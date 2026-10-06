// Serverless API: AI suggestions for EMPTY Marketing-view fields (OpenAI).
// POST /api/suggest {
//   projects: [{ id, name, category, squad, note, teams, tags, start, end, jira, design, missing:[field] }],
//   examples: [{ n, c, p, s, pr, o, t }],            // already-filled projects, to match team conventions
//   options:  { priority:[...], size:[...], openScale:[...], tags:[...] }
// } -> { suggestions: { [id]: { priority?, size?, promo?, openScale?, tags?:[...] } } }
//
// Auth: the super-admin only — suggestions are a private aid shown just to them.
// OpenAI credentials live in Vercel env vars: OPENAI_API_KEY, OPENAI_MODEL (opt), OPENAI_BASE_URL (opt).

import { OAuth2Client } from 'google-auth-library';
import { openaiConfig, redact } from './_openai.js';

const CLIENT_ID = '292601272916-9kkgsjlp8fdo9eskuj0lelufve2h7cvq.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'everfit.io';
const ADMIN_EMAIL = 'thanhngo@everfit.io';
const oauth = new OAuth2Client(CLIENT_ID);
const FIELDS = ['priority', 'size', 'promo', 'openScale', 'tags'];

async function verify(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    const ticket = await oauth.verifyIdToken({ idToken: token, audience: CLIENT_ID });
    const p = ticket.getPayload();
    if (!p || !p.email_verified) return null;
    if (!(p.email || '').toLowerCase().endsWith('@' + ALLOWED_DOMAIN)) return null;
    return p;
  } catch (e) { return null; }
}

const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const strList = (v, n) => (Array.isArray(v) ? v : []).map(x => str(x, 60)).filter(Boolean).slice(0, n);

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const user = await verify(req);
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }
  if ((user.email || '').toLowerCase() !== ADMIN_EMAIL) { res.status(403).json({ error: 'forbidden' }); return; }

  const cfg = openaiConfig();
  if (cfg.error) { res.status(cfg.error.status).json(cfg.error.body); return; }
  const KEY = cfg.key, MODEL = cfg.model, BASE = cfg.base;

  const b = req.body || {};
  const opt = b.options || {};
  const options = {
    priority: strList(opt.priority, 10),
    size: strList(opt.size, 10),
    openScale: strList(opt.openScale, 10),
    promo: ['Yes', 'No'],
    tags: strList(opt.tags, 80),
  };
  const projects = (Array.isArray(b.projects) ? b.projects : []).slice(0, 40).map(p => ({
    id: str(p.id, 80), name: str(p.name, 200), category: str(p.category, 120), squad: str(p.squad, 120),
    note: str(p.note, 400), teams: strList(p.teams, 6), tags: strList(p.tags, 8),
    start: str(p.start, 10), end: str(p.end, 10), jira: str(p.jira, 30), design: str(p.design, 60),
    missing: strList(p.missing, 5).filter(f => FIELDS.includes(f)),
  })).filter(p => p.id && p.missing.length);
  if (!projects.length) { res.status(200).json({ suggestions: {} }); return; }
  const examples = (Array.isArray(b.examples) ? b.examples : []).slice(0, 60);

  const sys = 'You help a product manager at a B2B fitness-coaching SaaS fill in MISSING metadata on roadmap projects in a release calendar. '
    + 'Fields: priority (business importance), size (feature size / effort), promo ("Yes" if the release deserves marketing promotion, else "No"), '
    + 'openScale (release audience: Internal, Beta or Public), tags (labels like audience or request source). '
    + 'Study the EXAMPLES of already-filled projects and match this team\'s conventions (how they size, prioritize, promote and tag similar work). '
    + 'For each project, suggest values ONLY for the fields listed in its "missing" array, and ONLY using the allowed option values given. '
    + 'For tags, pick at most 3 from the allowed tag list that clearly apply. If you are not reasonably confident about a field, omit it. '
    + 'Return STRICT JSON only: {"suggestions": {"<project id>": {"priority"?: string, "size"?: string, "promo"?: "Yes"|"No", "openScale"?: string, "tags"?: string[]}}}.';
  const usr = 'ALLOWED OPTIONS:\n' + JSON.stringify(options)
    + '\n\nEXAMPLES (n=name, c=category, p=priority, s=size, pr=promo, o=openScale, t=tags):\n' + JSON.stringify(examples)
    + '\n\nPROJECTS TO FILL:\n' + JSON.stringify(projects);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50000);
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      res.status(502).json({ error: 'openai_error', status: r.status, detail: redact(text).slice(0, 500) });
      return;
    }
    const data = await r.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    let parsed;
    try { parsed = JSON.parse(content); } catch (e) { res.status(502).json({ error: 'bad_ai_json', detail: String(content).slice(0, 500) }); return; }

    // Keep only allowed values for fields that were actually missing on that project.
    const raw = (parsed && parsed.suggestions) || {};
    const out = {};
    projects.forEach(p => {
      const s = raw[p.id]; if (!s || typeof s !== 'object') return;
      const clean = {};
      p.missing.forEach(f => {
        if (f === 'tags') {
          const t = strList(s.tags, 3).filter(x => options.tags.includes(x));
          if (t.length) clean.tags = t;
        } else {
          const v = str(s[f], 40);
          if (v && options[f].includes(v)) clean[f] = v;
        }
      });
      if (Object.keys(clean).length) out[p.id] = clean;
    });
    res.status(200).json({ suggestions: out, model: MODEL, generatedAt: Date.now() });
  } catch (e) {
    const msg = (e && e.name === 'AbortError') ? 'timeout' : String(e && e.message || e);
    res.status(500).json({ error: 'server_error', detail: redact(msg) });
  }
}

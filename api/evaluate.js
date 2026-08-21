// Serverless API: AI-assisted performance evaluation (OpenAI).
// POST /api/evaluate { name, role, period, criteria:[...], history, slack, managerNotes, selfEval }
//   -> { overall, criteria:[{name, score, insight}], summary }
//
// Auth: valid Google ID token for the ADMIN account (thanhngo@everfit.io) only — this is a manager tool.
// OpenAI credentials live in Vercel env vars (never in code):
//   OPENAI_API_KEY   your OpenAI API key (sk-...)
//   OPENAI_MODEL     (optional) chat model id; defaults to gpt-4o
//   OPENAI_BASE_URL  (optional) override base, e.g. an Azure/proxy endpoint

import { OAuth2Client } from 'google-auth-library';

const CLIENT_ID = '292601272916-9kkgsjlp8fdo9eskuj0lelufve2h7cvq.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'everfit.io';
const ADMIN_EMAIL = 'thanhngo@everfit.io';
const oauth = new OAuth2Client(CLIENT_ID);

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

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const user = await verify(req);
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }
  if ((user.email || '').toLowerCase() !== ADMIN_EMAIL) { res.status(403).json({ error: 'forbidden' }); return; }

  const KEY = process.env.OPENAI_API_KEY;
  if (!KEY) { res.status(500).json({ error: 'openai_not_configured', detail: 'Set OPENAI_API_KEY in Vercel env vars.' }); return; }
  const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
  const BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');

  const b = req.body || {};
  const name = String(b.name || 'the team member');
  const role = String(b.role || '').trim();
  const period = String(b.period || '').trim();
  const criteria = Array.isArray(b.criteria) && b.criteria.length
    ? b.criteria.map(String).slice(0, 12)
    : ['Delivery', 'Quality', 'Collaboration', 'Ownership', 'Communication'];

  // Compact the evidence so the prompt stays bounded.
  const ev = {
    role, period,
    workingHistory: b.history || null,     // { totalHours, projects:[{name, hours, category}], activeDays, ... }
    slackActivity: b.slack || null,        // { messageCount, channels, samples:[...] }
    managerNotes: (b.managerNotes || '').slice(0, 4000),
    selfEvaluation: b.selfEval || null,    // { criteria:{name:{score,comment}}, summary }
  };

  const sys = 'You are an engineering manager writing a fair, evidence-based performance review. '
    + 'You will be given a team member\'s role, the review period, their working history (Jira worklogs), '
    + 'Slack activity, the manager\'s notes, and the member\'s self-evaluation. '
    + 'Score each requested criterion from 1 to 5 (1=needs significant improvement, 3=meets expectations, 5=outstanding), '
    + 'using half-points if warranted. Base every score on the evidence provided; when evidence is thin, say so in the insight and score conservatively near 3. '
    + 'For each criterion write a concise 1-3 sentence insight citing concrete signals (projects, hours, activity, self-eval, manager notes). '
    + 'Then give an overall score (1-5, one decimal) and a short summary (2-4 sentences) with strengths and one growth area. '
    + 'Be specific, professional, and neutral. Do NOT invent facts not supported by the evidence. '
    + 'Return STRICT JSON only, matching this shape: '
    + '{"overall": number, "summary": string, "criteria": [{"name": string, "score": number, "insight": string}]}. '
    + 'The criteria array MUST contain exactly the requested criteria names in the given order.';

  const usr = 'Team member: ' + name + '\nRole: ' + (role || 'unspecified')
    + '\nReview period: ' + (period || 'unspecified')
    + '\nCriteria to score (in this exact order): ' + criteria.join(', ')
    + '\n\nEVIDENCE (JSON):\n' + JSON.stringify(ev, null, 2);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      res.status(502).json({ error: 'openai_error', status: r.status, detail: text.slice(0, 500) });
      return;
    }
    const data = await r.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    let parsed;
    try { parsed = JSON.parse(content); } catch (e) { res.status(502).json({ error: 'bad_ai_json', detail: String(content).slice(0, 500) }); return; }

    // Normalize + align to the requested criteria order.
    const byName = {};
    (Array.isArray(parsed.criteria) ? parsed.criteria : []).forEach(c => { if (c && c.name) byName[String(c.name).toLowerCase()] = c; });
    const outCriteria = criteria.map(nm => {
      const c = byName[nm.toLowerCase()] || {};
      return { name: nm, score: clamp(Number(c.score) || 0, 0, 5), insight: String(c.insight || '').slice(0, 800) };
    });
    const overall = parsed.overall != null ? clamp(Number(parsed.overall) || 0, 0, 5)
      : (outCriteria.reduce((s, c) => s + c.score, 0) / (outCriteria.length || 1));
    res.status(200).json({
      overall: Math.round(overall * 10) / 10,
      summary: String(parsed.summary || '').slice(0, 2000),
      criteria: outCriteria,
      model: MODEL,
      generatedAt: Date.now(),
    });
  } catch (e) {
    const msg = (e && e.name === 'AbortError') ? 'timeout' : String(e && e.message || e);
    res.status(500).json({ error: 'server_error', detail: msg });
  }
}

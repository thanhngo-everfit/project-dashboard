// Serverless API for syncing "Design ETA" from Jira (incl. Jira Product Discovery).
// POST /api/jira  { action:'sync', issues:[{id, key}] }  -> { results:[{id,key,designEta|error}], syncedAt, fieldId }
// POST /api/jira  { action:'fields', query? }             -> { fields:[{id,name}] }   (debug: find the field id)
//
// Auth: every request needs a valid Google ID token for the ADMIN account (thanhngo@everfit.io).
// Jira credentials live in Vercel env vars (never in code):
//   JIRA_BASE_URL          e.g. https://everfit.atlassian.net
//   JIRA_EMAIL             the Atlassian account email that owns the API token
//   JIRA_API_TOKEN         an Atlassian API token (id.atlassian.com -> Security -> API tokens)
//   JIRA_DESIGN_ETA_FIELD  (optional) custom field id like customfield_10123.
//                          If unset, the field named "Design ETA" is auto-detected.

import { OAuth2Client } from 'google-auth-library';

const CLIENT_ID = '292601272916-9kkgsjlp8fdo9eskuj0lelufve2h7cvq.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'everfit.io';
const ADMIN_EMAIL = 'thanhngo@everfit.io';   // only this user may sync Jira
const FIELD_NAME = 'design eta';             // matched case-insensitively when no field id is configured

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
  } catch (e) {
    return null;
  }
}

// A Jira date custom field comes back as "YYYY-MM-DD" (or a datetime, or {value}). Normalize to
// a clean YYYY-MM-DD, or null if it isn't a plausible date (so bad values never reach the client).
function normalizeDate(v) {
  if (!v) return null;
  let s = typeof v === 'string' ? v : (typeof v === 'object' && v.value) ? String(v.value) : '';
  s = s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  if (y < 2000 || y > 2100) return null;
  return s;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const user = await verify(req);
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }
  if ((user.email || '').toLowerCase() !== ADMIN_EMAIL) { res.status(403).json({ error: 'forbidden' }); return; }

  const base = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  const email = process.env.JIRA_EMAIL, apiToken = process.env.JIRA_API_TOKEN;
  if (!base || !email || !apiToken) {
    res.status(500).json({ error: 'jira_not_configured', need: ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'] });
    return;
  }
  const auth = 'Basic ' + Buffer.from(email + ':' + apiToken).toString('base64');
  const jheaders = { Authorization: auth, Accept: 'application/json' };
  const body = req.body || {};

  try {
    // list fields (helper to discover the Design ETA custom field id)
    if (body.action === 'fields') {
      const r = await fetch(base + '/rest/api/3/field', { headers: jheaders });
      if (!r.ok) { res.status(502).json({ error: 'jira_http_' + r.status }); return; }
      const all = await r.json();
      const q = (body.query || '').toLowerCase();
      const fields = (Array.isArray(all) ? all : [])
        .filter(f => !q || (f.name || '').toLowerCase().includes(q))
        .map(f => ({ id: f.id, name: f.name }));
      res.status(200).json({ fields });
      return;
    }

    // resolve the Design ETA field id (env override, else auto-detect by name)
    let fieldId = process.env.JIRA_DESIGN_ETA_FIELD || '';
    if (!fieldId) {
      const r = await fetch(base + '/rest/api/3/field', { headers: jheaders });
      if (!r.ok) { res.status(502).json({ error: 'jira_http_' + r.status, detail: 'could not list fields to auto-detect Design ETA' }); return; }
      const all = await r.json();
      const hit = (Array.isArray(all) ? all : []).find(f => (f.name || '').toLowerCase() === FIELD_NAME)
        || (Array.isArray(all) ? all : []).find(f => (f.name || '').toLowerCase().includes(FIELD_NAME));
      if (!hit) { res.status(500).json({ error: 'design_eta_field_not_found', hint: 'Set JIRA_DESIGN_ETA_FIELD, or rename the Jira field to "Design ETA".' }); return; }
      fieldId = hit.id;
    }

    const issues = Array.isArray(body.issues) ? body.issues.slice(0, 200) : [];
    // Fetch in parallel (bounded concurrency) so many linked projects don't blow the function timeout.
    const results = new Array(issues.length);
    const CONCURRENCY = 12;
    let next = 0;
    async function worker() {
      while (true) {
        const i = next++;
        if (i >= issues.length) return;
        const it = issues[i];
        const key = String((it && it.key) || '').trim();
        if (!key) { results[i] = { id: it && it.id, key, error: 'no_key' }; continue; }
        try {
          const r = await fetch(base + '/rest/api/3/issue/' + encodeURIComponent(key) + '?fields=' + encodeURIComponent(fieldId), { headers: jheaders });
          if (!r.ok) { results[i] = { id: it.id, key, error: 'http_' + r.status }; continue; }
          const j = await r.json();
          const raw = j && j.fields ? j.fields[fieldId] : undefined;
          results[i] = { id: it.id, key, designEta: normalizeDate(raw), raw: raw === undefined ? '(field absent)' : raw };
        } catch (e) {
          results[i] = { id: it.id, key, error: String((e && e.message) || e) };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, issues.length) }, worker));
    res.status(200).json({ results, syncedAt: Date.now(), fieldId });
  } catch (e) {
    res.status(500).json({ error: 'server_error', detail: String((e && e.message) || e) });
  }
}

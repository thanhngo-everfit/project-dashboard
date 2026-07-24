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
const END_FIELD_NAME = 'design eta';         // -> design work END (matched case-insensitively if no id set)
const START_FIELD_NAME = 'design start';     // -> design work START
// Known Everfit field ids (override via env). Design ETA -> end, Design Start -> start, Design Status.
const END_FIELD_DEFAULT = 'customfield_10666';
const START_FIELD_DEFAULT = 'customfield_12752';
const STATUS_FIELD_DEFAULT = 'customfield_10139';   // design status (select/status)
// Per-discipline effort estimation (number fields). Auto-detected by name; override via env.
const EST_FIELDS = [
  { key: 'api',     name: 'api estimation',     env: 'JIRA_EST_API_FIELD' },
  { key: 'web',     name: 'web estimation',     env: 'JIRA_EST_WEB_FIELD' },
  { key: 'android', name: 'android estimation', env: 'JIRA_EST_ANDROID_FIELD' },
  { key: 'ios',     name: 'ios estimation',     env: 'JIRA_EST_IOS_FIELD' },
  { key: 'landing', name: 'landing estimation', env: 'JIRA_EST_LANDING_FIELD' },
];

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

// Normalize a single date to a clean YYYY-MM-DD, or null if not a plausible date.
function normalizeDate(v) {
  if (!v) return null;
  let s = typeof v === 'string' ? v : (typeof v === 'object' && v.value) ? String(v.value) : '';
  s = s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  if (y < 2000 || y > 2100) return null;
  return s;
}
// Walk a Jira description (Atlassian Document Format, or a plain string) and pull out every figma.com URL.
function collectDoc(node, acc) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(n => collectDoc(n, acc)); return; }
  if (typeof node === 'object') {
    if (Array.isArray(node.marks)) node.marks.forEach(m => { if (m && m.type === 'link' && m.attrs && m.attrs.href) acc.hrefs.push(m.attrs.href); });
    if (node.attrs && node.attrs.url) acc.hrefs.push(node.attrs.url);   // inlineCard / embedCard / blockCard
    if (typeof node.text === 'string') acc.text += ' ' + node.text;
    if (node.content) collectDoc(node.content, acc);
  }
}
function extractFigmaLinks(desc) {
  const acc = { hrefs: [], text: '' };
  if (typeof desc === 'string') acc.text = desc;
  else collectDoc(desc, acc);
  const urls = new Set();
  acc.hrefs.forEach(h => { if (/figma\.com/i.test(h)) urls.add(h.trim()); });
  const re = /https?:\/\/[^\s)"'\]]*figma\.com[^\s)"'\]]*/ig; let m;
  while ((m = re.exec(acc.text))) urls.add(m[0].trim());
  return [...urls];
}
// A number custom field -> a finite number, or null.
function extractNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object') v = v.value ?? v.number ?? null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// Design ETA can be a plain date, a {start,end} object, OR a JSON *string* of that object
// (Jira Product Discovery returns e.g. '{"start":"2026-07-15","end":"2026-07-15"}').
// Return {start,end}: a range keeps both; a lone date is treated as the ETA (end).
function extractRange(raw) {
  let v = raw;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s[0] === '{' || s[0] === '[') { try { v = JSON.parse(s); } catch (e) { /* leave as string */ } }
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return { start: normalizeDate(v.start), end: normalizeDate(v.end) };
  }
  return { start: null, end: normalizeDate(v) };
}
// A select/status custom field comes back as a string, {value}, or {name}. Return the label string.
function extractStatus(raw) {
  if (!raw) return '';
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'object') return String(raw.value || raw.name || '').trim();
  return '';
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

    // resolve the Design ETA (end), Design Start, and Design Status field ids: env -> known default -> auto-detect
    let fieldId = process.env.JIRA_DESIGN_ETA_FIELD || END_FIELD_DEFAULT || '';        // design work END
    let startFieldId = process.env.JIRA_DESIGN_START_FIELD || START_FIELD_DEFAULT || ''; // design work START
    let statusFieldId = process.env.JIRA_DESIGN_STATUS_FIELD || STATUS_FIELD_DEFAULT || ''; // design status
    const estIds = {};   // discipline key -> field id (env override or auto-detected)
    EST_FIELDS.forEach(f => { const v = process.env[f.env]; if (v) estIds[f.key] = v; });
    const needList = !fieldId || !startFieldId || EST_FIELDS.some(f => !estIds[f.key]);
    if (needList) {
      const r = await fetch(base + '/rest/api/3/field', { headers: jheaders });
      if (!r.ok) { res.status(502).json({ error: 'jira_http_' + r.status, detail: 'could not list fields to auto-detect fields' }); return; }
      const all = await r.json();
      const list = Array.isArray(all) ? all : [];
      const findBy = name => { const n = name.toLowerCase(); return list.find(f => (f.name || '').toLowerCase() === n) || list.find(f => (f.name || '').toLowerCase().includes(n)); };
      if (!fieldId) { const h = findBy(END_FIELD_NAME); if (h) fieldId = h.id; }
      if (!startFieldId) { const h = findBy(START_FIELD_NAME); if (h) startFieldId = h.id; }
      EST_FIELDS.forEach(f => { if (!estIds[f.key]) { const h = findBy(f.name); if (h) estIds[f.key] = h.id; } });
    }
    if (!fieldId) { res.status(500).json({ error: 'design_eta_field_not_found', hint: 'Set JIRA_DESIGN_ETA_FIELD, or rename the Jira field to "Design ETA".' }); return; }

    // debug: dump the exact Design ETA / Start / Status values + schema for one issue
    if (body.action === 'raw') {
      const key = String(body.key || '').trim();
      const fp = [fieldId, startFieldId, statusFieldId].filter(Boolean).join(',');
      const r = await fetch(base + '/rest/api/3/issue/' + encodeURIComponent(key) + '?fields=' + encodeURIComponent(fp) + '&expand=schema', { headers: jheaders });
      const j = await r.json().catch(() => ({}));
      const f = (j && j.fields) || {}, sc = (j && j.schema) || {};
      res.status(200).json({
        key, status: r.status, fieldId, startFieldId, statusFieldId,
        end: f[fieldId] ?? null, start: startFieldId ? (f[startFieldId] ?? null) : null, designStatus: statusFieldId ? (f[statusFieldId] ?? null) : null,
        statusSchema: statusFieldId ? (sc[statusFieldId] ?? null) : null,
      });
      return;
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
          const estFieldIds = EST_FIELDS.map(f => estIds[f.key]).filter(Boolean);
          const fieldsParam = [fieldId, startFieldId, statusFieldId, 'description', ...estFieldIds].filter(Boolean).join(',');
          const r = await fetch(base + '/rest/api/3/issue/' + encodeURIComponent(key) + '?fields=' + encodeURIComponent(fieldsParam), { headers: jheaders });
          if (!r.ok) { results[i] = { id: it.id, key, error: 'http_' + r.status }; continue; }
          const j = await r.json();
          const f = (j && j.fields) || {};
          const endR = extractRange(f[fieldId]);                 // Design ETA -> end
          const startR = startFieldId ? extractRange(f[startFieldId]) : { start: null, end: null };  // Design Start
          const est = {};   // per-discipline estimation numbers
          EST_FIELDS.forEach(fd => { if (estIds[fd.key]) { const n = extractNumber(f[estIds[fd.key]]); if (n !== null) est[fd.key] = n; } });
          results[i] = {
            id: it.id, key,
            designStart: startR.start || startR.end,             // each field is a single date (start===end)
            designEnd: endR.end || endR.start,
            designStatus: statusFieldId ? extractStatus(f[statusFieldId]) : '',   // customfield_10139
            est,
            figma: extractFigmaLinks(f.description),             // Figma URLs found in the card description
            raw: { start: startFieldId ? f[startFieldId] ?? null : '(no start field)', end: f[fieldId] ?? null, status: statusFieldId ? f[statusFieldId] ?? null : null },
          };
        } catch (e) {
          results[i] = { id: it.id, key, error: String((e && e.message) || e) };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, issues.length) }, worker));
    res.status(200).json({ results, syncedAt: Date.now(), fieldId, startFieldId, statusFieldId, estIds });
  } catch (e) {
    res.status(500).json({ error: 'server_error', detail: String((e && e.message) || e) });
  }
}

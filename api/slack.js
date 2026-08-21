// Serverless API: pull a member's recent Slack activity as evidence for the AI evaluation.
// POST /api/slack { name, email?, from?, to? }  -> { found, user, messageCount, channels:[...], samples:[...] }
//
// Auth: valid Google ID token for the ADMIN account (thanhngo@everfit.io) only.
// Slack credentials live in Vercel env vars (never in code):
//   SLACK_USER_TOKEN  a user OAuth token (xoxp-...) with scopes: search:read, users:read, users:read.email
//                     (search.messages REQUIRES a user token — a bot token cannot search.)
//   SLACK_BOT_TOKEN   (optional) fallback for users.lookupByEmail / users.info if no user token.
//
// Privacy note: this only surfaces messages the token's owner can already see. It is a manager-only tool.

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

async function slackGet(token, method, params) {
  const url = 'https://slack.com/api/' + method + (params ? ('?' + new URLSearchParams(params)) : '');
  const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const user = await verify(req);
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }
  if ((user.email || '').toLowerCase() !== ADMIN_EMAIL) { res.status(403).json({ error: 'forbidden' }); return; }

  const USER_TOKEN = process.env.SLACK_USER_TOKEN;
  const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  const lookupTok = USER_TOKEN || BOT_TOKEN;
  if (!lookupTok) { res.status(500).json({ error: 'slack_not_configured', detail: 'Set SLACK_USER_TOKEN (search:read, users:read.email) in Vercel env vars.' }); return; }

  const b = req.body || {};
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim();
  const from = String(b.from || '').trim();   // YYYY-MM-DD
  const to = String(b.to || '').trim();

  try {
    // 1) Resolve the Slack user (prefer email; fall back to name search).
    let su = null;
    if (email) {
      const r = await slackGet(lookupTok, 'users.lookupByEmail', { email });
      if (r && r.ok && r.user) su = r.user;
    }
    if (!su && name) {
      const r = await slackGet(lookupTok, 'users.list', {});
      if (r && r.ok && Array.isArray(r.members)) {
        const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const target = norm(name);
        su = r.members.find(m => !m.deleted && !m.is_bot && (
          norm(m.real_name) === target || norm(m.profile && m.profile.real_name) === target ||
          norm(m.profile && m.profile.display_name) === target
        )) || r.members.find(m => !m.deleted && !m.is_bot && (
          norm(m.real_name).includes(target) || target.includes(norm(m.real_name))
        )) || null;
      }
    }
    if (!su) { res.status(200).json({ found: false, detail: 'No matching Slack user (provide the member\'s email for a reliable match).' }); return; }

    const handle = (su.profile && su.profile.display_name) || su.name || '';
    const info = { id: su.id, name: su.real_name || (su.profile && su.profile.real_name) || '', handle };

    // 2) Search their recent messages (needs a user token with search:read).
    if (!USER_TOKEN) {
      res.status(200).json({ found: true, user: info, messageCount: null, channels: [], samples: [], detail: 'Set SLACK_USER_TOKEN to include message activity (search requires a user token).' });
      return;
    }
    let query = 'from:<@' + su.id + '>';
    if (from) query += ' after:' + from;
    if (to) query += ' before:' + to;
    const sr = await slackGet(USER_TOKEN, 'search.messages', { query, count: '100', sort: 'timestamp' });
    if (!sr || !sr.ok) { res.status(200).json({ found: true, user: info, messageCount: null, channels: [], samples: [], detail: 'search.messages failed: ' + (sr && sr.error || 'unknown') }); return; }

    const matches = (sr.messages && sr.messages.matches) || [];
    const total = (sr.messages && sr.messages.total) || matches.length;
    const chanCount = {};
    matches.forEach(m => { const c = (m.channel && (m.channel.name || m.channel.id)) || '?'; chanCount[c] = (chanCount[c] || 0) + 1; });
    const channels = Object.entries(chanCount).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, count }));
    const samples = matches.slice(0, 20).map(m => (m.text || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 15);

    res.status(200).json({ found: true, user: info, messageCount: total, channels, samples, period: { from: from || null, to: to || null } });
  } catch (e) {
    res.status(500).json({ error: 'server_error', detail: String(e && e.message || e) });
  }
}

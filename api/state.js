// Serverless API for the shared roadmap document.
// GET  /api/state  -> { record: { state, updatedAt, updatedBy } | null }
// POST /api/state  -> { state }  (body)  -> { ok, updatedAt, updatedBy }
//
// Every request must carry a valid Google ID token (Authorization: Bearer <token>)
// belonging to a verified @everfit.io account. This is where the domain restriction
// is *actually enforced* (server-side), unlike the client-only gate.

import { Redis } from '@upstash/redis';
import { OAuth2Client } from 'google-auth-library';

const CLIENT_ID = '292601272916-9kkgsjlp8fdo9eskuj0lelufve2h7cvq.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'everfit.io';
const ADMIN_EMAIL = 'thanhngo@everfit.io';   // only this user can add/remove squads
const KEY = 'roadmap:state';

// Works with either the native Vercel KV env vars or the Upstash Marketplace ones.
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

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

export default async function handler(req, res) {
  if (!process.env.KV_REST_API_URL && !process.env.UPSTASH_REDIS_REST_URL) {
    res.status(500).json({ error: 'storage_not_configured' });
    return;
  }

  const user = await verify(req);
  if (!user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const record = await redis.get(KEY); // null if never written
      res.status(200).json({ record: record || null });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      if (typeof body.state === 'undefined' || body.state === null) {
        res.status(400).json({ error: 'missing_state' });
        return;
      }
      // Only the admin may add or remove tribes or squads (renames/reorders/edits are fine for everyone).
      const tribeIds = st => Array.isArray(st && st.tribes) ? st.tribes.map(t => t.id) : null;   // legacy (no tribes) -> skip tribe check
      const squadIds = st => {
        if (Array.isArray(st && st.tribes)) return st.tribes.flatMap(t => (t.squads || []).map(s => s.id));
        if (Array.isArray(st && st.squads)) return st.squads.map(s => s.id);
        return null;
      };
      if ((user.email || '').toLowerCase() !== ADMIN_EMAIL) {
        const existing = await redis.get(KEY);
        const oldSt = existing && existing.state;
        const setChanged = (a, b) => {
          if (!a || !b) return false;
          const A = new Set(a), B = new Set(b);
          return a.length !== b.length || a.some(x => !B.has(x)) || b.some(x => !A.has(x));
        };
        const hiddenArr = st => Array.isArray(st && st.hidden) ? st.hidden : [];
        if (setChanged(tribeIds(oldSt), tribeIds(body.state)) || setChanged(squadIds(oldSt), squadIds(body.state)) || setChanged(hiddenArr(oldSt), hiddenArr(body.state))) {
          res.status(403).json({ error: 'structure_change_forbidden' });
          return;
        }
      }
      const record = { state: body.state, updatedAt: Date.now(), updatedBy: user.email };
      await redis.set(KEY, record);
      res.status(200).json({ ok: true, updatedAt: record.updatedAt, updatedBy: record.updatedBy });
      return;
    }

    res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    res.status(500).json({ error: 'server_error', detail: String(e && e.message || e) });
  }
}

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
const HKEY = 'roadmap:history';   // rolling list of prior versions (newest first), for rollback

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
      // ?history=1 -> prior versions (admin only), newest first, for rollback
      if (req.query && (req.query.history === '1' || req.query.history === 'true')) {
        if ((user.email || '').toLowerCase() !== ADMIN_EMAIL) { res.status(403).json({ error: 'forbidden' }); return; }
        const raw = await redis.lrange(HKEY, 0, 29);
        const projectCount = st => (st && Array.isArray(st.tribes))
          ? st.tribes.reduce((n, t) => n + (t.squads || []).reduce((m, s) => m + (s.projects || []).reduce((k, c) => k + ((c.phases || []).length), 0), 0), 0) : 0;
        const versions = (raw || []).map((rec, i) => {
          const r = typeof rec === 'string' ? (() => { try { return JSON.parse(rec); } catch (e) { return null; } })() : rec;
          return r && r.state ? { i, updatedAt: r.updatedAt || 0, updatedBy: r.updatedBy || '', projects: projectCount(r.state), tribes: (r.state.tribes || []).length } : null;
        }).filter(Boolean);
        res.status(200).json({ versions });
        return;
      }
      const record = await redis.get(KEY); // null if never written
      res.status(200).json({ record: record || null });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      // Admin: restore a prior version from history (index into roadmap:history, newest first).
      if (body.action === 'restore') {
        if ((user.email || '').toLowerCase() !== ADMIN_EMAIL) { res.status(403).json({ error: 'forbidden' }); return; }
        const idx = Number(body.index) || 0;
        const raw = await redis.lrange(HKEY, idx, idx);
        let rec = raw && raw[0];
        if (typeof rec === 'string') { try { rec = JSON.parse(rec); } catch (e) { rec = null; } }
        if (!rec || !rec.state) { res.status(404).json({ error: 'version_not_found' }); return; }
        const cur = await redis.get(KEY);
        if (cur && cur.state) { try { await redis.lpush(HKEY, cur); await redis.ltrim(HKEY, 0, 29); } catch (e) {} }
        const record = { state: rec.state, updatedAt: Date.now(), updatedBy: user.email + ' (restore)' };
        await redis.set(KEY, record);
        res.status(200).json({ ok: true, restored: true, updatedAt: record.updatedAt });
        return;
      }
      if (typeof body.state === 'undefined' || body.state === null) {
        res.status(400).json({ error: 'missing_state' });
        return;
      }
      const existing = await redis.get(KEY);
      // Anti-wipe guard: never silently replace a populated board with a near-empty one (e.g. the
      // built-in seed). Applies to everyone, including the admin. Client may resend with force:true
      // only after the user explicitly confirms.
      const projectCount = st => (st && Array.isArray(st.tribes))
        ? st.tribes.reduce((n, t) => n + (t.squads || []).reduce((m, s) => m + (s.projects || []).reduce((k, c) => k + ((c.phases || []).length), 0), 0), 0)
        : 0;
      const oldCount = projectCount(existing && existing.state);
      const newCount = projectCount(body.state);
      if (!body.force && oldCount >= 5 && newCount <= 1) {
        res.status(409).json({ error: 'wipe_guard', oldCount, newCount });
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
        const oldSt = existing && existing.state;
        const setChanged = (a, b) => {
          if (!a || !b) return false;
          const A = new Set(a), B = new Set(b);
          return a.length !== b.length || a.some(x => !B.has(x)) || b.some(x => !A.has(x));
        };
        // hidden lists live per-tribe now; token = "<tribeId>::<hiddenId>".
        // Returns null for legacy data (no per-tribe hidden) so the migration save isn't blocked.
        const hiddenTokens = st => {
          if (!st || !Array.isArray(st.tribes)) return null;
          if (!st.tribes.some(t => Array.isArray(t.hidden))) return null;
          return st.tribes.flatMap(t => (Array.isArray(t.hidden) ? t.hidden : []).map(h => t.id + '::' + h));
        };
        if (setChanged(tribeIds(oldSt), tribeIds(body.state)) || setChanged(squadIds(oldSt), squadIds(body.state)) || setChanged(hiddenTokens(oldSt), hiddenTokens(body.state))) {
          res.status(403).json({ error: 'structure_change_forbidden' });
          return;
        }
      }
      // Snapshot the version we're about to replace so any bad save is recoverable (keep last 30).
      if (existing && existing.state) {
        try { await redis.lpush(HKEY, existing); await redis.ltrim(HKEY, 0, 29); } catch (e) { /* history is best-effort */ }
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

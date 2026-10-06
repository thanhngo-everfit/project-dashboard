// Shared OpenAI config + error redaction for the AI endpoints (evaluate, wiki-ai, suggest).
// Underscore-prefixed files in /api are helpers, not deployed as routes.

// Read + validate the env config. Returns { key, model, base } or { error: { status, body } }.
export function openaiConfig() {
  const key = String(process.env.OPENAI_API_KEY || '').trim();
  if (!key) return { error: { status: 500, body: { error: 'openai_not_configured', detail: 'Set OPENAI_API_KEY in Vercel env vars.' } } };
  if (/\s/.test(key)) return { error: { status: 500, body: { error: 'openai_key_malformed', detail: 'OPENAI_API_KEY contains spaces or line breaks (it looks pasted more than once). Set it to the single key in Vercel and redeploy.' } } };
  return {
    key,
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    base: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  };
}

// Strip anything key-like from text before it is returned to the browser.
export function redact(s) {
  return String(s == null ? '' : s)
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_\-]{6,}/g, '$1-•••')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer •••');
}

// Serverless API: turn a raw pasted document into a clean wiki page (OpenAI).
// POST /api/wiki-ai { raw, title? } -> { title, body }
//   body is the app's Markdown-ish format: "## " / "### " / "#### " headings, "- " bullets
//   (indent two spaces to nest), **bold**, `code`, "a | b | c" tables, and bare URLs as links.
//
// Auth: any verified @everfit.io Google account (formatting text the caller already has). Saving the
// page is separately gated by the 'wiki' permission on /api/state (patchWiki).
// OpenAI credentials live in Vercel env vars: OPENAI_API_KEY, OPENAI_MODEL (opt), OPENAI_BASE_URL (opt).

import { OAuth2Client } from 'google-auth-library';

const CLIENT_ID = '292601272916-9kkgsjlp8fdo9eskuj0lelufve2h7cvq.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'everfit.io';
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

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const user = await verify(req);
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }

  const KEY = process.env.OPENAI_API_KEY;
  if (!KEY) { res.status(500).json({ error: 'openai_not_configured', detail: 'Set OPENAI_API_KEY in Vercel env vars.' }); return; }
  const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
  const BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');

  const b = req.body || {};
  const raw = String(b.raw || '').slice(0, 60000).trim();   // bound the prompt
  const hintTitle = String(b.title || '').trim().slice(0, 200);
  // PDF path: the client sends the file as base64; the model reads it natively (no server-side PDF parser).
  const pdf = b.pdfBase64 ? String(b.pdfBase64) : '';
  const pdfName = String(b.filename || 'document.pdf').replace(/[^\w.\- ]+/g, '').slice(0, 120) || 'document.pdf';
  if (!raw && !pdf) { res.status(400).json({ error: 'missing_raw', detail: 'Paste text or attach a PDF to convert.' }); return; }
  if (pdf && pdf.length > 12_000_000) { res.status(413).json({ error: 'pdf_too_large', detail: 'PDF is too large — keep it under ~8MB.' }); return; }

  const sys = 'You are a technical writer who turns messy raw documents (pasted notes, exported docs, transcripts) '
    + 'into a single clean, well-structured internal wiki page. '
    + 'Preserve ALL substantive information and intent — do not invent facts, do not omit details, do not summarize away content; '
    + 'reorganize and clarify only. Fix obvious formatting noise (stray symbols, broken line wraps, duplicated whitespace). '
    + 'Output the BODY using this lightweight markup: '
    + '"# " page section / "## " section / "### " subsection / "#### " minor heading; '
    + '"- " bullets (indent two spaces per nesting level), and "- [ ] " / "- [x] " for task checkboxes; '
    + '"1. " for numbered lists; "> " for blockquotes/callouts; "---" on its own line for a divider; '
    + '**bold**, *italic*, ~~strikethrough~~, `inline code`; ``` on its own line to open/close a code block; '
    + '[link text](https://url) or a bare URL; '
    + 'tables as pipe-separated rows like "Column A | Column B | Column C" (one row per line, first row = header). '
    + 'Use these styles where they make the page clearer. Do NOT output raw HTML or images. '
    + 'Write a short, specific page title (Title Case, no trailing punctuation). '
    + 'Return STRICT JSON only: {"title": string, "body": string}.';

  let userContent;
  if (pdf) {
    const dataUrl = pdf.startsWith('data:') ? pdf : ('data:application/pdf;base64,' + pdf);
    userContent = [
      { type: 'text', text: 'Convert the attached PDF into a clean wiki page, preserving all substantive content.' + (hintTitle ? (' Suggested title: ' + hintTitle) : '') },
      { type: 'file', file: { filename: pdfName, file_data: dataUrl } },
    ];
  } else {
    userContent = (hintTitle ? ('Suggested title (use or improve): ' + hintTitle + '\n\n') : '') + 'RAW DOCUMENT:\n' + raw;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);   // PDFs take longer to read
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: userContent }],
        response_format: { type: 'json_object' },
        temperature: 0.2,
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
    res.status(200).json({
      title: String(parsed.title || hintTitle || pdfName.replace(/\.pdf$/i, '') || 'Imported page').slice(0, 200),
      body: String(parsed.body || '').slice(0, 60000),
      model: MODEL,
      generatedAt: Date.now(),
    });
  } catch (e) {
    const msg = (e && e.name === 'AbortError') ? 'timeout' : String(e && e.message || e);
    res.status(500).json({ error: 'server_error', detail: msg });
  }
}

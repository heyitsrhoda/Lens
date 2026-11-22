// api/ai.js — Lens's single, stateless LLM relay (Vercel Node serverless function) in front of OpenRouter.
//
//   GET  /api/ai?op=status   → { ok: true, key: boolean, model }
//   POST /api/ai   (JSON)    → OpenRouter Chat Completions  POST https://openrouter.ai/api/v1/chat/completions
//
// Request body: { system?: string, messages: [{ role: 'user'|'assistant', content: string }], maxTokens?, temperature? }
//   - max_tokens is clamped to 64..8000 (default 1500); temperature to 0..1.5 (sent only when given).
//   - The model is fixed by the deployment: env OPENROUTER_MODEL, else the free 'google/gemma-4-31b-it:free'.
//     Callers cannot pick a model (keeps this from being an open proxy for any model on the account).
//   - Body limit 200 KB. Upstream timeout 55 s.
//
// Response envelope: { ok: true, data: { text, model, finishReason } }
//                  | { ok: false, status, error, code } with code:
//     'no-key'   — OPENROUTER_API_KEY is not set on the deployment (HTTP 500)
//     'credits'  — OpenRouter answered 402 (insufficient credits)
//     'rate'     — OpenRouter answered 429
//     'invalid'  — the request body did not validate (HTTP 400 / 413)
//     'forbidden' — a browser request from another site (Origin / Sec-Fetch-Site does not match this host) (HTTP 403)
//     'upstream' — anything else (OpenRouter error, timeout, unreadable or empty answer)
//
// Key: process.env.OPENROUTER_API_KEY only (Authorization: Bearer). Never logs keys or bodies. No CORS headers, and
// POSTs whose Origin / Sec-Fetch-Site show another site are refused (403). That only stops other websites from using
// visitors' browsers; scripts can still call this endpoint, so set a credit limit on the OpenRouter key (per-key limit
// in OpenRouter's key settings). OpenRouter can also report a failure inside an HTTP 200 (top-level `error`, or
// choices[0].finish_reason === 'error' with choices[0].error); both are treated as errors.
// The OpenRouter logic lives in api/_lib/openrouter.js (shared with the temporary op=agent shim in api/you.js).

import { AI_MAX_BODY as MAX_BODY, AiError, apiKey, assertSameOrigin, model, relayChat } from './_lib/openrouter.js';

// ------------------------------------------------------------------ http helpers

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}

function fail(res, status, error, code) {
  send(res, status, { ok: false, status, error, code });
}

function header(req, name) {
  const v = req.headers ? req.headers[name] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

function queryOp(req) {
  if (req.query && typeof req.query.op === 'string') return req.query.op;
  try {
    return new URL(req.url || '', 'http://local').searchParams.get('op') || '';
  } catch {
    return '';
  }
}

const TOO_LARGE = 'Request body is too large (200 KB max).';

async function readBody(req) {
  const declared = Number(header(req, 'content-length') || 0);
  if (declared > MAX_BODY) throw new AiError(413, TOO_LARGE, 'invalid');
  // Vercel's Node runtime pre-parses JSON bodies into req.body (its getter throws on invalid JSON);
  // fall back to reading the stream when no parsed body is available.
  let pre;
  try {
    pre = req.body;
  } catch {
    throw new AiError(400, 'Request body must be a JSON object.', 'invalid');
  }
  if (pre !== undefined && pre !== null) {
    if (typeof pre === 'object' && !Buffer.isBuffer(pre)) {
      if (Array.isArray(pre)) throw new AiError(400, 'Request body must be a JSON object.', 'invalid');
      if (Buffer.byteLength(JSON.stringify(pre), 'utf8') > MAX_BODY) throw new AiError(413, TOO_LARGE, 'invalid');
      return pre;
    }
    const text = Buffer.isBuffer(pre) ? pre.toString('utf8') : String(pre);
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY) throw new AiError(413, TOO_LARGE, 'invalid');
    return parseJson(text);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new AiError(413, TOO_LARGE, 'invalid');
    chunks.push(chunk);
  }
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function parseJson(text) {
  if (!text || !text.trim()) throw new AiError(400, 'Request body must be a JSON object.', 'invalid');
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new AiError(400, 'Request body must be a JSON object.', 'invalid');
  }
}

// ------------------------------------------------------------------ handler

export default async function handler(req, res) {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    res.end();
    return;
  }
  if (method === 'GET') {
    if (queryOp(req) !== 'status') return fail(res, 400, 'Use GET /api/ai?op=status, or POST a chat request.', 'invalid');
    return send(res, 200, { ok: true, key: Boolean(apiKey()), model: model() });
  }
  if (method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return fail(res, 405, 'Use POST for chat requests.', 'invalid');
  }

  try {
    assertSameOrigin(req);
    const body = await readBody(req);
    const data = await relayChat(req, body);
    return send(res, 200, { ok: true, data });
  } catch (e) {
    if (e instanceof AiError) {
      if (e.code !== 'invalid') console.warn(`[ai-relay] failed with status ${e.status} (${e.code})`);
      return fail(res, e.status, e.message, e.code);
    }
    console.error(`[ai-relay] crashed: ${e && e.name ? e.name : 'Error'}`);
    return fail(res, 500, 'The AI relay hit an unexpected error.', 'upstream');
  }
}

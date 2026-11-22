// api/you.js — Lens's stateless You.com search/extract relay (Vercel Node serverless function).
//
//   GET  /api/you?op=status            → { ok: true, envKey: boolean }
//   POST /api/you?op=search   (JSON)   → You.com Web Search   POST https://ydc-index.io/v1/search   (X-API-Key)
//   POST /api/you?op=extract  (JSON)   → You.com Extract      POST https://ydc-index.io/v1/extract  (X-API-Key)
//
// AI (LLM) calls do not go through here: they use api/ai.js (OpenRouter).
//
//   POST /api/you?op=agent    (JSON)   → TEMPORARY shim for browser tabs still running the pre-OpenRouter client
//                                        (js/services/you.js used to send AI calls here). Body { system?, messages | input,
//                                        maxTokens?, temperature? } goes to OpenRouter through the same logic as api/ai.js
//                                        (api/_lib/openrouter.js; never You.com inference) and answers the old shape
//                                        { ok: true, data: { text, model, finishReason } }. Remove once old tabs have aged out.
//
// Key: header `x-you-key` (a developer's own key), else process.env.YOU_API_KEY (owner-funded), else 400.
// Never logs keys or bodies. Only these ops are allowed (not an open proxy). Body limit 64 KB. Upstream timeout 55 s.
// Response envelope: { ok: true, data } or { ok: false, status, error, detail? } with the upstream status code passed through.

const SEARCH_URL = 'https://ydc-index.io/v1/search';
const EXTRACT_URL = 'https://ydc-index.io/v1/extract';

import { AI_MAX_BODY, AiError, assertSameOrigin, relayChat } from './_lib/openrouter.js';

const MAX_BODY = 64 * 1024;
const TIMEOUT_MS = 55000;
const OPS = new Set(['status', 'search', 'extract', 'agent']);

const SEARCH_FIELDS = ['query', 'count', 'freshness', 'country', 'language', 'include_domains', 'exclude_domains', 'boost_domains', 'offset', 'safesearch', 'extraction', 'crawl_timeout', 'knowledge', 'strict_operators'];
const EXTRACT_FIELDS = ['url', 'full_page', 'extraction_source', 'timeout', 'parse_effort'];

// ------------------------------------------------------------------ http helpers

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}

function fail(res, status, error, detail) {
  const body = { ok: false, status, error };
  if (detail !== undefined) body.detail = detail;
  send(res, status, body);
}

class RelayError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
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

async function readBody(req, limit = MAX_BODY) {
  const tooLarge = `Request body is too large (${Math.round(limit / 1024)} KB max).`;
  const declared = Number(header(req, 'content-length') || 0);
  if (declared > limit) throw new RelayError(413, tooLarge);
  // Vercel's Node runtime pre-parses JSON bodies into req.body (its getter throws on invalid JSON);
  // fall back to reading the stream when no parsed body is available.
  let pre;
  try {
    pre = req.body;
  } catch {
    throw new RelayError(400, 'Request body must be a JSON object.');
  }
  if (pre !== undefined && pre !== null) {
    if (typeof pre === 'object' && !Buffer.isBuffer(pre)) {
      if (Array.isArray(pre)) throw new RelayError(400, 'Request body must be a JSON object.');
      if (JSON.stringify(pre).length > limit) throw new RelayError(413, tooLarge);
      return pre;
    }
    const text = Buffer.isBuffer(pre) ? pre.toString('utf8') : String(pre);
    if (text.length > limit) throw new RelayError(413, tooLarge);
    return parseJson(text);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new RelayError(413, tooLarge);
    chunks.push(chunk);
  }
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function parseJson(text) {
  if (!text || !text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new RelayError(400, 'Request body must be a JSON object.');
  }
}

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj[f] !== undefined && obj[f] !== null && obj[f] !== '') out[f] = obj[f];
  return out;
}

function upstreamMessage(status, body, fallbackText) {
  let detail = '';
  if (body && typeof body === 'object') {
    const e = body.error;
    if (e && typeof e === 'object') detail = e.message || e.code || '';
    else if (typeof e === 'string') detail = body.message || e;
    if (!detail && typeof body.message === 'string') detail = body.message;
    if (!detail && typeof body.detail === 'string') detail = body.detail;
    if (!detail && Array.isArray(body.detail) && body.detail[0]) detail = body.detail[0].msg || '';
    if (!detail && Array.isArray(body.errors) && body.errors[0]) detail = body.errors[0].detail || body.errors[0].title || '';
  } else if (fallbackText) {
    detail = String(fallbackText).slice(0, 200);
  }
  const prefix = {
    400: 'You.com could not process the request',
    401: 'You.com rejected the API key',
    402: 'The You.com account is out of credits',
    403: 'This You.com key is not allowed to use this API',
    404: 'You.com endpoint not found',
    422: 'You.com did not accept the request parameters',
    429: 'You.com rate limit reached — try again in a minute',
    503: 'You.com is temporarily unavailable',
    504: 'You.com timed out',
  }[status] || `You.com request failed (HTTP ${status})`;
  return detail && !prefix.includes(detail) ? `${prefix}: ${detail}` : `${prefix}.`;
}

async function callYou(url, { method = 'POST', key, body }) {
  const headers = { Accept: 'application/json', 'X-API-Key': key };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new RelayError(504, 'You.com took too long to respond (55 s). Try again.');
    throw new RelayError(502, 'Could not reach You.com from the relay. Try again shortly.');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) throw new RelayError(res.status, upstreamMessage(res.status, json, json ? '' : text), json || undefined);
  if (json === null) throw new RelayError(502, 'You.com returned a response the relay could not read.');
  return json;
}

// ------------------------------------------------------------------ ops

async function opSearch(key, body) {
  const q = typeof body.query === 'string' ? body.query.trim() : '';
  if (!q) throw new RelayError(400, 'Search needs a non-empty "query".');
  return callYou(SEARCH_URL, { key, body: { ...pick(body, SEARCH_FIELDS), query: q } });
}

async function opExtract(key, body) {
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!/^https?:\/\//i.test(url)) throw new RelayError(400, 'Extract needs an absolute http(s) "url".');
  const payload = { full_page: { extraction_formats: ['markdown'] }, ...pick(body, EXTRACT_FIELDS), url };
  return callYou(EXTRACT_URL, { key, body: payload });
}

// Temporary: old clients' AI calls → OpenRouter (see the header). Accepts `messages`, or a plain `input` string.
async function opAgent(req, body) {
  const messages = Array.isArray(body.messages) && body.messages.length
    ? body.messages
    : typeof body.input === 'string' && body.input.trim() ? [{ role: 'user', content: body.input }] : body.messages;
  return relayChat(req, { system: body.system, messages, maxTokens: body.maxTokens, temperature: body.temperature });
}

async function handleAgent(req, res) {
  try {
    assertSameOrigin(req);
    let body;
    try {
      body = await readBody(req, AI_MAX_BODY);
    } catch (e) {
      if (e instanceof RelayError) throw new AiError(e.status, e.message, 'invalid');
      throw e;
    }
    const data = await opAgent(req, body);
    return send(res, 200, { ok: true, data });
  } catch (e) {
    if (e instanceof AiError) {
      if (e.code !== 'invalid') console.warn(`[you-relay] op=agent (OpenRouter) failed with status ${e.status} (${e.code})`);
      return send(res, e.status, { ok: false, status: e.status, error: e.message, code: e.code });
    }
    console.error(`[you-relay] op=agent crashed: ${e && e.name ? e.name : 'Error'}`);
    return send(res, 500, { ok: false, status: 500, error: 'The AI relay hit an unexpected error.', code: 'upstream' });
  }
}

// ------------------------------------------------------------------ handler

export default async function handler(req, res) {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    res.end();
    return;
  }
  const op = queryOp(req);
  if (!OPS.has(op)) return fail(res, 400, 'Unknown op. Use status, search or extract (AI calls use /api/ai; reload Lens if it is out of date).');

  if (op === 'status') {
    if (method !== 'GET' && method !== 'POST') return fail(res, 405, 'Use GET for op=status.');
    return send(res, 200, { ok: true, envKey: Boolean(process.env.YOU_API_KEY) });
  }
  if (method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return fail(res, 405, `Use POST for op=${op}.`);
  }
  if (op === 'agent') return handleAgent(req, res);

  const userKey = String(header(req, 'x-you-key') || '').trim();
  const key = userKey || String(process.env.YOU_API_KEY || '').trim();
  if (!key) return fail(res, 400, 'No You.com API key. Add yours in Settings → Connections, or set YOU_API_KEY on the deployment.');

  try {
    const body = await readBody(req);
    const data = op === 'search' ? await opSearch(key, body) : await opExtract(key, body);
    return send(res, 200, { ok: true, data });
  } catch (e) {
    if (e instanceof RelayError) {
      console.warn(`[you-relay] op=${op} failed with status ${e.status}`);
      return fail(res, e.status, e.message, e.detail);
    }
    console.error(`[you-relay] op=${op} crashed: ${e && e.name ? e.name : 'Error'}`);
    return fail(res, 500, 'The You.com relay hit an unexpected error.');
  }
}

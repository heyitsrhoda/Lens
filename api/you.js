// api/you.js — Lens's single, stateless You.com relay (Vercel Node serverless function).
//
//   GET  /api/you?op=status            → { ok: true, envKey: boolean }
//   POST /api/you?op=search   (JSON)   → You.com Web Search   POST https://ydc-index.io/v1/search   (X-API-Key)
//   POST /api/you?op=extract  (JSON)   → You.com Extract      POST https://ydc-index.io/v1/extract  (X-API-Key)
//   POST /api/you?op=agent    (JSON)   → LLM answer, see below
//
// op=agent, checked against the You.com docs (you.com/docs, OpenAPI specs under /docs/openapi/*):
//   - default            → Inference Router  POST https://api.you.com/v1/chat/completions
//                          (Authorization: Bearer <key>; OpenAI Chat Completions body { model, messages, max_tokens, stream:false };
//                          response choices[0].message.content). `model` is required by the API: we use the request's
//                          `model`, else env YOU_MODEL, else pick one from GET https://api.you.com/v1/models for that key.
//   - agent: 'answer'    → Answer API        POST https://api.you.com/v1/answer (X-API-Key; { query ≤ 400 chars };
//                          response { answer, citations[{source, excerpts}], results.web[] }).
//   - agent: 'express' | 'advanced' | <custom agent id>
//                        → legacy Agents API POST https://api.you.com/v1/agents/runs (Bearer; { agent, input, stream:false };
//                          response output[{ type, text }]). If You.com no longer serves it (404/410), the Inference Router answers.
//
// Key: header `x-you-key` (the user's own key from Settings), else process.env.YOU_API_KEY (owner-funded), else 400.
// Never logs keys or bodies. Only these ops are allowed (not an open proxy). Body limit 64 KB. Upstream timeout 55 s.
// Response envelope: { ok: true, data } or { ok: false, status, error, detail? } with the upstream status code passed through.

import { createHash } from 'node:crypto';

const SEARCH_URL = 'https://ydc-index.io/v1/search';
const EXTRACT_URL = 'https://ydc-index.io/v1/extract';
const ROUTER_URL = 'https://api.you.com/v1/chat/completions';
const MODELS_URL = 'https://api.you.com/v1/models';
const ANSWER_URL = 'https://api.you.com/v1/answer';
const AGENTS_URL = 'https://api.you.com/v1/agents/runs';

const MAX_BODY = 64 * 1024;
const TIMEOUT_MS = 55000;
const MODEL_CACHE_MS = 10 * 60 * 1000;
const OPS = new Set(['status', 'search', 'extract', 'agent']);

const SEARCH_FIELDS = ['query', 'count', 'freshness', 'country', 'language', 'include_domains', 'exclude_domains', 'boost_domains', 'offset', 'safesearch', 'extraction', 'crawl_timeout', 'knowledge', 'strict_operators'];
const EXTRACT_FIELDS = ['url', 'full_page', 'extraction_source', 'timeout', 'parse_effort'];
const ANSWER_FIELDS = ['freshness', 'country', 'language', 'safesearch', 'include_domains', 'exclude_domains', 'boost_domains'];

// Preferred general-purpose chat models, in order, when the request does not name one.
const MODEL_PREFERENCE = [/claude.*sonnet/i, /claude/i, /^gpt-5/i, /^gpt/i, /gemini.*pro/i, /gemini/i, /kimi/i, /deepseek/i, /qwen/i, /glm/i, /llama/i, /mistral/i];

const modelCache = new Map(); // sha256(key) → { at, models: [{ id, maxTokens }] }

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

async function readBody(req) {
  const declared = Number(header(req, 'content-length') || 0);
  if (declared > MAX_BODY) throw new RelayError(413, 'Request body is too large (64 KB max).');
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
      if (JSON.stringify(pre).length > MAX_BODY) throw new RelayError(413, 'Request body is too large (64 KB max).');
      return pre;
    }
    const text = Buffer.isBuffer(pre) ? pre.toString('utf8') : String(pre);
    if (text.length > MAX_BODY) throw new RelayError(413, 'Request body is too large (64 KB max).');
    return parseJson(text);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new RelayError(413, 'Request body is too large (64 KB max).');
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

async function callYou(url, { method = 'POST', key, auth = 'x-api-key', body }) {
  const headers = { Accept: 'application/json' };
  if (auth === 'bearer') headers.Authorization = `Bearer ${key}`;
  else headers['X-API-Key'] = key;
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

function keyHash(key) {
  return createHash('sha256').update(key).digest('hex');
}

async function listModels(key) {
  const h = keyHash(key);
  const hit = modelCache.get(h);
  if (hit && Date.now() - hit.at < MODEL_CACHE_MS) return hit.models;
  const out = await callYou(MODELS_URL, { method: 'GET', key, auth: 'bearer' });
  const data = Array.isArray(out && out.data) ? out.data : [];
  const models = data
    .filter((m) => m && typeof m.id === 'string')
    .filter((m) => {
      const outputs = m.capabilities && Array.isArray(m.capabilities.output) ? m.capabilities.output : null;
      return !outputs || outputs.includes('text');
    })
    .map((m) => ({ id: m.id, maxTokens: typeof m.max_tokens === 'number' ? m.max_tokens : null }));
  modelCache.set(h, { at: Date.now(), models });
  if (modelCache.size > 200) modelCache.delete(modelCache.keys().next().value);
  return models;
}

function rankModels(models) {
  const rank = (id) => {
    const i = MODEL_PREFERENCE.findIndex((re) => re.test(id));
    return i === -1 ? MODEL_PREFERENCE.length : i;
  };
  return models.slice().sort((a, b) => rank(a.id) - rank(b.id));
}

function toMessages(body) {
  const out = [];
  const system = typeof body.system === 'string' ? body.system.trim() : '';
  if (system) out.push({ role: 'system', content: system });
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const m of msgs) {
    if (!m || typeof m.content !== 'string' || !m.content.trim()) continue;
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  if (!out.some((m) => m.role !== 'system')) {
    const input = typeof body.input === 'string' ? body.input.trim() : '';
    if (!input) throw new RelayError(400, 'The agent needs "input" or "messages".');
    out.push({ role: 'user', content: input });
  }
  return out;
}

async function runRouter(key, body) {
  const messages = toMessages(body);
  const requested = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : (process.env.YOU_MODEL || '').trim();
  let candidates;
  if (requested) {
    candidates = [{ id: requested, maxTokens: null }];
  } else {
    const models = rankModels(await listModels(key));
    if (!models.length) throw new RelayError(403, 'This You.com key has no Inference Router models available. Check your plan at you.com/platform.');
    candidates = models.slice(0, 2);
  }
  // Reasoning tokens count toward max_tokens, so a small limit can leave a reasoning model with an empty
  // reply (finish_reason 'length'). Floor at 4096, ask for low reasoning effort, and retry once with a
  // doubled limit if the reply is still empty for lack of room.
  const wanted = Math.max(4096, Math.min(16000, Number(body.maxTokens) || 1500));
  const effort = REASONING_EFFORTS.includes(body.reasoningEffort) ? body.reasoningEffort : 'low';
  let lastErr = null;
  for (const m of candidates) {
    try {
      return await routerCall(key, body, messages, m, wanted, effort);
    } catch (e) {
      lastErr = e;
      // Only an auto-picked model that this key cannot use is worth one more try with the next candidate.
      if (requested || !(e instanceof RelayError) || ![400, 403, 404].includes(e.status)) throw e;
    }
  }
  throw lastErr;
}

const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'];

async function routerCall(key, body, messages, m, wanted, effort) {
  const cap = m.maxTokens || 32000;
  let maxTokens = Math.min(wanted, cap);
  let sendEffort = true;
  let grew = false;
  for (;;) {
    const payload = { model: m.id, messages, stream: false, max_tokens: maxTokens };
    if (sendEffort) payload.reasoning_effort = effort;
    if (typeof body.temperature === 'number') payload.temperature = body.temperature;
    if (body.webSearch) payload.tools = [{ type: 'web_search', max_search_rounds: 2 }];
    let out;
    try {
      out = await callYou(ROUTER_URL, { key, auth: 'bearer', body: payload });
    } catch (e) {
      // A model that rejects reasoning_effort: retry once without it.
      if (sendEffort && e instanceof RelayError && (e.status === 400 || e.status === 422)) {
        sendEffort = false;
        continue;
      }
      throw e;
    }
    const choice = Array.isArray(out.choices) ? out.choices[0] : null;
    const msg = (choice && choice.message) || {};
    const text = typeof msg.content === 'string' ? msg.content.trim() : '';
    if (!text) {
      if (msg.refusal) throw new RelayError(422, `The model declined: ${msg.refusal}`);
      if (choice && choice.finish_reason === 'length') {
        if (!grew && maxTokens < cap) {
          grew = true;
          maxTokens = Math.min(maxTokens * 2, cap);
          continue;
        }
        throw new RelayError(422, 'The model ran out of room before answering. Try a shorter request.');
      }
      throw new RelayError(502, 'The model returned an empty answer.');
    }
    return {
      provider: 'router',
      agent: 'router',
      model: out.model || m.id,
      text,
      finishReason: (choice && choice.finish_reason) || null,
      webResults: out.web_results || null,
      usage: out.usage || null,
    };
  }
}

async function runAnswer(key, body) {
  const query = String(body.input || '').trim();
  if (!query) throw new RelayError(400, 'The Answer API needs "input".');
  if (query.length > 400) throw new RelayError(400, 'The Answer API accepts at most 400 characters of input.');
  const out = await callYou(ANSWER_URL, { key, body: { query, ...pick(body, ANSWER_FIELDS) } });
  return {
    provider: 'answer',
    agent: 'answer',
    text: String(out.answer || '').trim(),
    citations: Array.isArray(out.citations) ? out.citations : [],
    webResults: out.results || null,
  };
}

async function runLegacyAgent(key, body, agent) {
  const input = String(body.input || '').trim() || toMessages(body).map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n');
  try {
    const out = await callYou(AGENTS_URL, { key, auth: 'bearer', body: { agent, input, stream: false } });
    const items = Array.isArray(out.output) ? out.output : [];
    const text = items
      .map((o) => (o && typeof o.text === 'string' ? o.text : o && typeof o.content === 'string' ? o.content : ''))
      .filter(Boolean)
      .join('\n\n')
      .trim();
    if (!text) throw new RelayError(502, 'The You.com agent returned an empty answer.');
    return { provider: 'agents', agent, text, output: items };
  } catch (e) {
    if (e instanceof RelayError && (e.status === 404 || e.status === 410)) return runRouter(key, body);
    throw e;
  }
}

async function opAgent(key, body) {
  const agent = typeof body.agent === 'string' ? body.agent.trim() : '';
  if (!agent || agent === 'router' || agent === 'chat') return runRouter(key, body);
  if (agent === 'answer') return runAnswer(key, body);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(agent)) throw new RelayError(400, 'Unknown agent id.');
  return runLegacyAgent(key, body, agent);
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
  if (!OPS.has(op)) return fail(res, 400, 'Unknown op. Use status, search, extract or agent.');

  if (op === 'status') {
    if (method !== 'GET' && method !== 'POST') return fail(res, 405, 'Use GET for op=status.');
    return send(res, 200, { ok: true, envKey: Boolean(process.env.YOU_API_KEY) });
  }
  if (method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return fail(res, 405, `Use POST for op=${op}.`);
  }

  const userKey = String(header(req, 'x-you-key') || '').trim();
  const key = userKey || String(process.env.YOU_API_KEY || '').trim();
  if (!key) return fail(res, 400, 'No You.com API key. Add yours in Settings → Connections, or set YOU_API_KEY on the deployment.');

  try {
    const body = await readBody(req);
    let data;
    if (op === 'search') data = await opSearch(key, body);
    else if (op === 'extract') data = await opExtract(key, body);
    else data = await opAgent(key, body);
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

// Shared OpenRouter logic for api/ai.js and the temporary op=agent shim in api/you.js
// (Vercel treats files under api/_lib as non-routes).
//
// OpenRouter Chat Completions: POST https://openrouter.ai/api/v1/chat/completions
//   headers: Authorization: Bearer <OPENROUTER_API_KEY>, HTTP-Referer: <site origin>, X-Title: Lens
//   body:    { model, messages: [{ role: 'system'|'user'|'assistant', content }], max_tokens, temperature?, stream: false }
//   answer:  choices[0].message.content, choices[0].finish_reason
//   errors:  { error: { message, code } } with HTTP 400/401/402 (credits)/403/408/429/502/503; errors after generation
//            started can arrive inside an HTTP 200 (top-level `error`, or finish_reason 'error' with choices[0].error).
//
// The model is fixed by the deployment (env OPENROUTER_MODEL, else 'anthropic/claude-sonnet-5.5'); callers cannot pick one.
// Every call is billed to OPENROUTER_API_KEY, so use a key with a credit limit set in OpenRouter (per-key limit).
// Never logs keys or bodies.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5';

export const AI_MAX_BODY = 200 * 1024;
const TIMEOUT_MS = 55000;
const MAX_MESSAGES = 200;
const DEFAULT_MAX_TOKENS = 1500;
const MIN_MAX_TOKENS = 64;
const MAX_MAX_TOKENS = 8000;
const MAX_TEMPERATURE = 1.5;
// Upstream statuses passed through as-is; anything else becomes 502.
const PASS_STATUSES = new Set([400, 401, 402, 403, 408, 413, 422, 429, 502, 503, 504]);

export class AiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function header(req, name) {
  const v = req.headers ? req.headers[name] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

export function model() {
  return String(process.env.OPENROUTER_MODEL || '').trim() || DEFAULT_MODEL;
}

export function apiKey() {
  return String(process.env.OPENROUTER_API_KEY || '').trim();
}

// ------------------------------------------------------------------ same-origin check

function requestHost(req) {
  return String(header(req, 'x-forwarded-host') || header(req, 'host') || '').split(',')[0].trim().toLowerCase();
}

/**
 * Rejects browser requests made from other sites: Sec-Fetch-Site must be 'same-origin' (or 'none') when present,
 * and Origin, when present, must name this request's host. Requests without either header (curl, scripts) pass;
 * this stops other websites from spending the deployment's credits through visitors' browsers, nothing more.
 */
export function assertSameOrigin(req) {
  const site = String(header(req, 'sec-fetch-site') || '').trim().toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') throw new AiError(403, 'Lens AI only answers requests from the Lens app itself.', 'forbidden');
  const origin = String(header(req, 'origin') || '').trim();
  if (!origin) return;
  let originHost = '';
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    originHost = '';
  }
  const host = requestHost(req);
  if (!originHost || !host || originHost !== host) throw new AiError(403, 'Lens AI only answers requests from the Lens app itself.', 'forbidden');
}

// ------------------------------------------------------------------ validation

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function buildPayload(body) {
  if (body.system !== undefined && body.system !== null && typeof body.system !== 'string') {
    throw new AiError(400, '"system" must be a string.', 'invalid');
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw new AiError(400, '"messages" must be a non-empty array of { role, content }.', 'invalid');
  }
  if (body.messages.length > MAX_MESSAGES) throw new AiError(400, `At most ${MAX_MESSAGES} messages.`, 'invalid');
  const messages = [];
  const system = typeof body.system === 'string' ? body.system.trim() : '';
  if (system) messages.push({ role: 'system', content: system });
  for (const m of body.messages) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new AiError(400, 'Each message must be an object { role, content }.', 'invalid');
    if (m.role !== 'user' && m.role !== 'assistant') throw new AiError(400, 'Message roles must be "user" or "assistant" (send the system prompt as "system").', 'invalid');
    if (typeof m.content !== 'string' || !m.content.trim()) throw new AiError(400, 'Each message needs non-empty string "content".', 'invalid');
    messages.push({ role: m.role, content: m.content });
  }
  if (!messages.some((m) => m.role === 'user')) throw new AiError(400, '"messages" needs at least one user message.', 'invalid');

  let maxTokens = DEFAULT_MAX_TOKENS;
  if (body.maxTokens !== undefined && body.maxTokens !== null) {
    const n = Number(body.maxTokens);
    if (!Number.isFinite(n)) throw new AiError(400, '"maxTokens" must be a number.', 'invalid');
    maxTokens = clamp(Math.round(n), MIN_MAX_TOKENS, MAX_MAX_TOKENS);
  }
  const payload = { model: model(), messages, max_tokens: maxTokens, stream: false };
  if (body.temperature !== undefined && body.temperature !== null) {
    const t = Number(body.temperature);
    if (typeof body.temperature !== 'number' || !Number.isFinite(t)) throw new AiError(400, '"temperature" must be a number.', 'invalid');
    payload.temperature = clamp(t, 0, MAX_TEMPERATURE);
  }
  return payload;
}

// ------------------------------------------------------------------ upstream

function siteOrigin(req) {
  const host = String(header(req, 'x-forwarded-host') || header(req, 'host') || '').split(',')[0].trim();
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) return '';
  const proto = String(header(req, 'x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  const scheme = proto === 'http' || proto === 'https' ? proto : /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https';
  return `${scheme}://${host}`;
}

function looksLikeMarkup(text) {
  return /^\s*</.test(text) || /<(html|head|body|title)[\s>]/i.test(text);
}

function errorDetail(body, fallbackText) {
  if (body && typeof body === 'object') {
    const e = body.error;
    if (e && typeof e === 'object' && typeof e.message === 'string') return e.message.slice(0, 300);
    if (typeof e === 'string') return e.slice(0, 300);
    if (typeof body.message === 'string') return body.message.slice(0, 300);
  }
  // Raw (non-JSON) bodies are only used when they are plain text: an HTML error page (e.g. from the CDN) never reaches the user.
  if (!fallbackText || looksLikeMarkup(String(fallbackText))) return '';
  return String(fallbackText).replace(/\s+/g, ' ').trim().slice(0, 200);
}

function upstreamError(status, detail) {
  if (status === 402) return new AiError(402, 'OpenRouter is out of credits.', 'credits');
  if (status === 429) return new AiError(429, 'OpenRouter rate limit reached. Try again in a minute.', 'rate');
  const prefix = {
    400: 'OpenRouter could not process the request',
    401: 'OpenRouter rejected the API key',
    403: 'OpenRouter refused the request',
    408: 'OpenRouter timed out',
    502: 'The AI model is unavailable right now',
    503: 'No AI provider is available right now',
  }[status] || `OpenRouter request failed (HTTP ${status})`;
  const message = detail && !prefix.includes(detail) ? `${prefix}: ${detail}` : `${prefix}.`;
  return new AiError(PASS_STATUSES.has(status) ? status : 502, message, 'upstream');
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p.text === 'string' ? p.text : typeof p === 'string' ? p : '')).join('');
  }
  return '';
}

/** Calls OpenRouter with a payload from buildPayload → { text, model, finishReason }; throws AiError. */
export async function callOpenRouter(req, key, payload) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
    'X-Title': 'Lens',
  };
  const origin = siteOrigin(req);
  if (origin) headers['HTTP-Referer'] = origin;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  let text;
  try {
    res = await fetch(OPENROUTER_URL, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal });
    text = await res.text();
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw new AiError(504, 'The AI took too long to respond (55 s). Try again.', 'upstream');
    throw new AiError(502, 'Could not reach OpenRouter from the server. Try again shortly.', 'upstream');
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) throw upstreamError(res.status, errorDetail(json, json ? '' : text));
  if (!json || typeof json !== 'object') throw new AiError(502, 'OpenRouter returned a response the server could not read.', 'upstream');

  // Errors after generation started can arrive with HTTP 200.
  if (json.error && !Array.isArray(json.choices)) {
    const code = Number(json.error && json.error.code);
    throw upstreamError(Number.isInteger(code) && code >= 400 && code < 600 ? code : 502, errorDetail(json, ''));
  }
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  if (!choice) throw new AiError(502, 'OpenRouter returned no answer.', 'upstream');
  const finishReason = choice.finish_reason || choice.native_finish_reason || null;
  if (finishReason === 'error' || choice.error) {
    const e = choice.error && typeof choice.error === 'object' ? choice.error : {};
    const code = Number(e.code);
    throw upstreamError(Number.isInteger(code) && code >= 400 && code < 600 ? code : 502, typeof e.message === 'string' ? e.message.slice(0, 300) : '');
  }
  const msg = choice.message || {};
  const out = contentText(msg.content).trim();
  if (!out) {
    if (typeof msg.refusal === 'string' && msg.refusal.trim()) throw new AiError(422, `The model declined: ${msg.refusal.trim().slice(0, 300)}`, 'upstream');
    if (finishReason === 'length') throw new AiError(422, 'The model ran out of room before answering. Try a shorter request.', 'upstream');
    throw new AiError(502, 'The model returned an empty answer.', 'upstream');
  }
  return { text: out, model: typeof json.model === 'string' && json.model ? json.model : payload.model, finishReason };
}

/** Relay step shared by both endpoints (call assertSameOrigin first): validate, key check, call. */
export async function relayChat(req, body) {
  const payload = buildPayload(body);
  const key = apiKey();
  if (!key) throw new AiError(500, "AI isn't configured on this deployment (OPENROUTER_API_KEY).", 'no-key');
  return callOpenRouter(req, key, payload);
}

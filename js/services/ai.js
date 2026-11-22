// AI client for Lens. The browser never calls the model provider directly: it POSTs to the same-origin relay
// ./api/ai (api/ai.js on Vercel, or `python3 dev/serve.py` locally), which calls OpenRouter with the
// deployment's OPENROUTER_API_KEY and model (OPENROUTER_MODEL, default anthropic/claude-sonnet-5.5).
//
//   status({ force })                                               → { relay, key, model, confirmed }
//   chat({ system, messages, maxTokens, temperature, signal })      → text
//   json({ system, prompt, shape, maxTokens, temperature, signal }) → parsed JSON (one retry on a parse failure)
//   extractJson(text, expect)                                       → first balanced JSON object/array in text
//
// Relay envelope: { ok: true, data: { text, model, finishReason } } | { ok: false, status, error, code }.
//
// Errors are thrown as Error with a readable .message and, when it applies, .code:
//   'no-relay' — no /api/ai here (file://, plain static hosting, 404/405/501)
//   'no-key'   — the deployment has no OPENROUTER_API_KEY
//   'credits'  — OpenRouter answered 402
//   'rate'     — OpenRouter answered 429
//   'network'  — the Lens server could not be reached
//   'timeout'  — no answer in time

export const RELAY_URL = './api/ai';

const TIMEOUT_MS = 70000; // the relay gives OpenRouter 55 s
const STATUS_RETRY_MS = 10000;

const MESSAGES = {
  'no-relay': 'Lens AI needs the Lens server (the Vercel deployment, or python3 dev/serve.py locally).',
  'no-key': "AI isn't configured on this deployment (OPENROUTER_API_KEY).",
  credits: 'OpenRouter is out of credits.',
  rate: 'OpenRouter rate limit reached. Try again in a minute.',
};

export function codedError(code, message, extra = {}) {
  const err = new Error(message || MESSAGES[code] || 'Something went wrong.');
  if (code) err.code = code;
  Object.assign(err, extra);
  return err;
}

function isFileProtocol() {
  try {
    return location.protocol === 'file:';
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ relay status (cached, retried on network errors)

let statusCache = null; // { relay, key, model, confirmed, at }
let statusPromise = null;

function statusFresh(st) {
  // A reachable relay or a confirmed "no relay" (404 / file://) is final; a network error is retried after a while.
  return Boolean(st && (st.relay || st.confirmed || Date.now() - (st.at || 0) < STATUS_RETRY_MS));
}

/** GET ./api/ai?op=status → { relay, key, model, confirmed }. */
export function status({ force = false } = {}) {
  if (!force && statusFresh(statusCache)) return Promise.resolve(statusCache);
  if (!force && statusPromise) return statusPromise;
  statusPromise = (async () => {
    let st = { relay: false, key: false, model: '', confirmed: isFileProtocol() };
    if (!isFileProtocol()) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(`${RELAY_URL}?op=status`, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
        const body = res.ok ? await res.json().catch(() => null) : null;
        if (body && body.ok) st = { relay: true, key: Boolean(body.key), model: String(body.model || ''), confirmed: true };
        else if (res.status === 404 || res.status === 405 || res.status === 501) st = { ...st, confirmed: true };
      } catch {
        /* unreachable: retried later */
      } finally {
        clearTimeout(timer);
      }
    }
    statusCache = { ...st, at: Date.now() };
    statusPromise = null;
    return statusCache;
  })();
  return statusPromise;
}

/** Throws 'no-relay' / 'no-key' early when the cached status already says calls cannot work. */
async function preflight() {
  if (isFileProtocol()) throw codedError('no-relay');
  const st = await status();
  if (st.confirmed && !st.relay) throw codedError('no-relay');
  if (st.relay && !st.key) throw codedError('no-key');
}

// ------------------------------------------------------------------ relay

/** POST to the relay. Returns `data` from { ok: true, data } or throws a readable Error (.status, .code). */
async function relay(body, { signal, timeout = TIMEOUT_MS } = {}) {
  await preflight();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let res;
  try {
    res = await fetch(RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body || {}),
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (e) {
    if (signal && signal.aborted) throw e;
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw codedError('timeout', 'Lens AI took too long to respond. Try again.');
    throw codedError('network', 'Could not reach the Lens server. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!payload || typeof payload !== 'object' || !('ok' in payload)) {
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      statusCache = { relay: false, key: false, model: '', confirmed: true, at: Date.now() };
      throw codedError('no-relay');
    }
    throw codedError('', res.ok ? 'The Lens AI server sent a response Lens could not read.' : `The Lens AI server failed (HTTP ${res.status}).`, { status: res.status });
  }
  if (!payload.ok) {
    const st = Number(payload.status || res.status) || 0;
    const code = String(payload.code || '');
    const msg = String(payload.error || '');
    if (code === 'no-key') {
      if (statusCache) statusCache = { ...statusCache, key: false };
      throw codedError('no-key', msg || MESSAGES['no-key'], { status: st });
    }
    if (code === 'credits' || st === 402) throw codedError('credits', MESSAGES.credits, { status: st });
    if (code === 'rate' || st === 429) throw codedError('rate', msg || MESSAGES.rate, { status: st });
    throw codedError(code === 'invalid' ? 'invalid' : '', msg || `Lens AI request failed (HTTP ${st}).`, { status: st });
  }
  return payload.data;
}

// ------------------------------------------------------------------ chat

function stripThinking(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function normalizeMessages(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m.content !== 'string' || !m.content.trim()) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${m.content}`;
    else out.push({ role, content: m.content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  if (!out.length) throw codedError('', 'Nothing to send to the AI.');
  return out;
}

/** chat({ system, messages:[{role:'user'|'assistant', content}], maxTokens, temperature, signal }) → text */
export async function chat({ system, messages, maxTokens = 1500, temperature, signal } = {}) {
  const body = { system: String(system || ''), messages: normalizeMessages(messages), maxTokens: Math.round(Number(maxTokens) || 1500) };
  if (typeof temperature === 'number' && Number.isFinite(temperature)) body.temperature = temperature;
  const data = await relay(body, { signal });
  const text = stripThinking(data && data.text);
  if (!text) throw codedError('', 'Lens AI returned an empty answer.');
  return text;
}

// ------------------------------------------------------------------ JSON

// Remove a code fence that wraps the reply (never ``` inside JSON string values).
function stripFences(text) {
  const t = stripThinking(text);
  const whole = t.match(/^```[a-z]*[ \t]*\n?([\s\S]*?)\n?```\s*$/i);
  if (whole) return whole[1].trim();
  const inner = t.match(/```(?:json|javascript|js)?[ \t]*\n([\s\S]*?)\n```/i);
  if (inner && /^\s*[[{]/.test(inner[1])) return inner[1].trim();
  return t;
}

/**
 * Parse the first balanced JSON object/array in a string. `expect` ('{' or '[') skips the other shape,
 * so "Based on [1], here it is: {...}" returns the object. Throws if none parses.
 */
export function extractJson(text, expect) {
  const want = expect === '[' || expect === '{' ? expect : null;
  const fits = (v) => !want || (want === '[' ? Array.isArray(v) : v !== null && typeof v === 'object' && !Array.isArray(v));
  const src = stripFences(text);
  try {
    const whole = JSON.parse(src);
    if (fits(whole)) return whole;
  } catch {
    /* scan below */
  }
  for (let start = 0; start < src.length; start++) {
    const ch = src[start];
    if (ch !== '{' && ch !== '[') continue;
    if (want && ch !== want) continue;
    const close = ch === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < src.length; i++) {
      const c = src[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === ch) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try {
            const v = JSON.parse(src.slice(start, i + 1));
            if (fits(v)) return v;
          } catch {
            /* try the next start */
          }
          break;
        }
      }
    }
  }
  throw new Error('No JSON found in the reply.');
}

/**
 * json({ system, prompt, shape, maxTokens, temperature, signal }) → parsed JSON.
 * Asks for JSON only, parses robustly, and retries once with the parse error.
 */
export async function json({ system, prompt, shape, maxTokens = 2000, temperature, signal } = {}) {
  const sys = [
    system || 'You are a precise assistant.',
    'Respond with valid JSON only: no prose, no markdown fences, no commentary before or after.',
    shape ? `The JSON must match this shape:\n${shape}` : '',
  ].filter(Boolean).join('\n\n');
  const expect = shape ? String(shape).trim()[0] : undefined;
  const messages = [{ role: 'user', content: String(prompt || '') }];
  const first = await chat({ system: sys, messages, maxTokens, temperature, signal });
  try {
    return extractJson(first, expect);
  } catch (e) {
    const retry = await chat({
      system: sys,
      messages: [
        ...messages,
        { role: 'assistant', content: first.slice(0, 4000) },
        { role: 'user', content: `That was not valid JSON (${e.message}). Reply again with only the JSON value, nothing else.` },
      ],
      maxTokens,
      temperature,
      signal,
    });
    try {
      return extractJson(retry, expect);
    } catch {
      throw codedError('', 'Lens AI did not return a usable answer. Try again.');
    }
  }
}

// Warm the status check so the first real call does not wait for it.
if (typeof window !== 'undefined') {
  try {
    queueMicrotask(() => { status(); });
  } catch {
    /* ignore */
  }
}

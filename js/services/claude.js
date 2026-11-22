// Claude Messages API — direct browser call with the user's own key (never sent anywhere else).

import { getState } from '../store.js';

export const API_URL = 'https://api.anthropic.com/v1/messages';
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

const TIMEOUT_MS = 120000;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// Models that think adaptively by default and accept output_config.effort.
const EFFORT_MODELS = /^claude-(fable-5|mythos-5|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|haiku-5)/;
// Models that accept server-side refusal fallbacks (fallbacks: 'default').
const FALLBACK_MODELS = /^claude-(fable-5-[12]|opus-5-5|opus-5$|sonnet-5-5)/;

let fallbacksRejected = false;

export function hasKey() {
  return Boolean((getState().settings?.claudeKey || '').trim());
}

function settings() {
  const s = getState().settings || {};
  const key = (s.claudeKey || '').trim();
  if (!key) throw new Error('Add a Claude API key in Settings → Connections to use AI features.');
  return { key, model: (s.claudeModel || DEFAULT_MODEL).trim() };
}

function normalizeMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = typeof m.content === 'string' ? m.content : m.content;
    if (typeof content === 'string' && !content.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === role && typeof last.content === 'string' && typeof content === 'string') {
      last.content += `\n\n${content}`;
    } else {
      out.push({ role, content });
    }
  }
  while (out.length && out[0].role !== 'user') out.shift();
  while (out.length && out[out.length - 1].role !== 'user') out.pop();
  if (!out.length) throw new Error('Nothing to send to Claude.');
  return out;
}

async function readError(res) {
  let message = '';
  let type = '';
  try {
    const body = await res.json();
    message = body?.error?.message || '';
    type = body?.error?.type || '';
  } catch { /* ignore */ }
  const prefix = {
    400: 'Claude could not process the request',
    401: 'Claude rejected the API key',
    403: 'This Claude key is not allowed to use that model',
    404: 'Claude model not found — check the model name in Settings',
    413: 'The request to Claude was too large',
    429: 'Claude rate limit reached — try again shortly',
    500: 'Claude had an internal error',
    529: 'Claude is overloaded right now — try again in a moment',
  }[res.status] || `Claude request failed (HTTP ${res.status})`;
  const err = new Error(message ? `${prefix}: ${message}` : `${prefix}.`);
  err.status = res.status;
  err.type = type;
  err.apiMessage = message;
  return err;
}

async function send(body, key, useFallbacks, signal) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const payload = { ...body };
  if (useFallbacks) {
    headers['anthropic-beta'] = FALLBACK_BETA;
    payload.fallbacks = 'default';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  try {
    return await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal });
  } catch (e) {
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
      if (signal?.aborted) throw e;
      throw new Error('Claude took too long to respond. Try again.');
    }
    if (e instanceof TypeError) {
      const err = new Error('Could not reach the Claude API from the browser (network or CORS). Check your connection and key.');
      err.code = 'network';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * complete({ system, messages, maxTokens=1200, model, effort, signal }) → assistant text.
 * messages: [{ role: 'user'|'assistant', content }]. A plain `prompt` string is also accepted.
 */
export async function complete({ system, messages, prompt, maxTokens = 1200, model, effort = 'low', signal } = {}) {
  const cfg = settings();
  const useModel = (model || cfg.model || DEFAULT_MODEL).trim();
  const msgs = normalizeMessages(messages || [{ role: 'user', content: prompt || '' }]);
  const thinks = EFFORT_MODELS.test(useModel);
  const body = {
    model: useModel,
    // Adaptive thinking shares max_tokens with the visible answer, so leave headroom for it.
    max_tokens: Math.max(256, Math.round(maxTokens)) + (thinks ? 2048 : 0),
    messages: msgs,
  };
  if (system) body.system = system;
  if (thinks && effort) body.output_config = { effort };

  const wantFallbacks = FALLBACK_MODELS.test(useModel) && !fallbacksRejected;
  let res = await send(body, cfg.key, wantFallbacks, signal);
  if (!res.ok && res.status === 400 && wantFallbacks) {
    const err = await readError(res.clone());
    if (/fallback|beta|anthropic-beta/i.test(err.apiMessage || '')) {
      fallbacksRejected = true;
      res = await send(body, cfg.key, false, signal);
    } else {
      throw err;
    }
  }
  if (!res.ok) throw await readError(res);

  let data;
  try { data = await res.json(); } catch { throw new Error('Claude returned a response Lens could not read.'); }
  if (data?.stop_reason === 'refusal') {
    const why = data?.stop_details?.explanation;
    throw new Error(`Claude declined this request${why ? `: ${why}` : '.'}`);
  }
  const text = (data?.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) {
    if (data?.stop_reason === 'max_tokens') throw new Error('Claude ran out of room before answering. Try a shorter request.');
    throw new Error('Claude returned an empty answer.');
  }
  return text;
}

/**
 * Find and parse the first balanced JSON object/array in a string. `expect` ('{' or '[') skips
 * candidates of the other shape. Only a fence wrapping the reply is stripped. Throws if none parses.
 */
export function extractJson(text, expect) {
  const want = expect === '[' || expect === '{' ? expect : null;
  const fits = (v) => !want || (want === '[' ? Array.isArray(v) : v !== null && typeof v === 'object' && !Array.isArray(v));
  let src = String(text || '').trim();
  const fenced = src.match(/^```[a-z]*[ \t]*\n?([\s\S]*?)\n?```\s*$/i);
  if (fenced) src = fenced[1].trim();
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
            /* not JSON — try the next start */
          }
          break;
        }
      }
    }
  }
  throw new Error('No JSON found in Claude response.');
}

/**
 * json({ system, prompt, schemaHint, maxTokens, model }) → parsed JSON.
 * Retries once with the parse error if the first answer is not valid JSON.
 */
export async function json({ system, prompt, schemaHint, maxTokens = 2000, model, effort = 'low', signal } = {}) {
  const sys = [
    system || 'You are a precise assistant.',
    'Respond with valid JSON only — no prose, no markdown fences.',
    schemaHint ? `The JSON must match this shape:\n${typeof schemaHint === 'string' ? schemaHint : JSON.stringify(schemaHint, null, 2)}` : '',
  ].filter(Boolean).join('\n\n');
  const messages = [{ role: 'user', content: prompt }];
  const expect = typeof schemaHint === 'string' ? schemaHint.trim()[0] : Array.isArray(schemaHint) ? '[' : schemaHint ? '{' : undefined;
  const first = await complete({ system: sys, messages, maxTokens, model, effort, signal });
  try {
    return extractJson(first, expect);
  } catch {
    const retry = await complete({
      system: sys,
      messages: [
        ...messages,
        { role: 'assistant', content: first.slice(0, 4000) },
        { role: 'user', content: 'That was not valid JSON. Reply again with only the JSON value, nothing else.' },
      ],
      maxTokens,
      model,
      effort,
      signal,
    });
    try {
      return extractJson(retry, expect);
    } catch {
      throw new Error('Claude did not return valid JSON.');
    }
  }
}

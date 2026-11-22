// You.com via Lens's same-origin relay (api/you.js on Vercel, or `python3 dev/serve.py` locally).
// The browser never calls You.com directly: it POSTs to ./api/you?op=search|extract|agent and sends the
// user's own key (if any) in `x-you-key`; without one the relay may use the deployment's YOU_API_KEY.
//
// Upstream APIs the relay forwards to (checked against you.com/docs):
//   search  → POST https://ydc-index.io/v1/search  { query, count 1-100, freshness day|week|month|year|range,
//             country, language, include_domains[], exclude_domains[], offset 0-9, safesearch }
//             → { results: { web: [{ url, title, description, snippets[], page_age, thumbnail_url, favicon_url, contents? }] } }
//   extract → POST https://ydc-index.io/v1/extract { url, full_page: { extraction_formats: ['markdown'] } }
//             → { url, title, contents: { full_page: { markdown } }, metadata }
//   agent   → Inference Router POST https://api.you.com/v1/chat/completions (default), Answer API (agent 'answer'),
//             or the legacy Agents API /v1/agents/runs (agent 'express' | 'advanced' | custom id).
//   Relay envelope: { ok: true, data } | { ok: false, status, error }.

import { getState, setState } from '../store.js';

export const RELAY_URL = './api/you';
export const SEARCH_URL = 'https://ydc-index.io/v1/search';
export const EXTRACT_URL = 'https://ydc-index.io/v1/extract';
export const NO_RELAY_MESSAGE = 'Live mode needs the Vercel deployment (or `python3 dev/serve.py` locally) — showing demo data.';

const TIMEOUT_MS = 30000;
const AGENT_TIMEOUT_MS = 70000;
const FRESHNESS_ALIASES = { pd: 'day', pw: 'week', pm: 'month', py: 'year', '24h': 'day', '7d': 'week', '30d': 'month' };

// ------------------------------------------------------------------ relay status (cached once per page load)

let statusCache = null; // { ok, envKey, relay }
let statusPromise = null;

function isFileProtocol() {
  try {
    return location.protocol === 'file:';
  } catch {
    return false;
  }
}

function publishStatus(st) {
  try {
    setState((s) => ({ ui: { ...(s.ui || {}), relay: { envKey: st.envKey, available: st.relay, checkedAt: new Date().toISOString() } } }));
  } catch {
    /* store not ready */
  }
}

/** GET ./api/you?op=status once → { ok, envKey, relay }. `relay:false` means no relay (static hosting / file://). */
export function status({ force = false } = {}) {
  if (!force && statusCache) return Promise.resolve(statusCache);
  if (!force && statusPromise) return statusPromise;
  statusPromise = (async () => {
    let st = { ok: false, envKey: false, relay: false };
    if (!isFileProtocol()) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(`${RELAY_URL}?op=status`, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
        const body = res.ok ? await res.json().catch(() => null) : null;
        if (body && body.ok) st = { ok: true, envKey: Boolean(body.envKey), relay: true };
      } catch {
        /* unreachable → relay:false */
      } finally {
        clearTimeout(timer);
      }
    }
    statusCache = st;
    statusPromise = null;
    publishStatus(st);
    return st;
  })();
  return statusPromise;
}

/** Last known relay status without waiting (null until the first check finishes). */
export function cachedStatus() {
  return statusCache;
}

function userKey() {
  return String(getState().settings?.youKey || '').trim();
}

export function hasUserKey() {
  return Boolean(userKey());
}

/** True when live You.com calls can be made: the user's own key, or an owner key on the server. */
export function hasKey() {
  if (hasUserKey()) return true;
  if (!statusCache && !statusPromise) status();
  return Boolean(statusCache?.envKey);
}

// Kick off the status check early so hasKey() is accurate by the time views ask.
if (typeof window !== 'undefined') queueMicrotask(() => { status(); });

// ------------------------------------------------------------------ helpers

/** Map a URL's hostname to a Lens source id. */
export function detectSource(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return 'web'; }
  if (host === 'reddit.com' || host.endsWith('.reddit.com') || host === 'redd.it') return 'reddit';
  if (host === 'news.ycombinator.com') return 'hackernews';
  if (host === 'x.com' || host === 'twitter.com' || host.endsWith('.x.com') || host.endsWith('.twitter.com')) return 'x';
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) return 'linkedin';
  if (host === 'indiehackers.com' || host.endsWith('.indiehackers.com')) return 'indiehackers';
  if (host === 'producthunt.com' || host.endsWith('.producthunt.com')) return 'producthunt';
  return 'web';
}

function normalizeFreshness(f) {
  if (!f) return undefined;
  const v = String(f).trim().toLowerCase();
  if (FRESHNESS_ALIASES[v]) return FRESHNESS_ALIASES[v];
  if (['day', 'week', 'month', 'year'].includes(v)) return v;
  if (/^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return undefined;
}

function normalizeDomains(list) {
  if (!list) return [];
  const arr = Array.isArray(list) ? list : [list];
  const out = [];
  for (const raw of arr) {
    if (!raw) continue;
    let d = String(raw).trim().toLowerCase().replace(/^site:/, '');
    try { if (/^https?:\/\//.test(d)) d = new URL(d).hostname; } catch { /* keep as typed */ }
    d = d.replace(/^www\./, '').replace(/\/.*$/, '');
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

function toIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function noRelayError() {
  const err = new Error(NO_RELAY_MESSAGE);
  err.code = 'no-relay';
  err.status = 404;
  return err;
}

/** POST to the relay. Returns the `data` of { ok: true, data } or throws a readable Error (err.status, err.code). */
export async function relay(op, body, { key, signal, timeout = TIMEOUT_MS } = {}) {
  if (isFileProtocol()) throw noRelayError();
  const k = String(key || userKey() || '').trim();
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (k) headers['x-you-key'] = k;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeout);
  const onAbort = () => controller.abort(signal.reason);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let res;
  try {
    res = await fetch(`${RELAY_URL}?op=${encodeURIComponent(op)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
      if (signal?.aborted) throw e;
      throw new Error('You.com took too long to respond. Try again.');
    }
    const err = new Error('Could not reach the Lens server to talk to You.com. Check your connection and try again.');
    err.code = 'network';
    throw err;
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
  // A 404/405 without our envelope means there is no relay here (plain static hosting).
  if (!payload || typeof payload !== 'object' || !('ok' in payload)) {
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      statusCache = { ok: false, envKey: false, relay: false };
      publishStatus(statusCache);
      throw noRelayError();
    }
    const err = new Error(res.ok ? 'The You.com relay returned a response Lens could not read.' : `The You.com relay failed (HTTP ${res.status}).`);
    err.status = res.status;
    throw err;
  }
  if (!payload.ok) {
    const err = new Error(payload.error || `You.com request failed (HTTP ${payload.status || res.status}).`);
    err.status = payload.status || res.status;
    err.detail = payload.detail;
    throw err;
  }
  return payload.data;
}

function normalizeResult(r) {
  const url = r?.url || '';
  const snippets = Array.isArray(r?.snippets) ? r.snippets.filter(Boolean) : [];
  const highlights = Array.isArray(r?.contents?.highlights) ? r.contents.highlights.filter(Boolean) : [];
  const description = r?.description || '';
  const snippet = (highlights.join(' ') || snippets.join(' ') || description || '').replace(/\s+/g, ' ').trim();
  return {
    title: (r?.title || '').trim() || url,
    url,
    snippet,
    description,
    snippets: highlights.length ? highlights : snippets,
    publishedAt: toIso(r?.page_age || r?.age || r?.published_date),
    source: detectSource(url),
    thumbnail: r?.thumbnail_url || r?.thumbnail?.src || null,
    favicon: r?.favicon_url || null,
  };
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = item.url.replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase();
    if (!item.url || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// ------------------------------------------------------------------ public API

/**
 * Web search. Returns normalized [{ title, url, snippet, publishedAt, source, ... }].
 * opts: { count=10, freshness, siteFilters (domains to include), excludeDomains, country, language, offset, key, signal }
 */
export async function search(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const { count = 10, freshness, siteFilters, excludeDomains, country, language, offset, key, signal } = opts;
  const body = { query: q, count: Math.max(1, Math.min(100, Number(count) || 10)) };
  const f = normalizeFreshness(freshness);
  if (f) body.freshness = f;
  const include = normalizeDomains(siteFilters);
  const exclude = normalizeDomains(excludeDomains);
  if (include.length) body.include_domains = include;
  else if (exclude.length) body.exclude_domains = exclude;
  if (country) body.country = String(country).toUpperCase();
  if (language) body.language = String(language).toUpperCase();
  if (offset) body.offset = Math.max(0, Math.min(9, Number(offset) || 0));
  const data = await relay('search', body, { key, signal });
  const web = Array.isArray(data?.results?.web) ? data.results.web : [];
  const news = Array.isArray(data?.results?.news) ? data.results.news : [];
  return dedupe([...web, ...news].map(normalizeResult));
}

/** Recent news for a query (news is ranked within web results; freshness defaults to 'week'). Newest first. */
export async function news(query, opts = {}) {
  const results = await search(query, { count: 12, ...opts, freshness: opts.freshness || 'week' });
  return results.sort((a, b) => (Date.parse(b.publishedAt || 0) || 0) - (Date.parse(a.publishedAt || 0) || 0));
}

/**
 * Full-page content for URLs via the Extract API (one request per URL, max 5).
 * Returns [{ url, title, markdown, error? }] in input order; failures are reported per item.
 */
export async function contents(urls, { key, signal } = {}) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean).slice(0, 5);
  const settled = await Promise.allSettled(
    list.map((url) => relay('extract', { url, full_page: { extraction_formats: ['markdown'] } }, { key, signal })),
  );
  return settled.map((s, i) => {
    if (s.status === 'rejected') return { url: list[i], title: '', markdown: '', error: s.reason?.message || 'Extract failed' };
    const v = s.value || {};
    return {
      url: v.url || list[i],
      title: v.title || '',
      markdown: v.contents?.full_page?.markdown || v.contents?.markdown || '',
    };
  });
}

/**
 * LLM answer through the relay (op=agent).
 * input: a string prompt. opts: { agent ('router' default | 'answer' | 'express' | 'advanced' | custom id),
 *   system, messages [{role, content}], model, maxTokens, webSearch, key, signal }
 * Returns { text, provider, agent, model?, citations?, webResults? }.
 */
export async function agent(input, opts = {}) {
  const { agent: agentId, system, messages, model, maxTokens, webSearch, temperature, key, signal } = opts;
  const body = { input: String(input || '') };
  if (agentId) body.agent = agentId;
  if (system) body.system = String(system);
  if (Array.isArray(messages) && messages.length) body.messages = messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }));
  const m = model || String(getState().settings?.youModel || '').trim();
  if (m) body.model = m;
  if (maxTokens) body.maxTokens = Math.round(maxTokens);
  if (webSearch) body.webSearch = true;
  if (typeof temperature === 'number') body.temperature = temperature;
  const data = await relay('agent', body, { key, signal, timeout: AGENT_TIMEOUT_MS });
  const text = String(data?.text || '').trim();
  if (!text) throw new Error('You.com returned an empty answer.');
  return { ...data, text };
}

// You.com search + extract client for Lens. The browser never calls You.com directly: it POSTs to the same-origin
// relay ./api/you?op=search|extract (api/you.js on Vercel, or `python3 dev/serve.py` locally) and the relay
// uses the deployment's YOU_API_KEY (or a key sent in `x-you-key`). AI (LLM) calls live in ./ai.js (OpenRouter).
//
// Relay envelope: { ok: true, data } | { ok: false, status, error }.
//   search  → data = You.com Web Search response { results: { web: [{ url, title, description, snippets[], page_age }], news? } }
//   extract → data = { url, title, contents: { full_page: { markdown } } }
//
// Errors are thrown as Error with a readable .message and, when it applies, .code:
//   'no-relay' — no /api/you here (file://, plain static hosting, 404)
//   'no-key'   — neither a user key nor the deployment's YOU_API_KEY
//   'credits'  — You.com answered 402

export const RELAY_URL = './api/you';

const TIMEOUT_MS = 30000;
const STATUS_RETRY_MS = 10000;
const USER_KEY_STORAGE = 'lens-you-key'; // optional: a developer may set their own key here from the console

const MESSAGES = {
  'no-relay': 'You.com needs the Lens server (the Vercel deployment, or python3 dev/serve.py locally).',
  'no-key': 'You.com isn’t set up on this deployment yet (no API key).',
  credits: 'You.com is out of API credits for this key.',
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

function userKey() {
  try {
    return String(localStorage.getItem(USER_KEY_STORAGE) || '').trim();
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------ relay status (cached, retried on network errors)

let statusCache = null; // { relay, envKey, confirmed, at }
let statusPromise = null;

function statusFresh(st) {
  // A reachable relay or a confirmed "no relay" (404 / file://) is final; a network error is retried after a while.
  return Boolean(st && (st.relay || st.confirmed || Date.now() - (st.at || 0) < STATUS_RETRY_MS));
}

/** GET ./api/you?op=status → { relay, envKey, confirmed }. */
export function status({ force = false } = {}) {
  if (!force && statusFresh(statusCache)) return Promise.resolve(statusCache);
  if (!force && statusPromise) return statusPromise;
  statusPromise = (async () => {
    let st = { relay: false, envKey: false, confirmed: isFileProtocol() };
    if (!isFileProtocol()) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(`${RELAY_URL}?op=status`, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
        const body = res.ok ? await res.json().catch(() => null) : null;
        if (body && body.ok) st = { relay: true, envKey: Boolean(body.envKey), confirmed: true };
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
  if (st.relay && !st.envKey && !userKey()) throw codedError('no-key');
}

// ------------------------------------------------------------------ relay

/** POST to the relay. Returns `data` from { ok: true, data } or throws a readable Error (.status, .code). */
export async function relay(op, body, { signal, timeout = TIMEOUT_MS } = {}) {
  await preflight();
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const k = userKey();
  if (k) headers['x-you-key'] = k;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const onAbort = () => controller.abort();
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
    if (signal && signal.aborted) throw e;
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw codedError('', 'You.com took too long to respond. Try again.');
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
      statusCache = { relay: false, envKey: false, confirmed: true, at: Date.now() };
      throw codedError('no-relay');
    }
    throw codedError('', res.ok ? 'The You.com relay sent a response Lens could not read.' : `The You.com relay failed (HTTP ${res.status}).`, { status: res.status });
  }
  if (!payload.ok) {
    const st = Number(payload.status || res.status) || 0;
    const msg = String(payload.error || '');
    if (st === 402) throw codedError('credits', MESSAGES.credits, { status: st });
    if (st === 400 && /no you\.com api key/i.test(msg)) throw codedError('no-key', MESSAGES['no-key'], { status: st });
    throw codedError('', msg || `You.com request failed (HTTP ${st}).`, { status: st });
  }
  return payload.data;
}

// ------------------------------------------------------------------ search / extract

function toIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeResult(r) {
  const url = String((r && r.url) || '');
  const snippets = Array.isArray(r && r.snippets) ? r.snippets.filter(Boolean) : [];
  const description = String((r && r.description) || '');
  const snippet = (snippets.join(' ') || description).replace(/\s+/g, ' ').trim();
  return {
    title: String((r && r.title) || '').trim() || url,
    url,
    snippet,
    publishedAt: toIso(r && (r.page_age || r.age || r.published_date)),
  };
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!/^https?:\/\//i.test(item.url)) continue;
    const key = item.url.replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Web search → [{ title, url, snippet, publishedAt }].
 * opts: { count=10, freshness ('day'|'week'|'month'|'year'), includeDomains: [], signal }
 */
export async function search(query, { count = 10, freshness, includeDomains, signal } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const body = { query: q, count: Math.max(1, Math.min(50, Number(count) || 10)) };
  if (['day', 'week', 'month', 'year'].includes(freshness)) body.freshness = freshness;
  if (Array.isArray(includeDomains) && includeDomains.length) body.include_domains = includeDomains;
  const data = await relay('search', body, { signal });
  const results = (data && data.results) || {};
  const web = Array.isArray(results.web) ? results.web : [];
  const news = Array.isArray(results.news) ? results.news : [];
  return dedupe([...web, ...news].map(normalizeResult));
}

/** Full page as markdown → { url, title, markdown }. */
export async function extract(url, { signal } = {}) {
  const data = await relay('extract', { url, full_page: { extraction_formats: ['markdown'] } }, { signal });
  const v = Array.isArray(data) ? data[0] || {} : Array.isArray(data && data.results) ? data.results[0] || {} : data || {};
  const contents = v.contents || {};
  const markdown = (contents.full_page && contents.full_page.markdown) || contents.markdown || v.markdown || '';
  return { url: v.url || url, title: String(v.title || ''), markdown: String(markdown || '') };
}

// Warm the status check so the first real call does not wait for it.
if (typeof window !== 'undefined') {
  try {
    queueMicrotask(() => { status(); });
  } catch {
    /* ignore */
  }
}

// LinkedIn, browser side. The access token never reaches JavaScript: it lives in an HttpOnly session cookie
// set by the Vercel functions under /api/linkedin/*.
//
//   status()     GET  /api/linkedin/me      → { connected, name?, picture? }
//   connect()    navigates to /api/linkedin/start?return=<path+hash> (LinkedIn sign-in, then back here)
//   disconnect() POST /api/linkedin/logout
//   publish()    POST /api/linkedin/post    { text, imageUrl? } → { id, url }
//
// The callback redirects back with ?li=connected or ?li=error&reason=<code>; lens.init() reads and strips it.

const BASE = './api/linkedin';
const UNAVAILABLE = 'LinkedIn sign-in needs the Vercel deployment of Lens.';
const STATUS_TIMEOUT_MS = 10000;

let state = { connected: false };
let available = null; // null unknown · true functions exist · false no functions here (static hosting / dev server)
const listeners = new Set();

function codedError(code, message, extra = {}) {
  const err = new Error(message);
  if (code) err.code = code;
  Object.assign(err, extra);
  return err;
}

function set(next) {
  state = next;
  for (const fn of [...listeners]) {
    try { fn(state); } catch (e) { console.warn('[Lens] LinkedIn listener failed', e); }
  }
}

/** Last known status (sync). */
export function current() {
  return { ...state };
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function isFileProtocol() {
  try { return location.protocol === 'file:'; } catch { return false; }
}

async function readJson(res) {
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (!type.includes('application/json')) return null;
  try { return await res.json(); } catch { return null; }
}

/** GET /api/linkedin/me → { connected, name?, picture?, error? } (never throws). */
export async function status() {
  if (isFileProtocol()) {
    available = false;
    set({ connected: false });
    return current();
  }
  let res;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  try {
    res = await fetch(`${BASE}/me`, { headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
  } catch {
    // Network blip or a stalled function: keep what we knew.
    return current();
  } finally {
    clearTimeout(timer);
  }
  const body = await readJson(res);
  // No LinkedIn functions here: static hosting (404/405) or the local dev server (501 JSON).
  if (!body || res.status === 404 || res.status === 405 || res.status === 501) {
    available = false;
    set({ connected: false });
    return current();
  }
  available = true;
  if (res.ok && body.connected) {
    const next = { connected: true };
    if (typeof body.name === 'string' && body.name) next.name = body.name;
    if (typeof body.picture === 'string' && /^https:\/\//i.test(body.picture)) next.picture = body.picture;
    set(next);
  } else {
    const next = { connected: false };
    if (!res.ok && body.error) next.error = String(body.error);
    set(next);
  }
  return current();
}

/** Mark an error from an OAuth return (shown under the row) without a network call. */
export function setError(message) {
  set({ ...state, connected: false, error: String(message || '') });
}

/** Start LinkedIn sign-in. Navigates away (throws code 'redirect'); throws a readable error when unavailable. */
export async function connect() {
  if (available === null) await status();
  if (available === false) {
    const err = codedError('', UNAVAILABLE);
    set({ connected: false, error: UNAVAILABLE });
    throw err;
  }
  if (state.error && /isn.t configured/i.test(state.error)) throw codedError('', state.error);
  const back = `${location.pathname}${location.hash || ''}`;
  location.assign(`${BASE}/start?return=${encodeURIComponent(back)}`);
  throw codedError('redirect', 'Opening LinkedIn sign-in…');
}

/** POST /api/linkedin/logout (clears the session cookie). */
export async function disconnect() {
  if (!isFileProtocol()) {
    try {
      await fetch(`${BASE}/logout`, { method: 'POST', headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' });
    } catch {
      /* the cookie ends with the browser session anyway */
    }
  }
  set({ connected: false });
}

/** POST /api/linkedin/post { text, imageUrl? } → { id, url, imageSkipped? } */
export async function publish({ text, imageUrl } = {}) {
  if (isFileProtocol() || available === false) throw codedError('not-connected', UNAVAILABLE);
  const body = { text: String(text || '') };
  if (imageUrl) body.imageUrl = imageUrl;
  let res;
  try {
    res = await fetch(`${BASE}/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch {
    throw codedError('network', 'Could not reach the Lens server to post to LinkedIn. Check your connection.');
  }
  const out = await readJson(res);
  if (!out || res.status === 501) {
    if (res.status === 404 || res.status === 501) {
      available = false;
      throw codedError('not-connected', UNAVAILABLE);
    }
    if (res.status === 413) throw codedError('', 'That image is too large to post. Remove the visual or use a smaller one.');
    throw codedError('', `LinkedIn posting failed (HTTP ${res.status}).`);
  }
  if (res.status === 401) {
    const msg = String(out.error || 'Connect LinkedIn first.');
    set({ connected: false, ...(out.expired ? { error: msg } : {}) });
    throw codedError('not-connected', msg, { status: 401 });
  }
  if (!res.ok || !out.id) throw codedError('', String(out.error || `LinkedIn posting failed (HTTP ${res.status}).`), { status: res.status });
  return { id: String(out.id), url: typeof out.url === 'string' ? out.url : undefined, imageSkipped: Boolean(out.imageSkipped) };
}

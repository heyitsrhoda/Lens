// Browser MCP client (Streamable HTTP transport + OAuth 2.1 with PKCE) — used for Sculptex only.
//
// Verified against the live server:
//   POST <server>/mcp without a token → 401, WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"
//   Protected resource metadata: { resource: "<origin>/mcp", authorization_servers: ["<origin>"], scopes_supported: ["mcp"] }
//   Authorization server metadata: authorization_endpoint /oauth/authorize, token_endpoint /oauth/token,
//     registration_endpoint /oauth/register, code_challenge_methods_supported ["S256"], token auth 'none' supported.
//   CORS: Access-Control-Allow-Origin *, exposes WWW-Authenticate + Mcp-Session-Id, methods GET/POST/OPTIONS.
//
// Connection state (tokens, session id, tools, status) only lives in state.connections, which the
// store persists to sessionStorage — closing the tab forgets it. The pending OAuth record also
// lives in sessionStorage only.

import { getState, setState, toast } from '../store.js';

export const PROTOCOL_VERSION = '2025-06-18';
export const DEFAULT_URLS = { sculptex: 'https://sculptex-git-main-jacksonschorr.vercel.app/mcp' };
const LABELS = { sculptex: 'Sculptex' };

const PENDING_KEY = 'lens_mcp_pending_v1';
const CLIENTS_KEY = 'lens_mcp_clients_v1';
const RPC_TIMEOUT_MS = 30000;
const CALL_TIMEOUT_MS = 240000;
const PENDING_MAX_AGE_MS = 30 * 60 * 1000;

const runtime = {}; // per key, page-lifetime only: { initialized, protocolVersion, initPromise }
let rpcCounter = 0;
let callbackPromise = null;

class AuthRequiredError extends Error {
  constructor(message, resourceMetadataUrl) {
    super(message);
    this.name = 'AuthRequiredError';
    this.resourceMetadataUrl = resourceMetadataUrl || null;
  }
}

// ---------------------------------------------------------------- state helpers

function label(key) {
  return LABELS[key] || key;
}

export function getConnection(key) {
  const c = getState().connections?.[key] || {};
  return {
    ...c,
    url: c.url || DEFAULT_URLS[key] || '',
    status: c.status || 'disconnected',
    tools: Array.isArray(c.tools) ? c.tools : [],
    auth: c.auth || null,
    sessionId: c.sessionId || null,
    error: c.error || '',
  };
}

export function isConnected(key) {
  return getConnection(key).status === 'connected';
}

function patchConn(key, patch) {
  setState((s) => {
    const all = s.connections || {};
    const prev = all[key] || { url: DEFAULT_URLS[key] || '' };
    return { connections: { ...all, [key]: { ...prev, ...patch } } };
  });
}

function rt(key) {
  if (!runtime[key]) runtime[key] = { initialized: false, protocolVersion: PROTOCOL_VERSION, initPromise: null };
  return runtime[key];
}

function readSession(name) {
  try { return JSON.parse(sessionStorage.getItem(name) || '{}') || {}; } catch { return {}; }
}

function writeSession(name, value) {
  try { sessionStorage.setItem(name, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

function savePending(state, record) {
  const all = readSession(PENDING_KEY);
  const now = Date.now();
  for (const [k, v] of Object.entries(all)) if (!v?.createdAt || now - v.createdAt > PENDING_MAX_AGE_MS) delete all[k];
  all[state] = { ...record, createdAt: now };
  writeSession(PENDING_KEY, all);
}

function takePending(state) {
  const all = readSession(PENDING_KEY);
  const rec = all[state] || null;
  delete all[state];
  writeSession(PENDING_KEY, all);
  return rec;
}

function clearPendingFor(key) {
  const all = readSession(PENDING_KEY);
  for (const [k, v] of Object.entries(all)) if (v?.key === key) delete all[k];
  writeSession(PENDING_KEY, all);
}

// ---------------------------------------------------------------- utils

function redirectUri() {
  return location.origin + location.pathname;
}

function base64url(bytes) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return base64url(a);
}

async function pkceChallenge(verifier) {
  if (!crypto?.subtle) throw new Error('Secure sign-in needs HTTPS or localhost (Web Crypto is unavailable here).');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(digest);
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function safeFetch(url, init, what, timeoutMs = RPC_TIMEOUT_MS) {
  const t = withTimeout(timeoutMs);
  try {
    return await fetch(url, { ...init, signal: t.signal });
  } catch (e) {
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') throw new Error(`${what} timed out.`);
    if (e instanceof TypeError) throw new Error(`${what} failed: the server could not be reached from the browser (network or CORS).`);
    throw e;
  } finally {
    t.done();
  }
}

async function getJson(url) {
  try {
    const res = await safeFetch(url, { headers: { Accept: 'application/json' } }, 'Discovery', 15000);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function parseResourceMetadata(header) {
  if (!header) return null;
  const m = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header) || /resource_metadata\s*=\s*([^\s,]+)/i.exec(header);
  return m ? m[1] : null;
}

function errorText(body, fallback) {
  if (!body) return fallback;
  if (typeof body === 'string') return body.slice(0, 200) || fallback;
  return body.error_description || body.error?.message || body.message || (typeof body.error === 'string' ? body.error : '') || fallback;
}

// ---------------------------------------------------------------- transport

function parseSseEvents(buffer) {
  // Returns { events: [dataString], rest }
  const events = [];
  const normalized = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop();
  for (const block of parts) {
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) events.push(data.join('\n'));
  }
  return { events, rest };
}

async function readSse(res, id) {
  if (!res.body) {
    const { events } = parseSseEvents(`${await res.text()}\n\n`);
    for (const ev of events) {
      const msg = tryParse(ev);
      const hit = findResponse(msg, id);
      if (hit) return hit;
    }
    return null;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += '\n\n';
      const { events, rest } = parseSseEvents(buffer);
      buffer = rest;
      for (const ev of events) {
        const hit = findResponse(tryParse(ev), id);
        if (hit) return hit;
      }
      if (done) return null;
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

function tryParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function findResponse(msg, id) {
  if (!msg) return null;
  const list = Array.isArray(msg) ? msg : [msg];
  return list.find((m) => m && m.id === id && ('result' in m || 'error' in m)) || null;
}

async function ensureFreshToken(key) {
  const { auth } = getConnection(key);
  if (auth?.refreshToken && auth.expiresAt && auth.expiresAt - Date.now() < 30000) {
    try { await refresh(key); } catch { /* the 401 path will handle it */ }
  }
}

/**
 * Send one JSON-RPC message. For requests returns the `result`; for notifications returns null.
 * Handles JSON and SSE responses, Mcp-Session-Id, token refresh on 401 (once), session re-init on 404.
 */
async function rpc(key, method, params, { notification = false, timeoutMs = RPC_TIMEOUT_MS, retried = false, reinit = false } = {}) {
  await ensureFreshToken(key);
  const conn = getConnection(key);
  if (!conn.url) throw new Error(`No server URL configured for ${label(key)}.`);
  const id = notification ? undefined : `lens-${Date.now().toString(36)}-${++rpcCounter}`;
  const message = { jsonrpc: '2.0', method };
  if (params !== undefined) message.params = params;
  if (!notification) message.id = id;

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (method !== 'initialize') headers['MCP-Protocol-Version'] = rt(key).protocolVersion || PROTOCOL_VERSION;
  if (conn.sessionId && method !== 'initialize') headers['Mcp-Session-Id'] = conn.sessionId;
  if (conn.auth?.accessToken) headers.Authorization = `Bearer ${conn.auth.accessToken}`;

  const t = withTimeout(timeoutMs);
  let res;
  try {
    res = await fetch(conn.url, { method: 'POST', headers, body: JSON.stringify(message), signal: t.signal });
  } catch (e) {
    t.done();
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') throw new Error(`${label(key)} did not answer "${method}" in time.`);
    if (e instanceof TypeError) throw new Error(`Could not reach ${label(key)} (network or CORS). Check your connection and try again.`);
    throw e;
  }

  try {
    const sid = res.headers.get('mcp-session-id');
    if (sid && sid !== conn.sessionId) patchConn(key, { sessionId: sid });

    if (res.status === 401) {
      const metaUrl = parseResourceMetadata(res.headers.get('www-authenticate'));
      if (!retried && conn.auth?.refreshToken) {
        try {
          await refresh(key);
          t.done();
          return rpc(key, method, params, { notification, timeoutMs, retried: true, reinit });
        } catch { /* fall through to auth required */ }
      }
      let detail = '';
      try { detail = errorText(await res.json(), ''); } catch { /* no body */ }
      throw new AuthRequiredError(detail || `${label(key)} needs you to sign in.`, metaUrl);
    }

    if (res.status === 404 && conn.sessionId && !notification && method !== 'initialize' && !reinit) {
      // Session expired on the server: start a new one and retry once.
      patchConn(key, { sessionId: null });
      rt(key).initialized = false;
      t.done();
      await initialize(key);
      return rpc(key, method, params, { notification, timeoutMs, retried, reinit: true });
    }

    if (notification) {
      if (!res.ok && res.status !== 202) throw new Error(`${label(key)} rejected ${method} (HTTP ${res.status}).`);
      return null;
    }

    if (!res.ok) {
      let detail = '';
      try { detail = errorText(await res.json(), ''); } catch { /* no body */ }
      throw new Error(`${label(key)} returned HTTP ${res.status}${detail ? `: ${detail}` : ''}.`);
    }

    const type = (res.headers.get('content-type') || '').toLowerCase();
    let reply;
    try {
      if (type.includes('text/event-stream')) {
        reply = await readSse(res, id);
      } else {
        const text = await res.text();
        reply = findResponse(tryParse(text), id);
      }
    } catch (e) {
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError') throw new Error(`${label(key)} did not finish "${method}" in time.`);
      throw new Error(`${label(key)} connection dropped while answering "${method}".`);
    }
    if (!reply) throw new Error(`${label(key)} sent no reply to ${method}.`);
    if (reply.error) {
      const err = new Error(`${label(key)}: ${reply.error.message || 'request failed'}${reply.error.code ? ` (code ${reply.error.code})` : ''}`);
      err.code = reply.error.code;
      err.data = reply.error.data;
      throw err;
    }
    return reply.result;
  } finally {
    t.done();
  }
}

async function initialize(key) {
  const r = rt(key);
  if (r.initPromise) return r.initPromise;
  r.initPromise = (async () => {
    const result = await rpc(key, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'Lens', title: 'Lens', version: '1.0.0' },
    });
    r.protocolVersion = result?.protocolVersion || PROTOCOL_VERSION;
    await rpc(key, 'notifications/initialized', undefined, { notification: true });
    r.initialized = true;
    patchConn(key, {
      serverInfo: result?.serverInfo || null,
      instructions: typeof result?.instructions === 'string' ? result.instructions : '',
    });
    return result;
  })();
  try {
    return await r.initPromise;
  } finally {
    r.initPromise = null;
  }
}

async function ensureInitialized(key) {
  if (!rt(key).initialized) await initialize(key);
}

// ---------------------------------------------------------------- OAuth

async function discoverResource(serverUrl, metaUrl) {
  const u = new URL(serverUrl);
  const path = u.pathname.replace(/\/$/, '');
  const candidates = [
    metaUrl,
    path && path !== '/' ? `${u.origin}/.well-known/oauth-protected-resource${path}` : null,
    `${u.origin}/.well-known/oauth-protected-resource`,
  ].filter(Boolean);
  for (const c of candidates) {
    const meta = await getJson(c);
    if (meta && (meta.authorization_servers || meta.resource)) return meta;
  }
  return null;
}

async function discoverAuthServer(issuer) {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, '');
  const candidates = path && path !== '/'
    ? [
        `${u.origin}/.well-known/oauth-authorization-server${path}`,
        `${u.origin}/.well-known/openid-configuration${path}`,
        `${u.origin}${path}/.well-known/openid-configuration`,
      ]
    : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  for (const c of candidates) {
    const meta = await getJson(c);
    if (meta?.authorization_endpoint && meta?.token_endpoint) return meta;
  }
  // Spec fallback: default endpoint paths at the authorization server's base URL.
  const base = u.origin;
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    code_challenge_methods_supported: ['S256'],
  };
}

async function registerClient(asMeta, redirect, scope) {
  const cacheKey = `${asMeta.issuer || asMeta.token_endpoint}|${redirect}`;
  const cache = readSession(CLIENTS_KEY);
  if (cache[cacheKey]?.client_id) return cache[cacheKey];
  if (!asMeta.registration_endpoint) {
    throw new Error('This server does not support automatic client registration. Paste an access token instead.');
  }
  const res = await safeFetch(asMeta.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Lens',
      client_uri: location.origin,
      redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope,
    }),
  }, 'Client registration');
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok || !body?.client_id) {
    throw new Error(`Client registration failed: ${errorText(body, `HTTP ${res.status}`)}`);
  }
  const client = { client_id: body.client_id, client_secret: body.client_secret || null };
  cache[cacheKey] = client;
  writeSession(CLIENTS_KEY, cache);
  return client;
}

async function startOAuth(key, metaUrl) {
  const conn = getConnection(key);
  const prm = await discoverResource(conn.url, metaUrl);
  const issuer = prm?.authorization_servers?.[0] || new URL(conn.url).origin;
  const asMeta = await discoverAuthServer(issuer);
  const methods = asMeta.code_challenge_methods_supported;
  if (Array.isArray(methods) && methods.length && !methods.includes('S256')) {
    throw new Error(`${label(key)} does not support PKCE S256 sign-in.`);
  }
  const supported = prm?.scopes_supported || asMeta.scopes_supported || [];
  const scope = supported.includes('mcp') || !supported.length ? 'mcp' : supported.join(' ');
  const resource = prm?.resource || conn.url;
  const redirect = redirectUri();
  const client = await registerClient(asMeta, redirect, scope);

  const verifier = randomString(48);
  const challenge = await pkceChallenge(verifier);
  const state = randomString(24);
  savePending(state, {
    key,
    verifier,
    clientId: client.client_id,
    clientSecret: client.client_secret,
    tokenEndpoint: asMeta.token_endpoint,
    redirectUri: redirect,
    resource,
    scope,
    returnHash: location.hash || '',
  });

  const authUrl = new URL(asMeta.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', client.client_id);
  authUrl.searchParams.set('redirect_uri', redirect);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('scope', scope);
  authUrl.searchParams.set('resource', resource);

  patchConn(key, { status: 'connecting', error: '' });
  window.location.assign(authUrl.toString());
  return authUrl.toString();
}

async function tokenRequest(endpoint, params) {
  const res = await safeFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString(),
  }, 'Token request');
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok || !body?.access_token) {
    const err = new Error(errorText(body, `Token request failed (HTTP ${res.status}).`));
    err.status = res.status;
    throw err;
  }
  return body;
}

function authFromTokens(tokens, base) {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || base.refreshToken || null,
    expiresAt: tokens.expires_in ? Date.now() + Number(tokens.expires_in) * 1000 : null,
    tokenType: tokens.token_type || 'Bearer',
    scope: tokens.scope || base.scope || 'mcp',
    clientId: base.clientId,
    clientSecret: base.clientSecret || null,
    tokenEndpoint: base.tokenEndpoint,
    resource: base.resource,
  };
}

// One refresh in flight per server, so rotating refresh tokens are never spent twice.
function refresh(key) {
  const r = rt(key);
  if (!r.refreshPromise) r.refreshPromise = doRefresh(key).finally(() => { r.refreshPromise = null; });
  return r.refreshPromise;
}

async function doRefresh(key) {
  const { auth } = getConnection(key);
  if (!auth?.refreshToken || !auth.tokenEndpoint) throw new Error('No refresh token available.');
  const sent = auth.refreshToken;
  try {
    const tokens = await tokenRequest(auth.tokenEndpoint, {
      grant_type: 'refresh_token',
      refresh_token: sent,
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      resource: auth.resource,
    });
    const next = authFromTokens(tokens, auth);
    patchConn(key, { auth: next });
    return next;
  } catch (e) {
    // Only forget the refresh token when the server rejected it (invalid_grant), not on timeouts or network blips,
    // and only if nothing has replaced it in the meantime.
    const current = getConnection(key).auth;
    if ((e?.status === 400 || e?.status === 401) && current?.refreshToken === sent) {
      patchConn(key, { auth: { ...current, refreshToken: null } });
    }
    throw e;
  }
}

function cleanCallbackUrl(hash) {
  try {
    history.replaceState(history.state, '', location.pathname + (hash || location.hash || ''));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- public API

/** Connect (or reconnect) to an MCP server. May redirect the page to sign in. */
export async function connect(key, { interactive = true } = {}) {
  const conn = getConnection(key);
  if (!conn.url) throw new Error(`No server URL configured for ${label(key)}.`);
  patchConn(key, { url: conn.url, status: 'connecting', error: '' });
  rt(key).initialized = false;
  try {
    await initialize(key);
    const tools = await fetchTools(key);
    patchConn(key, { status: 'connected', tools, error: '', connectedAt: new Date().toISOString() });
    return getConnection(key);
  } catch (e) {
    if (e instanceof AuthRequiredError) {
      const current = getConnection(key);
      if (current.auth?.manual) {
        const msg = `${label(key)} rejected the pasted token. Paste a fresh token or sign in instead.`;
        patchConn(key, { status: 'error', error: msg, auth: null, sessionId: null });
        throw new Error(msg);
      }
      if (!interactive) {
        patchConn(key, { status: 'disconnected', error: '', auth: null, sessionId: null });
        return getConnection(key);
      }
      try {
        patchConn(key, { auth: null, sessionId: null });
        await startOAuth(key, e.resourceMetadataUrl);
        return { ...getConnection(key), redirecting: true };
      } catch (oauthErr) {
        const msg = `Could not start ${label(key)} sign-in: ${oauthErr.message}`;
        patchConn(key, { status: 'error', error: msg });
        throw new Error(msg);
      }
    }
    patchConn(key, { status: 'error', error: e.message || String(e) });
    throw e;
  }
}

async function fetchTools(key) {
  const tools = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const result = await rpc(key, 'tools/list', cursor ? { cursor } : {});
    for (const t of result?.tools || []) {
      tools.push({
        name: t.name,
        title: t.title || t.annotations?.title || '',
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
        annotations: t.annotations || null,
      });
    }
    cursor = result?.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

/** List tools (refreshes the cached list in state). */
export async function listTools(key) {
  await ensureInitialized(key);
  const tools = await fetchTools(key);
  patchConn(key, { tools });
  return tools;
}

/** Call a tool. Returns the MCP result { content: [...], structuredContent? }. Throws on isError. */
export async function callTool(key, name, args = {}) {
  if (!getConnection(key).auth?.accessToken && getConnection(key).status !== 'connected') {
    throw new Error(`Connect ${label(key)} first.`);
  }
  await ensureInitialized(key);
  let result;
  try {
    result = await rpc(key, 'tools/call', { name, arguments: args || {} }, { timeoutMs: CALL_TIMEOUT_MS });
  } catch (e) {
    if (e instanceof AuthRequiredError) {
      patchConn(key, { status: 'error', error: `${label(key)} sign-in expired. Reconnect to continue.`, auth: null, sessionId: null });
      throw new Error(`${label(key)} sign-in expired. Reconnect to continue.`);
    }
    throw e;
  }
  if (result?.isError) {
    const text = (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim();
    const err = new Error(`${label(key)} tool "${name}" failed${text ? `: ${text}` : '.'}`);
    err.result = result;
    throw err;
  }
  return result || { content: [] };
}

/** Pick the best tool for a list of intent words/phrases, by name and description match. */
export function pickTool(key, intents = []) {
  const tools = getConnection(key).tools;
  if (!tools.length) return null;
  const words = [];
  for (const intent of intents) {
    const s = String(intent || '').toLowerCase().trim();
    if (!s) continue;
    words.push({ phrase: s, weight: 2 });
    for (const w of s.split(/[\s_\-./]+/)) if (w.length > 2) words.push({ phrase: w, weight: 1 });
  }
  let best = null;
  let bestScore = 0;
  for (const tool of tools) {
    const name = String(tool.name || '').toLowerCase();
    const nameParts = name.split(/[\s_\-./]+/);
    const desc = `${tool.title || ''} ${tool.description || ''}`.toLowerCase();
    let score = 0;
    for (const { phrase, weight } of words) {
      if (name === phrase) score += 12 * weight;
      else if (nameParts.includes(phrase)) score += 6 * weight;
      else if (name.includes(phrase)) score += 4 * weight;
      if (desc.includes(phrase)) score += 1 * weight;
    }
    if (score > bestScore) {
      bestScore = score;
      best = tool;
    }
  }
  return best;
}

/** Use a pasted access token instead of OAuth, then connect with it. */
export async function setManualToken(key, token) {
  const value = String(token || '').trim().replace(/^Bearer\s+/i, '');
  if (!value) throw new Error('Paste an access token first.');
  rt(key).initialized = false;
  patchConn(key, { auth: { accessToken: value, manual: true }, sessionId: null, status: 'disconnected', error: '' });
  return connect(key);
}

/** Called by app.js on load when location.search has ?code=&state= (or ?error=). */
export function handleOAuthCallback() {
  if (!callbackPromise) callbackPromise = processCallback();
  return callbackPromise;
}

async function processCallback() {
  const params = new URLSearchParams(location.search);
  const state = params.get('state');
  const code = params.get('code');
  const error = params.get('error');
  if (!state || (!code && !error)) return null;

  const pending = takePending(state);
  if (!pending) {
    cleanCallbackUrl();
    toast('That sign-in link expired or was opened in another tab. Connect again from Settings.', 'error');
    return { ok: false, error: 'Unknown or expired sign-in state.' };
  }
  const key = pending.key;
  cleanCallbackUrl(pending.returnHash);

  if (error) {
    const desc = params.get('error_description') || error;
    const msg = error === 'access_denied' ? `${label(key)} sign-in was cancelled.` : `${label(key)} sign-in failed: ${desc}`;
    patchConn(key, { status: 'error', error: msg, auth: null });
    toast(msg, 'error');
    return { key, ok: false, error: msg };
  }

  try {
    const tokens = await tokenRequest(pending.tokenEndpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      client_id: pending.clientId,
      client_secret: pending.clientSecret,
      code_verifier: pending.verifier,
      resource: pending.resource,
    });
    const auth = authFromTokens(tokens, pending);
    rt(key).initialized = false;
    patchConn(key, { auth, sessionId: null, status: 'connecting', error: '' });
  } catch (e) {
    const msg = `${label(key)} sign-in failed: ${e.message}`;
    patchConn(key, { status: 'error', error: msg, auth: null });
    toast(msg, 'error');
    return { key, ok: false, error: msg };
  }

  // The tokens are good; a failed handshake keeps them so "Connect" can retry without a new sign-in.
  try {
    const conn = await connect(key, { interactive: false });
    if (conn.status === 'connected') {
      toast(`${label(key)} connected · ${conn.tools.length} tool${conn.tools.length === 1 ? '' : 's'} available`, 'success');
      return { key, ok: true, connection: conn };
    }
    const msg = `${label(key)} did not accept the new sign-in. Try connecting again.`;
    patchConn(key, { status: 'error', error: msg });
    toast(msg, 'error');
    return { key, ok: false, error: msg };
  } catch (e) {
    const msg = `Signed in to ${label(key)}, but connecting failed: ${e.message}. Try Connect again.`;
    patchConn(key, { status: 'error', error: msg });
    toast(msg, 'error');
    return { key, ok: false, error: msg };
  }
}

/** Forget the connection (tokens, session, tools). */
export function disconnect(key) {
  runtime[key] = null;
  clearPendingFor(key);
  patchConn(key, {
    url: getConnection(key).url,
    status: 'disconnected',
    tools: [],
    auth: null,
    sessionId: null,
    error: '',
    serverInfo: null,
    instructions: '',
  });
}

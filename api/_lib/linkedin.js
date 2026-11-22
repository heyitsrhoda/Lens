// Shared helpers for the LinkedIn functions in api/linkedin/*.js (Vercel treats files under api/_lib as non-routes).
//
// Checked against learn.microsoft.com/linkedin (Nov 2026):
//   Sign In with LinkedIn (OpenID Connect):
//     authorize  GET  https://www.linkedin.com/oauth/v2/authorization  (response_type=code, client_id, redirect_uri, state, scope)
//     token      POST https://www.linkedin.com/oauth/v2/accessToken    (form: grant_type=authorization_code, code, redirect_uri,
//                                                                       client_id, client_secret) → { access_token, expires_in, scope, id_token }
//     userinfo   GET  https://api.linkedin.com/v2/userinfo             → { sub, name, given_name, family_name, picture, email?, locale }
//   Posts API (versioned):  POST https://api.linkedin.com/rest/posts → 201, post URN in the `x-restli-id` header.
//   Images API:            POST https://api.linkedin.com/rest/images?action=initializeUpload
//                          { initializeUploadRequest: { owner } } → { value: { uploadUrl, image } }; then PUT the bytes to
//                          uploadUrl with the OAuth Bearer token. JPG, GIF, PNG.
//   Versioned calls need `LinkedIn-Version: YYYYMM` and `X-Restli-Protocol-Version: 2.0.0`.
//   Commentary uses the "little" text format: reserved characters | { } @ [ ] ( ) < > # \ * _ ~ must be backslash-escaped.
//
// Session: one HttpOnly, Secure, SameSite=Lax session cookie `lens_li` (no Max-Age/Expires → gone when the browser
// session ends) holding { t: access token, sub, name, picture, exp }, base64url JSON + "." + HMAC-SHA256 signature keyed
// by LINKEDIN_CLIENT_SECRET. The token is never sent to page JavaScript.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization';
export const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
export const USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';
export const POSTS_URL = 'https://api.linkedin.com/rest/posts';
export const IMAGES_INIT_URL = 'https://api.linkedin.com/rest/images?action=initializeUpload';
export const SCOPES = 'openid profile email w_member_social';

export const SESSION_COOKIE = 'lens_li';
export const STATE_COOKIE = 'lens_li_state';
export const STATE_MAX_AGE_S = 600;
export const NOT_CONFIGURED = "LinkedIn isn't configured on this deployment.";
export const EXPIRED = 'LinkedIn session expired — reconnect.';
const TIMEOUT_MS = 20000;

// ------------------------------------------------------------------ env

export function config() {
  const clientId = String(process.env.LINKEDIN_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.LINKEDIN_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

// ------------------------------------------------------------------ http

export function header(req, name) {
  const v = req.headers ? req.headers[name] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

export function sendJson(res, status, payload, cookies = []) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.end(JSON.stringify(payload));
}

export function redirect(res, location, cookies = []) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.end();
}

export function notConfigured(res) {
  return sendJson(res, 500, { ok: false, error: NOT_CONFIGURED });
}

export function query(req) {
  try {
    return new URL(req.url || '', 'http://local').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** https://<host> of this request (x-forwarded-host / x-forwarded-proto on Vercel). */
export function origin(req) {
  const host = String(header(req, 'x-forwarded-host') || header(req, 'host') || '').split(',')[0].trim();
  let proto = String(header(req, 'x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  if (proto !== 'http' && proto !== 'https') proto = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host) ? 'http' : 'https';
  if (!/^[A-Za-z0-9.\-[\]:]+$/.test(host)) throw new Error('Bad host header');
  return `${proto}://${host}`;
}

export function redirectUri(req) {
  return `${origin(req)}/api/linkedin/callback`;
}

/** A same-origin relative path ("/…", optionally with ?query and #hash); anything else → "/". */
export function safeReturn(value) {
  const v = typeof value === 'string' ? value : '';
  if (!v || v.length > 1024) return '/';
  if (v[0] !== '/' || v[1] === '/' || v[1] === '\\') return '/';
  if (/[\u0000-\u001f\u007f\\]/.test(v)) return '/';
  try {
    const u = new URL(v, 'https://lens.invalid');
    if (u.origin !== 'https://lens.invalid') return '/';
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return '/';
  }
}

/** Add ?li=…(&reason=…) to a return path, before its #hash. */
export function withFlag(path, flag, reason) {
  const safe = safeReturn(path);
  const i = safe.indexOf('#');
  const base = i === -1 ? safe : safe.slice(0, i);
  const hash = i === -1 ? '' : safe.slice(i);
  const u = new URL(base, 'https://lens.invalid');
  u.searchParams.delete('li');
  u.searchParams.delete('reason');
  u.searchParams.set('li', flag);
  if (reason) u.searchParams.set('reason', reason);
  return `${u.pathname}${u.search}${hash}`;
}

// ------------------------------------------------------------------ cookies

export function parseCookies(req) {
  const out = {};
  const raw = String(header(req, 'cookie') || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    out[k] = part.slice(i + 1).trim();
  }
  return out;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(secret, data) {
  return b64url(createHmac('sha256', secret).update(data).digest());
}

/** base64url(JSON) + "." + HMAC-SHA256(base64url(JSON)), keyed by the client secret and a purpose label. */
export function seal(secret, purpose, value) {
  const data = b64url(Buffer.from(JSON.stringify(value), 'utf8'));
  return `${data}.${sign(`${purpose}:${secret}`, data)}`;
}

export function unseal(secret, purpose, token) {
  if (typeof token !== 'string' || token.length > 8000) return null;
  const i = token.lastIndexOf('.');
  if (i <= 0) return null;
  const data = token.slice(0, i);
  const mac = token.slice(i + 1);
  const want = sign(`${purpose}:${secret}`, data);
  const a = Buffer.from(mac);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const v = JSON.parse(Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Session cookie: no Max-Age / Expires, so the browser drops it when the session ends. */
export function sessionCookie(value) {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function stateCookie(value) {
  return `${STATE_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/api/linkedin; Max-Age=${STATE_MAX_AGE_S}`;
}

export function clearStateCookie() {
  return `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api/linkedin; Max-Age=0`;
}

export function randomState() {
  return b64url(randomBytes(24));
}

/** The verified session { t, sub, name, picture, exp } or null (missing, tampered or expired). */
export function readSession(req, cfg) {
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return null;
  const s = unseal(cfg.clientSecret, 'session', raw);
  if (!s || typeof s.t !== 'string' || !s.t || typeof s.sub !== 'string' || !s.sub) return null;
  if (typeof s.exp === 'number' && s.exp <= Date.now()) return null;
  return s;
}

export function hasSessionCookie(req) {
  return Boolean(parseCookies(req)[SESSION_COOKIE]);
}

// ------------------------------------------------------------------ LinkedIn calls

export async function timedFetch(url, init = {}, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function readBodyJson(res) {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
}

export function liMessage(body, fallback) {
  if (!body || typeof body !== 'object') return fallback;
  const m = body.message || body.error_description || (typeof body.error === 'string' ? body.error : '') || '';
  return m ? String(m).slice(0, 300) : fallback;
}

// LinkedIn-Version: env LINKEDIN_VERSION, else the current UTC month, falling back a few months when LinkedIn
// says a version is not active (426 / "version" errors). The working version is remembered per instance.
let workingVersion = null;

function versionCandidates() {
  const fixed = String(process.env.LINKEDIN_VERSION || '').trim();
  if (/^\d{6}$/.test(fixed)) return [fixed];
  const list = [];
  if (workingVersion) list.push(workingVersion);
  const d = new Date();
  for (let i = 0; i < 4; i++) {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    const v = `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!list.includes(v)) list.push(v);
  }
  return list;
}

/** fetch a versioned /rest endpoint with the standard headers. Returns { res, body }. */
export async function restCall(url, { token, method = 'POST', json } = {}) {
  let last = null;
  for (const version of versionCandidates()) {
    const res = await timedFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'LinkedIn-Version': version,
        'X-Restli-Protocol-Version': '2.0.0',
        Accept: 'application/json',
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    const body = res.status === 201 || res.status === 204 ? null : await readBodyJson(res);
    const versionProblem = res.status === 426 || (res.status === 400 && /version/i.test(liMessage(body, '')));
    if (versionProblem) {
      last = { res, body };
      continue;
    }
    if (res.ok) workingVersion = version;
    return { res, body };
  }
  return last;
}

// ------------------------------------------------------------------ "little" text format

const RESERVED = /[|{}@[\]()<>#\\*_~]/g;

export function escapeLittle(text) {
  return String(text || '').replace(RESERVED, (c) => `\\${c}`);
}

/**
 * Escape plain text for the Posts API commentary. Hashtags (#word at the start or after whitespace) are kept as
 * LinkedIn hashtags through the HashtagTemplate {hashtag|\#|word}; everything else is literal text.
 */
export function toCommentary(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const re = /(^|[\s(])#([\p{L}\p{N}_]{1,100})/gu;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[1].length;
    out += escapeLittle(src.slice(last, start));
    out += `{hashtag|\\#|${escapeLittle(m[2])}}`;
    last = start + 1 + m[2].length;
  }
  out += escapeLittle(src.slice(last));
  return out;
}

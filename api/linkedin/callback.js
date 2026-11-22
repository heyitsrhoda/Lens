// GET /api/linkedin/callback?code=&state= (or ?error=&state=) — LinkedIn's redirect back after sign-in.
// Verifies the state cookie, exchanges the code for an access token, reads /v2/userinfo, stores the session in the
// signed HttpOnly session cookie `lens_li`, and redirects to the saved return path with ?li=connected
// (or ?li=error&reason=<code>), keeping its #hash.
//
// reason codes: cancelled · state · token · profile · scope · unknown

import { TOKEN_URL, USERINFO_URL, clearStateCookie, config, liMessage, notConfigured, parseCookies, query, readBodyJson, redirect, redirectUri, seal, sessionCookie, sendJson, STATE_COOKIE, timedFetch, unseal, withFlag, clearSessionCookie, handoffCookie, encryptSession, SESSION_MAX_AGE_MS } from '../_lib/linkedin.js';

function fail(res, back, reason) {
  return redirect(res, withFlag(back, 'error', reason), [clearStateCookie()]);
}

export default async function handler(req, res) {
  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { ok: false, error: 'Use GET.' });
  }
  const cfg = config();
  if (!cfg) return notConfigured(res);

  const params = query(req);
  const saved = unseal(cfg.clientSecret, 'state', parseCookies(req)[STATE_COOKIE]);
  const back = saved && typeof saved.r === 'string' ? saved.r : '/';
  const state = params.get('state') || '';
  if (!saved || !state || saved.s !== state || typeof saved.exp !== 'number' || saved.exp < Date.now()) {
    return fail(res, back, 'state');
  }

  const error = params.get('error');
  if (error) {
    const cancelled = /cancel|denied/i.test(error) || /cancel/i.test(params.get('error_description') || '');
    console.warn(`[linkedin] sign-in returned error=${String(error).slice(0, 60)}`);
    return fail(res, back, cancelled ? 'cancelled' : 'unknown');
  }
  const code = params.get('code');
  if (!code) return fail(res, back, 'unknown');

  let callback;
  try {
    callback = redirectUri(req);
  } catch {
    return fail(res, back, 'unknown');
  }

  // 1) code → access token
  let token;
  let expiresIn = 0;
  let scope = '';
  try {
    const r = await timedFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callback,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }).toString(),
    });
    const body = await readBodyJson(r);
    if (!r.ok || !body || !body.access_token) {
      console.warn(`[linkedin] token exchange failed: HTTP ${r.status} ${liMessage(body, '')}`);
      return fail(res, back, 'token');
    }
    token = String(body.access_token);
    expiresIn = Number(body.expires_in) || 0;
    scope = String(body.scope || '');
  } catch {
    return fail(res, back, 'token');
  }
  // Posting needs w_member_social ('\b' keeps w_member_social_feed from counting). Replying uses w_member_social_feed.
  const granted = scope.split(/[\s,]+/).filter(Boolean);
  if (scope && !granted.includes('w_member_social')) return fail(res, back, 'scope');

  // 2) who is this?
  let me;
  try {
    const r = await timedFetch(USERINFO_URL, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    me = await readBodyJson(r);
    if (!r.ok || !me || typeof me.sub !== 'string' || !me.sub) {
      console.warn(`[linkedin] userinfo failed: HTTP ${r.status}`);
      return fail(res, back, 'profile');
    }
  } catch {
    return fail(res, back, 'profile');
  }

  const name = typeof me.name === 'string' && me.name.trim()
    ? me.name.trim()
    : [me.given_name, me.family_name].filter((x) => typeof x === 'string' && x).join(' ');
  const picture = typeof me.picture === 'string' && /^https:\/\//i.test(me.picture) && me.picture.length < 1200 ? me.picture : '';
  const session = {
    t: token,
    sub: me.sub,
    name: name.slice(0, 120),
    picture,
    exp: Date.now() + Math.min(expiresIn ? expiresIn * 1000 : SESSION_MAX_AGE_MS, SESSION_MAX_AGE_MS), // 60 days at most
  };
  // Whether the comment permission was granted (unknown when LinkedIn leaves `scope` out of the token response).
  if (scope) session.feed = granted.includes('w_member_social_feed');
  // The page moves the encrypted sign-in into localStorage and deletes the handoff cookie.
  return redirect(res, withFlag(back, 'connected'), [clearStateCookie(), clearSessionCookie(), handoffCookie(encryptSession(cfg.clientSecret, session))]);
}

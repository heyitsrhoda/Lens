// GET /api/linkedin/start?return=<same-origin path> — begin "Sign In with LinkedIn" (OAuth 2.0 authorization code).
// Sets a short-lived signed HttpOnly state cookie (CSRF) and redirects to LinkedIn's authorization page.

import {
  AUTHORIZE_URL, config, notConfigured, query, redirect, redirectUri, safeReturn, seal, randomState, scopes,
  sendJson, stateCookie, STATE_MAX_AGE_S,
} from '../_lib/linkedin.js';

export default async function handler(req, res) {
  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { ok: false, error: 'Use GET to start LinkedIn sign-in.' });
  }
  const cfg = config();
  if (!cfg) return notConfigured(res);

  let callback;
  try {
    callback = redirectUri(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Bad request host.' });
  }
  const back = safeReturn(query(req).get('return'));
  const state = randomState();
  const sealed = seal(cfg.clientSecret, 'state', { s: state, r: back, exp: Date.now() + STATE_MAX_AGE_S * 1000 });

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', callback);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', scopes());
  return redirect(res, url.toString(), [stateCookie(sealed)]);
}

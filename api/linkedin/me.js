// GET /api/linkedin/me → { connected: true, name, picture } | { connected: false }.
// Never returns the access token.

import { clearSessionCookie, config, hasSessionCookie, readSession, sendJson } from '../_lib/linkedin.js';

export default async function handler(req, res) {
  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { ok: false, error: 'Use GET.' });
  }
  const cfg = config();
  if (!cfg) return sendJson(res, 500, { ok: false, connected: false, error: "LinkedIn isn't configured on this deployment." });
  const s = readSession(req, cfg);
  if (!s) {
    // A cookie that is present but invalid (tampered, old secret, expired token) is cleared.
    return sendJson(res, 200, { ok: true, connected: false }, hasSessionCookie(req) ? [clearSessionCookie()] : []);
  }
  const out = { ok: true, connected: true };
  if (s.name) out.name = s.name;
  if (s.picture) out.picture = s.picture;
  return sendJson(res, 200, out);
}

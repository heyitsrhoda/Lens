// POST /api/linkedin/logout — forget the LinkedIn session (clears the session cookie).

import { clearSessionCookie, sendJson } from '../_lib/linkedin.js';

export default async function handler(req, res) {
  const method = (req.method || 'POST').toUpperCase();
  if (method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, error: 'Use POST.' });
  }
  return sendJson(res, 200, { ok: true, connected: false }, [clearSessionCookie()]);
}

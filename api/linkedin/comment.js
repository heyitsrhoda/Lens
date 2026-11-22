// POST /api/linkedin/comment  JSON { urn, text } → 201 { ok, id, commentUrn, url }
//
// Replies to a LinkedIn post as the signed-in member through the Comments API (checked against
// learn.microsoft.com/linkedin, Comments API, LinkedIn-Version 202611):
//   POST https://api.linkedin.com/rest/socialActions/{url-encoded thread URN}/comments
//   headers  Authorization: Bearer <token>, LinkedIn-Version: YYYYMM, X-Restli-Protocol-Version: 2.0.0
//   body     { actor: "urn:li:person:<sub>", object: <thread URN>, message: { text } }
//   → 201, comment id in `x-restli-id`, body { id, commentUrn, object, … }
// Permission: w_member_social_feed ("Post, comment, and react on posts on behalf of an authenticated member"; Community
// Management API product, requested when LINKEDIN_FEED_SCOPE=1). Without it LinkedIn is expected to answer 403.
//
// urn: the thread — urn:li:activity:<id> (from /posts/…-activity-<id>-… or /feed/update/urn:li:activity:<id>),
//      urn:li:share:<id> or urn:li:ugcPost:<id>; or a comment URN urn:li:comment:(<thread urn>,<id>) to reply to that
//      comment (the comment URN goes in the path and in parentComment; object is the thread).
// text: plain text, max 1250 characters. The comment message is plain text (mentions would go in message.attributes),
//       so nothing is escaped here — unlike post commentary, which uses the "little" text format.
//
// Errors: readable JSON { ok:false, error, code }. LinkedIn 401 → session cookie cleared, 401 { expired:true, code:'expired' }.
// code 'unsupported' means LinkedIn would not take a comment on that URN through the API (reply on the thread instead).

import {
  EXPIRED, SOCIAL_ACTIONS_URL, clearSessionCookie, config, liMessage, notConfigured, readJsonBody, readSession,
  restCall, restliEncode, sameOrigin, sendJson,
} from '../_lib/linkedin.js';

const MAX_TEXT = 1250;
const THREAD_URN = /^urn:li:(?:activity|share|ugcPost):\d{1,25}$/;
const COMMENT_URN = /^urn:li:comment:\((urn:li:(?:activity|share|ugcPost):\d{1,25}),(\d{1,25})\)$/;

function fail(res, status, code, error, cookies = []) {
  return sendJson(res, status, { ok: false, code, error }, cookies);
}

function expired(res) {
  return sendJson(res, 401, { ok: false, expired: true, code: 'expired', error: EXPIRED }, [clearSessionCookie()]);
}

function cleanText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export default async function handler(req, res) {
  const method = (req.method || 'POST').toUpperCase();
  if (method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'invalid', 'Use POST.');
  }
  const cfg = config();
  if (!cfg) return notConfigured(res);
  if (!sameOrigin(req)) return fail(res, 403, 'forbidden', 'Cross-site request refused.');

  const session = readSession(req, cfg);
  if (!session) return fail(res, 401, 'not-connected', 'Connect LinkedIn first.');

  let body;
  try {
    body = await readJsonBody(req, 64 * 1024);
  } catch (e) {
    return fail(res, e.status || 400, e.code || 'invalid', e.message);
  }

  const urn = typeof body.urn === 'string' ? body.urn.trim() : '';
  const text = cleanText(body.text);
  if (!text) return fail(res, 400, 'invalid', 'The reply is empty.');
  if (text.length > MAX_TEXT) return fail(res, 400, 'invalid', `LinkedIn comments can be at most ${MAX_TEXT} characters (this one has ${text.length}).`);

  let object = urn;
  let parentComment = '';
  const asComment = COMMENT_URN.exec(urn);
  if (asComment) {
    object = asComment[1];
    parentComment = urn;
  } else if (!THREAD_URN.test(urn)) {
    return fail(res, 400, 'invalid', 'That is not a LinkedIn post Lens can reply to.');
  }

  const payload = { actor: `urn:li:person:${session.sub}`, object, message: { text } };
  if (parentComment) payload.parentComment = parentComment;

  let out;
  try {
    out = await restCall(`${SOCIAL_ACTIONS_URL}/${restliEncode(urn)}/comments`, { token: session.t, json: payload });
  } catch (e) {
    const timeout = e && e.name === 'AbortError';
    return fail(res, timeout ? 504 : 502, timeout ? 'timeout' : 'network',
      timeout ? 'LinkedIn took too long to answer. Check the post before retrying.' : 'Could not reach LinkedIn. Try again.');
  }
  if (!out) return fail(res, 502, 'upstream', 'LinkedIn did not accept the API version. Try again later.');
  const { res: r, body: rb } = out;
  if (r.status === 401) return expired(res);
  if (!r.ok) {
    const detail = liMessage(rb, '');
    console.warn(`[linkedin] comment failed: HTTP ${r.status}`);
    if (r.status === 403) {
      return fail(res, 403, 'forbidden', session.feed === true
        ? 'LinkedIn did not allow this reply. The post may limit who can comment.'
        : 'LinkedIn did not allow this reply. This Lens deployment doesn’t have LinkedIn’s comment permission yet, so reply in the thread instead.');
    }
    if (r.status === 404 || r.status === 410) return fail(res, 404, 'not-found', 'LinkedIn could not find that post. It may have been deleted.');
    if (r.status === 429) return fail(res, 429, 'rate', 'LinkedIn allows only a few comments a minute. Try again shortly.');
    if ((r.status === 400 || r.status === 422) && /syntax|path|urn|invalid (?:entity|resource)|not (?:a )?(?:valid|supported)/i.test(detail)) {
      return fail(res, 400, 'unsupported', 'LinkedIn would not take a reply on this post through the API. Open the thread and reply there.');
    }
    if (r.status >= 500) return fail(res, 502, 'upstream', 'LinkedIn had a problem posting the reply. Try again.');
    return fail(res, r.status, 'rejected', `LinkedIn rejected the reply${detail ? `: ${detail}` : ` (HTTP ${r.status})`}.`);
  }

  const headerId = String(r.headers.get('x-restli-id') || r.headers.get('x-linkedin-id') || '').trim();
  const b = rb && typeof rb === 'object' ? rb : {};
  let commentUrn = typeof b.commentUrn === 'string' ? b.commentUrn : '';
  let id = typeof b.id === 'string' || typeof b.id === 'number' ? String(b.id) : '';
  if (/^urn:li:comment:/.test(headerId)) {
    if (!commentUrn) commentUrn = headerId;
    if (!id) id = (/,(\d+)\)$/.exec(headerId) || [])[1] || '';
  } else if (headerId && !id) {
    id = headerId;
  }
  const thread = typeof b.object === 'string' && THREAD_URN.test(b.object) ? b.object : object;
  if (!commentUrn && id) commentUrn = `urn:li:comment:(${thread},${id})`;
  const url = `https://www.linkedin.com/feed/update/${thread}/${commentUrn ? `?commentUrn=${encodeURIComponent(commentUrn)}` : ''}`;
  return sendJson(res, 201, { ok: true, id, commentUrn, url });
}

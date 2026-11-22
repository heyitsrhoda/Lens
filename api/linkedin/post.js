// POST /api/linkedin/post  JSON { text, imageUrl? } → 201 { ok, id, url, imageSkipped? }
//
// Creates a member post through the Posts API (POST https://api.linkedin.com/rest/posts) as urn:li:person:<sub>,
// visibility PUBLIC, distribution MAIN_FEED, lifecycleState PUBLISHED. `text` is plain text; it is converted to
// LinkedIn's "little" text format here (reserved characters escaped, #hashtags kept as hashtags).
//
// imageUrl (optional): https URL or data:image/(png|jpeg|gif);base64,… — at most 5 MB. It is uploaded with the
// Images API (initializeUpload → PUT bytes) and attached as content.media. If the image cannot be fetched or
// uploaded, the post goes out as text only and the response says imageSkipped: true.
// Note: Vercel caps request bodies at 4.5 MB, so a data: URL must stay under ~3.3 MB of image bytes.
//
// Errors: readable JSON { ok:false, error }. LinkedIn 401 → session cookie cleared, 401 { error, expired:true }.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  EXPIRED, IMAGES_INIT_URL, POSTS_URL, clearSessionCookie, config, header, liMessage, notConfigured, origin,
  readSession, restCall, sendJson, timedFetch, toCommentary,
} from '../_lib/linkedin.js';

const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_BODY = 8 * 1024 * 1024;
const MAX_TEXT = 3000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readBody(req) {
  let pre;
  try {
    pre = req.body;
  } catch {
    throw new HttpError(400, 'Request body must be JSON.');
  }
  if (pre !== undefined && pre !== null) {
    if (typeof pre === 'object' && !Buffer.isBuffer(pre)) return pre;
    return parse(Buffer.isBuffer(pre) ? pre.toString('utf8') : String(pre));
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'That image is too large to post (5 MB max).');
    chunks.push(chunk);
  }
  return parse(Buffer.concat(chunks).toString('utf8'));
}

function parse(text) {
  try {
    const v = JSON.parse(text || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
}

// Same-origin check for a state-changing request (SameSite=Lax already keeps the cookie off cross-site POSTs).
function sameOrigin(req) {
  const o = header(req, 'origin');
  if (!o) return true;
  try {
    return new URL(o).origin === origin(req);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ image loading

function sniff(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 6 && buf.slice(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  return '';
}

function privateHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const kind = isIP(h);
  if (kind === 4) {
    const [a, b] = h.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (kind === 6) return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:');
  return false;
}

// A public-looking name can still resolve to a private address (e.g. 127.0.0.1.nip.io): check what it resolves to.
async function assertPublicHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '');
  if (privateHost(h)) throw new Error('image URL not allowed');
  if (isIP(h)) return;
  let addresses;
  try {
    addresses = await lookup(h, { all: true, verbatim: true });
  } catch {
    throw new Error('image host not found');
  }
  if (!addresses.length || addresses.some((a) => privateHost(a.address))) throw new Error('image URL not allowed');
}

async function fetchRemoteImage(url) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    let u;
    try {
      u = new URL(current);
    } catch {
      throw new Error('bad image URL');
    }
    if (u.protocol !== 'https:') throw new Error('image URL not allowed');
    await assertPublicHost(u.hostname);
    const res = await timedFetch(u.toString(), { redirect: 'manual', headers: { Accept: 'image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1' } }, 15000);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), u).toString();
      continue;
    }
    if (!res.ok || !res.body) throw new Error(`image fetch HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_IMAGE) throw new Error('image too large');
    const reader = res.body.getReader();
    const parts = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_IMAGE) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error('image too large');
      }
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts);
  }
  throw new Error('too many redirects');
}

async function loadImage(imageUrl) {
  const v = String(imageUrl || '').trim();
  if (!v) return null;
  let buf;
  if (/^data:/i.test(v)) {
    const m = /^data:(image\/(?:png|jpe?g|gif|webp|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/i.exec(v);
    if (!m) throw new Error('unsupported data URL');
    if (m[2].length > Math.ceil((MAX_IMAGE * 4) / 3) + 8) throw new Error('image too large');
    buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  } else if (/^https:\/\//i.test(v)) {
    buf = await fetchRemoteImage(v);
  } else {
    throw new Error('image URL must be https or a data:image URL');
  }
  if (!buf.length || buf.length > MAX_IMAGE) throw new Error('image empty or too large');
  const type = sniff(buf);
  if (!type) throw new Error('LinkedIn accepts PNG, JPG or GIF images');
  return { buf, type };
}

async function uploadImage(token, owner, image) {
  const init = await restCall(IMAGES_INIT_URL, { token, json: { initializeUploadRequest: { owner } } });
  if (!init) throw new Error('image init failed');
  if (init.res.status === 401) throw Object.assign(new Error('expired'), { expired: true });
  const value = init.body && init.body.value;
  if (!init.res.ok || !value || !value.uploadUrl || !value.image) throw new Error(`image init HTTP ${init.res.status}: ${liMessage(init.body, '')}`);
  const put = await timedFetch(String(value.uploadUrl), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': image.type },
    body: image.buf,
  }, 30000);
  if (put.status === 401) throw Object.assign(new Error('expired'), { expired: true });
  if (!put.ok) throw new Error(`image upload HTTP ${put.status}`);
  return String(value.image);
}

// ------------------------------------------------------------------ handler

function expired(res) {
  return sendJson(res, 401, { ok: false, expired: true, error: EXPIRED }, [clearSessionCookie()]);
}

export default async function handler(req, res) {
  const method = (req.method || 'POST').toUpperCase();
  if (method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, error: 'Use POST.' });
  }
  const cfg = config();
  if (!cfg) return notConfigured(res);
  if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Cross-site request refused.' });

  const session = readSession(req, cfg);
  if (!session) return sendJson(res, 401, { ok: false, error: 'Connect LinkedIn first.' });

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, e.status || 400, { ok: false, error: e.message });
  }
  const text = typeof body.text === 'string' ? body.text.replace(/\r\n?/g, '\n').trim() : '';
  if (!text) return sendJson(res, 400, { ok: false, error: 'The post is empty.' });
  if (text.length > MAX_TEXT) return sendJson(res, 400, { ok: false, error: `LinkedIn posts can be at most ${MAX_TEXT} characters (this one has ${text.length}).` });

  const author = `urn:li:person:${session.sub}`;
  let imageUrn = '';
  let imageSkipped = false;
  if (body.imageUrl) {
    try {
      const image = await loadImage(body.imageUrl);
      if (image) imageUrn = await uploadImage(session.t, author, image);
    } catch (e) {
      if (e && e.expired) return expired(res);
      console.warn(`[linkedin] image skipped: ${String((e && e.message) || e).slice(0, 120)}`);
      imageSkipped = true;
    }
  }

  const post = {
    author,
    commentary: toCommentary(text),
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
  if (imageUrn) post.content = { media: { id: imageUrn, altText: text.split('\n')[0].slice(0, 120) } };

  let out;
  try {
    out = await restCall(POSTS_URL, { token: session.t, json: post });
  } catch (e) {
    const timeout = e && e.name === 'AbortError';
    return sendJson(res, timeout ? 504 : 502, { ok: false, error: timeout ? 'LinkedIn took too long to answer. Check your profile before retrying.' : 'Could not reach LinkedIn. Try again.' });
  }
  if (!out) return sendJson(res, 502, { ok: false, error: 'LinkedIn did not accept the API version. Try again later.' });
  const { res: r, body: rb } = out;
  if (r.status === 401) return expired(res);
  if (!r.ok) {
    const detail = liMessage(rb, '');
    const msg = r.status === 403
      ? 'LinkedIn did not allow this post. Reconnect LinkedIn and approve posting permission.'
      : r.status === 429
        ? 'LinkedIn rate limit reached. Try again later.'
        : `LinkedIn rejected the post${detail ? `: ${detail}` : ` (HTTP ${r.status})`}.`;
    console.warn(`[linkedin] post failed: HTTP ${r.status}`);
    return sendJson(res, r.status >= 500 ? 502 : r.status, { ok: false, error: msg });
  }
  const id = String(r.headers.get('x-restli-id') || r.headers.get('x-linkedin-id') || (rb && rb.id) || '');
  if (!id) return sendJson(res, 502, { ok: false, error: 'LinkedIn accepted the post but returned no id.' });
  const payload = { ok: true, id, url: `https://www.linkedin.com/feed/update/${id}/` };
  if (imageSkipped) payload.imageSkipped = true;
  return sendJson(res, 201, payload);
}

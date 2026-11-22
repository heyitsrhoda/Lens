// Lens service contract (docs/SPEC.md → "Service contract — js/services/lens.js" and "v3.1").
//
//   init()                                   → { returnedFrom?: 'Sculptex'|'LinkedIn', error? }
//   connections()                            (sync) → { Sculptex:{connected, account?, error?}, LinkedIn:{connected, name?, picture?, canReply?, error?} }
//   onConnectionsChange(fn)                  → unsubscribe
//   connect(provider) · disconnect(provider) · disconnectAll()
//   scanSite(url)                            → { name, summary, product, audience?, keywords: [] }
//   onboardTurn({ site, scan, answers, messages }) → { reply, answers, done }
//   listen({ brand, force })                 → { at, painPoints:[{label, detail, count, quotes:[{text, url, source}]}],
//                                                threads:[{id, url, title, snippet, platform, platformLabel, community,
//                                                          author?, publishedAt?, linkedinUrn?, about?}],
//                                                competitors:[string] }  (brand.competitors, else names the AI suggested)
//   generatePosts({ brand, count, painPoints }) → [{ kind:'post', title, copy, sourceUrl?, sourceLabel?, visualIdea?,
//                                                    painPoint?, visual3d?:{prompt, effort:'low'|'medium'|'high'} }]
//   findReplies({ brand, threads, count, painPoints?, exclude? })
//                                            → [{ kind:'reply', platform, platformLabel, community, title, quote, copy,
//                                                 sourceUrl, sourceLabel, threadId, author?, linkedinUrn? }]
//   findDMs({ brand, threads, count, painPoints?, exclude? })
//                                            → [{ kind:'dm', title, copy, recipient?, sourceUrl, sourceLabel, platform, threadId }]
//   postReply(item)                          → { url?, id?, commentUrn? }  (LinkedIn only; codes 'not-linkedin' | 'not-connected')
//   revise({ brand, item, request })         → { title?, copy, message }   (item.kind 'post' | 'dm' | 'reply')
//   brainstorm({ brand, messages, proposal })→ { reply, proposal?: { title, copy } }
//   createVisual({ provider, prompt, effort })→ { src, link?, provider }  (provider 'Sculptex'; effort low|medium|high, default low)
//   publish(post)                            → { id, url?, imageSkipped? }
//   linkedinUrnFrom(url)                     (sync) → 'urn:li:activity:<id>' | 'urn:li:share:<id>' | 'urn:li:ugcPost:<id>' | ''
//
// Errors are Error objects with a readable .message; .code may be 'no-relay' | 'no-key' | 'credits' | 'rate' |
// 'not-connected' | 'redirect' (connect() navigating away to sign in). 'no-relay' / 'no-key' / 'credits' come from
// either You.com search (./you.js) or OpenRouter AI (./ai.js); the message says which.
//
// Search and page extraction go through You.com (./you.js → ./api/you); every AI (LLM) call goes through OpenRouter
// (./ai.js → ./api/ai). Sculptex is an MCP server (./mcp.js, OAuth in
// sessionStorage) and the only visual provider. LinkedIn lives behind ./api/linkedin/* (./linkedin.js, HttpOnly session cookie).

import * as you from './you.js';
import * as ai from './ai.js';
import * as mcp from './mcp.js';
import * as linkedin from './linkedin.js';

const PROVIDERS = ['Sculptex', 'LinkedIn'];
const MCP_KEYS = { Sculptex: 'sculptex' };
const COMMUNITY_DOMAINS = ['reddit.com', 'news.ycombinator.com', 'x.com', 'linkedin.com', 'indiehackers.com', 'producthunt.com'];

const SLOTS = [
  ['product', 'What does your company do?'],
  ['audience', 'Who do you want to reach?'],
  ['goal', 'What do you want your posts to achieve?'],
  ['cadence', 'How often should Lens post? For example, 3 times a week.'],
  ['voice', 'How should your posts sound? You can also mention topics to avoid.'],
];
const FINAL_REPLY = 'I have enough to save your brand. Connect LinkedIn to continue (Lens posts there). Sculptex for 3D visuals is optional.';
const LINKEDIN_REASONS = {
  cancelled: 'LinkedIn sign-in was cancelled.',
  state: 'LinkedIn sign-in expired or was opened in another tab. Try connecting again.',
  token: 'LinkedIn did not finish the sign-in. Try connecting again.',
  profile: 'LinkedIn signed you in but did not share your profile. Try connecting again.',
  scope: 'LinkedIn did not grant posting permission. Try connecting again and allow posting.',
  config: "LinkedIn isn't configured on this deployment.",
};

function err(code, message, extra = {}) {
  const e = new Error(message);
  if (code) e.code = code;
  Object.assign(e, extra);
  return e;
}

// ============================================================== small text helpers

function str(x, max = 2000) {
  return typeof x === 'string' ? x.trim().slice(0, max) : '';
}

function clip(text, n) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

function countWords(text) {
  return (String(text || '').trim().match(/\S+/g) || []).length;
}

function sentences(text) {
  return String(text || '').replace(/[ \t]+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"“'(])/).filter(Boolean);
}

/** Keep whole sentences up to `max` words; a single over-long sentence is cut at a word boundary. */
function clampWords(text, max) {
  const t = String(text || '').trim();
  if (countWords(t) <= max) return t;
  const paras = t.split(/\n{2,}/);
  const out = [];
  let used = 0;
  for (const p of paras) {
    const parts = sentences(p);
    const keep = [];
    for (const s of parts) {
      const n = countWords(s);
      if (used + n > max) break;
      keep.push(s);
      used += n;
    }
    if (keep.length) out.push(keep.join(' '));
    if (keep.length < parts.length) break;
  }
  if (out.length) return out.join('\n\n');
  return `${t.split(/\s+/).slice(0, max).join(' ')}…`;
}

function limitHashtags(text, max = 3) {
  let seen = 0;
  return String(text || '')
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, (m, pre) => (++seen <= max ? m : pre))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain text: no markdown emphasis, headings, code ticks or wrapping quotes. */
function plain(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/```[a-z]*\n?|```/gi, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|[.,!?]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1')
    .replace(/^["“](.*)["”]$/s, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Post copy: plain paragraphs (bullets and emphasis removed is too aggressive for posts, so only emphasis/headings). */
function postCopy(text) {
  return limitHashtags(String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^["“]([\s\S]*)["”]$/, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim(), 3);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function httpUrl(u) {
  const v = String(u || '').trim();
  if (!/^https?:\/\//i.test(v)) return '';
  try {
    return new URL(v).toString();
  } catch {
    return '';
  }
}

function normalizeSiteUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withProto);
    if (!/\./.test(u.hostname)) return '';
    return u.toString();
  } catch {
    return '';
  }
}

const STOP = new Set('the a an and or but of for to in on at with from by is are was were be been it this that these those you your our we they i my me as into about over than then so not no yes can will just more most very also how what why when where who which their there here have has had do does did make made get got use used using help helps helping who people teams company companies platform tool tools app apps product products build builds building easy simple better new best way ways all any every one'.split(' '));

function keywordsFrom(text, n = 4) {
  const counts = new Map();
  for (const w of String(text || '').toLowerCase().match(/[a-z][a-z0-9+-]{2,}/g) || []) {
    if (STOP.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

// ============================================================== brand helpers

function normBrand(brand) {
  const b = brand && typeof brand === 'object' ? brand : {};
  const keywords = Array.isArray(b.keywords) ? b.keywords.map((k) => str(k, 60)).filter(Boolean).slice(0, 8) : [];
  return {
    name: str(b.name, 120) || hostOf(b.url) || 'the company',
    url: str(b.url, 300),
    product: str(b.product, 600),
    audience: str(b.audience, 300),
    goal: str(b.goal, 300),
    voice: str(b.voice, 300),
    cadence: Number.isInteger(b.cadence) ? b.cadence : undefined,
    summary: str(b.summary, 400),
    keywords,
  };
}

function brandBrief(b) {
  return [
    `Company: ${b.name}${b.url ? ` (${b.url})` : ''}`,
    b.product && `What it does: ${b.product}`,
    b.summary && b.summary !== b.product && `Summary: ${b.summary}`,
    b.audience && `Audience: ${b.audience}`,
    b.goal && `Goal for posts: ${b.goal}`,
    b.voice && `Voice: ${b.voice}`,
    b.keywords.length && `Keywords: ${b.keywords.join(', ')}`,
  ].filter(Boolean).join('\n');
}

function topicOf(b) {
  if (b.keywords.length) return b.keywords.slice(0, 3).join(' ');
  const kw = keywordsFrom(`${b.product} ${b.summary}`, 3);
  return kw.length ? kw.join(' ') : b.name;
}

function audienceShort(b) {
  return clip(String(b.audience || '').split(/[,.;]| and /i)[0], 40).replace(/…$/, '');
}

// ============================================================== connections

const listeners = new Set();
let lastSnapshot = '';

function mcpRow(key) {
  const c = mcp.getConnection(key);
  const row = { connected: c.status === 'connected' };
  if (c.status === 'connecting') row.connecting = true;
  if (c.account) row.account = String(c.account);
  if (c.error && c.status !== 'connected') row.error = String(c.error);
  return row;
}

/** Sync snapshot of every connection. */
export function connections() {
  const li = linkedin.current();
  const LinkedIn = { connected: Boolean(li.connected) };
  if (li.name) LinkedIn.name = li.name;
  if (li.picture) LinkedIn.picture = li.picture;
  if (li.connected && typeof li.canReply === 'boolean') LinkedIn.canReply = li.canReply; // comment permission granted
  if (li.error && !li.connected) LinkedIn.error = li.error;
  return { Sculptex: mcpRow('sculptex'), LinkedIn };
}

export function onConnectionsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  const snap = connections();
  const key = JSON.stringify(snap);
  if (key === lastSnapshot) return;
  lastSnapshot = key;
  for (const fn of [...listeners]) {
    try { fn(snap); } catch (e) { console.warn('[Lens] connections listener failed', e); }
  }
}

mcp.onChange(() => emit());
linkedin.onChange(() => emit());

function providerName(p) {
  const v = String(p || '').toLowerCase();
  return PROVIDERS.find((x) => x.toLowerCase() === v) || '';
}

// ---- account names (best effort, never throws)

function decodeJwtName(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return '';
    const data = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return String(data.name || data.display_name || data.email || '').trim();
  } catch {
    return '';
  }
}

const accountLookups = {};

function fillAccount(key) {
  if (!accountLookups[key]) accountLookups[key] = lookupAccount(key).finally(() => { accountLookups[key] = null; });
  return accountLookups[key];
}

async function lookupAccount(key) {
  try {
    const account = decodeJwtName(mcp.getConnection(key).auth?.accessToken);
    if (account) mcp.patchConn(key, { account: String(account).trim().slice(0, 120) });
  } catch (e) {
    console.warn(`[Lens] ${mcp.label(key)} account lookup failed`, e);
  }
}

mcp.onConnected((key) => fillAccount(key));

// ---- init / connect / disconnect

let initPromise = null;

/** Call once on load: completes any OAuth return and refreshes connection status. */
export function init() {
  if (!initPromise) initPromise = doInit();
  return initPromise;
}

function stripLinkedInFlag() {
  let params;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    return null;
  }
  const flag = params.get('li');
  if (!flag) return null;
  const reason = params.get('reason') || '';
  params.delete('li');
  params.delete('reason');
  const qs = params.toString();
  try {
    history.replaceState(history.state, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash || ''}`);
  } catch {
    /* ignore */
  }
  return { flag, reason };
}

async function doInit() {
  const out = {};
  // 1) Sculptex OAuth return (?code=&state= on this page).
  if (mcp.hasPendingCallback()) {
    const r = await mcp.handleOAuthCallback();
    if (r && r.label) out.returnedFrom = r.label;
    if (r && !r.ok && r.error) out.error = r.error;
  } else {
    // Not returning from sign-in: a connection left "connecting" (back button on the sign-in page) is not connected.
    for (const key of Object.values(MCP_KEYS)) {
      if (mcp.getConnection(key).status === 'connecting') mcp.patchConn(key, { status: 'disconnected' });
    }
    try {
      const params = new URLSearchParams(location.search);
      if (params.get('state') && (params.get('code') || params.get('error')) && !params.get('li')) {
        const r = await mcp.handleOAuthCallback(); // cleans the URL, reports an expired sign-in
        if (r && r.error) out.error = r.error;
      }
    } catch {
      /* ignore */
    }
  }
  // 2) LinkedIn return (?li=connected | ?li=error&reason=…).
  const li = stripLinkedInFlag();
  if (li) {
    out.returnedFrom = 'LinkedIn';
    if (li.flag !== 'connected') out.error = LINKEDIN_REASONS[li.reason] || 'LinkedIn sign-in failed. Try connecting again.';
  }
  await linkedin.status();
  if (li && li.flag !== 'connected') linkedin.setError(out.error);
  else if (li && !linkedin.current().connected) {
    out.error = 'LinkedIn sign-in finished, but the session was not saved. Check that cookies are allowed and try again.';
    linkedin.setError(out.error);
  }
  // 3) Account names for MCP connections restored from sessionStorage.
  for (const key of Object.values(MCP_KEYS)) {
    const c = mcp.getConnection(key);
    if (c.status === 'connected' && !c.account) fillAccount(key);
  }
  you.status();
  ai.status();
  emit();
  return out;
}

// Back from a provider's sign-in page through the back/forward cache: this module does not run again, so undo the
// "connecting" state init() would have cleared on a fresh load and re-check LinkedIn.
try {
  globalThis.addEventListener?.('pageshow', (event) => {
    if (!event || !event.persisted) return;
    for (const key of Object.values(MCP_KEYS)) {
      if (mcp.getConnection(key).status === 'connecting') mcp.patchConn(key, { status: 'disconnected' });
    }
    linkedin.status().finally(() => emit());
  });
} catch {
  /* no window (tests) */
}

/** Connect a provider. Throws code 'redirect' when the page is navigating to the provider's sign-in. */
export async function connect(provider) {
  const p = providerName(provider);
  if (!p) throw err('', `Unknown provider: ${provider}`);
  if (p === 'LinkedIn') {
    await linkedin.connect(); // navigates away (throws 'redirect') or throws a readable error
    return connections().LinkedIn;
  }
  const key = MCP_KEYS[p];
  const conn = await mcp.connect(key);
  if (conn && conn.redirecting) throw err('redirect', `Opening ${p} sign-in…`);
  if (conn && conn.status === 'connected') await fillAccount(key);
  emit();
  return connections()[p];
}

export async function disconnect(provider) {
  const p = providerName(provider);
  if (!p) return;
  if (p === 'LinkedIn') await linkedin.disconnect();
  else mcp.disconnect(MCP_KEYS[p]);
  emit();
}

export async function disconnectAll() {
  mcp.disconnectAll();
  await linkedin.disconnect();
  emit();
}

// ============================================================== scan

/** Read a company website → { name, summary, product, audience?, keywords: [] }. */
export async function scanSite(url) {
  const target = normalizeSiteUrl(url);
  if (!target) throw err('', 'Enter a company website, like sculptex.app.');
  const host = hostOf(target);

  let page = null;
  let pageError = null;
  try {
    page = await you.extract(target);
  } catch (e) {
    if (e.code === 'no-relay' || e.code === 'no-key' || e.code === 'credits') throw e;
    pageError = e;
  }
  let material = page && page.markdown ? page.markdown : '';
  if (material.length < 200) {
    // Thin or failed extract: add what the web says about the site.
    try {
      const results = await you.search(`${host}`, { count: 6 });
      const own = results.filter((r) => hostOf(r.url) === host || hostOf(r.url).endsWith(`.${host}`));
      const use = (own.length ? own : results).slice(0, 5);
      material += `\n\n${use.map((r) => `${r.title}\n${r.snippet}`).join('\n\n')}`;
    } catch (e) {
      if (!material) throw pageError || e;
    }
  }
  material = material.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 14000);
  if (!material) throw err('', `Lens could not read ${host}.`);

  let out;
  try {
    out = await ai.json({
    system: 'You read a company website and describe the company for its founder. Use only what the page says; never invent facts. Plain text, no markdown.',
    prompt: `Website: ${target}\nPage title: ${(page && page.title) || ''}\n\nPage content (markdown):\n${material}\n\nDescribe the company:
- name: the company or product name as written on the site
- summary: one line (max 20 words) saying what the product is and who it is for
- product: one sentence (max 25 words) saying what the product helps customers do
- audience: who it is for (a short phrase), or "" if unclear
- keywords: 3 to 6 short topic keywords for the company's field (lowercase)`,
    shape: '{"name": string, "summary": string, "product": string, "audience": string, "keywords": [string]}',
    maxTokens: 900,
    temperature: 0.2,
  });
  } catch (e) {
    // AI unavailable: still use what was read (title + first real sentence) so the scan isn't empty.
    const fallback = readWithoutAI(material, page, host);
    if (fallback) return fallback;
    throw e;
  }
  const name = str(out.name, 80) || (page && clip(page.title, 60)) || host;
  const summary = plain(str(out.summary, 300)).replace(/\.$/, '');
  const product = plain(str(out.product, 400));
  if (!summary && !product) throw err('', `Lens could not tell what ${host} does.`);
  const result = {
    name,
    summary: summary || product.replace(/\.$/, ''),
    product: product || `${summary}.`,
    keywords: (Array.isArray(out.keywords) ? out.keywords : []).map((k) => str(k, 40).toLowerCase()).filter(Boolean).slice(0, 6),
  };
  const audience = plain(str(out.audience, 200));
  if (audience) result.audience = audience;
  return result;
}

/** Best-effort description from the page text alone (no AI): page title + first descriptive sentence. */
function readWithoutAI(material, page, host) {
  const rawTitle = String((page && page.title) || '').replace(/\s+/g, ' ').trim();
  const name = clip(rawTitle.split(/\s[|·–—-]\s/)[0] || host, 60) || host;
  const sentences = String(material || '')
    .split('\n')
    .map((line) => line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#>*_`|]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((line) => line.split(' ').length >= 6 && line.length <= 400 && !/cookie|sign in|log in|privacy|terms|©/i.test(line))
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .filter((t) => t.split(' ').length >= 6);
  const titleRest = rawTitle.includes(' — ') || rawTitle.includes(' - ') || rawTitle.includes(' | ') ? rawTitle.split(/\s[|·–—-]\s/).slice(1).join(' ').trim() : '';
  const first = sentences[0] || (titleRest.split(' ').length >= 3 ? titleRest : '');
  if (!first) return null;
  const summary = plain(first.split(' ').slice(0, 24).join(' ')).replace(/[.!?]+$/, '');
  if (!summary) return null;
  return { name, summary, product: `${summary}.`, keywords: [], fromPageOnly: true };
}

// ============================================================== onboarding

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14 };

function parseCadence(text) {
  const t = String(text || '').toLowerCase();
  if (/\btwice (?:a |per )?day\b|\btwice daily\b/.test(t)) return 14;
  if (/\b(?:once (?:a |per )?day|daily|every day|each day)\b/.test(t)) return 7;
  if (/\bevery (?:other|second) day\b/.test(t)) return 3;
  if (/\b(?:per|a|each) month\b|\bmonthly\b/.test(t)) return null;
  const m = t.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen)\b/);
  if (m) {
    const n = NUMBER_WORDS[m[1]] ?? Number(m[1]);
    if (/\b(?:a|per|each) day\b|\bdaily\b/.test(t)) return Number.isInteger(n) && n >= 1 && n <= 2 ? n * 7 : null;
    return Number.isInteger(n) && n >= 1 && n <= 14 ? n : null;
  }
  if (/\btwice\b/.test(t)) return 2;
  if (/\bweekly\b|\bonce (?:a |per )?week\b|\bonce\b/.test(t)) return 1;
  return null;
}

function toCadence(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 14) return v;
  if (typeof v === 'string' && v.trim()) return parseCadence(v.trim()) || (/^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 14 ? Number(v) : null);
  return null;
}

function cleanAnswers(a) {
  const out = {};
  const src = a && typeof a === 'object' ? a : {};
  for (const [key] of SLOTS) {
    if (key === 'cadence') {
      const c = toCadence(src.cadence);
      if (c) out.cadence = c;
    } else {
      const v = plain(str(src[key], 400));
      if (v.length >= 2) out[key] = v;
    }
  }
  return out;
}

function nextSlot(answers) {
  return SLOTS.find(([k]) => answers[k] === undefined) || null;
}

function opener(site, scan) {
  const name = str(scan && scan.name, 80) || hostOf(normalizeSiteUrl(site)) || str(site, 80) || 'your company';
  const summary = str(scan && (scan.summary || scan.product), 240).replace(/\.$/, '');
  if (summary) return `I read ${name}: ${summary}. Did I get that right? Correct anything that’s off, or describe what your company does in a sentence.`;
  return `I’ll build a brand profile for ${name}. ${SLOTS[0][1]}`;
}

/** One onboarding chat turn. messages: [{ role:'agent'|'user', text }]. */
export async function onboardTurn({ site, scan, answers, messages } = {}) {
  const current = cleanAnswers(answers);
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({ role: m.role === 'agent' ? 'agent' : 'user', text: m.text.trim().slice(0, 1500) }));

  // No agent message yet: open with what the scan learned (no AI round trip needed).
  if (!list.some((m) => m.role === 'agent')) {
    const done = !nextSlot(current);
    return { reply: done ? FINAL_REPLY : opener(site, scan), answers: current, done };
  }

  const slot = nextSlot(current);
  const lastUser = [...list].reverse().find((m) => m.role === 'user');
  const transcript = list.slice(-24).map((m) => `${m.role === 'agent' ? 'Lens' : 'Founder'}: ${m.text}`).join('\n');
  const scanText = scan && typeof scan === 'object'
    ? JSON.stringify({ name: scan.name, summary: scan.summary, product: scan.product, audience: scan.audience, keywords: scan.keywords })
    : 'none (the scan did not work)';

  const system = `You are Lens's onboarding agent. Through a short chat you build a brand profile for a founder's company, so Lens can write LinkedIn posts for them.

Fill five slots, in this order:
1. product: what the company does / what it helps customers do
2. audience: who the posts should reach (a named group, e.g. "early-stage SaaS founders")
3. goal: what the posts should achieve (concrete, e.g. "find our first 50 users")
4. cadence: posts per week, an integer from 1 to 14
5. voice: how the posts should sound; may include topics to avoid

Rules:
- Ask exactly one question per turn, about the first slot that is still empty.
- Read the founder's latest message. If it answers the slot being asked, record it in their words, lightly cleaned up (one sentence, max 25 words).
- If the answer is vague (like "idk", "everyone", "stuff", "grow", or too short to be useful), do not record it. Ask a friendly follow-up with a concrete example instead.
- If the founder confirms the scanned description ("yes", "that's right", "correct"), record the scan's product description as product. If they correct it, record their correction.
- cadence: convert phrases to an integer ("three times a week" → 3, "daily" → 7, "twice a day" → 14, "weekly" → 1). If it is outside 1–14 or unclear, do not record it; ask again and mention the 1–14 range.
- One message may answer several slots; record every slot it clearly answers. The founder may also correct an earlier answer.
- Never invent answers.
- Replies are brief (1–2 sentences, max 40 words), friendly, plain text. No markdown, no lists, no emoji.
- When all five slots are filled, set done to true and reply with a short wrap-up: you have enough to save the brand, and they need to connect LinkedIn to continue (Lens posts there), and Sculptex for 3D visuals is optional.`;

  const prompt = `Company website: ${str(site, 300) || 'unknown'}
Website scan: ${scanText}
Slots already filled: ${JSON.stringify(current)}
Slot being asked now: ${slot ? slot[0] : 'none (all filled)'}

Conversation so far:
${transcript}

Return the slots recorded from the founder's latest message (and any corrections) in "answers" (omit slots you are not recording), your next message in "reply", and "done".`;

  const out = await ai.json({
    system,
    prompt,
    shape: '{"reply": string, "answers": {"product"?: string, "audience"?: string, "goal"?: string, "cadence"?: integer, "voice"?: string}, "done": boolean}',
    maxTokens: 900,
    temperature: 0.3,
  });

  const merged = { ...current, ...cleanAnswers(out && out.answers) };
  if (slot && slot[0] === 'cadence' && merged.cadence === undefined && lastUser) {
    const c = parseCadence(lastUser.text);
    if (c) merged.cadence = c;
  }
  const next = nextSlot(merged);
  const done = !next;
  let reply = clampWords(plain(str(out && out.reply, 1200)), 60);
  if (done && !(out && out.done === true)) reply = FINAL_REPLY;
  if (!done && (out && out.done === true)) reply = '';
  if (!reply) reply = done ? FINAL_REPLY : next[1];
  return { reply, answers: merged, done };
}

// ============================================================== sources and threads

const PLATFORMS = [
  ['reddit', 'Reddit', (h) => h === 'reddit.com' || h.endsWith('.reddit.com')],
  ['hackernews', 'Hacker News', (h) => h === 'news.ycombinator.com'],
  ['x', 'X', (h) => h === 'x.com' || h === 'twitter.com' || h.endsWith('.x.com') || h.endsWith('.twitter.com')],
  ['linkedin', 'LinkedIn', (h) => h === 'linkedin.com' || h.endsWith('.linkedin.com')],
  ['indiehackers', 'Indie Hackers', (h) => h === 'indiehackers.com' || h.endsWith('.indiehackers.com')],
  ['producthunt', 'Product Hunt', (h) => h === 'producthunt.com' || h.endsWith('.producthunt.com')],
];

function isCommunity(url) {
  const h = hostOf(url);
  return COMMUNITY_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`)) || h === 'twitter.com';
}

function siteLabel(url) {
  const h = hostOf(url);
  if (!h) return 'Source';
  const p = PLATFORMS.find(([, , test]) => test(h));
  return p ? p[1] : h;
}

/** LinkedIn thread URN from a post URL: /posts/…-activity-<id>-…, /feed/update/urn:li:activity:<id> (also share/ugcPost). */
export function linkedinUrnFrom(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    return '';
  }
  const h = u.hostname.replace(/^www\./, '').toLowerCase();
  if (!(h === 'linkedin.com' || h.endsWith('.linkedin.com'))) return '';
  let path = u.pathname;
  try { path = decodeURIComponent(path); } catch { /* keep raw */ }
  let m = /urn:li:(activity|share|ugcPost):(\d{6,25})(?!\d)/i.exec(path);
  if (!m && /^\/posts\//i.test(path)) m = /-(activity|share|ugcPost)-(\d{6,25})(?=-|\/|$)/i.exec(path);
  if (!m) return '';
  const type = m[1].toLowerCase() === 'ugcpost' ? 'ugcPost' : m[1].toLowerCase();
  return `urn:li:${type}:${m[2]}`;
}

/** { platform (id), platformLabel, community, author } from a thread URL. */
function threadMeta(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { platform: 'web', platformLabel: 'Web', community: '', author: '' };
  }
  const h = u.hostname.replace(/^www\./, '').toLowerCase();
  const p = PLATFORMS.find(([, , test]) => test(h));
  const path = u.pathname;
  if (!p) return { platform: 'web', platformLabel: h, community: h, author: '' };
  const [platform, platformLabel] = p;
  let community = platformLabel;
  let author = '';
  if (platform === 'reddit') {
    const sub = /\/r\/([A-Za-z0-9_]+)/.exec(path);
    const user = /\/(?:u|user)\/([A-Za-z0-9_-]+)/.exec(path);
    if (sub) community = `r/${sub[1]}`;
    if (user) author = `u/${user[1]}`;
  } else if (platform === 'x') {
    const handle = /^\/([A-Za-z0-9_]{1,15})(?:\/|$)/.exec(path);
    if (handle && !['search', 'i', 'home', 'explore', 'hashtag', 'intent', 'share'].includes(handle[1].toLowerCase())) author = `@${handle[1]}`;
  } else if (platform === 'linkedin') {
    const post = /^\/posts\/([A-Za-z0-9-]{2,100})_/.exec(path);
    const person = /^\/in\/([A-Za-z0-9-]{2,100})/.exec(path);
    if (post) author = post[1];
    else if (person) author = person[1];
  } else if (platform === 'producthunt') {
    const product = /^\/(?:products|posts)\/([A-Za-z0-9-]{2,80})/.exec(path);
    if (product) community = `Product Hunt · ${product[1]}`;
  }
  return { platform, platformLabel, community, author };
}

function sourceLabelOf(thread) {
  const c = thread.community && thread.community !== thread.platformLabel ? ` · ${thread.community}` : '';
  return `${thread.platformLabel || siteLabel(thread.url)}${c}`;
}

function threadId(url) {
  let h = 5381;
  const s = String(url || '').replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase();
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `t${h.toString(36)}`;
}

/** Threads from listen() (or anything shaped like them) → validated thread objects. */
function normThreads(threads) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(threads) ? threads : []) {
    if (!t || typeof t !== 'object') continue;
    const url = httpUrl(t.url);
    if (!url) continue;
    const id = threadId(url);
    if (seen.has(id)) continue;
    seen.add(id);
    const meta = threadMeta(url);
    const thread = {
      id,
      url,
      title: clip(str(t.title, 300), 200) || url,
      snippet: str(t.snippet, 1200),
      platform: meta.platform,
      platformLabel: meta.platformLabel,
      community: clip(str(t.community, 80), 60) || meta.community,
    };
    const author = clip(str(t.author, 80), 60) || meta.author;
    if (author) thread.author = author;
    if (t.publishedAt && !Number.isNaN(new Date(t.publishedAt).getTime())) thread.publishedAt = new Date(t.publishedAt).toISOString();
    const urn = LI_THREAD_URN.test(str(t.linkedinUrn, 200)) ? str(t.linkedinUrn, 200) : linkedinUrnFrom(url);
    if (urn) thread.linkedinUrn = urn;
    if (['brand', 'competitor', 'problem'].includes(t.about)) thread.about = t.about;
    out.push(thread);
  }
  return out;
}

function excludeSet(exclude) {
  const set = new Set();
  for (const x of Array.isArray(exclude) ? exclude : []) {
    const v = typeof x === 'string' ? x : x && (x.url || x.sourceUrl);
    if (v) set.add(threadId(v));
    if (x && typeof x === 'object' && typeof x.id === 'string') set.add(x.id);
  }
  return set;
}

// ---- verbatim quotes

// Normalised text (lowercase, straight quotes, ellipses as spaces, single spaces) plus, for each normalised character,
// the [start, end) span it came from in the original, so a match can be cut out of the source word for word.
function normMap(text) {
  const src = String(text || '');
  let out = '';
  const map = [];
  for (let i = 0; i < src.length;) {
    let ch = src[i];
    let len = 1;
    if (ch === '…') ch = ' ';
    else if (src.startsWith('...', i)) {
      ch = ' ';
      len = 3;
    } else if (/[’‘`´]/.test(ch)) ch = "'";
    else if (/[“”„]/.test(ch)) ch = '"';
    else if (/\s/.test(ch)) ch = ' ';
    else {
      const lower = ch.toLowerCase();
      if (lower.length === 1) ch = lower;
    }
    if (!(ch === ' ' && (!out || out.endsWith(' ')))) {
      out += ch;
      map.push([i, i + len]);
    }
    i += len;
  }
  return { out, map };
}

const QUOTE_EDGES = /^[\s"'.,;:!?()[\]-]+|[\s"'.,;:!?()[\]-]+$/g;

function normQuote(text) {
  return normMap(text).out.replace(QUOTE_EDGES, '').trim();
}

function cleanQuote(text) {
  let q = String(text || '').replace(/\s+/g, ' ').trim().replace(/^["“'‘]+|["”'’]+$/g, '').trim();
  q = q.replace(/^(?:…|\.{3})\s*|\s*(?:…|\.{3})$/g, '').trim();
  return q;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** The original text of the first whole-word match of normalised quote n in source, or ''. */
function sourceSpan(source, n) {
  const { out, map } = normMap(source);
  for (let k = out.indexOf(n); k >= 0; k = out.indexOf(n, k + 1)) {
    const before = k > 0 ? out[k - 1] : ' ';
    const after = k + n.length < out.length ? out[k + n.length] : ' ';
    if (WORD_CHAR.test(before) || WORD_CHAR.test(after)) continue; // starts or ends inside a word
    const from = map[k][0];
    const to = map[k + n.length - 1][1];
    return String(source).slice(from, to).replace(/\s+/g, ' ').trim();
  }
  return '';
}

/**
 * A quote that appears word for word (whole words) in a result's title or text → { text, idx }, or null.
 * text is the source's own wording (case, quote marks, punctuation), shortened to 30 words.
 */
function verifyQuote(raw, results, preferIdx = -1) {
  const n = normQuote(cleanQuote(raw));
  if (countWords(n) < 3) return null;
  const order = preferIdx >= 0 && preferIdx < results.length ? [preferIdx, ...results.keys()] : [...results.keys()];
  for (const i of order) {
    const r = results[i];
    if (!r) continue;
    const found = sourceSpan(r.snippet, n) || sourceSpan(`${r.title} ${r.snippet}`, n);
    if (found) {
      const words = found.split(' ');
      return { text: words.length > 30 ? `${words.slice(0, 25).join(' ')}…` : found, idx: i };
    }
  }
  return null;
}

// Words that show someone is describing a problem rather than a vendor describing a feature.
const PAIN_MARKER = /\?|\b(?:hate|frustrat\w*|struggl\w*|annoy\w*|slow|hard|difficult|painful|pain|problem\w*|issue\w*|broken|bug\w*|can't|cannot|couldn't|doesn't|don't|won't|isn't|never|wish|tired of|sick of|confus\w*|expensive|waste\w*|stuck|fail\w*|nightmare|impossible|clunky|tedious)\b/i;

/**
 * The snippet sentence (verbatim) that clearly expresses a pain point, max 30 words; '' when nothing fits.
 * Needs at least 2 shared keywords, at least 40% of the label's keywords, and wording that describes a problem.
 */
function bestSentence(result, label, detail = '') {
  const labelWords = keywordsFrom(label, 6);
  const want = new Set([...labelWords, ...keywordsFrom(detail, 8)]);
  const needLabel = Math.max(1, Math.ceil(labelWords.length * 0.4));
  let best = '';
  let bestScore = 0;
  for (const s of sentences(result.snippet)) {
    const t = s.trim();
    if (countWords(t) < 5 || !PAIN_MARKER.test(normMap(t).out)) continue;
    const words = keywordsFrom(t, 30);
    const score = words.filter((w) => want.has(w)).length;
    const labelHits = words.filter((w) => labelWords.includes(w)).length;
    if (score < 2 || labelHits < needLabel) continue;
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  if (!best) return '';
  const w = best.split(/\s+/);
  return w.length > 30 ? `${w.slice(0, 25).join(' ')}…` : best;
}

function resultsBlock(results) {
  return results.map((r, i) => {
    const date = r.publishedAt ? r.publishedAt.slice(0, 10) : 'undated';
    return `[${i}] ${clip(r.title, 160)}\n    ${r.url}\n    ${date} · ${clip(r.snippet, 420)}`;
  }).join('\n');
}

function mergeResults(lists, exclude = '') {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const r of list) {
      const key = r.url.replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase();
      if (seen.has(key)) continue;
      const h = hostOf(r.url);
      if (exclude && (h === exclude || h.endsWith(`.${exclude}`))) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

async function settledSearches(specs) {
  const settled = await Promise.allSettled(specs.map(([q, opts]) => you.search(q, opts)));
  const ok = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  if (!ok.length) throw settled[0].reason;
  return ok;
}

function asArray(v, key) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    for (const k of [key, 'items', 'results', 'drafts']) if (Array.isArray(v[k])) return v[k];
  }
  return [];
}

function intOf(v) {
  if (Number.isInteger(v)) return v;
  if (v === null || v === '' || v === undefined || typeof v === 'boolean') return -1;
  const n = Number(v);
  return Number.isInteger(n) ? n : -1;
}

// ============================================================== listening

const LISTEN_TTL_MS = 12 * 60 * 60 * 1000;
let listenCache = null; // { key, value }
let listenInflight = null; // { key, promise }

function competitorsOf(brand) {
  const raw = brand && brand.competitors;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;\n]/) : [];
  return list.map((c) => str(c, 60)).filter((c) => c.length >= 2).slice(0, 4);
}

/** 2–4 likely competitor names from the brand brief (one compact AI call); [] when unsure or unavailable. */
async function guessCompetitors(b) {
  if (!b.product && !b.summary) return [];
  let out;
  try {
    out = await ai.json({
      system: 'You name direct competitors of a company: products or companies that sell to the same customers for the same job. Only name ones you are confident exist. Plain names only, no descriptions.',
      prompt: `Brand brief:\n${brandBrief(b)}\n\nName 2–4 direct competitors. If unsure, return {"competitors": []}.`,
      shape: '{"competitors": [string]}',
      maxTokens: 200,
      temperature: 0.2,
    });
  } catch {
    return [];
  }
  const own = b.name.toLowerCase();
  const names = [];
  for (const c of asArray(out, 'competitors')) {
    const name = clip(plain(str(typeof c === 'string' ? c : c && c.name, 60)), 40);
    if (name.length < 2 || name.toLowerCase() === own || names.some((n) => n.toLowerCase() === name.toLowerCase())) continue;
    names.push(name);
  }
  return names.slice(0, 4);
}

/** Words that describe the problem the product solves (keywords first, then the product line and audience). */
function problemOf(b) {
  const words = [];
  for (const w of [...b.keywords.slice(0, 3), ...keywordsFrom(`${b.product} ${b.summary}`, 4)]) {
    for (const part of String(w).toLowerCase().split(/\s+/)) if (part && !words.includes(part)) words.push(part);
  }
  return words.slice(0, 5).join(' ') || topicOf(b);
}

function normPainPoints(list) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || typeof p !== 'object') continue;
    const label = clip(plain(str(p.label, 200)), 80);
    if (!label) continue;
    const quotes = (Array.isArray(p.quotes) ? p.quotes : [])
      .map((q) => ({ text: clip(str(q && q.text, 400), 240), url: httpUrl(q && q.url), source: clip(str(q && q.source, 80), 60) }))
      .filter((q) => q.text);
    out.push({ label, detail: clip(plain(str(p.detail, 400)), 200), count: Math.max(1, intOf(p.count)), quotes });
  }
  return out;
}

/**
 * Listen to public conversations about the brand, its competitors and the problem it solves (You.com, past month),
 * then distill pain points with verbatim quotes and keep the threads worth engaging.
 * → { at, painPoints:[{label, detail, count, quotes:[{text, url, source}]}],
 *     threads:[{id, url, title, snippet, platform, platformLabel, community, author?, publishedAt?, linkedinUrn?, about?}] }
 * Cached in memory for 12 h per brand; force: true searches again.
 */
export async function listen({ brand, force = false } = {}) {
  const b = normBrand(brand);
  const competitors = competitorsOf(brand);
  const key = JSON.stringify([b.name, b.url, b.product, b.audience, b.keywords, competitors]);
  if (!force && listenCache && listenCache.key === key && Date.now() - listenCache.value.at < LISTEN_TTL_MS) {
    return JSON.parse(JSON.stringify(listenCache.value));
  }
  if (listenInflight && listenInflight.key === key) return listenInflight.promise;
  const promise = doListen(b, competitors).then((value) => {
    listenCache = { key, value };
    return JSON.parse(JSON.stringify(value));
  });
  listenInflight = { key, promise };
  try {
    return await promise;
  } finally {
    if (listenInflight && listenInflight.promise === promise) listenInflight = null;
  }
}

async function doListen(b, known) {
  const name = b.name && b.name !== 'the company' ? b.name : '';
  // No competitors saved yet: ask the AI for likely ones while the other searches run.
  const guessing = known.length ? Promise.resolve(known) : guessCompetitors(b);
  const problem = problemOf(b);
  const aud = audienceShort(b);
  const community = { freshness: 'month', includeDomains: COMMUNITY_DOMAINS };
  const specs = [];
  if (name) {
    specs.push(['brand', `"${name}"`, { count: 12, ...community }]);
    specs.push(['brand', `${name} ${b.keywords[0] || ''} review OR alternative OR vs`.replace(/\s+/g, ' '), { count: 10, freshness: 'month' }]);
  }
  specs.push(['problem', `${problem} frustrating struggling problem`, { count: 12, ...community }]);
  specs.push(['problem', `${problem}${aud ? ` ${aud}` : ''} looking for recommendation how do you`, { count: 10, ...community }]);
  specs.push(['problem', `${problem} challenge`, { count: 10, freshness: 'month', includeDomains: ['linkedin.com'] }]);
  const first = Promise.allSettled(specs.map(([, q, opts]) => you.search(q, opts)));

  const competitors = await guessing;
  const rivalSpecs = competitors.length
    ? [
      ['competitor', `${competitors.slice(0, 3).join(' OR ')} ${b.keywords[0] || ''}`.trim(), { count: 10, ...community }],
      ['competitor', `${competitors.slice(0, 3).join(' OR ')} frustrating OR switching OR alternative`, { count: 10, ...community }],
    ]
    : [['competitor', `best ${topicOf(b)} tools alternatives`, { count: 10, ...community }]];
  const rivals = await Promise.allSettled(rivalSpecs.map(([, q, opts]) => you.search(q, opts)));
  specs.push(...rivalSpecs);
  const settled = [...(await first), ...rivals];
  if (!settled.some((s) => s.status === 'fulfilled')) throw settled[0].reason;
  const tagged = settled.map((s, i) => (s.status === 'fulfilled' ? s.value.map((r) => ({ ...r, about: specs[i][0] })) : []));
  const own = hostOf(b.url);
  const merged = mergeResults(tagged, own).filter((r) => r.title || r.snippet);
  // Community conversations first, a few open-web pages after; keep the prompt compact.
  const results = [...merged.filter((r) => isCommunity(r.url)).slice(0, 24), ...merged.filter((r) => !isCommunity(r.url)).slice(0, 8)];
  const at = Date.now();
  if (!results.length) return { at, painPoints: [], threads: [], competitors };

  const block = results.map((r, i) => {
    const meta = threadMeta(r.url);
    const date = r.publishedAt ? r.publishedAt.slice(0, 10) : 'undated';
    return `[${i}] ${meta.community || meta.platformLabel} · ${date} · ${clip(r.title, 140)}\n    ${clip(r.snippet, 320)}`;
  }).join('\n');

  const out = await ai.json({
    system: 'You analyse public online conversations for a founder. Use only the numbered results. A quote must be copied exactly, word for word, from one result\'s title or text (max 25 words); never paraphrase or invent a quote. Plain text, no markdown.',
    prompt: `Brand brief:
${brandBrief(b)}${competitors.length ? `\nCompetitors: ${competitors.join(', ')}` : ''}

Results (past month):
${block}

1. painPoints: up to 6 problems or frustrations people express that relate to what the company does (the problem it solves, its brand, or its competitors). For each: "label" (2–6 words), "detail" (one line, max 20 words), "count" (how many results mention it), "sources" (result numbers), "quotes" (1–3 exact excerpts with their result number). Strongest first. Skip anything only the company itself says.
2. threads: up to 12 results most worth engaging with: a person describing a problem, asking for a recommendation, comparing tools, or talking about the brand or competitors. Skip news, company or marketing pages, job posts and listicles. "about" is brand, competitor or problem; "author" is the person's name or handle only if it is visible in that result, else "".`,
    shape: '{"painPoints": [{"label": string, "detail": string, "count": integer, "sources": [integer], "quotes": [{"text": string, "source": integer}]}], "threads": [{"source": integer, "about": "brand"|"competitor"|"problem", "author": string}]}',
    maxTokens: 2400,
    temperature: 0.2,
  });

  const painPoints = [];
  for (const p of asArray(out && out.painPoints, 'painPoints')) {
    if (!p || typeof p !== 'object') continue;
    const label = clip(plain(str(p.label, 200)), 80);
    if (!label) continue;
    const detail = clip(plain(str(p.detail, 400)), 200);
    const quotes = [];
    const quoteIdx = new Set();
    const usedText = new Set();
    for (const q of Array.isArray(p.quotes) ? p.quotes : []) {
      const v = verifyQuote(q && typeof q === 'object' ? q.text : q, results, intOf(q && q.source));
      if (!v || usedText.has(normQuote(v.text))) continue;
      usedText.add(normQuote(v.text));
      quoteIdx.add(v.idx);
      const r = results[v.idx];
      quotes.push({ text: v.text, url: httpUrl(r.url), source: threadMeta(r.url).community || siteLabel(r.url) });
      if (quotes.length >= 3) break;
    }
    const sources = (Array.isArray(p.sources) ? p.sources : []).map(intOf).filter((i) => i >= 0 && i < results.length);
    if (!quotes.length) {
      // No exact quote survived: take the best-matching sentence, word for word, from a cited result.
      for (const i of sources) {
        const text = bestSentence(results[i], label, detail);
        if (text) {
          quoteIdx.add(i);
          quotes.push({ text, url: httpUrl(results[i].url), source: threadMeta(results[i].url).community || siteLabel(results[i].url) });
          break;
        }
      }
    }
    if (!quotes.length) continue;
    const distinct = new Set([...sources, ...quoteIdx]).size;
    const count = Math.max(quotes.length, Math.min(results.length, Math.max(intOf(p.count), distinct, 1)));
    painPoints.push({ label, detail, count, quotes });
    if (painPoints.length >= 6) break;
  }

  const picked = [];
  const pickedIdx = new Set();
  for (const t of asArray(out && out.threads, 'threads')) {
    const idx = intOf(t && typeof t === 'object' ? t.source : t);
    if (idx < 0 || idx >= results.length || pickedIdx.has(idx)) continue;
    pickedIdx.add(idx);
    const r = results[idx];
    const hay = `${r.url} ${r.title} ${r.snippet}`.toLowerCase();
    const author = clip(plain(str(t && t.author, 80)), 60);
    picked.push({ ...r, about: ['brand', 'competitor', 'problem'].includes(t && t.about) ? t.about : r.about, author: author && hay.includes(author.toLowerCase().replace(/^[@]|^u\//, '')) ? author : '' });
    if (picked.length >= 12) break;
  }
  // Keep LinkedIn posts with a URN in play (they can be answered through the API), and fall back to community results.
  for (const [i, r] of results.entries()) {
    if (picked.length >= 14) break;
    if (!pickedIdx.has(i) && linkedinUrnFrom(r.url) && r.snippet && picked.filter((p) => linkedinUrnFrom(p.url)).length < 3) {
      pickedIdx.add(i);
      picked.push(r);
    }
  }
  if (!picked.length) for (const r of results.filter((x) => isCommunity(x.url) && x.snippet).slice(0, 10)) picked.push(r);

  const threads = normThreads(picked.map((r) => ({ ...r, snippet: clip(r.snippet, 600) })));
  return { at, painPoints, threads, competitors };
}

function painBlock(pains) {
  return pains.map((p, i) => {
    const q = p.quotes[0] ? ` — e.g. "${clip(p.quotes[0].text, 160)}"` : '';
    return `(${i}) ${p.label}: ${p.detail}${q}`;
  }).join('\n');
}

// ============================================================== posts

const EFFORTS = ['low', 'medium', 'high'];
const THREE_D_RE = /\b(3d|3-d|three[- ]dimensional|cad|architect\w*|render\w*|mesh(?:es)?|modell?ing|hardware|devices?|gadgets?|industrial|manufactur\w*|fabricat\w*|machin\w*|3d[- ]print\w*|printers?|prototyp\w*|mechanical|engineer\w*|robot\w*|games?|gaming|design\w*|furniture|interiors?|construction|buildings?|real estate|packaging|physical products?|consumer products?|toys?|jewel\w*|sneakers?|footwear|automotive|cars?|drones?|aerospace|sculpt\w*|vr|xr|metaverse|animation)\b/i;

function clampEffort(v) {
  const e = String(v || '').toLowerCase().trim();
  return EFFORTS.includes(e) ? e : 'low';
}

function visual3dFrom(v, fallbackIdea) {
  const raw = v && typeof v === 'object' ? str(v.prompt, 800) : typeof v === 'string' ? str(v, 800) : '';
  const prompt = clip(plain(raw), 500);
  if (prompt && countWords(prompt) >= 3) return { prompt, effort: clampEffort(v && v.effort) };
  if (fallbackIdea) return { prompt: clip(`A clean 3D render: ${fallbackIdea.replace(/\.$/, '')}. Soft studio lighting, plain background, no text or logos.`, 500), effort: 'low' };
  return null;
}

/**
 * LinkedIn post drafts written from listened pain points and fresh You.com trend/news results.
 * count: 1–28 (2 × cadence per refill). When Sculptex is connected, posts carry visual3d: { prompt, effort } wherever
 * a 3D render fits (every post for 3D/hardware/architecture/design-type companies). effort is low|medium|high.
 */
export async function generatePosts({ brand, count = 3, painPoints } = {}) {
  const b = normBrand(brand);
  const n = Math.max(1, Math.min(28, Math.round(Number(count)) || 3));
  const pains = normPainPoints(painPoints).slice(0, 8);
  const topic = topicOf(b);
  const aud = audienceShort(b);
  let results = [];
  try {
    const lists = await settledSearches([
      [`${topic} news`, { count: 10, freshness: 'week' }],
      [`${topic}${aud ? ` ${aud}` : ''} trends events`, { count: 10, freshness: 'month' }],
    ]);
    results = mergeResults(lists, hostOf(b.url)).slice(0, 20);
  } catch (e) {
    if (!pains.length) throw e; // nothing to write from
  }

  const sculptex = mcp.getConnection('sculptex').status === 'connected';
  const fits3d = THREE_D_RE.test(`${b.product} ${b.summary} ${b.keywords.join(' ')} ${b.audience}`);
  const per = 4;
  const chunks = Math.ceil(n / per);
  const jobs = [];
  for (let c = 0; c < chunks; c++) {
    const want = Math.min(per, n - c * per);
    const mine = results.filter((_, j) => j % chunks === c);
    let myPains = pains.filter((_, j) => j % chunks === c);
    if (!myPains.length && pains.length) myPains = [pains[c % pains.length]];
    jobs.push({ want, results: mine, pains: myPains });
  }

  const posts = [];
  const titles = new Set();
  let firstError = null;
  // Two AI calls at a time keeps free-tier rate limits happy.
  for (let i = 0; i < jobs.length; i += 2) {
    const batch = await Promise.allSettled(jobs.slice(i, i + 2).map((job) => draftPosts(b, job, { sculptex, fits3d })));
    for (const s of batch) {
      if (s.status === 'rejected') {
        firstError = firstError || s.reason;
        if (['no-key', 'no-relay', 'credits'].includes(s.reason && s.reason.code)) throw s.reason;
        continue;
      }
      for (const p of s.value) {
        const k = p.title.toLowerCase();
        if (titles.has(k)) continue;
        titles.add(k);
        posts.push(p);
      }
    }
  }
  if (!posts.length) throw firstError || err('', 'Lens AI did not return usable posts. Try again.');

  if (sculptex) {
    // Strong preference for Sculptex renders: every post for 3D-type companies, at least half otherwise.
    const target = fits3d ? posts.length : Math.ceil(posts.length / 2);
    let have = posts.filter((p) => p.visual3d).length;
    for (const p of posts) {
      if (have >= target) break;
      if (p.visual3d) continue;
      const v = visual3dFrom(null, p.visualIdea || (fits3d ? p.title : ''));
      if (v) {
        p.visual3d = v;
        have++;
      }
    }
  }
  return posts.slice(0, n);
}

async function draftPosts(b, job, { sculptex, fits3d }) {
  const { want, results, pains } = job;
  const visualRule = !sculptex
    ? ''
    : fits3d
      ? `\n- visual3d: Sculptex (a 3D render tool) is connected and this company works with physical or 3D things, so give EVERY post a visual3d.`
      : `\n- visual3d: Sculptex (a 3D render tool) is connected. Give a post a visual3d whenever any object, product, place or metaphor in it could be shown as a 3D render — that is most posts. Use null only when nothing physical fits.`;
  const visualSpec = sculptex
    ? `\n- visual3d.prompt: one object or small scene to render in 3D — the object, its shape, materials and colors, camera angle and lighting, plain studio background, no text or logos (max 60 words).
- visual3d.effort: "low" for simple objects or scenes (the default); "medium" only for multi-part assemblies or detailed scenes; "high" only when the post is about one intricate hero object. Pick the lowest effort that will still look good — renders only need to look good, not be manufacturable.`
    : '';

  const system = `You write LinkedIn posts for a founder, in their brand voice. Each post is built on one pain point people have publicly described, or one recent web result (trend, news or event), and connects it to what the founder's company does.

Rules for every post:
- title: a hook headline, max 90 characters.
- copy: 80–180 words, short paragraphs separated by blank lines, first person from the founder ("we" for the company).
- At most 3 hashtags, at the very end. No emoji unless the voice asks for them. No markdown.
- End the copy with a question to the reader.
- Use only facts in the brand brief, the pain point or the chosen result. Never invent numbers, quotes, names, dates or claims. You may quote a pain point's example quote exactly.
- "pain" is the pain point number the post is built on, or null. "source" is the result number it uses, or null. Posts use different pain points or results.
- "topic" is 2–4 words naming what the post is about.
- "visualIdea" is one sentence describing a simple image that would suit the post.${visualRule}${visualSpec}`;

  const prompt = `Brand brief:
${brandBrief(b)}

What people are saying (pain points):
${pains.length ? painBlock(pains) : '(none)'}

Recent web results:
${results.length ? resultsBlock(results) : '(none found)'}

Write ${want} different LinkedIn post${want === 1 ? '' : 's'}${pains.length ? ', most of them built on the pain points' : ''}.${!results.length && !pains.length ? ' Nothing was found, so write from the brand brief only, with "source" and "pain" null, and do not mention any news.' : ''}`;

  const shape = `[{"title": string, "copy": string, "pain": integer|null, "source": integer|null, "topic": string, "visualIdea": string${sculptex ? ', "visual3d": {"prompt": string, "effort": "low"|"medium"|"high"}|null' : ''}}]`;
  const out = await ai.json({ system, prompt, shape, maxTokens: sculptex ? 3400 : 3000, temperature: 0.7 });

  const used = new Set();
  const posts = [];
  for (const p of asArray(out, 'posts')) {
    if (!p || typeof p !== 'object') continue;
    const title = clip(plain(str(p.title, 300)), 90);
    const copy = postCopy(str(p.copy, 4000));
    if (!title || countWords(copy) < 20) continue;
    const post = { kind: 'post', title, copy };
    const idx = intOf(p.source);
    const r = idx >= 0 && idx < results.length ? results[idx] : null;
    const pi = intOf(p.pain);
    const pain = pi >= 0 && pi < pains.length ? pains[pi] : null;
    const t = clip(plain(str(p.topic, 80)), 40);
    if (r && !used.has(idx) && httpUrl(r.url)) {
      used.add(idx);
      post.sourceUrl = httpUrl(r.url);
      post.sourceLabel = `${siteLabel(r.url)} · ${t || clip(r.title, 40)}`;
    } else if (pain && pain.quotes[0] && pain.quotes[0].url) {
      post.sourceUrl = pain.quotes[0].url;
      post.sourceLabel = `${siteLabel(pain.quotes[0].url)} · ${clip(pain.label, 40)}`;
    }
    if (pain) post.painPoint = pain.label;
    const visualIdea = clip(plain(str(p.visualIdea, 400)), 220);
    if (visualIdea) post.visualIdea = visualIdea;
    if (sculptex && p.visual3d) {
      const v = visual3dFrom(p.visual3d, '');
      if (v) post.visual3d = v;
    } else if (sculptex && fits3d) {
      const v = visual3dFrom(null, visualIdea || title);
      if (v) post.visual3d = v;
    }
    posts.push(post);
    if (posts.length >= want) break;
  }
  return posts;
}

// ============================================================== comment replies

const LI_THREAD_URN = /^urn:li:(?:activity|share|ugcPost):\d{6,25}$/;
const LINKEDIN_MAX_COMMENT = 1250;

// "I'm building …", "I'm the founder of …", "we built …", "… founder here", "disclosure: …".
const DISCLOSURE = /\bdisclos\w*|\b(?:i'm|i am|we're|we are)\b[^.!?]{0,40}?\b(?:building|founder|co-?founder|working on|making|running|maker|ceo|behind)\b|\b(?:i|we)\s+(?:also\s+)?(?:built|build|made|make|run|founded|co-?founded|created|started|work on)\b|\b(?:founder|co-?founder|maker|ceo)\s+(?:of|at|here)\b/gi;

/** Appends "(I'm building <name>.)" unless the copy already discloses the affiliation next to the brand name. */
function ensureDisclosure(copy, b, max) {
  const name = b.name && b.name !== 'the company' ? b.name : '';
  if (!name) return copy;
  const text = String(copy).replace(/[’‘]/g, "'");
  // The brand name alone isn't a disclosure: a name like "Lens" or "Linear" is also an ordinary word.
  const named = new RegExp(`(?:^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu');
  for (const m of text.matchAll(DISCLOSURE)) {
    if (/^disclos/i.test(m[0]) || named.test(text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 50))) return copy;
  }
  return `${clampWords(copy, max - 5)} (I'm building ${name}.)`;
}

/**
 * Comment-reply drafts on listened threads where a founder's reply would be welcome.
 * → [{ kind:'reply', platform, platformLabel, community, title, quote, copy, sourceUrl, sourceLabel, threadId, author?, linkedinUrn? }]
 * platform is an id: 'linkedin' | 'reddit' | 'hackernews' | 'x' | 'indiehackers' | 'producthunt' | 'web'.
 * Only items with linkedinUrn can be posted through the API (postReply); the rest are copied by hand.
 */
export async function findReplies({ brand, threads, count = 3, painPoints, exclude } = {}) {
  const b = normBrand(brand);
  const n = Math.max(1, Math.min(8, Number(count) || 3));
  const skip = excludeSet(exclude);
  const list = normThreads(threads).filter((t) => !skip.has(t.id) && t.snippet).slice(0, 16);
  if (!list.length) return [];
  const pains = normPainPoints(painPoints).slice(0, 5);

  const block = list.map((t, i) => {
    const date = t.publishedAt ? t.publishedAt.slice(0, 10) : 'undated';
    const via = t.linkedinUrn ? ' (LinkedIn post)' : '';
    return `[${i}] ${sourceLabelOf(t)}${via} · ${date}${t.author ? ` · by ${t.author}` : ''}\n    ${clip(t.title, 140)}\n    ${clip(t.snippet, 420)}`;
  }).join('\n');

  const out = await ai.json({
    system: `You help a founder join public conversations helpfully. Pick threads where a reply from the founder would be welcome: someone asks a question, asks for a recommendation, describes a problem the product helps with, or compares tools. Skip news articles, company announcements, job posts, listicles, the company's own posts, and anything where a vendor reply would be unwelcome.

For each pick write a reply comment:
- max 80 words, plain text, no markdown, no emoji, no hashtags, no links.
- helpful first: answer, share a concrete tip or insight before anything about the product.
- reference the person's own words or situation.
- disclose the affiliation plainly (e.g. "I'm building <company>").
- no hard sell, no pricing. On Reddit and Hacker News sound like a peer.
"quote" is the part of the thread you are replying to, copied word for word from its text (max 30 words). "title" is short context (max 70 characters).
Never invent details about the person or the product.`,
    prompt: `Brand brief:
${brandBrief(b)}${pains.length ? `\n\nPain points people mention:\n${painBlock(pains)}` : ''}

Threads:
${block}

Pick up to ${n} of the best and write a reply for each. Prefer LinkedIn posts when they are equally good. If none fit, return [].`,
    shape: '[{"thread": integer, "quote": string, "title": string, "copy": string}]',
    maxTokens: 2000,
    temperature: 0.5,
  });

  const used = new Set();
  const replies = [];
  for (const d of asArray(out, 'replies')) {
    if (!d || typeof d !== 'object') continue;
    const idx = intOf(d.thread ?? d.source);
    if (idx < 0 || idx >= list.length || used.has(idx)) continue;
    const t = list[idx];
    let copy = clampWords(plain(str(d.copy, 2000)), 80);
    if (countWords(copy) < 8) continue;
    copy = ensureDisclosure(copy, b, 80);
    if (copy.length > LINKEDIN_MAX_COMMENT) copy = clip(copy, LINKEDIN_MAX_COMMENT);
    used.add(idx);
    const v = verifyQuote(d.quote, [t], 0);
    const quote = v ? v.text : clampWords(t.snippet, 30);
    const item = {
      kind: 'reply',
      platform: t.platform,
      platformLabel: t.platformLabel,
      community: t.community,
      title: clip(plain(str(d.title, 200)), 70) || clip(t.title, 70),
      quote,
      copy,
      sourceUrl: t.url,
      sourceLabel: sourceLabelOf(t),
      threadId: t.id,
    };
    if (t.author) item.author = t.author;
    if (t.linkedinUrn) item.linkedinUrn = t.linkedinUrn;
    replies.push(item);
    if (replies.length >= n) break;
  }
  return replies;
}

/** Post a LinkedIn reply through the API → { url?, id?, commentUrn? }. Codes: 'not-linkedin' | 'not-connected' | … */
export async function postReply(item) {
  const it = item && typeof item === 'object' ? item : {};
  const urn = str(it.linkedinUrn, 200) || linkedinUrnFrom(it.sourceUrl);
  if (!LI_THREAD_URN.test(urn)) throw err('not-linkedin', 'This reply isn’t on a LinkedIn post. Copy it and reply on the thread.');
  if (!linkedin.current().connected) throw err('not-connected', 'Reconnect LinkedIn in Settings.');
  const text = str(it.copy, 4000).replace(/\r\n?/g, '\n');
  if (!text) throw err('', 'The reply is empty.');
  if (text.length > LINKEDIN_MAX_COMMENT) throw err('', `LinkedIn comments can be at most ${LINKEDIN_MAX_COMMENT} characters; this reply has ${text.length}. Shorten it and try again.`);
  let out;
  try {
    out = await linkedin.comment({ urn, text });
  } finally {
    emit(); // an expired session shows on the connection row
  }
  const result = {};
  if (out.url) result.url = out.url;
  if (out.id) result.id = out.id;
  if (out.commentUrn) result.commentUrn = out.commentUrn;
  return result;
}

// ============================================================== DMs

const DM_PLATFORMS = new Set(['reddit', 'x', 'linkedin', 'indiehackers', 'producthunt']);

const DM_SYSTEM = `You help a founder do respectful, one-to-one outreach. From recent public community posts, pick the ones where a real person describes the problem the founder's product solves (a frustration, a struggle, or asking for a tool or a better way). Skip news articles, company pages, ads, job posts and anything not written by a person with that problem.

For each pick write a short direct message from the founder:
- max 70 words, plain text, no markdown, no emoji, no hashtags.
- reference the person's specific words or situation from the snippet.
- disclose the affiliation plainly (e.g. "I'm building <company>").
- no hard sell, no links, no pricing; offer help or ask a question.
- ask permission (e.g. "Would it be OK if I shared what we're building?").
Never invent details about the person beyond the snippet.

"title" is short context, like "u/handle on r/sub" or the thread title (max 70 characters). "recipient" is the person's handle or name only if it is visible in the URL, title or snippet, else "".`;

/**
 * DM drafts to people who publicly described the problem the product solves, from listened threads
 * (falls back to its own community search when there are none).
 * → [{ kind:'dm', title, copy, recipient?, sourceUrl, sourceLabel, platform, threadId }]
 */
export async function findDMs({ brand, threads, count = 2, painPoints, exclude } = {}) {
  const b = normBrand(brand);
  const n = Math.max(1, Math.min(5, Number(count) || 2));
  const skip = excludeSet(exclude);
  let list = normThreads(threads).filter((t) => !skip.has(t.id) && t.snippet && DM_PLATFORMS.has(t.platform));
  // People with a visible handle first; LinkedIn posts with a URN last (those are better answered with a reply).
  list.sort((x, y) => (Number(Boolean(y.author)) - Number(Boolean(x.author))) || (Number(Boolean(x.linkedinUrn)) - Number(Boolean(y.linkedinUrn))));
  list = list.slice(0, 16);
  if (!list.length) {
    const topic = topicOf(b);
    const lists = await settledSearches([
      [`${topic} frustrating problem`, { count: 10, freshness: 'month', includeDomains: COMMUNITY_DOMAINS }],
      [`${topic} looking for a better way recommendation`, { count: 10, freshness: 'month', includeDomains: COMMUNITY_DOMAINS }],
    ]);
    list = normThreads(mergeResults(lists, hostOf(b.url)).filter((r) => isCommunity(r.url)))
      .filter((t) => !skip.has(t.id) && DM_PLATFORMS.has(t.platform))
      .slice(0, 16);
  }
  if (!list.length) return [];
  const pains = normPainPoints(painPoints).slice(0, 5);

  const out = await ai.json({
    system: DM_SYSTEM,
    prompt: `Brand brief:
${brandBrief(b)}${pains.length ? `\n\nPain points people mention:\n${painBlock(pains)}` : ''}

Recent community posts:
${resultsBlock(list)}

Pick up to ${n} of the strongest and write a DM for each. If none fit, return [].`,
    shape: '[{"source": integer, "title": string, "recipient": string, "copy": string}]',
    maxTokens: 2000,
    temperature: 0.5,
  });

  const used = new Set();
  const dms = [];
  for (const d of asArray(out, 'dms')) {
    if (!d || typeof d !== 'object') continue;
    const idx = intOf(d.source);
    if (idx < 0 || idx >= list.length || used.has(idx)) continue;
    const t = list[idx];
    const copy = clampWords(plain(str(d.copy, 1500)), 70);
    if (countWords(copy) < 8) continue;
    used.add(idx);
    let recipient = clip(plain(str(d.recipient, 80)), 60);
    if (recipient && !`${t.url} ${t.title} ${t.snippet} ${t.author || ''}`.toLowerCase().includes(recipient.toLowerCase().replace(/^@|^u\//, ''))) recipient = '';
    if (!recipient && t.author) recipient = t.author;
    const sub = t.platform === 'reddit' && t.community.startsWith('r/') ? t.community : '';
    let title = clip(plain(str(d.title, 200)), 70);
    if (!title) title = recipient && sub ? `${recipient} on ${sub}` : clip(t.title, 70);
    const dm = { kind: 'dm', title, copy, sourceUrl: t.url, sourceLabel: sourceLabelOf(t), platform: t.platform, threadId: t.id };
    if (recipient) dm.recipient = recipient;
    dms.push(dm);
    if (dms.length >= n) break;
  }
  return dms;
}

// ============================================================== revise

/** Apply a revision request to a post, DM or comment reply → { title?, copy, message }. */
export async function revise({ brand, item, request } = {}) {
  const b = normBrand(brand);
  const it = item && typeof item === 'object' ? item : {};
  const kind = it.kind === 'dm' ? 'dm' : it.kind === 'reply' ? 'reply' : 'post';
  const short = kind !== 'post';
  const ask = str(request, 1000);
  if (!ask) throw err('', 'Say what to change.');
  const copyIn = str(it.copy, 4000);
  if (!copyIn) throw err('', 'There is nothing to revise yet.');

  const system = kind === 'dm'
    ? `You revise a founder's direct message to someone who publicly described a problem. Apply the requested change. Keep it max 70 words, plain text, no markdown, no emoji, no links. Keep the plain disclosure of the founder's affiliation, keep references to the person's situation, no hard sell, and keep asking permission. Never invent facts.`
    : kind === 'reply'
      ? `You revise a founder's public reply to a comment or post. Apply the requested change. Keep it max 80 words, plain text, no markdown, no emoji, no hashtags, no links. Helpful first, reference the person's own words, keep the plain disclosure of the founder's affiliation, no hard sell. Never invent facts.`
      : `You revise a founder's LinkedIn post in their brand voice. Apply the requested change and keep everything else. Unless the request says otherwise: title is a hook headline (max 90 characters); copy is 80–180 words in short paragraphs, at most 3 hashtags at the end, no markdown, and ends with a question. Never invent facts, numbers or quotes that are not already in the post or the brand brief.`;
  const noun = kind === 'dm' ? 'message' : kind === 'reply' ? 'reply' : 'post';
  const context = short
    ? `Context: ${str(it.title, 200)}${it.sourceLabel ? ` (${str(it.sourceLabel, 80)})` : ''}\n${kind === 'reply' && it.quote ? `Replying to: "${str(it.quote, 400)}"\n` : ''}`
    : `Title: ${str(it.title, 300)}\n`;
  const prompt = `Brand brief:
${brandBrief(b)}

Current ${noun}:
${context}Copy:
${copyIn}

Requested change: ${ask}

Return the revised ${noun} and "message": one short plain sentence (max 15 words) telling the founder what you changed.`;

  const out = await ai.json({
    system,
    prompt,
    shape: short ? '{"copy": string, "message": string}' : '{"title": string, "copy": string, "message": string}',
    maxTokens: 1500,
    temperature: 0.6,
  });
  let copy = kind === 'dm' ? clampWords(plain(str(out.copy, 2000)), 70)
    : kind === 'reply' ? clampWords(plain(str(out.copy, 2000)), 80)
      : postCopy(str(out.copy, 4000));
  if (kind === 'reply' && copy) {
    copy = ensureDisclosure(copy, b, 80);
    if (copy.length > LINKEDIN_MAX_COMMENT) copy = clip(copy, LINKEDIN_MAX_COMMENT);
  }
  if (!copy) throw err('', 'Lens AI did not return a revision. Try again.');
  const result = { copy, message: clip(plain(str(out.message, 300)), 140) || `Updated the ${noun}.` };
  if (!short) {
    const title = clip(plain(str(out.title, 300)), 90);
    if (title) result.title = title;
  }
  return result;
}

// ============================================================== brainstorm

/** Idea chat → { reply, proposal?: { title, copy } }. messages: [{ role:'agent'|'user', text }]. */
export async function brainstorm({ brand, messages, proposal } = {}) {
  const b = normBrand(brand);
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({ role: m.role === 'agent' ? 'assistant' : 'user', content: m.text.trim().slice(0, 2000) }));
  if (!list.some((m) => m.role === 'user')) throw err('', 'Type an idea first.');
  const current = proposal && typeof proposal === 'object' && str(proposal.copy) ? { title: str(proposal.title, 300), copy: str(proposal.copy, 4000) } : null;

  const system = `You are Lens, helping a founder brainstorm LinkedIn posts.
${brandBrief(b)}

Reply to the founder's latest message in max 60 words, plain text, friendly, no markdown, no emoji.
When there is a post idea in the conversation, include "proposal": a full draft with "title" (hook headline, max 90 characters) and "copy" (80–180 words, short paragraphs, at most 3 hashtags at the end, ends with a question, in the brand voice).
${current ? `There is a current proposal:\nTitle: ${current.title}\nCopy:\n${current.copy}\nIf the founder asks to change it, return the full refined proposal (apply the change, keep the rest). If they move to a new idea, return a new proposal.` : 'There is no proposal yet.'}
If the founder is only asking a question or chatting, set "proposal" to null.
Never invent facts, numbers or quotes about the company beyond the brief and what the founder said.

Respond with JSON only, shaped {"reply": string, "proposal": {"title": string, "copy": string} | null}.`;

  const send = async (extra = []) => ai.chat({ system, messages: [...list.slice(-20), ...extra], maxTokens: 1600, temperature: 0.7 });
  const first = await send();
  let parsed;
  try {
    parsed = ai.extractJson(first, '{');
  } catch (e) {
    try {
      parsed = ai.extractJson(await send([
        { role: 'assistant', content: first.slice(0, 3000) },
        { role: 'user', content: `That was not valid JSON (${e.message}). Reply again with only the JSON object.` },
      ]), '{');
    } catch {
      // A plain-text answer is still a usable reply.
      const reply = clampWords(plain(first), 60);
      if (!reply) throw err('', 'Lens AI did not return a usable answer. Try again.');
      return { reply };
    }
  }
  const reply = clampWords(plain(str(parsed.reply, 1500)), 60);
  const result = { reply: reply || 'Here’s a draft.' };
  const p = parsed.proposal;
  if (p && typeof p === 'object') {
    const title = clip(plain(str(p.title, 300)), 90);
    const copy = postCopy(str(p.copy, 4000));
    if (title && copy) result.proposal = { title, copy };
  }
  return result;
}

// ============================================================== visuals (MCP)

function requireConnected(provider) {
  const key = MCP_KEYS[provider];
  if (mcp.getConnection(key).status !== 'connected') throw err('not-connected', `Connect ${provider} in Settings first.`);
  return key;
}

// ---- Sculptex

const GEN_RE = /generat|create|model|part|render|design|make|build|sculpt/;
const MEDIA_RE = /\.(png|jpe?g|webp|gif|svg)(\?|#|$)/i;
const MODEL_RE = /\.(stl|3mf|step|stp|glb|gltf|obj)(\?|#|$)/i;

function scoreGenTool(tool) {
  const name = String(tool.name || '').toLowerCase();
  const desc = `${tool.title || ''} ${tool.description || ''}`.toLowerCase();
  let score = 0;
  for (const w of ['generate', 'create', 'model', 'part', 'render', 'design']) {
    if (name.includes(w)) score += 4;
    if (desc.includes(w)) score += 1;
  }
  if (GEN_RE.test(name)) score += 1;
  if (/^(list|get|delete|remove|status|whoami|search|account|usage|logout)/.test(name)) score -= 6;
  if (tool.annotations?.readOnlyHint) score -= 2;
  const props = Object.keys(tool.inputSchema?.properties || {});
  if (props.some((p) => /prompt|description|text|query/i.test(p))) score += 3;
  return score;
}

function pickGenerationTool(tools) {
  let best = null;
  let bestScore = 0;
  for (const t of tools) {
    const s = scoreGenTool(t);
    if (s > bestScore) {
      best = t;
      bestScore = s;
    }
  }
  return best;
}

function defaultFor(schema = {}) {
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'number' || type === 'integer') return typeof schema.minimum === 'number' ? schema.minimum : 1;
  if (type === 'boolean') return false;
  if (type === 'array') return [];
  if (type === 'object') return {};
  return '';
}

function isStringProp(schema) {
  if (!schema) return false;
  const t = schema.type;
  return t === 'string' || (Array.isArray(t) && t.includes('string')) || (!t && !schema.enum && !schema.properties);
}

function buildArgs(tool, prompt) {
  const schema = tool.inputSchema || {};
  const props = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const names = Object.keys(props);
  const preferred = ['prompt', 'description', 'text', 'query', 'input', 'instructions', 'request', 'idea', 'message'];
  const rank = (n) => {
    const i = preferred.findIndex((p) => n.toLowerCase() === p || n.toLowerCase().includes(p));
    return i === -1 ? preferred.length : i;
  };
  const reqStrings = required.filter((n) => isStringProp(props[n]) && !props[n]?.enum && !EFFORT_NAME_STRICT.test(n));
  const allStrings = names.filter((n) => isStringProp(props[n]) && !props[n]?.enum && !EFFORT_NAME_STRICT.test(n));
  const byPreference = (list) => list.slice().sort((a, b) => rank(a) - rank(b));
  let target = null;
  if (reqStrings.length) {
    const pref = byPreference(reqStrings);
    target = rank(pref[0]) < preferred.length ? pref[0] : reqStrings[0];
  } else if (allStrings.length) {
    target = byPreference(allStrings)[0];
  } else if (!names.length) {
    target = 'prompt';
  }
  const args = {};
  if (target) args[target] = prompt;
  for (const n of required) {
    if (n in args) continue;
    const ps = props[n] || {};
    const plainString = isStringProp(ps) && !ps.enum && ps.default === undefined && ps.const === undefined;
    args[n] = plainString ? clip(prompt, 60) : defaultFor(ps);
  }
  return args;
}

function collectUrls(value, out, depth = 0) {
  if (depth > 6 || value == null) return;
  if (typeof value === 'string') {
    for (const u of value.match(/https?:\/\/[^\s"'<>)\]]+/g) || []) out.add(u.replace(/[.,;:]+$/, ''));
    if (/^data:(image|model)\//.test(value)) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectUrls(v, out, depth + 1);
    return;
  }
  if (typeof value === 'object') for (const v of Object.values(value)) collectUrls(v, out, depth + 1);
}

function extractRender(result) {
  let renderUrl = '';
  let modelUrl = '';
  const texts = [];
  const urls = new Set();
  for (const item of result?.content || []) {
    if (!item) continue;
    if (item.type === 'image' && item.data) {
      if (!renderUrl) renderUrl = `data:${item.mimeType || 'image/png'};base64,${item.data}`;
    } else if (item.type === 'text' && item.text) {
      texts.push(item.text);
      let parsed = null;
      try { parsed = JSON.parse(item.text); } catch { parsed = null; }
      collectUrls(parsed || item.text, urls);
    } else if (item.type === 'resource_link' && item.uri) {
      urls.add(item.uri);
    } else if (item.type === 'resource' && item.resource) {
      const r = item.resource;
      if (r.blob && /^image\//.test(r.mimeType || '')) {
        if (!renderUrl) renderUrl = `data:${r.mimeType};base64,${r.blob}`;
      } else if (r.blob && r.mimeType) {
        if (!modelUrl && /model|stl|3mf|step|gltf|octet/.test(r.mimeType)) modelUrl = `data:${r.mimeType};base64,${r.blob}`;
      }
      if (r.uri) urls.add(r.uri);
      if (r.text) {
        texts.push(r.text);
        collectUrls(r.text, urls);
      }
    }
  }
  collectUrls(result?.structuredContent, urls);
  const list = [...urls].filter((u) => /^(https?:|data:)/.test(u));
  if (!renderUrl) renderUrl = list.find((u) => MEDIA_RE.test(u) || /^data:image\//.test(u)) || '';
  if (!modelUrl) modelUrl = list.find((u) => MODEL_RE.test(u)) || list.find((u) => /^https:/.test(u) && u !== renderUrl) || '';
  return { renderUrl, modelUrl, text: texts.join('\n\n').trim() };
}

// ---- render effort: only low | medium | high are ever sent

const EFFORT_NAME_STRICT = /^(?:effort|reasoning_?effort|effort_?level|quality|quality_?level|render_?quality|detail_?level|level_?of_?detail|fidelity)$/i;
const EFFORT_NAME_LOOSE = /effort|quality|fidelity|detail|lod$/i;
const EFFORT_NAME_ORDER = [/^effort$/i, /effort/i, /quality/i, /detail|lod$/i, /fidelity/i];
const EFFORT_RANK = { low: 1, medium: 2, high: 3 };
const EFFORT_WORDS = [
  [0, /^(?:minimal|min|minimum|lowest|very_?low|draft|preview|fastest|fast|quick|rough|sketch|none)$/],
  [1, /^(?:low|lo|basic|simple|light|lite)$/],
  [2, /^(?:medium|med|mid|middle|normal|standard|balanced|moderate)$/],
  [3, /^(?:high|hi|detailed|fine|hq)$/],
  [4, /^(?:x_?high|xhigh|very_?high|extra_?high|higher|highest|max|maximum|ultra|ultra_?high|best|extreme|insane|production|premium)$/],
];

function wordRank(value) {
  if (typeof value !== 'string') return -1;
  const w = value.toLowerCase().trim().replace(/[\s-]+/g, '_');
  for (const [rank, re] of EFFORT_WORDS) if (re.test(w)) return rank;
  return -1;
}

function enumOf(schema) {
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum;
  const alts = schema.anyOf || schema.oneOf;
  if (!Array.isArray(alts)) return null;
  const vals = alts.map((a) => (a && a.const !== undefined ? a.const : a && Array.isArray(a.enum) && a.enum.length === 1 ? a.enum[0] : undefined)).filter((v) => v !== undefined);
  return vals.length ? vals : null;
}

function schemaType(schema) {
  const t = Array.isArray(schema.type) ? schema.type.find((x) => x !== 'null') : schema.type;
  return t || '';
}

/** The tool input that controls effort/quality → { name, schema }, or null. */
function effortInput(tool) {
  const props = (tool.inputSchema && tool.inputSchema.properties) || {};
  const candidates = Object.keys(props).filter((name) => {
    const ps = props[name] || {};
    if (/prompt|description|text|instruction|query/i.test(name)) return false;
    const en = enumOf(ps);
    const type = schemaType(ps);
    if (en) return EFFORT_NAME_LOOSE.test(name);
    if (type === 'number' || type === 'integer') return EFFORT_NAME_LOOSE.test(name);
    if (type === 'string' || !type) return EFFORT_NAME_STRICT.test(name);
    return false;
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const ra = EFFORT_NAME_ORDER.findIndex((re) => re.test(a));
    const rb = EFFORT_NAME_ORDER.findIndex((re) => re.test(b));
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
  });
  return { name: candidates[0], schema: props[candidates[0]] || {} };
}

/** Value for an effort-like input: the closest allowed value at or below `effort` (never above high); undefined → send nothing. */
function effortValue(schema, effort) {
  const target = EFFORT_RANK[effort] || 1;
  const en = enumOf(schema);
  const type = schemaType(schema);
  if (en && en.every((v) => typeof v === 'number')) {
    return numericEffort(Math.min(...en), Math.max(...en), target, en);
  }
  if (en) {
    const ranked = en.map((v) => ({ v, r: wordRank(v) })).filter((x) => x.r >= 0 && x.r <= 3);
    if (!ranked.length) return undefined;
    const atOrBelow = ranked.filter((x) => x.r <= target).sort((a, b) => b.r - a.r);
    if (atOrBelow.length) return atOrBelow[0].v;
    return ranked.sort((a, b) => a.r - b.r)[0].v;
  }
  if (type === 'number' || type === 'integer') {
    // JSON Schema bounds: minimum/maximum (inclusive), exclusiveMinimum/exclusiveMaximum as numbers (2019+) or as
    // booleans next to minimum/maximum (draft 4).
    const exMin = typeof schema.exclusiveMinimum === 'number' || (schema.exclusiveMinimum === true && typeof schema.minimum === 'number');
    const exMax = typeof schema.exclusiveMaximum === 'number' || (schema.exclusiveMaximum === true && typeof schema.maximum === 'number');
    const min = typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum : typeof schema.minimum === 'number' ? schema.minimum : undefined;
    const max = typeof schema.exclusiveMaximum === 'number' ? schema.exclusiveMaximum : typeof schema.maximum === 'number' ? schema.maximum : undefined;
    if (min === undefined || max === undefined || max <= min) return undefined;
    const int = type === 'integer';
    const step = int ? 1 : (max - min) / 100;
    // Keep the value strictly inside exclusive bounds.
    const lo = exMin ? min + step : min;
    const hi = exMax ? max - step : max;
    if (hi < lo) return undefined;
    let v = numericEffort(min, max, target, null);
    if (int) v = Math.round(v);
    return Math.min(hi, Math.max(lo, v));
  }
  return effort; // free-form string input named effort/quality/…
}

function numericEffort(min, max, target, allowed) {
  if (allowed) {
    const sorted = [...new Set(allowed)].sort((a, b) => a - b);
    // Short scales map by position: low = first, medium = second, high = third (on a 4-step scale the top value may be "max").
    if (sorted.length <= 4) return sorted[Math.min(target - 1, sorted.length - 1, 2)];
    const want = min + { 1: 0.35, 2: 0.6, 3: 0.8 }[target] * (max - min);
    const below = sorted.filter((v) => v <= want + 1e-9);
    return below.length ? below[below.length - 1] : sorted[0];
  }
  const steps = max - min;
  const frac = steps <= 4 ? { 1: 0, 2: 0.5, 3: 0.75 }[target] : { 1: 0.35, 2: 0.6, 3: 0.8 }[target];
  return min + frac * (max - min);
}

/** Add the clamped effort to the tool arguments when the tool has an effort-like input. */
function applyEffort(tool, args, effort) {
  const input = effortInput(tool);
  if (!input) return args;
  const value = effortValue(input.schema, effort);
  if (value === undefined) {
    // Unknown scale: never leave a default above high in place.
    if (wordRank(args[input.name]) === 4) delete args[input.name];
    return args;
  }
  args[input.name] = value;
  return args;
}

async function renderWithSculptex(prompt, effort = 'low') {
  const conn = mcp.getConnection('sculptex');
  let tools = conn.tools.length ? conn.tools : await mcp.listTools('sculptex');
  let tool = pickGenerationTool(tools);
  if (!tool) {
    tools = await mcp.listTools('sculptex');
    tool = pickGenerationTool(tools) || mcp.pickTool('sculptex', ['generate', 'create', 'model', 'part', 'render', 'design']);
  }
  if (!tool) throw err('', 'Sculptex has no tool that renders models.');
  const raw = await mcp.callTool('sculptex', tool.name, applyEffort(tool, buildArgs(tool, prompt), clampEffort(effort)));
  const { renderUrl, modelUrl, text } = extractRender(raw);
  const src = /^data:image\//i.test(renderUrl) || /^https:\/\//i.test(renderUrl) ? renderUrl : '';
  if (!src) {
    throw err('', modelUrl ? 'Sculptex made a model but no preview image.' : `Sculptex returned no image${text ? `: ${clip(text, 160)}` : '.'}`);
  }
  // Keep a LinkedIn-ready copy (PNG/JPEG/GIF, capped size); a webp or oversized render is re-encoded here.
  const out = { src: (await postableImage(src)) || src, provider: 'Sculptex' };
  if (/^https:\/\//i.test(modelUrl)) out.link = modelUrl;
  return out;
}

// ---- images: LinkedIn takes PNG, JPEG or GIF; keep a lasting copy rather than a link that may expire

const POSTABLE_IMAGE = /^data:image\/(png|jpe?g|gif);base64,/i;
const MAX_STORED_IMAGE_CHARS = 1000000; // the post is saved in localStorage (~5 MB for everything)
const MAX_IMAGE_SIDE = 1600;

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/** An image (https or data:) as a lasting PNG/JPEG/GIF data URL, or '' when it cannot be read from this page. */
async function postableImage(src, timeout = 15000) {
  const value = String(src || '');
  if (POSTABLE_IMAGE.test(value) && value.length <= MAX_STORED_IMAGE_CHARS) return value;
  if (!/^(https:|data:image\/)/i.test(value)) return '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let blob;
    try {
      const res = await fetch(value, { signal: controller.signal, credentials: 'omit', cache: 'no-store' });
      if (!res.ok) return '';
      blob = await res.blob();
    } finally {
      clearTimeout(timer);
    }
    if (blob.type && !/^image\//i.test(blob.type)) return '';
    if (/^image\/(png|jpe?g|gif)$/i.test(blob.type) && blob.size * 1.37 + 40 <= MAX_STORED_IMAGE_CHARS) return await blobToDataUrl(blob);
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height, 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    for (const quality of [0.88, 0.75, 0.6]) {
      const url = canvas.toDataURL('image/jpeg', quality);
      if (POSTABLE_IMAGE.test(url) && url.length <= MAX_STORED_IMAGE_CHARS) return url;
    }
    return '';
  } catch {
    return ''; // e.g. the image host does not allow cross-origin reads
  }
}

/** Make an image for a post with Sculptex → { src, link?, provider }. effort: low | medium | high (default low). */
export async function createVisual({ provider, prompt, effort } = {}) {
  const p = providerName(provider);
  if (p !== 'Sculptex') throw err('', 'Visuals come from Sculptex.');
  requireConnected(p);
  const text = clip(str(prompt, 2000), 900);
  if (!text) throw err('', 'Describe the visual first.');
  try {
    return await renderWithSculptex(text, clampEffort(effort));
  } catch (e) {
    emit(); // a sign-in that expired mid-call shows on the connection row
    if (!/^Sculptex/.test(e.message || '')) throw err(e.code || '', `Sculptex render failed: ${e.message}`);
    throw e;
  }
}

// ============================================================== publish

const MAX_DATA_URL_CHARS = 4300000; // Vercel request bodies are capped at 4.5 MB

const LINKEDIN_MAX_TEXT = 3000;

/**
 * Post to LinkedIn now → { id, url?, imageSkipped? }. Includes the visual (https or data:image URL) when it can;
 * imageSkipped is true when the post went out without it.
 */
export async function publish(post) {
  const p = post && typeof post === 'object' ? post : {};
  const title = str(p.title, 300);
  const copy = str(p.copy, 6000);
  const text = [title, copy].filter(Boolean).join('\n\n');
  if (!text) throw err('', 'The post is empty.');
  if (text.length > LINKEDIN_MAX_TEXT) {
    throw err('', `With its headline this post is ${text.length} characters; LinkedIn allows ${LINKEDIN_MAX_TEXT}. Shorten it and try again.`);
  }
  const src = String(p.visual?.src || '');
  let imageSkipped = false;
  let imageUrl;
  if (/^https:\/\//i.test(src)) imageUrl = src;
  else if (src) {
    const ready = POSTABLE_IMAGE.test(src) && src.length <= MAX_DATA_URL_CHARS ? src : await postableImage(src);
    if (ready && ready.length <= MAX_DATA_URL_CHARS) imageUrl = ready;
    else imageSkipped = true;
  }
  const out = await linkedin.publish({ text, imageUrl });
  const result = { id: out.id };
  if (out.url) result.url = out.url;
  if (imageSkipped || out.imageSkipped) result.imageSkipped = true;
  return result;
}

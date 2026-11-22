// Lens service contract (docs/SPEC.md → "Service contract — js/services/lens.js").
//
//   init()                                   → { returnedFrom?: 'Canva'|'Sculptex'|'LinkedIn', error? }
//   connections()                            (sync) → { Canva:{connected, account?, error?}, Sculptex:{…}, LinkedIn:{connected, name?, picture?, error?} }
//   onConnectionsChange(fn)                  → unsubscribe
//   connect(provider) · disconnect(provider) · disconnectAll()
//   scanSite(url)                            → { name, summary, product, audience?, keywords: [] }
//   onboardTurn({ site, scan, answers, messages }) → { reply, answers, done }
//   generatePosts({ brand, count })          → [{ kind:'post', title, copy, sourceUrl?, sourceLabel?, visualIdea? }]
//   findDMs({ brand, count })                → [{ kind:'dm', title, copy, recipient?, sourceUrl, sourceLabel }]
//   revise({ brand, item, request })         → { title?, copy, message }
//   brainstorm({ brand, messages, proposal })→ { reply, proposal?: { title, copy } }
//   createVisual({ provider, prompt })       → { src, link?, provider, designId? }  (designId: Canva, when only a link could be kept)
//   publish(post)                            → { id, url?, imageSkipped? }
//
// Errors are Error objects with a readable .message; .code may be 'no-relay' | 'no-key' | 'credits' |
// 'not-connected' | 'redirect' (connect() navigating away to sign in).
//
// AI and search go through You.com (./you.js → ./api/you). Canva + Sculptex are MCP servers (./mcp.js, OAuth in
// sessionStorage). LinkedIn lives behind ./api/linkedin/* (./linkedin.js, HttpOnly session cookie).

import * as you from './you.js';
import * as mcp from './mcp.js';
import * as linkedin from './linkedin.js';

const PROVIDERS = ['Canva', 'Sculptex', 'LinkedIn'];
const MCP_KEYS = { Canva: 'canva', Sculptex: 'sculptex' };
const COMMUNITY_DOMAINS = ['reddit.com', 'news.ycombinator.com', 'indiehackers.com', 'x.com', 'linkedin.com'];

const SLOTS = [
  ['product', 'What does your company do?'],
  ['audience', 'Who do you want to reach?'],
  ['goal', 'What do you want your posts to achieve?'],
  ['cadence', 'How often should Lens post? For example, 3 times a week.'],
  ['voice', 'How should your posts sound? You can also mention topics to avoid.'],
];
const FINAL_REPLY = 'I have enough to save your brand. Connect Canva for design, Sculptex for 3D visuals, and LinkedIn for scheduling, or continue without connecting.';
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
  if (li.error && !li.connected) LinkedIn.error = li.error;
  return { Canva: mcpRow('canva'), Sculptex: mcpRow('sculptex'), LinkedIn };
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
    let account = '';
    if (key === 'canva') {
      const tool = mcp.findTool('canva', CANVA_TOOLS.profile.names);
      if (tool) {
        const parsed = mcp.parseToolResult(await mcp.callTool('canva', tool.name, canvaArgs(tool, {})));
        account = findKey(parsed.json, ['display_name', 'displayName', 'name', 'email'], (v) => typeof v === 'string' && v.trim()) || '';
      }
    }
    if (!account) account = decodeJwtName(mcp.getConnection(key).auth?.accessToken);
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
  // 1) Canva / Sculptex OAuth return (?code=&state= on this page).
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
  if (!target) throw err('', 'Enter a company website, like you.com.');
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

  const out = await you.json({
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
- When all five slots are filled, set done to true and reply with a short wrap-up: you have enough to save the brand, and they can connect Canva for design, Sculptex for 3D visuals and LinkedIn for scheduling, or continue without connecting.`;

  const prompt = `Company website: ${str(site, 300) || 'unknown'}
Website scan: ${scanText}
Slots already filled: ${JSON.stringify(current)}
Slot being asked now: ${slot ? slot[0] : 'none (all filled)'}

Conversation so far:
${transcript}

Return the slots recorded from the founder's latest message (and any corrections) in "answers" (omit slots you are not recording), your next message in "reply", and "done".`;

  const out = await you.json({
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

// ============================================================== posts

function siteLabel(url) {
  const h = hostOf(url);
  if (!h) return 'Source';
  if (h === 'news.ycombinator.com') return 'Hacker News';
  if (h === 'reddit.com' || h.endsWith('.reddit.com')) return 'Reddit';
  if (h === 'indiehackers.com') return 'Indie Hackers';
  if (h === 'x.com' || h === 'twitter.com') return 'X';
  if (h === 'linkedin.com' || h.endsWith('.linkedin.com')) return 'LinkedIn';
  return h;
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

/** LinkedIn post drafts grounded in fresh You.com results about the brand's field. */
export async function generatePosts({ brand, count = 3 } = {}) {
  const b = normBrand(brand);
  const n = Math.max(1, Math.min(6, Number(count) || 3));
  const topic = topicOf(b);
  const aud = audienceShort(b);
  const [news, trends] = await settledSearches([
    [`${topic} news`, { count: 8, freshness: 'week' }],
    [`${topic}${aud ? ` ${aud}` : ''} trends events`, { count: 8, freshness: 'month' }],
  ]).then((lists) => (lists.length === 2 ? lists : [lists[0], []]));
  const results = mergeResults([news, trends], hostOf(b.url)).slice(0, 14);

  const system = `You write LinkedIn posts for a founder, in their brand voice. Each post is grounded in one recent web result about the founder's field (a trend, news story or event) and connects it to what the founder's company does.

Rules for every post:
- title: a hook headline, max 90 characters.
- copy: 80–180 words, short paragraphs separated by blank lines, first person from the founder ("we" for the company).
- At most 3 hashtags, at the very end. No emoji unless the voice asks for them. No markdown.
- End the copy with a question to the reader.
- Use only facts stated in the chosen result and the brand brief. Never invent numbers, quotes, names, dates or claims. If a detail is not in the result, leave it out.
- Each post uses a different result. "source" is that result's number.
- "topic" is 2–4 words naming what the result is about (e.g. "AI agent funding").
- "visualIdea" is one sentence describing a simple image that would suit the post.`;

  const prompt = `Brand brief:
${brandBrief(b)}

Recent web results:
${results.length ? resultsBlock(results) : '(none found)'}

Write ${n} different LinkedIn post${n === 1 ? '' : 's'}.${results.length ? '' : ' No results were found, so write from the brand brief only, with "source": null, and do not mention any news.'}`;

  const out = await you.json({
    system,
    prompt,
    shape: '[{"title": string, "copy": string, "source": integer|null, "topic": string, "visualIdea": string}]',
    maxTokens: 3500,
    temperature: 0.7,
  });

  const used = new Set();
  const posts = [];
  for (const p of asArray(out, 'posts')) {
    if (!p || typeof p !== 'object') continue;
    const title = clip(plain(str(p.title, 300)), 90);
    const copy = postCopy(str(p.copy, 4000));
    if (!title || countWords(copy) < 20) continue;
    const post = { kind: 'post', title, copy };
    const idx = Number.isInteger(p.source) ? p.source : Number.isInteger(Number(p.source)) && p.source !== null && p.source !== '' ? Number(p.source) : -1;
    const r = idx >= 0 && idx < results.length ? results[idx] : null;
    if (r && !used.has(idx) && httpUrl(r.url)) {
      used.add(idx);
      post.sourceUrl = httpUrl(r.url);
      const t = clip(plain(str(p.topic, 80)), 40) || clip(r.title, 40);
      post.sourceLabel = `${siteLabel(r.url)} · ${t}`;
    }
    const visualIdea = clip(plain(str(p.visualIdea, 400)), 220);
    if (visualIdea) post.visualIdea = visualIdea;
    posts.push(post);
    if (posts.length >= n) break;
  }
  if (!posts.length) throw err('', 'You.com did not return usable posts. Try again.');
  return posts;
}

// ============================================================== DMs

function threadContext(r) {
  try {
    const u = new URL(r.url);
    const h = u.hostname.replace(/^www\./, '');
    const sub = /\/r\/([A-Za-z0-9_]+)/.exec(u.pathname);
    const user = /\/(?:u|user)\/([A-Za-z0-9_-]+)/.exec(u.pathname);
    if (/reddit\.com$/.test(h)) return { label: sub ? `Reddit · r/${sub[1]}` : 'Reddit', sub: sub ? sub[1] : '', user: user ? user[1] : '' };
    if (h === 'x.com' || h === 'twitter.com') {
      const handle = /^\/([A-Za-z0-9_]{1,15})(?:\/|$)/.exec(u.pathname);
      return { label: 'X', sub: '', user: handle && !['search', 'i', 'home'].includes(handle[1]) ? `@${handle[1]}` : '' };
    }
    if (h === 'linkedin.com' || h.endsWith('.linkedin.com')) return { label: 'LinkedIn', sub: '', user: '' };
    if (h === 'news.ycombinator.com') return { label: 'Hacker News', sub: '', user: '' };
    if (h === 'indiehackers.com' || h.endsWith('.indiehackers.com')) return { label: 'Indie Hackers', sub: '', user: '' };
    return { label: h, sub: '', user: '' };
  } catch {
    return { label: 'Source', sub: '', user: '' };
  }
}

/** DM drafts to people who publicly described the problem the product solves. */
export async function findDMs({ brand, count = 2 } = {}) {
  const b = normBrand(brand);
  const n = Math.max(1, Math.min(5, Number(count) || 2));
  const topic = topicOf(b);
  const lists = await settledSearches([
    [`${topic} frustrating problem`, { count: 10, freshness: 'month', includeDomains: COMMUNITY_DOMAINS }],
    [`${topic} looking for a better way recommendation`, { count: 10, freshness: 'month', includeDomains: COMMUNITY_DOMAINS }],
  ]);
  const results = mergeResults(lists, hostOf(b.url))
    .filter((r) => COMMUNITY_DOMAINS.some((d) => hostOf(r.url) === d || hostOf(r.url).endsWith(`.${d}`)))
    .slice(0, 16);
  if (!results.length) return [];

  const system = `You help a founder do respectful, one-to-one outreach. From recent public community posts, pick the ones where a real person describes the problem the founder's product solves (a frustration, a struggle, or asking for a tool or a better way). Skip news articles, company pages, ads, job posts and anything not written by a person with that problem.

For each pick write a short direct message from the founder:
- max 70 words, plain text, no markdown, no emoji, no hashtags.
- reference the person's specific words or situation from the snippet.
- disclose the affiliation plainly (e.g. "I'm building <company>").
- no hard sell, no links, no pricing; offer help or ask a question.
- ask permission (e.g. "Would it be OK if I shared what we're building?").
Never invent details about the person beyond the snippet.

"title" is short context, like "u/handle on r/sub" or the thread title (max 70 characters). "recipient" is the person's handle or name only if it is visible in the URL, title or snippet, else "".`;

  const prompt = `Brand brief:
${brandBrief(b)}

Recent community posts:
${resultsBlock(results)}

Pick up to ${n} of the strongest and write a DM for each. If none fit, return [].`;

  const out = await you.json({
    system,
    prompt,
    shape: '[{"source": integer, "title": string, "recipient": string, "copy": string}]',
    maxTokens: 2000,
    temperature: 0.5,
  });

  const used = new Set();
  const dms = [];
  for (const d of asArray(out, 'dms')) {
    if (!d || typeof d !== 'object') continue;
    const idx = Number(d.source);
    if (!Number.isInteger(idx) || idx < 0 || idx >= results.length || used.has(idx)) continue;
    const r = results[idx];
    const sourceUrl = httpUrl(r.url);
    const copy = clampWords(plain(str(d.copy, 1500)), 70);
    if (!sourceUrl || countWords(copy) < 8) continue;
    used.add(idx);
    const ctx = threadContext(r);
    let recipient = clip(plain(str(d.recipient, 80)), 60);
    if (!recipient && ctx.user) recipient = ctx.sub && !ctx.user.startsWith('@') ? `u/${ctx.user}` : ctx.user;
    let title = clip(plain(str(d.title, 200)), 70);
    if (!title) title = recipient && ctx.sub ? `${recipient} on r/${ctx.sub}` : clip(r.title, 70);
    const dm = { kind: 'dm', title, copy, sourceUrl, sourceLabel: ctx.label };
    if (recipient) dm.recipient = recipient;
    dms.push(dm);
    if (dms.length >= n) break;
  }
  return dms;
}

// ============================================================== revise

/** Apply a revision request to a post or DM → { title?, copy, message }. */
export async function revise({ brand, item, request } = {}) {
  const b = normBrand(brand);
  const it = item && typeof item === 'object' ? item : {};
  const isDm = it.kind === 'dm';
  const ask = str(request, 1000);
  if (!ask) throw err('', 'Say what to change.');
  const copyIn = str(it.copy, 4000);
  if (!copyIn) throw err('', 'There is nothing to revise yet.');

  const system = isDm
    ? `You revise a founder's direct message to someone who publicly described a problem. Apply the requested change. Keep it max 70 words, plain text, no markdown, no emoji, no links. Keep the plain disclosure of the founder's affiliation, keep references to the person's situation, no hard sell, and keep asking permission. Never invent facts.`
    : `You revise a founder's LinkedIn post in their brand voice. Apply the requested change and keep everything else. Unless the request says otherwise: title is a hook headline (max 90 characters); copy is 80–180 words in short paragraphs, at most 3 hashtags at the end, no markdown, and ends with a question. Never invent facts, numbers or quotes that are not already in the post or the brand brief.`;
  const prompt = `Brand brief:
${brandBrief(b)}

Current ${isDm ? 'message' : 'post'}:
${isDm ? '' : `Title: ${str(it.title, 300)}\n`}${isDm ? `Context: ${str(it.title, 200)}\n` : ''}Copy:
${copyIn}

Requested change: ${ask}

Return the revised ${isDm ? 'message' : 'post'} and "message": one short plain sentence (max 15 words) telling the founder what you changed.`;

  const out = await you.json({
    system,
    prompt,
    shape: isDm ? '{"copy": string, "message": string}' : '{"title": string, "copy": string, "message": string}',
    maxTokens: 1500,
    temperature: 0.6,
  });
  const copy = isDm ? clampWords(plain(str(out.copy, 2000)), 70) : postCopy(str(out.copy, 4000));
  if (!copy) throw err('', 'You.com did not return a revision. Try again.');
  const result = { copy, message: clip(plain(str(out.message, 300)), 140) || (isDm ? 'Updated the message.' : 'Updated the post.') };
  if (!isDm) {
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

  const send = async (extra = []) => you.chat({ system, messages: [...list.slice(-20), ...extra], maxTokens: 1600, temperature: 0.7 });
  const first = await send();
  let parsed;
  try {
    parsed = you.extractJson(first, '{');
  } catch (e) {
    try {
      parsed = you.extractJson(await send([
        { role: 'assistant', content: first.slice(0, 3000) },
        { role: 'user', content: `That was not valid JSON (${e.message}). Reply again with only the JSON object.` },
      ]), '{');
    } catch {
      // A plain-text answer is still a usable reply.
      const reply = clampWords(plain(first), 60);
      if (!reply) throw err('', 'You.com did not return a usable answer. Try again.');
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
  const reqStrings = required.filter((n) => isStringProp(props[n]) && !props[n]?.enum);
  const allStrings = names.filter((n) => isStringProp(props[n]) && !props[n]?.enum);
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

async function renderWithSculptex(prompt) {
  const conn = mcp.getConnection('sculptex');
  let tools = conn.tools.length ? conn.tools : await mcp.listTools('sculptex');
  let tool = pickGenerationTool(tools);
  if (!tool) {
    tools = await mcp.listTools('sculptex');
    tool = pickGenerationTool(tools) || mcp.pickTool('sculptex', ['generate', 'create', 'model', 'part', 'render', 'design']);
  }
  if (!tool) throw err('', 'Sculptex has no tool that renders models.');
  const raw = await mcp.callTool('sculptex', tool.name, buildArgs(tool, prompt));
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

// ---- images: LinkedIn takes PNG, JPEG or GIF; links from Canva expire (export ≈ 24 h, thumbnail ≈ 15 min)

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

// ---- Canva (tools resolved from tools/list; Canva's documented names first, then a fuzzy match)

const CANVA_INTENT = 'Create a social media visual for a LinkedIn post drafted in Lens';
const CANVA_TOOLS = {
  generate: { names: ['generate-design'], intents: ['generate design', 'design candidates'] },
  fromCandidate: { names: ['create-design-from-candidate'], intents: ['create design from candidate', 'candidate'] },
  get: { names: ['get-design'], intents: [] },
  export: { names: ['export-design', 'create-design-export-job'], intents: ['export design'] },
  profile: { names: ['get-user-profile', 'get-profile', 'get-current-user', 'get-user', 'whoami', 'me'], intents: [] },
};
// generate-design's design_type enum has no LinkedIn type in every version; these are social formats in preference order.
const CANVA_TYPE_FALLBACKS = ['linkedin_post', 'instagram_post', 'facebook_post', 'twitter_post', 'poster'];

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

async function canvaTool(which) {
  const spec = CANVA_TOOLS[which];
  let tool = mcp.findTool('canva', spec.names, spec.intents);
  if (!tool) {
    await mcp.listTools('canva');
    tool = mcp.findTool('canva', spec.names, spec.intents);
  }
  if (!tool) throw err('', `Your Canva connection doesn't offer "${spec.names[0]}". Reconnect Canva in Settings and try again.`);
  return tool;
}

function schemaProps(tool) {
  const schema = tool?.inputSchema || {};
  return { props: schema.properties || {}, required: Array.isArray(schema.required) ? schema.required : [] };
}

function canvaArgs(tool, values) {
  const { props, required } = schemaProps(tool);
  const names = Object.keys(props);
  const args = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null || v === '') continue;
    if (names.length && !(k in props)) continue;
    args[k] = v;
  }
  if (names.length && 'user_intent' in props && !('user_intent' in args)) args.user_intent = CANVA_INTENT;
  for (const n of required) if (!(n in args)) args[n] = defaultFor(props[n] || {});
  return args;
}

function mainTextProp(tool, fallback) {
  const { props, required } = schemaProps(tool);
  const names = Object.keys(props);
  if (!names.length) return fallback;
  for (const p of ['query', 'prompt', 'brief', 'description', 'text', 'instructions']) if (p in props) return p;
  return required.find((n) => isStringProp(props[n]) && !props[n]?.enum && n !== 'user_intent') || fallback;
}

function findKey(values, keys, ok = (v) => v != null, depth = 0) {
  if (depth > 6 || values == null) return undefined;
  const list = Array.isArray(values) && depth === 0 ? values : [values];
  for (const v of list) {
    if (!v || typeof v !== 'object') continue;
    if (!Array.isArray(v)) {
      for (const k of keys) if (k in v && ok(v[k])) return v[k];
    }
    for (const child of Array.isArray(v) ? v : Object.values(v)) {
      if (child && typeof child === 'object') {
        const hit = findKey(child, keys, ok, depth + 1);
        if (hit !== undefined) return hit;
      }
    }
  }
  return undefined;
}

function firstThumb(x) {
  if (!x) return '';
  if (typeof x.thumbnail === 'string') return x.thumbnail;
  return x.thumbnail?.url || x.thumbnails?.[0]?.url || x.thumbnail_url || x.thumbnailUrl || '';
}

function normalizeDesign(d) {
  if (!isObj(d)) return null;
  const id = d.id || d.design_id || '';
  if (!id) return null;
  const editUrl = d.urls?.edit_url || d.edit_url || d.editUrl || d.url || '';
  return {
    id: String(id),
    title: d.title || d.name || 'Untitled design',
    thumbnailUrl: firstThumb(d),
    editUrl,
    viewUrl: d.urls?.view_url || d.view_url || d.viewUrl || d.url || editUrl,
  };
}

function normalizeCandidate(c) {
  if (!isObj(c)) return null;
  const id = c.candidate_id || c.candidateId || c.id || '';
  return id ? { id: String(id), thumbnailUrl: firstThumb(c) } : null;
}

function canvaError(prefix, e) {
  const msg = String(e?.message || e || 'unknown error');
  if (e?.code === 'not-connected' || /sign-in expired|Connect Canva|Reconnect Canva/i.test(msg)) return e instanceof Error ? e : err('', msg);
  if (/license_required/i.test(msg)) return err('', `${prefix}: this design uses premium Canva elements your plan can't export.`);
  return err('', `${prefix}: ${msg.replace(/^Canva:?\s*/, '')}`);
}

function pickDesignType(tool) {
  const prop = schemaProps(tool).props.design_type;
  if (!prop) return undefined;
  const options = Array.isArray(prop.enum) ? prop.enum : [];
  if (!options.length) return 'instagram_post';
  return CANVA_TYPE_FALLBACKS.find((o) => options.includes(o)) || options[0];
}

async function canvaGetDesign(designId) {
  const tool = await canvaTool('get');
  const parsed = mcp.parseToolResult(await mcp.callTool('canva', tool.name, canvaArgs(tool, { design_id: designId })));
  return normalizeDesign(findKey(parsed.json, ['design'], isObj) || parsed.data);
}

async function canvaGenerate(prompt) {
  const tool = await canvaTool('generate');
  const args = canvaArgs(tool, { [mainTextProp(tool, 'query')]: prompt, design_type: pickDesignType(tool) });
  const parsed = mcp.parseToolResult(await mcp.callTool('canva', tool.name, args));
  const job = findKey(parsed.json, ['job'], isObj);
  const jobId = job?.id || findKey(parsed.json, ['job_id', 'jobId'], (v) => typeof v === 'string' && v) || null;
  const list = findKey(parsed.json, ['generated_designs', 'candidates'], Array.isArray) || [];
  const candidates = list.map(normalizeCandidate).filter(Boolean);
  const design = normalizeDesign(findKey(parsed.json, ['design_summary', 'design'], isObj));
  if (!candidates.length && !design) {
    const status = String(job?.status || '').toLowerCase();
    if (status && status !== 'success') {
      throw err('', status === 'failed' ? (job?.error?.message || 'generation failed.') : 'Canva is still working on it. Try again in a moment.');
    }
    throw err('', parsed.text ? clip(parsed.text, 240) : 'Canva returned no designs.');
  }
  return { jobId, candidates, design };
}

async function canvaCreateFromCandidate(candidateId, jobId) {
  const tool = await canvaTool('fromCandidate');
  const parsed = mcp.parseToolResult(await mcp.callTool('canva', tool.name, canvaArgs(tool, { job_id: jobId, candidate_id: candidateId })));
  const design = normalizeDesign(findKey(parsed.json, ['design_summary', 'design'], isObj) || parsed.data);
  if (!design) throw err('', parsed.text ? clip(parsed.text, 200) : 'Canva did not return the new design.');
  return design;
}

async function canvaExportPng(designId) {
  const tool = await canvaTool('export');
  const { props } = schemaProps(tool);
  const fmt = props.format || {};
  const fmtType = Array.isArray(fmt.type) ? fmt.type[0] : fmt.type;
  let format = { type: 'png' };
  if (fmtType === 'string' || Array.isArray(fmt.enum)) {
    format = (fmt.enum || []).find((x) => String(x).toLowerCase() === 'png') || 'png';
  } else if (fmt.properties?.pages) {
    format = { type: 'png', pages: [1] };
  }
  const parsed = mcp.parseToolResult(await mcp.callTool('canva', tool.name, canvaArgs(tool, { design_id: designId, format })));
  const job = findKey(parsed.json, ['job'], isObj) || (isObj(parsed.data) ? parsed.data : {});
  const rawUrls = job.urls || findKey(parsed.json, ['urls', 'download_urls', 'exports'], Array.isArray) || [];
  let urls = rawUrls.map((u) => (typeof u === 'string' ? u : u?.url)).filter((u) => typeof u === 'string' && /^https:/.test(u));
  if (!urls.length) urls = parsed.urls.filter((u) => /^https:/.test(u) && /export|download|\.png(\?|$)/i.test(u));
  if (!urls.length && parsed.images[0]) urls = [parsed.images[0].src];
  if (!urls.length) {
    const status = String(job.status || '').toLowerCase();
    if (status && status !== 'success') {
      throw err('', status === 'failed' ? (job.error?.message || job.error?.code || 'export failed.') : 'Canva is still exporting. Try again in a moment.');
    }
    throw err('', parsed.text ? clip(parsed.text, 240) : 'Canva returned no export link.');
  }
  return urls[0];
}

async function createWithCanva(prompt) {
  let design;
  try {
    const gen = await canvaGenerate(prompt);
    design = gen.design;
    if (!design) {
      if (!gen.jobId || !gen.candidates[0]) throw err('', 'Canva returned no design to use.');
      design = await canvaCreateFromCandidate(gen.candidates[0].id, gen.jobId);
    }
  } catch (e) {
    throw canvaError('Canva could not make a design', e);
  }
  let src = '';
  try {
    src = await canvaExportPng(design.id);
  } catch (e) {
    let thumb = design.thumbnailUrl || '';
    if (!thumb) {
      try { thumb = (await canvaGetDesign(design.id))?.thumbnailUrl || ''; } catch { /* fall through */ }
    }
    if (!thumb) throw canvaError('Canva export failed', e);
    console.warn('[Lens] Canva export failed; using the design thumbnail', e);
    src = thumb;
  }
  // Canva's links expire, so keep the image itself. When Canva's host does not allow that, keep the design id
  // and export again right before publishing.
  const inline = await postableImage(src);
  const out = { src: inline || src, provider: 'Canva' };
  if (!inline) out.designId = design.id;
  const link = httpUrl(design.editUrl || design.viewUrl);
  if (link) out.link = link;
  return out;
}

/** Make an image for a post with Canva or Sculptex → { src, link?, provider }. */
export async function createVisual({ provider, prompt } = {}) {
  const p = providerName(provider);
  if (p !== 'Canva' && p !== 'Sculptex') throw err('', 'Choose Canva or Sculptex.');
  requireConnected(p);
  const text = clip(str(prompt, 2000), 900);
  if (!text) throw err('', 'Describe the visual first.');
  try {
    return p === 'Canva' ? await createWithCanva(text) : await renderWithSculptex(text);
  } catch (e) {
    emit(); // a sign-in that expired mid-call shows on the connection row
    if (p === 'Sculptex' && !/^Sculptex/.test(e.message || '')) throw err(e.code || '', `Sculptex render failed: ${e.message}`);
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
  let src = String(p.visual?.src || '');
  let imageSkipped = false;
  // A Canva link kept instead of the image: export again for a fresh link while Canva is connected.
  if (/^https:\/\//i.test(src) && p.visual?.designId && mcp.isConnected('canva')) {
    try {
      src = await canvaExportPng(String(p.visual.designId));
    } catch (e) {
      console.warn('[Lens] Canva re-export failed; posting the saved link', e);
    }
  }
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

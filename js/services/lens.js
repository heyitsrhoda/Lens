// High-level Lens actions. Views call ONLY these for data; every function returns its data AND
// writes it into the store. Demo mode (settings.demoMode or a missing key) uses demo-data with a
// short simulated delay; live mode uses You.com (search + AI via the ./api/you relay; Claude optional via
// settings.aiProvider) and falls back to demo data with a toast. Every LLM call goes through ai.js.
// LinkedIn is MOCKED (no network). Sculptex is a real MCP server (see mcp.js).

import { getState, setState, toast, uid, setLoading } from '../store.js';
import { demo, replyTemplate, dmTemplate, postTemplate, altPostTemplate, postVisual } from '../demo-data.js';
import * as you from './youcom.js';
import * as ai from './ai.js';
import * as mcp from './mcp.js';

// ============================================================== shared helpers

const COMMUNITY_DOMAINS = ['reddit.com', 'news.ycombinator.com', 'indiehackers.com', 'x.com', 'twitter.com', 'linkedin.com', 'producthunt.com'];
const PAIN_WORDS = ['struggl', 'frustrat', 'hate', 'annoy', 'pain', 'stuck', 'impossible', "can't", 'cannot', 'broken', 'waste', 'tedious', 'confus', 'hard to', 'difficult', 'problem', 'issue', 'fail', 'wish'];
const SEEK_WORDS = ['looking for', 'recommend', 'alternative', 'any tool', 'anyone know', 'how do i', 'how do you', 'best way', 'is there a', 'help', 'suggestions', 'what do you use'];
const STOP_WORDS = new Set('the a an and or but of for to in on at with from by is are was were be been it this that these those you your our we they i my me as into about over than then so not no yes can will just more most very also how what why when where who which their there here have has had do does did make made get got use used using'.split(' '));
const BEST_SLOTS = [
  { dow: 2, h: 9, m: 30 },
  { dow: 3, h: 12, m: 0 },
  { dow: 4, h: 8, m: 0 },
  { dow: 1, h: 10, m: 0 },
  { dow: 5, h: 11, m: 0 },
];

const notifiedDue = new Set();
const sendingNow = new Set();

function nowIso() {
  return new Date().toISOString();
}

function delay(min = 400, max = 900) {
  const ms = Math.round(min + Math.random() * Math.max(0, max - min));
  return new Promise((r) => setTimeout(r, ms));
}

function clone(x) {
  if (x === undefined || x === null) return x;
  try { return structuredClone(x); } catch { return JSON.parse(JSON.stringify(x)); }
}

function demoList(name) {
  const v = demo?.[name];
  try {
    const out = typeof v === 'function' ? v(new Date()) : v;
    return Array.isArray(out) ? clone(out) : [];
  } catch (e) {
    console.warn(`[Lens] demo ${name} failed`, e);
    return [];
  }
}

function settings() {
  return getState().settings || {};
}

// Live AI = not in demo mode and the chosen provider is usable (You.com user key or the deployment's env key;
// or aiProvider 'claude' with a Claude key).
function canUseAI() {
  return !settings().demoMode && ai.available();
}

// Live web search = not in demo mode and a You.com key (the user's, or the deployment's env key).
function canUseYou() {
  return !settings().demoMode && you.hasKey();
}

// Wait for the relay status check (does the deployment hold an env key?) before deciding live vs demo.
async function warm() {
  try {
    await you.status();
  } catch {
    /* treated as no relay */
  }
}

function aiName() {
  return ai.providerLabel();
}

/** { live, demoMode, search, ai, provider, providerLabel, userKey, envKey, relay } — for Settings / badges. */
export async function liveStatus() {
  await warm();
  const st = you.cachedStatus() || {};
  const s = settings();
  return {
    live: canUseYou() || canUseAI(),
    demoMode: Boolean(s.demoMode),
    search: canUseYou(),
    ai: canUseAI(),
    provider: ai.provider(),
    providerLabel: ai.providerLabel(),
    userKey: you.hasUserKey(),
    envKey: Boolean(st.envKey),
    relay: Boolean(st.relay),
  };
}

function company() {
  const c = getState().company || {};
  const d = demo?.company || {};
  return {
    ...d,
    ...Object.fromEntries(Object.entries(c).filter(([, v]) => (Array.isArray(v) ? v.length : v))),
    keywords: Array.isArray(c.keywords) && c.keywords.length ? c.keywords : d.keywords || [],
    competitors: Array.isArray(c.competitors) && c.competitors.length ? c.competitors : d.competitors || [],
  };
}

async function withLoading(key, fn) {
  setLoading(key, true);
  try {
    return await fn();
  } finally {
    setLoading(key, false);
  }
}

function fallbackToast(label, err) {
  console.warn(`[Lens] ${label} failed`, err);
  if (err?.code === 'no-relay') {
    toast(you.NO_RELAY_MESSAGE, 'info');
    return;
  }
  toast(`${label}: ${err?.message || err} — using demo data instead.`, 'error');
}

function asText(x) {
  if (!x) return '';
  if (typeof x === 'string') return x;
  return x.body || x.text || '';
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function normalizeUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withProto);
    return u.toString().replace(/\/$/, '');
  } catch {
    return withProto;
  }
}

function urlKey(url) {
  return String(url || '').replace(/[#?].*$/, '').replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/, '').toLowerCase();
}

function words(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9'+-]*/g) || [];
}

function countWords(text) {
  return (String(text || '').trim().match(/\S+/g) || []).length;
}

function sentences(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"“'(])/).filter(Boolean);
}

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
    .replace(/(^|\s)#[A-Za-z][\w-]*/g, (m) => (++seen <= max ? m : ''))
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function cleanMessage(text) {
  return String(text || '')
    .trim()
    .replace(/^(here(?:'s| is)[^:\n]*:\s*)/i, '')
    .replace(/^["“](.*)["”]$/s, '$1')
    .trim();
}

function titleCase(s) {
  return String(s || '').replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function clip(text, n) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

function normForMatch(s) {
  return String(s || '').toLowerCase().replace(/[“”"’'`]/g, '').replace(/\s+/g, ' ').trim();
}

function updateDraft(id, patch) {
  let updated = null;
  setState((s) => ({
    drafts: (s.drafts || []).map((d) => {
      if (d.id !== id) return d;
      updated = { ...d, ...patch, updatedAt: nowIso() };
      return updated;
    }),
  }));
  return updated;
}

function setThreadStatus(threadId, status) {
  if (!threadId) return;
  setState((s) => ({ threads: (s.threads || []).map((t) => (t.id === threadId ? { ...t, status } : t)) }));
}

function findDraft(id) {
  const d = (getState().drafts || []).find((x) => x.id === id);
  if (!d) throw new Error('That draft no longer exists.');
  return d;
}

function findThread(id) {
  return (getState().threads || []).find((t) => t.id === id) || null;
}

function addDrafts(list) {
  setState((s) => ({ drafts: [...list, ...(s.drafts || [])] }));
}

function linkedinConnected() {
  return getState().connections?.linkedin?.status === 'connected';
}

function patchConnection(key, patch) {
  setState((s) => {
    const all = s.connections || {};
    return { connections: { ...all, [key]: { ...(all[key] || {}), ...patch } } };
  });
}

function companyBrief(c = company()) {
  return [
    `Product: ${c.name || 'Unnamed'}${c.url ? ` (${c.url})` : ''}`,
    c.tagline ? `Tagline: ${c.tagline}` : '',
    c.description ? `What it does: ${c.description}` : '',
    c.audience ? `Target audience: ${c.audience}` : '',
    c.field ? `Field: ${c.field}` : '',
    c.keywords?.length ? `Keywords: ${c.keywords.join(', ')}` : '',
    c.competitors?.length ? `Alternatives people use: ${c.competitors.join(', ')}` : '',
    c.voice ? `Founder voice: ${c.voice}` : '',
  ].filter(Boolean).join('\n');
}

// ============================================================== threads

function communityOf(url, source) {
  const host = hostOf(url);
  if (source === 'reddit') {
    const m = /\/r\/([A-Za-z0-9_]+)/.exec(url || '');
    return m ? `r/${m[1]}` : 'Reddit';
  }
  return {
    hackernews: 'Hacker News',
    x: 'X',
    linkedin: 'LinkedIn',
    indiehackers: 'Indie Hackers',
    producthunt: 'Product Hunt',
  }[source] || host || 'Web';
}

function authorOf(url, source) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (source === 'x' && parts[0] && parts[1] === 'status') return `@${parts[0]}`;
    if (source === 'reddit') {
      const i = parts.indexOf('user');
      if (i >= 0 && parts[i + 1]) return `u/${parts[i + 1]}`;
    }
    if (source === 'linkedin' && parts[0] === 'posts' && parts[1]) return parts[1].split('_')[0];
    if (source === 'linkedin' && parts[0] === 'in' && parts[1]) return parts[1];
    if (source === 'indiehackers' && parts[0] && parts[0] !== 'post') return parts[0];
  } catch { /* ignore */ }
  return '';
}

function heuristicScore(result, c) {
  const text = `${result.title} ${result.snippet}`.toLowerCase();
  const kw = (c.keywords || []).map((k) => String(k).toLowerCase()).filter(Boolean);
  const kwHits = kw.filter((k) => text.includes(k)).length;
  const fieldHits = words(c.field).filter((w) => w.length > 3 && !STOP_WORDS.has(w) && text.includes(w)).length;
  const painHits = PAIN_WORDS.filter((w) => text.includes(w)).length;
  const seekHits = SEEK_WORDS.filter((w) => text.includes(w)).length;
  const ageDays = result.publishedAt ? (Date.now() - Date.parse(result.publishedAt)) / 86400000 : 30;
  const recency = ageDays < 3 ? 10 : ageDays < 10 ? 6 : ageDays < 30 ? 3 : 0;
  const community = result.source !== 'web' ? 8 : 0;
  const relevance = Math.max(5, Math.min(96, 22 + kwHits * 12 + fieldHits * 4 + painHits * 7 + seekHits * 8 + recency + community));
  const intent = seekHits >= 1 && painHits >= 1 ? 'high' : seekHits || painHits ? 'medium' : 'low';
  const matched = kw.find((k) => text.includes(k));
  const painPoint = matched ? titleCase(matched) : (c.keywords?.[0] ? titleCase(c.keywords[0]) : 'General');
  return { relevance, intent, painPoint };
}

function bestQuote(snippet) {
  const parts = sentences(snippet);
  if (!parts.length) return clip(snippet, 200);
  let best = parts[0];
  let bestScore = -1;
  for (const s of parts) {
    const l = s.toLowerCase();
    const score = PAIN_WORDS.filter((w) => l.includes(w)).length * 2 + SEEK_WORDS.filter((w) => l.includes(w)).length + (s.length > 40 ? 1 : 0);
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return clip(best, 220);
}

function mergeThreads(existing, incoming) {
  // Match by id, else by URL + title (demo threads can share a search-page URL), keeping statuses.
  const out = (existing || []).slice();
  const byId = new Map(out.map((t, i) => [t.id, i]));
  const byKey = new Map();
  out.forEach((t, i) => {
    const k = `${urlKey(t.url)}|${normForMatch(t.title)}`;
    if (!byKey.has(k)) byKey.set(k, i);
  });
  for (const t of incoming || []) {
    const k = `${urlKey(t.url)}|${normForMatch(t.title)}`;
    const i = byId.has(t.id) ? byId.get(t.id) : byKey.get(k);
    if (i === undefined) {
      byId.set(t.id, out.length);
      byKey.set(k, out.length);
      out.push(t);
    } else {
      const old = out[i];
      out[i] = { ...old, ...t, id: old.id, status: old.status || t.status };
    }
  }
  return out
    .sort((a, b) => (b.relevance || 0) - (a.relevance || 0) || Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
    .slice(0, 80);
}

async function rankWithAI(results, c) {
  const items = results.map((r, i) => ({ i, source: r.source, title: clip(r.title, 160), snippet: clip(r.snippet, 650), url: r.url }));
  const out = await ai.json({
    system:
      'You are the research analyst inside Lens, a tool that helps a founder find people who have the problem their product solves. ' +
      'Score each public conversation honestly; most search results are NOT good leads.',
    prompt: `${companyBrief(c)}

Score these search results. For each, decide how clearly the AUTHOR personally describes the problem this product solves and would plausibly welcome a helpful reply.
- relevance: 0-100 (90+ = explicit pain + asking for help; 60-89 = clear pain; 30-59 = adjacent; <30 = not a lead, e.g. news, vendor pages, listicles)
- painPoint: a 2-4 word Title Case label for the underlying problem; REUSE the same label for results about the same problem
- intent: "high" (actively seeking a solution), "medium" (complaining / describing the pain), "low" (tangential)
- quote: copy the single most telling sentence EXACTLY, character for character, from the snippet (max 200 chars). Empty string if none.
- author: the handle or name if it appears in the snippet or URL, else ""

Results:
${JSON.stringify(items, null, 1)}`,
    schemaHint: '[{"i":0,"relevance":0,"painPoint":"","intent":"high|medium|low","quote":"","author":""}]',
    maxTokens: 3000,
  });
  const list = Array.isArray(out) ? out : Array.isArray(out?.results) ? out.results : [];
  return new Map(list.filter((x) => Number.isInteger(x?.i)).map((x) => [x.i, x]));
}

function buildThread(r, scored, c) {
  const h = heuristicScore(r, c);
  const s = scored || {};
  let quote = typeof s.quote === 'string' ? s.quote.trim() : '';
  if (!quote || !normForMatch(r.snippet).includes(normForMatch(quote))) quote = bestQuote(r.snippet);
  const intent = ['high', 'medium', 'low'].includes(s.intent) ? s.intent : h.intent;
  const relevance = Number.isFinite(Number(s.relevance)) ? Math.max(0, Math.min(100, Math.round(Number(s.relevance)))) : h.relevance;
  return {
    id: uid('t'),
    source: r.source,
    community: communityOf(r.url, r.source),
    title: r.title,
    url: r.url,
    author: (s.author || '').trim() || authorOf(r.url, r.source),
    snippet: r.snippet,
    quote,
    publishedAt: r.publishedAt || nowIso(),
    relevance,
    painPoint: (s.painPoint || '').trim() || h.painPoint,
    intent,
    engagement: { replies: 0, upvotes: 0 },
    status: 'new',
  };
}

function demoThreadsFor(query) {
  const base = demoList('threads');
  const q = words(query).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  if (!q.length) return base;
  const score = (t) => q.filter((w) => `${t.title} ${t.snippet} ${t.painPoint} ${t.community}`.toLowerCase().includes(w)).length;
  return base
    .map((t) => ({ t, s: score(t) }))
    .sort((a, b) => b.s - a.s || (b.t.relevance || 0) - (a.t.relevance || 0))
    .map(({ t, s }) => (s ? { ...t, relevance: Math.min(99, (t.relevance || 0) + 3 * s) } : t));
}

export async function findConversations({ query } = {}) {
  return withLoading('threads', async () => {
    await warm();
    const c = company();
    let incoming = null;
    if (canUseYou()) {
      try {
        const kw = (c.keywords || []).slice(0, 4);
        const topic = String(query || '').trim() || kw.slice(0, 3).join(', ') || c.field || c.name;
        const searches = [
          you.search(`${topic} — people asking for help, advice or recommendations`, { count: 20, freshness: 'month', siteFilters: COMMUNITY_DOMAINS }),
          you.search(`${topic} frustrated OR struggling OR "how do I" ${c.audience ? `(${clip(c.audience, 60)})` : ''}`.trim(), { count: 15, freshness: 'month' }),
        ];
        const settled = await Promise.allSettled(searches);
        const ok = settled.filter((s) => s.status === 'fulfilled').flatMap((s) => s.value);
        if (!ok.length) throw settled.find((s) => s.status === 'rejected')?.reason || new Error('No conversations found.');
        const ownHost = hostOf(c.url);
        const seen = new Set();
        const results = ok.filter((r) => {
          const k = urlKey(r.url);
          if (!r.url || seen.has(k) || (ownHost && hostOf(r.url) === ownHost) || !r.snippet) return false;
          seen.add(k);
          return true;
        }).slice(0, 30);
        let scored = new Map();
        if (canUseAI() && results.length) {
          try {
            scored = await rankWithAI(results, c);
          } catch (e) {
            console.warn('[Lens] AI ranking failed, using heuristic', e);
            if (e?.code !== 'no-relay') toast(`${aiName()} ranking failed (${e.message}) — used keyword scoring instead.`, 'error');
          }
        }
        incoming = results
          .map((r, i) => buildThread(r, scored.get(i), c))
          .filter((t) => t.relevance >= 30)
          .sort((a, b) => b.relevance - a.relevance)
          .slice(0, 25);
        if (!incoming.length) toast('No strong conversations found this time — try a more specific search.', 'info');
      } catch (e) {
        fallbackToast('Conversation search', e);
        incoming = null;
      }
    }
    if (!incoming) {
      await delay();
      incoming = demoThreadsFor(query);
    }
    const threads = mergeThreads(getState().threads, incoming);
    setState((s) => ({ threads, ui: { ...s.ui, lastRefresh: nowIso() } }));
    return threads;
  });
}

// ============================================================== trends & events

export async function loadTrends() {
  return withLoading('trends', async () => {
    await warm();
    const c = company();
    let trends = null;
    if (canUseYou()) {
      try {
        const results = (await you.news(`${c.field || c.keywords?.[0] || c.name} news this week`, { count: 15 })).filter((r) => r.title && r.url);
        if (!results.length) throw new Error('No recent news found.');
        let picked = results.slice(0, 6).map((r, i) => ({ r, i, summary: clip(r.snippet, 180), tag: titleCase(c.keywords?.[0] || 'News') }));
        if (canUseAI()) {
          try {
            const out = await ai.json({
              system: 'You curate a short news digest for a startup founder.',
              prompt: `${companyBrief(c)}

Pick the 6 items most useful for this founder to know about or post about this week. For each, write a one-sentence summary of what happened and why it matters to them, and a 1-2 word tag.

${JSON.stringify(results.map((r, i) => ({ i, title: r.title, snippet: clip(r.snippet, 400), date: r.publishedAt })), null, 1)}`,
              schemaHint: '[{"i":0,"summary":"","tag":""}]',
              maxTokens: 1500,
            });
            const list = (Array.isArray(out) ? out : []).filter((x) => results[x?.i]);
            if (list.length) picked = list.slice(0, 6).map((x) => ({ r: results[x.i], i: x.i, summary: x.summary || clip(results[x.i].snippet, 180), tag: x.tag || 'News' }));
          } catch (e) {
            console.warn('[Lens] AI trend summary failed', e);
          }
        }
        trends = picked.map(({ r, summary, tag }) => ({
          id: uid('tr'),
          title: r.title,
          summary,
          url: r.url,
          source: hostOf(r.url) || 'web',
          publishedAt: r.publishedAt || nowIso(),
          tag,
        }));
      } catch (e) {
        fallbackToast('Trends', e);
      }
    }
    if (!trends) {
      await delay();
      trends = demoList('trends');
    }
    setState({ trends });
    return trends;
  });
}

export async function loadEvents() {
  return withLoading('events', async () => {
    await warm();
    const c = company();
    let events = null;
    if (canUseYou() && !canUseAI()) {
      toast('Live events need the AI provider to read dates — showing sample events.', 'info');
    } else if (canUseYou()) {
      try {
        const loc = c.location ? ` ${c.location}` : '';
        const results = await you.search(`founder startup events meetups this week ${c.field || ''}${loc}`.trim(), { count: 15, freshness: 'month' });
        if (!results.length) throw new Error('No event listings found.');
        const now = new Date();
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
        const out = await ai.json({
          system: 'You extract upcoming events from search results for a startup founder. Never invent events, dates or URLs.',
          prompt: `${companyBrief(c)}

Today is ${now.toDateString()} (${now.toISOString()}), time zone ${tz}.
From the search results below, extract events that have an explicit date within the next 7 days. If a listing gives no year, assume the nearest future date. Skip anything without a date.
- start/end: ISO 8601 with time zone offset (estimate end as start + 2h if missing)
- format: "in-person" or "virtual"
- url: must be exactly the result URL it came from
- why: one sentence on why this founder should go

${JSON.stringify(results.map((r) => ({ title: r.title, url: r.url, snippet: clip(r.snippet, 500), published: r.publishedAt })), null, 1)}`,
          schemaHint: '[{"title":"","start":"","end":"","location":"","format":"in-person|virtual","url":"","host":"","why":""}]',
          maxTokens: 2000,
        });
        const allowed = new Set(results.map((r) => urlKey(r.url)));
        const horizon = Date.now() + 8 * 86400000;
        const parsed = (Array.isArray(out) ? out : [])
          .filter((e) => e?.title && e?.start && allowed.has(urlKey(e.url)))
          .map((e) => {
            const start = new Date(e.start);
            const end = e.end ? new Date(e.end) : new Date(start.getTime() + 2 * 3600000);
            return {
              id: uid('ev'),
              title: e.title,
              start: start.toISOString(),
              end: (Number.isNaN(end.getTime()) ? new Date(start.getTime() + 2 * 3600000) : end).toISOString(),
              location: e.location || (e.format === 'virtual' ? 'Online' : ''),
              format: e.format === 'virtual' ? 'virtual' : 'in-person',
              url: e.url,
              host: e.host || hostOf(e.url),
              why: e.why || '',
              _t: start.getTime(),
            };
          })
          .filter((e) => Number.isFinite(e._t) && e._t >= Date.now() - 6 * 3600000 && e._t <= horizon)
          .sort((a, b) => a._t - b._t)
          .map(({ _t, ...e }) => e);
        if (!parsed.length) throw new Error('No dated events in the next 7 days were found.');
        events = parsed;
      } catch (e) {
        fallbackToast('Events', e);
      }
    }
    if (!events) {
      await delay();
      events = demoList('events');
    }
    // Keep "Add to my week" flags across refreshes (live ids are regenerated, so also match by url+title).
    const savedPrev = (getState().events || []).filter((e) => e && e.saved);
    if (savedPrev.length) {
      const ids = new Set(savedPrev.map((e) => e.id));
      const keys = new Set(savedPrev.map((e) => urlKey(e.url) + '|' + e.title));
      events = events.map((e) => (ids.has(e.id) || keys.has(urlKey(e.url) + '|' + e.title) ? { ...e, saved: true } : e));
    }
    setState({ events });
    return events;
  });
}

export async function refreshAll() {
  return withLoading('refresh', async () => {
    const [trends, events, threads] = await Promise.allSettled([loadTrends(), loadEvents(), findConversations()]);
    setState((s) => ({ ui: { ...s.ui, lastRefresh: nowIso() } }));
    const val = (r, key) => (r.status === 'fulfilled' ? r.value : getState()[key]);
    return { trends: val(trends, 'trends'), events: val(events, 'events'), threads: val(threads, 'threads') };
  });
}

// ============================================================== drafting

function outreachSystem(c, kind, thread) {
  const limit = kind === 'dm' ? 70 : 90;
  return `You write ${kind === 'dm' ? 'a private direct message' : `a public reply in ${thread.community || 'the thread'}`} on behalf of the founder of ${c.name}.
Rules:
- Helpful first: open by engaging with their actual situation and give one concrete, useful suggestion that works even without the product.
- Reference the person's specific words — quote or closely paraphrase a detail from their post.
- Disclose plainly that you are the founder of ${c.name} (e.g. "Full disclosure: I'm building ${c.name}").
- No hard sell: no "DM me", no "sign up", no urgency, no superlatives. At most one mention of the product and at most one link.
- ${kind === 'dm' ? 'End with one low-pressure question or an easy way to say no.' : 'Write it as a natural comment from a peer.'}
- Founder voice: ${c.voice || 'warm, direct, plain language'}.
- No hashtags. No emojis. At most ${limit} words.
Output only the message text.`;
}

export async function draftOutreach(threadId, kind = 'reply') {
  const k = kind === 'dm' ? 'dm' : 'reply';
  const thread = findThread(threadId);
  if (!thread) throw new Error('That conversation is no longer in your list.');
  return withLoading(`draft:${threadId}`, async () => {
    await warm();
    const c = company();
    let body = '';
    if (canUseAI()) {
      try {
        const text = await ai.complete({
          system: outreachSystem(c, k, thread),
          messages: [{
            role: 'user',
            content: `${companyBrief(c)}

Their post (${thread.source}, ${thread.community || ''}${thread.author ? `, by ${thread.author}` : ''}):
Title: ${thread.title}
Post: ${thread.snippet}
Key quote: "${thread.quote}"
Pain point: ${thread.painPoint}

Write the ${k === 'dm' ? 'DM' : 'reply'}.`,
          }],
          maxTokens: 500,
          effort: 'medium',
        });
        body = clampWords(cleanMessage(text), k === 'dm' ? 70 : 90);
      } catch (e) {
        fallbackToast(`Drafting with ${aiName()}`, e);
      }
    }
    if (!body) {
      await delay();
      body = asText(k === 'dm' ? dmTemplate(thread, c) : replyTemplate(thread, c));
    }
    const at = nowIso();
    const draft = {
      id: uid('d'),
      kind: k,
      threadId,
      title: thread.title,
      body,
      status: 'pending',
      createdAt: at,
      updatedAt: at,
      channel: linkedinConnected() ? 'linkedin' : 'copy',
      painPoint: thread.painPoint,
    };
    addDrafts([draft]);
    if (thread.status === 'new' || thread.status === 'saved') setThreadStatus(threadId, 'drafted');
    return draft;
  });
}

const POST_RULES = `LinkedIn post rules:
- LinkedIn-native: the first line is a hook (max 12 words, specific, no clickbait), then short paragraphs separated by blank lines.
- 120 to 220 words.
- Ground it in what real people said in the conversations (paraphrase; never name or tag individuals).
- Give genuinely useful insight or advice; mention the product at most once, near the end, with a plain disclosure that you're building it.
- No hashtag spam: at most 3 hashtags, only at the very end (zero is fine). No emoji walls.
- End with a genuine question to the reader.`;

function normalizePost(p, fallbackTitle) {
  const body = limitHashtags(cleanMessage(p?.body || ''), 3);
  return {
    // Titles publish as the post's first line (see postText), so never invent one from a label.
    title: clip(String(p?.title || '').trim(), 90),
    body,
    visualIdea: (p?.visualIdea || '').trim(),
    sculptexPrompt: (p?.sculptexPrompt || '').trim(),
  };
}

function demoPost(painPoint, threads, c, variant = 0) {
  const raw = variant > 0 ? altPostTemplate(painPoint, threads, c, variant) : postTemplate(painPoint, threads, c);
  const body = asText(raw);
  const vis = postVisual(painPoint);
  return {
    // The body already opens with its hook; a separate title would publish it twice.
    title: (raw && raw.title) || '',
    body,
    visualIdea: (raw && raw.visualIdea) || vis.visualIdea,
    sculptexPrompt: (raw && raw.sculptexPrompt) || vis.sculptexPrompt || demo?.sculptexDemoPrompt || '',
  };
}

export async function draftPost({ painPoint, threadIds = [], angle, source } = {}) {
  return withLoading('post', async () => {
    await warm();
    const c = company();
    const all = getState().threads || [];
    let threads = all.filter((t) => threadIds.includes(t.id));
    if (!threads.length && painPoint) threads = all.filter((t) => t.painPoint === painPoint && t.status !== 'dismissed');
    const label = painPoint || threads[0]?.painPoint || 'What we keep hearing';
    let post = null;
    if (canUseAI()) {
      try {
        const out = await ai.json({
          system: `You ghostwrite LinkedIn posts for the founder of ${c.name}. Voice: ${c.voice || 'warm, direct, plain language'}.\n${POST_RULES}`,
          prompt: `${companyBrief(c)}

Recurring pain point: ${label}
${angle ? `Angle requested by the founder: ${angle}\n` : ''}What people said:
${threads.slice(0, 6).map((t) => `- (${t.community || t.source}) "${clip(t.quote || t.snippet, 240)}"`).join('\n') || '- (no specific conversations selected)'}

Write the post. Also give a one-line visual idea and, if a physical object fits the post, a one-sentence Sculptex prompt describing an exact 3D-printable part to render (dimensions welcome); else "".`,
          schemaHint: '{"title":"","body":"","visualIdea":"","sculptexPrompt":""}',
          maxTokens: 1400,
          effort: 'medium',
        });
        post = normalizePost(out, label);
        if (countWords(post.body) < 60) post = null;
      } catch (e) {
        fallbackToast(`Drafting the post with ${aiName()}`, e);
      }
    }
    const srcType = source?.type === 'trend' || source?.type === 'free' ? source.type : 'pain';
    if (!post) {
      await delay();
      const trend = srcType === 'trend' ? (getState().trends || []).find((t) => t.id === source.trendId) : null;
      if (trend) post = demoTrendPost(trend, await clusterPainPoints(), c);
      else if (srcType === 'free' && (source.text || angle)) post = demoIdeaPost(source.text || angle, c);
      else post = demoPost(label, threads.length ? threads : all, c);
    }
    const at = nowIso();
    const draft = {
      id: uid('d'),
      kind: 'post',
      title: post.title,
      body: post.body,
      status: 'pending',
      createdAt: at,
      updatedAt: at,
      channel: 'linkedin',
      // Trend headlines and free-text ideas are not pain points.
      painPoint: srcType === 'pain' ? label : undefined,
      source: { type: srcType, label, threadIds: threads.map((t) => t.id), ...(srcType === 'trend' ? { trendId: source.trendId } : {}) },
      visualIdea: post.visualIdea,
      sculptexPrompt: post.sculptexPrompt,
    };
    addDrafts([draft]);
    return draft;
  });
}

function demoRewrite(body, instruction, draft) {
  const ins = String(instruction || '').toLowerCase();
  let out = String(body || '');
  let changed = false;
  if (/short|concise|tight|trim|brief/.test(ins)) {
    const target = Math.max(25, Math.round(countWords(out) * 0.6));
    out = clampWords(out, target);
    changed = true;
  }
  if (/warm|friendl|kind|empath/.test(ins)) {
    if (!/^(thanks|really|totally|appreciate)/i.test(out)) out = `Really appreciate you sharing this.\n\n${out}`;
    changed = true;
  }
  if (/question/.test(ins)) {
    if (!/\?\s*(#\S+\s*)*$/.test(out.trim())) out = `${out.trim()}\n\nWhat would you add?`;
    changed = true;
  }
  if (/specific|detail|concrete/.test(ins)) {
    const t = draft?.threadId ? findThread(draft.threadId) : null;
    const q = t?.quote || '';
    if (q && !out.includes(clip(q, 60).replace(/…$/, ''))) out = `${out.trim()}\n\n(Thinking specifically about: "${clip(q, 140)}")`;
    else if (draft?.painPoint) out = `${out.trim()}\n\nThe specific piece I mean: ${draft.painPoint.toLowerCase()}.`;
    changed = true;
  }
  if (/formal|professional/.test(ins)) {
    out = out.replace(/!+/g, '.').replace(/\b(gonna|wanna)\b/gi, (m) => (m.toLowerCase() === 'gonna' ? 'going to' : 'want to'));
    changed = true;
  }
  if (/casual|relaxed|less formal/.test(ins)) {
    out = out.replace(/\bI am\b/g, "I'm").replace(/\bdo not\b/g, "don't").replace(/\bit is\b/g, "it's");
    changed = true;
  }
  if (/hook/.test(ins)) {
    const lines = out.split('\n');
    const i = lines.findIndex((l) => l.trim());
    if (i >= 0) {
      const topic = String(draft?.painPoint || '').trim();
      const hook = topic
        ? `${topic}: the part nobody warns you about.`
        : `${lines[i].trim().replace(/[.!?…]+$/, '')}. Here's what actually helps.`;
      if (lines[i].trim() !== hook) {
        lines[i] = hook;
        out = lines.join('\n');
        changed = true;
      }
    }
  }
  if (/pitch|sales|salesy|promo/.test(ins)) {
    // Keep a one-sentence founder disclosure; drop the product pitch around it.
    const PITCH = /(you can describe|happy to |if it's (relevant|helpful)|i could also|get an editable model|it's our attempt|you describe the part)/i;
    out = out
      .split('\n')
      .map((line) => {
        const sentences = line.split(/(?<=[.!?]["”)]?)\s+/);
        if (/disclosure:/i.test(line)) return sentences[0].trim();
        if (!PITCH.test(line)) return line;
        return sentences.filter((x) => !PITCH.test(x)).join(' ').trim();
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');
    changed = true;
  }
  if (/hashtag/.test(ins) && /remove|no|drop|without/.test(ins)) {
    out = out.replace(/(^|\s)#[A-Za-z][\w-]*/g, '').trim();
    changed = true;
  }
  return { body: out.trim(), changed };
}

export async function rewrite(draftId, instruction) {
  const draft = findDraft(draftId);
  const ins = String(instruction || '').trim();
  if (!ins) return draft;
  return withLoading(`rewrite:${draftId}`, async () => {
    await warm();
    let body = '';
    if (canUseAI()) {
      try {
        const c = company();
        const limits = draft.kind === 'dm' ? 'at most 70 words' : draft.kind === 'reply' ? 'at most 90 words' : '120-220 words, max 3 hashtags at the end, ending with a question';
        const text = await ai.complete({
          system: `You edit outreach and LinkedIn copy for the founder of ${c.name}. Keep the founder disclosure, stay helpful and non-salesy, keep facts and quotes accurate, ${limits}. Voice: ${c.voice || 'warm, direct'}. Output only the revised text.`,
          messages: [{ role: 'user', content: `Instruction: ${ins}\n\nCurrent ${draft.kind}:\n${draft.body}` }],
          maxTokens: 900,
        });
        body = cleanMessage(text);
        if (draft.kind === 'dm') body = clampWords(body, 70);
        else if (draft.kind === 'reply') body = clampWords(body, 90);
        else body = limitHashtags(body, 3);
      } catch (e) {
        fallbackToast(`Rewrite with ${aiName()}`, e);
      }
    }
    if (!body) {
      await delay();
      const r = demoRewrite(draft.body, ins, draft);
      body = r.body;
      if (!r.changed) toast('Demo mode handles shorter / warmer / more specific / add a question. Turn off demo mode with a You.com key for free-form rewrites.', 'info');
    }
    return updateDraft(draftId, { body });
  });
}

export async function clusterPainPoints() {
  const threads = (getState().threads || []).filter((t) => t.status !== 'dismissed' && t.painPoint);
  const groups = new Map();
  for (const t of threads) {
    const key = t.painPoint.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { painPoint: t.painPoint.trim(), threads: [] });
    groups.get(key).threads.push(t);
  }
  return [...groups.values()]
    .map((g) => {
      const sorted = g.threads.slice().sort((a, b) => (b.relevance || 0) - (a.relevance || 0));
      const top = sorted[0];
      return {
        painPoint: g.painPoint,
        count: g.threads.length,
        threadIds: sorted.map((t) => t.id),
        example: top?.quote || top?.snippet || top?.title || '',
        relevance: Math.round(sorted.reduce((n, t) => n + (t.relevance || 0), 0) / sorted.length),
        hot: sorted.filter((t) => t.intent === 'high').length,
      };
    })
    .sort((a, b) => b.count - a.count || b.relevance - a.relevance);
}

// ============================================================== sending & scheduling (LinkedIn is MOCKED)

function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
  } catch { /* fall through */ }
  return Promise.resolve(legacyCopy(text));
}

function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** The exact text a post publishes: title as a first line (unless the body already opens with it), then body. */
export function postText(d) {
  const t = String(d?.title || '').trim();
  const b = String(d?.body || '').trim();
  if (!t) return b;
  const head = t.replace(/…$/, '').trim();
  return head && b.startsWith(head) ? b : `${t}\n\n${b}`;
}

export async function sendDraft(draftId) {
  const draft = findDraft(draftId);
  if (draft.status === 'sent' || draft.status === 'posted') return draft;
  if (draft.status === 'rejected') throw new Error('This draft was rejected — restore it before sending.');
  const thread = draft.threadId ? findThread(draft.threadId) : null;
  const isPost = draft.kind === 'post';
  const text = isPost ? postText(draft) : draft.body;

  if (!linkedinConnected()) {
    // Copy + open, done synchronously inside the click so the browser allows the clipboard and the new tab.
    const copied = copyText(text);
    const target = isPost ? 'https://www.linkedin.com/feed/' : thread?.url;
    if (target) {
      try { window.open(target, '_blank', 'noopener'); } catch { /* popup blocked */ }
    }
    const ok = await copied;
    const at = nowIso();
    const updated = updateDraft(draftId, isPost ? { status: 'posted', postedAt: at, channel: 'copy', error: '' } : { status: 'sent', postedAt: at, channel: 'copy', error: '' });
    if (!isPost) setThreadStatus(draft.threadId, 'contacted');
    toast(
      ok
        ? `Copied to clipboard${target ? ' — paste it in the tab we opened' : ''}.`
        : `Couldn't copy automatically — select the text and copy it${target ? ', then paste it in the tab we opened' : ''}.`,
      ok ? 'success' : 'info',
    );
    return updated;
  }

  if (sendingNow.has(draftId)) return draft;
  sendingNow.add(draftId);
  try {
    await delay(500, 800);
    const at = nowIso();
    const entry = {
      id: uid('li'),
      draftId,
      kind: draft.kind,
      body: text,
      // data: URLs are not duplicated into the feed; PublishedFeed looks them up from the draft.
      visual: draft.visual && !/^data:/.test(draft.visual.src || '') ? draft.visual : undefined,
      to: isPost ? undefined : thread?.author || undefined,
      threadUrl: isPost ? undefined : thread?.url || undefined,
      at,
      reactions: 0,
      comments: 0,
      impressions: 0,
      reposts: 0,
      profileViews: 0,
    };
    setState((s) => ({ linkedinFeed: [entry, ...(s.linkedinFeed || [])] }));
    const updated = updateDraft(draftId, isPost ? { status: 'posted', postedAt: at, channel: 'linkedin', error: '' } : { status: 'sent', postedAt: at, channel: 'linkedin', error: '' });
    if (!isPost) setThreadStatus(draft.threadId, 'contacted');
    toast(isPost ? 'Published to LinkedIn (demo).' : `${draft.kind === 'dm' ? 'DM' : 'Reply'} sent via LinkedIn (demo).`, 'success');
    return updated;
  } finally {
    sendingNow.delete(draftId);
  }
}

export async function connectLinkedIn() {
  patchConnection('linkedin', { status: 'connecting', profile: null });
  await delay(800, 800);
  const p = demo?.linkedinProfile || {};
  const c = company();
  const profile = {
    name: p.name || 'Founder',
    headline: p.headline || `Building ${c.name}`,
    initials: p.initials || (p.name || 'F').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase(),
    ...p,
  };
  patchConnection('linkedin', { status: 'connected', profile, connectedAt: nowIso() });
  toast('LinkedIn (demo) connected — nothing is sent to the real LinkedIn.', 'success');
  return profile;
}

export async function disconnectLinkedIn() {
  patchConnection('linkedin', { status: 'disconnected', profile: null });
  return null;
}

export async function scheduleDraft(draftId, iso) {
  findDraft(draftId);
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) throw new Error('Pick a valid date and time.');
  notifiedDue.delete(draftId);
  return updateDraft(draftId, { status: 'scheduled', scheduledFor: when.toISOString(), error: '' });
}

export function runDueSchedules() {
  const now = Date.now();
  const due = (getState().drafts || []).filter((d) => d.status === 'scheduled' && d.scheduledFor && Date.parse(d.scheduledFor) <= now);
  if (!due.length) return [];
  const connected = linkedinConnected();
  for (const d of due) {
    if (connected) {
      sendDraft(d.id).catch((e) => {
        updateDraft(d.id, { error: e.message || String(e) });
        toast(`Couldn't publish "${clip(d.title || d.body, 40)}": ${e.message || e}`, 'error');
      });
    } else if (!notifiedDue.has(d.id)) {
      notifiedDue.add(d.id);
      toast(`"${clip(d.title || d.body, 48)}" is due — post it now from Schedule.`, 'info');
    }
  }
  return due.map((d) => d.id);
}

// ============================================================== Sculptex (REAL MCP)

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
    const found = value.match(/https?:\/\/[^\s"'<>)\]]+/g) || [];
    for (const u of found) out.add(u.replace(/[.,;:]+$/, ''));
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
      const parsed = (() => { try { return JSON.parse(item.text); } catch { return null; } })();
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

function demoRender(prompt, extra = {}) {
  const r = demo?.sculptexDemoRender;
  const base = typeof r === 'string' ? { renderUrl: r } : { ...(r || {}) };
  return {
    renderUrl: base.renderUrl || base.src || '',
    modelUrl: base.modelUrl || '',
    text: base.text || `Demo render (sample). Connect Sculptex to render: "${clip(prompt, 120)}"`,
    toolName: 'demo',
    raw: null,
    demo: true,
    ...extra,
  };
}

export async function renderWithSculptex({ prompt } = {}) {
  const p = String(prompt || '').trim() || demo?.sculptexDemoPrompt || 'a simple L-bracket with two mounting holes';
  return withLoading('sculptex', async () => {
    const conn = getState().connections?.sculptex || {};
    if (conn.status !== 'connected') {
      await delay();
      return demoRender(p);
    }
    try {
      let tools = Array.isArray(conn.tools) && conn.tools.length ? conn.tools : await mcp.listTools('sculptex');
      let tool = pickGenerationTool(tools);
      if (!tool) {
        tools = await mcp.listTools('sculptex');
        tool = pickGenerationTool(tools) || mcp.pickTool('sculptex', ['generate', 'create', 'model', 'part', 'render', 'design']);
      }
      if (!tool) throw new Error('Sculptex has no tool that generates models.');
      const args = buildArgs(tool, p);
      const raw = await mcp.callTool('sculptex', tool.name, args);
      const { renderUrl, modelUrl, text } = extractRender(raw);
      if (!renderUrl && !modelUrl && !text) throw new Error(`Sculptex "${tool.name}" returned nothing to show.`);
      return { renderUrl, modelUrl, text, toolName: tool.name, raw, demo: false };
    } catch (e) {
      console.warn('[Lens] Sculptex render failed', e);
      toast(`Sculptex render failed: ${e.message || e} — showing the sample render.`, 'error');
      return demoRender(p, { error: e.message || String(e) });
    }
  });
}

// ============================================================== product analysis

function profileFromText(url, title, text, c0) {
  const host = hostOf(url);
  const name = titleCase((host.split('.')[0] || 'Product').replace(/[-_]+/g, ' ')).split(' ')[0];
  const cleanTitle = String(title || '').split(/[|–—-]/)[0].trim();
  const desc = clip(sentences(text).slice(0, 2).join(' '), 300);
  const freq = new Map();
  for (const w of words(`${title} ${text}`)) {
    if (w.length < 4 || STOP_WORDS.has(w) || /^\d+$/.test(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  const keywords = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
  return {
    name: cleanTitle && cleanTitle.length < 30 ? cleanTitle : name,
    url,
    tagline: clip(String(title || '').split(/[|–—-]/).slice(1).join(' ').trim() || sentences(text)[0] || '', 110),
    description: desc,
    field: c0.field || '',
    keywords,
    competitors: [],
    audience: '',
  };
}

export async function analyzeProduct(url) {
  const target = normalizeUrl(url);
  if (!target) throw new Error('Enter your product URL first.');
  return withLoading('analyze', async () => {
    await warm();
    const base = demo?.company || {};
    const sameAsDemo = hostOf(target) && hostOf(target) === hostOf(base.url);
    let profile = null;

    if (canUseYou() || canUseAI()) {
      try {
        let pageText = '';
        let pageTitle = '';
        if (canUseYou()) {
          const [extracted, searched] = await Promise.allSettled([
            you.contents([target]),
            you.search(`${hostOf(target)} product`, { count: 6, siteFilters: [hostOf(target)] }),
          ]);
          const page = extracted.status === 'fulfilled' ? extracted.value[0] : null;
          if (page?.markdown) {
            pageText = page.markdown.slice(0, 7000);
            pageTitle = page.title;
          }
          if (searched.status === 'fulfilled' && searched.value.length) {
            pageTitle = pageTitle || searched.value[0].title;
            pageText += `\n\n${searched.value.map((r) => `${r.title}: ${r.snippet}`).join('\n')}`;
          }
          if (!pageText.trim() && !canUseAI()) {
            throw (extracted.status === 'rejected' ? extracted.reason : null)
              || (searched.status === 'rejected' ? searched.reason : null)
              || new Error('Could not read that page.');
          }
        }
        if (canUseAI()) {
          const out = await ai.json({
            system: 'You analyze a startup product from its website so a founder-marketing tool can find its future users. Be specific and concrete; do not invent features.',
            prompt: `Product URL: ${target}
${pageText.trim() ? `Website content:\n${pageText.slice(0, 8000)}` : 'No page content could be fetched — infer cautiously from the URL and say less rather than invent.'}

Return:
- name, tagline (≤ 10 words), description (2 sentences, plain language)
- field (e.g. "3D printing / CAD"), audience (who has the problem, 1 sentence)
- keywords: 6-10 phrases real users would write when describing the PROBLEM (not marketing words)
- competitors: 3-6 tools or workarounds people use today
- voice: a short description of a fitting founder voice`,
            schemaHint: '{"name":"","tagline":"","description":"","field":"","audience":"","keywords":[""],"competitors":[""],"voice":""}',
            maxTokens: 1200,
          });
          if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error(`${aiName()} returned an unexpected profile.`);
          profile = {
            name: String(out.name || '').trim(),
            url: target,
            tagline: String(out.tagline || '').trim(),
            description: String(out.description || '').trim(),
            field: String(out.field || '').trim(),
            audience: String(out.audience || '').trim(),
            keywords: (Array.isArray(out.keywords) ? out.keywords : []).map(String).filter(Boolean).slice(0, 12),
            competitors: (Array.isArray(out.competitors) ? out.competitors : []).map(String).filter(Boolean).slice(0, 8),
            voice: String(out.voice || '').trim(),
          };
        } else {
          profile = profileFromText(target, pageTitle, pageText, company());
        }
      } catch (e) {
        fallbackToast('Analyzing your site', e);
        profile = null;
      }
    }

    if (!profile) {
      await delay(600, 900);
      if (sameAsDemo) {
        profile = { ...clone(base), url: target };
      } else {
        const host = hostOf(target);
        const name = titleCase((host.split('.')[0] || 'Your product').replace(/[-_]+/g, ' '));
        profile = { ...clone(base), name, url: target };
        toast('Demo mode: showing the sample profile. Add a You.com key in Settings (and turn off demo mode) to analyze your real site.', 'info');
      }
    }

    const current = getState().company || {};
    const merged = { ...current };
    for (const [k, v] of Object.entries(profile)) {
      if (Array.isArray(v) ? v.length : v) merged[k] = v;
    }
    setState({ company: merged });
    return profile;
  });
}

// ============================================================== chat

function groundingContext() {
  const s = getState();
  const c = company();
  const threads = (s.threads || [])
    .filter((t) => t.status !== 'dismissed')
    .slice()
    .sort((a, b) => (b.relevance || 0) - (a.relevance || 0))
    .slice(0, 8);
  const drafts = s.drafts || [];
  const byStatus = drafts.reduce((m, d) => ({ ...m, [d.status]: (m[d.status] || 0) + 1 }), {});
  const pending = drafts.filter((d) => d.status === 'pending').slice(0, 5);
  const scheduled = drafts.filter((d) => d.status === 'scheduled').slice(0, 5);
  return `## Company
${companyBrief(c)}

## Top conversations (by relevance)
${threads.map((t, i) => `${i + 1}. [${t.id}] ${t.community || t.source} · relevance ${t.relevance} · intent ${t.intent} · status ${t.status} · pain "${t.painPoint}"
   "${clip(t.title, 120)}" — quote: "${clip(t.quote, 200)}"${t.author ? ` — by ${t.author}` : ''}
   ${t.url}`).join('\n') || 'None yet.'}

## Trending in the field
${(s.trends || []).slice(0, 6).map((t) => `- ${t.title} (${t.tag || t.source}, ${fmtWhen(t.publishedAt)}): ${clip(t.summary, 160)}`).join('\n') || 'None loaded.'}

## Founder events
${(s.events || []).slice(0, 6).map((e) => `- ${e.title} — ${fmtWhen(e.start)}, ${e.location || e.format}${e.host ? `, by ${e.host}` : ''}. ${clip(e.why, 140)} ${e.url || ''}`).join('\n') || 'None loaded.'}

## Drafts
Counts: ${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}
${pending.map((d) => `- pending ${d.kind}: "${clip(d.body, 100)}"`).join('\n')}
${scheduled.map((d) => `- scheduled ${d.kind} for ${fmtWhen(d.scheduledFor)}: "${clip(d.title || d.body, 80)}"`).join('\n')}`;
}

function chatSystem() {
  return `You are Lens, an assistant that helps a startup founder build a following and find early users.
Today is ${new Date().toDateString()}.
Ground every answer in the data below — name specific conversations (with their community and a short quote), pain points, events and drafts. If the data doesn't cover something, say so briefly.
Be concise and actionable: short paragraphs or a short list, then one clear next step inside Lens (Discover, Outreach, Studio, Schedule).
Lens never sends or posts anything without the founder approving it. LinkedIn in Lens is a demo integration.
Encourage helpful, non-spammy outreach with honest founder disclosure.

${groundingContext()}`;
}

function demoChatAnswer(message) {
  const s = getState();
  const c = company();
  const m = String(message || '').toLowerCase();
  const threads = (s.threads || []).filter((t) => t.status !== 'dismissed').slice().sort((a, b) => (b.relevance || 0) - (a.relevance || 0));
  const fresh = threads.filter((t) => t.status === 'new' || t.status === 'saved');
  const groups = new Map();
  for (const t of threads) if (t.painPoint) groups.set(t.painPoint, [...(groups.get(t.painPoint) || []), t]);
  const clusters = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const events = (s.events || []).slice().sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const pending = (s.drafts || []).filter((d) => d.status === 'pending');
  const scheduled = (s.drafts || []).filter((d) => d.status === 'scheduled');

  if (/event|meetup|conference|week|attend|go to/.test(m)) {
    if (!events.length) return 'No events are loaded yet. Hit Refresh on the Dashboard and I\'ll look for founder events this week.';
    return `Here's what's worth your time this week:\n\n${events.slice(0, 4).map((e) => `- **${e.title}** — ${fmtWhen(e.start)}, ${e.location || e.format}. ${e.why || ''}`).join('\n')}\n\nNext step: pick one and bring a concrete example of ${c.name} solving "${clusters[0]?.[0] || 'a real user problem'}" — it's an easy conversation starter.`;
  }
  if (/post|write|content|linkedin|publish|share/.test(m)) {
    const [label, list] = clusters[0] || [];
    if (!label) return 'Once Lens has found a few conversations, I\'ll suggest a post built on the pain point that comes up most. Try Discover first.';
    const q = list.find((t) => t.quote)?.quote;
    return `Post about **${label}** — it came up in ${list.length} conversation${list.length === 1 ? '' : 's'}${list[0]?.community ? `, including ${list[0].community}` : ''}.${q ? `\n\nOne line that captures it: "${clip(q, 180)}"` : ''}\n\nAngle: open with that frustration in your own words, share what actually helps (tools aside), disclose you're building ${c.name}, and end with a question.${clusters[1] ? ` Runner-up topic: **${clusters[1][0]}** (${clusters[1][1].length}).` : ''}\n\nNext step: open Studio and draft from "${label}".`;
  }
  if (/reply|who|dm|reach|outreach|lead|contact|talk to|respond/.test(m)) {
    const pick = (fresh.length ? fresh : threads).slice(0, 3);
    if (!pick.length) return 'There are no open conversations yet. Run a search in Discover and I\'ll tell you who to reply to first.';
    return `Start with these — they're the clearest fit and still uncontacted:\n\n${pick.map((t, i) => `${i + 1}. **${t.author || t.community}** in ${t.community} (relevance ${t.relevance}, ${t.intent} intent): "${clip(t.quote || t.snippet, 150)}"`).join('\n')}\n\nLead with a genuinely useful tip about their exact problem, then disclose you're the founder of ${c.name}. Next step: Discover → Draft reply on #1.`;
  }
  if (/trend|news|happening|industry/.test(m)) {
    const trends = (s.trends || []).slice(0, 4);
    if (!trends.length) return 'No trends are loaded yet — hit Refresh on the Dashboard.';
    return `What's moving in ${c.field || 'your field'}:\n\n${trends.map((t) => `- **${t.title}** — ${clip(t.summary, 140)}`).join('\n')}\n\nA quick take on one of these, tied to what your users are saying, makes an easy post.`;
  }
  if (/draft|pending|queue|approve|schedule/.test(m)) {
    return `You have ${pending.length} draft${pending.length === 1 ? '' : 's'} waiting for approval and ${scheduled.length} scheduled.${pending[0] ? `\n\nOldest pending: a ${pending[pending.length - 1].kind} — "${clip(pending[pending.length - 1].body, 120)}"` : ''}${scheduled[0] ? `\n\nNext scheduled: ${fmtWhen(scheduled[0].scheduledFor)}.` : ''}\n\nNext step: review them in Outreach (replies/DMs) or Schedule (posts).`;
  }
  const top = fresh[0] || threads[0];
  return `Here's where things stand for ${c.name}:\n\n- ${threads.length} conversations found${clusters[0] ? `; the biggest pain point is **${clusters[0][0]}** (${clusters[0][1].length})` : ''}.\n- ${pending.length} draft${pending.length === 1 ? '' : 's'} pending, ${scheduled.length} scheduled.\n- ${events.length} founder event${events.length === 1 ? '' : 's'} this week${events[0] ? ` — next: ${events[0].title}, ${fmtWhen(events[0].start)}` : ''}.${top ? `\n\nBest next move: reply to ${top.author || 'the author'} in ${top.community} — "${clip(top.quote || top.title, 120)}".` : ''}\n\nAsk me "what should I post?", "who should I reply to?" or "which events are worth it?"`;
}

export async function chat(message) {
  const text = String(message || '').trim();
  if (!text) return '';
  setState((s) => ({ chat: [...(s.chat || []), { role: 'user', content: text, at: nowIso() }] }));
  return withLoading('chat', async () => {
    await warm();
    let reply = '';
    if (canUseAI()) {
      try {
        const history = (getState().chat || []).slice(-16).map((m) => ({ role: m.role, content: m.content }));
        reply = await ai.complete({ system: chatSystem(), messages: history, maxTokens: 900 });
      } catch (e) {
        console.warn('[Lens] chat failed', e);
        if (e?.code === 'no-relay') toast(you.NO_RELAY_MESSAGE, 'info');
        else toast(`${aiName()} chat failed: ${e.message || e} — answering from your saved data instead.`, 'error');
      }
    }
    if (!reply) {
      await delay();
      reply = demoChatAnswer(text);
    }
    setState((s) => ({ chat: [...(s.chat || []), { role: 'assistant', content: reply, at: nowIso() }] }));
    return reply;
  });
}

// ============================================================== v2: onboarding chat

function onboardingState() {
  const o = getState().onboarding || {};
  return { ...o, step: o.step || 'url', url: o.url || '', transcript: Array.isArray(o.transcript) ? o.transcript : [], profileDraft: o.profileDraft || {} };
}

function patchOnboarding(patch) {
  setState((s) => ({ onboarding: { ...onboardingState(), ...(s.onboarding || {}), ...patch } }));
}

function mergeProfile(prev, next) {
  const out = { ...(prev || {}) };
  for (const [k, v] of Object.entries(next || {})) {
    if (Array.isArray(v)) {
      const clean = v.map((x) => String(x).trim()).filter(Boolean);
      if (clean.length) out[k] = [...new Set(clean)];
    } else if (typeof v === 'string' && v.trim()) {
      out[k] = v.trim();
    }
  }
  return out;
}

function splitList(text) {
  return String(text || '')
    .split(/,|;|\n|\band\b|\bor\b/i)
    .map((x) => x.replace(/^[\s\-•*]+|[\s.!]+$/g, '').trim())
    .filter((x) => x.length > 1)
    .slice(0, 6);
}

function script() {
  return demo?.onboardingScript || {};
}

function onboardingOpener(c) {
  if (typeof script().opener === 'function') return script().opener(c);
  return `I took a look at ${c.name || 'your site'}${c.tagline ? ` — "${c.tagline}"` : ''}${c.field ? `, in ${c.field}` : ''}. Who is it for? Describe the person who feels this problem most — their role, what they're trying to get done.`;
}

const SKIP_RE = /^\s*(skip|done|that'?s (it|all)|looks (good|right)|good enough|next)\b|^\s*(ok|okay)?\s*,?\s*(skip|done)\s*[.!]*\s*$/i;

function demoOnboardingTurn(message, transcript, draft, c) {
  const userTurns = transcript.filter((m) => m.role === 'user').length; // includes this message
  const msg = String(message || '').trim();
  const sc = script();
  const defaults = sc.defaults || {};
  if (SKIP_RE.test(msg)) {
    const profile = mergeProfile({
      audience: c.audience,
      pains: defaults.pains || (demo?.painPoints || []).slice(0, 4),
      channels: defaults.channels || ['r/3Dprinting', 'r/functionalprint', 'r/cad', 'Hacker News'],
      keywords: c.keywords || [],
      voice: c.voice,
    }, draft);
    const reply = typeof sc.skip === 'function' ? sc.skip(c) : `Got it — I've filled in the rest from what I learned about ${c.name}.`;
    return { reply, ready: true, profile };
  }
  if (userTurns <= 1) {
    const reply = typeof sc.askPains === 'function'
      ? sc.askPains(msg)
      : `Makes sense — ${clip(msg, 140)}. What do they struggle with most today?`;
    return { reply, ready: false, profile: { audience: msg } };
  }
  if (userTurns === 2) {
    const pains = splitList(msg);
    const list = pains.length ? pains : [clip(msg, 80)];
    const reply = typeof sc.askChannels === 'function'
      ? sc.askChannels(list)
      : 'Those are exactly the kinds of things Lens can listen for. Where do these people hang out online?';
    return {
      reply,
      ready: false,
      profile: { pains: list, keywords: [...new Set([...list.map((p) => p.toLowerCase()), ...(c.keywords || []).slice(0, 6)])].slice(0, 10) },
    };
  }
  const channels = splitList(msg);
  const chosen = channels.length ? channels : defaults.channels || [];
  const profile = mergeProfile(draft, { channels: chosen, voice: draft.voice || c.voice, audience: draft.audience || c.audience });
  const reply = typeof sc.ready === 'function'
    ? sc.ready({ channels: chosen, pains: profile.pains || [], voice: profile.voice })
    : `Perfect — your audience profile is ready.`;
  return { reply, ready: true, profile: { channels: chosen, voice: profile.voice, audience: profile.audience } };
}

export async function onboardingChat(message) {
  const text = String(message || '').trim();
  const c = company();
  const ob = onboardingState();
  if (!text && !ob.transcript.length) {
    const opener = onboardingOpener(c);
    patchOnboarding({ transcript: [{ role: 'assistant', content: opener, at: nowIso() }] });
    return { reply: opener, ready: false, profile: ob.profileDraft };
  }
  if (!text) return { reply: '', ready: false, profile: ob.profileDraft };

  const transcript = [...ob.transcript, { role: 'user', content: text, at: nowIso() }];
  patchOnboarding({ transcript });

  return withLoading('onboarding', async () => {
    await warm();
    let turn = null;
    if (canUseAI() && !SKIP_RE.test(text)) {
      try {
        const userCount = transcript.filter((m) => m.role === 'user').length;
        const out = await ai.json({
          system: `You are Lens, onboarding a startup founder. Learn their target audience, the audience's pains (in the audience's own words), where they hang out online, and the founder's voice — in at most 4 questions, ONE question per reply, friendly and brief (≤ 60 words). Build on what the founder already said; never repeat a question. Set ready=true once you know audience, pains and channels (or the founder says skip/done, or after the 4th answer). When ready, the reply summarizes the profile in one or two sentences and asks for nothing.`,
          prompt: `What Lens learned from the website:
${companyBrief(c)}

Profile so far: ${JSON.stringify(ob.profileDraft)}
Founder answers so far: ${userCount}

Conversation:
${transcript.map((m) => `${m.role === 'user' ? 'Founder' : 'Lens'}: ${m.content}`).join('\n')}`,
          schemaHint: '{"reply":"","ready":false,"profile":{"audience":"","pains":[""],"channels":[""],"keywords":[""],"voice":""}}',
          maxTokens: 900,
        });
        if (out && typeof out.reply === 'string' && out.reply.trim()) {
          turn = { reply: out.reply.trim(), ready: Boolean(out.ready) || userCount >= 5, profile: out.profile && typeof out.profile === 'object' ? out.profile : {} };
        }
      } catch (e) {
        console.warn('[Lens] onboarding chat failed', e);
        if (e?.code === 'no-relay') toast(you.NO_RELAY_MESSAGE, 'info');
        else toast(`${aiName()} is unavailable (${e.message || e}) — continuing with the guided questions.`, 'error');
      }
    }
    if (!turn) {
      await delay();
      turn = demoOnboardingTurn(text, transcript, ob.profileDraft, c);
    }
    const profile = mergeProfile(ob.profileDraft, turn.profile);
    setState((s) => ({
      onboarding: {
        ...onboardingState(),
        ...(s.onboarding || {}),
        transcript: [...transcript, { role: 'assistant', content: turn.reply, at: nowIso() }],
        profileDraft: profile,
      },
    }));
    return { reply: turn.reply, ready: turn.ready, profile };
  });
}

// ============================================================== v2: suggestions (swipe stack)

function nextFreeSlot(excludeId) {
  const used = new Set(
    (getState().drafts || [])
      .filter((d) => d.status === 'scheduled' && d.scheduledFor && d.id !== excludeId)
      .map((d) => Math.round(Date.parse(d.scheduledFor) / 60000)),
  );
  const minTime = Date.now() + 5 * 60000;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const candidates = [];
  for (let day = 0; day < 56; day++) {
    const d = new Date(start.getTime());
    d.setDate(start.getDate() + day);
    for (const slot of BEST_SLOTS) {
      if (d.getDay() !== slot.dow) continue;
      const at = new Date(d.getTime());
      at.setHours(slot.h, slot.m, 0, 0);
      if (at.getTime() > minTime) candidates.push(at);
    }
  }
  candidates.sort((a, b) => a - b);
  const free = candidates.find((at) => !used.has(Math.round(at.getTime() / 60000)));
  if (free) return free.toISOString();
  const fallback = new Date(Date.now() + 86400000);
  fallback.setMinutes(0, 0, 0);
  return fallback.toISOString();
}

function demoTrendPost(t, clusters, c, variant = 0) {
  const top = (clusters || [])[variant % Math.max(1, (clusters || []).length)];
  return {
    title: '',
    body: `${variant > 0 ? 'Still thinking about this one: ' : ''}${clip(t.title, 120)}\n\n${t.summary || ''}\n\nWhat I find interesting is what this means for people dealing with ${top ? top.painPoint.toLowerCase() : 'this problem'} every day.${top?.example ? ` One person put it like this: "${clip(top.example, 160)}"` : ''}\n\nI'm building ${c.name}${c.tagline ? ` — ${c.tagline.replace(/\.$/, '').toLowerCase()}` : ''}, so I watch this space closely. My bet: the tools that win will be the ones that remove a step, not add a feature.\n\nWhat's your read on it — does this change anything for how you work?`,
    visualIdea: `A simple chart or render that illustrates "${clip(t.title, 60)}"`,
    sculptexPrompt: demo?.sculptexDemoPrompt || '',
  };
}

export async function generateSuggestions({ count = 5 } = {}) {
  return withLoading('suggestions', async () => {
    await warm();
    const c = company();
    const threads = getState().threads || [];
    const clusters = await clusterPainPoints();
    const trends = (getState().trends || []).slice(0, 3);
    const n = Math.max(1, Math.min(10, Number(count) || 5));
    const trendSlots = trends.length ? Math.min(trends.length, Math.max(1, Math.round(n / 4))) : 0;
    const sources = [
      ...clusters.slice(0, n - trendSlots).map((cl) => ({ type: 'pain', label: cl.painPoint, threadIds: cl.threadIds.slice(0, 6), cluster: cl })),
      ...trends.slice(0, trendSlots).map((t) => ({ type: 'trend', label: t.title, threadIds: [], trend: t })),
    ];
    while (sources.length < n && clusters.length) {
      const cl = clusters[sources.length % clusters.length];
      sources.push({ type: 'pain', label: cl.painPoint, threadIds: cl.threadIds.slice(0, 6), cluster: cl, alt: true });
    }
    if (!sources.length) sources.push({ type: 'pain', label: c.keywords?.[0] ? titleCase(c.keywords[0]) : 'What we keep hearing', threadIds: [] });
    const final = sources.slice(0, n);

    let posts = null;
    if (canUseAI()) {
      try {
        const brief = final.map((src, i) => {
          if (src.type === 'trend') return `${i}. TREND: ${src.trend.title} — ${clip(src.trend.summary, 200)}`;
          const qs = src.threadIds.map((id) => threads.find((t) => t.id === id)).filter(Boolean).slice(0, 3).map((t) => `"${clip(t.quote || t.snippet, 180)}" (${t.community})`);
          return `${i}. PAIN POINT: ${src.label} (${src.cluster?.count || qs.length} conversations)${src.alt ? ' — use a different angle than any earlier post on this pain point' : ''}\n   ${qs.join('\n   ')}`;
        }).join('\n');
        const out = await ai.json({
          system: `You ghostwrite LinkedIn posts for the founder of ${c.name}. Voice: ${c.voice || 'warm, direct, plain language'}.\n${POST_RULES}`,
          prompt: `${companyBrief(c)}

Write one post for EACH numbered source below (${final.length} posts, same order). For each also give a one-line visual idea and a one-sentence Sculptex prompt describing an exact 3D-printable part that fits the post ("" if none fits).

${brief}`,
          schemaHint: '[{"i":0,"title":"","body":"","visualIdea":"","sculptexPrompt":""}]',
          maxTokens: 900 * final.length,
          effort: 'medium',
        });
        const list = Array.isArray(out) ? out : [];
        posts = final.map((src, i) => {
          const hit = list.find((x) => x?.i === i) || list[i];
          const p = hit ? normalizePost(hit, src.label) : null;
          return p && countWords(p.body) >= 60 ? p : null;
        });
        if (!posts.some(Boolean)) posts = null;
      } catch (e) {
        fallbackToast(`Generating posts with ${aiName()}`, e);
      }
    }

    const fresh = [];
    const base = Date.now();
    // How often each topic was already suggested, so "Generate more" takes a new angle instead of repeating itself.
    const seen = new Map();
    for (const d of getState().drafts || []) {
      if (d && d.kind === 'post' && d.source?.label) seen.set(d.source.label, (seen.get(d.source.label) || 0) + 1);
    }
    for (let i = 0; i < final.length; i++) {
      const src = final[i];
      let p = posts?.[i] || null;
      if (!p) {
        const variant = seen.get(src.label) || 0;
        seen.set(src.label, variant + 1);
        if (src.type === 'trend') {
          p = demoTrendPost(src.trend, clusters, c, variant);
        } else {
          const related = src.threadIds.map((id) => threads.find((t) => t.id === id)).filter(Boolean);
          p = demoPost(src.label, related.length ? related : threads, c, variant);
        }
      }
      const at = new Date(base - i * 1000).toISOString();
      fresh.push({
        id: uid('d'),
        kind: 'post',
        title: p.title,
        body: p.body,
        status: 'pending',
        createdAt: at,
        updatedAt: at,
        channel: 'linkedin',
        painPoint: src.type === 'pain' ? src.label : undefined,
        source: { type: src.type, label: src.label, threadIds: src.threadIds },
        visualIdea: p.visualIdea,
        sculptexPrompt: p.sculptexPrompt,
      });
    }
    if (!posts) await delay();
    addDrafts(fresh);
    return fresh;
  });
}

export function approveSuggestion(id) {
  findDraft(id);
  const slot = nextFreeSlot(id);
  notifiedDue.delete(id);
  updateDraft(id, { status: 'scheduled', scheduledFor: slot, error: '' });
  return slot;
}

export function declineSuggestion(id) {
  findDraft(id);
  return updateDraft(id, { status: 'rejected' });
}

export function undoSuggestion(id, prevStatus = 'pending') {
  const d = findDraft(id);
  const patch = { status: prevStatus || 'pending' };
  if (patch.status !== 'scheduled' && d.status === 'scheduled') patch.scheduledFor = undefined;
  return updateDraft(id, patch);
}

// ============================================================== v2: idea chat

const REFINE_RE = /\b(short|concise|tight|trim|brief|warm|friendl|personal|question|specific|detail|concrete|hook|casual|formal|professional|pitch|salesy|hashtag|refine|tweak|change|edit|rewrite)/i;

function lastProposal(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant' && history[i].proposal?.body) return { proposal: history[i].proposal, index: i };
  }
  return null;
}

function demoIdeaTurn(text, history, c) {
  const last = lastProposal(history);
  // Refine the current proposal when the founder asks for a change to it.
  if (last && REFINE_RE.test(text) && countWords(text) <= 25) {
    const ins = /personal/i.test(text) ? `${text} warmer` : text;
    const r = demoRewrite(last.proposal.body, ins, { painPoint: '' });
    if (r.changed) {
      return {
        reply: 'Updated — here\'s the revised version. Add it to your stack, or keep tweaking.',
        proposal: { ...last.proposal, body: r.body },
      };
    }
    return {
      reply: 'In demo mode I can make it shorter, warmer, more specific, change the hook, or end on a question. Which one?',
      proposal: null,
    };
  }
  // The idea so far = everything the founder said since the last proposal.
  const since = history.slice(last ? last.index + 1 : 0).filter((m) => m.role === 'user').map((m) => m.content);
  // Drop throwaway openers ("a post", "idea:") once the founder has said something substantial.
  const substantial = since.filter((m) => countWords(m) >= 4);
  const idea = (substantial.length ? substantial : since).join(' ').trim() || text;
  if (since.length <= 1 && countWords(idea) < 8) {
    return {
      reply: `"${clip(text, 80)}" — good start. Who is it for, and what's the one thing you want them to take away? A concrete example or story makes it land.`,
      proposal: null,
    };
  }
  return {
    reply: 'Here\'s a first version shaped as a LinkedIn post. Add it to your stack, or tell me what to change (shorter, warmer, more specific, a different hook…).',
    proposal: demoIdeaPost(idea, c),
  };
}

function demoIdeaPost(text, c) {
  const clusters = (getState().threads || []).filter((t) => t.painPoint);
  const relatedThread = clusters.find((t) => words(text).some((w) => w.length > 4 && `${t.title} ${t.snippet} ${t.painPoint}`.toLowerCase().includes(w)));
  const idea = clip(String(text || '').replace(/\s+/g, ' '), 200);
  const hook = clip(sentences(text)[0] || idea, 90).replace(/[.…]+$/, '');
  const body = `${hook}.\n\n${idea}${relatedThread ? `\n\nI keep seeing this in conversations — someone on ${relatedThread.community} wrote: "${clip(relatedThread.quote || relatedThread.snippet, 150)}"` : ''}\n\nHere's what I've learned building ${c.name}: the problem is rarely the tool itself — it's the gap between what you have in your head and what the tool makes you do first. Close that gap and people move faster than they expect.\n\nFull disclosure: that gap is exactly what we're working on at ${c.name}.\n\nHave you run into this? What did you do about it?`;
  return {
    title: '',
    body,
    visualIdea: relatedThread ? `A render of the part that solves "${relatedThread.painPoint}"` : 'A clean product shot or a before/after',
    sculptexPrompt: demo?.sculptexDemoPrompt || '',
  };
}

export async function ideaChat(message) {
  const text = String(message || '').trim();
  if (!text) return { reply: '', proposal: null };
  setState((s) => ({ ideaChat: [...(s.ideaChat || []), { role: 'user', content: text, at: nowIso() }] }));
  return withLoading('ideaChat', async () => {
    await warm();
    const c = company();
    const history = getState().ideaChat || [];
    let turn = null;
    if (canUseAI()) {
      try {
        const out = await ai.json({
          system: `You help the founder of ${c.name} turn a rough idea into a LinkedIn post. Ask at most one short clarifying question if the idea is too vague; otherwise propose a full post. Keep replies brief (≤ 50 words).\n${POST_RULES}`,
          prompt: `${companyBrief(c)}

Recent pain points from real conversations: ${(await clusterPainPoints()).slice(0, 4).map((cl) => `${cl.painPoint} (${cl.count})`).join(', ') || 'none yet'}

Conversation:
${history.slice(-12).map((m) => `${m.role === 'user' ? 'Founder' : 'Lens'}: ${m.content}${m.proposal ? `\n[Proposed post: ${clip(m.proposal.body, 400)}]` : ''}`).join('\n')}

Return the reply and, when you have a post (new or refined), the proposal; else proposal null.`,
          schemaHint: '{"reply":"","proposal":{"title":"","body":"","visualIdea":"","sculptexPrompt":""}}',
          maxTokens: 1400,
          effort: 'medium',
        });
        if (out && typeof out.reply === 'string') {
          const proposal = out.proposal && out.proposal.body ? normalizePost(out.proposal, 'Your idea') : null;
          turn = { reply: out.reply.trim() || (proposal ? 'Here\'s a draft.' : ''), proposal };
        }
      } catch (e) {
        console.warn('[Lens] idea chat failed', e);
        if (e?.code === 'no-relay') toast(you.NO_RELAY_MESSAGE, 'info');
        else toast(`${aiName()} is unavailable (${e.message || e}) — using a template instead.`, 'error');
      }
    }
    if (!turn) {
      await delay();
      turn = demoIdeaTurn(text, history, c);
    }
    setState((s) => ({
      ideaChat: [...(s.ideaChat || []), { role: 'assistant', content: turn.reply, at: nowIso(), ...(turn.proposal ? { proposal: turn.proposal } : {}) }],
    }));
    return turn;
  });
}

export function addIdeaToStack(proposal) {
  const p = normalizePost(proposal || {}, 'Your idea');
  if (!p.body) throw new Error('That proposal has no text yet.');
  const at = nowIso();
  const draft = {
    id: uid('d'),
    kind: 'post',
    title: p.title,
    body: p.body,
    status: 'pending',
    createdAt: at,
    updatedAt: at,
    channel: 'linkedin',
    source: { type: 'idea', label: p.title || clip(p.body.split('\n')[0], 80), threadIds: [] },
    visualIdea: p.visualIdea,
    sculptexPrompt: p.sculptexPrompt,
  };
  addDrafts([draft]);
  return draft;
}

// ============================================================== v2: design tool (MOCK, session-only)

export async function connectDesignTool(tool) {
  const t = tool === 'figma' ? 'figma' : 'canva';
  patchConnection('design', { tool: t, status: 'connecting', account: null });
  await delay(700, 900);
  const p = demo?.linkedinProfile || {};
  const acc = demo?.designAccounts?.[t];
  const account = acc?.name
    ? `${acc.name} · ${acc.owner || p.name || 'Founder'} (${t === 'figma' ? 'Figma' : 'Canva'} demo)`
    : `${p.name || 'Founder'} · ${company().name || 'Team'} (${t === 'figma' ? 'Figma' : 'Canva'} demo)`;
  patchConnection('design', { tool: t, status: 'connected', account });
  toast(`${t === 'figma' ? 'Figma' : 'Canva'} (demo) connected.`, 'success');
  return { tool: t, status: 'connected', account };
}

export async function disconnectDesignTool() {
  patchConnection('design', { tool: null, status: 'disconnected', account: null });
  return null;
}

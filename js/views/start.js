// #/start — the first-run flow, rendered full-screen WITHOUT the app shell.
// Steps (persisted in state.onboarding.step so an OAuth redirect resumes in place):
//   url → scanning (two glass lenses) → audience (chat) → connect → swipe (first posts)
import { html, useState, useEffect, useMemo, useRef, useCallback } from '../lib.js';
import { useStore, getState, setState, toast } from '../store.js';
import { navigate } from '../router.js';
import { Button, Badge, Icon, Spinner, SOURCE_META, hostname, cx } from '../ui.js';
import {
  analyzeProduct,
  findConversations,
  onboardingChat,
  generateSuggestions,
  connectDesignTool,
  disconnectDesignTool,
  connectLinkedIn,
  disconnectLinkedIn,
} from '../services/lens.js';
import * as mcp from '../services/mcp.js';
import { demo } from '../demo-data.js';
import { SwipeStack } from './stack.js';
import { LinkedInAvatar, useProfile } from './studio.js';

// ---------------------------------------------------------------------------
// constants

export const START_STEPS = [
  { id: 'url', label: 'Your product' },
  { id: 'scanning', label: 'Scanning' },
  { id: 'audience', label: 'Audience' },
  { id: 'connect', label: 'Connect' },
  { id: 'swipe', label: 'First posts' },
];
const STEP_IDS = START_STEPS.map((s) => s.id);

const DEMO_URL = (demo && demo.company && demo.company.url) || 'https://sculptex-git-main-jacksonschorr.vercel.app';
const DEMO_HOST = hostname(DEMO_URL);
const MIN_SCAN_MS = 4500;
const STATUS_MS = 1700;
const AUTO_ADVANCE_MS = 4000;

const COMMUNITY_URLS = [
  { text: 'reddit.com/r/3Dprinting', source: 'reddit' },
  { text: 'news.ycombinator.com', source: 'hackernews' },
  { text: 'x.com', source: 'x' },
  { text: 'linkedin.com', source: 'linkedin' },
  { text: 'indiehackers.com', source: 'indiehackers' },
  { text: 'producthunt.com', source: 'producthunt' },
  { text: 'youtube.com', source: 'youtube' },
  { text: 'reddit.com/r/functionalprint', source: 'reddit' },
  { text: 'reddit.com/r/startups', source: 'reddit' },
  { text: 'discord.com', source: 'web' },
];
const FALLBACK_QUOTES = [
  'is there a tool that just…',
  'I spent three hours on this',
  'anyone else stuck on',
  'honestly would pay for this',
  'how do you all handle',
  'nothing I tried actually works',
];
const GLYPH_SOURCES = ['reddit', 'hackernews', 'x', 'linkedin', 'indiehackers', 'producthunt'];
const EXTRA_COLORS = { youtube: '#FF0033' };

const PROFILE_FIELDS = [
  { key: 'audience', label: 'Audience', icon: 'users', type: 'text' },
  { key: 'pains', label: 'Pains', icon: 'flame', type: 'quotes' },
  { key: 'channels', label: 'Where they hang out', icon: 'globe', type: 'chips' },
  { key: 'keywords', label: 'Keywords', icon: 'hash', type: 'chips' },
  { key: 'voice', label: 'Voice', icon: 'message', type: 'text' },
];

// ---------------------------------------------------------------------------
// helpers

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clip(text, n) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

function uniq(list) {
  const out = [];
  const seen = new Set();
  for (const x of list || []) {
    const s = String(x || '').trim();
    const k = s.toLowerCase();
    if (s && !seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

function lowerFirst(text) {
  const t = String(text || '');
  // Keep acronyms / proper nouns that start with two capitals ("AI founders", "CAD users").
  return /^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

function hasValue(v) {
  return Array.isArray(v) ? v.length > 0 : Boolean(v && String(v).trim());
}

// 'Sculptex.com/' → 'https://sculptex.com' ; returns '' when it can't be a URL.
export function normalizeProductUrl(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, '');
  if (!s) return '';
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`;
  try {
    const u = new URL(withProto);
    if (!/^https?:$/.test(u.protocol)) return '';
    const host = u.hostname;
    if (!host || (!host.includes('.') && host !== 'localhost')) return '';
    if (/\.$/.test(host) || /\.\./.test(host)) return '';
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return '';
  }
}

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function patchOnboarding(patch) {
  setState((s) => ({
    onboarding: { step: 'url', url: '', transcript: [], profileDraft: {}, ...(s.onboarding || {}), ...patch },
  }));
}

function goStep(step) {
  patchOnboarding({ step });
}

// Seeded PRNG so the floating layer is identical in every copy (outside + inside each lens).
function seeded(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sourceColor(source) {
  return EXTRA_COLORS[source] || (SOURCE_META[source] || SOURCE_META.web).color;
}

// Everything that drifts across the scanning page.
function buildFloatItems(host, quotes) {
  const rnd = seeded(host || 'lens');
  const pieces = [];
  const own = host || 'your-product.com';
  pieces.push({ kind: 'url', text: own, own: true, depth: 2 });
  pieces.push({ kind: 'url', text: own, own: true, depth: 0 });
  COMMUNITY_URLS.forEach((u, i) => pieces.push({ kind: 'url', text: u.text, color: sourceColor(u.source), depth: i % 3 }));
  const qs = uniq(quotes).slice(0, 6);
  (qs.length >= 3 ? qs : FALLBACK_QUOTES).slice(0, 6).forEach((q, i) => pieces.push({ kind: 'quote', text: clip(q, 44), depth: 1 + (i % 2) }));
  GLYPH_SOURCES.forEach((s, i) => {
    const meta = SOURCE_META[s] || SOURCE_META.web;
    pieces.push({ kind: 'glyph', text: meta.glyph || '•', color: meta.color, depth: (i + 1) % 3 });
  });
  for (let i = 0; i < 7; i++) pieces.push({ kind: 'sparkle', depth: i % 3 });
  for (let i = 0; i < 8; i++) pieces.push({ kind: 'dot', depth: i % 3 });

  // Interleave kinds a little, then spread across lanes with the golden ratio.
  const order = pieces.map((p, i) => ({ p, k: rnd() + (p.own ? -0.5 : 0) + i * 0.001 })).sort((a, b) => a.k - b.k).map((x) => x.p);
  const DUR = [
    [44, 56],
    [30, 38],
    [20, 26],
  ];
  return order.map((p, i) => {
    const [lo, hi] = DUR[p.depth];
    const dur = lo + rnd() * (hi - lo);
    return {
      ...p,
      id: `f${i}`,
      y: 5 + ((i * 0.6180339887 + rnd() * 0.08) % 1) * 84,
      x: 2 + rnd() * 84,
      dur: Math.round(dur * 10) / 10,
      delay: -Math.round(rnd() * dur * 10) / 10,
      bob: Math.round((5 + rnd() * 5) * 10) / 10,
      bobDelay: -Math.round(rnd() * 6 * 10) / 10,
    };
  });
}

// ---------------------------------------------------------------------------
// shared chrome

function LensMark({ size = 22 }) {
  return html`<svg className="start-mark" width=${size} height=${size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <circle cx="12" cy="16" r="8.5" fill="none" stroke="currentColor" strokeWidth="2.4" />
    <circle cx="20" cy="16" r="8.5" fill="none" stroke="currentColor" strokeWidth="2.4" opacity="0.55" />
  </svg>`;
}

function StartHeader({ step }) {
  const idx = Math.max(0, STEP_IDS.indexOf(step));
  return html`<header className="start-header">
    <div className="start-wordmark" aria-label="Lens">
      <span className="start-wordmark-badge"><${LensMark} size=${20} /></span>
      <span className="start-wordmark-text">Lens</span>
    </div>
    <ol className="start-dots" aria-label=${`Step ${idx + 1} of ${START_STEPS.length}: ${START_STEPS[idx].label}`}>
      ${START_STEPS.map(
        (s, i) => html`<li
          key=${s.id}
          className=${cx('start-dot', i < idx && 'is-done', i === idx && 'is-current')}
          aria-current=${i === idx ? 'step' : undefined}
          title=${s.label}
        ><span className="sr-only">${s.label}${i < idx ? ' (done)' : ''}</span></li>`
      )}
    </ol>
    <div className="start-stepname" aria-hidden="true">
      <span className="start-stepname-n">${idx + 1}/${START_STEPS.length}</span>
      <span>${START_STEPS[idx].label}</span>
    </div>
  </header>`;
}

function StepFooter({ onBack, backLabel = 'Back', children }) {
  return html`<div className="start-footer">
    ${onBack ? html`<${Button} variant="ghost" icon="chevronLeft" onClick=${onBack}>${backLabel}<//>` : html`<span></span>`}
    <div className="start-footer-right">${children}</div>
  </div>`;
}

// ---------------------------------------------------------------------------
// step 1 — url

function UrlStep({ ob }) {
  const [value, setValue] = useState(() => (ob.url ? ob.url.replace(/^https?:\/\//, '') : ''));
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  const submit = (e) => {
    if (e) e.preventDefault();
    const url = normalizeProductUrl(value);
    if (!url) {
      setError(value.trim() ? 'That doesn’t look like a web address — try something like yourproduct.com' : 'Paste your product URL to get started.');
      if (inputRef.current) inputRef.current.focus();
      return;
    }
    setState((s) => ({
      onboarding: {
        ...(s.onboarding || {}),
        step: 'scanning',
        url,
        transcript: [],
        profileDraft: {},
        ready: false,
        suggestedFor: '',
      },
    }));
  };

  const trySculptex = () => {
    setValue(DEMO_HOST);
    setError('');
    if (inputRef.current) inputRef.current.focus();
  };

  return html`<section className="start-url-step">
    <div className="start-hero-lenses" aria-hidden="true">
      <span className="start-hero-lens start-hero-lens--a"></span>
      <span className="start-hero-lens start-hero-lens--b"></span>
    </div>
    <h1 className="start-title" tabIndex=${-1}>Find the people who need what you built.</h1>
    <p className="start-lede">
      Paste your product URL. Lens reads it, listens to the communities where your users talk, and drafts your first posts. Nothing goes out without your approval.
    </p>
    <form className=${cx('start-url', error && 'has-error')} onSubmit=${submit} noValidate>
      <label className="sr-only" htmlFor="start-url-input">Your product URL</label>
      <span className="start-url-icon" aria-hidden="true"><${Icon} name="globe" size=${18} /></span>
      <input
        id="start-url-input"
        ref=${inputRef}
        data-autofocus="true"
        className="start-url-input"
        type="text"
        inputMode="url"
        autoComplete="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck=${false}
        placeholder="Paste your product URL"
        value=${value}
        aria-invalid=${error ? 'true' : undefined}
        aria-describedby="start-url-hint"
        onChange=${(e) => {
          setValue(e.target.value);
          if (error) setError('');
        }}
      />
      <button type="submit" className="start-url-go" aria-label="Scan this URL" disabled=${!value.trim()}>
        <${Icon} name="arrowRight" size=${20} strokeWidth=${2} />
      </button>
    </form>
    <p id="start-url-hint" className=${error ? 'start-url-error' : 'start-url-hint'} role=${error ? 'alert' : undefined}>
      ${error || html`e.g. <span className="start-mono">${DEMO_HOST}</span>`}
    </p>
    <button type="button" className="start-try" onClick=${trySculptex}>
      <${Icon} name="sparkles" size=${14} />
      <span>Try with Sculptex</span>
    </button>
    <p className="start-fineprint">Runs in your browser — no account, no database.</p>
  </section>`;
}

// ---------------------------------------------------------------------------
// step 2 — scanning (two glass lenses)

let scanRun = null; // { url, promise } — survives a remount so a scan never runs twice

function runScan(url) {
  if (scanRun && scanRun.url === url) return scanRun.promise;
  const started = Date.now();
  const promise = (async () => {
    // Analyse first: findConversations() reads company() from the store, so it must run after the
    // new product's profile (keywords, field, audience) has been written — not the previous one.
    const [analysis] = await Promise.allSettled([analyzeProduct(url)]);
    const [convos] = await Promise.allSettled([findConversations()]);
    const wait = MIN_SCAN_MS - (Date.now() - started);
    if (wait > 0) await sleep(wait);
    return { analysis, convos };
  })();
  const entry = { url, promise };
  scanRun = entry;
  promise.finally(() => {
    if (scanRun === entry) scanRun = null;
  });
  return promise;
}

function Piece({ it }) {
  switch (it.kind) {
    case 'url':
      return html`<span className=${cx('stx-chip', it.own && 'stx-chip--own')}>
        ${it.own
          ? html`<${Icon} name="globe" size=${12} strokeWidth=${2} />`
          : html`<span className="stx-chip-dot" style=${{ background: it.color }}></span>`}
        <span>${it.text}</span>
      </span>`;
    case 'quote':
      return html`<span className="st-quote">“${it.text}”</span>`;
    case 'glyph':
      return html`<span className="st-glyph" style=${{ background: it.color }}>${it.text}</span>`;
    case 'sparkle':
      return html`<svg className="st-sparkle" viewBox="0 0 24 24" width="16" height="16" focusable="false">
        <path d="M12 1.5c.7 5.2 3.3 8.4 10.5 10.5-7.2 2.1-9.8 5.3-10.5 10.5-.7-5.2-3.3-8.4-10.5-10.5C8.7 9.9 11.3 6.7 12 1.5z" />
      </svg>`;
    default:
      return html`<span className="stx-dot"></span>`;
  }
}

function FloatLayer({ items, variant }) {
  return html`<div className=${cx('st-float', `st-float--${variant}`)} aria-hidden="true">
    ${items.map(
      (it) => html`<div
        key=${it.id}
        className=${cx('st-item', `st-d${it.depth}`)}
        style=${{ top: `${it.y}%`, '--x': `${it.x}%`, '--dur': `${it.dur}s`, '--delay': `${it.delay}s` }}
      >
        <div className="st-bob" style=${{ '--bob': `${it.bob}s`, '--bob-delay': `${it.bobDelay}s` }}>
          <div className=${cx('st-piece', `st-piece--${it.kind}`)}><${Piece} it=${it} /></div>
        </div>
      </div>`
    )}
  </div>`;
}

function GlareArc() {
  return html`<svg className="st-glare-arc" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <path d="M17 58 A34 34 0 0 1 52 16" fill="none" stroke="url(#st-glare-grad)" strokeWidth="2.6" strokeLinecap="round" />
    <path d="M78 66 A31 31 0 0 1 66 80" fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="1.4" strokeLinecap="round" />
  </svg>`;
}

function LensView({ which, items }) {
  return html`<div className=${cx('st-lens', `st-lens--${which}`, 'st-lens-view')}>
    <div className="st-lens-shift">
      <${FloatLayer} items=${items} variant="mag" />
    </div>
  </div>`;
}

function LensGlass({ which }) {
  return html`<div className=${cx('st-lens', `st-lens--${which}`, 'st-lens-glass')}>
    <div className="st-lens-rimblur"></div>
    <div className="st-lens-tint"></div>
    <div className="st-lens-ring"></div>
    <div className="st-lens-glare"><${GlareArc} /><span className="st-lens-spec"></span></div>
  </div>`;
}

function ScanningStep({ ob }) {
  const url = ob.url || '';
  const host = hostname(url) || 'your site';
  const quotes = useStore((s) => (s.threads || []).map((t) => t.quote).filter(Boolean).slice(0, 8));
  // Freeze the floating layer for this scan so every copy stays identical.
  const items = useMemo(() => buildFloatItems(host, quotes), [host]);
  const messages = useMemo(
    () => [`Reading ${clip(host, 34)}…`, 'Understanding what you build…', 'Listening to communities…', 'Spotting pain points…', 'Ranking the best conversations…'],
    [host]
  );
  const [msgIdx, setMsgIdx] = useState(0);

  useEffect(() => {
    const iv = setInterval(() => setMsgIdx((i) => (i + 1 < messages.length ? i + 1 : 2)), STATUS_MS);
    return () => clearInterval(iv);
  }, [messages]);

  useEffect(() => {
    if (!url) {
      goStep('url');
      return undefined;
    }
    runScan(url).then(({ analysis, convos }) => {
      const failed = [analysis, convos].filter((r) => r.status === 'rejected');
      if (failed.length) {
        const why = failed.map((r) => (r.reason && r.reason.message) || String(r.reason)).join('; ');
        toast(`Scanning hit a snag (${clip(why, 120)}) — continuing with what Lens could find.`, 'error');
      }
      const now = getState().onboarding || {};
      if (now.step === 'scanning' && now.url === url) patchOnboarding({ step: 'audience' });
    });
    return undefined;
  }, [url]);

  return html`<section className="st-scan" aria-labelledby="st-scan-title">
    <svg width="0" height="0" className="st-defs" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="st-glare-grad" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.45" stopColor="#fff" stopOpacity="0.95" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.1" />
        </linearGradient>
      </defs>
    </svg>
    <div className="st-stage">
      <${FloatLayer} items=${items} variant="back" />
      <${LensView} which="a" items=${items} />
      <${LensView} which="b" items=${items} />
      <${LensGlass} which="a" />
      <${LensGlass} which="b" />
    </div>
    <div className="st-caption">
      <h1 id="st-scan-title" className="st-title" tabIndex=${-1}>Focusing on <span className="st-host">${host}</span></h1>
      <p className="st-status" aria-live="polite">
        <span key=${msgIdx} className="st-status-text">${messages[msgIdx]}</span>
      </p>
      <div className="stx-progress" aria-hidden="true"><span></span></div>
      <button type="button" className="start-textlink" onClick=${() => goStep('url')}>Use a different URL</button>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// step 3 — audience chat

function ProfileValue({ field, value }) {
  if (!hasValue(value)) {
    return html`<div className="start-profile-empty"><span></span>Listening…</div>`;
  }
  if (field.type === 'text') return html`<p className="start-profile-text">${value}</p>`;
  const list = Array.isArray(value) ? value : [value];
  if (field.type === 'quotes') {
    return html`<ul className="start-profile-quotes">
      ${list.slice(0, 5).map((v, i) => html`<li key=${i}>${v}</li>`)}
    </ul>`;
  }
  return html`<div className="start-profile-chips">
    ${list.slice(0, 10).map((v, i) => html`<span key=${i} className="start-chip">${v}</span>`)}
  </div>`;
}

function ProfileCard({ profile, company, collapsed, onToggle }) {
  const filled = PROFILE_FIELDS.filter((f) => hasValue(profile[f.key])).length;
  return html`<aside className=${cx('start-profile', collapsed && 'is-collapsed')} aria-label="Audience profile">
    <button type="button" className="start-profile-head" onClick=${onToggle} aria-expanded=${collapsed ? 'false' : 'true'}>
      <span className="start-profile-title"><${Icon} name="target" size=${16} /> Audience profile</span>
      <span className="start-profile-count">${filled}/${PROFILE_FIELDS.length}</span>
      <span className="start-profile-caret"><${Icon} name="chevronDown" size=${16} /></span>
    </button>
    <div className="start-profile-meter" aria-hidden="true"><span style=${{ width: `${(filled / PROFILE_FIELDS.length) * 100}%` }}></span></div>
    <div className="start-profile-body">
      ${company && (company.name || company.tagline)
        ? html`<div className="start-profile-co">
            <div className="start-profile-co-name">${company.name || hostname(company.url)}</div>
            ${company.tagline ? html`<div className="start-profile-co-tag">${company.tagline}</div>` : null}
            ${company.field ? html`<${Badge} tone="accent">${company.field}<//>` : null}
          </div>`
        : null}
      ${PROFILE_FIELDS.map(
        (f) => html`<div key=${f.key} className=${cx('start-profile-field', hasValue(profile[f.key]) && 'is-filled')}>
          <div className="start-profile-label">
            <${Icon} name=${hasValue(profile[f.key]) ? 'check' : f.icon} size=${13} strokeWidth=${2} />
            ${f.label}
          </div>
          <div key=${JSON.stringify(profile[f.key] || '')} className="start-profile-value">
            <${ProfileValue} field=${f} value=${profile[f.key]} />
          </div>
        </div>`
      )}
    </div>
  </aside>`;
}

function Bubble({ msg }) {
  const mine = msg.role === 'user';
  return html`<div className=${cx('start-msg', mine ? 'start-msg--me' : 'start-msg--ai')}>
    ${mine ? null : html`<span className="start-msg-avatar" aria-hidden="true"><${LensMark} size=${16} /></span>`}
    <div className="start-msg-bubble">
      <span className="sr-only">${mine ? 'You: ' : 'Lens: '}</span>
      ${msg.content}
    </div>
  </div>`;
}

function AudienceStep({ ob }) {
  const transcript = Array.isArray(ob.transcript) ? ob.transcript : [];
  const profile = ob.profileDraft || {};
  const ready = Boolean(ob.ready);
  const company = useStore((s) => s.company) || {};
  const loading = useStore((s) => Boolean(s.ui && s.ui.loading && s.ui.loading.onboarding));
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [armed, setArmed] = useState(false);
  const [secs, setSecs] = useState(AUTO_ADVANCE_MS / 1000);
  const [collapsed, setCollapsed] = useState(true);
  const opened = useRef(false);
  const logRef = useRef(null);
  const inputRef = useRef(null);
  const thinking = sending || loading || transcript.length === 0;
  const userTurns = transcript.filter((m) => m.role === 'user').length;

  const advance = useCallback(() => {
    setArmed(false);
    goStep('connect');
  }, []);
  const advanceRef = useRef(advance);
  advanceRef.current = advance;

  // AI opens the conversation with what it learned from the URL.
  useEffect(() => {
    if (opened.current || transcript.length) return;
    opened.current = true;
    onboardingChat('').catch((e) => toast(e.message || String(e), 'error'));
  }, [transcript.length]);

  // Keep the newest message in view (scroll the log only, never the page).
  useEffect(() => {
    const log = logRef.current;
    if (!log) return undefined;
    const raf = requestAnimationFrame(() => {
      try {
        log.scrollTo({ top: log.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      } catch {
        log.scrollTop = log.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [transcript.length, thinking, ready]);

  // Auto-advance 4s after the profile is ready — unless the founder starts typing.
  useEffect(() => {
    if (!armed) return undefined;
    const started = Date.now();
    setSecs(Math.ceil(AUTO_ADVANCE_MS / 1000));
    const iv = setInterval(() => setSecs(Math.max(1, Math.ceil((AUTO_ADVANCE_MS - (Date.now() - started)) / 1000))), 200);
    const to = setTimeout(() => advanceRef.current(), AUTO_ADVANCE_MS);
    return () => {
      clearInterval(iv);
      clearTimeout(to);
    };
  }, [armed]);

  // Auto-grow the composer.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const send = async (raw) => {
    const msg = String(raw !== undefined ? raw : text).trim();
    if (!msg || sending) return;
    setText('');
    setArmed(false);
    setSending(true);
    patchOnboarding({ ready: false });
    try {
      const res = await onboardingChat(msg);
      const isReady = Boolean(res && res.ready);
      patchOnboarding({ ready: isReady });
      if (isReady) setArmed(true);
    } catch (e) {
      toast(`Lens couldn’t reply: ${e.message || e}`, 'error');
    } finally {
      setSending(false);
      if (inputRef.current) inputRef.current.focus({ preventScroll: true });
    }
  };

  const skip = () => {
    const s = getState();
    const c = s.company || {};
    const threads = (s.threads || []).filter((t) => t.status !== 'dismissed');
    const defaults = {
      audience: c.audience || '',
      pains: uniq(threads.map((t) => t.painPoint)).slice(0, 4),
      channels: uniq(threads.map((t) => t.community)).slice(0, 5),
      keywords: (c.keywords || []).slice(0, 8),
      voice: c.voice || '',
    };
    const merged = { ...defaults };
    for (const [k, v] of Object.entries(profile)) if (hasValue(v)) merged[k] = v;
    setArmed(false);
    patchOnboarding({ profileDraft: merged, ready: true, step: 'connect' });
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const suggestion = userTurns === 0 && company.audience ? clip(company.audience, 110) : '';

  return html`<section className="start-audience">
    <div className="start-chat">
      <div className="start-chat-head">
        <h1 className="start-h1" tabIndex=${-1}>Who is ${company.name || 'this'} for?</h1>
        <p className="start-sub">A quick chat so Lens listens in the right places. Three or four answers is plenty.</p>
      </div>
      <div ref=${logRef} className="start-chat-log" role="log" aria-live="polite" aria-relevant="additions">
        ${transcript.map((m, i) => html`<${Bubble} key=${i} msg=${m} />`)}
        ${thinking
          ? html`<div className="start-msg start-msg--ai">
              <span className="start-msg-avatar" aria-hidden="true"><${LensMark} size=${16} /></span>
              <div className="start-msg-bubble start-typing" aria-label="Lens is typing"><span></span><span></span><span></span></div>
            </div>`
          : null}
        ${ready && !thinking
          ? html`<div className="start-ready" role="status">
              <div className="start-ready-text">
                <span className="start-ready-check"><${Icon} name="check" size=${14} strokeWidth=${2.4} /></span>
                <span>
                  <strong>Your audience profile is ready.</strong>
                  <span className="start-ready-note">
                    ${armed ? ` Continuing in ${secs}s — type to keep refining.` : ' Keep typing to refine it, or move on.'}
                  </span>
                </span>
              </div>
              <${Button} variant="primary" iconRight="arrowRight" onClick=${advance} className="start-ready-btn">Looks right<//>
              ${armed ? html`<span className="start-ready-bar" aria-hidden="true"><span></span></span>` : null}
            </div>`
          : null}
      </div>
      ${suggestion && !thinking
        ? html`<div className="start-suggest">
            <button type="button" className="start-suggest-chip" onClick=${() => send(company.audience)}>
              <${Icon} name="sparkles" size=${13} /> <span>${suggestion}</span>
            </button>
          </div>`
        : null}
      <form
        className="start-composer"
        onSubmit=${(e) => {
          e.preventDefault();
          send();
        }}
      >
        <label className="sr-only" htmlFor="start-composer-input">Message Lens</label>
        <textarea
          id="start-composer-input"
          ref=${inputRef}
          data-autofocus="true"
          className="start-composer-input"
          rows=${1}
          placeholder=${ready ? 'Add anything Lens missed…' : 'Describe who it’s for…'}
          value=${text}
          onChange=${(e) => {
            const v = e.target.value;
            setText(v);
            if (armed && v.trim()) setArmed(false);
          }}
          onKeyDown=${onKeyDown}
        ></textarea>
        <button type="submit" className="start-composer-send" disabled=${!text.trim() || sending} aria-label="Send">
          ${sending ? html`<${Spinner} size=${16} />` : html`<${Icon} name="send" size=${17} />`}
        </button>
      </form>
      <div className="start-chat-foot">
        <${Button} variant="ghost" size="sm" icon="chevronLeft" onClick=${() => goStep('url')}>Back<//>
        <button type="button" className="start-textlink" onClick=${skip}>Skip — use what Lens found</button>
      </div>
    </div>
    <${ProfileCard} profile=${profile} company=${company} collapsed=${collapsed} onToggle=${() => setCollapsed((v) => !v)} />
  </section>`;
}

// ---------------------------------------------------------------------------
// step 4 — connect

const DESIGN_TOOLS = [
  { id: 'canva', name: 'Canva', icon: 'palette', blurb: 'Templates & quick social graphics', hue: 'canva' },
  { id: 'figma', name: 'Figma', icon: 'layers', blurb: 'Frames from your design files', hue: 'figma' },
];

function DesignTile({ tool, design, onPick }) {
  const selected = design.tool === tool.id && design.status !== 'disconnected';
  const connecting = selected && design.status === 'connecting';
  const connected = selected && design.status === 'connected';
  return html`<button
    type="button"
    role="radio"
    aria-checked=${selected ? 'true' : 'false'}
    className=${cx('start-tile', `start-tile--${tool.hue}`, selected && 'is-selected')}
    onClick=${() => onPick(tool.id)}
    disabled=${design.status === 'connecting'}
  >
    <span className="start-tile-glyph" aria-hidden="true"><${Icon} name=${tool.icon} size=${22} /></span>
    <span className="start-tile-name">${tool.name} <span className="start-demo">demo</span></span>
    <span className="start-tile-blurb">${tool.blurb}</span>
    <span className="start-tile-state">
      ${connecting
        ? html`<${Spinner} size=${12} /> Connecting…`
        : connected
          ? html`<${Icon} name="check" size=${13} strokeWidth=${2.4} /> Connected`
          : 'Select'}
    </span>
    <span className="start-tile-radio" aria-hidden="true"></span>
  </button>`;
}

function ConnectRow({ icon, iconClass, title, badge, desc, status, children }) {
  return html`<div className="start-conn">
    <span className=${cx('start-conn-icon', iconClass)} aria-hidden="true"><${Icon} name=${icon} size=${20} /></span>
    <div className="start-conn-main">
      <div className="start-conn-title">${title} ${badge}</div>
      <div className="start-conn-desc">${desc}</div>
      ${status ? html`<div className="start-conn-status">${status}</div>` : null}
    </div>
    <div className="start-conn-action">${children}</div>
  </div>`;
}

function ConnectStep() {
  const conn = useStore((s) => s.connections) || {};
  const design = conn.design || { tool: null, status: 'disconnected' };
  const sculptex = conn.sculptex || { status: 'disconnected' };
  const linkedin = conn.linkedin || { status: 'disconnected' };
  const profile = useProfile();
  const [busy, setBusy] = useState('');

  const pickDesign = async (tool) => {
    if (design.status === 'connecting') return;
    try {
      if (design.tool === tool && design.status === 'connected') await disconnectDesignTool();
      else await connectDesignTool(tool);
    } catch (e) {
      toast(`Design tool: ${e.message || e}`, 'error');
    }
  };

  const connectSculptex = async () => {
    setBusy('sculptex');
    try {
      const res = await mcp.connect('sculptex');
      if (res && res.redirecting) return; // leaving for sign-in; state.onboarding.step brings us back here
      toast('Sculptex connected.', 'success');
    } catch (e) {
      toast(`Sculptex: ${e.message || e}`, 'error');
    } finally {
      setBusy('');
    }
  };

  const toggleLinkedIn = async () => {
    setBusy('linkedin');
    try {
      if (linkedin.status === 'connected') await disconnectLinkedIn();
      else await connectLinkedIn();
    } catch (e) {
      toast(`LinkedIn (demo): ${e.message || e}`, 'error');
    } finally {
      setBusy('');
    }
  };

  const sxConnecting = busy === 'sculptex' || sculptex.status === 'connecting';
  const anyConnected = design.status === 'connected' || sculptex.status === 'connected' || linkedin.status === 'connected';
  const toolCount = Array.isArray(sculptex.tools) ? sculptex.tools.length : 0;

  return html`<section className="start-panel start-connect">
    <div className="start-panel-head">
      <h1 className="start-h1" tabIndex=${-1}>Connect your tools</h1>
      <p className="start-sub">All optional, and only for this browser tab — close it and Lens forgets these connections.</p>
    </div>

    <div className="start-group">
      <div className="start-group-label">Design tool <span className="muted">· pick one</span></div>
      <div className="start-tiles" role="radiogroup" aria-label="Design tool">
        ${DESIGN_TOOLS.map((t) => html`<${DesignTile} key=${t.id} tool=${t} design=${design} onPick=${pickDesign} />`)}
      </div>
      ${design.status === 'connected' && design.account ? html`<p className="start-group-note">${design.account}</p>` : null}
    </div>

    <div className="start-group">
      <div className="start-group-label">3D renders</div>
      <${ConnectRow}
        icon="cube"
        iconClass="is-sculptex"
        title="Sculptex"
        badge=${html`<${Badge} tone="success">Real MCP<//>`}
        desc="Turn a post idea into a precise 3D render. Sign-in opens Sculptex and brings you right back to this step."
        status=${sculptex.status === 'connected'
          ? html`<span className="start-ok"><${Icon} name="check" size=${13} strokeWidth=${2.4} /> Connected${toolCount ? ` · ${toolCount} tool${toolCount === 1 ? '' : 's'}` : ''}</span>`
          : sculptex.status === 'error' && sculptex.error
            ? html`<span className="start-err">${clip(sculptex.error, 160)}</span>`
            : null}
      >
        ${sculptex.status === 'connected'
          ? html`<${Button} variant="ghost" size="sm" onClick=${() => mcp.disconnect('sculptex')}>Disconnect<//>`
          : html`<${Button} variant="secondary" loading=${sxConnecting} onClick=${connectSculptex}>
              ${sculptex.status === 'error' ? 'Retry' : 'Connect'}
            <//>`}
      <//>
    </div>

    <div className="start-group">
      <div className="start-group-label">Publishing</div>
      <${ConnectRow}
        icon="linkedin"
        iconClass="is-linkedin"
        title="LinkedIn"
        badge=${html`<span className="start-demo">demo</span>`}
        desc="Simulated connection — approved posts land in a mock feed inside Lens. Nothing is sent to the real LinkedIn."
        status=${linkedin.status === 'connected'
          ? html`<span className="start-li"><${LinkedInAvatar} profile=${profile} size=${22} /> ${profile.name}</span>`
          : null}
      >
        <${Button}
          variant=${linkedin.status === 'connected' ? 'ghost' : 'secondary'}
          size=${linkedin.status === 'connected' ? 'sm' : 'md'}
          loading=${busy === 'linkedin' || linkedin.status === 'connecting'}
          onClick=${toggleLinkedIn}
        >
          ${linkedin.status === 'connected' ? 'Disconnect' : 'Connect'}
        <//>
      <//>
    </div>

    <${StepFooter} onBack=${() => goStep('audience')}>
      <${Button} variant="primary" iconRight="arrowRight" onClick=${() => goStep('swipe')}>
        ${anyConnected ? 'Continue' : 'Skip for now'}
      <//>
    <//>
  </section>`;
}

// ---------------------------------------------------------------------------
// step 5 — swipe (first posts)

let suggestRun = null;

function pendingPostCount(s = getState()) {
  return (s.drafts || []).filter((d) => d && d.kind === 'post' && d.status === 'pending').length;
}

const SEED_SUGGESTION_ID = /^s\d+$/; // bundled Sculptex suggestions from demo-data (s1–s5)

function isSeedSuggestion(d) {
  return d && d.kind === 'post' && d.status === 'pending' && SEED_SUGGESTION_ID.test(String(d.id || ''));
}

/** True once this onboarding run (keyed by its URL) has its own suggestions. */
function suggestedThisRun(s = getState()) {
  const ob = s.onboarding || {};
  return Boolean(ob.url) && ob.suggestedFor === ob.url;
}

// Generate once per onboarding run, whatever is already pending (V2: "Calls generateSuggestions() once").
function ensureSuggestions() {
  if (suggestRun) return suggestRun;
  const s = getState();
  const ob = s.onboarding || {};
  const runKey = ob.url || '';
  if (suggestedThisRun(s)) return Promise.resolve(null);
  const demoMode = Boolean(s.settings && s.settings.demoMode);
  const hasSeeds = (s.drafts || []).some(isSeedSuggestion);
  // The curated Sculptex suggestions are this run's posts only for the Sculptex demo in demo mode.
  if (demoMode && hasSeeds && hostname(runKey) === DEMO_HOST) {
    patchOnboarding({ suggestedFor: runKey });
    return Promise.resolve(null);
  }
  if (hasSeeds) setState((st) => ({ drafts: (st.drafts || []).filter((d) => !isSeedSuggestion(d)) }));
  suggestRun = generateSuggestions()
    .then((fresh) => {
      const now = getState().onboarding || {};
      if (now.url === runKey) patchOnboarding({ suggestedFor: runKey });
      return fresh;
    })
    .finally(() => {
      suggestRun = null;
    });
  return suggestRun;
}

export function finishOnboarding() {
  const s = getState();
  const ob = s.onboarding || {};
  const p = ob.profileDraft || {};
  const c = { ...(s.company || {}) };
  if (ob.url) c.url = ob.url;
  if (hasValue(p.audience)) c.audience = String(p.audience).trim();
  if (hasValue(p.voice)) c.voice = String(p.voice).trim();
  if (hasValue(p.keywords)) c.keywords = uniq([...(p.keywords || []), ...(c.keywords || [])]).slice(0, 12);
  if (hasValue(p.pains)) c.pains = uniq(p.pains).slice(0, 8);
  if (hasValue(p.channels)) c.channels = uniq(p.channels).slice(0, 8);
  setState({
    onboarded: true,
    company: c,
    onboarding: { ...ob, ready: false, completedAt: new Date().toISOString() },
  });
  navigate('/');
}

function SwipeStep() {
  const scheduled = useStore((s) => (s.drafts || []).filter((d) => d && d.kind === 'post' && d.status === 'scheduled').length);
  const audience = useStore((s) => (s.onboarding && s.onboarding.profileDraft && s.onboarding.profileDraft.audience) || '');
  const [phase, setPhase] = useState(() => (suggestedThisRun() && pendingPostCount() > 0 ? 'ready' : 'generating'));
  const baseline = useRef(scheduled);
  const finished = useRef(false);

  useEffect(() => {
    let alive = true;
    ensureSuggestions()
      .catch((e) => toast(`Couldn’t write suggestions: ${e.message || e}`, 'error'))
      .finally(() => {
        if (alive) setPhase('ready');
      });
    return () => {
      alive = false;
    };
  }, []);

  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    const approved = Math.max(0, (getState().drafts || []).filter((d) => d && d.kind === 'post' && d.status === 'scheduled').length - baseline.current);
    toast(approved ? `You’re set — ${approved} post${approved === 1 ? '' : 's'} scheduled. Welcome to Lens.` : 'You’re set — welcome to Lens.', 'success');
    finishOnboarding();
  }, []);

  const onEmpty = useCallback(() => {
    if (phase === 'ready') finish();
  }, [phase, finish]);

  const approved = Math.max(0, scheduled - baseline.current);

  return html`<section className="start-panel start-swipe">
    <div className="start-panel-head">
      <h1 className="start-h1" tabIndex=${-1}>Your first posts</h1>
      <p className="start-sub">
        Written from what your audience is saying. Swipe right to schedule at a good time, left to skip — nothing is posted without you.
      </p>
    </div>
    <div className="start-swipe-area">
      ${phase === 'ready'
        ? html`<${SwipeStack} compact=${true} onEmpty=${onEmpty} />`
        : html`<div className="start-writing" role="status">
            <div className="start-writing-card" aria-hidden="true">
              <div className="start-writing-row"><span className="start-sk start-sk-av"></span><span className="start-sk start-sk-name"></span></div>
              <span className="start-sk"></span><span className="start-sk"></span><span className="start-sk start-sk-short"></span>
              <span className="start-sk start-sk-media"></span>
            </div>
            <p className="start-writing-text">
              <${Spinner} size=${14} /> Writing posts from what ${audience ? lowerFirst(clip(audience, 60).replace(/[.]$/, '')) : 'your audience'} said…
            </p>
          </div>`}
    </div>
    <${StepFooter} onBack=${() => goStep('connect')}>
      ${phase === 'ready'
        ? html`<span className="start-count" aria-live="polite">${approved ? `${approved} scheduled` : ''}</span>`
        : null}
      <${Button} variant="primary" iconRight="arrowRight" onClick=${finish}>Finish<//>
    <//>
  </section>`;
}

// ---------------------------------------------------------------------------
// page

export default function Start() {
  const ob = useStore((s) => s.onboarding) || {};
  const step = STEP_IDS.includes(ob.step) ? ob.step : 'url';
  const rootRef = useRef(null);
  const firstRender = useRef(true);

  // Move focus to the new step (input if the step has one, else its heading).
  useEffect(() => {
    try {
      window.scrollTo(0, 0);
    } catch {
      /* ignore */
    }
    const root = rootRef.current;
    if (!root) return undefined;
    const raf = requestAnimationFrame(() => {
      const target = root.querySelector('[data-autofocus]') || (firstRender.current ? null : root.querySelector('h1'));
      firstRender.current = false;
      if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [step]);

  let body;
  if (step === 'scanning') body = html`<${ScanningStep} ob=${ob} />`;
  else if (step === 'audience') body = html`<${AudienceStep} ob=${ob} />`;
  else if (step === 'connect') body = html`<${ConnectStep} />`;
  else if (step === 'swipe') body = html`<${SwipeStep} />`;
  else body = html`<${UrlStep} ob=${ob} />`;

  return html`<div ref=${rootRef} className=${cx('start', `start--${step}`)}>
    <${StartHeader} step=${step} />
    <div className="start-body" key=${step}>${body}</div>
  </div>`;
}

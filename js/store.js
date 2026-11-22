// js/store.js — the single app store.
// - Everything durable lives in localStorage 'lens_state_v1' (no database, no accounts).
// - MCP / mock connections are TEMPORARY: sessionStorage 'lens_mcp_v1' only. Close the tab → gone.
// - toasts, ui.loading, ui.chatOpen and ui.relay (You.com relay status) are never persisted.
// - v2 (onboarding, swipe stack, analytics) and v3 (You.com as AI provider) keys are deep-merged into older saves.
import { useState, useEffect, useRef } from './lib.js';
import { demo } from './demo-data.js';

const LS_KEY = 'lens_state_v1';
const SS_KEY = 'lens_mcp_v1';
const STORAGE_VERSION = 2;
const TOAST_MS = 5000;
export const SCULPTEX_URL = 'https://sculptex-git-main-jacksonschorr.vercel.app/mcp';

// ---------------------------------------------------------------------------
// helpers

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
}

function clone(x) {
  if (x === undefined) return undefined;
  try {
    return structuredClone(x);
  } catch {
    return JSON.parse(JSON.stringify(x));
  }
}

// demo-data fields may be arrays or functions of `now` (dates relative to today).
function resolveDemo(x, fallback = []) {
  try {
    const v = typeof x === 'function' ? x(new Date()) : x;
    return v === undefined || v === null ? clone(fallback) : clone(v);
  } catch (err) {
    console.warn('[Lens] demo data generator failed', err);
    return clone(fallback);
  }
}

// Deep-merge saved data over defaults so keys added in newer versions appear.
// Arrays are replaced wholesale; a saved value whose type doesn't match the default is ignored.
function mergeDefaults(def, saved) {
  if (saved === undefined) return def;
  if (isPlainObject(def)) {
    if (!isPlainObject(saved)) return def;
    const out = { ...def };
    for (const k of Object.keys(saved)) out[k] = k in def ? mergeDefaults(def[k], saved[k]) : saved[k];
    return out;
  }
  if (Array.isArray(def)) return Array.isArray(saved) ? saved : def;
  if (def !== null && def !== undefined && saved !== null && typeof def !== typeof saved) return def;
  return saved;
}

function safeGet(storage, key) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function storageOf(name) {
  try {
    return window[name];
  } catch {
    return null;
  }
}

export function uid(prefix = 'id') {
  const t = Date.now().toString(36).slice(-5);
  const r = Math.random().toString(36).slice(2, 7);
  return `${prefix}_${t}${r}`;
}

// ---------------------------------------------------------------------------
// defaults

function defaultConnections() {
  return {
    linkedin: { status: 'disconnected', profile: null }, // MOCK — "LinkedIn (demo)"
    sculptex: { url: SCULPTEX_URL, status: 'disconnected', tools: [], auth: null, sessionId: null, error: '' }, // REAL MCP
    design: { tool: null, status: 'disconnected', account: null }, // MOCK Canva/Figma pick
  };
}

function defaultCompany() {
  const base = { name: '', url: '', tagline: '', description: '', audience: '', field: '', keywords: [], competitors: [], voice: '' };
  return mergeDefaults(base, resolveDemo(demo && demo.company, {}));
}

function buildDefaults() {
  const d = demo || {};
  return {
    onboarded: false,
    company: defaultCompany(),
    // aiProvider: 'you' (default, via ./api/you) | 'claude'. youModel: optional Inference Router model id ('' = relay picks).
    // youAgent: optional You.com agent ('' = Inference Router; 'answer' | 'express' | 'advanced' | custom id).
    settings: { youKey: '', claudeKey: '', claudeModel: 'claude-sonnet-5-5', demoMode: true, aiProvider: 'you', youModel: '', youAgent: '' },
    connections: defaultConnections(),
    linkedinFeed: resolveDemo(d.linkedinFeed, []),
    threads: resolveDemo(d.threads, []),
    trends: resolveDemo(d.trends, []),
    events: resolveDemo(d.events, []),
    drafts: resolveDemo(d.drafts, []),
    chat: [],
    ideaChat: [],
    onboarding: { step: 'url', url: '', transcript: [], profileDraft: {} },
    ui: { chatOpen: false, lastRefresh: null, loading: {}, relay: null },
    toasts: [],
  };
}

// ---------------------------------------------------------------------------
// migrations (saved envelope version → current)

// v1 → v2: seed the mock LinkedIn history (Analytics) and the demo swipe-stack suggestions
// when the saved data has none, without touching anything the user created.
function migrate(state, fromVersion) {
  if (fromVersion >= 2) return state;
  let next = state;
  const d = demo || {};
  if (!Array.isArray(next.linkedinFeed) || next.linkedinFeed.length === 0) {
    next = { ...next, linkedinFeed: resolveDemo(d.linkedinFeed, []) };
  } else if (!next.linkedinFeed.some((e) => e && e.demo)) {
    // Keep what was published this session and add the demo history behind it.
    const seeded = resolveDemo(d.linkedinFeed, []);
    const ids = new Set(next.linkedinFeed.map((e) => e && e.id));
    next = { ...next, linkedinFeed: [...next.linkedinFeed, ...seeded.filter((e) => !ids.has(e.id))] };
  }
  const drafts = Array.isArray(next.drafts) ? next.drafts : [];
  const hasSuggestions = drafts.some((x) => x && x.kind === 'post' && x.source);
  if (!hasSuggestions) {
    const ids = new Set(drafts.map((x) => x && x.id));
    const fresh = resolveDemo(d.suggestions, []).filter((x) => !ids.has(x.id));
    if (fresh.length) next = { ...next, drafts: [...fresh, ...drafts] };
  }
  return next;
}

// ---------------------------------------------------------------------------
// load

function load() {
  const defaults = buildDefaults();
  const local = storageOf('localStorage');
  const session = storageOf('sessionStorage');

  const savedEnvelope = local ? safeGet(local, LS_KEY) : null;
  const saved = savedEnvelope && isPlainObject(savedEnvelope.data) ? savedEnvelope.data : null;

  let state = saved ? mergeDefaults(defaults, saved) : defaults;
  if (saved) state = migrate(state, Number(savedEnvelope.version) || 1);
  if (!['you', 'claude'].includes(state.settings.aiProvider)) state = { ...state, settings: { ...state.settings, aiProvider: 'you' } };
  if (!isPlainObject(state.onboarding) || !state.onboarding.step) state = { ...state, onboarding: { ...defaults.onboarding } };

  // Connections never come from localStorage — only from this tab's session.
  const savedConn = session ? safeGet(session, SS_KEY) : null;
  const conn = mergeDefaults(defaultConnections(), isPlainObject(savedConn) ? savedConn : {});
  // A mock connect interrupted by a reload can't finish; Sculptex 'connecting' is left for mcp.js (OAuth round-trip).
  if (conn.linkedin.status === 'connecting') conn.linkedin = { ...conn.linkedin, status: 'disconnected' };
  if (conn.design.status === 'connecting') conn.design = { ...conn.design, status: 'disconnected' };
  if (!conn.sculptex.url) conn.sculptex = { ...conn.sculptex, url: SCULPTEX_URL };
  // An OAuth sign-in abandoned mid-way (back button, closed tab) would otherwise stay 'connecting' forever.
  let oauthReturn = false;
  try {
    const q = new URLSearchParams(location.search);
    oauthReturn = q.has('state') && (q.has('code') || q.has('error'));
  } catch {
    /* no location */
  }
  if (conn.sculptex.status === 'connecting' && !oauthReturn) {
    conn.sculptex = { ...conn.sculptex, status: conn.sculptex.auth ? 'connected' : 'disconnected' };
  }

  state = {
    ...state,
    connections: conn,
    ui: { ...state.ui, loading: {}, chatOpen: false, relay: null },
    toasts: [],
  };

  // Demo events are relative to "now". If every saved event is the original demo set and they're all over, refresh them.
  if (saved && demo && typeof demo.events === 'function') {
    const fresh = resolveDemo(demo.events, []);
    const freshIds = new Set(fresh.map((e) => e && e.id));
    const now = Date.now();
    const all = state.events || [];
    const allDemo = all.length > 0 && all.every((e) => e && freshIds.has(e.id));
    const allPast = all.every((e) => !e || new Date(e.end || e.start).getTime() < now);
    if (allDemo && allPast) state = { ...state, events: fresh };
  }
  return state;
}

// ---------------------------------------------------------------------------
// state + persistence

let state = load();
const listeners = new Set();
let lastPersisted = { local: null, session: null };
let persistScheduled = false;
let lastQuotaToastAt = 0;

function persistableSnapshot(s) {
  const { toasts, connections, ui, ...rest } = s;
  const { loading, chatOpen, relay, ...uiRest } = ui || {};
  return { ...rest, ui: uiRest };
}

// Same snapshot with inline data: images removed, used when the full one exceeds the storage quota.
function stripDataImages(snap) {
  const strip = (v) => (v && typeof v.src === 'string' && /^data:/.test(v.src) ? null : v);
  return {
    ...snap,
    drafts: (snap.drafts || []).map((d) => (d && d.visual && strip(d.visual) === null ? { ...d, visual: null } : d)),
    linkedinFeed: (snap.linkedinFeed || []).map((e) => (e && e.visual && strip(e.visual) === null ? { ...e, visual: undefined } : e)),
  };
}

function persist() {
  persistScheduled = false;
  const local = storageOf('localStorage');
  const session = storageOf('sessionStorage');

  // Only rewrite storage when something it holds actually changed.
  const localKey = [];
  for (const k of Object.keys(state)) {
    if (k === 'toasts' || k === 'connections') continue;
    if (k === 'ui') {
      const { loading, chatOpen, relay, ...uiRest } = state.ui || {};
      localKey.push(JSON.stringify(uiRest));
    } else {
      localKey.push(state[k]);
    }
  }
  const localChanged = !lastPersisted.local || lastPersisted.local.length !== localKey.length || localKey.some((v, i) => v !== lastPersisted.local[i]);
  const sessionChanged = lastPersisted.session !== state.connections;

  if (localChanged && local) {
    try {
      local.setItem(LS_KEY, JSON.stringify({ version: STORAGE_VERSION, savedAt: new Date().toISOString(), data: persistableSnapshot(state) }));
      lastPersisted.local = localKey;
    } catch (err) {
      const quota = err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014);
      let savedWithoutImages = false;
      if (quota) {
        // Save everything else; only the inline images are dropped from storage (they stay on screen this session).
        try {
          local.setItem(LS_KEY, JSON.stringify({ version: STORAGE_VERSION, savedAt: new Date().toISOString(), data: stripDataImages(persistableSnapshot(state)) }));
          lastPersisted.local = localKey;
          savedWithoutImages = true;
        } catch {
          /* still too big */
        }
      }
      const now = Date.now();
      if (now - lastQuotaToastAt > 10000) {
        lastQuotaToastAt = now;
        toast(
          savedWithoutImages
            ? 'Browser storage is full — your work was saved, but uploaded images and renders won\'t survive a reload.'
            : quota
              ? 'Browser storage is full — recent changes could not be saved. Try removing an uploaded visual.'
              : `Couldn't save to browser storage: ${err && err.message ? err.message : err}`,
          'error'
        );
      }
    }
  }
  if (sessionChanged && session) {
    try {
      session.setItem(SS_KEY, JSON.stringify(state.connections || {}));
      lastPersisted.session = state.connections;
    } catch (err) {
      console.warn('[Lens] could not write session connections', err);
    }
  }
}

function schedulePersist() {
  if (persistScheduled) return;
  persistScheduled = true;
  queueMicrotask(persist);
}

function emit() {
  for (const fn of Array.from(listeners)) {
    try {
      fn(state);
    } catch (err) {
      console.error('[Lens] store listener failed', err);
    }
  }
}

export function getState() {
  return state;
}

export function setState(patchOrFn) {
  const patch = typeof patchOrFn === 'function' ? patchOrFn(state) : patchOrFn;
  if (!patch || typeof patch !== 'object') return state;
  let changed = false;
  for (const k of Object.keys(patch)) {
    if (state[k] !== patch[k]) {
      changed = true;
      break;
    }
  }
  if (!changed) return state;
  state = { ...state, ...patch };
  schedulePersist();
  emit();
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !Object.is(a[k], b[k])) return false;
  return true;
}

// ---------------------------------------------------------------------------
// live / demo

/**
 * Live/demo flags derived from store state only (reactive: use inside useStore selectors).
 * Mirrors lens.js canUseYou()/canUseAI(): You.com is usable with the user's key or the deployment's
 * env key (state.ui.relay, published by youcom.js), Claude with the user's Claude key.
 * → { demoMode, search, ai, live, provider }
 */
export function liveFlags(s = state) {
  const st = (s && s.settings) || {};
  const relay = (s && s.ui && s.ui.relay) || null;
  const relayOk = !relay || relay.available !== false;
  const youOk = relayOk && Boolean(String(st.youKey || '').trim() || (relay && relay.envKey));
  const claudeOk = Boolean(String(st.claudeKey || '').trim());
  const chosen = st.aiProvider === 'claude' ? 'claude' : 'you';
  let prov = chosen;
  if (chosen === 'claude' && !claudeOk && youOk) prov = 'you';
  if (chosen === 'you' && !youOk && claudeOk) prov = 'claude';
  const demoMode = Boolean(st.demoMode);
  const search = !demoMode && youOk;
  const aiLive = !demoMode && (prov === 'claude' ? claudeOk : youOk);
  return { demoMode, search, ai: aiLive, live: search || aiLive, provider: prov };
}

const identity = (s) => s;

// React hook. Selectors may derive new arrays/objects; results are compared shallowly,
// so `s => s.drafts.filter(...)` only re-renders when the filtered items change.
export function useStore(selector = identity) {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const value = selector(state);
  const valueRef = useRef(value);
  valueRef.current = value;
  const [, force] = useState(0);

  useEffect(() => {
    const check = () => {
      let next;
      try {
        next = selectorRef.current(state);
      } catch {
        force((n) => n + 1);
        return;
      }
      if (!shallowEqual(next, valueRef.current)) force((n) => n + 1);
    };
    const unsub = subscribe(check);
    check(); // catch changes between render and subscription
    return unsub;
  }, []);

  return value;
}

// ---------------------------------------------------------------------------
// toasts

const toastTimers = new Map();

export function dismissToast(id) {
  const t = toastTimers.get(id);
  if (t) clearTimeout(t);
  toastTimers.delete(id);
  setState((s) => (s.toasts.some((x) => x.id === id) ? { toasts: s.toasts.filter((x) => x.id !== id) } : null));
}

// toast(message, kind?, { action?: { label, onClick }, duration? })
// `action` renders as a button on the toast (e.g. Undo); toasts are never persisted, so functions are fine here.
export function toast(message, kind = 'info', opts = {}) {
  const text = message instanceof Error ? message.message : typeof message === 'string' ? message : String(message ?? '');
  const k = ['info', 'success', 'error'].includes(kind) ? kind : 'info';
  const action =
    opts && opts.action && typeof opts.action.onClick === 'function'
      ? { label: String(opts.action.label || 'Undo'), onClick: opts.action.onClick }
      : null;
  const ms = opts && Number(opts.duration) > 0 ? Number(opts.duration) : action ? TOAST_MS + 2000 : TOAST_MS;
  const existing = action ? null : state.toasts.find((t) => t.message === text && t.kind === k && !t.action);
  const id = existing ? existing.id : uid('toast');
  if (!existing) {
    const item = action ? { id, message: text, kind: k, action } : { id, message: text, kind: k };
    setState((s) => ({ toasts: [...s.toasts, item].slice(-5) }));
  }
  if (toastTimers.has(id)) clearTimeout(toastTimers.get(id));
  toastTimers.set(id, setTimeout(() => dismissToast(id), ms));
  return id;
}

// ---------------------------------------------------------------------------
// convenience

export function setLoading(key, on) {
  setState((s) => {
    const loading = { ...(s.ui.loading || {}) };
    if (on) loading[key] = true;
    else delete loading[key];
    return { ui: { ...s.ui, loading } };
  });
}

// Back to demo defaults. Keeps API keys/settings and this tab's (temporary) connections.
export function resetState() {
  const fresh = buildDefaults();
  for (const t of toastTimers.values()) clearTimeout(t);
  toastTimers.clear();
  state = {
    ...fresh,
    settings: { ...fresh.settings, ...state.settings },
    connections: state.connections,
  };
  lastPersisted = { local: null, session: state.connections };
  schedulePersist();
  emit();
  return state;
}

// Persist immediately before the page goes away (e.g. OAuth redirect).
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (persistScheduled) persist();
  });
}

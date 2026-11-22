// js/app.js — boots Lens: OAuth callback (Sculptex MCP), app shell, routing, chat, toasts.
// '/start' (first-run onboarding) renders full-screen without the shell; every other route renders in it.
import { html, React, Fragment, createRoot, useEffect, useState, useRef } from './lib.js';
import { useStore, setState, getState, toast, resetState, liveFlags } from './store.js';
import { useRoute, navigate, href, parseHash, OPEN_ROUTES } from './router.js';
import { Icon, Toasts, Button, Avatar, cx, hostname, timeAgo } from './ui.js';

// primary: shown in the mobile bottom bar; the rest go into the "More" sheet on mobile.
const NAV = [
  { path: '/', label: 'Dashboard', icon: 'home', primary: true },
  { path: '/stack', label: 'Stack', icon: 'layers', badge: 'stack', primary: true },
  { path: '/discover', label: 'Discover', icon: 'search', primary: true },
  { path: '/outreach', label: 'Outreach', icon: 'inbox', badge: 'outreach' },
  { path: '/studio', label: 'Studio', icon: 'edit' },
  { path: '/schedule', label: 'Schedule', icon: 'calendar' },
  { path: '/analytics', label: 'Analytics', icon: 'chart' },
  { path: '/chat', label: 'Chat', icon: 'chat', primary: true },
  { path: '/settings', label: 'Settings', icon: 'settings' },
];
const PRIMARY_NAV = NAV.filter((n) => n.primary);
const MORE_NAV = NAV.filter((n) => !n.primary);

const TITLES = {
  '/': 'Dashboard',
  '/start': 'Get started',
  '/stack': 'Stack',
  '/discover': 'Discover',
  '/outreach': 'Outreach',
  '/studio': 'Studio',
  '/schedule': 'Schedule',
  '/analytics': 'Analytics',
  '/chat': 'Chat',
  '/settings': 'Settings',
};

const VIEW_FILES = {
  '/start': './views/start.js',
  '/': './views/dashboard.js',
  '/stack': './views/stack.js',
  '/discover': './views/discover.js',
  '/outreach': './views/outreach.js',
  '/studio': './views/studio.js',
  '/schedule': './views/schedule.js',
  '/analytics': './views/analytics.js',
  '/chat': './views/ideas.js',
  '/settings': './views/settings.js',
};

// Routes where the floating "Ask Lens" button would be redundant or in the way.
const NO_FAB = ['/chat', '/start'];

// Loaded modules (or their load errors), filled in by boot().
const views = {};
let chatModule = { ChatDrawer: null, error: null };

// ---------------------------------------------------------------------------
// theme (per-viewer convenience; not app data)

const THEME_KEY = 'lens_theme';
const THEMES = ['system', 'light', 'dark'];

function readTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return THEMES.includes(t) ? t : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage unavailable — theme still applies for this visit */
  }
}

function ThemeToggle({ withLabel = false }) {
  const [theme, setTheme] = useState(readTheme);
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  const icon = theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'monitor';
  const label = theme === 'light' ? 'Light' : theme === 'dark' ? 'Dark' : 'System';
  return html`<button
    type="button"
    className=${cx('btn btn-ghost btn-sm', !withLabel && 'btn-icon', withLabel && 'theme-toggle-wide')}
    title=${`Theme: ${theme} (switch to ${next})`}
    aria-label=${`Theme: ${theme}. Switch to ${next}.`}
    onClick=${() => {
      applyTheme(next);
      setTheme(next);
    }}
  >
    <${Icon} name=${icon} size=${16} />
    ${withLabel ? html`<span className="btn-label">Theme: ${label}</span>` : null}
  </button>`;
}

// ---------------------------------------------------------------------------
// error boundary

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('[Lens] render error', error, info && info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.quiet) return null;
    return html`<${ViewError} error=${this.state.error} onRetry=${() => this.setState({ error: null })} />`;
  }
}

function confirmReset() {
  const ok = window.confirm('Reset Lens to the demo data? Threads, drafts and your company profile in this browser are cleared. API keys are kept.');
  if (!ok) return false;
  resetState();
  toast('Demo data restored.', 'success');
  navigate('/start');
  return true;
}

function ViewError({ error, onRetry, title = 'This view hit a snag' }) {
  const message = error && error.message ? error.message : String(error || 'Unknown error');
  return html`<div className="page">
    <div className="card view-error" role="alert">
      <div className="card-body stack">
        <div className="row">
          <span className="view-error-icon"><${Icon} name="alert" size=${18} /></span>
          <h2 className="card-title">${title}</h2>
        </div>
        <pre className="view-error-msg">${message}</pre>
        <p className="muted small">Your data is stored only in this browser. If the problem persists, resetting the demo data usually fixes it.</p>
        <div className="row">
          ${onRetry ? html`<${Button} variant="secondary" icon="refresh" onClick=${onRetry}>Try again<//>` : null}
          <${Button} variant="secondary" icon="refresh" onClick=${() => location.reload()}>Reload page<//>
          <${Button} variant="danger" icon="trash" onClick=${confirmReset}>Reset demo data<//>
        </div>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// shell pieces

const STATUS_LABEL = { connected: 'Connected', connecting: 'Connecting…', error: 'Error', disconnected: 'Not connected' };
const CONNECTIONS_HREF = href('/settings?tab=connections');

function useConnectionRows() {
  const li = useStore((s) => (s.connections && s.connections.linkedin ? s.connections.linkedin.status : 'disconnected'));
  const sx = useStore((s) => (s.connections && s.connections.sculptex ? s.connections.sculptex.status : 'disconnected'));
  const design = useStore((s) => (s.connections && s.connections.design) || null);
  const designTool = design && design.tool;
  return [
    { id: 'sculptex', label: 'Sculptex', note: 'MCP', status: sx || 'disconnected' },
    {
      id: 'design',
      label: designTool === 'figma' ? 'Figma' : designTool === 'canva' ? 'Canva' : 'Design tool',
      note: 'demo',
      status: (design && design.status) || 'disconnected',
    },
    { id: 'linkedin', label: 'LinkedIn', note: 'demo', status: li || 'disconnected' },
  ];
}

function ConnectionStatus({ compact = false }) {
  const rows = useConnectionRows();
  if (compact) {
    return html`<a className="conn-compact" href=${CONNECTIONS_HREF} title=${rows.map((r) => `${r.label}: ${STATUS_LABEL[r.status] || r.status}`).join(' · ')}>
      ${rows.map((r) => html`<span key=${r.id} className=${cx('conn-dot', `conn-${r.status}`)}></span>`)}
      <span className="sr-only">Connections</span>
    </a>`;
  }
  return html`<div className="conn-list" aria-label="Connections">
    ${rows.map(
      (r) => html`<a key=${r.id} className="conn-row" href=${CONNECTIONS_HREF} title=${STATUS_LABEL[r.status] || r.status}>
        <span className=${cx('conn-dot', `conn-${r.status}`)} aria-hidden="true"></span>
        <span className="conn-name">${r.label}</span>
        <span className="conn-note">${r.note}</span>
        <span className="conn-state">${r.status === 'connected' ? 'On' : r.status === 'connecting' ? '…' : r.status === 'error' ? 'Error' : 'Off'}</span>
      </a>`
    )}
  </div>`;
}

function DemoIndicator() {
  // Live only when demo mode is off AND a provider is actually usable (user key, the deployment's env key
  // via the relay status, or a Claude key) — otherwise lens.js serves demo data and the pill must say so.
  const flags = useStore((s) => liveFlags(s));
  const demo = !flags.live;
  const provider = flags.provider;
  if (demo) {
    return html`<a className="demo-pill" href=${CONNECTIONS_HREF} title="Using bundled demo data. Add a You.com key (or use the shared key) in Settings → Connections.">
      <span className="demo-pill-dot"></span>Demo mode
    </a>`;
  }
  const label = provider === 'claude' ? 'You.com · Claude' : 'You.com';
  return html`<a className="demo-pill is-live" href=${CONNECTIONS_HREF} title=${`Live data · AI provider: ${provider === 'claude' ? 'Claude' : 'You.com'}`}>
    <span className="demo-pill-dot"></span>Live · ${label}
  </a>`;
}

function CompanyChip({ compact = false }) {
  const company = useStore((s) => s.company || {});
  const name = company.name || 'Your company';
  const host = hostname(company.url) || 'Add your product URL';
  return html`<button
    type="button"
    className=${cx('company-chip', compact && 'is-compact')}
    onClick=${() => navigate('/settings?tab=product')}
    title="Edit company profile"
  >
    <${Avatar} name=${name} size=${compact ? 28 : 32} />
    ${compact
      ? null
      : html`<span className="company-chip-text">
          <span className="company-chip-name truncate">${name}</span>
          <span className="company-chip-url truncate">${host}</span>
        </span>`}
    ${compact ? null : html`<${Icon} name="chevronRight" size=${14} className="company-chip-caret" />`}
  </button>`;
}

function Brand() {
  return html`<a className="brand" href=${href('/')} aria-label="Lens home">
    <span className="brand-mark"><${Icon} name="aperture" size=${18} strokeWidth=${2} /></span>
    <span className="brand-name">Lens</span>
  </a>`;
}

function useBadges() {
  const stack = useStore((s) => (s.drafts || []).filter((d) => d && d.kind === 'post' && d.status === 'pending').length);
  const outreach = useStore((s) => (s.drafts || []).filter((d) => d && (d.kind === 'reply' || d.kind === 'dm') && d.status === 'pending').length);
  return { stack, outreach };
}

function NavBadge({ count }) {
  if (!count) return null;
  return html`<span className="nav-badge" aria-label=${`${count} pending`}>${count > 99 ? '99+' : count}</span>`;
}

function NavLink({ item, path, badges, className, onClick }) {
  const active = path === item.path;
  return html`<a
    className=${cx('nav-item', active && 'active', className)}
    href=${href(item.path)}
    aria-current=${active ? 'page' : undefined}
    onClick=${onClick}
  >
    <${Icon} name=${item.icon} size=${18} />
    <span className="nav-label">${item.label}</span>
    <${NavBadge} count=${item.badge ? badges[item.badge] : 0} />
  </a>`;
}

function Sidebar({ path, onMore, moreOpen }) {
  const badges = useBadges();
  const moreActive = MORE_NAV.some((n) => n.path === path);
  const moreCount = MORE_NAV.reduce((sum, n) => sum + (n.badge ? badges[n.badge] || 0 : 0), 0);
  return html`<aside className="sidebar" aria-label="Primary">
    <${Brand} />
    <nav className="nav" aria-label="Main">
      ${NAV.map(
        (item) => html`<${NavLink}
          key=${item.path}
          item=${item}
          path=${path}
          badges=${badges}
          className=${item.primary ? 'nav-primary' : 'nav-secondary'}
        />`
      )}
      <button
        type="button"
        className=${cx('nav-item nav-more', (moreActive || moreOpen) && 'active')}
        onClick=${onMore}
        aria-haspopup="dialog"
        aria-expanded=${moreOpen ? 'true' : 'false'}
      >
        <${Icon} name="menu" size=${18} />
        <span className="nav-label">More</span>
        <${NavBadge} count=${moreCount} />
      </button>
    </nav>
    <div className="spacer"></div>
    <div className="sidebar-footer">
      <${ConnectionStatus} />
      <${DemoIndicator} />
      <${CompanyChip} />
    </div>
  </aside>`;
}

// Mobile-only bottom sheet with the nav items that don't fit in the bottom bar.
function MoreSheet({ open, path, onClose }) {
  const badges = useBadges();
  const ref = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const prev = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    const raf = requestAnimationFrame(() => {
      const first = ref.current && ref.current.querySelector('a, button');
      if (first) first.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;
  return html`<div className="more-backdrop" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="more-sheet" ref=${ref} role="dialog" aria-modal="true" aria-label="More">
      <div className="more-grip" aria-hidden="true"></div>
      <div className="more-head">
        <span className="more-title">More</span>
        <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick=${onClose} aria-label="Close">
          <${Icon} name="x" size=${16} />
        </button>
      </div>
      <nav className="more-nav" aria-label="More pages">
        ${MORE_NAV.map(
          (item) => html`<${NavLink} key=${item.path} item=${item} path=${path} badges=${badges} className="more-item" onClick=${onClose} />`
        )}
      </nav>
      <div className="more-foot">
        <${ConnectionStatus} />
        <div className="row more-foot-row">
          <${DemoIndicator} />
          <span className="spacer"></span>
          <${ThemeToggle} withLabel=${true} />
        </div>
        <${CompanyChip} />
      </div>
    </div>
  </div>`;
}

function Topbar({ path, onboarding }) {
  const lastRefresh = useStore((s) => (s.ui ? s.ui.lastRefresh : null));
  const loading = useStore((s) => Object.keys((s.ui && s.ui.loading) || {}).length > 0);
  return html`<header className="topbar">
    <div className="topbar-left">
      <span className=${cx('topbar-brand', !onboarding && 'mobile-only')}><${Brand} /></span>
      ${onboarding ? null : html`<span className="topbar-title desktop-only">${TITLES[path] || ''}</span>`}
      ${!onboarding && lastRefresh
        ? html`<span className="topbar-meta desktop-only">${loading ? 'Refreshing…' : `Updated ${timeAgo(lastRefresh)}`}</span>`
        : null}
    </div>
    <div className="topbar-right">
      ${onboarding
        ? html`<a className="btn btn-ghost btn-sm" href=${href('/start')}><${Icon} name="arrowLeft" size=${14} /><span className="btn-label">Back to setup</span></a>`
        : html`<${Fragment}>
            <span className="mobile-only"><${DemoIndicator} /></span>
            <span className="mobile-only"><${ConnectionStatus} compact=${true} /></span>
          <//>`}
      <${ThemeToggle} />
      ${onboarding ? null : html`<span className="mobile-only"><${CompanyChip} compact=${true} /></span>`}
    </div>
  </header>`;
}

function ChatFab({ path }) {
  const open = useStore((s) => !!(s.ui && s.ui.chatOpen));
  if (open || !chatModule.ChatDrawer || NO_FAB.includes(path)) return null;
  return html`<button
    type="button"
    className="chat-fab"
    onClick=${() => setState((s) => ({ ui: { ...s.ui, chatOpen: true } }))}
    aria-label="Open Lens chat"
    title="Ask Lens (Ctrl/⌘ K)"
  >
    <${Icon} name="sparkles" size=${18} />
    <span className="chat-fab-label">Ask Lens</span>
  </button>`;
}

function Chat() {
  const open = useStore((s) => !!(s.ui && s.ui.chatOpen));
  const Drawer = chatModule.ChatDrawer;
  if (!Drawer) return null;
  const close = () => setState((s) => ({ ui: { ...s.ui, chatOpen: false } }));
  return html`<${ErrorBoundary} quiet=${true}><${Drawer} open=${open} onClose=${close} /><//>`;
}

function ViewHost({ route }) {
  const entry = views[route.path];
  if (!entry) return html`<${ViewError} title="Page not found" error=${new Error(`No view for ${route.path}`)} />`;
  if (entry.error) {
    return html`<${ViewError} title="Couldn't load this view" error=${entry.error} />`;
  }
  const View = entry.Component;
  return html`<${ErrorBoundary} key=${route.path}><${View} params=${route.params} route=${route} /><//>`;
}

function App() {
  const route = useRoute();
  const onboarded = useStore((s) => !!s.onboarded);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    document.title = route.path === '/' ? 'Lens' : `${TITLES[route.path] || 'Lens'} · Lens`;
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    setMoreOpen(false);
  }, [route.path]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        if (!getState().onboarded) return;
        e.preventDefault();
        setState((s) => ({ ui: { ...s.ui, chatOpen: !s.ui.chatOpen } }));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // First-run flow: full-screen, no sidebar/topbar/FAB.
  if (route.path === '/start') {
    return html`<div className="app-start">
      <main className="start-main" id="main" tabIndex=${-1}>
        <${ViewHost} route=${route} />
      </main>
      <${Toasts} />
    </div>`;
  }

  // Settings is reachable before onboarding is finished (keys, connections) — minimal shell.
  if (!onboarded) {
    return html`<div className="app app-onboarding">
      <main className="main" id="main">
        <${Topbar} path=${route.path} onboarding=${true} />
        <div className="view"><${ViewHost} route=${route} /></div>
      </main>
      <${Toasts} />
    </div>`;
  }

  return html`<div className="app">
    <a className="skip-link" href="#main" onClick=${(e) => {
      e.preventDefault();
      const m = document.getElementById('main');
      if (m) m.focus();
    }}>Skip to content</a>
    <${Sidebar} path=${route.path} moreOpen=${moreOpen} onMore=${() => setMoreOpen((v) => !v)} />
    <main className="main" id="main" tabIndex=${-1}>
      <${Topbar} path=${route.path} onboarding=${false} />
      <div className="view"><${ViewHost} route=${route} /></div>
    </main>
    <${MoreSheet} open=${moreOpen} path=${route.path} onClose=${() => setMoreOpen(false)} />
    <${ChatFab} path=${route.path} />
    <${Chat} />
    <${Toasts} />
  </div>`;
}

// ---------------------------------------------------------------------------
// boot

function hasOAuthReturn() {
  try {
    const p = new URLSearchParams(location.search);
    return p.has('state') && (p.has('code') || p.has('error'));
  } catch {
    return false;
  }
}

// Mid-onboarding OAuth round-trips land back on the start flow, at the step persisted in state.onboarding.
// After an OAuth return the callback has already restored the hash the user left from (e.g.
// #/settings?tab=connections). Only fall back to the start flow when that hash is not an open route.
function resumeOnboarding() {
  if (getState().onboarded) return;
  if (OPEN_ROUTES.includes(parseHash().path)) return;
  navigate('/start', { replace: true });
}

async function loadModule(path) {
  try {
    return { mod: await import(path) };
  } catch (error) {
    console.error(`[Lens] failed to load ${path}`, error);
    return { error };
  }
}

async function boot() {
  applyTheme(readTheme());
  const rootEl = document.getElementById('root');

  // Start every import in parallel.
  const mcpP = loadModule('./services/mcp.js');
  const lensP = loadModule('./services/lens.js');
  const chatP = loadModule('./views/chat.js');
  const viewPs = Object.entries(VIEW_FILES).map(([path, file]) => loadModule(file).then((r) => [path, r]));

  const mcp = await mcpP;
  if (hasOAuthReturn()) {
    const failed = (err) => {
      toast(`Sculptex sign-in didn't complete: ${err && err.message ? err.message : err}`, 'error');
      // Never leave an OAuth code sitting in the address bar.
      try {
        history.replaceState(history.state, '', location.pathname + location.hash);
      } catch {
        /* ignore */
      }
      resumeOnboarding();
    };
    // Not awaited: the callback cleans the URL synchronously (restoring the hash it left from), then the token
    // exchange and MCP handshake run in the background while the UI shows the 'connecting' status from the store.
    try {
      if (mcp.error) throw mcp.error;
      Promise.resolve(mcp.mod.handleOAuthCallback())
        .catch(failed)
        .finally(() => {
          try { window.dispatchEvent(new HashChangeEvent('hashchange')); } catch { /* ignore */ }
        });
      resumeOnboarding();
    } catch (err) {
      failed(err);
    }
  }

  for (const [path, r] of await Promise.all(viewPs)) {
    if (r.error) views[path] = { error: r.error };
    else if (typeof r.mod.default !== 'function') views[path] = { error: new Error(`${VIEW_FILES[path]} has no default export`) };
    else views[path] = { Component: r.mod.default };
  }

  const chat = await chatP;
  if (chat.error) chatModule = { ChatDrawer: null, error: chat.error };
  else chatModule = { ChatDrawer: typeof chat.mod.ChatDrawer === 'function' ? chat.mod.ChatDrawer : null, error: null };

  window.__lensBooted = true;
  createRoot(rootEl).render(html`<${ErrorBoundary}><${App} /><//>`);

  const lens = await lensP;
  if (lens.error) {
    toast(`Lens services failed to load: ${lens.error.message || lens.error}`, 'error');
    return;
  }
  const runDue = () => {
    try {
      const r = lens.mod.runDueSchedules();
      if (r && typeof r.catch === 'function') r.catch((err) => console.warn('[Lens] scheduled run failed', err));
    } catch (err) {
      console.warn('[Lens] scheduled run failed', err);
    }
  };
  setInterval(runDue, 30000);
  setTimeout(runDue, 3000);
}

boot().catch((err) => {
  console.error('[Lens] boot failed', err);
  window.__lensBooted = true;
  const rootEl = document.getElementById('root');
  if (rootEl) {
    rootEl.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'boot-error';
    const h = document.createElement('h1');
    h.textContent = 'Lens could not start';
    const p = document.createElement('p');
    p.textContent = err && err.message ? err.message : String(err);
    const b = document.createElement('button');
    b.className = 'btn btn-primary';
    b.textContent = 'Reload';
    b.onclick = () => location.reload();
    box.append(h, p, b);
    rootEl.appendChild(box);
  }
});

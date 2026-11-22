// js/ui.js — shared components. All styling comes from css/base.css.
import { html, useEffect, useRef } from './lib.js';
import { useStore, dismissToast } from './store.js';

// ---------------------------------------------------------------------------
// small utilities

export function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

export function initials(name = '') {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const s = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0];
  return s.toUpperCase();
}

export function hostname(url = '') {
  if (!url) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return String(url);
  }
}

export async function copyText(text) {
  const value = String(text ?? '');
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
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

// ---------------------------------------------------------------------------
// dates

function toDate(iso) {
  if (!iso) return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

const DATE_PRESETS = {
  short: { month: 'short', day: 'numeric' },
  long: { weekday: 'long', month: 'long', day: 'numeric' },
  weekday: { weekday: 'short', month: 'short', day: 'numeric' },
  time: { hour: 'numeric', minute: '2-digit' },
  datetime: { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  full: { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
};

export function fmtDate(iso, opts) {
  const d = toDate(iso);
  if (!d) return '';
  const o = typeof opts === 'string' ? DATE_PRESETS[opts] || DATE_PRESETS.short : opts || DATE_PRESETS.short;
  try {
    return new Intl.DateTimeFormat(undefined, o).format(d);
  } catch {
    return d.toLocaleDateString();
  }
}

export function timeAgo(iso) {
  const d = toDate(iso);
  if (!d) return '';
  const diff = Date.now() - d.getTime();
  const future = diff < 0;
  const abs = Math.abs(diff);
  if (abs < 45 * 1000) return future ? 'in a moment' : 'just now';
  const min = Math.round(abs / 60000);
  const hr = Math.round(abs / 3600000);
  const day = Math.round(abs / 86400000);
  let s;
  if (min < 60) s = `${min}m`;
  else if (hr < 24) s = `${hr}h`;
  else if (day < 7) s = `${day}d`;
  else if (day < 35) s = `${Math.round(day / 7)}w`;
  else {
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return fmtDate(d, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return future ? `in ${s}` : `${s} ago`;
}

// ---------------------------------------------------------------------------
// icons — 24×24 stroke icons, 1.75 stroke

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  sparkles: '<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0l1.58 6.14a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/><path d="M20 3v4M22 5h-4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  cube: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  trending: '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  arrowUpRight: '<path d="M7 17 17 7"/><path d="M7 7h10v10"/>',
  linkedin: '<path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54z"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  aperture: '<circle cx="12" cy="12" r="10"/><path d="m14.31 8 5.74 9.94M9.69 8h11.48M7.38 12l5.74-9.94M9.69 16 3.95 6.06M14.31 16H2.83M16.62 12l-5.74 9.94"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  mapPin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  video: '<path d="m22 8-6 4 6 4V8z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  thumbsUp: '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  palette: '<path d="M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-2a2 2 0 0 0-1 3.7A1.6 1.6 0 0 1 12 22z"/><circle cx="7.5" cy="10.5" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16.5" cy="10.5" r="1"/>',
  play: '<path d="m6 3 14 9-14 9z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15v2M11 11v6M15 7v10M19 12v5"/>',
  dot: '<circle cx="12" cy="12" r="3"/>',
};
ICONS.zap = ICONS.bolt;
ICONS.close = ICONS.x;
ICONS.pencil = ICONS.edit;
ICONS.gear = ICONS.settings;

export const ICON_NAMES = Object.keys(ICONS);

function escapeXml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

export function Icon({ name, size = 16, className = '', strokeWidth = 1.75, title, style }) {
  const body = ICONS[name] || ICONS.dot;
  const inner = (title ? `<title>${escapeXml(title)}</title>` : '') + body;
  return html`<svg
    className=${cx('icon', className)}
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth=${strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden=${title ? undefined : 'true'}
    role=${title ? 'img' : undefined}
    focusable="false"
    style=${style}
    dangerouslySetInnerHTML=${{ __html: inner }}
  ></svg>`;
}

function renderIcon(icon, size) {
  if (!icon) return null;
  if (typeof icon === 'string') return html`<${Icon} name=${icon} size=${size} />`;
  return icon;
}

// ---------------------------------------------------------------------------
// primitives

export function Spinner({ size = 16, className = '' } = {}) {
  return html`<span
    className=${cx('spinner', className)}
    style=${{ width: size + 'px', height: size + 'px' }}
    role="status"
    aria-label="Loading"
  ></span>`;
}

function hasChildren(children) {
  if (children === null || children === undefined || children === false || children === '') return false;
  if (Array.isArray(children)) return children.some(hasChildren);
  return true;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  onClick,
  disabled,
  loading,
  children,
  title,
  type = 'button',
  className = '',
  ...rest
}) {
  const iconOnly = !hasChildren(children);
  const iconSize = size === 'sm' ? 14 : 16;
  return html`<button
    type=${type}
    className=${cx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', iconOnly && 'btn-icon', loading && 'is-loading', className)}
    onClick=${onClick}
    disabled=${!!(disabled || loading)}
    title=${title}
    aria-label=${iconOnly ? title : undefined}
    aria-busy=${loading ? 'true' : undefined}
    ...${rest}
  >
    ${loading ? html`<${Spinner} size=${iconSize - 2} />` : renderIcon(icon, iconSize)}
    ${iconOnly ? null : html`<span className="btn-label">${children}</span>`}
    ${iconRight && !loading ? renderIcon(iconRight, iconSize) : null}
  </button>`;
}

export function Card({ title, subtitle, actions, children, className = '', icon, ...rest }) {
  const hasHeader = !!(title || subtitle || actions);
  return html`<section className=${cx('card', className)} ...${rest}>
    ${hasHeader
      ? html`<div className="card-header">
          <div className="card-heading">
            ${title ? html`<h3 className="card-title">${renderIcon(icon, 16)}${title}</h3>` : null}
            ${subtitle ? html`<p className="card-sub">${subtitle}</p>` : null}
          </div>
          ${actions ? html`<div className="card-actions">${actions}</div>` : null}
        </div>`
      : null}
    ${hasChildren(children) ? html`<div className="card-body">${children}</div>` : null}
  </section>`;
}

const BADGE_TONES = ['neutral', 'accent', 'success', 'warning', 'danger', 'info', 'hot'];

export function Badge({ tone = 'neutral', icon, children, className = '', title }) {
  const t = BADGE_TONES.includes(tone) ? tone : 'neutral';
  return html`<span className=${cx('badge', `badge-${t}`, className)} title=${title}>${renderIcon(icon, 12)}${children}</span>`;
}

export const SOURCE_META = {
  reddit: { label: 'Reddit', glyph: 'r/', color: '#FF4500' },
  hackernews: { label: 'Hacker News', glyph: 'Y', color: '#FF6600' },
  x: { label: 'X', glyph: 'X', color: '#111114' },
  linkedin: { label: 'LinkedIn', glyph: 'in', color: '#0A66C2' },
  indiehackers: { label: 'Indie Hackers', glyph: 'IH', color: '#0E2439' },
  producthunt: { label: 'Product Hunt', glyph: 'P', color: '#DA552F' },
  web: { label: 'Web', glyph: null, color: '#64748B' },
};

export function SourceIcon({ source = 'web', label = true, community, className = '' }) {
  const meta = SOURCE_META[source] || SOURCE_META.web;
  const text = community || meta.label;
  return html`<span className=${cx('source', `source-${SOURCE_META[source] ? source : 'web'}`, className)} title=${meta.label}>
    <span className="source-glyph" style=${{ background: meta.color }} aria-hidden="true">
      ${meta.glyph ? meta.glyph : html`<${Icon} name="globe" size=${11} strokeWidth=${2} />`}
    </span>
    ${label ? html`<span className="source-label">${text}</span>` : html`<span className="sr-only">${meta.label}</span>`}
  </span>`;
}

export function Empty({ icon = 'inbox', title, body, action, className = '' }) {
  return html`<div className=${cx('empty', className)}>
    <div className="empty-icon">${renderIcon(icon, 22)}</div>
    ${title ? html`<div className="empty-title">${title}</div>` : null}
    ${body ? html`<div className="empty-body">${body}</div>` : null}
    ${action ? html`<div className="empty-action">${action}</div>` : null}
  </div>`;
}

export function Avatar({ name = '', src, size = 32, className = '' }) {
  const style = { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.38) + 'px' };
  return src
    ? html`<img className=${cx('avatar', className)} src=${src} alt=${name} style=${style} />`
    : html`<span className=${cx('avatar', className)} style=${style} aria-hidden="true">${initials(name)}</span>`;
}

export function Stat({ label, value, hint, icon, tone }) {
  return html`<div className=${cx('stat', tone && `stat-${tone}`)}>
    <div className="stat-label">${renderIcon(icon, 14)}${label}</div>
    <div className="stat-value">${value}</div>
    ${hint ? html`<div className="stat-hint">${hint}</div>` : null}
  </div>`;
}

export function Skeleton({ lines = 3, className = '' }) {
  return html`<div className=${cx('skeleton-group', className)} aria-hidden="true">
    ${Array.from({ length: lines }, (_, i) => html`<div key=${i} className="skeleton" style=${{ width: `${i === lines - 1 ? 60 : 100 - i * 6}%` }}></div>`)}
  </div>`;
}

export function Toggle({ checked, onChange, label, disabled, hint }) {
  return html`<label className=${cx('toggle', disabled && 'is-disabled')}>
    <input type="checkbox" checked=${!!checked} disabled=${disabled} onChange=${(e) => onChange && onChange(e.target.checked)} />
    <span className="toggle-track" aria-hidden="true"><span className="toggle-thumb"></span></span>
    ${label || hint
      ? html`<span className="toggle-text">
          ${label ? html`<span className="toggle-label">${label}</span>` : null}
          ${hint ? html`<span className="field-hint">${hint}</span>` : null}
        </span>`
      : null}
  </label>`;
}

export function Kbd({ children }) {
  return html`<kbd className="kbd">${children}</kbd>`;
}

// ---------------------------------------------------------------------------
// tabs

export function Tabs({ tabs = [], value, onChange, className = '' }) {
  return html`<div className=${cx('tabs', className)} role="tablist">
    ${tabs.map(
      (t) => html`<button
        key=${t.id}
        type="button"
        role="tab"
        aria-selected=${value === t.id ? 'true' : 'false'}
        className=${cx('tab', value === t.id && 'active')}
        onClick=${() => onChange && onChange(t.id)}
      >
        ${renderIcon(t.icon, 14)}
        <span>${t.label}</span>
        ${t.count !== undefined && t.count !== null ? html`<span className="tab-count">${t.count}</span>` : null}
      </button>`
    )}
  </div>`;
}

// ---------------------------------------------------------------------------
// form controls

export function Field({ label, hint, error, children, className = '', htmlFor, group }) {
  const asDiv = !!(group || htmlFor);
  const labelEl = label
    ? asDiv
      ? html`<label className="field-label" htmlFor=${htmlFor}>${label}</label>`
      : html`<span className="field-label">${label}</span>`
    : null;
  const note = error ? html`<span className="field-error">${error}</span>` : hint ? html`<span className="field-hint">${hint}</span>` : null;
  return asDiv
    ? html`<div className=${cx('field', className)}>${labelEl}${children}${note}</div>`
    : html`<label className=${cx('field', className)}>${labelEl}${children}${note}</label>`;
}

export function Input({ className = '', ...props }) {
  return html`<input className=${cx('input', className)} ...${props} />`;
}

export function TextArea({ className = '', autoGrow = false, ...props }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!autoGrow || !ref.current) return;
    const el = ref.current;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 2 + 'px';
  }, [autoGrow, props.value]);
  return html`<textarea ref=${ref} className=${cx('textarea', className)} ...${props}></textarea>`;
}

export function Select({ className = '', options, children, ...props }) {
  return html`<select className=${cx('select', className)} ...${props}>
    ${options
      ? options.map((o) => {
          const opt = typeof o === 'object' ? o : { value: o, label: o };
          return html`<option key=${String(opt.value)} value=${opt.value} disabled=${opt.disabled}>${opt.label ?? opt.value}</option>`;
        })
      : children}
  </select>`;
}

// ---------------------------------------------------------------------------
// modal

const modalStack = [];
let bodyLocks = 0;
let savedOverflow = '';

export function Modal({ open, title, onClose, children, footer, wide, className = '' }) {
  const ref = useRef(null);
  const downOnBackdrop = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const token = {};
    modalStack.push(token);
    if (bodyLocks++ === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    const prevFocus = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape' && modalStack[modalStack.length - 1] === token) {
        e.stopPropagation();
        onCloseRef.current && onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    const raf = requestAnimationFrame(() => {
      const el = ref.current;
      if (el && !el.contains(document.activeElement)) {
        const target = el.querySelector('[autofocus], .modal-body input, .modal-body textarea, .modal-body select');
        (target || el).focus({ preventScroll: true });
      }
    });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      const i = modalStack.indexOf(token);
      if (i >= 0) modalStack.splice(i, 1);
      if (--bodyLocks === 0) document.body.style.overflow = savedOverflow;
      if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;
  return html`<div
    className="modal-backdrop"
    onMouseDown=${(e) => {
      downOnBackdrop.current = e.target === e.currentTarget;
    }}
    onClick=${(e) => {
      if (e.target === e.currentTarget && downOnBackdrop.current) onCloseRef.current && onCloseRef.current();
      downOnBackdrop.current = false;
    }}
  >
    <div
      ref=${ref}
      className=${cx('modal', wide && 'modal-wide', className)}
      role="dialog"
      aria-modal="true"
      aria-label=${typeof title === 'string' ? title : undefined}
      tabIndex=${-1}
    >
      <div className="modal-header">
        <h2 className="modal-title">${title}</h2>
        <button type="button" className="btn btn-ghost btn-sm btn-icon modal-close" onClick=${() => onCloseRef.current && onCloseRef.current()} aria-label="Close">
          <${Icon} name="x" size=${16} />
        </button>
      </div>
      <div className="modal-body">${children}</div>
      ${footer ? html`<div className="modal-footer">${footer}</div>` : null}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// toasts

const TOAST_ICON = { info: 'info', success: 'check', error: 'alert' };

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return html`<div className="toast-stack" role="status" aria-live="polite">
    ${toasts.map(
      (t) => html`<div key=${t.id} className=${cx('toast', `toast-${t.kind}`)}>
        <span className="toast-icon"><${Icon} name=${TOAST_ICON[t.kind] || 'info'} size=${16} /></span>
        <div className="toast-msg">${t.message}</div>
        <button type="button" className="toast-close" onClick=${() => dismissToast(t.id)} aria-label="Dismiss">
          <${Icon} name="x" size=${14} />
        </button>
      </div>`
    )}
  </div>`;
}

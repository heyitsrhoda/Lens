// Analytics (#/analytics) — how posts and outreach are landing.
// Data: state.linkedinFeed (mock LinkedIn activity), drafts, threads. All charts are inline SVG,
// themed through CSS classes that use the design tokens (see css/views-d.css).
import { html, useState, useEffect, useMemo, useRef } from '../lib.js';
import { useStore } from '../store.js';
import { navigate } from '../router.js';
import { Button, Empty, Icon, cx } from '../ui.js';

const DAY = 86400000;
const EMPTY = Object.freeze([]);
const RANGES = [
  { id: 7, label: '7d', long: 'last 7 days' },
  { id: 30, label: '30d', long: 'last 30 days' },
  { id: 90, label: '90d', long: 'last 90 days' },
];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const BUCKETS = [
  { label: 'Early', short: '6–9a', range: '6–9 am', from: 6, to: 9 },
  { label: 'Morning', short: '9–12', range: '9 am–12 pm', from: 9, to: 12 },
  { label: 'Midday', short: '12–2p', range: '12–2 pm', from: 12, to: 14 },
  { label: 'Afternoon', short: '2–5p', range: '2–5 pm', from: 14, to: 17 },
  { label: 'Evening', short: '5–9p', range: '5–9 pm', from: 17, to: 21 },
  { label: 'Night', short: 'Night', range: '9 pm–6 am', from: 21, to: 30 },
];

/* ------------------------------------------------------------------ */
/* formatting                                                          */
/* ------------------------------------------------------------------ */

const compactFmt = (() => {
  try {
    return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
  } catch {
    return null;
  }
})();

function fmtNum(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 10000 && compactFmt) return compactFmt.format(v);
  return Math.round(v).toLocaleString();
}

function fmtPct(x, digits = 1) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

function fmtDay(ms, opts = { month: 'short', day: 'numeric' }) {
  try {
    return new Intl.DateTimeFormat(undefined, opts).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleDateString();
  }
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/* ------------------------------------------------------------------ */
/* data shaping                                                        */
/* ------------------------------------------------------------------ */

function time(iso) {
  if (!iso) return NaN;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function hash(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// LinkedIn is mocked. Seeded feed items carry metrics; a post published in this session starts at
// zero, so its reach is simulated deterministically from its id and age (grows, then plateaus).
function metricsOf(e, now) {
  const base = {
    impressions: num(e.impressions),
    reactions: num(e.reactions),
    comments: num(e.comments),
    reposts: num(e.reposts),
    profileViews: num(e.profileViews),
  };
  if (e.kind !== 'post' || base.impressions > 0) return base;
  const at = time(e.at);
  const ageH = Number.isFinite(at) ? Math.max(0, (now - at) / 3600000) : 0;
  const h = hash(e.id || e.at || e.body || '');
  const impressions = Math.round((450 + (h % 1600)) * (1 - Math.exp(-ageH / 20)));
  const eng = impressions * (0.025 + ((h >>> 8) % 30) / 1000);
  return {
    impressions,
    reactions: Math.max(base.reactions, Math.round(eng * 0.72)),
    comments: Math.max(base.comments, Math.round(eng * 0.2)),
    reposts: Math.max(base.reposts, Math.round(eng * 0.08)),
    profileViews: Math.max(base.profileViews, Math.round(impressions * 0.012)),
  };
}

function topicOf(e, draft) {
  if (e.painPoint) return e.painPoint;
  const src = (draft && draft.source) || e.source;
  if (draft && draft.painPoint) return draft.painPoint;
  if (src) {
    if (src.type === 'pain' && src.label) return src.label;
    if (src.type === 'idea' || src.type === 'free') return 'Your ideas';
    if (src.type === 'trend') return 'Trends';
  }
  return 'Other';
}

function normalizeFeed(feed, draftsById, now) {
  const out = [];
  for (const e of feed || EMPTY) {
    if (!e) continue;
    const at = time(e.at);
    if (!Number.isFinite(at)) continue;
    const draft = e.draftId ? draftsById.get(e.draftId) : null;
    const m = metricsOf(e, now);
    out.push({
      id: e.id || `${e.kind}-${at}`,
      kind: e.kind === 'reply' || e.kind === 'dm' ? e.kind : 'post',
      at,
      body: e.body || (draft && draft.body) || '',
      draftId: draft ? draft.id : null,
      topic: topicOf(e, draft),
      ...m,
      engagements: m.reactions + m.comments + m.reposts,
    });
  }
  return out;
}

const inWindow = (t, from, to) => Number.isFinite(t) && t >= from && t < to;

function countOutreach(items, drafts, from, to) {
  const counted = new Set();
  let n = 0;
  for (const d of drafts) {
    if ((d.kind === 'reply' || d.kind === 'dm') && d.status === 'sent' && inWindow(time(d.postedAt || d.updatedAt), from, to)) {
      n++;
      counted.add(d.id);
    }
  }
  for (const i of items) {
    if (i.kind !== 'post' && inWindow(i.at, from, to) && !(i.draftId && counted.has(i.draftId))) n++;
  }
  return n;
}

function summarize(items, drafts, threads, from, to) {
  const posts = items.filter((i) => i.kind === 'post' && inWindow(i.at, from, to));
  let impressions = 0;
  let engagements = 0;
  let followers = 0;
  for (const p of posts) {
    impressions += p.impressions;
    engagements += p.engagements;
    // Mock: a share of profile visitors follow (plus a few from reactions).
    followers += Math.round(p.profileViews * 0.22 + p.reactions * 0.03);
  }
  return {
    posts: posts.length,
    impressions,
    engagements,
    rate: impressions > 0 ? engagements / impressions : null,
    followers,
    outreach: countOutreach(items, drafts, from, to),
    found: threads.filter((t) => t && inWindow(time(t.foundAt || t.publishedAt), from, to)).length,
  };
}

function delta(cur, prev, mode = 'pct') {
  if (cur === null || cur === undefined) return null;
  if (mode === 'pts') {
    if (prev === null || prev === undefined) return null;
    const d = (cur - prev) * 100;
    if (Math.abs(d) < 0.05) return { dir: 'flat', text: '±0 pts' };
    return { dir: d > 0 ? 'up' : 'down', text: `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} pts` };
  }
  if (!prev) return cur > 0 ? { dir: 'up', text: 'new' } : null;
  const d = (cur - prev) / prev;
  if (Math.abs(d) < 0.005) return { dir: 'flat', text: '±0%' };
  return { dir: d > 0 ? 'up' : 'down', text: `${d > 0 ? '+' : '−'}${Math.round(Math.abs(d) * 100)}%` };
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeek(ms) {
  const d = new Date(startOfDay(ms));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function shiftDays(ms, days) {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

// 7d → daily bars; 30d → 8 weekly bars; 90d → 13 weekly bars.
function impressionBins(items, range, now) {
  const posts = items.filter((i) => i.kind === 'post');
  const daily = range === 7;
  const n = daily ? 7 : range === 90 ? 13 : 8;
  const last = daily ? startOfDay(now) : startOfWeek(now);
  const rangeStart = now - range * DAY;
  const bins = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = shiftDays(last, -(daily ? 1 : 7) * i);
    const end = shiftDays(start, daily ? 1 : 7);
    let impressions = 0;
    let count = 0;
    for (const p of posts) {
      if (p.at >= start && p.at < end) {
        impressions += p.impressions;
        count++;
      }
    }
    bins.push({
      start,
      end,
      impressions,
      count,
      current: i === 0,
      inRange: end > rangeStart,
      label: daily ? fmtDay(start, { weekday: 'short' }) : fmtDay(start),
      long: daily
        ? fmtDay(start, { weekday: 'long', month: 'short', day: 'numeric' })
        : `Week of ${fmtDay(start, { month: 'short', day: 'numeric' })}${i === 0 ? ' (so far)' : ''}`,
    });
  }
  return { bins, daily };
}

function byTopic(posts) {
  const map = new Map();
  for (const p of posts) {
    const g = map.get(p.topic) || { topic: p.topic, posts: 0, impressions: 0, engagements: 0 };
    g.posts++;
    g.impressions += p.impressions;
    g.engagements += p.engagements;
    map.set(p.topic, g);
  }
  return Array.from(map.values())
    .map((g) => ({ ...g, rate: g.impressions > 0 ? g.engagements / g.impressions : 0 }))
    .sort((a, b) => b.rate - a.rate || b.engagements - a.engagements)
    .slice(0, 8);
}

function funnelOf(items, drafts, threads, from, to) {
  const outreach = drafts.filter((d) => (d.kind === 'reply' || d.kind === 'dm') && inWindow(time(d.createdAt), from, to));
  const sent = countOutreach(items, drafts, from, to);
  // Anything sent was approved, and anything approved was drafted — keep the funnel monotonic.
  const approved = Math.max(sent, outreach.filter((d) => d.status === 'approved' || d.status === 'sent').length);
  const drafted = Math.max(approved, outreach.length);
  const found = threads.filter((t) => t && t.status !== 'dismissed' && inWindow(time(t.foundAt || t.publishedAt), from, to)).length;
  return [
    { id: 'found', label: 'Conversations found', value: found },
    { id: 'drafted', label: 'Replies & DMs drafted', value: drafted },
    { id: 'approved', label: 'Approved', value: approved },
    { id: 'sent', label: 'Sent', value: sent },
    // Mock: LinkedIn replies aren't real, so estimate a typical response rate.
    { id: 'replied', label: 'Replied', value: Math.round(sent * 0.38), simulated: true },
  ];
}

function bucketIndex(hour) {
  for (let i = 0; i < BUCKETS.length - 1; i++) if (hour >= BUCKETS[i].from && hour < BUCKETS[i].to) return i;
  return BUCKETS.length - 1;
}

function heatmapOf(items, now) {
  const from = now - 90 * DAY;
  const cells = WEEKDAYS.map(() => BUCKETS.map(() => ({ posts: 0, impressions: 0, engagements: 0 })));
  for (const p of items) {
    if (p.kind !== 'post' || p.at < from) continue;
    const d = new Date(p.at);
    const c = cells[(d.getDay() + 6) % 7][bucketIndex(d.getHours())];
    c.posts++;
    c.impressions += p.impressions;
    c.engagements += p.engagements;
  }
  let max = -Infinity;
  let min = Infinity;
  let best = null;
  cells.forEach((row, r) =>
    row.forEach((c, b) => {
      c.rate = c.impressions > 0 ? c.engagements / c.impressions : c.posts ? 0 : null;
      if (c.rate === null) return;
      max = Math.max(max, c.rate);
      min = Math.min(min, c.rate);
      if (!best || c.rate > best.rate) best = { r, b, rate: c.rate };
    })
  );
  // Sequential scale stretched over the observed range so small differences stay visible.
  const spread = max - min;
  cells.forEach((row) =>
    row.forEach((c) => {
      c.intensity = c.rate === null ? 0 : spread > 1e-9 ? 0.22 + 0.78 * ((c.rate - min) / spread) : 0.7;
    })
  );
  return { cells, best };
}

/* ------------------------------------------------------------------ */
/* chart plumbing: width + tooltip                                     */
/* ------------------------------------------------------------------ */

function useChart() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  const [tip, setTip] = useState(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => setWidth(Math.round(el.clientWidth));
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Spread onto any SVG mark: hover, tap and keyboard focus all show the same tooltip.
  function mark(content, label) {
    const show = (e) => {
      const el = ref.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      let x;
      let y;
      if (e && typeof e.clientX === 'number' && e.type !== 'focus' && (e.clientX || e.clientY)) {
        x = e.clientX - box.left;
        y = e.clientY - box.top;
      } else {
        const r = e.currentTarget.getBoundingClientRect();
        x = r.left + r.width / 2 - box.left;
        y = r.top - box.top;
      }
      setTip({ x, y, content, w: box.width });
    };
    const hide = () => setTip(null);
    return {
      tabIndex: 0,
      role: 'img',
      'aria-label': label,
      onMouseEnter: show,
      onMouseMove: show,
      onMouseLeave: hide,
      onFocus: show,
      onBlur: hide,
      onClick: show,
    };
  }

  const tipEl = tip
    ? html`<div
        className="an-tip"
        role="presentation"
        style=${{ left: `${Math.max(84, Math.min(tip.x, tip.w - 84))}px`, top: `${tip.y}px` }}
      >
        ${tip.content}
      </div>`
    : null;

  return { ref, width, mark, tipEl, hide: () => setTip(null) };
}

function TipBody({ title, rows }) {
  return html`<div className="an-tip-title">${title}</div>
    ${rows.filter(Boolean).map(
      ([k, v]) => html`<div key=${k} className="an-tip-row"><span>${k}</span><strong>${v}</strong></div>`
    )}`;
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  for (const s of [1, 2, 2.5, 5, 10]) if (s * exp >= v) return s * exp;
  return 10 * exp;
}

function barUp(x, y, w, h, r = 4) {
  if (h <= 0 || w <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function barRight(x, y, w, h, r = 4) {
  if (h <= 0 || w <= 0) return '';
  const rr = Math.min(r, h / 2, w);
  return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z`;
}

function ChartEmpty({ icon = 'chart', children }) {
  return html`<div className="an-chart-empty"><${Icon} name=${icon} size=${18} /><span>${children}</span></div>`;
}

/* ------------------------------------------------------------------ */
/* charts                                                              */
/* ------------------------------------------------------------------ */

function ImpressionsChart({ items, range, now }) {
  const c = useChart();
  const { bins, daily } = useMemo(() => impressionBins(items, range, now), [items, range, now]);
  const total = bins.reduce((a, b) => a + b.impressions, 0);
  const W = c.width;
  const H = 220;
  const m = { top: 22, right: 8, bottom: 28, left: 44 };
  const pw = Math.max(0, W - m.left - m.right);
  const ph = H - m.top - m.bottom;
  const max = niceMax(Math.max(...bins.map((b) => b.impressions)));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const band = bins.length ? pw / bins.length : 0;
  const bw = Math.max(4, Math.min(36, band * 0.62));
  const every = Math.max(1, Math.ceil((bins.length * 46) / Math.max(pw, 1)));
  const last = bins[bins.length - 1];
  const summary = `Impressions per ${daily ? 'day' : 'week'}, ${bins.length} ${daily ? 'days' : 'weeks'}: ${bins
    .map((b) => `${b.label} ${b.impressions}`)
    .join(', ')}.`;

  return html`<div className="an-chart" ref=${c.ref} onMouseLeave=${c.hide}>
    ${total === 0
      ? html`<${ChartEmpty}>No impressions yet — published posts will show up here.<//>`
      : W > 0
        ? html`<svg width=${W} height=${H} viewBox=${`0 0 ${W} ${H}`} role="group" aria-label=${summary}>
            <title>${summary}</title>
            ${ticks.map(
              (t, i) => html`<g key=${`t${i}`}>
                <line className="an-grid" x1=${m.left} x2=${W - m.right} y1=${m.top + ph - (t / max) * ph} y2=${m.top + ph - (t / max) * ph} />
                <text className="an-axis" x=${m.left - 8} y=${m.top + ph - (t / max) * ph} dy="0.32em" textAnchor="end">${fmtNum(t)}</text>
              </g>`
            )}
            ${bins.map((b, i) => {
              const h = (b.impressions / max) * ph;
              const x = m.left + i * band + (band - bw) / 2;
              const y = m.top + ph - h;
              const content = html`<${TipBody}
                title=${b.long}
                rows=${[
                  ['Impressions', fmtNum(b.impressions)],
                  ['Posts', String(b.count)],
                ]}
              />`;
              return html`<g key=${`${range}-${b.start}`} className="an-col">
                <path className=${cx('an-bar', 'an-bar-v', !b.inRange && 'is-muted')} d=${barUp(x, y, bw, h)} />
                <rect
                  className="an-hit"
                  x=${m.left + i * band}
                  y=${m.top}
                  width=${band}
                  height=${ph}
                  ...${c.mark(content, `${b.long}: ${b.impressions} impressions from ${plural(b.count, 'post')}`)}
                />
                ${i % every === (bins.length - 1) % every
                  ? html`<text className=${cx('an-axis', b.current && 'is-strong')} x=${m.left + i * band + band / 2} y=${H - 8} textAnchor="middle">
                      ${b.current ? (daily ? 'Today' : 'This wk') : b.label}
                    </text>`
                  : null}
              </g>`;
            })}
            ${last && last.impressions > 0
              ? html`<text
                  className="an-value"
                  x=${m.left + (bins.length - 1) * band + band / 2}
                  y=${m.top + ph - (last.impressions / max) * ph - 6}
                  textAnchor="middle"
                >
                  ${fmtNum(last.impressions)}
                </text>`
              : null}
            <line className="an-baseline" x1=${m.left} x2=${W - m.right} y1=${m.top + ph} y2=${m.top + ph} />
          </svg>`
        : null}
    ${c.tipEl}
  </div>`;
}

function TopicChart({ posts }) {
  const c = useChart();
  const rows = useMemo(() => byTopic(posts), [posts]);
  const W = c.width;
  const rowH = 46;
  const H = rows.length * rowH + 4;
  const max = Math.max(...rows.map((r) => r.rate), 0) || 1;
  const summary = `Engagement rate by pain point: ${rows.map((r) => `${r.topic} ${fmtPct(r.rate)}`).join(', ')}.`;

  return html`<div className="an-chart" ref=${c.ref} onMouseLeave=${c.hide}>
    ${rows.length === 0
      ? html`<${ChartEmpty} icon="target">No posts in this range yet.<//>`
      : W > 0
        ? html`<svg width=${W} height=${H} viewBox=${`0 0 ${W} ${H}`} role="group" aria-label=${summary}>
            <title>${summary}</title>
            ${rows.map((r, i) => {
              const y = i * rowH;
              const w = Math.max(3, (r.rate / max) * W);
              const label = `${fmtPct(r.rate)} · ${plural(r.posts, 'post')}`;
              const maxChars = Math.max(12, Math.floor((W - label.length * 7 - 16) / 7));
              const content = html`<${TipBody}
                title=${r.topic}
                rows=${[
                  ['Engagement rate', fmtPct(r.rate)],
                  ['Engagements', fmtNum(r.engagements)],
                  ['Impressions', fmtNum(r.impressions)],
                  ['Posts', String(r.posts)],
                ]}
              />`;
              return html`<g key=${r.topic} className="an-col">
                <text className="an-label" x="0" y=${y + 14}>${clip(r.topic, maxChars)}</text>
                <text className="an-label-value" x=${W} y=${y + 14} textAnchor="end">${label}</text>
                <rect className="an-track" x="0" y=${y + 22} width=${W} height="12" rx="4" />
                <path className=${cx('an-bar', 'an-bar-h', i === 0 && 'is-top')} d=${barRight(0, y + 22, w, 12)} />
                <rect
                  className="an-hit"
                  x="0"
                  y=${y}
                  width=${W}
                  height=${rowH - 4}
                  ...${c.mark(content, `${r.topic}: ${fmtPct(r.rate)} engagement rate across ${plural(r.posts, 'post')}`)}
                />
              </g>`;
            })}
          </svg>`
        : null}
    ${c.tipEl}
  </div>`;
}

function FunnelChart({ stages }) {
  const c = useChart();
  const W = c.width;
  const rowH = 52;
  const H = stages.length * rowH;
  const max = Math.max(...stages.map((s) => s.value), 0);
  const summary = `Outreach funnel: ${stages.map((s) => `${s.label} ${s.value}`).join(', ')}.`;

  return html`<div className="an-chart" ref=${c.ref} onMouseLeave=${c.hide}>
    ${max === 0
      ? html`<${ChartEmpty} icon="inbox">No outreach in this range yet — draft a reply from Discover.<//>`
      : W > 0
        ? html`<svg width=${W} height=${H} viewBox=${`0 0 ${W} ${H}`} role="group" aria-label=${summary}>
            <title>${summary}</title>
            ${stages.map((s, i) => {
              const y = i * rowH;
              const w = s.value > 0 ? Math.max(6, (s.value / max) * W) : 0;
              const prev = i > 0 ? stages[i - 1].value : null;
              const conv = prev ? s.value / prev : null;
              const content = html`<${TipBody}
                title=${s.simulated ? `${s.label} (simulated)` : s.label}
                rows=${[
                  ['Count', fmtNum(s.value)],
                  conv !== null ? ['From previous step', fmtPct(conv, 0)] : null,
                  i > 0 && stages[0].value ? ['From found', fmtPct(s.value / stages[0].value, 0)] : null,
                ]}
              />`;
              return html`<g key=${s.id} className="an-col">
                <text className="an-label" x="0" y=${y + 14}>${s.label}${s.simulated ? ' (simulated)' : ''}</text>
                <text className="an-label-value" x=${W} y=${y + 14} textAnchor="end">
                  ${fmtNum(s.value)}${conv !== null ? html`<tspan className="an-conv"> · ${fmtPct(conv, 0)}</tspan>` : null}
                </text>
                <rect className="an-track" x="0" y=${y + 22} width=${W} height="18" rx="4" />
                ${w > 0
                  ? html`<rect
                      className=${cx('an-bar', 'an-bar-h', 'an-funnel-bar', s.simulated && 'is-simulated')}
                      x=${(W - w) / 2}
                      y=${y + 22}
                      width=${w}
                      height="18"
                      rx="4"
                    />`
                  : null}
                <rect
                  className="an-hit"
                  x="0"
                  y=${y}
                  width=${W}
                  height=${rowH - 6}
                  ...${c.mark(content, `${s.label}${s.simulated ? ' (simulated)' : ''}: ${s.value}${conv !== null ? `, ${fmtPct(conv, 0)} of the previous step` : ''}`)}
                />
              </g>`;
            })}
          </svg>`
        : null}
    ${c.tipEl}
  </div>`;
}

function Heatmap({ items, now }) {
  const c = useChart();
  const { cells, best } = useMemo(() => heatmapOf(items, now), [items, now]);
  const W = c.width;
  const left = 38;
  const top = 24;
  const gap = 3;
  const cw = Math.max(0, (W - left) / BUCKETS.length);
  const ch = 30;
  const H = top + WEEKDAYS.length * ch + 2;
  const wide = cw >= 76;
  const any = cells.some((row) => row.some((x) => x.posts > 0));
  const summary = best
    ? `Posting-time heatmap, engagement rate by weekday and time of day over the last 90 days. Best slot: ${WEEKDAYS_LONG[best.r]} ${BUCKETS[best.b].label.toLowerCase()} at ${fmtPct(best.rate)}.`
    : 'Posting-time heatmap: no posts yet.';

  return html`<div className="an-chart" ref=${c.ref} onMouseLeave=${c.hide}>
    ${!any
      ? html`<${ChartEmpty} icon="clock">Publish a few posts to see when your audience engages most.<//>`
      : W > 0
        ? html`<svg width=${W} height=${H} viewBox=${`0 0 ${W} ${H}`} role="group" aria-label=${summary}>
            <title>${summary}</title>
            ${BUCKETS.map(
              (b, j) => html`<text key=${`h${j}`} className="an-axis" x=${left + j * cw + cw / 2} y="12" textAnchor="middle">${wide ? b.label : b.short}</text>`
            )}
            ${WEEKDAYS.map(
              (d, i) => html`<g key=${d}>
                <text className="an-axis" x="0" y=${top + i * ch + ch / 2} dy="0.32em">${d}</text>
                ${cells[i].map((cell, j) => {
                  const isBest = best && best.r === i && best.b === j;
                  const label = cell.posts
                    ? `${WEEKDAYS_LONG[i]} ${BUCKETS[j].label.toLowerCase()} (${BUCKETS[j].range}): ${fmtPct(cell.rate)} engagement across ${plural(cell.posts, 'post')}`
                    : `${WEEKDAYS_LONG[i]} ${BUCKETS[j].label.toLowerCase()}: no posts yet`;
                  const content = html`<${TipBody}
                    title=${`${WEEKDAYS_LONG[i]} · ${BUCKETS[j].label} (${BUCKETS[j].range})`}
                    rows=${cell.posts
                      ? [
                          ['Engagement rate', fmtPct(cell.rate)],
                          ['Posts', String(cell.posts)],
                          ['Impressions', fmtNum(cell.impressions)],
                        ]
                      : [['Posts', 'none yet']]}
                  />`;
                  return html`<rect
                    key=${j}
                    className=${cx('an-cell', cell.posts ? 'has-data' : 'is-empty', isBest && 'is-best')}
                    x=${left + j * cw + gap / 2}
                    y=${top + i * ch + gap / 2}
                    width=${Math.max(0, cw - gap)}
                    height=${ch - gap}
                    rx="4"
                    style=${cell.posts ? { fillOpacity: cell.intensity } : undefined}
                    ...${c.mark(content, label)}
                  />`;
                })}
              </g>`
            )}
          </svg>`
        : null}
    ${any
      ? html`<div className="an-heat-foot small">
          ${best
            ? html`<span><${Icon} name="star" size=${13} /> Best so far: <strong>${WEEKDAYS_LONG[best.r]} ${BUCKETS[best.b].label.toLowerCase()}</strong> (${fmtPct(best.rate)})</span>`
            : null}
          <span className="an-scale" aria-hidden="true">
            <span>Lower</span>
            ${[0.22, 0.42, 0.61, 0.8, 1].map((o) => html`<i key=${o} style=${{ opacity: o }}></i>`)}
            <span>Higher</span>
          </span>
        </div>`
      : null}
    ${c.tipEl}
  </div>`;
}

function TopPosts({ posts, drafts }) {
  const draftIds = useMemo(() => new Set(drafts.map((d) => d.id)), [drafts]);
  const top = useMemo(() => [...posts].sort((a, b) => b.impressions - a.impressions || b.engagements - a.engagements).slice(0, 5), [posts]);
  if (!top.length) return html`<${ChartEmpty} icon="list">No posts published in this range.<//>`;
  return html`<div className="an-table-wrap">
    <table className="an-table">
      <thead>
        <tr>
          <th scope="col">Post</th>
          <th scope="col" className="an-col-date">Date</th>
          <th scope="col" className="num">Impressions</th>
          <th scope="col" className="num">Eng. rate</th>
          <th scope="col" className="an-col-act"><span className="sr-only">Open</span></th>
        </tr>
      </thead>
      <tbody>
        ${top.map((p, i) => {
          const rate = p.impressions > 0 ? p.engagements / p.impressions : null;
          const canOpen = p.draftId && draftIds.has(p.draftId);
          return html`<tr key=${p.id}>
            <td className="an-post">
              <span className="an-rank">${i + 1}</span>
              <span className="an-post-text">
                <span className="an-excerpt">${clip(String(p.body).split('\n').find((l) => l.trim()) || p.body, 110) || 'Untitled post'}</span>
                <span className="an-post-meta small muted">${p.topic}<span className="an-date-inline"> · ${fmtDay(p.at)}</span></span>
              </span>
            </td>
            <td className="an-col-date muted">${fmtDay(p.at)}</td>
            <td className="num">${fmtNum(p.impressions)}</td>
            <td className="num">${fmtPct(rate)}</td>
            <td className="an-col-act">
              ${canOpen
                ? html`<a
                    className="btn btn-ghost btn-sm"
                    href=${`#/studio?draft=${encodeURIComponent(p.draftId)}`}
                    onClick=${(e) => {
                      e.preventDefault();
                      navigate(`/studio?draft=${encodeURIComponent(p.draftId)}`);
                    }}
                    aria-label="Open in Studio"
                    title="Open in Studio"
                  >
                    <${Icon} name="edit" size=${14} /><span className="an-open-label">Studio</span>
                  </a>`
                : null}
            </td>
          </tr>`;
        })}
      </tbody>
    </table>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* KPI tiles                                                           */
/* ------------------------------------------------------------------ */

function Kpi({ icon, label, value, d, hint, invert = false }) {
  const good = d && d.dir !== 'flat' ? (d.dir === 'up') !== invert : null;
  return html`<div className="an-kpi">
    <div className="an-kpi-label"><${Icon} name=${icon} size=${14} />${label}</div>
    <div className="an-kpi-value">${value}</div>
    <div className="an-kpi-foot">
      ${d
        ? html`<span className=${cx('an-delta', good === true && 'is-good', good === false && 'is-bad')}>
            ${d.dir === 'flat'
              ? html`<${Icon} name="minus" size=${12} />`
              : html`<${Icon} name="trending" size=${12} className=${d.dir === 'down' ? 'an-flip' : ''} />`}
            ${d.text}
          </span>`
        : html`<span className="an-delta">—</span>`}
      <span className="an-kpi-hint">${hint}</span>
    </div>
  </div>`;
}

function RangeToggle({ value, onChange }) {
  return html`<div className="an-range" role="radiogroup" aria-label="Date range">
    ${RANGES.map(
      (r) => html`<button
        key=${r.id}
        type="button"
        role="radio"
        aria-checked=${value === r.id ? 'true' : 'false'}
        className=${cx('an-range-btn', value === r.id && 'is-active')}
        onClick=${() => onChange(r.id)}
        title=${r.long}
      >
        ${r.label}
      </button>`
    )}
  </div>`;
}

function Panel({ title, subtitle, icon, children, className }) {
  return html`<section className=${cx('card', 'an-panel', className)}>
    <div className="card-header">
      <div className="card-heading">
        <h3 className="card-title"><${Icon} name=${icon} size=${16} />${title}</h3>
        ${subtitle ? html`<p className="card-sub">${subtitle}</p>` : null}
      </div>
    </div>
    <div className="card-body">${children}</div>
  </section>`;
}

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */

function readRange() {
  try {
    const v = Number(sessionStorage.getItem('lens_analytics_range'));
    return RANGES.some((r) => r.id === v) ? v : 30;
  } catch {
    return 30;
  }
}

export default function Analytics() {
  const feed = useStore((s) => s.linkedinFeed) || EMPTY;
  const drafts = useStore((s) => s.drafts) || EMPTY;
  const threads = useStore((s) => s.threads) || EMPTY;
  const demoMode = useStore((s) => !!(s.settings && s.settings.demoMode));
  const [range, setRangeState] = useState(readRange);
  // Re-evaluate "now" every minute so simulated reach keeps growing while the page is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  const setRange = (r) => {
    setRangeState(r);
    try {
      sessionStorage.setItem('lens_analytics_range', String(r));
    } catch {
      /* storage unavailable */
    }
  };

  const draftsById = useMemo(() => new Map(drafts.map((d) => [d.id, d])), [drafts]);
  const items = useMemo(() => normalizeFeed(feed, draftsById, now), [feed, draftsById, now]);
  const from = now - range * DAY;
  const prevFrom = now - 2 * range * DAY;
  const cur = useMemo(() => summarize(items, drafts, threads, from, now + 1), [items, drafts, threads, from, now]);
  const prev = useMemo(() => summarize(items, drafts, threads, prevFrom, from), [items, drafts, threads, prevFrom, from]);
  const postsInRange = useMemo(() => items.filter((i) => i.kind === 'post' && i.at >= from), [items, from]);
  const funnel = useMemo(() => funnelOf(items, drafts, threads, from, now + 1), [items, drafts, threads, from, now]);
  const rangeLabel = RANGES.find((r) => r.id === range).long;
  const vs = `vs prior ${range}d`;

  const nothing = !items.length && !drafts.length && !threads.length;

  return html`<div className="page an-page">
    <header className="page-header">
      <h1>Analytics</h1>
      <p className="page-sub">How your posts and outreach are landing — ${rangeLabel}, compared with the ${range} days before.</p>
      <div className="page-actions"><${RangeToggle} value=${range} onChange=${setRange} /></div>
    </header>

    ${nothing
      ? html`<${Empty}
          icon="chart"
          title="Nothing to measure yet"
          body="Approve a few posts and send some replies — impressions, engagement and your outreach funnel will appear here."
          action=${html`<${Button} variant="primary" icon="layers" onClick=${() => navigate('/stack')}>Review your stack<//>
            <${Button} variant="secondary" icon="search" onClick=${() => navigate('/discover')}>Find conversations<//>`}
        />`
      : html`
          <div className="an-kpis">
            <${Kpi} icon="eye" label="Impressions" value=${fmtNum(cur.impressions)} d=${delta(cur.impressions, prev.impressions)} hint=${vs} />
            <${Kpi}
              icon="heart"
              label="Engagement rate"
              value=${fmtPct(cur.rate)}
              d=${delta(cur.rate, prev.rate, 'pts')}
              hint=${cur.posts ? `${plural(cur.posts, 'post')} · ${vs}` : vs}
            />
            <${Kpi} icon="users" label="Followers gained" value=${`+${fmtNum(cur.followers)}`} d=${delta(cur.followers, prev.followers)} hint=${`est. · ${vs}`} />
            <${Kpi} icon="send" label="Replies & DMs sent" value=${fmtNum(cur.outreach)} d=${delta(cur.outreach, prev.outreach)} hint=${vs} />
            <${Kpi} icon="search" label="Conversations found" value=${fmtNum(cur.found)} d=${delta(cur.found, prev.found)} hint=${vs} />
          </div>

          <div className="an-grid-2">
            <${Panel}
              title="Impressions"
              icon="chart"
              subtitle=${range === 7 ? 'Per day, last 7 days' : `Per week, last ${range === 90 ? 13 : 8} weeks${range === 30 ? ' · lighter bars fall outside the range' : ''}`}
              className="an-span-2"
            >
              <${ImpressionsChart} items=${items} range=${range} now=${now} />
            <//>
            <${Panel} title="Engagement by pain point" icon="target" subtitle="Engagement rate of posts in range, best first">
              <${TopicChart} posts=${postsInRange} />
            <//>
            <${Panel} title="Outreach funnel" icon="filter" subtitle="Conversations → replies, with step conversion">
              <${FunnelChart} stages=${funnel} />
            <//>
            <${Panel} title="Best posting times" icon="clock" subtitle="Engagement rate by weekday and time of day · last 90 days" className="an-span-2">
              <${Heatmap} items=${items} now=${now} />
            <//>
            <${Panel} title="Top posts" icon="trending" subtitle=${`By impressions, ${rangeLabel}`} className="an-span-2">
              <${TopPosts} posts=${postsInRange} drafts=${drafts} />
            <//>
          </div>
        `}

    <p className="an-note small muted">
      <${Icon} name="info" size=${13} />
      ${`LinkedIn metrics are simulated in demo mode.${demoMode ? '' : ' LinkedIn is always a demo connection in Lens, so post metrics stay simulated.'} Follower and reply counts are estimates.`}
    </p>
  </div>`;
}

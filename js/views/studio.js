// Studio (#/studio) — Branch B: turn a recurring pain point into a LinkedIn post,
// attach a visual (upload / real Canva MCP / Sculptex 3D render), preview, schedule or post.
// Also exports small shared helpers + LinkedIn-style preview components used by
// outreach.js and schedule.js.
import { html, useState, useEffect, useMemo, useRef, useCallback } from '../lib.js';
import { useStore, setState, toast, uid } from '../store.js';
import { useRoute, navigate } from '../router.js';
import { Button, Badge, Empty, Spinner, Modal, Tabs, Field, Icon, SourceIcon, timeAgo } from '../ui.js';
import { draftPost, rewrite, sendDraft, scheduleDraft, renderWithSculptex, clusterPainPoints, postText } from '../services/lens.js';
import { CanvaPanel } from './canva.js';

/* ------------------------------------------------------------------ */
/* Shared helpers (exported)                                           */
/* ------------------------------------------------------------------ */

export function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

export function patchDraft(id, patch) {
  const now = new Date().toISOString();
  setState((s) => ({
    drafts: (s.drafts || []).map((d) => (d.id === id ? { ...d, ...patch, updatedAt: now } : d)),
  }));
}

export function wordCount(text) {
  const t = (text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

export function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Y';
  const first = parts[0][0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

// Builds a display profile from the mock LinkedIn connection, falling back to company info.
export function profileFrom(connections, company) {
  const p = (connections && connections.linkedin && connections.linkedin.profile) || null;
  const c = company || {};
  const name = (p && p.name) || (c.name ? `${c.name} founder` : 'You');
  const headline = (p && p.headline) || (c.name ? `Founder at ${c.name}` : 'Founder');
  const avatar = p && typeof p.avatar === 'string' ? p.avatar : '';
  const avatarUrl = (p && p.avatarUrl) || (/^(https?:|data:)/.test(avatar) ? avatar : null);
  const initials = (p && p.initials) || (avatar && avatar.length <= 3 ? avatar : initialsOf(name));
  return { name, headline, initials, avatarUrl };
}

export function useProfile() {
  const connections = useStore((s) => s.connections);
  const company = useStore((s) => s.company);
  return useMemo(() => profileFrom(connections, company), [connections, company]);
}

export function firstLine(draft, max = 80) {
  const src = (draft && (draft.title || draft.body)) || '';
  const line = src.split('\n').map((l) => l.trim()).find(Boolean) || 'Untitled post';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

const pad2 = (n) => String(n).padStart(2, '0');

// Date -> 'YYYY-MM-DDTHH:mm' in local time (for <input type="datetime-local">)
export function toLocalInput(date) {
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 'YYYY-MM-DDTHH:mm' (local) -> Date, or null
export function fromLocalInput(value) {
  if (!value || typeof value !== 'string') return null;
  const [datePart, timePart = '00:00'] = value.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm] = timePart.split(':').map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0);
  return isNaN(dt.getTime()) ? null : dt;
}

// Next weekday (Mon–Fri) at h:m strictly after `from`.
export function nextWeekdayAt(h, m, from = new Date()) {
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  for (let i = 0; i < 8; i++) {
    const day = d.getDay();
    if (day !== 0 && day !== 6 && d > from) return d;
    d.setDate(d.getDate() + 1);
  }
  return d;
}

// Next occurrence of weekday `dow` (0=Sun) at h:m strictly after `from`.
export function nextDayAt(dow, h, m, from = new Date()) {
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  for (let i = 0; i < 8; i++) {
    if (d.getDay() === dow && d > from) return d;
    d.setDate(d.getDate() + 1);
  }
  return d;
}

export function fmtWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

export function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// Relative time that also handles the future ("in 3 h", "5 min ago").
export function relTime(iso, now = new Date()) {
  const diff = new Date(iso).getTime() - now.getTime();
  if (isNaN(diff)) return '';
  const mins = Math.round(Math.abs(diff) / 60000);
  let s;
  if (mins < 1) s = 'under a minute';
  else if (mins < 60) s = `${mins} min`;
  else if (mins < 60 * 24) s = `${Math.round(mins / 60)} h`;
  else s = `${Math.round(mins / 1440)} d`;
  return diff >= 0 ? `in ${s}` : `${s} ago`;
}

export const STATUS_META = {
  pending: { tone: 'neutral', label: 'Draft' },
  approved: { tone: 'info', label: 'Approved' },
  scheduled: { tone: 'accent', label: 'Scheduled' },
  posted: { tone: 'success', label: 'Posted' },
  sent: { tone: 'success', label: 'Sent' },
  rejected: { tone: 'danger', label: 'Rejected' },
};

export function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { tone: 'neutral', label: status || 'Draft' };
  return html`<${Badge} tone=${meta.tone}>${meta.label}<//>`;
}

// Text state that is edited locally and committed to the store after a pause
// (avoids serialising the whole state to localStorage on every keystroke).
// Returns [value, onChange(value), flush()].
export function useBufferedText(value, commit, delay = 450) {
  const [local, setLocal] = useState(value || '');
  const latest = useRef(value || '');
  const dirty = useRef(false);
  const timer = useRef(null);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    if (!dirty.current) {
      latest.current = value || '';
      setLocal(value || '');
    }
  }, [value]);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (dirty.current) {
      dirty.current = false;
      commitRef.current(latest.current);
    }
  }, []);

  const onChange = useCallback(
    (v) => {
      latest.current = v;
      dirty.current = true;
      setLocal(v);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, delay);
    },
    [delay, flush],
  );

  useEffect(() => () => flush(), [flush]);

  return [local, onChange, flush];
}

export function LinkedInAvatar({ profile, size = 40 }) {
  const style = { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.38)}px` };
  if (profile && profile.avatarUrl) {
    return html`<img className="li-avatar" style=${style} src=${profile.avatarUrl} alt="" />`;
  }
  return html`<span className="li-avatar" style=${style} aria-hidden="true">${(profile && profile.initials) || 'Y'}</span>`;
}

function renderRichText(text) {
  const parts = String(text || '').split(/(#[\p{L}\p{N}_]+)/u);
  return parts.map((p, i) => (i % 2 === 1 ? html`<span key=${i} className="li-hashtag">${p}</span>` : p));
}

const SEE_MORE_CHARS = 210;
const SEE_MORE_LINES = 3;

function truncateForFeed(text) {
  const t = String(text || '');
  const lines = t.split('\n');
  let cut = lines.slice(0, SEE_MORE_LINES).join('\n');
  if (cut.length > SEE_MORE_CHARS) cut = cut.slice(0, SEE_MORE_CHARS);
  const truncated = cut.length < t.trimEnd().length;
  return { truncated, text: truncated ? cut.trimEnd() : t };
}

function CanvaLinkCard({ link }) {
  return html`<a className="li-linkcard" href=${link} target="_blank" rel="noopener noreferrer">
    <span className="li-linkcard-icon"><${Icon} name="palette" size=${18} /></span>
    <span className="li-linkcard-text">
      <strong>Canva design</strong>
      <span className="small muted">Open in Canva · refresh the image from the Canva tab</span>
    </span>
    <${Icon} name="external" size=${14} />
  </a>`;
}

export function VisualMedia({ visual }) {
  // Canva export/thumbnail links are signed and expire; fall back to the "Open in Canva" card when one breaks.
  const [broken, setBroken] = useState(false);
  const src = visual ? visual.src : '';
  useEffect(() => setBroken(false), [src]);
  if (!visual) return null;
  if (src && !broken) {
    return html`<div className="li-media"><img src=${src} alt=${visual.caption || 'Post visual'} loading="lazy" onError=${() => setBroken(true)} /></div>`;
  }
  if (visual.type === 'canva' && visual.link) return html`<${CanvaLinkCard} link=${visual.link} />`;
  return null;
}

// LinkedIn-style feed post card.
export function PostPreview({ profile, title, body, visual, timeLabel = 'now', reactions, comments, defaultExpanded = false, className }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const full = postText({ title, body });
  const { truncated, text } = truncateForFeed(full);
  const showCounts = typeof reactions === 'number' || typeof comments === 'number';
  return html`<article className=${cx('li-card', className)}>
    <header className="li-head">
      <${LinkedInAvatar} profile=${profile} size=${44} />
      <div className="li-who">
        <div className="li-name">${profile.name}</div>
        <div className="li-headline truncate">${profile.headline}</div>
        <div className="li-meta">${timeLabel} · <span aria-label="Public">🌐</span></div>
      </div>
    </header>
    <div className="li-body">
      ${full
        ? html`<span>${renderRichText(expanded || !truncated ? full : text)}</span>${truncated
            ? html`${expanded ? ' ' : '… '}<button type="button" className="li-more" onClick=${() => setExpanded(!expanded)}>
                ${expanded ? 'show less' : 'see more'}
              </button>`
            : null}`
        : html`<span className="muted">Your post text will appear here.</span>`}
    </div>
    <${VisualMedia} visual=${visual} />
    ${showCounts
      ? html`<div className="li-counts small">
          <span className="li-reacts"><span>👍</span><span>❤️</span><span>💡</span> ${reactions || 0}</span>
          <span>${comments || 0} comment${comments === 1 ? '' : 's'}</span>
        </div>`
      : null}
    <div className="li-actions" aria-hidden="true">
      <span className="li-action"><${Icon} name="thumbsUp" size=${16} /> Like</span>
      <span className="li-action"><${Icon} name="chat" size=${16} /> Comment</span>
      <span className="li-action"><${Icon} name="repeat" size=${16} /> Repost</span>
      <span className="li-action"><${Icon} name="send" size=${16} /> Send</span>
    </div>
  </article>`;
}

/* ------------------------------------------------------------------ */
/* Studio internals                                                    */
/* ------------------------------------------------------------------ */

const REWRITE_CHIPS = ['Shorter', 'Stronger hook', 'Warmer', 'More specific', 'Remove the pitch'];

const BEST_TIMES = [
  { label: 'Tue 9:30', dow: 2, h: 9, m: 30 },
  { label: 'Wed 12:00', dow: 3, h: 12, m: 0 },
  { label: 'Thu 8:00', dow: 4, h: 8, m: 0 },
];

const MAX_UPLOAD_BYTES = 1.5 * 1024 * 1024;
const LINKEDIN_POST_LIMIT = 3000;

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

// Concrete, dimensioned prompts work best with Sculptex; map common maker pain points
// to a representative part, otherwise describe an object that stands for the pain point.
const SCULPTEX_PROMPTS = [
  { re: /replace|broke|broken|spare|discontinu/i, prompt: 'a clip 18 mm wide that snaps onto a 6 mm rod, 2 mm walls, 0.3 mm clearance' },
  { re: /mesh|printable|manifold|text-to-3d|\bai\b/i, prompt: 'phone mount for a 78 mm wide phone, 2.4 mm walls, 15° tilt, two M4 screw holes' },
  { re: /\bcad\b|learning curve|fusion|onshape/i, prompt: 'enclosure 80 × 50 × 30 mm with four M3 standoffs and a USB-C cutout on the short side' },
  { re: /toleran|dimension|\bfits?\b|clearance/i, prompt: 'bearing seat for a 608 bearing, 22 mm bore, press fit with 0.1 mm interference and three crush ribs' },
  { re: /parametr|resiz|tweak|custom size/i, prompt: 'drawer divider 120 mm long, 40 mm tall, 2 mm thick, with the length as a parameter' },
  { re: /mount|bracket|pipe|wall/i, prompt: 'a wall-mount bracket for a 25mm pipe with two M4 screw holes' },
];

function sculptexPromptFor(painPoint) {
  const p = String(painPoint || '').trim().replace(/[.?!]+$/, '');
  if (!p) return 'a wall-mount bracket for a 25mm pipe with two M4 screw holes';
  const hit = SCULPTEX_PROMPTS.find((x) => x.re.test(p));
  if (hit) return hit.prompt;
  const short = p.length > 90 ? `${p.slice(0, 89).trimEnd()}…` : p;
  return `a simple, printable desk object that visualizes "${short}" — clean geometry, about 80 mm wide`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

function newBlankPost() {
  const now = new Date().toISOString();
  const d = { id: uid('d'), kind: 'post', title: '', body: '', status: 'pending', channel: 'linkedin', createdAt: now, updatedAt: now };
  setState((s) => ({ drafts: [d, ...(s.drafts || [])] }));
  navigate(`/studio?draft=${d.id}`);
}

/* ---------------- Source picker (left) ---------------- */

function SourcePicker({ params }) {
  const threads = useStore((s) => s.threads) || [];
  const trends = useStore((s) => s.trends) || [];
  const [mode, setMode] = useState(params.trend ? 'trend' : 'pain');
  const [clusters, setClusters] = useState(null);
  const [loadingClusters, setLoadingClusters] = useState(false);
  const [pain, setPain] = useState(params.pain || '');
  const [threadIds, setThreadIds] = useState(null);
  const [fromThread, setFromThread] = useState(null);
  const [trendId, setTrendId] = useState(params.trend || '');
  const [angle, setAngle] = useState('');
  const [freeText, setFreeText] = useState('');
  const [generating, setGenerating] = useState(false);

  const loadClusters = useCallback(async () => {
    setLoadingClusters(true);
    try {
      const res = await clusterPainPoints();
      setClusters(Array.isArray(res) ? res : []);
    } catch (e) {
      setClusters([]);
      toast(`Couldn't group pain points: ${e && e.message ? e.message : e}`, 'error');
    } finally {
      setLoadingClusters(false);
    }
  }, []);

  useEffect(() => {
    loadClusters();
  }, [loadClusters, threads.length]);

  // Prefill from ?pain= / ?thread= / ?trend=
  useEffect(() => {
    if (params.thread) {
      const t = threads.find((x) => x.id === params.thread);
      if (t) {
        setMode('pain');
        setPain(t.painPoint || t.title || '');
        setThreadIds([t.id]);
        setFromThread(t);
        return;
      }
    }
    if (params.pain) {
      setMode('pain');
      setPain(params.pain);
      setThreadIds(null);
      setFromThread(null);
    }
    if (params.trend) {
      setMode('trend');
      setTrendId(params.trend);
    }
    // threads intentionally omitted: prefill only when the route params change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.pain, params.thread, params.trend]);

  const list = clusters || [];
  const matched = list.find((c) => c.painPoint && pain && c.painPoint.toLowerCase() === pain.toLowerCase());
  const customPain = pain && !matched;

  function pickCluster(c) {
    setPain(c.painPoint);
    setThreadIds(c.threadIds || []);
    setFromThread(null);
  }

  function buildArgs() {
    if (mode === 'pain') {
      if (!pain.trim()) return null;
      return {
        painPoint: pain.trim(),
        threadIds: threadIds || (matched && matched.threadIds) || [],
        angle: angle.trim() || undefined,
      };
    }
    if (mode === 'trend') {
      const t = trends.find((x) => x.id === trendId);
      if (!t) return null;
      const trendAngle = `Tie it to this trend: ${t.title}${t.summary ? ` — ${t.summary}` : ''}`;
      return { painPoint: t.title, threadIds: [], angle: [angle.trim(), trendAngle].filter(Boolean).join('. '), source: { type: 'trend', trendId: t.id } };
    }
    const text = freeText.trim();
    if (!text) return null;
    const firstSentence = text.split(/(?<=[.!?])\s+/)[0];
    return {
      painPoint: firstSentence.length > 140 ? `${firstSentence.slice(0, 139)}…` : firstSentence,
      threadIds: [],
      angle: text,
      source: { type: 'free', text },
    };
  }

  const args = buildArgs();

  async function generate() {
    if (!args) return;
    setGenerating(true);
    try {
      const d = await draftPost(args);
      if (d && d.id) {
        toast('Post drafted — edit, add a visual, then preview.', 'success');
        navigate(`/studio?draft=${d.id}`);
      } else {
        toast('No draft came back. Try again.', 'error');
      }
    } catch (e) {
      toast(`Couldn't draft the post: ${e && e.message ? e.message : e}`, 'error');
    } finally {
      setGenerating(false);
    }
  }

  return html`<section className="card st-source">
    <div className="card-header">
      <div>
        <div className="card-title">Source</div>
        <div className="card-sub">What should the post be about?</div>
      </div>
    </div>
    <div className="card-body stack">
      <${Tabs}
        tabs=${[
          { id: 'pain', label: 'Pain points', count: list.length || undefined },
          { id: 'trend', label: 'Trends', count: trends.length || undefined },
          { id: 'free', label: 'Free angle' },
        ]}
        value=${mode}
        onChange=${setMode}
      />

      ${mode === 'pain'
        ? html`<div className="st-options">
            ${fromThread
              ? html`<div className="st-from small">
                  <${SourceIcon} source=${fromThread.source} />
                  <span className="truncate">From thread: ${fromThread.title}</span>
                </div>`
              : null}
            ${customPain
              ? html`<button type="button" className="st-option active">
                  <span className="st-option-title">${pain}</span>
                  <span className="small muted">${fromThread ? 'Pain point from this thread' : 'Pain point from link'}</span>
                </button>`
              : null}
            ${loadingClusters && !clusters
              ? html`<div className="row small muted"><${Spinner} /> Grouping pain points…</div>`
              : null}
            ${clusters && !list.length
              ? html`<div className="small muted">No pain points yet. Find conversations in Discover first, or use a free angle.</div>`
              : null}
            ${list.map(
              (c, i) => html`<button
                type="button"
                key=${`${c.painPoint}-${i}`}
                className=${cx('st-option', matched === c && 'active')}
                onClick=${() => pickCluster(c)}
              >
                <span className="row st-option-top">
                  <span className="st-option-title">${c.painPoint}</span>
                  <${Badge} tone=${c.count >= 3 ? 'warning' : 'neutral'}>${c.count} thread${c.count === 1 ? '' : 's'}<//>
                </span>
                ${c.example ? html`<span className="st-option-example small muted">“${c.example}”</span>` : null}
              </button>`,
            )}
            <div className="row">
              <${Button} variant="ghost" size="sm" icon="refresh" loading=${loadingClusters} onClick=${loadClusters}>Regroup<//>
            </div>
          </div>`
        : null}

      ${mode === 'trend'
        ? html`<div className="st-options">
            ${!trends.length
              ? html`<div className="small muted">No trends loaded yet — refresh the dashboard to pull what's trending in your field.</div>`
              : null}
            ${trends.map(
              (t) => html`<button
                type="button"
                key=${t.id}
                className=${cx('st-option', trendId === t.id && 'active')}
                onClick=${() => setTrendId(t.id)}
              >
                <span className="row st-option-top">
                  <span className="st-option-title">${t.title}</span>
                  ${t.tag ? html`<${Badge} tone="info">${t.tag}<//>` : null}
                </span>
                ${t.summary ? html`<span className="st-option-example small muted">${t.summary}</span>` : null}
              </button>`,
            )}
          </div>`
        : null}

      ${mode === 'free'
        ? html`<${Field} label="Your angle" hint="A lesson, an opinion, a behind-the-scenes moment…">
            <textarea
              className="textarea"
              rows="5"
              value=${freeText}
              placeholder="e.g. We almost shipped the wrong onboarding — here's what 20 user calls taught us."
              onChange=${(e) => setFreeText(e.target.value)}
            ></textarea>
          <//>`
        : html`<${Field} label="Angle (optional)" hint="e.g. contrarian take, lesson learned, quick how-to">
            <input className="input" value=${angle} placeholder="How should it land?" onChange=${(e) => setAngle(e.target.value)} />
          <//>`}

      <${Button} variant="primary" icon="sparkles" loading=${generating} disabled=${!args || generating} onClick=${generate}>
        Generate post
      <//>
    </div>
  </section>`;
}

/* ---------------- Drafts list (left) ---------------- */

function DraftList({ posts, activeId }) {
  return html`<section className="card st-drafts">
    <div className="card-header">
      <div>
        <div className="card-title">Your posts</div>
        <div className="card-sub">${posts.length} draft${posts.length === 1 ? '' : 's'}</div>
      </div>
      <div className="card-actions">
        <${Button} variant="ghost" size="sm" icon="plus" onClick=${newBlankPost} title="Start a blank post">New<//>
      </div>
    </div>
    <div className="st-draft-list">
      ${!posts.length ? html`<div className="small muted st-draft-empty">No posts yet.</div>` : null}
      ${posts.map(
        (d) => html`<button
          type="button"
          key=${d.id}
          className=${cx('st-draft-item', d.id === activeId && 'active')}
          onClick=${() => navigate(`/studio?draft=${d.id}`)}
        >
          <span className="st-draft-title truncate">${firstLine(d, 64)}</span>
          <span className="row st-draft-meta small muted">
            <${StatusBadge} status=${d.status} />
            ${d.visual ? html`<${Icon} name=${d.visual.type === 'sculptex' ? 'cube' : 'image'} size=${13} />` : null}
            <span className="spacer"></span>
            <span>${d.status === 'scheduled' && d.scheduledFor ? fmtWhen(d.scheduledFor) : timeAgo(d.updatedAt || d.createdAt)}</span>
          </span>
        </button>`,
      )}
    </div>
  </section>`;
}

/* ---------------- Visual panel (middle) ---------------- */

function UploadButton({ label = 'Upload image', onFile, variant = 'secondary' }) {
  const ref = useRef(null);
  return html`<span>
    <input
      ref=${ref}
      type="file"
      accept="image/*"
      className="st-file"
      onChange=${(e) => {
        const f = e.target.files && e.target.files[0];
        e.target.value = '';
        if (f) onFile(f);
      }}
    />
    <${Button} variant=${variant} size="sm" icon="upload" onClick=${() => ref.current && ref.current.click()}>${label}<//>
  </span>`;
}

function UploadVisual({ draft }) {
  const [warn, setWarn] = useState('');
  const visual = draft.visual && draft.visual.type === 'upload' ? draft.visual : null;
  const [dragOver, setDragOver] = useState(false);

  async function onFile(file) {
    if (!file.type.startsWith('image/')) {
      toast('Please choose an image file (PNG, JPG, GIF or WebP).', 'error');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      const msg = `Large image (${fmtBytes(file.size)}). Images over 1.5 MB may not fit in browser storage — consider a smaller export.`;
      setWarn(msg);
      toast(msg, 'info');
    } else {
      setWarn('');
    }
    try {
      const src = await readFileAsDataUrl(file);
      patchDraft(draft.id, { visual: { type: 'upload', src, caption: file.name } });
    } catch (e) {
      toast(`Couldn't read the image: ${e.message || e}`, 'error');
    }
  }

  return html`<div className="stack st-visual-panel">
    <div
      className=${cx('st-drop', dragOver && 'over')}
      onDragOver=${(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave=${() => setDragOver(false)}
      onDrop=${(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
    >
      <${Icon} name="upload" size=${20} />
      <div className="small">Drop an image here, or</div>
      <${UploadButton} label=${visual ? 'Replace image' : 'Choose image'} onFile=${onFile} />
      <div className="small muted">PNG or JPG · 1200×1200 or 1200×627 works best</div>
    </div>
    ${visual ? html`<div className="small muted">Attached: ${visual.caption || 'image'}</div>` : null}
    ${warn ? html`<div className="st-warn small"><${Icon} name="alert" size=${13} /> ${warn}</div>` : null}
  </div>`;
}

const RENDER_STAGES = [
  { at: 0, label: 'Connecting to Sculptex…' },
  { at: 3, label: 'Generating geometry…' },
  { at: 9, label: 'Rendering preview…' },
  { at: 25, label: 'Still working — complex models take a little longer…' },
];

function SculptexVisual({ draft }) {
  const sculptexStatus = useStore((s) => s.connections && s.connections.sculptex && s.connections.sculptex.status);
  const visual = draft.visual && draft.visual.type === 'sculptex' ? draft.visual : null;
  const defaultPrompt = () => draft.sculptexPrompt || sculptexPromptFor(draft.painPoint);
  const [prompt, setPrompt] = useState(() => (visual && visual.caption) || defaultPrompt());
  const [rendering, setRendering] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!rendering) return undefined;
    const started = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, [rendering]);

  async function render() {
    const p = prompt.trim();
    if (!p) return;
    setRendering(true);
    setError('');
    try {
      const res = (await renderWithSculptex({ prompt: p })) || {};
      if (!alive.current) return;
      setResult(res);
      const renderUrl = res.renderUrl || '';
      if (renderUrl || res.modelUrl) {
        patchDraft(draft.id, {
          visual: {
            type: 'sculptex',
            // Store the image once: data: URLs only in src, renderUrl only for http(s) links.
            src: renderUrl || undefined,
            renderUrl: /^https?:/i.test(renderUrl) ? renderUrl : undefined,
            modelUrl: res.modelUrl || undefined,
            caption: p,
            demo: !!res.demo,
          },
        });
      } else {
        setError('Sculptex finished but returned no image or model.');
      }
    } catch (e) {
      if (alive.current) setError(e && e.message ? e.message : String(e));
    } finally {
      if (alive.current) setRendering(false);
    }
  }

  const stage = [...RENDER_STAGES].reverse().find((s) => elapsed >= s.at) || RENDER_STAGES[0];
  const shown = visual || (result && (result.renderUrl || result.modelUrl) ? { renderUrl: result.renderUrl, modelUrl: result.modelUrl, demo: result.demo } : null);
  const isDemo = shown ? !!shown.demo : sculptexStatus !== 'connected';

  return html`<div className="stack st-visual-panel">
    ${sculptexStatus !== 'connected'
      ? html`<div className="st-note small">
          <${Icon} name="plug" size=${13} />
          <span>Sculptex isn't connected in this tab, so you'll get a demo render. <a href="#/connections">Connect Sculptex</a> for 3D renders.</span>
        </div>`
      : html`<div className="st-note small ok"><${Icon} name="check" size=${13} /><span>Sculptex connected.</span></div>`}
    <${Field} label="Describe the object" hint="Be concrete: dimensions, holes, materials. Sculptex builds a 3D model and renders it.">
      <textarea
        className="textarea"
        rows="3"
        value=${prompt}
        placeholder="a wall-mount bracket for a 25mm pipe with two M4 screw holes"
        onChange=${(e) => setPrompt(e.target.value)}
        disabled=${rendering}
      ></textarea>
    <//>
    <div className="row">
      <${Button} variant="primary" size="sm" icon="cube" loading=${rendering} disabled=${rendering || !prompt.trim()} onClick=${render}>
        ${shown ? 'Render again' : '3D render with Sculptex'}
      <//>
      ${!rendering && (draft.sculptexPrompt || draft.painPoint)
        ? html`<${Button} variant="ghost" size="sm" onClick=${() => setPrompt(defaultPrompt())}>Reset prompt<//>`
        : null}
    </div>
    ${rendering
      ? html`<div className="st-progress" role="status" aria-live="polite">
          <div className="st-progress-bar"><span></span></div>
          <div className="row small muted"><${Spinner} /> ${stage.label} <span className="spacer"></span> ${elapsed}s</div>
        </div>`
      : null}
    ${error ? html`<div className="st-warn small"><${Icon} name="alert" size=${13} /> ${error}</div>` : null}
    ${shown && !rendering
      ? html`<div className="st-render stack">
          ${shown.renderUrl || (visual && visual.src)
            ? html`<img className="st-render-img" src=${shown.renderUrl || visual.src} alt=${prompt} />`
            : html`<div className="small muted">The model is ready, but no preview image was returned.</div>`}
          <div className="row st-render-meta">
            ${isDemo
              ? html`<${Badge} tone="warning">Sample render — connect Sculptex to render yours<//>
                  <a className="small" href="#/connections">Connections →</a>`
              : html`<${Badge} tone="success">Rendered by Sculptex<//>`}
            <span className="spacer"></span>
            ${shown.modelUrl
              ? html`<a className="btn btn-secondary btn-sm" href=${shown.modelUrl} target="_blank" rel="noopener noreferrer" download>
                  <${Icon} name="download" size=${14} /> Download model
                </a>`
              : null}
          </div>
        </div>`
      : null}
  </div>`;
}

function VisualSection({ draft, disabled }) {
  const [mode, setMode] = useState(() => {
    const t = draft.visual && draft.visual.type;
    return t === 'canva' || t === 'sculptex' ? t : 'upload';
  });
  const options = [
    { id: 'upload', label: 'Upload', icon: 'upload' },
    { id: 'canva', label: 'Canva', icon: 'palette' },
    { id: 'sculptex', label: '3D render', icon: 'cube' },
  ];
  return html`<section className="st-visual">
    <div className="row st-section-head">
      <div className="field-label">Visual</div>
      <span className="spacer"></span>
      ${draft.visual
        ? html`<${Button} variant="ghost" size="sm" icon="trash" disabled=${disabled} onClick=${() => patchDraft(draft.id, { visual: null })}>Remove visual<//>`
        : html`<span className="small muted">Optional — posts with an image get more reach</span>`}
    </div>
    ${draft.visualIdea && !draft.visual ? html`<div className="small muted">Idea: ${draft.visualIdea}</div>` : null}
    <div className="st-visual-modes" role="tablist">
      ${options.map(
        (o) => html`<button
          type="button"
          role="tab"
          key=${o.id}
          aria-selected=${mode === o.id}
          className=${cx('st-visual-mode', mode === o.id && 'active')}
          onClick=${() => setMode(o.id)}
        >
          <${Icon} name=${o.icon} size=${16} />
          <span>${o.label}</span>
          ${draft.visual && draft.visual.type === o.id ? html`<span className="st-dot" aria-label="attached"></span>` : null}
        </button>`,
      )}
    </div>
    ${disabled
      ? html`<div className="small muted">This post is already published.</div>`
      : html`${mode === 'upload' ? html`<${UploadVisual} draft=${draft} />` : null}
        ${mode === 'canva' ? html`<${CanvaPanel} key=${draft.id} draft=${draft} visual=${draft.visual} onVisual=${(v) => patchDraft(draft.id, { visual: v })} />` : null}
        ${mode === 'sculptex' ? html`<${SculptexVisual} draft=${draft} />` : null}`}
  </section>`;
}

/* ---------------- Composer (middle + right + footer) ---------------- */

function Composer({ draft }) {
  const profile = useProfile();
  const linkedinStatus = useStore((s) => s.connections && s.connections.linkedin && s.connections.linkedin.status);
  const connected = linkedinStatus === 'connected';
  const id = draft.id;

  const [title, setTitle, flushTitle] = useBufferedText(draft.title || '', (v) => patchDraft(id, { title: v }));
  const [body, setBody, flushBody] = useBufferedText(draft.body || '', (v) => patchDraft(id, { body: v }));
  const flushAll = () => {
    flushTitle();
    flushBody();
  };

  const [busy, setBusy] = useState('');
  const [when, setWhen] = useState(() => toLocalInput(draft.scheduledFor ? new Date(draft.scheduledFor) : nextWeekdayAt(9, 30)));
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (draft.scheduledFor) setWhen(toLocalInput(new Date(draft.scheduledFor)));
  }, [draft.scheduledFor]);

  const published = draft.status === 'posted' || draft.status === 'sent';
  const scheduled = draft.status === 'scheduled';
  const words = wordCount(body);
  const chars = (title ? title.length + 2 : 0) + body.length;
  const overLimit = chars > LINKEDIN_POST_LIMIT;
  const hasContent = body.trim().length > 0;

  async function doRewrite(instruction) {
    flushAll();
    setBusy(`rw:${instruction}`);
    try {
      await rewrite(id, instruction);
    } catch (e) {
      toast(`Rewrite failed: ${e && e.message ? e.message : e}`, 'error');
    } finally {
      setBusy('');
    }
  }

  function save() {
    flushAll();
    toast('Draft saved.', 'success');
  }

  async function schedule() {
    const dt = fromLocalInput(when);
    if (!dt) {
      toast('Pick a date and time first.', 'error');
      return;
    }
    if (dt.getTime() <= Date.now()) {
      toast('Pick a time in the future.', 'error');
      return;
    }
    if (!hasContent) {
      toast('Write the post before scheduling it.', 'error');
      return;
    }
    flushAll();
    setBusy('schedule');
    try {
      await scheduleDraft(id, dt.toISOString());
      toast(`Scheduled for ${fmtWhen(dt.toISOString())}.`, 'success');
    } catch (e) {
      toast(`Couldn't schedule: ${e && e.message ? e.message : e}`, 'error');
    } finally {
      setBusy('');
    }
  }

  function unschedule() {
    patchDraft(id, { status: 'pending', scheduledFor: null });
    toast('Unscheduled — back to drafts.', 'info');
  }

  function openPreview() {
    if (!hasContent) {
      toast('Write the post before publishing it.', 'error');
      return;
    }
    flushAll();
    setPreviewOpen(true);
  }

  async function confirmPost() {
    flushAll();
    setBusy('post');
    try {
      await sendDraft(id);
      setPreviewOpen(false);
    } catch (e) {
      toast(`Couldn't post: ${e && e.message ? e.message : e}`, 'error');
    } finally {
      setBusy('');
    }
  }

  function duplicate() {
    flushAll();
    const now = new Date().toISOString();
    const copy = {
      ...draft,
      id: uid('d'),
      title,
      body,
      status: 'pending',
      scheduledFor: null,
      postedAt: null,
      error: undefined,
      createdAt: now,
      updatedAt: now,
    };
    setState((s) => ({ drafts: [copy, ...(s.drafts || [])] }));
    navigate(`/studio?draft=${copy.id}`);
  }

  function remove() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 4000);
      return;
    }
    setState((s) => ({ drafts: (s.drafts || []).filter((d) => d.id !== id) }));
    toast('Draft deleted.', 'info');
    navigate('/studio');
  }

  const pickedBest = BEST_TIMES.find((b) => toLocalInput(nextDayAt(b.dow, b.h, b.m)) === when);

  return html`<div className="st-composer">
    <section className="card st-editor">
      <div className="card-body stack">
        ${published
          ? html`<div className="st-banner ok small">
              <${Icon} name="check" size=${14} />
              <span>Published to LinkedIn (demo) ${draft.postedAt ? timeAgo(draft.postedAt) : ''}. Edits here won't change the published post.</span>
              <span className="spacer"></span>
              <${Button} variant="secondary" size="sm" icon="copy" onClick=${duplicate}>Duplicate as new draft<//>
            </div>`
          : null}
        ${scheduled && draft.scheduledFor
          ? html`<div className="st-banner small">
              <${Icon} name="clock" size=${14} />
              <span>Scheduled for <strong>${fmtWhen(draft.scheduledFor)}</strong> (${relTime(draft.scheduledFor)}).</span>
              <span className="spacer"></span>
              <${Button} variant="ghost" size="sm" onClick=${unschedule}>Unschedule<//>
            </div>`
          : null}
        ${draft.error ? html`<div className="st-warn small"><${Icon} name="alert" size=${13} /> ${draft.error}</div>` : null}
        ${draft.painPoint
          ? html`<div className="st-pain small"><span className="muted">Pain point:</span> ${draft.painPoint}</div>`
          : null}

        <${Field} label="Title (optional)" hint="Shown as a bold first line — LinkedIn has no title field.">
          <input
            className="input"
            value=${title}
            placeholder="A hook that stops the scroll"
            disabled=${published}
            onChange=${(e) => setTitle(e.target.value)}
            onBlur=${flushTitle}
          />
        <//>

        <div className="field">
          <div className="row st-section-head">
            <label className="field-label" htmlFor=${`st-body-${id}`}>Post</label>
            <span className="spacer"></span>
            <span className=${cx('small', overLimit ? 'st-over' : 'muted')}>
              ${words} word${words === 1 ? '' : 's'} · ${chars.toLocaleString()} / ${LINKEDIN_POST_LIMIT.toLocaleString()} chars
            </span>
          </div>
          <textarea
            id=${`st-body-${id}`}
            className="textarea st-body"
            rows="12"
            value=${body}
            placeholder="Write your post…"
            disabled=${published || busy.startsWith('rw:')}
            onChange=${(e) => setBody(e.target.value)}
            onBlur=${flushBody}
          ></textarea>
          <div className="st-chips">
            ${REWRITE_CHIPS.map(
              (c) => html`<button
                type="button"
                key=${c}
                className="pill st-chip"
                disabled=${published || !!busy || !hasContent}
                onClick=${() => doRewrite(c)}
              >
                ${busy === `rw:${c}` ? html`<${Spinner} />` : html`<${Icon} name="sparkles" size=${12} />`} ${c}
              </button>`,
            )}
          </div>
        </div>

        <div className="divider"></div>
        <${VisualSection} key=${`v-${id}`} draft=${draft} disabled=${published} />
      </div>
    </section>

    <aside className="st-preview">
      <div className="row st-preview-head">
        <span className="field-label">Live preview</span>
        <span className="spacer"></span>
        <${Badge} tone=${connected ? 'success' : 'neutral'}>${connected ? 'LinkedIn (demo) connected' : 'LinkedIn (demo)'}<//>
      </div>
      <${PostPreview} profile=${profile} title=${title} body=${body} visual=${draft.visual} />
    </aside>

    <footer className="card st-footer">
      <div className="st-footer-inner">
        <div className="row st-footer-left">
          <${Button} variant="secondary" icon="check" onClick=${save} disabled=${published}>Save draft<//>
          <${Button} variant=${confirmDelete ? 'danger' : 'ghost'} icon="trash" onClick=${remove}>
            ${confirmDelete ? 'Click again to delete' : 'Delete'}
          <//>
        </div>
        ${published
          ? null
          : html`<div className="st-schedule">
              <div className="row st-best">
                <span className="small muted">Best times:</span>
                ${BEST_TIMES.map(
                  (b) => html`<button
                    type="button"
                    key=${b.label}
                    className=${cx('pill st-chip', pickedBest === b && 'active')}
                    onClick=${() => setWhen(toLocalInput(nextDayAt(b.dow, b.h, b.m)))}
                  >
                    ${b.label}
                  </button>`,
                )}
              </div>
              <div className="row st-schedule-row">
                <input
                  className="input st-when"
                  type="datetime-local"
                  value=${when}
                  min=${toLocalInput(new Date())}
                  onChange=${(e) => setWhen(e.target.value)}
                  aria-label="Schedule date and time"
                />
                <${Button} variant="secondary" icon="calendar" loading=${busy === 'schedule'} disabled=${!!busy || !hasContent} onClick=${schedule}>
                  ${scheduled ? 'Reschedule' : 'Schedule'}
                <//>
                <${Button} variant="primary" icon="send" disabled=${!!busy || !hasContent} onClick=${openPreview}>Post now<//>
              </div>
            </div>`}
      </div>
    </footer>

    <${Modal}
      open=${previewOpen}
      title=${connected ? 'Preview — post to LinkedIn (demo)' : 'Preview — copy & open LinkedIn'}
      onClose=${() => busy !== 'post' && setPreviewOpen(false)}
      footer=${html`
        <${Button} variant="ghost" disabled=${busy === 'post'} onClick=${() => setPreviewOpen(false)}>Cancel<//>
        <${Button} variant="primary" icon="send" loading=${busy === 'post'} disabled=${busy === 'post'} onClick=${confirmPost}>
          ${connected ? 'Post to LinkedIn (demo)' : 'Copy post & open LinkedIn'}
        <//>
      `}
    >
      <div className="stack">
        <${PostPreview} profile=${profile} title=${title} body=${body} visual=${draft.visual} defaultExpanded=${true} />
        ${connected
          ? html`<p className="small muted">
              This publishes to your LinkedIn (demo) feed in Lens — no real LinkedIn account is involved. You'll find it under Schedule → Published.
            </p>`
          : html`<p className="small muted">
              LinkedIn (demo) isn't connected, so Lens will copy the text to your clipboard and open LinkedIn for you to paste.
              ${' '}<a href="#/connections">Connect LinkedIn (demo)</a> to publish to the demo feed instead.
            </p>`}
      </div>
    <//>
  </div>`;
}

/* ---------------- Page ---------------- */

export default function Studio() {
  const { params } = useRoute();
  const drafts = useStore((s) => s.drafts) || [];
  const posts = useMemo(
    () =>
      drafts
        .filter((d) => d.kind === 'post' && d.status !== 'rejected')
        .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''))),
    [drafts],
  );
  const requestedId = params.draft || '';
  const draft = requestedId ? drafts.find((d) => d.id === requestedId && d.kind === 'post') : null;

  return html`<div className="page st-page">
    <div className="page-header">
      <div>
        <h1>Studio</h1>
        <p className="page-sub">Turn what your audience keeps complaining about into a post — add a visual, preview it, then schedule.</p>
      </div>
      <div className="page-actions">
        <${Button} variant="secondary" icon="calendar" onClick=${() => navigate('/schedule')}>Schedule<//>
        <${Button} variant="primary" icon="plus" onClick=${newBlankPost}>New post<//>
      </div>
    </div>

    <div className="st-layout">
      <div className="st-side">
        <${SourcePicker} params=${params} />
        <${DraftList} posts=${posts} activeId=${draft ? draft.id : ''} />
      </div>
      <div className="st-main">
        ${draft
          ? html`<${Composer} key=${draft.id} draft=${draft} />`
          : html`<div className="card st-placeholder">
              <${Empty}
                icon="edit"
                title=${requestedId ? 'That draft is gone' : 'Pick a source, or start blank'}
                body=${requestedId
                  ? 'It may have been deleted. Choose another post from the list, or start a new one.'
                  : 'Choose a recurring pain point or a trend on the left and hit "Generate post" — or write one from scratch.'}
                action=${html`<${Button} variant="primary" icon="plus" onClick=${newBlankPost}>Start a blank post<//>`}
              />
            </div>`}
      </div>
    </div>
  </div>`;
}

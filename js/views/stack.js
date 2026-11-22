// Stack (#/stack) — swipe through suggested LinkedIn posts.
// Right = approve (scheduled at the next free best-time slot), left = decline, E = edit.
// Exports the page (default) and the reusable <SwipeStack> (also used in onboarding step 5).
import { html, useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from '../lib.js';
import { useStore, getState, toast } from '../store.js';
import { navigate } from '../router.js';
import { Button, Modal, Field, Icon, SourceIcon, Skeleton, Tabs, Spinner, Kbd } from '../ui.js';
import {
  generateSuggestions,
  approveSuggestion,
  declineSuggestion,
  undoSuggestion,
  rewrite,
  renderWithSculptex,
} from '../services/lens.js';
import { PostPreview, VisualMedia, useProfile, patchDraft, fmtWhen, cx } from './studio.js';

/* ------------------------------------------------------------------ */
/* constants + small helpers                                           */
/* ------------------------------------------------------------------ */

const VISIBLE = 3; // cards rendered in the stack (top + 2 behind)
const THRESHOLD = 0.3; // fraction of card width that commits a swipe
const FLICK_VELOCITY = 0.55; // px/ms
const FLY_MS = 360;
const UNDO_MS = 6000;
const MAX_UPLOAD_BYTES = 1.5 * 1024 * 1024;
const HINT_KEY = 'lens_stack_hint_v1';

const REWRITE_CHIPS = [
  { label: 'Shorter', icon: 'minus' },
  { label: 'Warmer', icon: 'heart' },
  { label: 'More specific', icon: 'target' },
  { label: 'Add a question', icon: 'chat' },
];

const RENDER_STAGES = [
  { at: 0, label: 'Connecting to Sculptex…' },
  { at: 3, label: 'Generating geometry…' },
  { at: 9, label: 'Rendering preview…' },
  { at: 25, label: 'Still working — complex models take a little longer…' },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const timeOf = (iso) => {
  const t = new Date(iso || 0).getTime();
  return isNaN(t) ? 0 : t;
};

function reducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable;
}

function anyModalOpen() {
  return !!document.querySelector('.modal-backdrop, [role="dialog"][aria-modal="true"]');
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function parseHttpUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}

function errText(e) {
  return e && e.message ? e.message : String(e);
}

function isPendingPost(d) {
  return !!d && d.kind === 'post' && d.status === 'pending';
}

function usePendingPosts() {
  const drafts = useStore((s) => s.drafts);
  return useMemo(
    () => (drafts || []).filter(isPendingPost).sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt)),
    [drafts],
  );
}

async function generateMore() {
  try {
    const fresh = await generateSuggestions();
    const n = Array.isArray(fresh) ? fresh.length : 0;
    if (n) toast(`${n} new suggestion${n === 1 ? '' : 's'} added to your stack.`, 'success');
  } catch (e) {
    toast(`Couldn't generate posts: ${errText(e)}`, 'error');
  }
}

// "From pain point: Exact dimensions & tolerances · 4 threads"
function sourceInfo(draft, threadsById) {
  const src =
    draft.source ||
    (draft.painPoint
      ? { type: 'pain', label: draft.painPoint, threadIds: draft.threadId ? [draft.threadId] : [] }
      : draft.threadId
        ? { type: 'thread', label: '', threadIds: [draft.threadId] }
        : null);
  const ids = (src && Array.isArray(src.threadIds) && src.threadIds) || [];
  const sources = [];
  for (const id of ids) {
    const t = threadsById.get(id);
    if (t && t.source && !sources.includes(t.source)) sources.push(t.source);
  }
  const n = ids.length;
  const meta = n ? `${n} thread${n === 1 ? '' : 's'}` : '';
  if (!src) return { tone: 'lens', icon: 'sparkles', kind: 'Suggested by Lens', label: '', meta: '', sources };
  if (src.type === 'trend') return { tone: 'trend', icon: 'trending', kind: 'From trend', label: src.label || '', meta: '', sources };
  // 'free' = Studio's free-angle posts (lens.draftPost); same family as ideas.
  if (src.type === 'idea' || src.type === 'free') return { tone: 'idea', icon: 'sparkles', kind: 'From your idea', label: '', meta: '', sources };
  if (src.type === 'thread') return { tone: 'pain', icon: 'chat', kind: 'From a conversation', label: '', meta: '', sources };
  return { tone: 'pain', icon: 'flame', kind: 'From pain point', label: src.label || draft.painPoint || '', meta, sources };
}

/* ------------------------------------------------------------------ */
/* one card                                                            */
/* ------------------------------------------------------------------ */

function SourceLine({ info }) {
  return html`<div className="sw-source">
    <span className=${cx('sw-source-icon', `is-${info.tone}`)} aria-hidden="true"><${Icon} name=${info.icon} size=${14} /></span>
    <span className="sw-source-text">
      <span>${info.kind}${info.label ? ':' : ''}</span>
      ${info.label ? html` <strong>${info.label}</strong>` : null}
      ${info.meta ? html`<span className="sw-source-meta"> · ${info.meta}</span>` : null}
    </span>
    ${info.sources.length
      ? html`<span className="sw-source-glyphs">
          ${info.sources.slice(0, 3).map((s) => html`<${SourceIcon} key=${s} source=${s} label=${false} />`)}
        </span>`
      : null}
  </div>`;
}

function SwipeCard({ draft, depth, isTop, position, total, profile, threadsById, hint, registerTop, onOpenVisual }) {
  const ref = useRef(null);
  const info = useMemo(() => sourceInfo(draft, threadsById), [draft, threadsById]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.inert = !isTop;
    if (isTop) {
      registerTop(node);
    } else {
      // A card pushed back down (e.g. by an undo) drops any drag styles so it settles into its depth slot.
      node.style.transition = '';
      node.style.transform = '';
      node.style.opacity = '';
      node.style.removeProperty('--approve');
      node.style.removeProperty('--decline');
      delete node.dataset.over;
      delete node.dataset.grab;
    }
  }, [isTop, registerTop]);

  return html`<article
    ref=${ref}
    className=${cx('sw-card', isTop && 'is-top', isTop && hint && 'sw-hint')}
    style=${{ '--depth': depth, zIndex: VISIBLE + 1 - depth }}
    aria-hidden=${isTop ? undefined : 'true'}
    role=${isTop ? 'group' : undefined}
    aria-roledescription=${isTop ? 'suggested post' : undefined}
    aria-label=${isTop ? `Suggested post ${position} of ${total}` : undefined}
    onDragStart=${(e) => e.preventDefault()}
  >
    <div className="sw-card-top">
      <${SourceLine} info=${info} />
    </div>
    <div className="sw-card-scroll">
      <${PostPreview} profile=${profile} title=${draft.title} body=${draft.body} visual=${draft.visual} timeLabel="Suggested" defaultExpanded=${true} />
    </div>
    ${draft.visualIdea || draft.sculptexPrompt
      ? html`<div className="sw-card-foot">
          ${draft.visualIdea
            ? html`<div className="sw-idea">
                <${Icon} name="image" size=${14} />
                <span className="sw-idea-text"><span className="sw-idea-label">Visual idea</span> ${draft.visualIdea}</span>
              </div>`
            : null}
          ${draft.sculptexPrompt
            ? html`<button
                type="button"
                className="sw-chip"
                tabIndex=${isTop ? 0 : -1}
                title=${`Render with Sculptex: ${draft.sculptexPrompt}`}
                onClick=${() => onOpenVisual('sculptex')}
              >
                <${Icon} name="cube" size=${13} />
                <span className="sw-chip-label">Sculptex</span>
                <span className="sw-chip-text">${draft.sculptexPrompt}</span>
              </button>`
            : null}
        </div>`
      : null}
    <div className="sw-stamp sw-stamp-approve" aria-hidden="true">Approve</div>
    <div className="sw-stamp sw-stamp-decline" aria-hidden="true">Decline</div>
  </article>`;
}

function SkeletonStack() {
  return html`<div className="sw-stage is-loading" aria-busy="true">
    ${[0, 1, 2].map(
      (depth) => html`<div key=${depth} className=${cx('sw-card sw-skel', depth === 0 && 'is-top')} style=${{ '--depth': depth, zIndex: VISIBLE + 1 - depth }} aria-hidden=${depth ? 'true' : undefined}>
        ${depth === 0
          ? html`<div className="sw-card-top">
                <div className="sw-source"><${Spinner} size=${14} /><span className="sw-source-text">Writing posts from what your audience is saying…</span></div>
              </div>
              <div className="sw-skel-body">
                <div className="row"><span className="sw-skel-avatar"></span><${Skeleton} lines=${2} className="sw-skel-who" /></div>
                <${Skeleton} lines=${6} />
              </div>`
          : null}
      </div>`,
    )}
  </div>`;
}

function EmptyStack({ generating, compact }) {
  const scheduled = useStore((s) => (s.drafts || []).filter((d) => d && d.kind === 'post' && d.status === 'scheduled').length);
  const onboarded = useStore((s) => !!s.onboarded);
  return html`<div className="sw-stage">
    <div className="sw-empty">
      <div className="sw-empty-badge" aria-hidden="true">
        <span className="sw-burst">${Array.from({ length: 8 }, (_, i) => html`<span key=${i} style=${{ '--a': `${i * 45}deg` }}></span>`)}</span>
        <${Icon} name="check" size=${30} strokeWidth=${2.25} />
      </div>
      <h2 className="sw-empty-title">You're all caught up</h2>
      <p className="sw-empty-body">
        ${scheduled
          ? `${scheduled} post${scheduled === 1 ? ' is' : 's are'} scheduled. `
          : ''}Lens can draft a few more from fresh conversations and trends, or shape an idea of your own.
      </p>
      <div className="sw-empty-actions">
        <${Button} variant="primary" icon="sparkles" loading=${generating} onClick=${generateMore}>Generate more<//>
        <${Button} variant="secondary" icon="chat" onClick=${() => navigate('/chat')}>Add your own idea<//>
      </div>
      ${scheduled && onboarded && !compact
        ? html`<a className="sw-empty-link small" href="#/schedule">See your schedule <${Icon} name="arrowRight" size=${13} /></a>`
        : null}
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* edit modal                                                          */
/* ------------------------------------------------------------------ */

function SculptexPanel({ draft, onVisual, visual }) {
  const status = useStore((s) => s.connections && s.connections.sculptex && s.connections.sculptex.status);
  const [prompt, setPrompt] = useState(() => (visual && visual.type === 'sculptex' && visual.caption) || draft.sculptexPrompt || '');
  const [rendering, setRendering] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
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
    const p = prompt.trim() || draft.sculptexPrompt || '';
    if (!p || rendering) return;
    setRendering(true);
    setError('');
    try {
      const res = (await renderWithSculptex({ prompt: p })) || {};
      if (!alive.current) return;
      const renderUrl = res.renderUrl || '';
      if (renderUrl || res.modelUrl) {
        onVisual({
          type: 'sculptex',
          src: renderUrl || undefined,
          renderUrl: /^https?:/i.test(renderUrl) ? renderUrl : undefined,
          modelUrl: res.modelUrl || undefined,
          caption: p,
          demo: !!res.demo,
        });
      } else {
        setError('Sculptex finished but returned no image or model.');
      }
    } catch (e) {
      if (alive.current) setError(errText(e));
    } finally {
      if (alive.current) setRendering(false);
    }
  }

  const stage = [...RENDER_STAGES].reverse().find((s) => elapsed >= s.at) || RENDER_STAGES[0];
  const shown = visual && visual.type === 'sculptex' ? visual : null;

  return html`<div className="stack sw-vis-panel">
    ${status === 'connected'
      ? html`<div className="sw-note is-ok small"><${Icon} name="check" size=${13} /><span>Sculptex connected — renders run on the real MCP server.</span></div>`
      : html`<div className="sw-note small">
          <${Icon} name="plug" size=${13} />
          <span>Sculptex isn't connected in this tab, so you'll get a sample render. <a href="#/settings">Connect Sculptex</a> for real 3D renders.</span>
        </div>`}
    <${Field} label="Describe the object" hint="Concrete beats clever: dimensions, holes, fit.">
      <textarea
        className="textarea"
        rows="3"
        value=${prompt}
        disabled=${rendering}
        placeholder="a wall-mount bracket for a 25mm pipe with two M4 screw holes"
        onChange=${(e) => setPrompt(e.target.value)}
      ></textarea>
    <//>
    <div className="row sw-vis-row">
      <${Button} variant="primary" size="sm" icon="cube" loading=${rendering} disabled=${!prompt.trim() && !draft.sculptexPrompt} onClick=${render}>
        ${shown ? 'Render again' : 'Render with Sculptex'}
      <//>
      ${draft.sculptexPrompt && prompt !== draft.sculptexPrompt && !rendering
        ? html`<${Button} variant="ghost" size="sm" onClick=${() => setPrompt(draft.sculptexPrompt)}>Use suggested prompt<//>`
        : null}
    </div>
    ${rendering
      ? html`<div className="sw-progress" role="status" aria-live="polite">
          <div className="sw-progress-bar"><span></span></div>
          <div className="row small muted"><${Spinner} size=${12} /> ${stage.label}<span className="spacer"></span>${elapsed}s</div>
        </div>`
      : null}
    ${error ? html`<div className="sw-note is-warn small"><${Icon} name="alert" size=${13} /><span>${error}</span></div>` : null}
    ${shown && !rendering
      ? html`<div className="row small sw-vis-row">
          ${shown.demo
            ? html`<span className="sw-tag is-warn">Sample render</span>`
            : html`<span className="sw-tag is-ok">Rendered by Sculptex</span>`}
          <span className="spacer"></span>
          ${shown.modelUrl
            ? html`<a className="btn btn-secondary btn-sm" href=${shown.modelUrl} target="_blank" rel="noopener noreferrer" download>
                <${Icon} name="download" size=${14} /> Model
              </a>`
            : null}
        </div>`
      : null}
  </div>`;
}

function UploadPanel({ visual, onVisual, label = 'Choose image', keepLink = false }) {
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);
  const [warn, setWarn] = useState('');

  async function onFile(file) {
    if (!file) return;
    if (!file.type || !file.type.startsWith('image/')) {
      toast('Please choose an image file (PNG, JPG, GIF or WebP).', 'error');
      return;
    }
    setWarn(file.size > MAX_UPLOAD_BYTES ? `Large image (${fmtBytes(file.size)}) — it may not survive a reload. A smaller export is safer.` : '');
    try {
      const src = await readFileAsDataUrl(file);
      if (keepLink && visual && visual.link) onVisual({ ...visual, src, caption: file.name });
      else onVisual({ type: 'upload', src, caption: file.name });
    } catch (e) {
      toast(`Couldn't read the image: ${errText(e)}`, 'error');
    }
  }

  return html`<div className="stack sw-vis-panel">
    <div
      className=${cx('sw-drop', over && 'is-over')}
      onDragOver=${(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave=${() => setOver(false)}
      onDrop=${(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
    >
      <${Icon} name="upload" size=${20} />
      <div className="small">Drop an image here, or</div>
      <input
        ref=${inputRef}
        type="file"
        accept="image/*"
        className="sw-file"
        onChange=${(e) => {
          const f = e.target.files && e.target.files[0];
          e.target.value = '';
          onFile(f);
        }}
      />
      <${Button} variant="secondary" size="sm" icon="image" onClick=${() => inputRef.current && inputRef.current.click()}>${label}<//>
      <div className="small muted">1200×1200 or 1200×627 works best</div>
    </div>
    ${warn ? html`<div className="sw-note is-warn small"><${Icon} name="alert" size=${13} /><span>${warn}</span></div>` : null}
  </div>`;
}

function LinkPanel({ visual, onVisual }) {
  const design = useStore((s) => (s.connections && s.connections.design) || {});
  const tool = design.tool === 'figma' || design.tool === 'canva' ? design.tool : null;
  const connected = !!tool && design.status === 'connected';
  const current = visual && (visual.type === 'canva' || visual.type === 'figma') ? visual : null;
  const [link, setLink] = useState(current ? current.link || '' : '');
  const name = tool === 'figma' ? 'Figma' : tool === 'canva' ? 'Canva' : 'Canva or Figma';

  function attach() {
    const u = parseHttpUrl(link);
    const host = u ? u.hostname.toLowerCase() : '';
    const type = host.endsWith('figma.com') ? 'figma' : host.endsWith('canva.com') || host.endsWith('canva.link') ? 'canva' : null;
    if (!u || !type || (tool && type !== tool)) {
      toast(`That doesn't look like a ${tool ? `${name} link (${tool}.com)` : 'Canva or Figma link'}.`, 'error');
      return;
    }
    onVisual({ type, link: u.toString(), src: current && current.type === type ? current.src : undefined, caption: `${type === 'figma' ? 'Figma' : 'Canva'} design` });
  }

  const openHref = tool === 'figma' ? 'https://www.figma.com/files' : 'https://www.canva.com/create/linkedin-posts/';

  return html`<div className="stack sw-vis-panel">
    ${connected
      ? html`<div className="sw-note is-ok small"><${Icon} name="check" size=${13} /><span>${design.account || `${name} (demo) connected`}</span></div>`
      : html`<div className="sw-note small">
          <${Icon} name="palette" size=${13} />
          <span>${tool ? `${name} (demo) isn't connected in this tab.` : 'No design tool picked yet.'} <a href="#/settings">Choose Canva or Figma</a> in Settings — or just paste a share link.</span>
        </div>`}
    <${Field} group=${true} label=${`${name} share link`} hint=${tool === 'figma' ? 'Share → Copy link (file, frame or prototype). Figma links preview live.' : 'Share → Copy link in your design tool.'}>
      <div className="row sw-link-row">
        <input
          className="input"
          type="url"
          value=${link}
          placeholder=${tool === 'figma' ? 'https://www.figma.com/design/…' : tool === 'canva' ? 'https://www.canva.com/design/…' : 'https://www.canva.com/… or https://www.figma.com/…'}
          onChange=${(e) => setLink(e.target.value)}
          onKeyDown=${(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              attach();
            }
          }}
        />
        <${Button} variant="secondary" size="sm" icon="link" disabled=${!link.trim()} onClick=${attach}>Attach<//>
      </div>
    <//>
    <div className="row sw-vis-row">
      ${tool
        ? html`<a className="btn btn-ghost btn-sm" href=${current ? current.link : openHref} target="_blank" rel="noopener noreferrer">
            <${Icon} name="external" size=${14} /> ${current ? `Open in ${current.type === 'figma' ? 'Figma' : 'Canva'}` : `Open ${name}`}
          </a>`
        : null}
      ${current
        ? html`<span className="small muted">LinkedIn needs an image file — export a PNG and add it:</span>`
        : null}
    </div>
    ${current ? html`<${UploadPanel} visual=${current} onVisual=${onVisual} label="Upload exported PNG" keepLink=${true} />` : null}
  </div>`;
}

function EditModal({ draft, initialTab, canOpenStudio, onClose, onSaveAndApprove }) {
  const profile = useProfile();
  const designTool = useStore((s) => (s.connections && s.connections.design && s.connections.design.tool) || null);
  const [body, setBody] = useState(draft.body || '');
  const [visual, setVisual] = useState(draft.visual || null);
  const [busyChip, setBusyChip] = useState('');
  const original = useRef(draft.body || '');
  const rewrote = useRef(false);
  const linkLabel = designTool === 'figma' ? 'Figma' : designTool === 'canva' ? 'Canva' : 'Canva / Figma';
  const [tab, setTab] = useState(() => {
    if (initialTab) return initialTab;
    const t = draft.visual && draft.visual.type;
    return t === 'sculptex' ? 'sculptex' : t === 'canva' || t === 'figma' ? 'link' : 'upload';
  });

  function storeBody() {
    const d = (getState().drafts || []).find((x) => x.id === draft.id);
    return d ? d.body || '' : '';
  }

  function save() {
    patchDraft(draft.id, { body, visual: visual || null });
  }

  function cancel() {
    if (rewrote.current && storeBody() !== original.current) patchDraft(draft.id, { body: original.current });
    onClose();
  }

  async function doRewrite(label) {
    if (busyChip) return;
    setBusyChip(label);
    try {
      if (body !== storeBody()) patchDraft(draft.id, { body });
      rewrote.current = true;
      const d = await rewrite(draft.id, label);
      const next = d && typeof d.body === 'string' ? d.body : storeBody();
      setBody(next);
    } catch (e) {
      toast(`Rewrite failed: ${errText(e)}`, 'error');
    } finally {
      setBusyChip('');
    }
  }

  const tabs = [
    { id: 'upload', label: 'Upload', icon: 'upload' },
    { id: 'link', label: linkLabel, icon: 'palette' },
    { id: 'sculptex', label: 'Sculptex 3D', icon: 'cube' },
  ];

  const footer = html`<div className="sw-edit-footer">
    ${canOpenStudio
      ? html`<${Button}
          variant="ghost"
          icon="external"
          onClick=${() => {
            save();
            onClose();
            navigate(`/studio?draft=${encodeURIComponent(draft.id)}`);
          }}
          >Open in Studio<//
        >`
      : null}
    <span className="spacer"></span>
    <${Button} variant="secondary" onClick=${cancel}>Cancel<//>
    <${Button}
      variant="secondary"
      icon="check"
      disabled=${!!busyChip}
      onClick=${() => {
        save();
        toast('Changes saved.', 'success');
        onClose();
      }}
      >Save<//
    >
    <${Button}
      variant="primary"
      icon="calendar"
      disabled=${!!busyChip || !body.trim()}
      onClick=${() => {
        save();
        onSaveAndApprove();
      }}
      >Save & approve<//
    >
  </div>`;

  return html`<${Modal} open=${true} title="Edit post" onClose=${cancel} wide=${true} footer=${footer} className="sw-modal">
    <div className="sw-edit">
      <div className="stack sw-edit-main">
        <${Field} label="Post">
          <textarea
            className="textarea sw-edit-body"
            rows="11"
            value=${body}
            disabled=${!!busyChip}
            onChange=${(e) => setBody(e.target.value)}
          ></textarea>
        <//>
        <div className="sw-chips" role="group" aria-label="Rewrite">
          ${REWRITE_CHIPS.map(
            (c) => html`<button
              key=${c.label}
              type="button"
              className=${cx('pill sw-rewrite', busyChip === c.label && 'is-active')}
              disabled=${!!busyChip}
              onClick=${() => doRewrite(c.label)}
            >
              ${busyChip === c.label ? html`<${Spinner} size=${12} />` : html`<${Icon} name=${c.icon} size=${13} />`}
              ${c.label}
            </button>`,
          )}
          <span className="sw-words small muted">${body.trim() ? body.trim().split(/\s+/).length : 0} words</span>
        </div>

        <section className="sw-visual">
          <div className="row sw-visual-head">
            <span className="field-label">Visual</span>
            <span className="spacer"></span>
            ${visual
              ? html`<${Button} variant="ghost" size="sm" icon="trash" onClick=${() => setVisual(null)}>Remove<//>`
              : html`<span className="small muted">Optional · posts with an image travel further</span>`}
          </div>
          ${draft.visualIdea ? html`<div className="sw-idea"><${Icon} name="sparkles" size=${14} /><span className="sw-idea-text"><span className="sw-idea-label">Idea</span> ${draft.visualIdea}</span></div>` : null}
          <${Tabs} tabs=${tabs} value=${tab} onChange=${setTab} className="sw-vis-tabs" />
          ${tab === 'upload' ? html`<${UploadPanel} visual=${visual} onVisual=${setVisual} label=${visual && visual.type === 'upload' ? 'Replace image' : 'Choose image'} />` : null}
          ${tab === 'link' ? html`<${LinkPanel} visual=${visual} onVisual=${setVisual} />` : null}
          ${tab === 'sculptex' ? html`<${SculptexPanel} draft=${draft} visual=${visual} onVisual=${setVisual} />` : null}
        </section>
      </div>
      <aside className="sw-edit-preview">
        <div className="sw-edit-preview-label small muted"><${Icon} name="eye" size=${13} /> Preview · LinkedIn (demo)</div>
        <${PostPreview} profile=${profile} title=${draft.title} body=${body} visual=${visual} timeLabel="now" defaultExpanded=${true} />
        ${visual && visual.type === 'figma' && visual.src
          ? html`<div className="small muted">Figma frame: <a href=${visual.link} target="_blank" rel="noopener noreferrer">open</a></div>`
          : null}
      </aside>
    </div>
  <//>`;
}

/* ------------------------------------------------------------------ */
/* SwipeStack                                                          */
/* ------------------------------------------------------------------ */

export function SwipeStack({ onEmpty, compact = false } = {}) {
  const pending = usePendingPosts();
  const threads = useStore((s) => s.threads);
  const generating = useStore((s) => !!(s.ui && s.ui.loading && s.ui.loading.suggestions));
  const onboarded = useStore((s) => !!s.onboarded);
  const profile = useProfile();
  const threadsById = useMemo(() => new Map((threads || []).map((t) => [t.id, t])), [threads]);

  const [editing, setEditing] = useState(null); // { id, tab }
  const [undo, setUndo] = useState(null); // { id, kind, message, key }
  const [hint, setHint] = useState(false);

  const stageRef = useRef(null);
  const cardRef = useRef(null);
  const drag = useRef(null);
  const busy = useRef(false);
  const frame = useRef(0);
  const returning = useRef(null);
  const undoTimer = useRef(null);
  const hintTimer = useRef(null);

  const top = pending[0] || null;
  const topRef = useRef(top);
  topRef.current = top;
  const visible = pending.slice(0, VISIBLE);
  const editingDraft = editing ? (getState().drafts || []).find((d) => d.id === editing.id) || null : null;

  const registerTop = useCallback((node) => {
    cardRef.current = node;
  }, []);

  const topEl = () => {
    const el = cardRef.current;
    return el && el.isConnected ? el : null;
  };

  const setProgress = (p) => {
    if (stageRef.current) stageRef.current.style.setProperty('--p', String(p));
  };

  function paint(el, x, y, width) {
    const t = width * THRESHOLD;
    el.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${x / 20}deg)`;
    el.style.setProperty('--approve', clamp(x / t, 0, 1).toFixed(3));
    el.style.setProperty('--decline', clamp(-x / t, 0, 1).toFixed(3));
    if (Math.abs(x) >= t) el.dataset.over = x > 0 ? 'approve' : 'decline';
    else delete el.dataset.over;
    setProgress(clamp(Math.abs(x) / t, 0, 1).toFixed(3));
  }

  function resetCard(el, animate = true) {
    if (!el) return;
    el.style.transition = animate && !reducedMotion() ? 'transform 560ms cubic-bezier(0.18, 1.35, 0.4, 1), opacity 200ms ease' : 'none';
    el.style.transform = '';
    el.style.opacity = '';
    el.style.setProperty('--approve', '0');
    el.style.setProperty('--decline', '0');
    delete el.dataset.over;
    delete el.dataset.grab;
    setProgress(0);
  }

  const stopHint = () => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = null;
    setHint(false);
  };

  const showUndo = (u) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({ ...u, key: Date.now() });
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
  };

  function act(draft, dir) {
    if (dir > 0) {
      const slot = approveSuggestion(draft.id);
      showUndo({ id: draft.id, kind: 'approve', message: slot ? `Scheduled for ${fmtWhen(slot)}` : 'Scheduled' });
    } else {
      declineSuggestion(draft.id);
      showUndo({ id: draft.id, kind: 'decline', message: 'Declined' });
    }
  }

  // Fly the top card off-screen, then approve (dir 1) or decline (dir -1).
  function commit(dir, from = {}) {
    const draft = topRef.current;
    if (!draft || busy.current) return;
    const el = topEl();
    stopHint();
    if (!el) {
      try {
        act(draft, dir);
      } catch (e) {
        toast(errText(e), 'error');
      }
      return;
    }
    busy.current = true;
    if (from.haptic) {
      try {
        if (navigator.vibrate) navigator.vibrate(12);
      } catch {
        /* no haptics */
      }
    }
    const reduced = reducedMotion();
    const w = el.offsetWidth || 360;
    const x0 = from.x || 0;
    const y0 = from.y || 0;
    const vx = from.vx || 0;
    const vy = from.vy || 0;
    const tx = dir * Math.max((window.innerWidth || 800) * 0.55 + w, Math.abs(x0) + w * 1.25);
    const ty = y0 + (vy ? clamp(vy * 180, -220, 220) : -28);
    const rot = clamp(tx / 20, -42, 42);
    const dur = reduced ? 160 : Math.round(clamp(FLY_MS - Math.abs(vx) * 80, 220, FLY_MS));

    el.style.setProperty('--approve', dir > 0 ? '1' : '0');
    el.style.setProperty('--decline', dir > 0 ? '0' : '1');
    el.dataset.over = dir > 0 ? 'approve' : 'decline';
    delete el.dataset.grab;
    if (stageRef.current) delete stageRef.current.dataset.dragging;
    if (reduced) {
      el.style.transition = `opacity ${dur}ms ease`;
      el.style.opacity = '0';
    } else {
      el.style.transition = `transform ${dur}ms cubic-bezier(0.25, 0.6, 0.35, 1), opacity ${dur}ms cubic-bezier(0.7, 0, 1, 1)`;
      el.style.transform = `translate3d(${tx}px, ${ty}px, 0) rotate(${rot}deg)`;
      el.style.opacity = '0';
    }
    setProgress(1);

    window.setTimeout(() => {
      try {
        act(draft, dir);
      } catch (e) {
        toast(errText(e), 'error');
        resetCard(el);
      } finally {
        busy.current = false;
      }
    }, dur);
  }

  function doUndo() {
    if (!undo) return;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    const u = undo;
    setUndo(null);
    try {
      undoSuggestion(u.id, 'pending');
      returning.current = { id: u.id, dir: u.kind === 'approve' ? 1 : -1 };
    } catch (e) {
      toast(`Couldn't undo: ${errText(e)}`, 'error');
    }
  }

  function openEdit(tab) {
    const d = topRef.current;
    if (!d || busy.current) return;
    stopHint();
    setEditing({ id: d.id, tab: tab || null });
  }

  /* ---------- pointer drag (mouse + touch + pen) ---------- */

  function onPointerDown(e) {
    // One pointer at a time: a second finger (non-primary) must not hijack a drag in progress.
    // (Not gated on drag.current, so a drag whose pointerup was lost can never lock the stack.)
    if (e.isPrimary === false) return;
    const el = topEl();
    if (!el || busy.current || editing || !el.contains(e.target)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest && e.target.closest('button, a, input, textarea, select, label, iframe, video, [data-no-drag]')) return;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported */
    }
    if (e.pointerType === 'mouse') e.preventDefault();
    stopHint();
    const t = e.timeStamp || performance.now();
    drag.current = {
      id: e.pointerId,
      type: e.pointerType,
      sx: e.clientX,
      sy: e.clientY,
      x: 0,
      y: 0,
      moved: false,
      w: el.offsetWidth || 360,
      samples: [{ t, x: e.clientX, y: e.clientY }],
    };
    el.style.transition = 'none';
    el.dataset.grab = '1';
  }

  function onPointerMove(e) {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const x = e.clientX - d.sx;
    const y = e.clientY - d.sy;
    if (!d.moved) {
      if (Math.hypot(x, y) < 5) return;
      d.moved = true;
      if (stageRef.current) stageRef.current.dataset.dragging = '1';
    }
    d.x = x;
    d.y = y * 0.55;
    const t = e.timeStamp || performance.now();
    d.samples.push({ t, x: e.clientX, y: e.clientY });
    while (d.samples.length > 2 && t - d.samples[0].t > 100) d.samples.shift();
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = topEl();
      if (el && drag.current === d) paint(el, d.x, d.y, d.w);
    });
  }

  function endDrag(e, cancelled) {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    const el = topEl();
    if (el) {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      delete el.dataset.grab;
    }
    if (stageRef.current) delete stageRef.current.dataset.dragging;
    if (!el) return;
    if (!d.moved || cancelled) {
      resetCard(el, d.moved);
      return;
    }
    const t = e.timeStamp || performance.now();
    d.samples.push({ t, x: e.clientX, y: e.clientY });
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    const dt = Math.max(1, last.t - first.t);
    const vx = (last.x - first.x) / dt;
    const vy = (last.y - first.y) / dt;
    const flick = Math.abs(vx) > FLICK_VELOCITY && Math.abs(d.x) > 30 && Math.sign(vx) === Math.sign(d.x);
    if (Math.abs(d.x) > d.w * THRESHOLD || flick) {
      commit(d.x > 0 ? 1 : -1, { x: d.x, y: d.y, vx, vy, haptic: d.type === 'touch' });
    } else {
      resetCard(el);
    }
  }

  /* ---------- keyboard ---------- */

  const keyActions = useRef({});
  keyActions.current = {
    approve: () => commit(1),
    decline: () => commit(-1),
    edit: () => openEdit(),
    blocked: () => !!editing,
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (isTypingTarget(document.activeElement) || anyModalOpen() || keyActions.current.blocked()) return;
      if (!topRef.current) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        keyActions.current.approve();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        keyActions.current.decline();
      } else if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        keyActions.current.edit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ---------- effects ---------- */

  // New top card: settle the depth progress, and fly an undone card back in from the side it left.
  const topId = top ? top.id : null;
  useLayoutEffect(() => {
    setProgress(0);
    const r = returning.current;
    const el = topEl();
    if (!r || !el || r.id !== topId) return;
    returning.current = null;
    if (reducedMotion()) return;
    const w = el.offsetWidth || 360;
    el.style.transition = 'none';
    el.style.opacity = '0';
    el.style.transform = `translate3d(${r.dir * ((window.innerWidth || 800) * 0.45 + w)}px, -24px, 0) rotate(${r.dir * 28}deg)`;
    el.getBoundingClientRect();
    el.style.transition = 'transform 620ms cubic-bezier(0.18, 1.25, 0.4, 1), opacity 260ms ease';
    el.style.transform = '';
    el.style.opacity = '';
  }, [topId]);

  // One gentle "nudge" per session to show the card can be swiped.
  useEffect(() => {
    if (!topId || reducedMotion()) return;
    let seen = false;
    try {
      seen = sessionStorage.getItem(HINT_KEY) === '1';
      sessionStorage.setItem(HINT_KEY, '1');
    } catch {
      seen = false;
    }
    if (seen) return;
    setHint(true);
    hintTimer.current = setTimeout(() => setHint(false), 2400);
  }, [!!topId]);

  // Tell the host when there is nothing left to review (not while suggestions are being generated).
  const empty = pending.length === 0;
  const onEmptyRef = useRef(onEmpty);
  onEmptyRef.current = onEmpty;
  const firedEmpty = useRef(false);
  useEffect(() => {
    if (!empty) {
      firedEmpty.current = false;
      return undefined;
    }
    // Hold off while the Undo bar is showing, so the last swipe can still be undone before the host moves on.
    if (generating || undo || firedEmpty.current) return undefined;
    const t = setTimeout(() => {
      firedEmpty.current = true;
      if (onEmptyRef.current) onEmptyRef.current();
    }, 700);
    return () => clearTimeout(t);
  }, [empty, generating, undo]);

  useEffect(
    () => () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
      if (hintTimer.current) clearTimeout(hintTimer.current);
      if (frame.current) cancelAnimationFrame(frame.current);
    },
    [],
  );

  // Close the editor if its draft disappears (deleted elsewhere).
  useEffect(() => {
    if (editing && !editingDraft) setEditing(null);
  }, [editing, editingDraft]);

  /* ---------- render ---------- */

  const n = pending.length;

  let stage;
  if (top) {
    stage = html`<div
      ref=${stageRef}
      className="sw-stage"
      onPointerDown=${onPointerDown}
      onPointerMove=${onPointerMove}
      onPointerUp=${(e) => endDrag(e, false)}
      onPointerCancel=${(e) => endDrag(e, true)}
      onLostPointerCapture=${(e) => endDrag(e, true)}
    >
      ${visible.map(
        (d, i) => html`<${SwipeCard}
          key=${d.id}
          draft=${d}
          depth=${i}
          isTop=${i === 0}
          position=${1}
          total=${n}
          profile=${profile}
          threadsById=${threadsById}
          hint=${hint}
          registerTop=${registerTop}
          onOpenVisual=${openEdit}
        />`,
      )}
    </div>`;
  } else if (generating) {
    stage = html`<${SkeletonStack} />`;
  } else {
    stage = html`<${EmptyStack} generating=${generating} compact=${compact} />`;
  }

  return html`<div className=${cx('sw-root', compact && 'is-compact')}>
    ${compact && n
      ? html`<div className="sw-meta small">
          <span><strong>${n}</strong> ${n === 1 ? 'post' : 'posts'} to review</span>
          <span className="muted">Approved posts go to your next best time slot</span>
        </div>`
      : null}
    ${stage}
    ${top
      ? html`<div className="sw-controls">
            <div className="sw-ctl">
              <button type="button" className="sw-btn sw-btn-decline" onClick=${() => commit(-1)} aria-label="Decline (Left arrow)" title="Decline (←)">
                <${Icon} name="x" size=${26} strokeWidth=${2.25} />
              </button>
              <span className="sw-ctl-label">Decline</span>
            </div>
            <div className="sw-ctl">
              <button type="button" className="sw-btn sw-btn-edit" onClick=${() => openEdit()} aria-label="Edit (E)" title="Edit (E)">
                <${Icon} name="edit" size=${19} strokeWidth=${2} />
              </button>
              <span className="sw-ctl-label">Edit</span>
            </div>
            <div className="sw-ctl">
              <button type="button" className="sw-btn sw-btn-approve" onClick=${() => commit(1)} aria-label="Approve and schedule (Right arrow)" title="Approve (→)">
                <${Icon} name="check" size=${26} strokeWidth=${2.25} />
              </button>
              <span className="sw-ctl-label">Approve</span>
            </div>
          </div>
          <div className="sw-legend" aria-hidden="true">
            <span><${Kbd}>←<//> Decline</span>
            <span><${Kbd}>E<//> Edit</span>
            <span><${Kbd}>→<//> Approve</span>
          </div>`
      : null}
    <div className="sw-undo-slot" role="status" aria-live="polite">
      ${undo
        ? html`<div key=${undo.key} className=${cx('sw-undo', `is-${undo.kind}`)}>
            <span className="sw-undo-icon" aria-hidden="true"><${Icon} name=${undo.kind === 'approve' ? 'calendar' : 'x'} size=${13} strokeWidth=${2.25} /></span>
            <span className="sw-undo-msg">${undo.message}</span>
            ${undo.kind === 'approve' && onboarded && !compact ? html`<a className="sw-undo-link" href="#/schedule">View</a>` : null}
            <button type="button" className="sw-undo-btn" onClick=${doUndo}>Undo</button>
            <span className="sw-undo-timer" style=${{ animationDuration: `${UNDO_MS}ms` }} aria-hidden="true"></span>
          </div>`
        : null}
    </div>
    ${editingDraft
      ? html`<${EditModal}
          key=${editingDraft.id}
          draft=${editingDraft}
          initialTab=${editing.tab}
          canOpenStudio=${onboarded}
          onClose=${() => setEditing(null)}
          onSaveAndApprove=${() => {
            const id = editingDraft.id;
            setEditing(null);
            if (topRef.current && topRef.current.id === id) {
              requestAnimationFrame(() => commit(1));
            } else {
              const d = (getState().drafts || []).find((x) => x.id === id);
              if (d && isPendingPost(d)) {
                try {
                  act(d, 1);
                } catch (e) {
                  toast(errText(e), 'error');
                }
              }
            }
          }}
        />`
      : null}
  </div>`;
}

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */

export default function StackPage() {
  const count = useStore((s) => (s.drafts || []).filter(isPendingPost).length);
  const generating = useStore((s) => !!(s.ui && s.ui.loading && s.ui.loading.suggestions));

  return html`<div className="page sw-page">
    <div className="page-header">
      <div>
        <h1 className="sw-title">
          Suggested posts
          ${count ? html`<span className="sw-count" aria-label=${`${count} to review`}>${count}</span>` : null}
        </h1>
        <p className="page-sub">Drafted from what your audience is saying. Swipe right to schedule at your next best time, left to pass.</p>
      </div>
      <div className="page-actions">
        <${Button} variant="primary" icon="sparkles" loading=${generating} onClick=${generateMore}>Generate more<//>
      </div>
    </div>
    <${SwipeStack} />
  </div>`;
}

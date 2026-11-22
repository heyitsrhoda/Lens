// Shared Canva visual picker (real Canva MCP, https://mcp.canva.com/mcp — OAuth sign-in, no API key).
// Used by Studio's visual section and the swipe-stack edit modal. The connection lives in
// state.connections.canva (sessionStorage only). onVisual(visual) receives a Draft.visual:
//   { type:'canva', designId, src, link, caption }
import { html, useState, useEffect, useRef } from '../lib.js';
import { useStore, toast } from '../store.js';
import { Button, Icon, Spinner } from '../ui.js';
import {
  connectCanva,
  canvaGenerate,
  canvaCreateFromCandidate,
  canvaDesigns,
  canvaVisual,
} from '../services/lens.js';

function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

function errText(e) {
  return e && e.message ? e.message : String(e);
}

function clip(text, n) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

export function defaultCanvaPrompt(draft) {
  const d = draft || {};
  if (d.visualIdea) return String(d.visualIdea);
  const topic = d.title || d.painPoint || clip(d.body, 140);
  return topic ? `A clean, bold social post graphic for LinkedIn about: ${topic}` : '';
}

function Thumb({ src, alt }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (!src || broken) {
    return html`<span className="cv-thumb cv-thumb-empty" aria-hidden="true"><${Icon} name="palette" size=${20} /></span>`;
  }
  return html`<span className="cv-thumb"><img src=${src} alt=${alt || ''} loading="lazy" referrerPolicy="no-referrer" onError=${() => setBroken(true)} /></span>`;
}

function DesignGrid({ items, busyId, selectedId, disabled, onPick, empty }) {
  if (!items.length) return empty ? html`<p className="small muted">${empty}</p>` : null;
  return html`<div className="cv-grid">
    ${items.map(
      (it) => html`<button
        key=${it.id}
        type="button"
        className=${cx('cv-item', selectedId === it.id && 'is-selected')}
        disabled=${disabled}
        onClick=${() => onPick(it)}
        title=${it.title || 'Canva design'}
      >
        <${Thumb} src=${it.thumbnailUrl} alt=${it.title || 'Canva design'} />
        <span className="cv-item-title truncate">${it.title || 'Untitled design'}</span>
        ${busyId === it.id ? html`<span className="cv-item-busy"><${Spinner} size=${16} /></span>` : null}
      </button>`,
    )}
  </div>`;
}

function ConnectPrompt({ conn, onBeforeConnect, beforeConnectNote }) {
  const [busy, setBusy] = useState(false);
  const connecting = busy || conn.status === 'connecting';
  async function go() {
    setBusy(true);
    try {
      // Sign-in is a full-page redirect: let the host save anything that lives only in component state.
      if (onBeforeConnect) onBeforeConnect();
      const res = await connectCanva();
      if (res && res.redirecting) return; // leaving for Canva sign-in; the callback returns to this page
    } catch (e) {
      toast(`Canva: ${errText(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  }
  return html`<div className="stack cv-panel">
    <div className="cv-note">
      <${Icon} name="palette" size=${14} />
      <span>
        Connect your Canva account to generate graphics with Canva AI or attach one of your designs. Sign-in opens
        Canva (no API key) and the connection lasts for this tab only.
      </span>
    </div>
    ${beforeConnectNote ? html`<p className="small muted">${beforeConnectNote}</p>` : null}
    ${conn.status === 'error' && conn.error ? html`<div className="cv-note is-warn"><${Icon} name="alert" size=${14} /><span>${clip(conn.error, 220)}</span></div>` : null}
    <div className="row cv-row">
      <${Button} variant="primary" size="sm" icon="plug" loading=${connecting} onClick=${go}>
        ${conn.status === 'error' ? 'Reconnect Canva' : 'Connect Canva'}
      <//>
      <a className="small" href="#/settings?tab=connections">Settings → Connections</a>
    </div>
  </div>`;
}

function GeneratePane({ draft, attach, busy, setBusy }) {
  const [prompt, setPrompt] = useState(() => defaultCanvaPrompt(draft));
  const [result, setResult] = useState(null); // { jobId, candidates, design }
  const [error, setError] = useState('');
  const alive = useAlive();

  async function generate() {
    const p = prompt.trim();
    if (!p || busy) return;
    setBusy('generate');
    setError('');
    try {
      const res = await canvaGenerate({ prompt: p });
      if (alive.current) setResult(res);
    } catch (e) {
      if (alive.current) setError(errText(e));
    } finally {
      if (alive.current) setBusy('');
    }
  }

  async function pickCandidate(c) {
    if (busy || !result) return;
    setBusy(`cand:${c.id}`);
    setError('');
    try {
      const { design } = await canvaCreateFromCandidate(c.id, result.jobId);
      if (!alive.current) return;
      setResult((r) => (r ? { ...r, design } : r));
      await attach(design, `cand:${c.id}`);
    } catch (e) {
      if (alive.current) setError(errText(e));
    } finally {
      if (alive.current) setBusy('');
    }
  }

  const candidates = (result && result.candidates) || [];
  const created = result && result.design;
  const busyId = busy.startsWith('cand:') ? busy.slice(5) : busy.startsWith('design:') ? busy.slice(7) : '';

  return html`<div className="stack cv-pane">
    <label className="field">
      <span className="field-label">Describe the graphic</span>
      <textarea
        className="textarea"
        rows="3"
        value=${prompt}
        placeholder="A bold quote card: “Stop guessing tolerances” on a dark blue background"
        disabled=${!!busy}
        onChange=${(e) => setPrompt(e.target.value)}
      ></textarea>
      ${draft && draft.visualIdea ? html`<span className="field-hint">Prefilled from this post's visual idea.</span>` : null}
    </label>
    <div className="row cv-row">
      <${Button} variant="primary" size="sm" icon="sparkles" loading=${busy === 'generate'} disabled=${!!busy || !prompt.trim()} onClick=${generate}>
        ${result ? 'Generate again' : 'Generate with Canva'}
      <//>
      ${busy === 'generate' ? html`<span className="small muted">Canva AI is designing — this can take up to a minute…</span>` : null}
    </div>
    ${error ? html`<div className="cv-note is-warn"><${Icon} name="alert" size=${14} /><span>${error}</span></div>` : null}
    ${candidates.length
      ? html`<div className="stack cv-results">
          <span className="small muted">Pick one — Lens creates it in your Canva account and exports a PNG for the post.</span>
          <${DesignGrid}
            items=${candidates.map((c, i) => ({ ...c, title: c.title || `Option ${i + 1}` }))}
            busyId=${busyId}
            disabled=${!!busy}
            onPick=${pickCandidate}
          />
        </div>`
      : null}
    ${!candidates.length && created
      ? html`<${DesignGrid} items=${[created]} busyId=${busyId} disabled=${!!busy} onPick=${(d) => attach(d, `design:${d.id}`)} />`
      : null}
  </div>`;
}

function DesignsPane({ attach, busy, setBusy, selectedId }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const alive = useAlive();

  async function load(q = query) {
    setBusy('search');
    setError('');
    try {
      const list = await canvaDesigns({ query: q.trim(), limit: 12 });
      if (alive.current) setItems(list || []);
    } catch (e) {
      if (alive.current) {
        setItems([]);
        setError(errText(e));
      }
    } finally {
      if (alive.current) setBusy('');
    }
  }

  useEffect(() => {
    load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busyId = busy.startsWith('design:') ? busy.slice(7) : '';

  return html`<div className="stack cv-pane">
    <form
      className="row cv-row cv-search"
      onSubmit=${(e) => {
        e.preventDefault();
        if (!busy) load();
      }}
    >
      <input
        className="input"
        type="search"
        value=${query}
        placeholder="Search your Canva designs"
        aria-label="Search your Canva designs"
        onChange=${(e) => setQuery(e.target.value)}
      />
      <${Button} type="submit" variant="secondary" size="sm" icon="search" loading=${busy === 'search'} disabled=${!!busy}>Search<//>
    </form>
    ${error ? html`<div className="cv-note is-warn"><${Icon} name="alert" size=${14} /><span>${error}</span></div>` : null}
    ${items === null
      ? html`<div className="row small muted"><${Spinner} /> Loading your recent designs…</div>`
      : html`<${DesignGrid}
          items=${items}
          busyId=${busyId}
          selectedId=${selectedId}
          disabled=${!!busy}
          onPick=${(d) => attach(d, `design:${d.id}`)}
          empty=${busy === 'search' || error ? '' : query.trim() ? 'No designs match that search.' : 'No designs found in your Canva account yet.'}
        />`}
  </div>`;
}

function useAlive() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

/**
 * Canva tab content. Props: draft (for the prompt prefill), visual (current visual), onVisual(visual).
 * Optional onBeforeConnect() runs right before the Canva sign-in redirect (e.g. to save unsaved edits), and
 * beforeConnectNote is shown under the Connect prompt to say so.
 */
export function CanvaPanel({ draft, visual, onVisual, onBeforeConnect, beforeConnectNote }) {
  const conn = useStore((s) => (s.connections && s.connections.canva) || {});
  const connected = conn.status === 'connected';
  const [mode, setMode] = useState('generate');
  const [busy, setBusy] = useState('');
  const alive = useAlive();
  const current = visual && visual.type === 'canva' ? visual : null;

  async function attach(design, busyKey) {
    const refresh = busyKey === 'refresh';
    setBusy(busyKey || `design:${design.id}`);
    try {
      const { visual: v, fromThumbnail, exportError } = await canvaVisual(design, {
        refresh,
        caption: refresh && current ? current.caption : undefined,
      });
      if (!alive.current) return;
      if (!v.src) {
        toast('Canva returned no image for that design. Try another one.', 'error');
        return;
      }
      onVisual(v);
      if (fromThumbnail) {
        const why = String(exportError || 'Canva export failed').trim();
        toast(
          `${/[.!?…]$/.test(why) ? why : `${why}.`} Attached a temporary preview instead — it expires in about 15 minutes, so refresh or pick another design before posting.`,
          'error',
          { duration: 9000 },
        );
      } else {
        toast(refresh ? 'Canva image refreshed.' : 'Canva design attached.', 'success');
      }
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      if (alive.current) setBusy('');
    }
  }

  if (!connected) {
    return html`<${ConnectPrompt} conn=${conn} onBeforeConnect=${onBeforeConnect} beforeConnectNote=${beforeConnectNote} />`;
  }

  return html`<div className="stack cv-panel">
    <div className="cv-note is-ok">
      <${Icon} name="check" size=${14} />
      <span>Canva connected${conn.account ? ` · ${conn.account}` : ''} · this tab only.</span>
    </div>

    ${current
      ? html`<div className="cv-current">
          <${Thumb} src=${current.src} alt=${current.caption || 'Canva design'} />
          <div className="cv-current-text">
            <strong className="small">${current.caption || 'Canva design'}</strong>
            <span className="small muted">Canva image links expire after a while — refresh before posting if the preview breaks.</span>
            <div className="row cv-row">
              ${current.link
                ? html`<a className="btn btn-secondary btn-sm" href=${current.link} target="_blank" rel="noopener noreferrer">
                    <${Icon} name="external" size=${14} /> Open in Canva
                  </a>`
                : null}
              ${current.designId
                ? html`<${Button}
                    variant="ghost"
                    size="sm"
                    icon="refresh"
                    loading=${busy === 'refresh'}
                    disabled=${!!busy}
                    onClick=${() => attach({ id: current.designId, editUrl: current.link }, 'refresh')}
                  >Refresh image<//>`
                : null}
            </div>
          </div>
        </div>`
      : null}

    <div className="cv-seg" role="tablist" aria-label="Canva source">
      ${[
        { id: 'generate', label: 'Generate with Canva', icon: 'sparkles' },
        { id: 'designs', label: 'Your designs', icon: 'image' },
      ].map(
        (o) => html`<button
          key=${o.id}
          type="button"
          role="tab"
          aria-selected=${mode === o.id ? 'true' : 'false'}
          className=${cx('cv-seg-btn', mode === o.id && 'is-active')}
          disabled=${!!busy && mode !== o.id}
          onClick=${() => setMode(o.id)}
        >
          <${Icon} name=${o.icon} size=${14} /> ${o.label}
        </button>`,
      )}
    </div>

    ${mode === 'generate'
      ? html`<${GeneratePane} draft=${draft} attach=${attach} busy=${busy} setBusy=${setBusy} />`
      : html`<${DesignsPane} attach=${attach} busy=${busy} setBusy=${setBusy} selectedId=${current && current.designId} />`}
  </div>`;
}

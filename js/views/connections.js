// Connections — rendered inside Settings → Connections (named export ConnectionsPanel).
// No accounts. API keys live in localStorage; tool connections (Sculptex MCP, mock design tool,
// mock LinkedIn) live in sessionStorage only. You.com is the default AI provider via ./api/you.
import { html, useState, useEffect } from '../lib.js';
import { useStore, setState, getState, toast, SCULPTEX_URL, liveFlags } from '../store.js';
import { Button, Card, Badge, Icon, Spinner } from '../ui.js';
import * as mcp from '../services/mcp.js';
import * as youcom from '../services/youcom.js';
import * as claude from '../services/claude.js';
import { connectLinkedIn, disconnectLinkedIn, renderWithSculptex, connectDesignTool, disconnectDesignTool } from '../services/lens.js';

const DEFAULT_SCULPTEX_URL = SCULPTEX_URL;
const DEFAULT_RENDER_PROMPT = 'a 40mm cable clip for a desk edge';
const EMPTY = Object.freeze([]);

const CLAUDE_MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (default, balanced)' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (most capable)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest)' },
];

const STATUS_META = {
  disconnected: { tone: 'neutral', label: 'Not connected' },
  connecting: { tone: 'info', label: 'Connecting…' },
  connected: { tone: 'success', label: 'Connected' },
  error: { tone: 'danger', label: 'Error' },
};

/* ---------- small helpers ---------- */

function patchConnection(key, patch) {
  setState((s) => {
    const all = s.connections || {};
    return { connections: { ...all, [key]: { ...(all[key] || {}), ...patch } } };
  });
}

function patchSettings(patch) {
  setState((s) => ({ settings: { ...(s.settings || {}), ...patch } }));
}

// Saving a first key switches off demo mode, otherwise the key would be ignored.
function saveKey(field, value) {
  const v = String(value || '').trim();
  const settings = getState().settings || {};
  const turnOff = v && !settings[field] && settings.demoModeExplicit && settings.demoMode;
  patchSettings(turnOff ? { [field]: v, demoMode: false, demoModeExplicit: true } : { [field]: v });
  if (turnOff) toast('Demo mode turned off — using your keys.', 'info');
}

function errMessage(e) {
  if (!e) return 'Unknown error';
  if (typeof e === 'string') return e;
  return e.message || String(e);
}

function validServerUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

function shortenLongStrings(_key, value) {
  if (typeof value === 'string' && value.length > 300) {
    return `${value.slice(0, 120)}… (${value.length.toLocaleString()} chars)`;
  }
  return value;
}

function prettyJson(value) {
  try {
    const text = JSON.stringify(value, shortenLongStrings, 2);
    if (text === undefined) return String(value);
    return text.length > 6000 ? `${text.slice(0, 6000)}\n… truncated` : text;
  } catch {
    return String(value);
  }
}

function initialsOf(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || 'in';
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || STATUS_META.disconnected;
  return html`<${Badge} tone=${meta.tone}>${meta.label}<//>`;
}

function KeyInput({ id, value, onChange, placeholder }) {
  const [shown, setShown] = useState(false);
  return html`
    <div className="cx-key">
      <input
        id=${id}
        className="input cx-key-input"
        type=${shown ? 'text' : 'password'}
        value=${value}
        placeholder=${placeholder}
        autoComplete="off"
        spellCheck=${false}
        onChange=${(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="btn btn-ghost btn-sm cx-key-toggle"
        aria-label=${shown ? 'Hide key' : 'Show key'}
        aria-pressed=${shown}
        onClick=${() => setShown((v) => !v)}
      >
        <${Icon} name="eye" size=${16} />
        <span>${shown ? 'Hide' : 'Show'}</span>
      </button>
    </div>
  `;
}

function ResultBox({ tone, title, children }) {
  return html`
    <div className=${`cx-result cx-result-${tone}`} role=${tone === 'error' ? 'alert' : 'status'}>
      <div className="cx-result-title">
        <${Icon} name=${tone === 'error' ? 'x' : 'check'} size=${14} />
        <span>${title}</span>
      </div>
      ${children && html`<div className="cx-result-body">${children}</div>`}
    </div>
  `;
}

/* ---------- 1. Sculptex MCP (real) ---------- */

function ToolItem({ tool }) {
  const schema = tool.inputSchema || tool.input_schema;
  const props = schema && schema.properties ? Object.keys(schema.properties) : [];
  return html`
    <li className="cx-tool">
      <details>
        <summary>
          <span className="cx-tool-name">${tool.name}</span>
          ${props.length > 0 && html`<span className="cx-tool-args small muted">(${props.join(', ')})</span>`}
          ${tool.description && html`<span className="cx-tool-desc small muted">${tool.description}</span>`}
        </summary>
        ${schema
          ? html`<pre className="cx-pre">${prettyJson(schema)}</pre>`
          : html`<p className="small muted">This tool does not publish an input schema.</p>`}
      </details>
    </li>
  `;
}

function RenderResult({ result, live }) {
  if (!result) return null;
  const img = result.renderUrl || result.imageUrl || null;
  return html`
    <div className="cx-render">
      <div className="row">
        <strong className="small">Render result</strong>
        ${live
          ? html`<${Badge} tone="success">Live from Sculptex<//>`
          : html`<${Badge} tone="warning">Demo placeholder<//>`}
      </div>
      ${img
        ? html`<div className="cx-render-frame"><img src=${img} alt="Sculptex render of the test prompt" loading="lazy" /></div>`
        : html`<p className="small muted">The tool did not return an image. See the raw result below.</p>`}
      ${result.modelUrl &&
      html`<a className="btn btn-secondary btn-sm" href=${result.modelUrl} target="_blank" rel="noopener noreferrer">
        <${Icon} name="cube" size=${14} /> Open 3D model <${Icon} name="external" size=${12} />
      </a>`}
      ${result.raw !== undefined &&
      html`<details className="cx-raw">
        <summary className="small">Raw MCP result</summary>
        <pre className="cx-pre">${prettyJson(result.raw)}</pre>
      </details>`}
    </div>
  `;
}

function SculptexCard() {
  const conn = useStore((s) => (s.connections ? s.connections.sculptex : null)) || {};
  const status = conn.status || 'disconnected';
  const tools = conn.tools || EMPTY;
  const connected = status === 'connected';

  const [url, setUrl] = useState(conn.url || DEFAULT_SCULPTEX_URL);
  const [urlError, setUrlError] = useState('');
  const [busy, setBusy] = useState('');
  const [token, setToken] = useState('');
  const [prompt, setPrompt] = useState(DEFAULT_RENDER_PROMPT);
  const [render, setRender] = useState({ state: 'idle', result: null, error: '', live: false });

  useEffect(() => {
    setUrl(conn.url || DEFAULT_SCULPTEX_URL);
  }, [conn.url]);

  function commitUrl() {
    const next = url.trim();
    if (!validServerUrl(next)) {
      setUrlError('Enter a full https:// MCP endpoint URL.');
      return false;
    }
    setUrlError('');
    if (next !== conn.url) {
      // Tokens and sessions belong to a specific server — drop them when the URL changes.
      patchConnection('sculptex', { url: next, tools: [], auth: null, sessionId: null, error: '', status: 'disconnected' });
    }
    return true;
  }

  async function doConnect() {
    if (!commitUrl()) return;
    setBusy('connect');
    try {
      await mcp.connect('sculptex');
      const after = getState().connections?.sculptex;
      if (after && after.status === 'connected') {
        toast(`Sculptex connected — ${(after.tools || []).length} tools available`, 'success');
      }
    } catch (e) {
      patchConnection('sculptex', { status: 'error', error: errMessage(e) });
    } finally {
      setBusy('');
    }
  }

  function doDisconnect() {
    try {
      mcp.disconnect('sculptex');
    } catch (e) {
      patchConnection('sculptex', { status: 'disconnected', tools: [], auth: null, sessionId: null, error: '' });
    }
    setRender({ state: 'idle', result: null, error: '', live: false });
    toast('Sculptex disconnected. Its token was removed from this tab.', 'info');
  }

  async function refreshTools() {
    setBusy('tools');
    try {
      const list = await mcp.listTools('sculptex');
      if (Array.isArray(list)) patchConnection('sculptex', { tools: list });
    } catch (e) {
      patchConnection('sculptex', { error: errMessage(e) });
    } finally {
      setBusy('');
    }
  }

  async function applyToken() {
    const t = token.trim().replace(/^Bearer\s+/i, '');
    if (!t) return;
    if (!commitUrl()) return;
    setBusy('connect');
    try {
      // setManualToken stores the token and runs the one connect for it.
      await mcp.setManualToken('sculptex', t);
      const after = getState().connections?.sculptex;
      if (after && after.status === 'connected') {
        toast(`Sculptex connected — ${(after.tools || []).length} tools available`, 'success');
      }
    } catch (e) {
      patchConnection('sculptex', { status: 'error', error: errMessage(e) });
    } finally {
      setBusy('');
      setToken('');
    }
  }

  async function testRender() {
    const p = prompt.trim() || DEFAULT_RENDER_PROMPT;
    const live = getState().connections?.sculptex?.status === 'connected';
    setRender({ state: 'loading', result: null, error: '', live });
    try {
      const result = await renderWithSculptex({ prompt: p });
      setRender({ state: 'done', result, error: '', live: live && !(result && result.demo) });
    } catch (e) {
      setRender({ state: 'error', result: null, error: errMessage(e), live });
    }
  }

  const authMode = conn.auth ? (conn.auth.refreshToken || conn.auth.tokenEndpoint ? 'OAuth' : 'Pasted token') : null;
  const isDefault = (conn.url || DEFAULT_SCULPTEX_URL) === DEFAULT_SCULPTEX_URL;

  return html`
    <${Card}
      className="cx-card cx-span-2"
      title=${html`<span className="cx-title"><span className="cx-logo cx-logo-sculptex"><${Icon} name="cube" size=${18} /></span>Sculptex MCP</span>`}
      subtitle="Real MCP server for 3D renders used in Studio visuals."
      actions=${html`<div className="row cx-badges">
        <${Badge} tone="info">Session only<//>
        <${StatusBadge} status=${status} />
      </div>`}
    >
      <div className="stack">
        <div className="field">
          <label className="field-label" htmlFor="cx-sculptex-url">Server URL</label>
          <div className="cx-inline">
            <input
              id="cx-sculptex-url"
              className="input"
              type="url"
              value=${url}
              disabled=${connected || busy === 'connect'}
              onChange=${(e) => setUrl(e.target.value)}
              onBlur=${() => url.trim() !== (conn.url || '') && commitUrl()}
              spellCheck=${false}
            />
            ${!connected && !isDefault &&
            html`<${Button} variant="ghost" size="sm" onClick=${() => { setUrl(DEFAULT_SCULPTEX_URL); patchConnection('sculptex', { url: DEFAULT_SCULPTEX_URL, auth: null, tools: [], sessionId: null, error: '', status: 'disconnected' }); }}>Reset<//>`}
          </div>
          ${urlError
            ? html`<span className="field-hint cx-danger-text">${urlError}</span>`
            : html`<span className="field-hint">Streamable HTTP endpoint. ${connected ? 'Disconnect to change it.' : ''}</span>`}
        </div>

        <div className="cx-note">
          <${Icon} name="link" size=${14} />
          <span>
            Connect may send you to Sculptex to sign in (OAuth). You'll come straight back here. The token is kept in
            this tab's sessionStorage only — close the tab and the connection is gone.
          </span>
        </div>

        <div className="row cx-actions">
          ${connected
            ? html`
                <${Button} variant="secondary" icon="refresh" loading=${busy === 'tools'} disabled=${!!busy} onClick=${refreshTools}>Refresh tools<//>
                <${Button} variant="ghost" icon="x" onClick=${doDisconnect}>Disconnect<//>
              `
            : html`
                <${Button} variant="primary" icon="plug" loading=${busy === 'connect'} disabled=${!!busy} onClick=${doConnect}>
                  ${status === 'error' ? 'Try again' : 'Connect'}
                <//>
                ${(status === 'error' || status === 'connecting') && !busy &&
                html`<${Button} variant="ghost" onClick=${doDisconnect}>Reset connection<//>`}
              `}
          <span className="spacer"></span>
          ${connected && authMode && html`<span className="small muted">Auth: ${authMode}${conn.sessionId ? ' · session active' : ''}</span>`}
        </div>

        ${(conn.error || status === 'error') &&
        html`<${ResultBox} tone="error" title="Sculptex connection problem">${conn.error || 'The server did not complete the connection.'}<//>`}

        ${!connected &&
        html`<details className="cx-disclosure">
          <summary>Paste access token instead</summary>
          <div className="stack cx-disclosure-body">
            <p className="small muted">
              If the OAuth pop-over can't complete (for example, a blocked redirect), paste a Sculptex access token. It is
              stored for this tab session only.
            </p>
            <div className="cx-key">
              <input
                className="input cx-key-input"
                type="password"
                value=${token}
                placeholder="Access token"
                autoComplete="off"
                spellCheck=${false}
                onChange=${(e) => setToken(e.target.value)}
                onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); if (!busy) applyToken(); } }}
                aria-label="Sculptex access token"
              />
              <${Button} variant="secondary" size="sm" disabled=${!token.trim() || !!busy} onClick=${applyToken}>Use token & connect<//>
            </div>
          </div>
        </details>`}

        <div className="divider"></div>

        <div className="cx-section">
          <div className="row">
            <h3 className="cx-h3">Discovered tools</h3>
            ${connected && html`<${Badge} tone="neutral">${tools.length}<//>`}
          </div>
          ${connected
            ? tools.length
              ? html`<ul className="cx-tools">${tools.map((t) => html`<${ToolItem} key=${t.name} tool=${t} />`)}</ul>`
              : html`<p className="small muted">Connected, but the server listed no tools. Try “Refresh tools”.</p>`
            : html`<p className="small muted">Connect to list the tools Sculptex exposes. Click a tool to see its input schema.</p>`}
        </div>

        <div className="divider"></div>

        <div className="cx-section">
          <h3 className="cx-h3">Test render</h3>
          <p className="small muted">
            ${connected
              ? 'Runs the best-matching Sculptex tool with this prompt.'
              : 'Not connected — this returns the bundled demo placeholder render.'}
          </p>
          <div className="cx-inline">
            <input
              className="input"
              value=${prompt}
              onChange=${(e) => setPrompt(e.target.value)}
              onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); if (render.state !== 'loading') testRender(); } }}
              aria-label="Render prompt"
            />
            <${Button} variant="secondary" icon="sparkles" loading=${render.state === 'loading'} disabled=${render.state === 'loading'} onClick=${testRender}>Test render<//>
          </div>
          ${render.state === 'loading' &&
          html`<div className="row small muted cx-loading"><${Spinner} /> Rendering… 3D generation can take a little while.</div>`}
          ${render.state === 'error' && html`<${ResultBox} tone="error" title="Render failed">${render.error}<//>`}
          ${render.state === 'done' && html`<${RenderResult} result=${render.result} live=${render.live} />`}
        </div>
      </div>
    <//>
  `;
}

/* ---------- 2. LinkedIn (demo) ---------- */

function LinkedInCard() {
  const conn = useStore((s) => (s.connections ? s.connections.linkedin : null)) || {};
  const feedCount = useStore((s) => (s.linkedinFeed ? s.linkedinFeed.length : 0));
  const status = conn.status || 'disconnected';
  const profile = conn.profile;
  const [busy, setBusy] = useState(false);
  const authorizing = busy || status === 'connecting';

  async function doConnect() {
    setBusy(true);
    try {
      await connectLinkedIn();
    } catch (e) {
      toast(`LinkedIn (demo) connect failed: ${errMessage(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function doDisconnect() {
    try {
      await disconnectLinkedIn();
    } catch (e) {
      patchConnection('linkedin', { status: 'disconnected', profile: null });
    }
  }

  const name = profile && (profile.name || [profile.firstName, profile.lastName].filter(Boolean).join(' '));
  const avatarText = profile && typeof profile.avatar === 'string' && profile.avatar.length <= 3 ? profile.avatar : '';
  const initials = profile && (profile.initials || avatarText || initialsOf(name));
  const followers = profile && (profile.followers ?? profile.connections);

  return html`
    <${Card}
      className="cx-card"
      title=${html`<span className="cx-title"><span className="cx-logo cx-logo-linkedin"><${Icon} name="linkedin" size=${18} /></span>LinkedIn (demo)</span>`}
      subtitle="Simulated connection for sending replies, DMs and posts."
      actions=${html`<div className="row cx-badges">
        <${Badge} tone="warning">Demo<//>
        <${StatusBadge} status=${authorizing ? 'connecting' : status} />
      </div>`}
    >
      <div className="stack">
        <div className="cx-demo-banner">
          <strong>Demo — no real LinkedIn account is used.</strong>
          <span>“Sent” items go to a mock feed inside Lens. Nothing leaves your browser.</span>
        </div>

        ${authorizing &&
        html`<div className="cx-authorizing" role="status">
          <${Spinner} />
          <div>
            <div className="cx-authorizing-title">Authorizing…</div>
            <div className="small muted">Simulating LinkedIn sign-in and permission grant.</div>
          </div>
        </div>`}

        ${!authorizing && status === 'connected' && profile &&
        html`<div className="cx-profile">
          <div className="cx-avatar" aria-hidden="true">${initials}</div>
          <div className="cx-profile-text">
            <div className="cx-profile-name">${name || 'Demo founder'}</div>
            ${profile.headline && html`<div className="small muted">${profile.headline}</div>`}
            <div className="small muted">
              ${followers != null ? `${Number(followers).toLocaleString()} ${profile.followers != null ? 'followers' : 'connections'} · ` : ''}${feedCount} item${feedCount === 1 ? '' : 's'} in demo feed
            </div>
          </div>
        </div>`}

        ${!authorizing && status !== 'connected' &&
        html`<p className="small muted">
          Without it, approved replies are copied to your clipboard and the original thread opens so you can paste them yourself.
        </p>`}

        <div className="row cx-actions">
          ${status === 'connected' && !authorizing
            ? html`<${Button} variant="ghost" icon="x" onClick=${doDisconnect}>Disconnect<//>`
            : html`<${Button} variant="primary" icon="linkedin" loading=${authorizing} disabled=${authorizing} onClick=${doConnect}>Connect (demo)<//>`}
          <span className="spacer"></span>
          <${Badge} tone="info">Session only<//>
        </div>
      </div>
    <//>
  `;
}

/* ---------- 3. You.com — the AI provider ---------- */

// Does this deployment's /api/you relay exist, and does it have an owner-provided key?
// Prefers youcom.js's own cached status helper; falls back to asking the relay directly.
let youStatusPromise = null;

async function fetchYouStatus() {
  for (const name of ['status', 'getStatus', 'serverStatus', 'relayStatus']) {
    const fn = youcom[name];
    if (typeof fn !== 'function') continue;
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'envKey' in r) return { relay: r.relay !== false && r.available !== false, envKey: !!r.envKey };
    } catch {
      /* try the next helper / the relay itself */
    }
  }
  if (typeof location !== 'undefined' && location.protocol === 'file:') return { relay: false, envKey: false };
  try {
    const res = await fetch('./api/you?op=status', { headers: { accept: 'application/json' } });
    if (!res.ok) return { relay: false, envKey: false };
    const body = await res.json();
    const data = body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : body;
    return { relay: true, envKey: !!(data && data.envKey) };
  } catch {
    return { relay: false, envKey: false };
  }
}

function useYouStatus() {
  const [status, setStatus] = useState({ state: 'loading', relay: true, envKey: false });
  useEffect(() => {
    let alive = true;
    if (!youStatusPromise) youStatusPromise = fetchYouStatus();
    youStatusPromise.then((r) => {
      if (alive) setStatus({ state: 'done', ...r });
    });
    return () => {
      alive = false;
    };
  }, []);
  return status;
}

function YouCard() {
  const key = useStore((s) => (s.settings ? s.settings.youKey : '')) || '';
  const demoMode = useStore((s) => liveFlags(s).demoMode);
  const provider = useStore((s) => (s.settings && s.settings.aiProvider === 'claude' ? 'claude' : 'you'));
  const field = useStore((s) => (s.company && s.company.field) || '');
  const status = useYouStatus();
  const [search, setSearch] = useState({ state: 'idle', result: null, error: '' });
  const [ai, setAi] = useState({ state: 'idle', text: '', error: '', ms: 0, label: '' });

  const hasUserKey = !!key.trim();
  const shared = !hasUserKey && status.envKey;
  const usable = hasUserKey || status.envKey;
  const relayMissing = status.state === 'done' && !status.relay;

  function resetTests() {
    setSearch({ state: 'idle', result: null, error: '' });
    setAi({ state: 'idle', text: '', error: '', ms: 0, label: '' });
  }

  async function testSearch() {
    setSearch({ state: 'loading', result: null, error: '' });
    try {
      const q = field ? `${field} founders discussion` : 'founders building in public';
      const results = await youcom.search(q, { count: 3 });
      const first = Array.isArray(results) ? results[0] : null;
      setSearch({ state: 'done', result: first, error: '' });
    } catch (e) {
      setSearch({ state: 'error', result: null, error: errMessage(e) });
    }
  }

  async function testAi() {
    const fallbackLabel = provider === 'claude' ? 'Claude' : 'You.com';
    setAi({ state: 'loading', text: '', error: '', ms: 0, label: fallbackLabel });
    const started = performance.now();
    let label = fallbackLabel;
    try {
      const aiService = await import('../services/ai.js');
      if (typeof aiService.providerLabel === 'function') label = aiService.providerLabel();
      const text = await aiService.complete({
        system: 'You are a connection test. Reply with one short sentence and nothing else.',
        prompt: 'Reply with exactly: "Lens is connected."',
        maxTokens: 60,
      });
      setAi({ state: 'done', text: String(text || '').trim(), error: '', ms: Math.round(performance.now() - started), label });
    } catch (e) {
      setAi({ state: 'error', text: '', error: errMessage(e), ms: 0, label });
    }
  }

  const badge = hasUserKey
    ? html`<${Badge} tone="success">Your key<//>`
    : shared
      ? html`<${Badge} tone="success">Using shared key<//>`
      : html`<${Badge} tone="neutral">Using demo data<//>`;

  return html`
    <${Card}
      className="cx-card cx-span-2 cx-primary"
      title=${html`<span className="cx-title"><span className="cx-logo cx-logo-you"><${Icon} name="search" size=${18} /></span>You.com</span>`}
      subtitle="AI provider — searches recent conversations, trends and events, and drafts with You.com Agents."
      actions=${html`<div className="row cx-badges">
        ${provider === 'you' && html`<${Badge} tone="accent">AI provider<//>`}
        ${badge}
      </div>`}
    >
      <div className="stack">
        <div className="field">
          <label className="field-label" htmlFor="cx-you-key">API key</label>
          <${KeyInput}
            id="cx-you-key"
            value=${key}
            placeholder=${shared ? 'Optional — the shared key is active' : 'ydc-…'}
            onChange=${(v) => { saveKey('youKey', v); resetTests(); }}
          />
          <span className="field-hint">
            Stored in this browser's localStorage. Sent only through this site's${' '}<code>/api/you</code>${' '}relay to You.com —
            the relay keeps nothing and logs nothing.${' '}
            <a href="https://you.com/platform" target="_blank" rel="noopener noreferrer">Get a key <${Icon} name="external" size=${12} /></a>
          </span>
        </div>

        ${shared &&
        html`<div className="cx-note">
          <${Icon} name="key" size=${14} />
          <span>
            <strong>Using shared key.</strong> The owner of this Lens deployment provides a You.com key, so live mode works
            without your own. Add your key above to use your own quota instead.
          </span>
        </div>`}

        ${!shared && !hasUserKey && status.state === 'done' && status.relay &&
        html`<div className="cx-note">
          <${Icon} name="info" size=${14} />
          <span>On Vercel the owner may set a shared key (<code>YOU_API_KEY</code>). This deployment has none, so add your own key for live data.</span>
        </div>`}

        ${relayMissing &&
        html`<div className="cx-note cx-note-warn">
          <${Icon} name="alert" size=${14} />
          <span>
            The You.com relay isn't reachable here. Live mode needs the Vercel deployment (or${' '}<code>python3 dev/serve.py</code>${' '}locally);
            until then Lens uses demo data.
          </span>
        </div>`}

        ${demoMode && usable &&
        html`<div className="cx-note">
          <${Icon} name="bolt" size=${14} />
          <span className="cx-note-grow">Demo mode is on, so Lens is still showing sample data.</span>
          <${Button} variant="primary" size="sm" onClick=${() => { patchSettings({ demoMode: false, demoModeExplicit: true }); toast('Live mode on — using You.com.', 'success'); }}>Go live<//>
        </div>`}

        <div className="row cx-actions">
          <${Button} variant="secondary" icon="search" loading=${search.state === 'loading'} disabled=${search.state === 'loading' || !usable} onClick=${testSearch}>Test search<//>
          <${Button} variant="secondary" icon="sparkles" loading=${ai.state === 'loading'} disabled=${ai.state === 'loading' || (provider === 'you' && !usable)} onClick=${testAi}>Test AI<//>
          ${hasUserKey && html`<${Button} variant="ghost" size="sm" onClick=${() => { patchSettings({ youKey: '' }); resetTests(); }}>Remove key<//>`}
          ${status.state === 'loading' && html`<span className="small muted row"><${Spinner} size=${12} /> Checking relay…</span>`}
        </div>

        ${search.state === 'error' && html`<${ResultBox} tone="error" title="You.com search failed">${search.error}<//>`}
        ${search.state === 'done' &&
        (search.result
          ? html`<${ResultBox} tone="success" title="You.com search is working">
              <a href=${search.result.url} target="_blank" rel="noopener noreferrer" className="cx-result-link">${search.result.title || search.result.url}</a>
              ${search.result.snippet && html`<div className="small muted cx-clamp">${search.result.snippet}</div>`}
            <//>`
          : html`<${ResultBox} tone="success" title="Request succeeded">The key works, but the test query returned no results.<//>`)}

        ${ai.state === 'error' && html`<${ResultBox} tone="error" title=${`AI test failed (${ai.label})`}>${ai.error}<//>`}
        ${ai.state === 'done' &&
        html`<${ResultBox} tone="success" title=${`${ai.label} replied in ${(ai.ms / 1000).toFixed(1)}s`}>
          <span className="cx-quote">${ai.text || '(empty reply)'}</span>
        <//>`}
      </div>
    <//>
  `;
}

/* ---------- 4. Design tool: Canva or Figma (demo) ---------- */

const DESIGN_TOOLS = [
  { id: 'canva', name: 'Canva', blurb: 'Templates and quick social graphics.', icon: 'palette' },
  { id: 'figma', name: 'Figma', blurb: 'Frames from your product design files.', icon: 'layers' },
];

function DesignToolCard() {
  const conn = useStore((s) => (s.connections ? s.connections.design : null)) || {};
  const status = conn.status || 'disconnected';
  const [busy, setBusy] = useState('');
  const current = status === 'connected' || status === 'connecting' ? conn.tool : null;

  async function pick(tool) {
    if (busy || (current === tool && status === 'connected')) return;
    setBusy(tool);
    try {
      await connectDesignTool(tool);
    } catch (e) {
      toast(`Design tool (demo) connect failed: ${errMessage(e)}`, 'error');
      patchConnection('design', { tool: null, status: 'disconnected', account: null });
    } finally {
      setBusy('');
    }
  }

  async function doDisconnect() {
    try {
      await disconnectDesignTool();
    } catch {
      patchConnection('design', { tool: null, status: 'disconnected', account: null });
    }
  }

  return html`
    <${Card}
      className="cx-card"
      title=${html`<span className="cx-title"><span className="cx-logo cx-logo-design"><${Icon} name="palette" size=${18} /></span>Design tool</span>`}
      subtitle="Pick one. Lens offers it when you add a visual to a post."
      actions=${html`<div className="row cx-badges">
        <${Badge} tone="warning">Demo<//>
        <${StatusBadge} status=${busy ? 'connecting' : status} />
      </div>`}
    >
      <div className="stack">
        <div className="cx-design-tiles" role="radiogroup" aria-label="Design tool">
          ${DESIGN_TOOLS.map((t) => {
            const selected = current === t.id;
            return html`<button
              key=${t.id}
              type="button"
              role="radio"
              aria-checked=${selected ? 'true' : 'false'}
              className=${`cx-design-tile cx-design-${t.id}${selected ? ' is-selected' : ''}`}
              disabled=${!!busy}
              onClick=${() => pick(t.id)}
            >
              <span className="cx-design-mark" aria-hidden="true"><${Icon} name=${t.icon} size=${18} /></span>
              <span className="cx-design-text">
                <span className="cx-design-name">${t.name}</span>
                <span className="small muted">${t.blurb}</span>
              </span>
              <span className="cx-design-state" aria-hidden="true">
                ${busy === t.id ? html`<${Spinner} size=${14} />` : selected && status === 'connected' ? html`<${Icon} name="check" size=${16} />` : null}
              </span>
            </button>`;
          })}
        </div>

        ${status === 'connected' && conn.account && html`<p className="small muted">Signed in as ${conn.account}</p>`}

        <div className="cx-demo-banner">
          <strong>Demo — no real Canva or Figma account is used.</strong>
          <span>Paste a share link when you add a visual; Lens shows it in the post preview.</span>
        </div>

        <div className="row cx-actions">
          ${status === 'connected' && html`<${Button} variant="ghost" icon="x" onClick=${doDisconnect}>Disconnect<//>`}
          <span className="spacer"></span>
          <${Badge} tone="info">Session only<//>
        </div>
      </div>
    <//>
  `;
}

/* ---------- 5. Optional: Claude ---------- */

function ClaudeCard() {
  const key = useStore((s) => (s.settings ? s.settings.claudeKey : '')) || '';
  const model = useStore((s) => (s.settings ? s.settings.claudeModel : '')) || 'claude-sonnet-5-5';
  const provider = useStore((s) => (s.settings && s.settings.aiProvider === 'claude' ? 'claude' : 'you'));
  const [test, setTest] = useState({ state: 'idle', text: '', error: '', ms: 0 });

  async function runTest() {
    if (!key.trim()) {
      setTest({ state: 'error', text: '', error: 'Add a Claude API key first.', ms: 0 });
      return;
    }
    setTest({ state: 'loading', text: '', error: '', ms: 0 });
    const started = performance.now();
    try {
      const text = await claude.complete({
        system: 'You are a connection test. Reply with one short sentence.',
        messages: [{ role: 'user', content: 'Reply with exactly: "Lens is connected to Claude."' }],
        maxTokens: 40,
        model,
      });
      setTest({ state: 'done', text: String(text || '').trim(), error: '', ms: Math.round(performance.now() - started) });
    } catch (e) {
      setTest({ state: 'error', text: '', error: errMessage(e), ms: 0 });
    }
  }

  function setProvider(next) {
    if (next === provider) return;
    patchSettings({ aiProvider: next });
    if (next === 'claude' && !key.trim()) toast('Add a Claude key below — until then AI features fall back to demo data.', 'info');
    else toast(`AI provider: ${next === 'claude' ? 'Claude' : 'You.com'}.`, 'success');
  }

  const known = CLAUDE_MODELS.some((m) => m.id === model);

  return html`
    <${Card}
      className="cx-card cx-span-2"
      title=${html`<span className="cx-title"><span className="cx-logo cx-logo-claude"><${Icon} name="sparkles" size=${18} /></span>Optional: use Claude instead</span>`}
      subtitle="Use Claude for drafting, ranking and chat. Search still runs on You.com."
      actions=${html`<div className="row cx-badges">
        ${provider === 'claude' && html`<${Badge} tone="accent">AI provider<//>`}
        ${key ? html`<${Badge} tone="success">Key saved<//>` : html`<${Badge} tone="neutral">Optional<//>`}
      </div>`}
    >
      <div className="stack">
        <div className="field">
          <span className="field-label" id="cx-provider-label">AI provider</span>
          <div className="cx-segmented" role="radiogroup" aria-labelledby="cx-provider-label">
            ${[
              { id: 'you', label: 'You.com (default)' },
              { id: 'claude', label: 'Claude' },
            ].map(
              (o) => html`<button
                key=${o.id}
                type="button"
                role="radio"
                aria-checked=${provider === o.id ? 'true' : 'false'}
                className=${`cx-segment${provider === o.id ? ' is-active' : ''}`}
                onClick=${() => setProvider(o.id)}
              >${o.label}</button>`
            )}
          </div>
          ${provider === 'claude' && !key.trim() &&
          html`<span className="field-hint cx-danger-text">Claude is selected but no key is saved — AI features use demo data until you add one.</span>`}
        </div>

        <div className="grid-2 cx-claude-grid">
          <div className="field">
            <label className="field-label" htmlFor="cx-claude-key">API key</label>
            <${KeyInput}
              id="cx-claude-key"
              value=${key}
              placeholder="sk-ant-…"
              onChange=${(v) => { saveKey('claudeKey', v); setTest({ state: 'idle', text: '', error: '', ms: 0 }); }}
            />
            <span className="field-hint">
              <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">Get a key <${Icon} name="external" size=${12} /></a>
            </span>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="cx-claude-model">Model</label>
            <select
              id="cx-claude-model"
              className="select"
              value=${model}
              onChange=${(e) => patchSettings({ claudeModel: e.target.value })}
            >
              ${!known && html`<option value=${model}>${model}</option>`}
              ${CLAUDE_MODELS.map((m) => html`<option key=${m.id} value=${m.id}>${m.label}</option>`)}
            </select>
          </div>
        </div>

        <div className="cx-note">
          <${Icon} name="lock" size=${14} />
          <span>
            Lens calls api.anthropic.com directly from your browser (direct browser access mode). The key is stored in this
            browser's localStorage and sent only to Anthropic — use a key with a spending limit.
          </span>
        </div>

        <div className="row cx-actions">
          <${Button} variant="secondary" icon="bolt" loading=${test.state === 'loading'} disabled=${test.state === 'loading' || !key} onClick=${runTest}>Test Claude<//>
          ${key && html`<${Button} variant="ghost" size="sm" onClick=${() => { patchSettings({ claudeKey: '' }); setTest({ state: 'idle', text: '', error: '', ms: 0 }); }}>Remove key<//>`}
        </div>

        ${test.state === 'error' && html`<${ResultBox} tone="error" title="Claude test failed">${test.error}<//>`}
        ${test.state === 'done' &&
        html`<${ResultBox} tone="success" title=${`Claude replied in ${(test.ms / 1000).toFixed(1)}s`}>
          <span className="cx-quote">${test.text || '(empty reply)'}</span>
        <//>`}
      </div>
    <//>
  `;
}

/* ---------- panel (used by Settings → Connections) ---------- */

export function ConnectionsPanel() {
  return html`
    <div className="cx-panel stack">
      <div className="cx-principles">
        <div className="cx-principle">
          <${Icon} name="users" size=${16} />
          <div><strong>No accounts</strong><span className="small muted">No sign-up, no database. Your data stays in this browser.</span></div>
        </div>
        <div className="cx-principle">
          <${Icon} name="key" size=${16} />
          <div><strong>Keys stay here</strong><span className="small muted">Saved in localStorage, sent only to each vendor (You.com via this site's relay).</span></div>
        </div>
        <div className="cx-principle">
          <${Icon} name="plug" size=${16} />
          <div><strong>Temporary connections</strong><span className="small muted">sessionStorage only — closing the tab disconnects.</span></div>
        </div>
      </div>

      <div className="cx-grid">
        <${YouCard} />
        <${SculptexCard} />
        <${DesignToolCard} />
        <${LinkedInCard} />
        <${ClaudeCard} />
      </div>
    </div>
  `;
}

/* ---------- standalone page (kept for safety; the route now lives in Settings) ---------- */

export default function Connections() {
  return html`
    <div className="page cx-page">
      <div className="page-header">
        <div>
          <h1>Connections</h1>
          <p className="page-sub">No accounts. Keys stay in this browser. Tool connections last only for this tab session.</p>
        </div>
      </div>
      <${ConnectionsPanel} />
    </div>
  `;
}

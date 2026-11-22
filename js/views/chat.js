// Ask Lens — chat drawer rendered by app.js (not a route).
import { html, useState, useEffect, useRef, Fragment } from '../lib.js';
import { useStore, setState, getState, toast, liveFlags } from '../store.js';
import { Icon } from '../ui.js';
import { navigate } from '../router.js';
import { chat } from '../services/lens.js';

const EMPTY = Object.freeze([]);

const SUGGESTIONS = [
  'What should I post this week?',
  'Which 3 threads should I reply to first?',
  'Which events are worth my time?',
  'Summarize the top pain points',
];

const QUICK_LINKS = [
  { path: '/discover', label: 'Discover', icon: 'search' },
  { path: '/studio', label: 'Studio', icon: 'edit' },
  { path: '/outreach', label: 'Outreach', icon: 'inbox' },
];

/* ---------- tiny, safe markdown (no innerHTML) ---------- */

const INLINE_RE = /(\*\*(?:(?!\*\*)[^\n])+\*\*|__[^_\n]+__|\[[^\]\n]+\]\([^)\s]+\)|`[^`\n]+`|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
const LIST_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;
const ORDERED_RE = /^\s*\d+[.)]\s+/;
const HEADING_RE = /^\s*#{1,6}\s+/;

function isMobile() {
  return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 859px)').matches;
}

function closeChat() {
  setState((s) => ({ ui: { ...(s.ui || {}), chatOpen: false } }));
}

function goTo(path) {
  navigate(path);
  if (isMobile()) closeChat();
}

function MdLink({ href, children }) {
  if (/^https?:\/\//i.test(href)) {
    return html`<a href=${href} target="_blank" rel="noopener noreferrer">${children}</a>`;
  }
  if (href.startsWith('#/')) {
    return html`<a
      href=${href}
      onClick=${(e) => {
        e.preventDefault();
        goTo(href.slice(1));
      }}
      >${children}</a
    >`;
  }
  return html`<span>${children}</span>`;
}

function renderInline(text, keyBase) {
  const parts = String(text).split(INLINE_RE);
  return parts.map((part, i) => {
    const key = `${keyBase}-${i}`;
    if (!part) return null;
    if (i % 2 === 0) return html`<${Fragment} key=${key}>${part}<//>`;
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) {
      return html`<strong key=${key}>${renderInline(part.slice(2, -2), key)}</strong>`;
    }
    if (part.startsWith('`')) return html`<code key=${key}>${part.slice(1, -1)}</code>`;
    if (part.startsWith('[')) {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
      if (m) return html`<${MdLink} key=${key} href=${m[2]}>${m[1]}<//>`;
      return html`<${Fragment} key=${key}>${part}<//>`;
    }
    return html`<${MdLink} key=${key} href=${part}>${part.replace(/^https?:\/\/(www\.)?/, '')}<//>`;
  });
}

function parseBlocks(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let list = null;

  const flushPara = () => {
    if (para.length) blocks.push({ type: 'p', lines: para });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    if (LIST_RE.test(line)) {
      flushPara();
      const ordered = ORDERED_RE.test(line);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { type: 'list', ordered, items: [] };
      }
      list.items.push(line.replace(LIST_RE, ''));
      continue;
    }
    if (list && /^\s{2,}\S/.test(raw)) {
      // continuation of the previous list item
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    if (HEADING_RE.test(line)) {
      flushPara();
      blocks.push({ type: 'h', text: line.replace(HEADING_RE, '') });
      continue;
    }
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}

function Markdown({ text }) {
  const blocks = parseBlocks(text);
  return html`<div className="cd-md">
    ${blocks.map((b, bi) => {
      if (b.type === 'h') return html`<p key=${bi} className="cd-md-h"><strong>${renderInline(b.text, `h${bi}`)}</strong></p>`;
      if (b.type === 'list') {
        const items = b.items.map((it, ii) => html`<li key=${ii}>${renderInline(it, `l${bi}-${ii}`)}</li>`);
        return b.ordered ? html`<ol key=${bi}>${items}</ol>` : html`<ul key=${bi}>${items}</ul>`;
      }
      return html`<p key=${bi}>
        ${b.lines.map(
          (ln, li) => html`<${Fragment} key=${li}>${li > 0 && html`<br />`}${renderInline(ln, `p${bi}-${li}`)}<//>`
        )}
      </p>`;
    })}
  </div>`;
}

/* ---------- pieces ---------- */

function Bubble({ role, content, at, children }) {
  const when = at ? new Date(at) : null;
  const title = when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : undefined;
  return html`
    <div className=${`cd-msg cd-msg-${role}`}>
      ${role === 'assistant' && html`<div className="cd-avatar" aria-hidden="true"><${Icon} name="sparkles" size=${14} /></div>`}
      <div className="cd-msg-col">
        <div className="cd-bubble" title=${title}>
          ${role === 'assistant' ? html`<${Markdown} text=${content} />` : html`<p className="cd-plain">${content}</p>`}
        </div>
        ${children}
      </div>
    </div>
  `;
}

function Typing() {
  return html`
    <div className="cd-msg cd-msg-assistant" role="status" aria-label="Lens is thinking">
      <div className="cd-avatar" aria-hidden="true"><${Icon} name="sparkles" size=${14} /></div>
      <div className="cd-bubble cd-typing"><span></span><span></span><span></span></div>
    </div>
  `;
}

function QuickLinks() {
  return html`
    <div className="cd-quick" aria-label="Jump to">
      ${QUICK_LINKS.map(
        (q) => html`<button key=${q.path} type="button" className="cd-quick-link" onClick=${() => goTo(q.path)}>
          <${Icon} name=${q.icon} size=${13} />
          <span>${q.label}</span>
          <${Icon} name="arrowRight" size=${12} />
        </button>`
      )}
    </div>
  `;
}

function EmptyChat({ onPick, hasKey, noRelay, companyName }) {
  return html`
    <div className="cd-empty">
      <div className="cd-empty-icon"><${Icon} name="chat" size=${22} /></div>
      <h3>Ask about your pipeline</h3>
      <p className="small muted">
        Lens answers using what's in this browser${companyName ? ` for ${companyName}` : ''}: your threads, trends, events and
        drafts.
      </p>
      <div className="cd-suggestions">
        ${SUGGESTIONS.map(
          (s) => html`<button key=${s} type="button" className="cd-suggestion" onClick=${() => onPick(s)}>
            <span>${s}</span>
            <${Icon} name="arrowRight" size=${14} />
          </button>`
        )}
      </div>
      ${!hasKey && noRelay &&
      html`<p className="small muted cd-empty-note">
        Ask Lens runs on You.com through the Lens server, which isn't reachable here. Open Lens on its Vercel deployment
        (or run <code>python3 dev/serve.py</code> locally).
      </p>`}
      ${!hasKey && !noRelay &&
      html`<p className="small muted cd-empty-note">
        Ask Lens runs on You.com. Add your You.com API key to start chatting.
        <a
          href="#/settings?tab=connections"
          onClick=${(e) => {
            e.preventDefault();
            goTo('/settings?tab=connections');
          }}
          >Add a key</a
        >
      </p>`}
    </div>
  `;
}

/* ---------- drawer ---------- */

export function ChatDrawer() {
  const open = useStore((s) => !!(s.ui && s.ui.chatOpen));
  const messages = useStore((s) => s.chat) || EMPTY;
  // The chat is always real You.com AI: live whenever a You.com key exists (user's or the deployment's).
  const live = useStore((s) => liveFlags(s));
  const hasKey = live.chat;
  const noRelay = useStore((s) => !!(s.ui && s.ui.relay && s.ui.relay.available === false));
  // Before the first relay check finishes we don't know yet whether the deployment holds a shared key.
  const checking = useStore((s) => !(s.ui && s.ui.relay) && !String((s.settings && s.settings.youKey) || '').trim());
  const providerName = 'You.com';
  const companyName = useStore((s) => (s.company ? s.company.name : '')) || '';

  const [input, setInput] = useState('');
  const [pending, setPending] = useState(null); // { content, baseLen }
  const [confirmClear, setConfirmClear] = useState(false);
  const listRef = useRef(null);
  const inputRef = useRef(null);

  // Scroll to the newest message.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending, open]);

  // Focus the input on open; close on Escape.
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => inputRef.current && inputRef.current.focus(), 60);
    const onKey = (e) => {
      if (e.key === 'Escape' && !document.querySelector('.modal-backdrop')) closeChat();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Reset the two-step clear confirmation after a few seconds.
  useEffect(() => {
    if (!confirmClear) return undefined;
    const t = setTimeout(() => setConfirmClear(false), 3500);
    return () => clearTimeout(t);
  }, [confirmClear]);

  // Auto-size the textarea.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input, open]);

  async function send(text) {
    const content = String(text || '').trim();
    if (!content || pending) return;
    const baseLen = (getState().chat || EMPTY).length;
    setInput('');
    setConfirmClear(false);
    setPending({ content, baseLen });
    try {
      await chat(content);
    } catch (e) {
      toast(`Ask Lens failed: ${(e && e.message) || e}`, 'error');
      const after = getState().chat || EMPTY;
      if (!after.slice(baseLen).some((m) => m.role === 'user' && m.content === content)) setInput(content);
    } finally {
      setPending(null);
      if (inputRef.current && open) inputRef.current.focus();
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(input);
    }
  }

  function onClear() {
    if (!messages.length) return;
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setState({ chat: [] });
    setConfirmClear(false);
    if (inputRef.current) inputRef.current.focus();
  }

  const showPendingUser =
    pending && !messages.slice(pending.baseLen).some((m) => m.role === 'user' && m.content === pending.content);
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'assistant') {
      lastAssistant = i;
      break;
    }
  }
  const showQuick = !pending && lastAssistant === messages.length - 1 && lastAssistant >= 0;
  const isEmpty = messages.length === 0 && !pending;

  return html`
    <aside
      className=${`chat-drawer cd${open ? ' open' : ''}`}
      role="dialog"
      aria-label="Ask Lens"
      aria-hidden=${open ? 'false' : 'true'}
      inert=${open ? undefined : ''}
    >
      <header className="cd-header">
        <div className="cd-title">
          <span className="cd-title-icon"><${Icon} name="sparkles" size=${16} /></span>
          <div>
            <h2>Ask Lens</h2>
            <span className="small muted">${hasKey ? `${providerName} · grounded in your data` : checking ? 'Connecting to You.com…' : 'You.com not connected'}</span>
          </div>
        </div>
        <div className="row cd-header-actions">
          ${messages.length > 0 &&
          html`<button
            type="button"
            className=${`btn btn-ghost btn-sm cd-clear${confirmClear ? ' cd-clear-confirm' : ''}`}
            onClick=${onClear}
            disabled=${!!pending}
            title="Clear conversation"
          >
            <${Icon} name="trash" size=${14} />
            <span>${confirmClear ? 'Confirm clear' : 'Clear'}</span>
          </button>`}
          <button type="button" className="btn btn-ghost btn-sm cd-close" onClick=${closeChat} aria-label="Close chat">
            <${Icon} name="x" size=${18} />
          </button>
        </div>
      </header>

      <div className="cd-list" ref=${listRef} aria-live="polite">
        ${isEmpty
          ? html`<${EmptyChat} onPick=${send} hasKey=${hasKey || checking} noRelay=${noRelay} companyName=${companyName} />`
          : html`
              ${messages.map(
                (m, i) => html`<${Bubble} key=${`${i}-${m.at || ''}`} role=${m.role === 'user' ? 'user' : 'assistant'} content=${m.content} at=${m.at}>
                  ${showQuick && i === lastAssistant && html`<${QuickLinks} />`}
                <//>`
              )}
              ${showPendingUser && html`<${Bubble} role="user" content=${pending.content} />`}
              ${pending && html`<${Typing} />`}
            `}
      </div>

      <form
        className="cd-composer"
        onSubmit=${(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          ref=${inputRef}
          className="textarea cd-input"
          rows=${1}
          value=${input}
          placeholder="Ask about threads, posts, events…"
          aria-label="Message Lens"
          onChange=${(e) => setInput(e.target.value)}
          onKeyDown=${onKeyDown}
        ></textarea>
        <button
          type="submit"
          className="btn btn-primary cd-send"
          disabled=${!input.trim() || !!pending}
          aria-label="Send message"
        >
          <${Icon} name="send" size=${16} />
        </button>
      </form>
      <div className="cd-hint small muted"><span className="kbd">Enter</span> to send · <span className="kbd">Shift</span>+<span className="kbd">Enter</span> for a new line</div>
    </aside>
  `;
}

export default ChatDrawer;

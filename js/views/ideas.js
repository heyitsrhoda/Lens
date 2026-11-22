// Bring your own idea (#/chat) — full-page chat that shapes a rough idea into a LinkedIn post.
// Conversation lives in state.ideaChat; ideaChat() returns { reply, proposal? }. Proposals render
// inline as LinkedIn-style previews with "Add to stack" (→ pending post draft) and "Refine".
import { html, useState, useEffect, useRef, useMemo, Fragment } from '../lib.js';
import { useStore, setState, getState, toast } from '../store.js';
import { navigate } from '../router.js';
import { Button, Icon, copyText, cx } from '../ui.js';
import { PostPreview, useProfile } from './studio.js';
import { ideaChat, addIdeaToStack } from '../services/lens.js';

const EMPTY = Object.freeze([]);

function reducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function starters(company) {
  const name = (company && company.name) || 'my product';
  const field = String((company && company.field) || 'my field').split('/')[0].trim() || 'my field';
  return [
    { icon: 'sparkles', text: `Why I started building ${name}` },
    { icon: 'users', text: 'A lesson from talking to our first 10 users' },
    { icon: 'flame', text: `A contrarian take on ${field}` },
    { icon: 'bolt', text: 'Behind the scenes of what we shipped this week' },
  ];
}

/* ---------- tiny, safe markdown (React elements, no innerHTML) ---------- */

const INLINE_RE = /(\*\*(?:(?!\*\*)[^\n])+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|\[[^\]\n]+\]\([^)\s]+\)|`[^`\n]+`|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
const LIST_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;
const ORDERED_RE = /^\s*\d+[.)]\s+/;
const HEADING_RE = /^\s*#{1,6}\s+/;

function MdLink({ href, children }) {
  if (/^https?:\/\//i.test(href)) return html`<a href=${href} target="_blank" rel="noopener noreferrer">${children}</a>`;
  if (href.startsWith('#/')) {
    return html`<a
      href=${href}
      onClick=${(e) => {
        e.preventDefault();
        navigate(href.slice(1));
      }}
      >${children}</a
    >`;
  }
  return html`<span>${children}</span>`;
}

function renderInline(text, keyBase) {
  return String(text)
    .split(INLINE_RE)
    .map((part, i) => {
      const key = `${keyBase}-${i}`;
      if (!part) return null;
      if (i % 2 === 0) return html`<${Fragment} key=${key}>${part}<//>`;
      if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) {
        return html`<strong key=${key}>${renderInline(part.slice(2, -2), key)}</strong>`;
      }
      if (part.startsWith('*') && part.endsWith('*')) return html`<em key=${key}>${part.slice(1, -1)}</em>`;
      if (part.startsWith('`')) return html`<code key=${key}>${part.slice(1, -1)}</code>`;
      if (part.startsWith('[')) {
        const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
        return m ? html`<${MdLink} key=${key} href=${m[2]}>${m[1]}<//>` : html`<${Fragment} key=${key}>${part}<//>`;
      }
      return html`<${MdLink} key=${key} href=${part}>${part.replace(/^https?:\/\/(www\.)?/, '')}<//>`;
    });
}

function parseBlocks(text) {
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
  for (const raw of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (LIST_RE.test(line)) {
      flushPara();
      const ordered = ORDERED_RE.test(line);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { type: 'list', ordered, items: [] };
      }
      list.items.push(line.replace(LIST_RE, ''));
    } else if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      if (HEADING_RE.test(line)) {
        flushPara();
        blocks.push({ type: 'h', text: line.replace(HEADING_RE, '') });
      } else {
        para.push(line);
      }
    }
  }
  flushPara();
  flushList();
  return blocks;
}

function Markdown({ text }) {
  return html`<div className="ic-md">
    ${parseBlocks(text).map((b, bi) => {
      if (b.type === 'h') return html`<p key=${bi} className="ic-md-h"><strong>${renderInline(b.text, `h${bi}`)}</strong></p>`;
      if (b.type === 'list') {
        const items = b.items.map((it, ii) => html`<li key=${ii}>${renderInline(it, `l${bi}-${ii}`)}</li>`);
        return b.ordered ? html`<ol key=${bi}>${items}</ol>` : html`<ul key=${bi}>${items}</ul>`;
      }
      return html`<p key=${bi}>
        ${b.lines.map((ln, li) => html`<${Fragment} key=${li}>${li > 0 ? html`<br />` : null}${renderInline(ln, `p${bi}-${li}`)}<//>`)}
      </p>`;
    })}
  </div>`;
}

/* ---------- pieces ---------- */

function Avatar() {
  return html`<div className="ic-avatar" aria-hidden="true"><${Icon} name="sparkles" size=${14} /></div>`;
}

function Message({ role, content, at, children }) {
  const when = at ? new Date(at) : null;
  const title = when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : undefined;
  if (role === 'user') {
    return html`<div className="ic-msg ic-msg-user">
      <div className="ic-bubble" title=${title}><p className="ic-plain">${content}</p></div>
    </div>`;
  }
  return html`<div className="ic-msg ic-msg-assistant">
    <${Avatar} />
    <div className="ic-msg-col">
      ${content ? html`<div className="ic-bubble" title=${title}><${Markdown} text=${content} /></div>` : null}
      ${children}
    </div>
  </div>`;
}

function Typing() {
  return html`<div className="ic-msg ic-msg-assistant" role="status" aria-label="Lens is writing">
    <${Avatar} />
    <div className="ic-bubble ic-typing"><span></span><span></span><span></span></div>
  </div>`;
}

const STATUS_TEXT = {
  pending: 'In your stack',
  approved: 'Approved',
  scheduled: 'Scheduled',
  posted: 'Posted',
  sent: 'Posted',
  rejected: 'Declined in stack',
};

function ProposalCard({ proposal, at, profile, drafts, onRefine, busy }) {
  const added = proposal.addedDraftId ? drafts.find((d) => d.id === proposal.addedDraftId) : null;

  function add() {
    try {
      const draft = addIdeaToStack(proposal);
      setState((s) => ({
        ideaChat: (s.ideaChat || EMPTY).map((m) =>
          m.proposal === proposal || (m.at === at && m.proposal && m.proposal.body === proposal.body)
            ? { ...m, proposal: { ...m.proposal, addedDraftId: draft.id } }
            : m
        ),
      }));
      toast('Added to your stack — review it in Stack.', 'success');
    } catch (e) {
      toast(`Couldn't add it: ${(e && e.message) || e}`, 'error');
    }
  }

  async function copy() {
    const text = [proposal.title, proposal.body].filter(Boolean).join('\n\n');
    const ok = await copyText(text);
    toast(ok ? 'Post copied.' : "Couldn't copy — select the text instead.", ok ? 'success' : 'info');
  }

  return html`<div className="ic-proposal">
    <div className="ic-proposal-label small"><${Icon} name="edit" size=${13} /> Proposed post</div>
    <${PostPreview} profile=${profile} title=${proposal.title} body=${proposal.body} timeLabel="Draft" />
    ${proposal.visualIdea || proposal.sculptexPrompt
      ? html`<div className="ic-visual small">
          ${proposal.visualIdea
            ? html`<div><${Icon} name="image" size=${13} /><span><strong>Visual idea:</strong> ${proposal.visualIdea}</span></div>`
            : null}
          ${proposal.sculptexPrompt
            ? html`<div><${Icon} name="cube" size=${13} /><span><strong>Sculptex prompt:</strong> ${proposal.sculptexPrompt}</span></div>`
            : null}
        </div>`
      : null}
    <div className="ic-proposal-actions">
      ${added
        ? html`<span className="ic-added"><${Icon} name="check" size=${14} /> ${STATUS_TEXT[added.status] || 'Added'}</span>
            <a
              className="btn btn-secondary btn-sm"
              href="#/stack"
              onClick=${(e) => {
                e.preventDefault();
                navigate('/stack');
              }}
              >Review in stack <${Icon} name="arrowRight" size=${14}
            /></a>`
        : html`<${Button} variant="primary" size="sm" icon="plus" onClick=${add}>Add to stack<//>`}
      <${Button} variant="secondary" size="sm" icon="edit" onClick=${onRefine} disabled=${busy}>Refine<//>
      <${Button} variant="ghost" size="sm" icon="copy" onClick=${copy} title="Copy post text">Copy<//>
    </div>
  </div>`;
}

function EmptyState({ company, onPick }) {
  return html`<div className="ic-empty">
    <div className="ic-empty-icon"><${Icon} name="sparkles" size=${24} /></div>
    <h2>What do you want to say?</h2>
    <p className="muted">
      Drop a rough thought — a lesson, a customer story, a hot take. Lens shapes it into a LinkedIn post you can add to your stack.
    </p>
    <div className="ic-starters">
      ${starters(company).map(
        (s) => html`<button key=${s.text} type="button" className="ic-starter" onClick=${() => onPick(s.text)}>
          <${Icon} name=${s.icon} size=${16} />
          <span>${s.text}</span>
          <${Icon} name="arrowRight" size=${14} className="ic-starter-go" />
        </button>`
      )}
    </div>
  </div>`;
}

/* ---------- page ---------- */

export default function Ideas() {
  const messages = useStore((s) => s.ideaChat) || EMPTY;
  const drafts = useStore((s) => s.drafts) || EMPTY;
  const company = useStore((s) => s.company) || {};
  const busyElsewhere = useStore((s) => !!(s.ui && s.ui.loading && s.ui.loading.ideaChat));
  const profile = useProfile();

  const [input, setInput] = useState('');
  const [pending, setPending] = useState(null); // { content, baseLen }
  const [confirmClear, setConfirmClear] = useState(false);
  const inputRef = useRef(null);
  const endRef = useRef(null);
  const firstScroll = useRef(true);

  const busy = !!pending || busyElsewhere;
  const pendingCount = useMemo(() => drafts.filter((d) => d.kind === 'post' && d.status === 'pending').length, [drafts]);

  // Keep the newest message in view.
  useEffect(() => {
    const el = endRef.current;
    if (!el) return;
    const instant = firstScroll.current || reducedMotion();
    firstScroll.current = false;
    if (!messages.length && !busy) return;
    el.scrollIntoView({ block: 'end', behavior: instant ? 'auto' : 'smooth' });
  }, [messages.length, busy]);

  // Auto-size the composer.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [input]);

  // Two-step clear resets itself.
  useEffect(() => {
    if (!confirmClear) return undefined;
    const t = setTimeout(() => setConfirmClear(false), 3500);
    return () => clearTimeout(t);
  }, [confirmClear]);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current && inputRef.current.focus({ preventScroll: true }), 80);
    return () => clearTimeout(t);
  }, []);

  function focusInput(atEnd) {
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      if (atEnd) {
        const n = el.value.length;
        el.setSelectionRange(n, n);
      }
    });
  }

  async function send(text) {
    const content = String(text || '').trim();
    if (!content || busy) return;
    const baseLen = (getState().ideaChat || EMPTY).length;
    setInput('');
    setConfirmClear(false);
    setPending({ content, baseLen });
    try {
      await ideaChat(content);
    } catch (e) {
      toast(`Lens couldn't answer: ${(e && e.message) || e}`, 'error');
      const after = getState().ideaChat || EMPTY;
      if (!after.slice(baseLen).some((m) => m.role === 'user' && m.content === content)) setInput(content);
    } finally {
      setPending(null);
      focusInput(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent && e.nativeEvent.isComposing)) {
      e.preventDefault();
      send(input);
    }
  }

  function refine() {
    setInput('Make it ');
    focusInput(true);
  }

  function onClear() {
    if (!messages.length || busy) return;
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setState({ ideaChat: [] });
    setConfirmClear(false);
    focusInput(false);
  }

  const showPendingUser = pending && !messages.slice(pending.baseLen).some((m) => m.role === 'user' && m.content === pending.content);
  const isEmpty = messages.length === 0 && !pending;

  return html`<div className="page ic-page">
    <header className="page-header ic-header">
      <h1>Bring your own idea</h1>
      <p className="page-sub">Talk it through with Lens. When it has a post, add it to your stack to review and schedule.</p>
      <div className="page-actions">
        <a
          className="btn btn-secondary btn-sm"
          href="#/stack"
          onClick=${(e) => {
            e.preventDefault();
            navigate('/stack');
          }}
        >
          <${Icon} name="layers" size=${14} />
          <span className="btn-label">Stack${pendingCount ? ` · ${pendingCount}` : ''}</span>
        </a>
        ${messages.length > 0
          ? html`<button
              type="button"
              className=${cx('btn', 'btn-sm', confirmClear ? 'btn-danger' : 'btn-ghost')}
              onClick=${onClear}
              disabled=${busy}
              title="Clear conversation"
            >
              <${Icon} name="trash" size=${14} />
              <span className="btn-label">${confirmClear ? 'Confirm clear' : 'Clear chat'}</span>
            </button>`
          : null}
      </div>
    </header>

    <div className="ic-thread" aria-live="polite">
      ${isEmpty
        ? html`<${EmptyState} company=${company} onPick=${send} />`
        : html`
            ${messages.map((m, i) =>
              m.role === 'user'
                ? html`<${Message} key=${`${i}-${m.at || ''}`} role="user" content=${m.content} at=${m.at} />`
                : html`<${Message} key=${`${i}-${m.at || ''}`} role="assistant" content=${m.content} at=${m.at}>
                    ${m.proposal && m.proposal.body
                      ? html`<${ProposalCard}
                          proposal=${m.proposal}
                          at=${m.at}
                          profile=${profile}
                          drafts=${drafts}
                          onRefine=${refine}
                          busy=${busy}
                        />`
                      : null}
                  <//>`
            )}
            ${showPendingUser ? html`<${Message} role="user" content=${pending.content} />` : null}
            ${busy ? html`<${Typing} />` : null}
          `}
      <div ref=${endRef} className="ic-end"></div>
    </div>

    <form
      className="ic-composer"
      onSubmit=${(e) => {
        e.preventDefault();
        send(input);
      }}
    >
      <div className="ic-composer-box">
        <textarea
          ref=${inputRef}
          className="ic-input"
          rows=${1}
          value=${input}
          placeholder=${messages.length ? 'Reply, or ask for a change ("Make it shorter")…' : 'Describe your idea…'}
          aria-label="Describe your idea"
          onChange=${(e) => setInput(e.target.value)}
          onKeyDown=${onKeyDown}
        ></textarea>
        <button type="submit" className="btn btn-primary ic-send" disabled=${!input.trim() || busy} aria-label="Send">
          <${Icon} name="send" size=${16} />
        </button>
      </div>
      <div className="ic-hint small muted">
        <span className="kbd">Enter</span> to send · <span className="kbd">Shift</span>+<span className="kbd">Enter</span> for a new line
      </div>
    </form>
  </div>`;
}

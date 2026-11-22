// Outreach (#/outreach) — Branch A approval queue for reply / DM drafts.
// Nothing is sent without the explicit "Send" click inside the preview modal.
import { html, useState, useEffect, useMemo, useRef } from '../lib.js';
import { useStore, setState, toast } from '../store.js';
import { useRoute, navigate } from '../router.js';
import { Button, Badge, Empty, Spinner, Modal, Tabs, Icon, SourceIcon, timeAgo } from '../ui.js';
import { draftOutreach, rewrite, sendDraft } from '../services/lens.js';
import { cx, patchDraft, wordCount, useBufferedText, useProfile, LinkedInAvatar, initialsOf, fmtWhen } from './studio.js';

const TABS = ['pending', 'approved', 'sent', 'rejected'];
const TAB_LABELS = { pending: 'Pending', approved: 'Approved', sent: 'Sent', rejected: 'Rejected' };
const REWRITE_CHIPS = ['Shorter', 'Warmer', 'More specific', 'Remove the pitch'];
const COMMENT_LIMIT = 1250;
const DM_LIMIT = 8000;

const SOURCE_NAMES = {
  reddit: 'Reddit',
  hackernews: 'Hacker News',
  x: 'X',
  linkedin: 'LinkedIn',
  indiehackers: 'Indie Hackers',
  producthunt: 'Product Hunt',
  web: 'the web',
};

function groupOf(status) {
  if (status === 'approved' || status === 'scheduled') return 'approved';
  if (status === 'sent' || status === 'posted') return 'sent';
  if (status === 'rejected') return 'rejected';
  return 'pending';
}

function sourceName(thread) {
  return (thread && SOURCE_NAMES[thread.source]) || 'the source';
}

/* ---------------- Thread context (left column of each item) ---------------- */

function ThreadContext({ thread }) {
  if (!thread) {
    return html`<div className="ob-context ob-context-missing small muted">
      <${Icon} name="link" size=${14} /> The source thread is no longer in your list.
    </div>`;
  }
  const engagement = thread.engagement || {};
  return html`<div className="ob-context">
    <div className="row ob-context-top small muted">
      <${SourceIcon} source=${thread.source} />
      ${thread.community ? html`<span className="truncate">${thread.community}</span>` : null}
      ${thread.publishedAt ? html`<span>· ${timeAgo(thread.publishedAt)}</span>` : null}
    </div>
    <a className="ob-thread-title" href=${thread.url} target="_blank" rel="noopener noreferrer">${thread.title}</a>
    ${thread.quote || thread.snippet ? html`<blockquote className="quote ob-quote">${thread.quote || thread.snippet}</blockquote>` : null}
    <div className="row ob-context-meta small muted">
      ${thread.author ? html`<span><${Icon} name="users" size=${13} /> ${thread.author}</span>` : null}
      ${typeof engagement.replies === 'number' ? html`<span>${engagement.replies} replies</span>` : null}
      ${typeof engagement.upvotes === 'number' ? html`<span>${engagement.upvotes} upvotes</span>` : null}
      ${thread.intent === 'high' ? html`<${Badge} tone="warning">High intent<//>` : null}
    </div>
    ${thread.painPoint ? html`<div className="ob-pain small"><span className="muted">Pain point:</span> ${thread.painPoint}</div>` : null}
    <a className="ob-open small" href=${thread.url} target="_blank" rel="noopener noreferrer">
      Open thread on ${sourceName(thread)} <${Icon} name="external" size=${12} />
    </a>
  </div>`;
}

/* ---------------- Queue item ---------------- */

function OutreachItem({ draft, thread, connected, highlighted, onPreview }) {
  const group = groupOf(draft.status);
  const editable = group === 'pending' || group === 'approved';
  const [body, setBody, flush] = useBufferedText(draft.body || '', (v) => patchDraft(draft.id, { body: v }));
  const [busy, setBusy] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    if (highlighted && ref.current) ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlighted]);

  const words = wordCount(body);
  const chars = body.length;
  const limit = draft.kind === 'dm' ? DM_LIMIT : COMMENT_LIMIT;
  const over = chars > limit;
  const empty = !body.trim();

  async function doRewrite(instruction) {
    flush();
    setBusy(`rw:${instruction}`);
    try {
      await rewrite(draft.id, instruction);
    } catch (e) {
      toast(`Rewrite failed: ${e && e.message ? e.message : e}`, 'error');
    } finally {
      setBusy('');
    }
  }

  async function regenerate() {
    if (!draft.threadId) {
      toast('This draft has no source thread to regenerate from.', 'error');
      return;
    }
    flush();
    setBusy('regen');
    try {
      const fresh = await draftOutreach(draft.threadId, draft.kind);
      if (!fresh || !fresh.body) throw new Error('No draft came back');
      const now = new Date().toISOString();
      setState((s) => ({
        drafts: (s.drafts || [])
          .filter((d) => d.id !== fresh.id)
          .map((d) => (d.id === draft.id ? { ...d, body: fresh.body, status: 'pending', error: undefined, updatedAt: now } : d)),
      }));
      toast('Fresh draft generated.', 'success');
    } catch (e) {
      toast(`Couldn't regenerate: ${e && e.message ? e.message : e}`, 'error');
    } finally {
      setBusy('');
    }
  }

  function setStatus(status, message) {
    flush();
    patchDraft(draft.id, { status });
    if (message) toast(message, status === 'rejected' ? 'info' : 'success');
  }

  function preview() {
    flush();
    onPreview(draft.id);
  }

  const kindLabel = draft.kind === 'dm' ? 'Direct message' : 'Reply';
  const sentAt = draft.postedAt || draft.updatedAt;

  return html`<article ref=${ref} id=${`ob-${draft.id}`} className=${cx('card ob-item', highlighted && 'ob-highlight', group === 'rejected' && 'ob-rejected')}>
    <div className="ob-item-head row">
      <${Badge} tone=${draft.kind === 'dm' ? 'info' : 'accent'}>${kindLabel}<//>
      ${thread && thread.author ? html`<span className="small muted truncate">to ${thread.author}</span>` : null}
      <span className="spacer"></span>
      <span className="small muted">
        ${group === 'sent' ? `Sent ${timeAgo(sentAt)}` : `Drafted ${timeAgo(draft.createdAt || draft.updatedAt)}`}
      </span>
    </div>

    <div className="ob-grid">
      <${ThreadContext} thread=${thread} />

      <div className="ob-draft">
        ${draft.error ? html`<div className="ob-error small"><${Icon} name="alert" size=${13} /> ${draft.error}</div>` : null}
        ${editable
          ? html`<textarea
                className="textarea ob-textarea"
                rows="7"
                value=${body}
                aria-label=${`${kindLabel} draft`}
                disabled=${!!busy}
                onChange=${(e) => setBody(e.target.value)}
                onBlur=${flush}
              ></textarea>
              <div className="row ob-counts small">
                <span className="muted">${words} word${words === 1 ? '' : 's'}; ${chars} char${chars === 1 ? '' : 's'}</span>
                ${over
                  ? html`<span className="ob-over">Over LinkedIn's ${limit.toLocaleString()}-char ${draft.kind === 'dm' ? 'message' : 'comment'} limit</span>`
                  : null}
              </div>
              <div className="ob-chips">
                ${REWRITE_CHIPS.map(
                  (c) => html`<button
                    type="button"
                    key=${c}
                    className="pill ob-chip"
                    disabled=${!!busy || empty}
                    onClick=${() => doRewrite(c)}
                  >
                    ${busy === `rw:${c}` ? html`<${Spinner} />` : html`<${Icon} name="sparkles" size=${12} />`} ${c}
                  </button>`,
                )}
              </div>`
          : html`<div className="ob-body-readonly">${draft.body}</div>`}

        <div className="row ob-actions">
          ${group === 'pending'
            ? html`
                <${Button} variant="ghost" size="sm" icon="refresh" loading=${busy === 'regen'} disabled=${!!busy} onClick=${regenerate}>Regenerate<//>
                <span className="spacer"></span>
                <${Button} variant="danger" size="sm" icon="x" disabled=${!!busy} onClick=${() => setStatus('rejected', 'Draft rejected.')}>Reject<//>
                <${Button} variant="primary" size="sm" icon="check" disabled=${!!busy || empty} onClick=${() => setStatus('approved', 'Approved — ready to send.')}>Approve<//>
              `
            : null}
          ${group === 'approved'
            ? html`
                <${Button} variant="ghost" size="sm" disabled=${!!busy} onClick=${() => setStatus('pending')}>Back to pending<//>
                <${Button} variant="ghost" size="sm" icon="x" disabled=${!!busy} onClick=${() => setStatus('rejected', 'Draft rejected.')}>Reject<//>
                <span className="spacer"></span>
                <${Button} variant="primary" size="sm" icon=${connected ? 'send' : 'copy'} disabled=${!!busy || empty} onClick=${preview}>
                  ${connected ? 'Send via LinkedIn (demo)' : 'Copy & open thread'}
                <//>
              `
            : null}
          ${group === 'sent'
            ? html`
                <${Badge} tone="success">${draft.channel === 'copy' ? 'Copied & opened thread' : 'Sent via LinkedIn (demo)'}<//>
                <span className="small muted">${sentAt ? fmtWhen(sentAt) : ''}</span>
                <span className="spacer"></span>
                ${thread && thread.url
                  ? html`<a className="btn btn-ghost btn-sm" href=${thread.url} target="_blank" rel="noopener noreferrer">
                      <${Icon} name="external" size=${14} /> View thread
                    </a>`
                  : null}
              `
            : null}
          ${group === 'rejected'
            ? html`
                <span className="spacer"></span>
                <${Button} variant="secondary" size="sm" icon="refresh" onClick=${() => setStatus('pending', 'Restored to pending.')}>Restore<//>
              `
            : null}
        </div>
      </div>
    </div>
  </article>`;
}

/* ---------------- Preview modal ---------------- */

function CommentPreview({ profile, draft, thread }) {
  return html`<div className="ob-li-thread">
    <div className="ob-li-post">
      <span className="li-avatar ob-li-op" aria-hidden="true">${initialsOf((thread && thread.author) || '?')}</span>
      <div className="ob-li-post-text">
        <div className="small"><strong>${(thread && thread.author) || 'Original poster'}</strong></div>
        <div className="small muted ob-li-post-title">${(thread && thread.title) || 'Original thread'}</div>
      </div>
    </div>
    <div className="ob-li-comment">
      <${LinkedInAvatar} profile=${profile} size=${36} />
      <div className="ob-li-comment-col">
        <div className="ob-li-bubble">
          <div className="row ob-li-bubble-head">
            <div>
              <div className="li-name">${profile.name}</div>
              <div className="li-headline small truncate">${profile.headline}</div>
            </div>
            <span className="spacer"></span>
            <span className="small muted">now</span>
          </div>
          <div className="ob-li-bubble-body">${draft.body}</div>
        </div>
        <div className="ob-li-under small muted">Like · Reply</div>
      </div>
    </div>
  </div>`;
}

function DmPreview({ profile, draft, thread }) {
  const recipient = (thread && thread.author) || 'Recipient';
  return html`<div className="ob-li-dm">
    <div className="ob-li-dm-head row">
      <span className="li-avatar" style=${{ width: '32px', height: '32px', fontSize: '12px' }} aria-hidden="true">${initialsOf(recipient)}</span>
      <div>
        <div className="li-name">${recipient}</div>
        <div className="small muted">LinkedIn messaging (demo)</div>
      </div>
    </div>
    <div className="ob-li-dm-body">
      <div className="ob-li-dm-msg">
        <${LinkedInAvatar} profile=${profile} size=${32} />
        <div className="ob-li-comment-col">
          <div className="row small">
            <strong>${profile.name}</strong>
            <span className="muted">· now</span>
          </div>
          <div className="ob-li-dm-text">${draft.body}</div>
        </div>
      </div>
    </div>
  </div>`;
}

function SendPreviewModal({ draft, thread, connected, onClose }) {
  const profile = useProfile();
  const [sending, setSending] = useState(false);
  const open = !!draft;

  async function confirm() {
    if (!draft) return;
    setSending(true);
    try {
      await sendDraft(draft.id);
      onClose();
    } catch (e) {
      toast(`Couldn't send: ${e && e.message ? e.message : e}`, 'error');
    } finally {
      setSending(false);
    }
  }

  const title = !draft
    ? ''
    : connected
      ? `Preview — ${draft.kind === 'dm' ? 'message' : 'reply'} via LinkedIn (demo)`
      : 'Preview — copy & open thread';

  return html`<${Modal}
    open=${open}
    title=${title}
    onClose=${() => !sending && onClose()}
    footer=${html`
      <${Button} variant="ghost" disabled=${sending} onClick=${onClose}>Cancel<//>
      <${Button} variant="primary" icon=${connected ? 'send' : 'copy'} loading=${sending} disabled=${sending} onClick=${confirm}>Send<//>
    `}
  >
    ${draft
      ? html`<div className="stack">
          ${draft.kind === 'dm'
            ? html`<${DmPreview} profile=${profile} draft=${draft} thread=${thread} />`
            : html`<${CommentPreview} profile=${profile} draft=${draft} thread=${thread} />`}
          ${connected
            ? html`<p className="small muted">
                Clicking Send records this ${draft.kind === 'dm' ? 'message' : 'reply'} in your LinkedIn (demo) activity inside Lens.
                LinkedIn is simulated — nothing leaves your browser.
              </p>`
            : html`<ol className="ob-steps small">
                <li>Lens copies the ${draft.kind === 'dm' ? 'message' : 'reply'} to your clipboard.</li>
                <li>The original thread opens on ${sourceName(thread)} in a new tab — paste it there and post it yourself.</li>
                <li>The draft moves to Sent.</li>
              </ol>`}
        </div>`
      : null}
  <//>`;
}

/* ---------------- Page ---------------- */

export default function Outreach() {
  const { params } = useRoute();
  const drafts = useStore((s) => s.drafts) || [];
  const threads = useStore((s) => s.threads) || [];
  const linkedinStatus = useStore((s) => s.connections && s.connections.linkedin && s.connections.linkedin.status);
  const connected = linkedinStatus === 'connected';

  const threadById = useMemo(() => {
    const m = new Map();
    for (const t of threads) m.set(t.id, t);
    return m;
  }, [threads]);

  const groups = useMemo(() => {
    const g = { pending: [], approved: [], sent: [], rejected: [] };
    for (const d of drafts) {
      if (d.kind !== 'reply' && d.kind !== 'dm') continue;
      g[groupOf(d.status)].push(d);
    }
    const key = (d) => String(d.postedAt || d.updatedAt || d.createdAt || '');
    for (const k of TABS) g[k].sort((a, b) => key(b).localeCompare(key(a)));
    return g;
  }, [drafts]);

  const focusDraft = params.draft ? drafts.find((d) => d.id === params.draft) : null;
  const [tab, setTab] = useState(() => {
    if (focusDraft) return groupOf(focusDraft.status);
    return TABS.includes(params.tab) ? params.tab : 'pending';
  });

  useEffect(() => {
    if (focusDraft) setTab(groupOf(focusDraft.status));
    else if (TABS.includes(params.tab)) setTab(params.tab);
    // react only to route changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.draft, params.tab]);

  const [previewId, setPreviewId] = useState(null);
  const previewDraft = previewId ? drafts.find((d) => d.id === previewId) : null;
  const previewThread = previewDraft ? threadById.get(previewDraft.threadId) : null;

  const items = groups[tab] || [];
  const total = TABS.reduce((n, k) => n + groups[k].length, 0);

  const emptyCopy = {
    pending: { title: 'No drafts waiting', body: 'Find a conversation in Discover and ask Lens to draft a reply or DM — it lands here for your approval.' },
    approved: { title: 'Nothing approved yet', body: 'Approve a pending draft and it will wait here until you preview and send it.' },
    sent: { title: 'Nothing sent yet', body: 'Sent replies and DMs show up here.' },
    rejected: { title: 'No rejected drafts', body: 'Drafts you reject are kept here in case you change your mind.' },
  }[tab];

  return html`<div className="page ob-page">
    <div className="page-header">
      <div>
        <h1>Outreach</h1>
        <p className="page-sub">Every reply and DM waits for your approval. Edit, approve, preview — nothing goes out until you press Send.</p>
      </div>
      <div className="page-actions">
        <${Badge} tone=${connected ? 'success' : 'neutral'}>${connected ? 'LinkedIn (demo) connected' : 'LinkedIn (demo) not connected'}<//>
        <${Button} variant="secondary" icon="search" onClick=${() => navigate('/discover')}>Find conversations<//>
      </div>
    </div>

    ${!connected && total > 0
      ? html`<div className="ob-banner small">
          <${Icon} name="linkedin" size=${16} />
          <span>LinkedIn (demo) isn't connected — approved drafts will be copied to your clipboard and the source thread opened so you can post by hand.</span>
          <span className="spacer"></span>
          <a href="#/connections">Connect</a>
        </div>`
      : null}

    <${Tabs}
      tabs=${TABS.map((id) => ({ id, label: TAB_LABELS[id], count: groups[id].length }))}
      value=${tab}
      onChange=${setTab}
    />

    <div className="ob-list stack">
      ${items.length
        ? items.map(
            (d) => html`<${OutreachItem}
              key=${d.id}
              draft=${d}
              thread=${threadById.get(d.threadId)}
              connected=${connected}
              highlighted=${!!focusDraft && focusDraft.id === d.id}
              onPreview=${setPreviewId}
            />`,
          )
        : html`<div className="card">
            <${Empty}
              icon="inbox"
              title=${emptyCopy.title}
              body=${emptyCopy.body}
              action=${tab === 'pending'
                ? html`<${Button} variant="primary" icon="search" onClick=${() => navigate('/discover')}>Go to Discover<//>`
                : null}
            />
          </div>`}
    </div>

    <${SendPreviewModal}
      draft=${previewDraft && groupOf(previewDraft.status) === 'approved' ? previewDraft : null}
      thread=${previewThread}
      connected=${connected}
      onClose=${() => setPreviewId(null)}
    />
  </div>`;
}

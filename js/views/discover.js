// #/discover — ranked conversations where people describe the problem you solve.
import { html, useState, useEffect, useMemo } from '../lib.js';
import { useStore, setState, toast, liveFlags } from '../store.js';
import { navigate } from '../router.js';
import { Button, Badge, SourceIcon, Empty, Spinner, Tabs, Input, Select, Icon, timeAgo } from '../ui.js';
import { findConversations, draftOutreach, clusterPainPoints } from '../services/lens.js';

const INTENTS = [
  { id: 'all', label: 'Any intent' },
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
];

// Which status tab each thread status belongs to.
const TAB_OF = {
  new: 'new',
  drafted: 'new',
  saved: 'saved',
  contacted: 'contacted',
  dismissed: 'dismissed',
};

const EMPTY_COPY = {
  new: { icon: 'search', title: 'No new conversations', body: 'Run a search to find people describing the problem you solve.' },
  saved: { icon: 'check', title: 'Nothing saved', body: 'Save threads you want to come back to — they collect here.' },
  contacted: { icon: 'send', title: 'No one contacted yet', body: 'Threads move here after you send a reply or DM.' },
  dismissed: { icon: 'x', title: 'Nothing dismissed', body: 'Dismissed threads land here so you can restore them later.' },
};

function intentTone(intent) {
  if (intent === 'high') return 'warning';
  if (intent === 'medium') return 'info';
  return 'neutral';
}

function compactNum(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return Math.round(v / 1000) + 'k';
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(v);
}

function relevanceTier(r) {
  if (r >= 80) return 'hot';
  if (r >= 60) return 'warm';
  return 'cool';
}

function normalizeExample(ex) {
  if (!ex) return '';
  if (typeof ex === 'string') return ex;
  return ex.quote || ex.snippet || ex.title || '';
}

function setThreadStatus(id, status) {
  setState((s) => ({
    threads: (s.threads || []).map((t) => (t.id === id ? { ...t, status } : t)),
  }));
}

function RelevanceMeter({ value }) {
  const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const tier = relevanceTier(v);
  return html`
    <div className=${'rel-meter rel-' + tier} title=${'Relevance ' + v + '/100'} aria-label=${'Relevance ' + v + ' out of 100'}>
      <div className="rel-track"><span className="rel-fill" style=${{ width: v + '%' }}></span></div>
      <span className="rel-num">${v}</span>
    </div>
  `;
}

function ThreadCard({ thread, busy, onDraft, onPainFilter, pendingDraftId }) {
  const t = thread;
  const isSaved = t.status === 'saved';
  const isDismissed = t.status === 'dismissed';
  const eng = t.engagement || {};
  return html`
    <article className=${'thread-card card' + (isDismissed ? ' is-dismissed' : '') + (t.intent === 'high' ? ' is-hot' : '')}>
      <div className="thread-head">
        <div className="thread-meta small">
          <${SourceIcon} source=${t.source} community=${t.community} className="thread-community truncate" />
          ${t.author && html`<span className="muted" aria-hidden="true">·</span><span className="muted truncate">${t.author}</span>`}
          <span className="muted" aria-hidden="true">·</span>
          <span className="muted">${t.publishedAt ? timeAgo(t.publishedAt) : 'recent'}</span>
        </div>
        <${RelevanceMeter} value=${t.relevance} />
      </div>

      <h3 className="thread-title">
        ${t.url ? html`<a href=${t.url} target="_blank" rel="noopener noreferrer">${t.title}</a>` : t.title}
      </h3>

      ${(t.quote || t.snippet) && html`<blockquote className="quote">${t.quote || t.snippet}</blockquote>`}

      <div className="thread-tags">
        <${Badge} tone=${intentTone(t.intent)} icon=${t.intent === 'high' ? 'flame' : null}>${(t.intent || 'low') + ' intent'}<//>
        ${t.painPoint &&
        html`<button type="button" className="pill thread-pain" title="Show threads with this pain point" onClick=${() => onPainFilter(t.painPoint)}>
          ${t.painPoint}
        </button>`}
        ${t.status === 'drafted' && html`<${Badge} tone="accent">Draft in queue<//>`}
        ${t.status === 'contacted' && html`<${Badge} tone="success">Contacted<//>`}
        <span className="spacer"></span>
        <span className="thread-eng small muted">
          <span title="Upvotes"><${Icon} name="chevronUp" size=${12} /> ${compactNum(eng.upvotes)}</span>
          <span title="Replies"><${Icon} name="chat" size=${12} /> ${compactNum(eng.replies)}</span>
        </span>
      </div>

      <div className="thread-actions">
        ${pendingDraftId
          ? html`<${Button}
              variant="primary"
              size="sm"
              icon="arrowRight"
              onClick=${() => navigate('/outreach?draft=' + encodeURIComponent(pendingDraftId))}
            >
              Open draft
            <//>`
          : html`<${Button}
                variant="primary"
                size="sm"
                icon="edit"
                loading=${busy === 'reply'}
                disabled=${!!busy}
                onClick=${() => onDraft(t, 'reply')}
              >
                Draft reply
              <//>
              <${Button}
                variant="secondary"
                size="sm"
                icon="send"
                loading=${busy === 'dm'}
                disabled=${!!busy}
                onClick=${() => onDraft(t, 'dm')}
              >
                Draft DM
              <//>`}
        <${Button}
          variant="ghost"
          size="sm"
          icon="sparkles"
          disabled=${!!busy}
          onClick=${() => navigate('/studio?thread=' + encodeURIComponent(t.id))}
        >
          Post about this
        <//>
        <${Button}
          variant="ghost"
          size="sm"
          icon=${isSaved ? 'check' : 'bookmark'}
          disabled=${!!busy}
          onClick=${() => {
            setThreadStatus(t.id, isSaved ? 'new' : 'saved');
            toast(isSaved ? 'Moved back to New.' : 'Saved for later.', 'info');
          }}
        >
          ${isSaved ? 'Saved' : 'Save'}
        <//>
        <${Button}
          variant="ghost"
          size="sm"
          icon=${isDismissed ? 'refresh' : 'x'}
          disabled=${!!busy}
          onClick=${() => {
            setThreadStatus(t.id, isDismissed ? 'new' : 'dismissed');
            toast(isDismissed ? 'Restored to New.' : 'Dismissed.', 'info');
          }}
        >
          ${isDismissed ? 'Restore' : 'Dismiss'}
        <//>
        <span className="spacer"></span>
        ${t.url &&
        html`<a className="btn btn-ghost btn-sm" href=${t.url} target="_blank" rel="noopener noreferrer">
          <${Icon} name="external" size=${14} /> Open source
        </a>`}
      </div>
    </article>
  `;
}

function ClusterPanel({ clusters, loading, activePain, onFilter }) {
  const max = clusters.reduce((m, c) => Math.max(m, c.count || 0), 1);
  return html`
    <aside className="disc-aside">
      <div className="card cluster-card">
        <div className="card-header">
          <div>
            <div className="card-title">Pain point clusters</div>
            <div className="card-sub">Recurring problems across all threads.</div>
          </div>
          ${loading && html`<div className="card-actions"><${Spinner} /></div>`}
        </div>
        <div className="card-body">
          ${loading && !clusters.length
            ? html`<div className="skel-list" aria-busy="true">
                ${[0, 1, 2, 3].map(
                  (i) => html`<div className="skel-item" key=${i}><div className="skel skel-line skel-w-70"></div><div className="skel skel-line skel-w-90"></div></div>`
                )}
              </div>`
            : clusters.length
            ? html`
                <ul className="cluster-list">
                  ${clusters.map((c) => {
                    const label = c.painPoint || c.label || 'Untitled';
                    const example = normalizeExample(c.example);
                    const active = activePain === label;
                    return html`
                      <li className=${'cluster-item' + (active ? ' is-active' : '')} key=${label}>
                        <button
                          type="button"
                          className="cluster-label"
                          aria-pressed=${active ? 'true' : 'false'}
                          title=${active ? 'Clear filter' : 'Show only these threads'}
                          onClick=${() => onFilter(active ? '' : label)}
                        >
                          <span className="cluster-name">${label}</span>
                          <span className="cluster-count">${c.count || 0}</span>
                        </button>
                        <div className="pain-bar"><span style=${{ width: Math.max(6, Math.round(((c.count || 0) / max) * 100)) + '%' }}></span></div>
                        ${example && html`<p className="cluster-example small muted">“${example}”</p>`}
                        <${Button}
                          variant="ghost"
                          size="sm"
                          icon="sparkles"
                          onClick=${() => navigate('/studio?pain=' + encodeURIComponent(label))}
                        >
                          Turn into post
                        <//>
                      </li>
                    `;
                  })}
                </ul>
              `
            : html`<p className="small muted">Clusters appear once there are a few threads to compare.</p>`}
        </div>
      </div>
    </aside>
  `;
}

export default function Discover() {
  const threads = useStore((s) => s.threads) || [];
  const drafts = useStore((s) => s.drafts) || [];
  const pendingByThread = useMemo(() => {
    const m = new Map();
    for (const d of drafts) if (d && d.threadId && d.status === 'pending' && d.kind !== 'post') m.set(d.threadId, d.id);
    return m;
  }, [drafts]);
  const settings = useStore((s) => s.settings) || {};
  const company = useStore((s) => s.company) || {};
  const loading = useStore((s) => (s.ui && s.ui.loading) || {});

  const [tab, setTab] = useState('new');
  const [sort, setSort] = useState('relevance');
  const [source, setSource] = useState('all');
  const [intent, setIntent] = useState('all');
  const [painFilter, setPainFilter] = useState('');
  const [query, setQuery] = useState('');
  const [lastQuery, setLastQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState({});
  const [clusters, setClusters] = useState([]);
  const [clustersLoading, setClustersLoading] = useState(false);

  // Live search needs demo mode off and a You.com key (the user's, or the deployment's env key).
  const demoMode = !useStore((s) => liveFlags(s).search);
  const threadsLoading = searching || !!loading.threads || !!loading.all;

  const threadSig = useMemo(
    () => threads.filter((t) => t.status !== 'dismissed').map((t) => t.id + ':' + (t.painPoint || '')).join('|'),
    [threads]
  );

  useEffect(() => {
    let alive = true;
    if (!threadSig) {
      setClusters([]);
      return undefined;
    }
    setClustersLoading(true);
    clusterPainPoints()
      .then((res) => {
        if (alive) setClusters((Array.isArray(res) ? res : []).slice().sort((a, b) => (b.count || 0) - (a.count || 0)));
      })
      .catch(() => {
        if (alive) setClusters([]);
      })
      .finally(() => {
        if (alive) setClustersLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [threadSig]);

  const counts = useMemo(() => {
    const c = { new: 0, saved: 0, contacted: 0, dismissed: 0 };
    for (const t of threads) {
      const k = TAB_OF[t.status] || 'new';
      c[k] += 1;
    }
    return c;
  }, [threads]);

  const inTab = useMemo(() => threads.filter((t) => (TAB_OF[t.status] || 'new') === tab), [threads, tab]);

  const sourceCounts = useMemo(() => {
    const m = {};
    for (const t of inTab) m[t.source || 'web'] = (m[t.source || 'web'] || 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [inTab]);

  const visible = useMemo(() => {
    let list = inTab;
    if (source !== 'all') list = list.filter((t) => (t.source || 'web') === source);
    if (intent !== 'all') list = list.filter((t) => (t.intent || 'low') === intent);
    if (painFilter) list = list.filter((t) => t.painPoint === painFilter);
    const sorted = list.slice();
    if (sort === 'newest') sorted.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
    else sorted.sort((a, b) => (b.relevance || 0) - (a.relevance || 0) || new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
    return sorted;
  }, [inTab, source, intent, painFilter, sort]);

  // If the selected source disappears from the current tab, fall back to all.
  useEffect(() => {
    if (source !== 'all' && !sourceCounts.some(([s]) => s === source)) setSource('all');
  }, [sourceCounts, source]);

  const hiddenByFilters = inTab.length - visible.length;

  async function onSearch(e) {
    if (e && e.preventDefault) e.preventDefault();
    const q = query.trim();
    setSearching(true);
    try {
      const before = new Set(threads.map((t) => t.url));
      const res = await findConversations(q ? { query: q } : {});
      const list = Array.isArray(res) ? res : [];
      const fresh = list.filter((t) => t && !before.has(t.url)).length;
      setLastQuery(q);
      setTab('new');
      toast(
        fresh
          ? 'Found ' + fresh + ' new conversation' + (fresh === 1 ? '' : 's') + (q ? ' for “' + q + '”' : '') + '.'
          : 'No new conversations' + (q ? ' for “' + q + '”' : '') + ' — your list is up to date.',
        fresh ? 'success' : 'info'
      );
    } catch (err) {
      toast('Search failed: ' + (err && err.message ? err.message : String(err)), 'error');
    } finally {
      setSearching(false);
    }
  }

  async function onDraft(thread, kind) {
    setBusy((b) => ({ ...b, [thread.id]: kind }));
    try {
      const d = await draftOutreach(thread.id, kind);
      toast((kind === 'dm' ? 'DM' : 'Reply') + ' drafted — review and approve it in Outreach.', 'success');
      navigate(d && d.id ? '/outreach?draft=' + encodeURIComponent(d.id) : '/outreach');
    } catch (err) {
      toast('Could not draft: ' + (err && err.message ? err.message : String(err)), 'error');
      setBusy((b) => {
        const next = { ...b };
        delete next[thread.id];
        return next;
      });
    }
  }

  function clearFilters() {
    setSource('all');
    setIntent('all');
    setPainFilter('');
  }

  const tabs = [
    { id: 'new', label: 'New', count: counts.new },
    { id: 'saved', label: 'Saved', count: counts.saved },
    { id: 'contacted', label: 'Contacted', count: counts.contacted },
    { id: 'dismissed', label: 'Dismissed', count: counts.dismissed },
  ];

  const empty = EMPTY_COPY[tab];
  const keywordHint = (company.keywords || []).slice(0, 3).join(', ');

  return html`
    <div className="page discover-page">
      <header className="page-header">
        <div>
          <h1>Discover</h1>
          <p className="page-sub">
            Recent public conversations where people describe the problem ${company.name ? company.name + ' solves' : 'you solve'}, ranked by relevance.
          </p>
        </div>
      </header>

      ${demoMode &&
      html`<div className="disc-note small">
        <${Icon} name="eye" size=${14} />
        <span>Sample conversations shown in demo mode — add a You.com key in Connections for live results.</span>
        <button type="button" className="disc-note-link" onClick=${() => navigate('/connections')}>Open Connections</button>
      </div>`}

      <form className="disc-search" onSubmit=${onSearch} role="search">
        <div className="disc-search-field">
          <span className="disc-search-icon" aria-hidden="true"><${Icon} name="search" size=${16} /></span>
          <${Input}
            type="search"
            value=${query}
            onChange=${(e) => setQuery(e.target.value)}
            placeholder=${keywordHint ? 'Search conversations, e.g. ' + keywordHint : 'Search conversations about your problem space'}
            aria-label="Search conversations"
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled=${threadsLoading}>
          ${threadsLoading ? html`<${Spinner} />` : html`<${Icon} name="search" size=${16} />`}
          <span>${threadsLoading ? 'Searching…' : query.trim() ? 'Search' : 'Find conversations'}</span>
        </button>
      </form>
      ${lastQuery &&
      html`<div className="small muted disc-lastq">
        Last search: <strong>${lastQuery}</strong>
        <button type="button" className="disc-note-link" onClick=${() => { setQuery(''); setLastQuery(''); }}>Clear</button>
      </div>`}

      <div className="disc-layout">
        <section className="disc-main">
          <div className="disc-toolbar">
            <${Tabs} tabs=${tabs} value=${tab} onChange=${setTab} />
            <div className="disc-sort">
              <label className="small muted" htmlFor="disc-sort">Sort</label>
              <${Select} id="disc-sort" value=${sort} onChange=${(e) => setSort(e.target.value)}>
                <option value="relevance">Relevance</option>
                <option value="newest">Newest</option>
              </${Select}>
            </div>
          </div>

          <div className="disc-filters">
            <div className="disc-chiprow" role="group" aria-label="Filter by source">
              <button type="button" className=${'pill filter-chip' + (source === 'all' ? ' is-active' : '')} onClick=${() => setSource('all')}>
                All sources <span className="chip-count">${inTab.length}</span>
              </button>
              ${sourceCounts.map(
                ([s, n]) => html`
                  <button
                    type="button"
                    key=${s}
                    className=${'pill filter-chip' + (source === s ? ' is-active' : '')}
                    onClick=${() => setSource(source === s ? 'all' : s)}
                  >
                    <${SourceIcon} source=${s} /> <span className="chip-count">${n}</span>
                  </button>
                `
              )}
            </div>
            <div className="disc-chiprow" role="group" aria-label="Filter by intent">
              ${INTENTS.map(
                (it) => html`
                  <button
                    type="button"
                    key=${it.id}
                    className=${'pill filter-chip' + (intent === it.id ? ' is-active' : '') + (it.id === 'high' ? ' chip-hot' : '')}
                    onClick=${() => setIntent(it.id)}
                  >
                    ${it.label}
                  </button>
                `
              )}
              ${painFilter &&
              html`<button type="button" className="pill filter-chip is-active" onClick=${() => setPainFilter('')} title="Clear pain point filter">
                <${Icon} name="filter" size=${12} /> ${painFilter} <${Icon} name="x" size=${12} />
              </button>`}
            </div>
          </div>

          ${threadsLoading && !visible.length
            ? html`<div className="thread-list">
                ${[0, 1, 2].map(
                  (i) => html`<div className="card thread-card thread-skel" key=${i}>
                    <div className="skel skel-line skel-w-30"></div>
                    <div className="skel skel-line skel-w-70 skel-tall"></div>
                    <div className="skel skel-block"></div>
                    <div className="skel skel-line skel-w-50"></div>
                  </div>`
                )}
              </div>`
            : visible.length
            ? html`
                <div className="disc-count small muted">
                  ${visible.length} ${visible.length === 1 ? 'conversation' : 'conversations'}
                  ${hiddenByFilters > 0 &&
                  html` · ${hiddenByFilters} hidden by filters <button type="button" className="disc-note-link" onClick=${clearFilters}>Clear filters</button>`}
                </div>
                <div className=${'thread-list' + (threadsLoading ? ' is-refreshing' : '')}>
                  ${visible.map(
                    (t) => html`<${ThreadCard}
                      key=${t.id}
                      thread=${t}
                      busy=${busy[t.id]}
                      pendingDraftId=${t.status === 'drafted' ? pendingByThread.get(t.id) : undefined}
                      onDraft=${onDraft}
                      onPainFilter=${(p) => setPainFilter(painFilter === p ? '' : p)}
                    />`
                  )}
                </div>
              `
            : html`<${Empty}
                icon=${inTab.length ? 'filter' : empty.icon}
                title=${inTab.length ? 'No threads match these filters' : empty.title}
                body=${inTab.length ? hiddenByFilters + ' threads are hidden by your filters.' : empty.body}
                action=${inTab.length
                  ? html`<${Button} variant="secondary" size="sm" onClick=${clearFilters}>Clear filters<//>`
                  : tab === 'new'
                  ? html`<${Button} variant="primary" size="sm" icon="search" onClick=${onSearch}>Find conversations<//>`
                  : null}
              />`}
        </section>

        <${ClusterPanel}
          clusters=${clusters}
          loading=${clustersLoading}
          activePain=${painFilter}
          onFilter=${setPainFilter}
        />
      </div>
    </div>
  `;
}

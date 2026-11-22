// #/ — dashboard: what's happening in your field, this week, and in your pipeline.
import { html, useState, useEffect, useMemo } from '../lib.js';
import { useStore, setState, toast } from '../store.js';
import { navigate } from '../router.js';
import { Button, Card, Badge, SourceIcon, Empty, Spinner, Icon, timeAgo, fmtDate } from '../ui.js';
import { refreshAll, clusterPainPoints } from '../services/lens.js';

let autoRefreshStarted = false;

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfWeek(d) {
  const x = startOfDay(d);
  const dow = (x.getDay() + 6) % 7; // Monday = 0
  x.setDate(x.getDate() - dow);
  return x;
}

function dayKey(d) {
  const x = new Date(d);
  return x.getFullYear() + '-' + (x.getMonth() + 1) + '-' + x.getDate();
}

function timeOf(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function dayLabel(date, now) {
  const diff = Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return fmtDate(date.toISOString(), { weekday: 'long' });
}

function greetingFor(now) {
  const h = now.getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function firstName(profile) {
  if (!profile || !profile.name) return '';
  return String(profile.name).trim().split(/\s+/)[0];
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

function isLoading(loading, keys) {
  if (!loading) return false;
  return keys.some((k) => !!loading[k]);
}

function normalizeExample(ex) {
  if (!ex) return '';
  if (typeof ex === 'string') return ex;
  return ex.quote || ex.snippet || ex.title || '';
}

function SkeletonRows({ count = 3, variant = 'row' }) {
  return html`
    <div className="skel-list" aria-busy="true" aria-label="Loading">
      ${Array.from({ length: count }).map(
        (_, i) => html`
          <div className=${'skel-item skel-' + variant} key=${i}>
            <div className="skel skel-line skel-w-30"></div>
            <div className="skel skel-line skel-w-90"></div>
            <div className="skel skel-line skel-w-70"></div>
          </div>
        `
      )}
    </div>
  `;
}

function StatTile({ label, value, sub, icon, tone, onClick }) {
  return html`
    <button type="button" className=${'stat-tile' + (tone ? ' stat-' + tone : '')} onClick=${onClick}>
      <div className="stat-top">
        <span className="stat-icon"><${Icon} name=${icon} size=${16} /></span>
        <span className="stat-label">${label}</span>
      </div>
      <div className="stat-value">${value}</div>
      <div className="stat-sub small muted">${sub}</div>
    </button>
  `;
}

function TrendItem({ trend }) {
  const host = safeHost(trend.url);
  return html`
    <article className="trend-item">
      <div className="trend-meta small muted">
        <${SourceIcon} source=${trend.source || 'web'} label=${false} />
        <span className="truncate">${host || trend.source || 'web'}</span>
        <span aria-hidden="true">·</span>
        <span>${trend.publishedAt ? timeAgo(trend.publishedAt) : 'recent'}</span>
        ${trend.tag && html`<${Badge} tone="neutral">${trend.tag}<//>`}
      </div>
      <h3 className="trend-title">
        ${trend.url
          ? html`<a href=${trend.url} target="_blank" rel="noopener noreferrer">${trend.title}</a>`
          : trend.title}
      </h3>
      ${trend.summary && html`<p className="trend-summary">${trend.summary}</p>`}
      <div className="trend-actions">
        <${Button}
          variant="secondary"
          size="sm"
          icon="edit"
          onClick=${() => navigate('/studio?trend=' + encodeURIComponent(trend.id))}
        >
          Write a post about this
        <//>
        ${trend.url &&
        html`<a className="btn btn-ghost btn-sm" href=${trend.url} target="_blank" rel="noopener noreferrer">
          <${Icon} name="external" size=${14} /> Open
        </a>`}
      </div>
    </article>
  `;
}

function EventItem({ event, onToggle }) {
  const start = timeOf(event.start);
  const end = event.end ? timeOf(event.end) : '';
  const virtual = event.format === 'virtual';
  return html`
    <li className=${'event-item' + (event.saved ? ' is-saved' : '')}>
      <div className="event-time">
        <span className="event-start">${start}</span>
        ${end && html`<span className="event-end small muted">${end}</span>`}
      </div>
      <div className="event-body">
        <div className="event-title-row">
          ${event.url
            ? html`<a className="event-title" href=${event.url} target="_blank" rel="noopener noreferrer">${event.title}</a>`
            : html`<span className="event-title">${event.title}</span>`}
          <${Badge} tone=${virtual ? 'info' : 'accent'}>${virtual ? 'Virtual' : 'In person'}<//>
        </div>
        <div className="event-meta small muted">
          ${event.location &&
          html`<span className="event-meta-item"><${Icon} name=${virtual ? 'globe' : 'mapPin'} size=${12} /> ${event.location}</span>`}
          ${event.host && html`<span className="event-meta-item"><${Icon} name="users" size=${12} /> ${event.host}</span>`}
        </div>
        ${event.why && html`<p className="event-why small">${event.why}</p>`}
        <div className="event-actions">
          <${Button}
            variant=${event.saved ? 'primary' : 'secondary'}
            size="sm"
            icon=${event.saved ? 'check' : 'plus'}
            onClick=${() => onToggle(event.id)}
          >
            ${event.saved ? 'In my week' : 'Add to my week'}
          <//>
          ${event.url &&
          html`<a className="btn btn-ghost btn-sm" href=${event.url} target="_blank" rel="noopener noreferrer">
            <${Icon} name="external" size=${14} /> Details
          </a>`}
        </div>
      </div>
    </li>
  `;
}

function intentTone(intent) {
  if (intent === 'high') return 'warning';
  if (intent === 'medium') return 'info';
  return 'neutral';
}

function HotThread({ thread }) {
  return html`
    <article className="hot-thread">
      <div className="hot-thread-meta small muted">
        <${SourceIcon} source=${thread.source} community=${thread.community} className="truncate" />
        <span aria-hidden="true">·</span>
        <span>${thread.publishedAt ? timeAgo(thread.publishedAt) : ''}</span>
        <span className="spacer"></span>
        <span className="hot-score" title="Relevance">${Math.round(thread.relevance || 0)}</span>
      </div>
      <h3 className="hot-thread-title">${thread.title}</h3>
      ${(thread.quote || thread.snippet) &&
      html`<blockquote className="quote quote-compact">${thread.quote || thread.snippet}</blockquote>`}
      <div className="row hot-thread-foot">
        <${Badge} tone=${intentTone(thread.intent)} icon=${thread.intent === 'high' ? 'flame' : null}>${(thread.intent || 'low') + ' intent'}<//>
        ${thread.painPoint && html`<span className="pill truncate">${thread.painPoint}</span>`}
      </div>
    </article>
  `;
}

export default function Dashboard() {
  const company = useStore((s) => s.company) || {};
  const threads = useStore((s) => s.threads) || [];
  const trends = useStore((s) => s.trends) || [];
  const events = useStore((s) => s.events) || [];
  const drafts = useStore((s) => s.drafts) || [];
  const ui = useStore((s) => s.ui) || {};
  const profile = useStore((s) => (s.connections && s.connections.linkedin && s.connections.linkedin.profile) || null);

  const loading = ui.loading || {};
  const now = new Date();

  const [clusters, setClusters] = useState([]);
  const [clustersLoading, setClustersLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [onlySaved, setOnlySaved] = useState(false);

  // First visit after onboarding with nothing loaded yet — fetch once.
  useEffect(() => {
    if (autoRefreshStarted) return;
    if (!threads.length && !trends.length && !events.length && !ui.lastRefresh && !isLoading(loading, ['threads', 'trends', 'events', 'all'])) {
      autoRefreshStarted = true;
      refreshAll().catch((err) => toast('Refresh failed: ' + (err && err.message ? err.message : String(err)), 'error'));
    }
  }, []);

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
        if (alive) setClusters(Array.isArray(res) ? res : []);
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

  const stats = useMemo(() => {
    const weekStart = startOfWeek(new Date()).getTime();
    const newThreads = threads.filter((t) => t.status === 'new');
    const highIntent = newThreads.filter((t) => t.intent === 'high').length;
    const pending = drafts.filter((d) => d.status === 'pending');
    const pendingReplies = pending.filter((d) => d.kind !== 'post').length;
    const scheduled = drafts
      .filter((d) => d.kind === 'post' && d.status === 'scheduled' && d.scheduledFor)
      .sort((a, b) => new Date(a.scheduledFor) - new Date(b.scheduledFor));
    const published = drafts.filter((d) => {
      if (d.status !== 'posted' && d.status !== 'sent') return false;
      const at = new Date(d.postedAt || d.updatedAt || d.createdAt).getTime();
      return at >= weekStart;
    });
    return {
      newThreads: newThreads.length,
      highIntent,
      pending: pending.length,
      pendingReplies,
      scheduled: scheduled.length,
      nextScheduled: scheduled[0] ? scheduled[0].scheduledFor : null,
      published: published.length,
      publishedPosts: published.filter((d) => d.kind === 'post').length,
    };
  }, [threads, drafts]);

  const sortedTrends = useMemo(
    () => [...trends].sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)).slice(0, 6),
    [trends]
  );

  const eventGroups = useMemo(() => {
    const today = startOfDay(new Date()).getTime();
    const horizon = today + 7 * DAY_MS;
    const upcoming = events
      .filter((e) => {
        const t = new Date(e.end || e.start).getTime();
        const s = new Date(e.start).getTime();
        return !isNaN(s) && t >= Date.now() - 60 * 60 * 1000 && s < horizon;
      })
      .filter((e) => (onlySaved ? e.saved : true))
      .sort((a, b) => new Date(a.start) - new Date(b.start));
    const groups = [];
    const byKey = {};
    for (const e of upcoming) {
      const k = dayKey(e.start);
      if (!byKey[k]) {
        byKey[k] = { key: k, date: new Date(e.start), items: [] };
        groups.push(byKey[k]);
      }
      byKey[k].items.push(e);
    }
    return groups;
  }, [events, onlySaved]);

  const savedCount = events.filter((e) => e.saved).length;

  const hotThreads = useMemo(
    () =>
      threads
        .filter((t) => t.status !== 'dismissed' && t.status !== 'contacted')
        .sort((a, b) => (b.relevance || 0) - (a.relevance || 0))
        .slice(0, 3),
    [threads]
  );

  const topClusters = useMemo(
    () => [...clusters].sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 5),
    [clusters]
  );
  const maxCluster = topClusters.reduce((m, c) => Math.max(m, c.count || 0), 1);

  const anyLoading = refreshing || isLoading(loading, ['threads', 'trends', 'events', 'all', 'refresh']);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await refreshAll();
      toast('Feed refreshed.', 'success');
    } catch (err) {
      toast('Refresh failed: ' + (err && err.message ? err.message : String(err)), 'error');
    } finally {
      setRefreshing(false);
    }
  }

  function toggleEvent(id) {
    const current = events.find((e) => e.id === id);
    const added = !(current && current.saved);
    setState((s) => ({
      events: (s.events || []).map((e) => (e.id === id ? { ...e, saved: added } : e)),
    }));
    toast(added ? 'Added to your week.' : 'Removed from your week.', 'info');
  }

  const field = company.field || 'your field';
  const name = firstName(profile);
  const trendsLoading = isLoading(loading, ['trends', 'all']) || (refreshing && !trends.length);
  const eventsLoading = isLoading(loading, ['events', 'all']) || (refreshing && !events.length);
  const threadsLoading = isLoading(loading, ['threads', 'all']) || (refreshing && !threads.length);

  return html`
    <div className="page dashboard-page">
      <header className="page-header dash-header">
        <div>
          <div className="dash-date small">${fmtDate(now.toISOString(), { weekday: 'long', month: 'long', day: 'numeric' })}</div>
          <h1>${greetingFor(now)}${name ? ', ' + name : ''}.</h1>
          <p className="page-sub">
            Here is what's moving in ${field}${company.name ? ' for ' + company.name : ''} — and who might need you today.
          </p>
        </div>
        <div className="page-actions">
          ${ui.lastRefresh && html`<span className="small muted dash-refreshed">Updated ${timeAgo(ui.lastRefresh)}</span>`}
          <${Button} variant="secondary" icon="refresh" loading=${anyLoading} disabled=${anyLoading} onClick=${onRefresh}>
            ${anyLoading ? 'Refreshing…' : 'Refresh'}
          <//>
        </div>
      </header>

      <section className="stat-row" aria-label="Pipeline">
        <${StatTile}
          label="New threads"
          value=${stats.newThreads}
          icon="search"
          tone=${stats.highIntent ? 'hot' : ''}
          sub=${stats.highIntent ? stats.highIntent + ' high intent' : 'Nothing urgent'}
          onClick=${() => navigate('/discover')}
        />
        <${StatTile}
          label="Pending approvals"
          value=${stats.pending}
          icon="inbox"
          sub=${stats.pending ? stats.pendingReplies + ' in Outreach · ' + (stats.pending - stats.pendingReplies) + ' posts in Studio' : 'Queue is clear'}
          onClick=${() => navigate(stats.pending && !stats.pendingReplies ? '/studio' : '/outreach')}
        />
        <${StatTile}
          label="Scheduled posts"
          value=${stats.scheduled}
          icon="calendar"
          sub=${stats.nextScheduled ? 'Next ' + fmtDate(stats.nextScheduled, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'Nothing scheduled'}
          onClick=${() => navigate('/schedule')}
        />
        <${StatTile}
          label="Published this week"
          value=${stats.published}
          icon="send"
          sub=${stats.published ? stats.publishedPosts + ' posts · ' + (stats.published - stats.publishedPosts) + ' replies' : 'Since Monday'}
          onClick=${() => navigate('/schedule')}
        />
      </section>

      <div className="dash-grid">
        <div className="dash-col dash-col-main stack">
          <${Card}
            title=${'Trending in ' + field}
            subtitle="Fresh stories worth a point of view."
            actions=${trendsLoading && trends.length ? html`<${Spinner} />` : null}
            className="dash-trends"
          >
            ${trendsLoading && !trends.length
              ? html`<${SkeletonRows} count=${3} />`
              : sortedTrends.length
              ? html`<div className="trend-list">${sortedTrends.map((t) => html`<${TrendItem} key=${t.id} trend=${t} />`)}</div>`
              : html`<${Empty}
                  icon="trending"
                  title="No trends yet"
                  body=${'Refresh to pull the latest news in ' + field + '.'}
                  action=${html`<${Button} variant="secondary" size="sm" icon="refresh" onClick=${onRefresh}>Refresh<//>`}
                />`}
          <//>

          <${Card}
            title="Hot conversations"
            subtitle="Highest-relevance threads you haven't handled yet."
            actions=${html`<${Button} variant="ghost" size="sm" icon="arrowRight" onClick=${() => navigate('/discover')}>Review<//>`}
            className="dash-hot"
          >
            ${threadsLoading && !threads.length
              ? html`<${SkeletonRows} count=${3} />`
              : hotThreads.length
              ? html`
                  <div className="hot-list">${hotThreads.map((t) => html`<${HotThread} key=${t.id} thread=${t} />`)}</div>
                  <div className="dash-card-foot">
                    <${Button} variant="primary" size="sm" icon="arrowRight" onClick=${() => navigate('/discover')}>Review all conversations<//>
                  </div>
                `
              : html`<${Empty}
                  icon="chat"
                  title="No open conversations"
                  body="Run a search in Discover to find people describing your problem."
                  action=${html`<${Button} variant="secondary" size="sm" icon="search" onClick=${() => navigate('/discover')}>Go to Discover<//>`}
                />`}
          <//>
        </div>

        <div className="dash-col dash-col-side stack">
          <${Card}
            title="Founder events this week"
            subtitle=${savedCount ? savedCount + ' in your week' : 'Meet your audience in person.'}
            actions=${html`
              <div className="row">
                ${eventsLoading && events.length ? html`<${Spinner} />` : null}
                <button
                  type="button"
                  className=${'pill dash-toggle' + (onlySaved ? ' is-active' : '')}
                  aria-pressed=${onlySaved ? 'true' : 'false'}
                  onClick=${() => setOnlySaved((v) => !v)}
                >
                  ${onlySaved ? 'Showing my week' : 'My week only'}
                </button>
              </div>
            `}
            className="dash-events"
          >
            ${eventsLoading && !events.length
              ? html`<${SkeletonRows} count=${3} variant="event" />`
              : eventGroups.length
              ? html`
                  <div className="event-days">
                    ${eventGroups.map(
                      (g) => html`
                        <section className="event-day" key=${g.key}>
                          <h4 className="event-day-label">
                            <span>${dayLabel(g.date, now)}</span>
                            <span className="muted">${fmtDate(g.date.toISOString(), { month: 'short', day: 'numeric' })}</span>
                          </h4>
                          <ul className="event-list">
                            ${g.items.map((e) => html`<${EventItem} key=${e.id} event=${e} onToggle=${toggleEvent} />`)}
                          </ul>
                        </section>
                      `
                    )}
                  </div>
                `
              : html`<${Empty}
                  icon="calendar"
                  title=${onlySaved ? 'Nothing in your week yet' : 'No events found this week'}
                  body=${onlySaved ? 'Add events below to build your week.' : 'Refresh to search for founder events in ' + field + '.'}
                  action=${onlySaved
                    ? html`<${Button} variant="secondary" size="sm" onClick=${() => setOnlySaved(false)}>Show all events<//>`
                    : html`<${Button} variant="secondary" size="sm" icon="refresh" onClick=${onRefresh}>Refresh<//>`}
                />`}
          <//>

          <${Card}
            title="Recurring pain points"
            subtitle="What keeps coming up across threads."
            actions=${clustersLoading && topClusters.length ? html`<${Spinner} />` : null}
            className="dash-pains"
          >
            ${(clustersLoading || threadsLoading) && !topClusters.length
              ? html`<${SkeletonRows} count=${3} variant="pain" />`
              : topClusters.length
              ? html`
                  <ul className="pain-list">
                    ${topClusters.map((c) => {
                      const label = c.painPoint || c.label || 'Untitled';
                      const example = normalizeExample(c.example);
                      return html`
                        <li className="pain-item" key=${label}>
                          <div className="pain-head">
                            <span className="pain-label">${label}</span>
                            <span className="pain-count">${c.count || 0}</span>
                          </div>
                          <div className="pain-bar"><span style=${{ width: Math.max(6, Math.round(((c.count || 0) / maxCluster) * 100)) + '%' }}></span></div>
                          ${example && html`<p className="pain-example small muted">“${example}”</p>`}
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
              : html`<${Empty} icon="filter" title="No patterns yet" body="Pain points appear once Lens has a few threads to compare." />`}
          <//>
        </div>
      </div>
    </div>
  `;
}

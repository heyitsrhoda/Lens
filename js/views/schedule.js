// Schedule (#/schedule) — week calendar of scheduled + posted posts, upcoming list,
// and the mock "Published (LinkedIn demo feed)".
import { html, useState, useEffect, useMemo } from '../lib.js';
import { useStore, toast } from '../store.js';
import { navigate } from '../router.js';
import { Button, Badge, Empty, Icon, timeAgo } from '../ui.js';
import { scheduleDraft } from '../services/lens.js';
import {
  cx,
  patchDraft,
  firstLine,
  toLocalInput,
  fromLocalInput,
  fmtWhen,
  fmtTime,
  relTime,
  useProfile,
  LinkedInAvatar,
  PostPreview,
} from './studio.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfWeek(now, offsetWeeks = 0) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const sinceMonday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - sinceMonday + offsetWeeks * 7);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function dayKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function weekLabel(start) {
  const end = addDays(start, 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const sameYear = start.getFullYear() === end.getFullYear();
  const a = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' });
  const b = end.toLocaleDateString(undefined, sameMonth ? { day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  return `${a} – ${b}`;
}

function snippet(text, max = 90) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/* ---------------- Week calendar ---------------- */

function WeekCalendar({ items, now }) {
  const [offset, setOffset] = useState(0);
  const start = startOfWeek(now, offset);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const todayKey = dayKey(now);

  const byDay = useMemo(() => {
    const m = new Map();
    for (const it of items) {
      const k = dayKey(it.at);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(it);
    }
    for (const list of m.values()) list.sort((a, b) => new Date(a.at) - new Date(b.at));
    return m;
  }, [items]);

  const weekCount = days.reduce((n, d) => n + (byDay.get(dayKey(d)) || []).length, 0);

  return html`<section className="card sc-week">
    <div className="card-header sc-week-head">
      <div>
        <div className="card-title">${weekLabel(start)}</div>
        <div className="card-sub">${weekCount} post${weekCount === 1 ? '' : 's'} this week</div>
      </div>
      <div className="card-actions row">
        <${Button} variant="ghost" size="sm" icon="chevronLeft" title="Previous week" onClick=${() => setOffset(offset - 1)}>Prev<//>
        <${Button} variant="secondary" size="sm" disabled=${offset === 0} onClick=${() => setOffset(0)}>This week<//>
        <${Button} variant="ghost" size="sm" iconRight="chevronRight" title="Next week" onClick=${() => setOffset(offset + 1)}>Next<//>
      </div>
    </div>
    <div className="sc-grid" role="grid" aria-label=${`Week of ${weekLabel(start)}`}>
      ${days.map((d) => {
        const k = dayKey(d);
        const list = byDay.get(k) || [];
        const isToday = k === todayKey;
        const isPast = d.getTime() + DAY_MS <= now.getTime();
        return html`<div key=${k} className=${cx('sc-day', isToday && 'today', isPast && 'past')} role="gridcell">
          <div className="sc-day-head">
            <span className="sc-dow">${d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
            <span className="sc-date">${d.getDate()}</span>
            ${isToday ? html`<span className="sc-today-label">Today</span>` : null}
          </div>
          <div className="sc-day-body">
            ${list.length ? null : html`<span className="sc-none small muted">—</span>`}
            ${list.map(
              (it) => html`<button
                type="button"
                key=${it.key}
                className=${cx('sc-event', it.kind)}
                disabled=${!it.draftId}
                title=${it.draftId ? 'Open in Studio' : 'Published post'}
                onClick=${() => it.draftId && navigate(`/studio?draft=${it.draftId}`)}
              >
                <span className="sc-event-time">
                  ${fmtTime(it.at)}
                  ${it.kind === 'posted' ? html`<${Icon} name="check" size=${12} />` : html`<${Icon} name="clock" size=${12} />`}
                </span>
                <span className="sc-event-title">${it.label}</span>
              </button>`,
            )}
          </div>
        </div>`;
      })}
    </div>
    <div className="row sc-legend small muted">
      <span className="sc-legend-item"><span className="sc-swatch scheduled"></span> Scheduled</span>
      <span className="sc-legend-item"><span className="sc-swatch posted"></span> Posted</span>
      <span className="spacer"></span>
      <span>Click a post to open it in Studio</span>
    </div>
  </section>`;
}

/* ---------------- Upcoming ---------------- */

function UpcomingRow({ draft, now, connected }) {
  const [when, setWhen] = useState(() => toLocalInput(draft.scheduledFor));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setWhen(toLocalInput(draft.scheduledFor));
  }, [draft.scheduledFor]);

  const due = new Date(draft.scheduledFor).getTime() <= now.getTime();
  const changed = when !== toLocalInput(draft.scheduledFor);

  async function reschedule() {
    const dt = fromLocalInput(when);
    if (!dt) {
      toast('Pick a date and time first.', 'error');
      return;
    }
    if (dt.getTime() <= Date.now()) {
      toast('Pick a time in the future.', 'error');
      return;
    }
    setSaving(true);
    try {
      await scheduleDraft(draft.id, dt.toISOString());
      toast(`Rescheduled for ${fmtWhen(dt.toISOString())}.`, 'success');
    } catch (e) {
      toast(`Couldn't reschedule: ${e && e.message ? e.message : e}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  function unschedule() {
    patchDraft(draft.id, { status: 'pending', scheduledFor: null });
    toast('Unscheduled — the post is back in your Studio drafts.', 'info');
  }

  return html`<li className=${cx('sc-up', due && 'due')}>
    <div className="sc-up-main">
      <button type="button" className="sc-up-title" onClick=${() => navigate(`/studio?draft=${draft.id}`)}>
        ${firstLine(draft, 90)}
      </button>
      <div className="row small muted sc-up-meta">
        <${Icon} name="clock" size=${13} />
        <span>${fmtWhen(draft.scheduledFor)}</span>
        <span>· ${relTime(draft.scheduledFor, now)}</span>
        ${draft.visual ? html`<span>· <${Icon} name=${draft.visual.type === 'sculptex' ? 'cube' : 'image'} size=${13} /> visual</span>` : null}
        ${due
          ? html`<${Badge} tone="warning">${connected ? 'Due — publishing shortly' : 'Due — post it now'}<//>`
          : null}
      </div>
    </div>
    <div className="row sc-up-actions">
      <input
        className="input sc-up-when"
        type="datetime-local"
        value=${when}
        min=${toLocalInput(new Date())}
        aria-label="New date and time"
        onChange=${(e) => setWhen(e.target.value)}
      />
      <${Button} variant="secondary" size="sm" icon="calendar" loading=${saving} disabled=${!changed || saving} onClick=${reschedule}>Reschedule<//>
      <${Button} variant="ghost" size="sm" icon="x" onClick=${unschedule}>Unschedule<//>
      ${due && !connected
        ? html`<${Button} variant="primary" size="sm" icon="send" onClick=${() => navigate(`/studio?draft=${draft.id}`)}>Post now<//>`
        : null}
    </div>
  </li>`;
}

/* ---------------- Published feed ---------------- */

function ActivityCard({ entry, profile }) {
  const isDm = entry.kind === 'dm';
  return html`<article className="li-card sc-activity">
    <div className="sc-activity-kicker small muted">
      <${Icon} name=${isDm ? 'send' : 'chat'} size=${13} />
      ${isDm ? ' You sent a message' : ' You commented'}${entry.to ? html` ${isDm ? 'to' : 'on a thread by'} <strong>${entry.to}</strong>` : null}
    </div>
    <header className="li-head">
      <${LinkedInAvatar} profile=${profile} size=${40} />
      <div className="li-who">
        <div className="li-name">${profile.name}</div>
        <div className="li-headline truncate">${profile.headline}</div>
        <div className="li-meta">${timeAgo(entry.at)}${isDm ? ' · Private' : ' · 🌐'}</div>
      </div>
    </header>
    <div className=${cx('li-body', isDm && 'sc-dm-body')}>${entry.body}</div>
    <div className="li-counts small">
      ${isDm
        ? html`<span>Delivered</span><span>${entry.comments || 0} repl${entry.comments === 1 ? 'y' : 'ies'}</span>`
        : html`<span className="li-reacts"><span>👍</span><span>❤️</span> ${entry.reactions || 0}</span>
            <span>${entry.comments || 0} repl${entry.comments === 1 ? 'y' : 'ies'}</span>`}
    </div>
    ${entry.threadUrl
      ? html`<a className="sc-activity-link small" href=${entry.threadUrl} target="_blank" rel="noopener noreferrer">
          View source thread <${Icon} name="external" size=${12} />
        </a>`
      : null}
  </article>`;
}

function PublishedFeed({ feed, drafts, profile }) {
  const [filter, setFilter] = useState('all');
  const sorted = useMemo(() => [...feed].sort((a, b) => new Date(b.at) - new Date(a.at)), [feed]);
  const counts = {
    all: sorted.length,
    post: sorted.filter((e) => e.kind === 'post').length,
    reply: sorted.filter((e) => e.kind === 'reply').length,
    dm: sorted.filter((e) => e.kind === 'dm').length,
  };
  const shown = filter === 'all' ? sorted : sorted.filter((e) => e.kind === filter);
  const draftById = useMemo(() => new Map(drafts.map((d) => [d.id, d])), [drafts]);
  const draftIds = draftById;
  const filters = [
    { id: 'all', label: 'All' },
    { id: 'post', label: 'Posts' },
    { id: 'reply', label: 'Replies' },
    { id: 'dm', label: 'DMs' },
  ];

  return html`<section className="sc-feed">
    <div className="row sc-section-head">
      <h2 className="sc-h2">Published <span className="muted">(LinkedIn demo feed)</span></h2>
      <span className="spacer"></span>
      <div className="row sc-filters">
        ${filters.map(
          (f) => html`<button
            type="button"
            key=${f.id}
            className=${cx('pill sc-filter', filter === f.id && 'active')}
            onClick=${() => setFilter(f.id)}
          >
            ${f.label} <span className="muted">${counts[f.id]}</span>
          </button>`,
        )}
      </div>
    </div>
    ${shown.length
      ? html`<div className="sc-feed-list">
          ${shown.map((e) =>
            e.kind === 'post'
              ? html`<div key=${e.id} className="sc-feed-item">
                  <${PostPreview}
                    profile=${profile}
                    body=${e.body}
                    visual=${e.visual || (e.draftId && draftById.get(e.draftId)?.visual) || undefined}
                    timeLabel=${timeAgo(e.at)}
                    reactions=${e.reactions || 0}
                    comments=${e.comments || 0}
                  />
                  ${e.draftId && draftIds.has(e.draftId)
                    ? html`<button type="button" className="sc-feed-open small" onClick=${() => navigate(`/studio?draft=${e.draftId}`)}>
                        Open draft in Studio <${Icon} name="arrowRight" size=${12} />
                      </button>`
                    : null}
                </div>`
              : html`<div key=${e.id} className="sc-feed-item"><${ActivityCard} entry=${e} profile=${profile} /></div>`,
          )}
        </div>`
      : html`<div className="card">
          <${Empty}
            icon="linkedin"
            title=${filter === 'all' ? 'Nothing published yet' : 'Nothing here yet'}
            body="Posts, replies and DMs you send through LinkedIn (demo) appear here. LinkedIn is simulated — nothing leaves your browser."
          />
        </div>`}
  </section>`;
}

/* ---------------- Page ---------------- */

export default function Schedule() {
  const drafts = useStore((s) => s.drafts) || [];
  const feed = useStore((s) => s.linkedinFeed) || [];
  const linkedinStatus = useStore((s) => s.connections && s.connections.linkedin && s.connections.linkedin.status);
  const connected = linkedinStatus === 'connected';
  const profile = useProfile();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  const posts = useMemo(() => drafts.filter((d) => d.kind === 'post'), [drafts]);

  const calendarItems = useMemo(() => {
    const items = [];
    const postIds = new Set();
    for (const d of posts) {
      postIds.add(d.id);
      if (d.status === 'scheduled' && d.scheduledFor) {
        items.push({ key: `s-${d.id}`, draftId: d.id, at: d.scheduledFor, kind: 'scheduled', label: firstLine(d, 60) });
      } else if (d.status === 'posted' || d.status === 'sent') {
        const at = d.postedAt || d.updatedAt;
        if (at) items.push({ key: `p-${d.id}`, draftId: d.id, at, kind: 'posted', label: firstLine(d, 60) });
      }
    }
    for (const e of feed) {
      if (e.kind !== 'post' || (e.draftId && postIds.has(e.draftId)) || !e.at) continue;
      items.push({ key: `f-${e.id}`, draftId: null, at: e.at, kind: 'posted', label: snippet(e.body, 60) || 'Published post' });
    }
    return items;
  }, [posts, feed]);

  const upcoming = useMemo(
    () =>
      posts
        .filter((d) => d.status === 'scheduled' && d.scheduledFor)
        .sort((a, b) => new Date(a.scheduledFor) - new Date(b.scheduledFor)),
    [posts],
  );

  return html`<div className="page sc-page">
    <div className="page-header">
      <div>
        <h1>Schedule</h1>
        <p className="page-sub">Your posting calendar and what's already gone out.</p>
      </div>
      <div className="page-actions">
        <${Button} variant="primary" icon="edit" onClick=${() => navigate('/studio')}>Write a post<//>
      </div>
    </div>

    <div className="sc-note small">
      <${Icon} name="clock" size=${15} />
      <span>
        Scheduled posts publish while Lens is open in a tab (static site, no server).
        ${connected
          ? ' LinkedIn (demo) is connected, so due posts publish to the demo feed automatically.'
          : html` LinkedIn (demo) isn't connected — when a post is due, Lens will remind you to post it. <a href="#/connections">Connect</a>`}
      </span>
    </div>

    <${WeekCalendar} items=${calendarItems} now=${now} />

    <section className="sc-upcoming">
      <div className="row sc-section-head">
        <h2 className="sc-h2">Upcoming</h2>
        <${Badge} tone="accent">${upcoming.length}<//>
      </div>
      ${upcoming.length
        ? html`<ul className="card sc-up-list">
            ${upcoming.map((d) => html`<${UpcomingRow} key=${d.id} draft=${d} now=${now} connected=${connected} />`)}
          </ul>`
        : html`<div className="card">
            <${Empty}
              icon="calendar"
              title="Nothing scheduled"
              body="Write a post in Studio and pick a time — Tue 9:30, Wed 12:00 and Thu 8:00 tend to do well."
              action=${html`<${Button} variant="primary" icon="edit" onClick=${() => navigate('/studio')}>Open Studio<//>`}
            />
          </div>`}
    </section>

    <${PublishedFeed} feed=${feed} drafts=${drafts} profile=${profile} />
  </div>`;
}

# Lens — architecture contract

> **See also:** [V2_ONBOARDING.md](./V2_ONBOARDING.md) (start flow, swipe stack, analytics, chat page, settings) and [V3_VERCEL_YOUCOM.md](./V3_VERCEL_YOUCOM.md) (Vercel hosting, You.com as the AI provider via `/api/you`). Later docs override this one where they differ.

Lens helps a founder build a following and find users:
1. Founder enters product URL + target audience (onboarding).
2. You.com finds recent public conversations where people describe the problem.
3. Founder reviews ranked threads, quotes and source links.
4. Branch A: draft a contextual reply or DM → approve/edit → send via LinkedIn MCP (or copy + open source link).
5. Branch B: turn a recurring pain point into a post → attach a Canva/Figma visual with an optional Sculptex 3D render → preview → schedule.
Plus: "Trending in your field" + "Founder events this week" on the dashboard, a sidebar, a floating Chat button (Claude, grounded in the app state).

## Hard constraints
- **No databases, no accounts, no backend.** All app data lives in the browser (localStorage `lens_state_v1`).
- **LinkedIn is MOCKED.** There is no real LinkedIn integration. "Connect LinkedIn" simulates an OAuth-style connect (short delay) and yields a fake profile from demo-data (`demo.linkedinProfile` = founder name/headline/avatar initials for the demo company). Sending a reply/DM or publishing a post "to LinkedIn" appends it to `state.linkedinFeed` (a mock feed shown in Schedule → 'Published' and as a LinkedIn-style card) and sets status sent/posted. Label it clearly in the UI as "LinkedIn (demo)". No real network calls for LinkedIn.
- **Sculptex is REAL** — a genuine MCP server (`https://sculptex-git-main-jacksonschorr.vercel.app/mcp`, OAuth required, CORS `*`). mcp.js is only used for Sculptex.
- **MCP connections are temporary.** Connection state for Sculptex (tokens, session id, tool list, status) lives ONLY in `sessionStorage` key `lens_mcp_v1` — never localStorage. Closing the tab forgets it; the user reconnects next time. store.js must exclude `connections` from the localStorage persist and instead persist it to sessionStorage. The mock LinkedIn connection is also session-only, for consistency.
- **Static site for GitHub Pages.** No build step, no Node, no server. Plain ES modules loaded by the browser. Every path is RELATIVE (`./js/app.js`, never `/js/app.js`) because Pages serves under `/<repo>/`.
- React via esm.sh, JSX-free with `htm`. Only import third-party code through `js/lib.js`:
  ```js
  // js/lib.js
  import React from 'https://esm.sh/react@18.3.1';
  import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client';
  import htm from 'https://esm.sh/htm@3.1.1';
  export const html = htm.bind(React.createElement);
  export const { useState, useEffect, useMemo, useRef, useCallback, Fragment } = React;
  export { React, createRoot };
  ```
  Views do `import { html, useState } from '../lib.js'`. Always use `className=` (not `class=`). Event handlers `onClick=${fn}`.
- Keys are bring-your-own, stored in localStorage only, never sent anywhere except the vendor's own API.
- **Everything must work with no keys** ("demo mode") using `js/demo-data.js`. When a key exists, call the real API; on any failure, fall back to demo data and show a non-blocking toast with the error.
- Nothing is ever posted/sent without an explicit user click on an approval button. Show a preview first.
- Today's date comes from `new Date()` at runtime. Demo dates are computed relative to now (never hard-coded calendar dates).

## File map (owner in brackets)
```
index.html                     [core]   links ALL css files below, mounts #root, loads ./js/app.js as module
404.html                       [core]   copy of index.html (Pages SPA fallback) — hash routing means it's mostly cosmetic
.nojekyll                      [core]   empty
css/base.css                   [core]   tokens, light/dark, layout shell, sidebar, components vocabulary below
css/views-a.css                [views-a] styles for setup/dashboard/discover
css/views-b.css                [views-b] styles for outreach/studio/schedule
css/views-c.css                [views-c] styles for connections/chat drawer
js/lib.js                      [core]
js/store.js                    [core]
js/router.js                   [core]
js/app.js                      [core]   shell: Sidebar + Topbar + current view + ChatButton/ChatDrawer + Toasts
js/ui.js                       [core]   shared components (see below)
js/demo-data.js                [data]
js/services/youcom.js          [services]
js/services/claude.js          [services]
js/services/mcp.js             [services]
js/services/lens.js            [services] high-level actions used by views (the ONLY thing views call for data)
js/views/setup.js              [views-a]  #/setup     onboarding: product URL, audience, field, keywords
js/views/dashboard.js          [views-a]  #/          trending in field + events this week + pipeline stats
js/views/discover.js           [views-a]  #/discover  ranked threads, quotes, source links, filters
js/views/outreach.js           [views-b]  #/outreach  approval queue for replies/DMs (edit, approve, send, reject)
js/views/studio.js             [views-b]  #/studio    post composer: pain point → post, visual, Sculptex render, preview
js/views/schedule.js           [views-b]  #/schedule  week calendar + list of scheduled/posted posts
js/views/connections.js        [views-c]  #/connections  LinkedIn MCP, Sculptex MCP, You.com key, Claude key, demo toggle
js/views/chat.js               [views-c]  exports ChatDrawer (rendered by app.js, not a route)
README.md                      [core]
```

## js/store.js API
```js
export function getState()                 // current state object (treat as immutable)
export function setState(patchOrFn)        // shallow-merge patch, or fn(state)=>patch; persists to localStorage 'lens_state_v1'; notifies
export function subscribe(fn)              // returns unsubscribe
export function useStore(selector = s=>s)  // React hook, re-renders on change
export function uid(prefix='id')           // short unique id
export function toast(message, kind='info')// kind: info|success|error ; pushes into state.toasts, auto-removed after 5s
export function resetState()               // back to defaults (keeps settings keys)
```
State shape (defaults built from demo-data on first load):
```js
{
  onboarded: false,
  company: { name, url, tagline, description, audience, field, keywords: [], competitors: [], voice },
  settings: { youKey: '', claudeKey: '', claudeModel: 'claude-sonnet-5-5', demoMode: true },
  connections: {            // persisted to sessionStorage 'lens_mcp_v1' ONLY (temporary)
    linkedin: { status: 'disconnected'|'connecting'|'connected', profile: null },   // MOCK
    sculptex: { url: 'https://sculptex-git-main-jacksonschorr.vercel.app/mcp', status: 'disconnected'|'connecting'|'connected'|'error', tools: [], auth: null, sessionId: null, error: '' },
  },
  linkedinFeed: [{ id, draftId, kind: 'post'|'reply'|'dm', body, visual?, to?: string /*thread author for dm/reply*/, threadUrl?, at: iso, reactions: number, comments: number }], // mock LinkedIn activity
  threads: [Thread], trends: [Trend], events: [Event], drafts: [Draft],
  chat: [{ role: 'user'|'assistant', content: string, at: iso }],
  ui: { chatOpen: false, lastRefresh: iso|null, loading: {} },   // loading: { threads: true, ... }
  toasts: [{ id, message, kind }],
}
Thread = { id, source: 'reddit'|'hackernews'|'x'|'linkedin'|'indiehackers'|'producthunt'|'web', community, title, url, author,
           snippet, quote, publishedAt: iso, relevance: 0-100, painPoint: string, intent: 'high'|'medium'|'low',
           engagement: { replies, upvotes }, status: 'new'|'saved'|'dismissed'|'drafted'|'contacted' }
Trend  = { id, title, summary, url, source, publishedAt, tag }
Event  = { id, title, start: iso, end: iso, location, format: 'in-person'|'virtual', url, host, why }
Draft  = { id, kind: 'reply'|'dm'|'post', threadId?: string, body: string, title?: string,
           status: 'pending'|'approved'|'scheduled'|'posted'|'sent'|'rejected', createdAt, updatedAt,
           scheduledFor?: iso, postedAt?: iso, channel: 'linkedin'|'copy',
           visual?: { type: 'upload'|'canva'|'figma'|'sculptex', src?: string /*dataURL or image url*/, link?: string, caption?: string, renderUrl?: string },
           painPoint?: string, error?: string }
```
Persist everything except `toasts`, `ui.loading` and `connections` (connections → sessionStorage). Data URLs from uploads can be large — catch QuotaExceededError and toast.

## js/router.js
Hash routing: `useRoute()` returns `{ path, params }` where path is e.g. `'/'`, `'/discover'`, `'/studio'`; query after `?` in the hash parsed into params (e.g. `#/studio?thread=t1`). `navigate(path)` sets location.hash. Unknown → '/'. If `!state.onboarded` and path !== '/setup' and path !== '/connections', redirect to '/setup'.

## js/ui.js shared components (all use base.css classes)
`Button({variant:'primary'|'secondary'|'ghost'|'danger', size:'sm'|'md', icon, onClick, disabled, loading, children, title})`,
`Card({title, subtitle, actions, children, className})`, `Badge({tone:'neutral'|'accent'|'success'|'warning'|'danger'|'info', children})`,
`SourceIcon({source})` (small colored glyph/label per source), `Empty({icon, title, body, action})`, `Spinner()`,
`Modal({open, title, onClose, children, footer, wide})`, `Tabs({tabs:[{id,label,count}], value, onChange})`,
`Field({label, hint, children})`, `TextArea`, `Input`, `Select` (thin wrappers passing props),
`timeAgo(iso)`, `fmtDate(iso, opts)`, `Icon({name, size})` — inline SVG icon set (stroke icons, 1.75 stroke) with at least:
home, search, inbox, edit, calendar, plug, chat, send, check, x, external, sparkles, image, cube, clock, trending, users, settings, refresh, copy, trash, plus, arrowRight, linkedin, link, chevronLeft, chevronRight, upload, filter, bolt, eye.

## css/base.css vocabulary (views use these; view-specific CSS goes in css/views-<a|b|c>.css)
Tokens on `:root` (light) + `@media (prefers-color-scheme: dark)` + `[data-theme=dark]`:
`--bg --surface --surface-2 --border --text --text-2 --text-3 --accent --accent-2 --accent-soft --success --warning --danger --info --radius --radius-sm --shadow --font --mono`.
Layout: `.app` (grid: sidebar + main), `.sidebar`, `.sidebar .nav-item(.active)`, `.main`, `.topbar`, `.page`, `.page-header` (h1 + `.page-sub` + `.page-actions`), `.grid-2 .grid-3`, `.stack` (vertical gap), `.row` (horizontal, center, gap), `.spacer`, `.muted`, `.small`, `.truncate`.
Components: `.card .card-header .card-title .card-sub .card-body .card-actions`, `.btn .btn-primary .btn-secondary .btn-ghost .btn-danger .btn-sm`, `.badge .badge-<tone>`, `.input .textarea .select .field .field-label .field-hint`, `.tabs .tab(.active)`, `.modal-backdrop .modal .modal-wide .modal-header .modal-body .modal-footer`, `.empty`, `.spinner`, `.toast-stack .toast .toast-<kind>`, `.chat-fab`, `.chat-drawer(.open)`, `.quote` (blockquote style for user quotes), `.kbd`, `.divider`, `.pill`.
Responsive: at <860px the sidebar collapses to a bottom tab bar; content has 16px side gutter; no horizontal scroll.
Visual direction: calm, editorial, founder-tool. Off-white bg, white cards, 1px borders, a single accent (deep indigo `#4F46E5`-ish) plus a warm secondary (`#F97316`) for "hot" signals. Inter from Google Fonts (link in index.html). Generous whitespace, 14px base font, 12px radius.

## js/services/lens.js (views call ONLY these; each returns data AND writes it into the store)
```js
export async function refreshAll()                       // trends + events + threads in parallel
export async function findConversations({ query } = {})  // You.com search → rank/score with Claude (or heuristic) → state.threads (merge by url, keep statuses)
export async function loadTrends()                       // You.com news for company.field → summarize → state.trends
export async function loadEvents()                       // You.com search "founder events this week <field> <location?>" → Claude extracts structured events → state.events
export async function draftOutreach(threadId, kind)      // kind 'reply'|'dm' → Claude drafts contextual, non-spammy message → new Draft (pending) → returns draft
export async function draftPost({ painPoint, threadIds = [], angle }) // → Draft kind 'post' pending
export async function rewrite(draftId, instruction)      // Claude edits body per instruction
export async function clusterPainPoints()                // → [{ painPoint, count, threadIds, example }] from threads (heuristic or Claude)
export async function sendDraft(draftId)                 // MOCK LinkedIn: if linkedin connected → append to state.linkedinFeed, status sent/posted ; else copy-to-clipboard + open thread url (status sent)
export async function connectLinkedIn() / disconnectLinkedIn()   // mock connect w/ 800ms delay, profile from demo-data
export async function scheduleDraft(draftId, iso)        // status 'scheduled'
export function runDueSchedules()                        // called every 30s by app.js; due scheduled posts → sendDraft if (mock) LinkedIn connected, else toast "due — post now"
export async function renderWithSculptex({ prompt })     // via Sculptex MCP tool (picked by name/schema); returns { renderUrl?, modelUrl?, raw } ; demo: returns bundled svg placeholder render
export async function analyzeProduct(url)                // You.com fetch/search on URL + Claude → { tagline, description, field, keywords, competitors, audience? }
export async function chat(message)                      // Claude with system prompt containing company + top threads + trends + events + drafts summary; appends to state.chat
```
Demo-mode behavior: every function returns plausible results from demo-data (with a 400–900ms simulated delay), with drafts generated from templates that reference the actual thread text.

## js/services/youcom.js
Wrap the You.com Search API (check current docs at https://documentation.you.com — base `https://ydc-index.io` / `https://api.ydc-index.io`, header `X-API-Key`). Functions: `search(query, { count, freshness, siteFilters })` → normalized `[{ title, url, snippet, publishedAt, source }]`; `news(query, opts)`; `contents(urls)` if available. Detect `source` from hostname (reddit.com→reddit, news.ycombinator.com→hackernews, x.com/twitter.com→x, linkedin.com→linkedin, indiehackers.com→indiehackers, producthunt.com→producthunt). Throw `Error` with readable message on non-2xx (CORS failures surface as TypeError — rethrow with "You.com blocked the browser request (CORS)…").

## js/services/claude.js
Direct browser call to `https://api.anthropic.com/v1/messages` with headers `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true`, `content-type`. `complete({ system, messages, maxTokens=1200, model })` → text. `json({ system, prompt, schemaHint })` → parsed JSON (extract first {...} or [...] block, retry once on parse failure).

## js/services/mcp.js — browser MCP client (Streamable HTTP + OAuth 2.1 PKCE)
```js
export async function connect(key)          // key: 'sculptex' (only real MCP); reads state.connections[key].url
export async function listTools(key)
export async function callTool(key, name, args)   // returns MCP result {content:[...]}
export function pickTool(key, intents)       // intents e.g. ['create_post','share','post'] → best tool by name/description match or null
export async function handleOAuthCallback() // called by app.js on load if location.search has ?code=&state=
export function disconnect(key)
```
Flow: POST JSON-RPC `initialize` (protocolVersion '2025-06-18') with `Accept: application/json, text/event-stream`; handle both JSON and SSE responses; keep `Mcp-Session-Id`; send `notifications/initialized`. On 401: read `WWW-Authenticate` resource_metadata (or fall back to `<origin>/.well-known/oauth-protected-resource`) → authorization server metadata (`/.well-known/oauth-authorization-server`, fallback `openid-configuration`) → dynamic client registration (`registration_endpoint`, client_name "Lens", redirect_uri = `location.origin + location.pathname`, token_endpoint_auth_method 'none') → PKCE S256 → redirect. Persist pending {key, verifier, clientId, tokenEndpoint, redirectUri, resource} in sessionStorage keyed by `state`. Callback exchanges code → tokens, stores in `connections[key].auth` (sessionStorage only, via store) {accessToken, refreshToken, expiresAt, clientId, tokenEndpoint}, strips query from URL (history.replaceState), resumes connect. Refresh token on 401 once. Also allow a manual "paste access token" fallback (auth = {accessToken}).

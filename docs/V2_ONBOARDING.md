# Lens v2 — onboarding, swipe stack, analytics, chat page, settings

Extends docs/ARCHITECTURE.md (still binding for everything not changed here).

> **Update (Canva MCP):** the mock "pick Canva or Figma" design tool is gone. Figma is removed entirely. Canva is a **real MCP connection** to `https://mcp.canva.com/mcp` (OAuth sign-in, no API key, session-only in `connections.canva`), handled by the same `mcp.js` client as Sculptex. `connections.design`, `connectDesignTool` and `disconnectDesignTool` no longer exist; use `connectCanva()` / `disconnectCanva()` and the `canva*` functions in `lens.js`. The text below is updated accordingly.

## New start flow (first-run, `state.onboarded === false`)
Route `#/start`. Step persisted in `state.onboarding = { step, url, transcript: [], profileDraft: {} }` so an OAuth redirect mid-onboarding resumes at the same step.
Steps:
1. **url** — full-screen, centered, minimal: Lens wordmark, one big input "Paste your product URL", subtle hint "e.g. sculptex-git-main-jacksonschorr.vercel.app", Enter/arrow button. Link "Try with Sculptex" fills the demo URL. Normalize URL (add https://).
2. **scanning** — the special loading page. Two large overlapping circles styled as **glass lenses** (radial gradients, inner shadow, glare highlight arc, thin rim, `backdrop-filter: blur()` + slight magnification). Continuously floating through/behind them, drifting left→right at different speeds/depths: URL chips (the user's URL, reddit.com/r/3Dprinting, news.ycombinator.com, x.com, linkedin.com, indiehackers.com, producthunt.com…), small source glyphs, quote fragments, sparkles/dots. Items passing behind a lens appear magnified + sharper (implement by rendering the floating layer twice: once blurred/dim outside, once inside each lens circle with `clip-path: circle()` and `transform: scale(1.25)`). Gentle lens bob/rotation of the glare. Status line below cycles ("Reading <host>…", "Understanding what you build…", "Listening to communities…", "Spotting pain points…"). Respects `prefers-reduced-motion`. Runs `analyzeProduct(url)` and `findConversations()` in parallel, minimum 4.5 s on screen, then advances to **audience**.
3. **audience** — full-page chat with the Lens AI about the target audience. AI opens with what it learned from the URL (tagline, field) and asks who it's for. Uses `onboardingChat(message)` (below). Shows a live "Audience profile" side card filling in (audience, pains, where they hang out, keywords, voice) as the conversation progresses. When the AI returns `ready: true`, it says so, shows a "Looks right →" button and **auto-advances after 4 s** unless the user keeps typing. "Skip" link uses defaults.
4. **connect** — "Connect your tools". **Canva** (REAL MCP, "Real Canva account · this tab only"; Connect → `connectCanva()`, may OAuth-redirect to Canva; on return the start flow resumes at this step; stored session-only in `connections.canva`). Plus **Sculptex** (REAL MCP; Connect button → `mcp.connect('sculptex')`, may OAuth-redirect; on return the start flow resumes at this step). Plus **LinkedIn (demo)** mock connect. Continue enabled always (connections optional), label "Continue" / "Skip for now".
5. **swipe** — "Your first posts". Calls `generateSuggestions()` once, then shows the **swipe stack** component (below). When the stack is empty (or "Finish"), set `onboarded: true`, `company` from profileDraft, navigate to `#/`.

Router: if `!onboarded` and path not in ['/start','/settings'] → `/start`. `/setup` and `/connections` now redirect to `/settings`.

## Swipe stack (route `#/stack`, also used in onboarding step 5) — `js/views/stack.js` exports default page AND named `SwipeStack`
- Cards = drafts with `kind:'post'` and `status:'pending'`, newest first. Card: mock LinkedIn post preview (profile, body truncated with see-more, visual if any), the source ("From pain point: Exact dimensions & tolerances · 4 threads" or "From trend"/"From your idea"), suggested visual concept line + Sculptex prompt if present.
- Gestures: pointer drag (mouse + touch) with rotation proportional to x, green "APPROVE" / red "DECLINE" stamps fading in, release past threshold (≈ 30% width or velocity) flies the card off; otherwise springs back. Buttons under the stack: ✕ Decline, ✎ Edit, ✓ Approve; keyboard ←/→ and E.
- Approve → `approveSuggestion(id)` = status 'scheduled' at the next free best-time slot (Tue 9:30 / Wed 12:00 / Thu 8:00 / Mon 10:00 / Fri 11:00 local, skipping past times and slots already used) + toast with Undo. Decline → status 'rejected' + toast with Undo.
- Edit → modal: textarea body, rewrite chips (Shorter / Warmer / More specific / Add a question), visual section (Upload; Canva tab — generate with Canva AI from the draft's visualIdea or pick one of your designs, exported to PNG, or a Connect Canva button when not connected; "Render with Sculptex" using the card's sculptexPrompt), Save; "Open in Studio" link (`#/studio?draft=<id>`).
- Empty state: "You're all caught up" + "Generate more" (`generateSuggestions()`) + "Add your own idea" → `#/chat`.

## Chat page (route `#/chat`) — `js/views/ideas.js` default export
Full-page chat "Bring your own idea". User describes an idea; AI (`ideaChat(message)`) helps shape it and, when it has a post, returns it as a proposal card in the thread with buttons **Add to stack** (creates pending post draft with `source:{type:'idea'}` → toast → link "Review in stack") and **Refine**. Suggested starter prompts. Conversation stored in `state.ideaChat`. The floating chat button/drawer still exists for quick questions.

## Analytics (route `#/analytics`) — `js/views/analytics.js` default export
Data: `state.linkedinFeed` (mock published activity, seeded by demo-data with ~10 past posts over the last 5 weeks with impressions/reactions/comments/reposts/profileViews) + drafts + threads. All charts inline SVG, no libraries, themed with CSS tokens, accessible labels.
- KPI tiles (last 30 days vs prior): impressions, engagement rate, followers gained (mock), replies/DMs sent, conversations found.
- Impressions per week (bar chart, 8 weeks), engagement by pain point (horizontal bars), outreach funnel (found → drafted → approved → sent → replied(mock)), best posting times heatmap (weekday × time-of-day from feed), top posts table (body excerpt, date, impressions, engagement rate, link to studio).
- Range toggle 7d / 30d / 90d. Footer note: "LinkedIn metrics are simulated in demo mode."

## Settings (route `#/settings`) — `js/views/settings.js` default export
Tabs: **Connections** (renders the existing Connections page content; make `connections.js` export a named `ConnectionsPanel` used here; add the real Canva MCP card: server URL, status, Connect/Disconnect, tool list, paste-token fallback, session-only), **Product** (edit company profile: URL, tagline, description, audience, field, keywords, competitors, voice; "Re-run onboarding" button sets onboarded:false, onboarding.step:'url' and navigates to /start), **Data** (demo toggle, reset, export, clear — move from connections if present there).

## Sidebar (app.js)
Dashboard `/`, Stack `/stack` (badge: pending posts), Discover `/discover`, Outreach `/outreach` (badge), Studio `/studio`, Schedule `/schedule`, Analytics `/analytics`, Chat `/chat`, Settings `/settings`. The `/start` route renders WITHOUT the app shell (full-screen). Mobile bottom bar shows Dashboard, Stack, Discover, Chat, More(→ sheet with the rest).

## New lens.js functions
```js
export async function onboardingChat(message)   // appends to state.onboarding.transcript; returns { reply, ready, profile }
  // Claude: system prompt = company analysis + instruction to learn audience, pains, where they hang out, voice in ≤4 questions, one question at a time;
  // reply must be JSON {reply, ready, profile:{audience, pains:[], channels:[], keywords:[], voice}}; merge profile into state.onboarding.profileDraft.
  // Demo: scripted, uses the user's words; ready after the 3rd user message (or immediately if the user says 'skip'/'done').
export async function generateSuggestions({ count = 5 } = {}) // pending post drafts from clusterPainPoints() + trends; each draft gets source:{type:'pain'|'trend', label, threadIds}, visualIdea, sculptexPrompt
export function approveSuggestion(id)            // → scheduled at next free best-time slot; returns slot iso
export function declineSuggestion(id)
export function undoSuggestion(id, prevStatus)
export async function ideaChat(message)          // state.ideaChat; returns { reply, proposal?: { title, body, visualIdea, sculptexPrompt } }
export function addIdeaToStack(proposal)         // → pending post draft source:{type:'idea'}
export async function connectCanva() / disconnectCanva()   // REAL Canva MCP (OAuth, no API key), session-only
// plus canvaDesigns, canvaGetDesign, canvaGenerate, canvaCreateFromCandidate, canvaExportPng, canvaVisual, attachCanvaToDraft
```
State additions: `onboarding`, `ideaChat: []`, `connections.canva`, Draft gains `source`, `visualIdea`, `sculptexPrompt`, `metrics?`; linkedinFeed items gain `impressions, reposts, profileViews`.

# Lens

Lens helps a founder build a following and find their first users.

You paste your product URL. Lens reads it, asks who it's for, finds recent public conversations where people describe the problem you solve, and turns recurring pain points into LinkedIn posts you approve with a swipe. It also drafts careful replies and DMs for those conversations, and shows what's trending in your field and which founder events are on this week.

Lens has **no accounts and no database**. Your data lives in your browser. The only server code is one small stateless function that relays requests to You.com.

## The flow

1. **Start.** Paste your product URL. Lens scans it and listens to communities in parallel, while two glass lenses float over the sources.
2. **Audience chat.** A short chat with the Lens AI about who the product is for, what hurts and where those people hang out. A live audience profile fills in as you talk.
3. **Connect your tools (optional).** Connect your Canva account (for post graphics), Sculptex (for 3D renders) and LinkedIn (demo). You can skip all of them.
4. **Your first posts.** Lens drafts posts from the pain points it found and trends in your field. Swipe right to approve (it's scheduled at the next good posting slot) or left to decline. Press ✎ to edit.
5. **Every day after that:**
   - **Dashboard:** trending in your field, founder events this week and your pipeline.
   - **Stack:** the swipe stack of suggested posts.
   - **Discover:** ranked threads with quotes and source links.
   - **Outreach:** reply and DM drafts to edit, approve or reject.
   - **Studio:** write a post and attach a visual (upload, a Canva design you generate or pick, or a Sculptex render).
   - **Schedule:** the week ahead and what's been published.
   - **Analytics:** impressions, engagement, outreach funnel and best posting times.
   - **Chat:** bring your own idea and shape it into a post.
   - **Settings:** connections, your product profile and your data.

   The floating **Ask Lens** button opens a quick chat grounded in your threads, trends, events and drafts.

Nothing is ever sent or posted until you click an approval button, and you always see a preview first.

## Deploy on Vercel

Lens is static files plus one serverless function (`api/you.js`). There's no build step and no dependencies.

1. Push the repository to GitHub.
2. In the Vercel dashboard, choose **Add New… → Project** and import the repository.
3. Set **Framework Preset** to **Other**. Leave **Build Command**, **Output Directory** and **Install Command** empty, with no overrides.
4. Click **Deploy**. Vercel serves the files at the repo root and turns `api/you.js` into a function at `/api/you`.

Routing uses the URL hash (`#/discover`), so no rewrites are needed.

### Optional: a shared You.com key (`YOU_API_KEY`)

By default each visitor adds their own You.com key in **Settings → Connections**. To let visitors use live mode without a key, add an environment variable in **Project → Settings → Environment Variables**:

| Name | Value |
| --- | --- |
| `YOU_API_KEY` | your You.com API key |

Then redeploy. The Connections page shows **Using shared key** to visitors who haven't added their own.

> **Cost and abuse caveat:** with `YOU_API_KEY` set, anyone who can open your deployment can spend your You.com quota through `/api/you`. The relay only allows the `search`, `extract` and `agent` operations and caps request size, but it has no accounts or rate limiting. Use a key with a spending limit, keep the deployment URL private (or turn on Vercel Deployment Protection), and remove the variable when you no longer need it. A visitor's own key always takes precedence over the shared one.

## Local development

You need Python 3.9 or later. Node isn't required.

```sh
cd Lens
python3 dev/serve.py
# open http://localhost:8000
```

`dev/serve.py` serves the static files and emulates `/api/you` by forwarding requests to You.com, so live mode works locally. To use a shared key locally, set `YOU_API_KEY` in your shell first. Otherwise add your key in Settings.

With any plain static server (for example `python3 -m http.server`), Lens runs in demo mode only: there's no `/api/you` relay, so Lens shows a notice and uses demo data. Opening `index.html` from `file://` won't work, because browsers block ES module imports from `file://` URLs.

## Demo mode, keys and AI provider

Lens works fully in **demo mode** with bundled sample data, so you don't need any keys to try it. Turn demo mode off in **Settings → Data**, or press **Go live** on the You.com card.

| Service | Used for | Where the key goes |
| --- | --- | --- |
| **You.com** (default AI provider) | Search for conversations, trends and events. You.com Agents for drafting, ranking and chat. | Stored in your browser's `localStorage`. Sent with each request to this site's `/api/you` relay, which forwards it to You.com. The relay stores nothing and logs no keys or request bodies. |
| **Claude** (optional) | Drafting, ranking and chat instead of You.com Agents, if you switch the provider in Settings. | Stored in `localStorage`. Sent only to `api.anthropic.com`, straight from your browser. |

If a live call fails, Lens falls back to demo data and shows a non-blocking notice.

## Integrations

| Integration | Status | What happens |
| --- | --- | --- |
| **You.com** | Live | Search, extract and Agents through the `/api/you` relay. |
| **Claude** | Optional | Direct browser calls to the Anthropic API with your key. |
| **Sculptex MCP** | Live | A live MCP server (`https://sculptex-git-main-jacksonschorr.vercel.app/mcp`). Lens connects from the browser over MCP Streamable HTTP with OAuth 2.1 + PKCE (or a pasted access token) and calls its tools to render 3D visuals. |
| **LinkedIn** | Demo, labeled "LinkedIn (demo)" | Connecting simulates a sign-in with a sample profile. Sending or publishing adds the item to a local mock feed and marks the draft sent or posted. No request ever goes to LinkedIn. Analytics numbers are simulated. |
| **Canva MCP** | Live | Canva's official MCP server (`https://mcp.canva.com/mcp`). No API key: Connect sends you to Canva to sign in (OAuth 2.1 + PKCE with dynamic client registration), then back to Lens. In Studio and the swipe-stack editor you can generate a graphic with Canva AI (pick one of its candidates) or pick one of your own designs; Lens exports it as a PNG and attaches it to the post, with an "Open in Canva" link. Canva image links expire after a while, so use "Refresh image" before posting an older draft. |

Figma is no longer supported. Canva is the only design tool.

### Connections are session-only

Connection state (Sculptex and Canva tokens, MCP sessions and tool lists, and the mock LinkedIn connection) is kept **only in `sessionStorage`** under `lens_mcp_v1`. It's never written to `localStorage`. Close the tab and you reconnect next time. If Sculptex or Canva sign-in redirects you away during onboarding, Lens brings you back to the same step.

## Privacy

- **No accounts, no database, no analytics, no tracking.**
- **App data** (company profile, onboarding progress, threads, drafts, schedule, chats and the mock LinkedIn feed) is stored in your browser's `localStorage` under `lens_state_v1`. Clear it in **Settings → Data**: export, reset to demo data, or clear everything.
- **Connections** live in `sessionStorage` (`lens_mcp_v1`) and are gone when the tab closes.
- **The `/api/you` relay** is stateless. It forwards an allow-listed operation to You.com, returns the response and doesn't store or log your key, queries or results.
- **Network calls** go only to:
  - esm.sh, to load React and htm
  - Google Fonts, to load Inter
  - this site's `/api/you` relay, which forwards to You.com
  - the services you connect yourself: Anthropic (Claude), Sculptex and Canva (`mcp.canva.com`, plus Canva's image links for exported designs)
- Uploaded images are stored as data URLs in `localStorage`. Very large images may exceed the browser's storage quota, and Lens warns you if that happens.

## Project layout

```
index.html, 404.html          app shell (404.html is a copy of index.html)
api/you.js                    Vercel function: stateless You.com relay (search | extract | agent | status)
dev/serve.py                  local static server + /api/you emulation (Python stdlib)
css/base.css                  design tokens (light + dark), shell, shared components, settings
css/views-*.css               view-specific styles
js/lib.js                     React + htm (the only third-party entry point)
js/store.js                   app state (localStorage) + connections (sessionStorage)
js/router.js                  hash routing, old-route redirects, onboarding gate
js/ui.js                      shared components + icon set
js/app.js                     boot, OAuth callback, shell (sidebar / mobile bar + More sheet), chat drawer, toasts
js/demo-data.js               demo data (dates relative to today)
js/services/ai.js             AI provider switch: You.com Agents (default) or Claude
js/services/youcom.js         You.com search/extract via the relay
js/services/claude.js         optional Claude client
js/services/mcp.js            browser MCP client (Sculptex, Canva)
js/services/lens.js           high-level Lens actions used by the views
js/views/start.js             first-run flow (#/start)
js/views/stack.js             swipe stack (#/stack)
js/views/canva.js             shared Canva picker (generate with Canva AI / your designs) for Studio and the stack editor
js/views/*.js                 dashboard, discover, outreach, studio, schedule, analytics, ideas (chat), settings, connections
docs/                         architecture contract + v2/v3 specs
```

# Lens

Lens is a founder studio for LinkedIn. You give it your company URL. It reads your site, asks a few questions about your brand, then listens to public conversations about your product, your competitors and the problem you solve. From the pain points it hears, it fills a swipe stack with LinkedIn post drafts, replies to public threads and DMs to people who described the problem. Approved posts go on a calendar and publish to LinkedIn at a good Eastern Time slot.

Lens is plain browser JavaScript with no build step, no npm dependencies, no accounts and no database. The only server code is a few small Vercel functions in `api/`.

Web search and page reading use You.com (`api/you.js`). Every AI call (site summary, onboarding, listening summary, posts, replies, DMs, revisions, chat) goes through OpenRouter (`api/ai.js`).

## The flow

1. **Company URL.** Lens reads your site while the glass-lens animation plays, then opens the onboarding chat.
2. **Onboarding chat.** Lens's AI agent confirms what your company does and asks about your audience, goal, posting cadence (1 to 14 posts a week) and voice, one question at a time. At the end you connect LinkedIn (required, since Lens posts there) and optionally Sculptex for 3D visuals.
3. **Listening.** Right after onboarding, and whenever the stack refills (**Generate more**, or when the last check is more than 12 hours old), Lens runs several You.com searches over the past month: your product and brand name, your competitors, and the problem you solve. It looks in communities (Reddit, Hacker News, X, LinkedIn, Indie Hackers, Product Hunt) and the open web. The AI turns what it finds into **pain points** (a label, a one-line detail, a rough count and short quotes with links) and keeps the best public threads. Settings → Brand memory shows the top pain points under **What people are saying**, each with a source link. The stack shows "Listening to conversations…" and then "Drafting posts…" while this runs.
4. **Stack.** Every refill is written from those pain points (plus fresh news in your field). Your cadence is posts per week, and each refill offers **two post options for each weekly post** (3 posts a week → 6 post options), **3 comment replies** and **2 DMs**, mixed together: post, post, reply, post, DM, post, reply… Kinds with nothing to work from are skipped (no threads found → no replies).
   - Posts: swipe right or press the check to approve and schedule. Swipe left or press the X to decline. Use the pencil to edit or add a visual with Sculptex, and the chat bubble to ask Lens for a revision.
   - Comment replies: each card shows the platform and community, a quote of the comment or post being answered, and Lens's draft reply (short, helpful first, says you are the founder, no hard sell).
     - On a **LinkedIn** thread, press **Post reply** or swipe right and Lens posts the comment through the LinkedIn API. The notice links to it. If your LinkedIn session ended, the card asks you to reconnect in Settings.
     - On **other platforms** (Reddit, Hacker News, X…), press **Copy**, use **Open thread ↗** to post it yourself, then press **I sent this** or swipe right.
     - **I don’t like this** or swipe left asks Lens for a clearly different version, in place.
   - DMs: press **Copy**, send the message yourself on LinkedIn, then press **I sent this** or swipe right. Press **I don’t like this** or swipe left for a new version. Lens never sends DMs.
   - Sculptex visuals: when Sculptex is connected, Lens suggests a 3D render for posts where one fits (almost always for 3D, architecture, CAD, hardware, product, manufacturing, game or design companies) and renders them in the background, one at a time, at the lowest effort that still looks good (low, medium or high). The card shows the render while it works. If a render fails, the post simply stays without a visual.
5. **Chat.** Brainstorm a post with Lens and add the draft to your stack.
6. **Calendar.** Your week of scheduled posts. Drag a post to another day to move it to a suggested slot, or open it to edit, revise, or post now.
7. **Settings.** Connections, brand memory (with **What people are saying**), brand file download and upload (the file includes the pain points), logo download, and **Erase local data**.

## Data and connections

- Your brand, drafts, schedule, chats and the latest listening results (pain points and threads) live in your browser's `localStorage` (key `lens-v3`). **Erase local data** clears them and disconnects everything.
- Connections are session-only. Sculptex (an MCP server with OAuth) is kept in `sessionStorage`; it is the only visual provider. LinkedIn sign-in is kept in an HttpOnly session cookie that the browser drops when the session ends, so the LinkedIn token never reaches page scripts.
- **Scheduled posts send only while Lens is open.** There is no server-side scheduler. Lens checks every 30 seconds, and when you return to the tab, for scheduled posts that are due. If LinkedIn is not connected, due posts wait and send once you connect. With LinkedIn connected, **Post now** on a scheduled post sends it right away.

## Deploy on Vercel

1. Import this repository into Vercel. Set **Framework Preset** to **Other**, with no build command and the repository root as the output.
2. Add these environment variables:
   - `YOU_API_KEY`: your You.com API key (web search and page extraction).
   - `OPENROUTER_API_KEY`: your OpenRouter API key (all AI calls). Set a credit limit on this key in OpenRouter: `/api/ai` refuses other websites, but anyone can still call it with a script, and every call is billed to this key.
   - `OPENROUTER_MODEL` (optional): the OpenRouter model id. Defaults to `anthropic/claude-haiku-5.5` (cheap, fast, no free-tier daily cap). Free models like `google/gemma-4-31b-it:free` also work (with OpenRouter's free router as a fallback) but are rate-limited; `anthropic/claude-sonnet-5.5` writes better and costs more.
   - `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET`: from your LinkedIn developer app.
   - `LINKEDIN_FEED_SCOPE` (optional): set to `1` once the app has the Community Management API product, so replies to LinkedIn posts go through the API (see step 3).
3. In the LinkedIn developer portal, on your app:
   - Under **Auth**, add the redirect URL `https://<your-domain>/api/linkedin/callback`.
   - Under **Products**, add **Sign In with LinkedIn using OpenID Connect** and **Share on LinkedIn**.
   - To post comment replies through the API, also add the **Community Management API** product (LinkedIn may review the request; it can require its own app). Once it is approved, set `LINKEDIN_FEED_SCOPE=1` so Lens also asks for `w_member_social_feed`. Without it, reply cards on LinkedIn threads fall back to Copy and **I sent this**, like other platforms. Don't set the variable before the product is approved: LinkedIn refuses sign-in when Lens asks for a permission the app doesn't have.
4. Deploy, then open your domain.

## Run locally

```sh
YOU_API_KEY=... OPENROUTER_API_KEY=... python3 dev/serve.py   # http://127.0.0.1:8000
```

The local server serves the static files and relays `/api/you` (You.com) and `/api/ai` (OpenRouter, `OPENROUTER_MODEL` optional). LinkedIn sign-in and posting need the Vercel deployment.

## Files

- `index.html`, `css/app.css`, `js/app.js`: the interface.
- `js/services/`: the service layer (`lens.js` is the only module the interface imports).
- `api/`: Vercel functions for the You.com search relay (`you.js`), the OpenRouter AI relay (`ai.js`), and LinkedIn sign-in and posting.
- `assets/`: wordmark and app icon.
- `docs/`: the spec and the design reference.

### Starting over

Open `https://<your-domain>/?reset`: Lens asks you to confirm, then clears only its own data in that browser (brand, drafts, schedule, chats, connections) and returns to the URL screen. Settings → Erase local data does the same from inside the app.

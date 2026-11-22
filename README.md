# Lens

Lens is a founder studio for LinkedIn. You give it your company URL. It reads your site, asks a few questions about your brand, then fills a swipe stack with LinkedIn post drafts and DMs to people who have publicly described the problem you solve. Approved posts go on a calendar and publish to LinkedIn at a good Eastern Time slot.

Lens is plain browser JavaScript with no build step, no npm dependencies, no accounts and no database. The only server code is a few small Vercel functions in `api/`.

## The flow

1. **Company URL.** Lens reads your site while the glass-lens animation plays, then opens the onboarding chat.
2. **Onboarding chat.** A You.com AI agent confirms what your company does and asks about your audience, goal, posting cadence (1 to 14 posts a week) and voice, one question at a time. You can connect Canva, Sculptex and LinkedIn at the end.
3. **Stack.** Lens drafts posts grounded in fresh You.com search results about your field (trends, news, events) and mixes in DM drafts.
   - Posts: swipe right or press the check to approve and schedule. Swipe left or press the X to decline. Use the pencil to edit or add a visual with Canva or Sculptex, and the chat bubble to ask Lens for a revision.
   - DMs: press **Copy**, send the message yourself on LinkedIn, then press **I sent this** or swipe right. Press **I don’t like this** or swipe left for a new version. Lens never sends DMs.
4. **Chat.** Brainstorm a post with Lens and add the draft to your stack.
5. **Calendar.** Your week of scheduled posts. Drag a post to another day to move it to a suggested slot, or open it to edit, revise, or post now.
6. **Settings.** Connections, brand file download and upload, logo download, and **Erase local data**.

## Data and connections

- Your brand, drafts, schedule and chats live in your browser's `localStorage` (key `lens-v3`). **Erase local data** clears them and disconnects everything.
- Connections are session-only. Canva and Sculptex (MCP servers with OAuth) are kept in `sessionStorage`. LinkedIn sign-in is kept in an HttpOnly session cookie that the browser drops when the session ends, so the LinkedIn token never reaches page scripts.
- **Scheduled posts send only while Lens is open.** There is no server-side scheduler. Lens checks every 30 seconds, and when you return to the tab, for scheduled posts that are due. If LinkedIn is not connected, due posts wait and send once you connect. With LinkedIn connected, **Post now** on a scheduled post sends it right away.

## Deploy on Vercel

1. Import this repository into Vercel. Set **Framework Preset** to **Other**, with no build command and the repository root as the output.
2. Add these environment variables:
   - `YOU_API_KEY`: your You.com API key.
   - `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET`: from your LinkedIn developer app.
3. In the LinkedIn developer portal, on your app:
   - Under **Auth**, add the redirect URL `https://<your-domain>/api/linkedin/callback`.
   - Under **Products**, add **Sign In with LinkedIn using OpenID Connect** and **Share on LinkedIn**.
4. Deploy, then open your domain.

## Run locally

```sh
YOU_API_KEY=... python3 dev/serve.py   # http://127.0.0.1:8000
```

The local server serves the static files and relays `/api/you`. LinkedIn sign-in and posting need the Vercel deployment.

## Files

- `index.html`, `css/app.css`, `js/app.js`: the interface.
- `js/services/`: the service layer (`lens.js` is the only module the interface imports).
- `api/`: Vercel functions for the You.com relay and LinkedIn sign-in and posting.
- `assets/`: wordmark and app icon.
- `docs/`: the spec and the design reference.

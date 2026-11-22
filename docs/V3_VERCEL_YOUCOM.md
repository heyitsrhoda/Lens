# Lens v3 — hosted on Vercel, You.com is the AI provider

Supersedes the "GitHub Pages / no server" parts of ARCHITECTURE.md. Everything else stays.

## Hosting
- Lens is deployed on **Vercel** by connecting the GitHub repo `heyitsrhoda/Lens` to a Vercel project (the owner does this in the Vercel dashboard; we never use the Vercel MCP/CLI). Zero-config: static files at the repo root + Node serverless functions in `/api`. No build step, no package.json dependencies (Node 18+ global `fetch` only). A minimal `package.json` `{ "private": true, "type": "module" }` is fine; `vercel.json` only for headers/caching if needed.
- Still: no database, no accounts. App state in localStorage; MCP connections in sessionStorage.
- Hash routing stays (no rewrites needed). `.nojekyll`/`404.html` can stay (harmless) or go.
- Local dev without Node: `python3 dev/serve.py` serves the static files on :8000 AND emulates `/api/you/*` by forwarding to You.com (stdlib only, Python 3.9 compatible). Document in README.

## You.com relay — `api/you.js` (single function, stateless)
- `POST /api/you?op=search|agent|extract` with JSON body; forwards to You.com:
  - `search` → `POST https://ydc-index.io/v1/search` (header `X-API-Key`)
  - `extract` → `POST https://ydc-index.io/v1/extract`
  - `agent` → You.com Agents API (verify current endpoint/headers/body in the docs at https://documentation.you.com / https://you.com/docs — expected `POST https://api.you.com/v1/agents/runs`, `Authorization: Bearer <key>`, body `{ agent: 'express' | 'advanced' | <custom id>, input: string, stream: false }`; response has an `output` array whose items carry `text`/`content` and optional search results/citations). Implement against what the docs actually say.
- Key: the browser sends the user's key in header `x-you-key` (typed into Settings). If absent, fall back to `process.env.YOU_API_KEY` (owner-funded mode, documented in README with the cost/abuse caveat). If neither → 400 with a readable message.
- Never log keys or request bodies. Allow only the three ops; reject anything else (no open proxy). Body size limit ~64 KB. Pass through You.com status codes and error JSON. Timeout 55 s. Same-origin only — no CORS headers needed (the app and the API share the Vercel domain); answer OPTIONS with 204 anyway.
- Response: `{ ok: true, data }` or `{ ok: false, status, error }`.

## AI provider = You.com
- New `js/services/ai.js`: `complete({ system, prompt | messages, maxTokens })` → text and `json({ system, prompt, schemaHint })` → parsed JSON (same contract as claude.js). Provider chosen by `state.settings.aiProvider`: `'you'` (DEFAULT) uses the relay `op=agent` (fold system + conversation into one `input` string with clear sections, ask for JSON-only output where needed; strip code fences; retry once on parse failure); `'claude'` delegates to claude.js (optional; needs a Claude key).
- `js/services/youcom.js` calls the relay (`fetch('./api/you?op=search', …)` with `x-you-key`) instead of ydc-index.io directly. Remove the CORS-failure messaging; on network/HTTP errors surface readable messages. `hasKey()` → true if the user has a key OR the server reports env key available (`GET ./api/you?op=status` → `{ envKey: boolean }`, cached).
- `js/services/lens.js`: every Claude call goes through `ai.js`. Live mode = You.com key present (or env key) and demoMode off. Prefer You.com Agents for drafting/ranking/chat, Search for conversations/trends/events.
- Settings → Connections: the You.com card is the primary "AI provider" card (key, test search, test agent). Claude card becomes "Optional: use Claude instead" with provider toggle. Default `settings.aiProvider = 'you'`.
- If `location.protocol === 'file:'` or the relay returns 404 (e.g. plain static hosting), show a toast "Live mode needs the Vercel deployment (or `python3 dev/serve.py` locally)" and use demo data.

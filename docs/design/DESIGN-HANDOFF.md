# Lens Demo Handoff

Lens is a founder-focused social content demo. A founder adds a company URL, answers onboarding questions or skips to sample drafts, and reviews LinkedIn posts in a stack.

## Run the demo

- Open `Lens Demo.html` in a current browser. It contains the HTML, CSS, and JavaScript and has no build step or package dependencies.
- Run `node checks/demo-check.cjs` from this folder with Node.js 20 or newer for interaction-logic checks. These checks use an isolated model of the browser and cover the demo flows.
- The `assets/` folder contains the SVG wordmark, SVG icon, and transparent 1024 × 1024 PNG icon. The HTML embeds its header artwork and favicon. Settings can download the same SVG wordmark.

## Current behavior

- Setup starts with the URL field, a short glass-lens scan animation and a full-screen scripted onboarding chat. Its slim text box and separate Send button match the main chat. Valid answers populate brand memory. Skipping preserves answers entered so far and fills the rest with defaults.
- The stack supports swipe or click decisions, manual editing and scripted inline revisions. Approval adds a post to the local schedule.
- Chat drafts ideas and can add a proposal to the review stack. Analytics uses sample data and has post and date filters. Calendar arrow buttons switch weeks. Cards can move to a different day, with a suggested Eastern Time slot. Opening a calendar card allows copy, date and revision edits.
- Settings manages Canva, Sculptex and LinkedIn demo connection states, imports and exports brand JSON, and has one reset action. After confirmation, **Erase local data** clears Lens browser storage and returns to the URL entry screen.
- The scan, AI responses, connections, analytics and publishing are simulated. The project does not include a backend, credentials, OAuth or live posting.

## UI conventions

Preserve the charcoal theme, overlapping glass-lens mark, line icons, reduced-motion support and emoji-free interface. The HTML reflects the latest browser feedback. Keep scheduled posts date-first in the calendar and keep analytics filters non-modal.

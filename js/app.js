// Lens: founder studio UI. Plain browser module, rendered with innerHTML.
// Every interpolated value goes through esc(); links and images pass safeUrl()/safeImage() first.
// All data and integrations come from ./services/lens.js (see docs/SPEC.md for the contract).
import * as lens from './services/lens.js';

const STORAGE_KEY = 'lens-v3';
const BANNER_KEY = 'lens-v3-calendar-banner';
const VIEW_KEY = 'lens-v3-view';
const PROVIDERS = ['Sculptex', 'LinkedIn'];
const VISUAL_PROVIDERS = [['Sculptex', 'Render with Sculptex', 'Rendering with Sculptex…']];
const QUESTIONS = [
  ['product', 'What does your company do?'],
  ['audience', 'Who do you want to reach?'],
  ['goal', 'What do you want your posts to achieve?'],
  ['cadence', 'How often should Lens post? For example, 3 times a week.'],
  ['voice', 'How should your posts sound? You can also mention topics to avoid.']
];
const SLOTS = QUESTIONS.map(([key]) => key);
const CLOSING = 'I have enough to save your brand. Connect LinkedIn to continue (Lens posts there). Sculptex for 3D visuals is optional.';
const DM_REWRITE = 'The founder did not like this message. Write a clearly different version.';
const DM_HINT = 'Copy the message, send it on LinkedIn, then mark it sent. Swipe left for a new version.';
const POST_HINT = 'Swipe left to decline or right to approve and schedule.';
const DEFAULTS = {
  product: 'Here’s a look at what we’re working on.',
  audience: 'founders and early users',
  goal: 'Share our progress and get feedback.',
  cadence: 3,
  voice: 'Clear and conversational'
};
const INITIAL = {brand: null, onboarding: null, posts: [], journal: [], brainstorm: [], proposal: null, next: 1};
const SCAN_DELAY = 2650;
const SCAN_DELAY_REDUCED = 950;
const SCAN_TIMEOUT = 90000; // site extract + search on You.com, then one AI call (with a retry) on OpenRouter
const PUBLISH_INTERVAL = 30000;
const PUBLISH_RETRY = 5 * 60000;
const WORKSPACE_VIEWS = ['review', 'chat', 'calendar', 'settings', 'scheduled-post'];
const LINKEDIN_MAX = 3000; // LinkedIn's limit for headline + blank line + copy

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const next = {...structuredClone(INITIAL), ...(saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {})};
    for (const key of ['posts', 'journal', 'brainstorm']) if (!Array.isArray(next[key])) next[key] = [];
    if (next.onboarding && (typeof next.onboarding !== 'object' || !Array.isArray(next.onboarding.messages))) next.onboarding = null;
    if (next.onboarding && (!next.onboarding.answers || typeof next.onboarding.answers !== 'object')) next.onboarding.answers = {};
    const highest = Math.max(0, ...[...next.posts, ...next.journal].map(item => Number(item?.id) || 0));
    if (!Number.isInteger(next.next) || next.next <= highest) next.next = highest + 1;
    return next;
  } catch {return structuredClone(INITIAL);}
}

let state = loadState();
let view = state.onboarding ? 'onboard' : state.brand ? 'review' : 'entry';
let revising = false;
let revisionError = '';
let revisionBusy = false;
let selectedPostId = null;
let editing = false;
let drag = null;
let timer;
let decisionPending = false;
let calendarWeek;
let scheduleDragId = null;
let onboardBusy = false;
let chatBusy = false;
let generating = false;
let rewritingId = null;
let scheduledBusy = false;
let visualBusy = null;
let publishRunning = false;
let lastDueSignature = '';
let saveFailed = false;
let ready = Promise.resolve({}); // lens.init(), started in boot()
const connecting = new Set();
const connectionErrors = {};
const publishing = new Set();
const resetForms = new Set();

const main = document.querySelector('#main');
const header = document.querySelector('#header');
const notice = document.querySelector('#notice');
const nav = document.querySelector('#nav');
const settingsNav = document.querySelector('#settings-nav');
const ICONS = {
  chat: '<path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l1.6-3.2A7.5 7.5 0 1 1 20 11.5Z"/><path d="M9 11.5h6"/>',
  previous: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  next: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  calendar: '<rect x="4" y="6" width="16" height="14" rx="2"/><path d="M8 4v4m8-4v4M4 11h16m-12 4h2m4 0h2"/>',
  settings: '<path d="m10 3-.6 2.4-1.8 1L5.2 5.7 3.3 9l1.8 1.7v2.1L3.3 14.5l1.9 3.3 2.4-.7 1.8 1 .6 2.4h3.9l.6-2.4 1.8-1 2.4.7 1.9-3.3-1.8-1.7v-2.1L20.6 9l-1.9-3.3-2.4.7-1.8-1-.6-2.4z"/><circle cx="12" cy="11.8" r="3.1"/>',
  linkedin: '<path fill="currentColor" stroke="none" d="M4 8.8h3.6V20H4zm1.8-5.4a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2zM10 8.8h3.5v1.5a3.8 3.8 0 0 1 3.4-1.7c3 0 3.8 1.9 3.8 4.5V20h-3.6v-6.1c0-1.4-.3-2.3-1.6-2.3-1.4 0-1.9 1-1.9 2.3V20H10z"/>',
  edit: '<path d="m5 16-1 4 4-1L19 8l-3-3L5 16Zm8-8 3 3"/>',
  approve: '<path d="m5 12 4 4L19 6"/>',
  decline: '<path d="m7 7 10 10M17 7 7 17"/>',
  send: '<path d="M12 19V5m-5 5 5-5 5 5"/>',
  link: '<path d="M9 15l6-6m-7 4H7a3 3 0 0 1 0-6h4m2 4h4a3 3 0 0 1 0 6h-4"/>',
  layers: '<path d="m12 4 8 5-8 5-8-5 8-5Zm-8 9 8 5 8-5"/>',
  globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4a12 12 0 0 1 0 16 12 12 0 0 1 0-16Z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>'
};
const LENS_MARK = '<svg viewBox="0 0 39 32" aria-hidden="true"><use href="#lens-glass-mark"/></svg>';
const MINI_LOGO = `<span class="mini-logo" aria-label="Lens">${LENS_MARK}</span>`;

function icon(name) {
  return `<svg class="line-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}
nav.innerHTML = [['review', 'Stack', 'layers'], ['chat', 'Chat'], ['calendar', 'Calendar']].map(([id, label, glyph = id]) =>
  `<button class="icon ghost" data-action="${id}" aria-label="${label}" title="${label}">${icon(glyph)}</button>`).join('');
settingsNav.innerHTML = icon('settings');

// ---------------------------------------------------------------- helpers

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    saveFailed = false;
  } catch {
    saveFailed = true;
    notify('Browser storage is full or unavailable. Changes last until you close this tab.');
  }
}
function esc(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
}
function str(value, max = 3000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function safeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch {return '';}
}
function safeImage(value) {
  if (typeof value !== 'string') return '';
  const src = value.trim();
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(src)) return src;
  return safeUrl(src);
}
function hostOf(url) {
  try {return new URL(url).hostname.replace(/^www\./, '');}
  catch {return 'Source';}
}
function oneLine(text, max = 260) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : line;
}
function endSentence(text) {
  const line = String(text || '').trim();
  return !line || /[.!?…]$/.test(line) ? line : line + '.';
}
function errorText(error) {
  if (typeof error === 'string') return error;
  return str(error?.message, 400) || 'Something went wrong.';
}
function aiUnavailable(error) {
  const message = endSentence(errorText(error));
  return `${/^lens ai isn.t available/i.test(message) ? message : 'Lens AI isn’t available right now. ' + message} Try again in a moment.`;
}
function sleep(ms) {return new Promise(resolve => setTimeout(resolve, ms));}
function attempt(fn) {return Promise.resolve().then(fn);}
function reducedMotion() {return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);}
function getConnections() {
  try {return lens.connections() || {};}
  catch {return {};}
}
function isConnected(provider) {return Boolean(getConnections()[provider]?.connected);}
function chatHistory(messages, limit = 40) {
  return messages.filter(message => !message.error).slice(-limit).map(({role, text}) => ({role, text}));
}
function notify(message) {
  clearTimeout(timer);
  notice.textContent = message;
  notice.hidden = false;
  timer = setTimeout(() => {notice.hidden = true;}, 4700);
}
function bannerDismissed() {
  try {return localStorage.getItem(BANNER_KEY) === 'dismissed';}
  catch {return false;}
}
function rememberView() {
  try {sessionStorage.setItem(VIEW_KEY, JSON.stringify({view: view === 'scan' ? 'onboard' : view, postId: selectedPostId}));}
  catch {}
}
function forgetView() {
  try {sessionStorage.removeItem(VIEW_KEY);} catch {}
}
function postLength(title, copy) {return String(title || '').trim().length + 2 + String(copy || '').trim().length;}
function tooLongMessage(title, copy) {
  return `With its headline this post is ${postLength(title, copy)} characters. LinkedIn allows ${LINKEDIN_MAX}, so shorten it.`;
}
function takeRememberedView() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(VIEW_KEY) || 'null');
    sessionStorage.removeItem(VIEW_KEY);
    return saved && typeof saved === 'object' ? saved : null;
  } catch {return null;}
}

// Keep typed text, caret and focus when a background update re-renders the page.
function formKey(form) {return form.id + ':' + (form.dataset.keep || '');}
function keptFields(form) {
  return Array.from(form.elements).filter(el => el.name && !['hidden', 'file', 'submit', 'button'].includes(el.type) && el.tagName !== 'BUTTON');
}
function snapshotForms() {
  const values = new Map();
  for (const form of main.querySelectorAll('form[data-keep]')) {
    if (resetForms.has(form.id)) continue;
    for (const el of keptFields(form)) values.set(formKey(form) + '|' + el.name, el.value);
  }
  const active = document.activeElement;
  let focus = null;
  if (active && main.contains(active) && active.form?.hasAttribute('data-keep') && active.name && !resetForms.has(active.form.id)) {
    focus = {key: formKey(active.form) + '|' + active.name, start: active.selectionStart, end: active.selectionEnd};
  }
  return {values, focus};
}
function restoreForms({values, focus}) {
  for (const form of main.querySelectorAll('form[data-keep]')) {
    if (resetForms.has(form.id)) continue;
    for (const el of keptFields(form)) {
      const key = formKey(form) + '|' + el.name;
      if (values.has(key)) el.value = values.get(key);
      if (focus?.key === key && !el.disabled) {
        el.focus({preventScroll: true});
        try {if (focus.start !== null && focus.start !== undefined) el.setSelectionRange(focus.start, focus.end);} catch {}
      }
    }
  }
}

function go(next) {
  view = next;
  editing = false;
  revising = false;
  revisionError = '';
  drag = null;
  render(false);
  main.firstElementChild?.classList.add('screen-enter');
  (main.querySelector('h1') || main.querySelector('.chat-composer textarea'))?.focus({preventScroll: true});
}
// Re-render in place for background updates (connections, publishing, async results).
function refresh() {
  if (view === 'scan' || drag || decisionPending || scheduleDragId !== null) return;
  if (main.querySelector('dialog[open]')) return; // never pull an open confirmation out from under the founder
  render();
}
function heading(title, detail = '', back = true) {
  return `<div class="page-head">${back ? '<div><button class="btn ghost" data-action="review">← Back to posts</button></div>' : ''}<h1 tabindex="-1">${title}</h1>${detail ? `<p class="muted">${detail}</p>` : ''}</div>`;
}

// ---------------------------------------------------------------- pages

function entryPage() {
  return `<section class="entry-page"><form id="entry-form" class="entry-form" novalidate><label for="site">Your company URL</label><div class="url-bar"><span class="url-dot" aria-hidden="true"></span><input id="site" name="site" type="text" inputmode="url" autocomplete="url" placeholder="yourcompany.com" required><button class="icon round primary" type="submit" aria-label="Send URL">${icon('send')}</button></div><p class="entry-error" role="alert" id="entry-error"></p></form></section>`;
}
function scanPage() {
  const domain = esc(state.onboarding?.name);
  return `<section class="scan-page" aria-labelledby="scan-title">
    <div class="scan-stage" aria-hidden="true">
      <span class="scan-token behind" style="--x:15%;--y:61%;--delay:-.3s">/about</span>
      <span class="scan-token behind icon-token" style="--x:56%;--y:21%;--delay:-.9s">${icon('layers')}</span>
      <div class="scan-lenses"><div class="glass-lens"></div><div class="glass-lens second"></div></div>
      <span class="scan-token" style="--x:15%;--y:28%">${domain}</span>
      <span class="scan-token icon-token" style="--x:38%;--y:59%;--delay:-.6s">${icon('link')}</span>
      <span class="scan-token" style="--x:66%;--y:49%;--delay:-.2s">/product</span>
      <span class="scan-token" style="--x:53%;--y:73%;--delay:-1s">/blog</span>
      <span class="scan-token icon-token" style="--x:78%;--y:19%;--delay:-.5s">${icon('globe')}</span>
    </div>
    <div class="scan-status" role="status">
      <h1 id="scan-title" tabindex="-1">Looking at ${domain}</h1>
      <p class="muted" id="scan-detail">Reading your site to learn what you do.</p>
      <div class="scan-progress" aria-hidden="true"></div>
    </div>
  </section>`;
}
function chatTurn(role, content) {
  return `<div class="turn ${role === 'user' ? 'user' : 'agent'}">${role === 'user' ? '' : MINI_LOGO}<div class="bubble">${esc(content)}</div></div>`;
}
function failedTurn(text, retryAction) {
  const button = retryAction ? `<button class="btn failed-retry" type="button" data-action="${retryAction}">Try again</button>` : '';
  return `<div class="turn agent failed">${MINI_LOGO}<div class="bubble failed-bubble" role="alert"><strong>Message failed.</strong> ${esc(retryAction ? String(text).replace(/\s*Try again in a moment\.$/, '') : text)}${button ? `<div class="failed-actions">${button}</div>` : ''}</div></div>`;
}
function typingTurn() {
  return `<div class="turn agent typing">${MINI_LOGO}<div class="bubble typing-bubble" role="status" aria-label="Lens is typing"><span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span></div></div>`;
}
function chatComposer(id, placeholder, busy = false, keep = '') {
  return `<form id="${id}" class="chat-composer" data-keep="${esc(keep)}"><textarea rows="1" name="message" aria-label="Message" placeholder="${esc(placeholder)}" maxlength="1200" required></textarea><button class="icon primary" type="submit" aria-label="Send message" ${busy ? 'disabled aria-busy="true"' : ''}>${icon('send')}</button></form>`;
}
function chatWorkspace(label, logLabel, thread, footer) {
  return `<section class="chat-workspace" aria-label="${label}">
    <div class="thread" role="log" aria-label="${logLabel}">${thread}</div>
    <div class="chat-footer">${footer}</div></section>`;
}

function connectionRows() {
  const live = getConnections();
  return `<div class="connections">${PROVIDERS.map(provider => {
    const info = live[provider] || {};
    const connected = Boolean(info.connected);
    const busy = connecting.has(provider);
    const who = str(provider === 'LinkedIn' ? (info.name || info.account) : (info.account || info.name), 120);
    const status = busy ? (connected ? 'Disconnecting…' : 'Connecting…') : connected ? (who ? `Connected · ${who}` : 'Connected') : 'Disconnected';
    const error = connectionErrors[provider] || str(info.error, 300);
    const label = provider === 'LinkedIn' && !connected ? `${provider}<span class="required-star" aria-hidden="true">*</span><span class="visually-hidden"> (required)</span>` : provider;
    const button = `<button class="btn ${connected ? 'ghost' : 'primary'}" data-action="connection" data-provider="${provider}" ${busy ? 'disabled aria-busy="true"' : ''}>${connected ? 'Disconnect' : 'Connect'}</button>`;
    return `<div class="connection-wrap"><div class="connection"><div><strong>${label}</strong><small>${esc(status)}</small></div>
      <div class="connection-actions">${button}</div></div>${error ? `<small class="connection-error" role="alert">${esc(error)}</small>` : ''}</div>`;
  }).join('')}</div>`;
}
function onboardPage() {
  const setup = state.onboarding;
  const complete = Boolean(setup.complete);
  const lastIndex = setup.messages.length - 1;
  const messages = setup.messages.map((m, i) => m.error
    ? failedTurn(m.text, i === lastIndex && !onboardBusy ? 'retry-onboard' : '')
    : chatTurn(m.role, m.text)).join('');
  const thread = messages + (onboardBusy ? typingTurn() : '') + (complete ? connectionRows() : '');
  const footer = complete
    ? (getConnections().LinkedIn?.connected
      ? '<div class="onboard-actions"><button class="btn primary" data-action="finish-onboard">Save brand &amp; open posts →</button></div>'
      : '<div class="onboard-actions"><small class="muted onboard-required">Connect LinkedIn to continue.</small><button class="btn primary" data-action="finish-onboard" disabled>Save brand &amp; open posts →</button></div>')
    : chatComposer('onboard-form', 'Reply to Lens', onboardBusy, 'onboard');
  return chatWorkspace('Onboarding', 'Onboarding conversation', thread, footer);
}

function visualBlock(post) {
  const pending = visualBusy && visualBusy.id === post.id ? VISUAL_PROVIDERS.find(([name]) => name === visualBusy.provider) : null;
  if (pending) return `<div class="post-visual" role="status"><strong>${esc(pending[2])}</strong><div class="visual-orb" aria-hidden="true"></div></div>`;
  const src = safeImage(post.visual?.src);
  if (!src) return '';
  const link = safeUrl(post.visual.link);
  const provider = PROVIDERS.includes(post.visual.provider) ? post.visual.provider : '';
  return `<div class="post-visual has-image"><img src="${esc(src)}" alt="${esc('Visual for ' + post.title)}" loading="lazy" decoding="async"></div>${link ? `<a class="visual-link" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${provider ? 'Open in ' + esc(provider) : 'Open visual'} ↗</a>` : ''}`;
}
function visualEditor(post) {
  const live = getConnections();
  const buttons = VISUAL_PROVIDERS.filter(([provider]) => live[provider]?.connected).map(([provider, label]) =>
    `<button class="btn" type="button" data-action="create-visual" data-provider="${provider}" data-post-id="${esc(post.id)}" ${visualBusy ? 'disabled' : ''}>${visualBusy?.provider === provider && visualBusy.id === post.id ? 'Working…' : label}</button>`);
  if (safeImage(post.visual?.src)) buttons.push(`<button class="btn ghost" type="button" data-action="remove-visual" data-post-id="${esc(post.id)}" ${visualBusy ? 'disabled' : ''}>Remove visual</button>`);
  const hint = !live.Sculptex?.connected
    ? '<p class="muted visual-hint">Connect Sculptex in <button class="link-button" type="button" data-action="settings">Settings</button> to add a visual.</p>' : '';
  return `<div class="visual-row"><span class="visual-label">Visual</span>${visualBlock(post)}${buttons.length ? `<div class="tools">${buttons.join('')}</div>` : ''}${hint}</div>`;
}
function sourceLink(post) {
  const url = safeUrl(post.sourceUrl);
  if (!url) return '';
  return `<a class="source-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(str(post.sourceLabel, 120) || hostOf(url))} · Source ↗</a>`;
}
function editForm(post) {
  const dm = post.kind === 'dm';
  return `<form class="settings-grid" id="edit-form" data-keep="${esc(post.id)}"><label class="form-label">${dm ? 'Title' : 'Headline'}<input class="field" name="title" maxlength="180" value="${esc(post.title)}" required></label><label class="form-label">${dm ? 'Message' : 'Post copy'}<textarea class="field" name="copy" rows="4" maxlength="3000" required>${esc(post.copy)}</textarea></label>${dm ? '' : visualEditor(post)}<div class="tools"><button class="btn primary" type="submit">Save edit</button><button class="btn ghost" data-action="cancel-edit" type="button">Cancel</button></div></form>`;
}
function postCard(post) {
  const dm = post.kind === 'dm';
  const busy = rewritingId === post.id;
  const noun = dm ? 'message' : 'post';
  const meta = dm
    ? `<span class="dm-head"><span class="dm-chip">DM</span><span class="dm-recipient">${esc(str(post.recipient, 140) || 'LinkedIn message')}</span></span>`
    : `<span class="linkedin-mark" role="img" aria-label="LinkedIn draft">${icon('linkedin')}</span>`;
  const copyButton = dm && !editing ? `<button class="btn ghost with-icon copy-btn" data-action="copy-dm" ${busy ? 'disabled' : ''}>${icon('copy')}Copy</button>` : '';
  return `<article class="post-card${busy ? ' busy' : ''}" id="post-card" aria-label="Draft ${noun}" ${busy ? 'aria-busy="true"' : ''}>
  <header class="post-meta">${meta}<div class="card-actions">${copyButton}<button class="icon ghost round" data-action="edit" aria-label="Edit ${noun}" title="Edit ${noun}" ${busy || revisionBusy ? 'disabled' : ''}>${icon('edit')}</button></div></header>
  <div class="post-body">${editing ? editForm(post) :
  `<h2>${esc(post.title)}</h2><div class="post-copy">${esc(post.copy)}</div>${busy ? '<p class="card-status" role="status">Writing a new version…</p>' : ''}${dm ? '' : visualBlock(post)}${sourceLink(post)}`}</div>
  ${editing ? '' : `<div class="post-revision">${revising ? revisionComposer('revise-form', post.id, revisionBusy || busy) : `<button class="icon ghost round" data-action="revise" title="Suggest a revision" aria-label="Suggest a revision" ${busy ? 'disabled' : ''}>${icon('chat')}</button>`}</div>`}
  <div class="swipe-overlay" aria-hidden="true"><span id="swipe-mark"></span></div></article>`;
}
function decisionButtons(post) {
  const disabled = rewritingId !== null || revisionBusy ? 'disabled' : '';
  if (post.kind === 'dm') {
    return `<div class="decisions labeled">
      <div class="decision-wrap"><button id="decline" class="icon decision decline" data-action="decline" aria-label="I don’t like this" title="Write a new version" ${disabled}>${icon('decline')}</button><label class="decision-label" for="decline">I don’t like this</label></div>
      <div class="decision-wrap"><button id="approve" class="icon decision approve" data-action="approve" aria-label="I sent this" title="Mark as sent" ${disabled}>${icon('approve')}</button><label class="decision-label" for="approve">I sent this</label></div>
    </div><p class="review-hint">${DM_HINT}</p>`;
  }
  return `<div class="decisions">
      <button id="decline" class="icon decision decline" data-action="decline" aria-label="Decline post" title="Decline" ${disabled}>${icon('decline')}</button>
      <button id="approve" class="icon decision approve" data-action="approve" aria-label="Approve and schedule post" title="Approve and schedule" ${disabled}>${icon('approve')}</button>
    </div><p class="review-hint">${POST_HINT}</p>`;
}
function reviewPage() {
  const post = state.posts[0];
  if (!post && generating) return `<section class="review"><div class="review-top"><h1 tabindex="-1">Post review</h1><span>Drafting…</span></div>
    <div class="stack"><article class="post-card loading-card" aria-label="Drafting posts" aria-busy="true"><div class="loading-content" role="status">
      <span class="loading-mark" aria-hidden="true">${LENS_MARK}</span><p>Drafting posts…</p><small>Lens is reading what’s new in your field.</small></div></article></div></section>`;
  if (!post) return `<section class="empty-review"><div class="empty-content">
    <span class="empty-check">${icon('approve')}</span><h1 tabindex="-1">You’re all caught up</h1>
    <button class="btn primary" data-action="generate">Generate more</button></div></section>`;
  return `<section class="review"><div class="review-top"><h1 tabindex="-1">Post review</h1><span>${state.posts.length} in stack</span></div>
    <div class="stack ${state.posts.length > 1 ? 'has-next' : ''}">${postCard(post)}</div>${editing ? '' : decisionButtons(post)}</section>`;
}

const DAY_MS = 86400000;
const nyDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'});
const nyTime = new Intl.DateTimeFormat('en-GB', {timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
const dayLabel = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric'});
const eastern = new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short'});
function dateKey(slot) {
  const parts = Object.fromEntries(nyDate.formatToParts(slot).map(({type, value}) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function moveDay(day, amount) {return new Date(Date.parse(day + 'T00:00:00Z') + amount * DAY_MS).toISOString().slice(0, 10);}
function dayOfWeek(day) {return new Date(day + 'T00:00:00Z').getUTCDay();}
function firstDay(day) {return moveDay(day, -dayOfWeek(day));}
function formatSlot(slot) {return eastern.format(new Date(slot)) + ' ET';}
function easternSlot(day, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const utc = Date.parse(day + 'T' + time + ':00Z');
  if (!Number.isFinite(utc)) return null;
  for (const offset of [4, 5]) {
    const candidate = utc + offset * 3600000;
    if (dateKey(candidate) === day && nyTime.format(candidate) === time) return candidate;
  }
  return null;
}
function scheduledPosts() {return state.journal.filter(post => post.status === 'Scheduled' && Number.isFinite(post.slot)).sort((a, b) => a.slot - b.slot);}
function calendarPosts() {return state.journal.filter(post => ['Scheduled', 'Posted'].includes(post.status) && Number.isFinite(post.slot)).sort((a, b) => a.slot - b.slot);}
function isDue(post) {return post.status === 'Scheduled' && post.slot <= Date.now();}
function recommendedSlot(day, ignoredId, earliest = Date.now() + 1) {
  const workday = ![0, 6].includes(dayOfWeek(day));
  const times = workday ? ['10:00', '11:00', '12:00', '14:00', '16:00', '18:00', '20:00'] : ['11:00', '12:00', '14:00', '16:00', '18:00', '20:00'];
  const booked = new Set(scheduledPosts().filter(post => post.id !== ignoredId).map(post => post.slot));
  return times.map(time => easternSlot(day, time)).find(slot => slot !== null && slot >= earliest && !booked.has(slot)) ?? null;
}
function initializeCalendar() {
  if (calendarWeek) return;
  const now = Date.now();
  const upcoming = scheduledPosts().find(post => post.slot > now);
  calendarWeek = firstDay(dateKey(upcoming?.slot || now));
}
function calendarPost(post) {
  const posted = post.status === 'Posted';
  const due = isDue(post);
  return `<button class="calendar-item${posted ? ' posted' : ''}${due ? ' due' : ''}" ${posted ? '' : 'draggable="true"'} data-post-id="${esc(post.id)}" data-action="select-post" title="${esc(post.title)}">
    <strong>${posted ? icon('approve') + '<span class="visually-hidden">Posted: </span>' : ''}${esc(post.title)}</strong>${due ? `<small>${publishing.has(post.id) ? 'Posting…' : 'Due'}</small>` : ''}</button>`;
}
function calendarBanner() {
  if (bannerDismissed()) return '';
  return `<div class="calendar-banner" role="note"><span>Leave Lens open so scheduled posts can send.</span><button class="icon ghost round" data-action="dismiss-banner" aria-label="Dismiss" title="Dismiss">${icon('decline')}</button></div>`;
}
function calendarPage() {
  initializeCalendar();
  const all = calendarPosts();
  const days = Array.from({length: 7}, (_, index) => moveDay(calendarWeek, index));
  return `<section class="page calendar-page">${calendarBanner()}${heading('Calendar', 'LinkedIn schedule', false)}
    <div class="calendar-header"><strong>${dayLabel.format(new Date(days[0] + 'T00:00:00Z'))} – ${dayLabel.format(new Date(days[6] + 'T00:00:00Z'))}</strong>
      <div class="tools"><button class="icon ghost" data-action="previous-week" aria-label="Previous week" title="Previous week">${icon('previous')}</button><button class="btn ghost" data-action="calendar-today">Today</button><button class="icon ghost" data-action="next-week" aria-label="Next week" title="Next week">${icon('next')}</button></div>
    </div>
    <div class="calendar-scroll"><div class="calendar-week">${days.map(day => `<div class="calendar-day" data-drop-day="${day}"><span class="calendar-date">${dayLabel.format(new Date(day + 'T00:00:00Z'))}</span>${all.filter(post => dateKey(post.slot) === day).map(calendarPost).join('')}</div>`).join('')}</div></div>
    <p class="muted calendar-note">${all.length ? 'Drag a post to another day or open it to edit.' : 'Approved posts will appear here.'}</p></section>`;
}
function getScheduledPost(id) {return scheduledPosts().find(post => post.id === id);}
function getCalendarPost(id) {return calendarPosts().find(post => post.id === id);}
function findEditablePost(id) {return state.posts.find(post => post.id === id) || getScheduledPost(id);}
function publishStatus(post) {
  const linked = isConnected('LinkedIn');
  const due = isDue(post);
  const sending = publishing.has(post.id);
  const text = sending ? 'Posting to LinkedIn…'
    : due && !linked ? 'Due — connect LinkedIn to post'
    : due ? 'Due now'
    : `Scheduled for ${formatSlot(post.slot)}`;
  const action = sending ? ''
    : linked ? `<button class="btn primary" data-action="post-now" data-post-id="${esc(post.id)}">Post now</button>`
    : due ? '<button class="btn" data-action="connection" data-provider="LinkedIn">Connect LinkedIn</button>' : '';
  const error = post.error && !sending ? `<p class="revision-error" role="alert">Last try failed: ${esc(post.error)}</p>` : '';
  return `<div class="publish-status${due ? ' due' : ''}" role="status"><div><strong>${esc(text)}</strong>${error}</div>${action}</div>`;
}
function postedPage(post) {
  const url = safeUrl(post.postedUrl);
  return `<section class="page"><div class="page-head"><div><button class="btn ghost" data-action="calendar">← Calendar</button></div><h1 tabindex="-1">Posted to LinkedIn</h1>
    <p class="posted-meta">${icon('approve')}<span>${esc(formatSlot(post.postedAt || post.slot))}</span></p></div>
    <article class="scheduled-editor posted-view"><h2>${esc(post.title)}</h2><div class="post-copy">${esc(post.copy)}</div>${visualBlock(post)}
      ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">View on LinkedIn ↗</a>` : ''}</article></section>`;
}
function scheduledPostPage() {
  const post = getCalendarPost(selectedPostId);
  if (!post) return calendarPage();
  if (post.status === 'Posted') return postedPage(post);
  const conversation = post.revisionThread || [];
  const thread = conversation.map(turn => chatTurn(turn.role, turn.text)).join('') + (scheduledBusy ? typingTurn() : '');
  return `<section class="page"><div class="page-head"><div><button class="btn ghost" data-action="calendar">← Calendar</button></div><h1 tabindex="-1">Scheduled post</h1></div>
    ${publishStatus(post)}
    <form id="scheduled-edit" class="scheduled-editor" data-keep="${esc(post.id)}">
      <label class="form-label">Headline<input class="field" name="title" maxlength="180" value="${esc(post.title)}" required></label>
      <label class="form-label">Post copy<textarea class="field" name="copy" rows="6" maxlength="3000" required>${esc(post.copy)}</textarea></label>
      <label class="form-label">Date<input class="field" type="date" name="day" value="${dateKey(post.slot)}" required></label>
      ${visualEditor(post)}
      <div><button class="btn primary" type="submit">Save changes</button></div>
    </form>
    <div class="revision-panel"><h2>Revise with Lens</h2>
      ${thread ? `<div class="thread" role="log" aria-label="Revision conversation">${thread}</div>` : ''}
      ${revisionComposer('scheduled-revise', post.id, scheduledBusy)}
    </div></section>`;
}
function brainstormPage() {
  const messages = state.brainstorm.length ? state.brainstorm : [{role: 'agent', text: `What would you like to post about for ${state.brand.name}?`}];
  const draftAction = state.proposal && !chatBusy ? '<div class="draft-action"><button class="btn primary" data-action="queue-proposal">Add draft to stack</button></div>' : '';
  const thread = messages.map(m => m.error ? failedTurn(m.text) : chatTurn(m.role, m.text)).join('') + (chatBusy ? typingTurn() : '') + draftAction;
  return chatWorkspace('Chat', 'Brainstorm conversation', thread, chatComposer('brainstorm-form', 'Message Lens', chatBusy, 'chat'));
}
function settingsPage() {
  return `<section class="page">${heading('Settings', '', false)}
  <div class="settings-block"><h2>Connections</h2><p class="muted">Manage your connections.</p>${connectionRows()}</div>
  <div class="settings-block"><h2>Brand memory</h2><p class="muted">${esc(state.brand.name)} · ${esc(state.brand.cadence)} posts per week</p><div class="tools"><button class="btn" data-action="download">Download brand file</button><button class="btn" data-action="upload">Upload brand file</button><button class="btn" data-action="download-logo">Download logo</button><input id="brand-upload" aria-label="Upload brand file" type="file" accept=".json,application/json" hidden></div></div>
  <div class="settings-block"><h2>Browser storage</h2><div class="tools"><button class="btn danger" data-action="request-erase">Erase local data</button></div></div>
  <dialog id="erase-dialog" class="popup" aria-labelledby="erase-title"><div class="popup-head"><h2 id="erase-title">Erase local data?</h2></div><p>This clears your saved brand, drafts, schedule and chats from this browser, disconnects Sculptex and LinkedIn, and takes you back to onboarding.</p><div class="popup-actions"><button class="btn" data-action="cancel-erase" autofocus>Cancel</button><button class="btn danger" data-action="confirm-erase">Erase local data</button></div></dialog></section>`;
}
function revisionComposer(id, postId, busy = false) {
  return `<form class="revise-form" id="${id}" data-keep="${esc(postId)}"><input type="hidden" name="post" value="${esc(postId)}"><input class="field" name="message" aria-label="Describe a change" placeholder="${busy ? 'Revising…' : 'Suggest a change'}" maxlength="500" required ${busy ? 'readonly aria-busy="true"' : ''}><button class="icon primary round" type="submit" aria-label="Apply revision" ${busy ? 'disabled' : ''}>${icon('send')}</button></form>
    ${revisionError && id === 'revise-form' ? `<p class="revision-error" role="alert">${esc(revisionError)}</p>` : ''}`;
}

function render(keep = true) {
  const snapshot = keep ? snapshotForms() : null;
  const workspace = !['entry', 'scan', 'onboard'].includes(view);
  header.classList.toggle('entry', !workspace);
  nav.hidden = settingsNav.hidden = !workspace;
  for (const button of header.querySelectorAll('[data-action]')) {
    const active = button.dataset.action === (view === 'scheduled-post' ? 'calendar' : view);
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  const renderPage = {entry: entryPage, scan: scanPage, onboard: onboardPage, review: reviewPage, calendar: calendarPage, 'scheduled-post': scheduledPostPage, chat: brainstormPage, settings: settingsPage};
  main.innerHTML = (renderPage[view] || entryPage)();
  if (snapshot) restoreForms(snapshot);
  resetForms.clear();
  for (const thread of main.querySelectorAll('.thread')) thread.scrollTop = thread.scrollHeight;
}

// ---------------------------------------------------------------- onboarding

function normalizedUrl(value) {
  try {
    const input = value.trim();
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : 'https://' + input);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.') || url.username || url.password) return null;
    return url;
  } catch {return null;}
}
function cleanScan(value) {
  if (!value || typeof value !== 'object') return null;
  const scan = {
    name: str(value.name, 80),
    summary: str(value.summary, 600),
    product: str(value.product, 1000),
    audience: str(value.audience, 400),
    keywords: Array.isArray(value.keywords) ? value.keywords.map(word => str(word, 60)).filter(Boolean).slice(0, 12) : []
  };
  return scan.summary || scan.product ? scan : null;
}
function firstQuestion(name) {return `I’ll build a brand profile for ${name}. ${QUESTIONS[0][1]}`;}
function firstMessage(setup) {
  const about = oneLine(setup.scan?.summary || setup.scan?.product);
  if (!about) return firstQuestion(setup.name);
  const label = setup.scan.name || setup.name;
  return `I read ${label}: ${endSentence(about)} Is that what you do? Confirm it, or correct me in a sentence.`;
}
async function startOnboard(value) {
  const url = normalizedUrl(value);
  if (!url) {document.querySelector('#entry-error').textContent = 'Enter a company website, like sculptex.app.'; return;}
  const name = url.hostname.replace(/^www\./, '');
  const setup = {url: url.href, name, scan: null, answers: {}, messages: [{role: 'user', text: name}], complete: false, filledTurns: 0};
  state.onboarding = setup;
  save();
  go('scan');
  let settled = false;
  const scanning = Promise.race([
    attempt(() => lens.scanSite(url.href)).then(value => ({ok: true, value}), error => ({ok: false, error})),
    sleep(SCAN_TIMEOUT).then(() => ({ok: false, error: new Error('The site took too long to read.')}))
  ]).then(result => {settled = true; return result;});
  // The intro animation is one pass; if the scan is still running after it, keep the stage moving.
  const minimum = sleep(reducedMotion() ? SCAN_DELAY_REDUCED : SCAN_DELAY).then(() => {
    if (settled || state.onboarding !== setup || view !== 'scan') return;
    main.querySelector('.scan-page')?.classList.add('waiting');
    const detail = main.querySelector('#scan-detail');
    if (detail) detail.textContent = 'Still reading your site…';
  });
  const [result] = await Promise.all([scanning, minimum]);
  if (state.onboarding !== setup) return;
  setup.scan = result.ok ? cleanScan(result.value) : null;
  setup.messages.push({role: 'agent', text: firstMessage(setup)});
  save();
  if (view === 'scan') go('onboard');
  if (!setup.scan) notify('Lens couldn’t read that site, so it will ask instead.');
}
function parseCadence(text) {
  if (/\b(once|twice) (daily|a day)\b/i.test(text)) return /twice/i.test(text) ? 14 : 7;
  if (/\b(daily|every day|a day|per day|month(?:ly)?)\b/i.test(text)) {
    const daily = /^(?:once )?(?:daily|every day)$/.test(text.toLowerCase());
    return daily ? 7 : null;
  }
  if (/\bevery (?:other|second) day\b/i.test(text)) return 3;
  if (/\btwice\b/i.test(text)) return 2;
  const match = text.toLowerCase().match(/\b(\d+|one|two|three|four|five|six|seven)\b/);
  const numbers = {one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7};
  const number = match ? numbers[match[1]] ?? Number(match[1]) : /\b(weekly|once a week)\b/i.test(text) ? 1 : null;
  return Number.isInteger(number) && number >= 1 && number <= 14 ? number : null;
}
function validCadence(value) {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? (parseCadence(value) ?? Number(value)) : NaN;
  return Number.isInteger(number) && number >= 1 && number <= 14 ? number : null;
}
function mergeAnswers(target, incoming) {
  if (!incoming || typeof incoming !== 'object') return;
  for (const key of ['product', 'audience', 'goal', 'voice']) {
    const value = str(incoming[key], 3000);
    if (value) target[key] = value;
  }
  const cadence = validCadence(incoming.cadence);
  if (cadence) target.cadence = cadence;
}
function nextQuestion(answers) {
  return QUESTIONS.find(([key]) => answers[key] === undefined)?.[1] || CLOSING;
}
function focusOnboard() {
  (main.querySelector('#onboard-form textarea') || main.querySelector('[data-action=finish-onboard]'))?.focus();
}
async function onboardAnswer(value, {retry = false} = {}) {
  const setup = state.onboarding;
  if (!setup || setup.complete || onboardBusy) return;
  if (retry) {
    // Drop the failure message and ask Lens AI again about the founder's last reply.
    while (setup.messages.length && setup.messages[setup.messages.length - 1].error) setup.messages.pop();
    if (setup.messages[setup.messages.length - 1]?.role !== 'user') return;
  } else {
    if (setup.messages[setup.messages.length - 1]?.error) setup.messages.pop();
    setup.messages.push({role: 'user', text: value});
  }
  onboardBusy = true;
  resetForms.add('onboard-form');
  save();
  render();
  focusOnboard();
  let result, failure;
  try {
    result = await lens.onboardTurn({site: setup.url, scan: setup.scan, answers: {...setup.answers}, messages: chatHistory(setup.messages)});
  } catch (error) {failure = error;}
  onboardBusy = false;
  if (state.onboarding !== setup) return;
  if (failure) {
    setup.messages.push({role: 'agent', text: aiUnavailable(failure), error: true});
  } else {
    mergeAnswers(setup.answers, result?.answers);
    const filled = SLOTS.every(key => setup.answers[key] !== undefined);
    if (filled) setup.filledTurns = (setup.filledTurns || 0) + 1;
    const reply = str(result?.reply, 4000);
    if (filled && (result?.done || setup.filledTurns > 1)) {
      setup.complete = true;
      setup.messages.push({role: 'agent', text: reply && /linkedin/i.test(reply) ? reply : (reply ? reply + '\n\n' : '') + CLOSING});
    } else {
      setup.messages.push({role: 'agent', text: reply || nextQuestion(setup.answers)});
    }
  }
  save();
  if (view !== 'onboard') return;
  render();
  const turns = main.querySelectorAll('.thread .turn');
  turns[turns.length - 1]?.classList.add('reply-enter');
  focusOnboard();
}
function finishOnboard() {
  const setup = state.onboarding;
  if (!setup || !setup.complete) return;
  if (!getConnections().LinkedIn?.connected) {notify('Connect LinkedIn to continue.'); return;}
  const scan = setup.scan || {};
  const brand = {name: scan.name || setup.name, url: setup.url};
  for (const key of SLOTS) brand[key] = setup.answers[key] ?? DEFAULTS[key];
  if (scan.summary) brand.summary = scan.summary;
  if (scan.keywords?.length) brand.keywords = scan.keywords;
  state.brand = brand;
  state.onboarding = null;
  onboardBusy = false;
  save();
  go('review');
  notify('Brand memory saved.');
  if (!state.posts.length) generateStack();
}

// ---------------------------------------------------------------- stack

function newPost(fields) {
  return {id: state.next++, ...fields};
}
function cleanItems(list, kind) {
  return (Array.isArray(list) ? list : []).map(item => {
    if (!item || typeof item !== 'object') return null;
    const copy = str(item.copy, 3000);
    if (!copy) return null;
    const out = {kind, title: str(item.title, 180) || (kind === 'dm' ? 'Message' : oneLine(copy, 90)), copy};
    const sourceUrl = safeUrl(item.sourceUrl);
    if (sourceUrl) {out.sourceUrl = sourceUrl; out.sourceLabel = str(item.sourceLabel, 120) || hostOf(sourceUrl);}
    if (kind === 'dm') {
      const recipient = str(item.recipient, 140);
      if (recipient) out.recipient = recipient;
    } else {
      const idea = str(item.visualIdea, 400);
      if (idea) out.visualIdea = idea;
    }
    return out;
  }).filter(Boolean);
}
function interleave(posts, dms) {
  const out = [];
  let i = 0, j = 0;
  while (i < posts.length || j < dms.length) {
    for (let k = 0; k < 2 && i < posts.length; k++) out.push(posts[i++]);
    if (j < dms.length) out.push(dms[j++]);
  }
  return out;
}
async function generateStack() {
  if (generating || !state.brand) return;
  generating = true;
  const owner = state;
  const brand = {...state.brand};
  if (view === 'review') refresh();
  const [posts, dms] = await Promise.allSettled([
    attempt(() => lens.generatePosts({brand, count: 3})),
    attempt(() => lens.findDMs({brand, count: 2}))
  ]);
  generating = false;
  if (state !== owner) return;
  const postItems = posts.status === 'fulfilled' ? cleanItems(posts.value, 'post') : [];
  const dmItems = dms.status === 'fulfilled' ? cleanItems(dms.value, 'dm') : [];
  const items = interleave(postItems, dmItems);
  for (const item of items) state.posts.push(newPost(item));
  save();
  if (posts.status === 'rejected' && dms.status === 'rejected') notify('Lens couldn’t draft posts. ' + endSentence(errorText(posts.reason)));
  else if (posts.status === 'rejected') notify('Lens couldn’t draft posts. ' + endSentence(errorText(posts.reason)));
  else if (dms.status === 'rejected') notify('Lens couldn’t find people to message. ' + endSentence(errorText(dms.reason)));
  else if (!items.length) notify('No new drafts this time. Try Generate more again.');
  if (view === 'review') {
    refresh();
    if (!editing && !revising) main.querySelector('h1')?.focus({preventScroll: true});
  }
}
function schedule(post) {
  const cadence = validCadence(state.brand.cadence) || DEFAULTS.cadence;
  const interval = Math.round(7 * 86400000 / cadence);
  const last = Math.max(0, ...scheduledPosts().map(item => item.slot));
  const earliest = Math.max(Date.now() + 3600000, last + interval);
  let day = dateKey(earliest);
  let slot = recommendedSlot(day, post.id, earliest);
  while (slot === null) {
    day = moveDay(day, 1);
    slot = recommendedSlot(day, post.id, earliest);
  }
  state.journal.unshift({...post, status: 'Scheduled', slot});
  return slot;
}
function commitDecision(approve, id) {
  decisionPending = false;
  if (state.posts[0]?.id !== id) return;
  const post = state.posts.shift();
  if (approve && post.kind === 'dm') {
    state.journal.unshift({...post, status: 'Sent', sentAt: Date.now()});
    notify('Marked as sent.');
  } else if (approve) {
    const slot = schedule(post);
    notify('Scheduled for ' + formatSlot(slot) + '.');
  } else {
    state.journal.unshift({...post, status: 'Declined'});
    notify('Post declined.');
  }
  save();
  drag = null;
  revising = false;
  revisionError = '';
  render();
  main.querySelector('#approve,[data-action=generate]')?.focus({preventScroll: true});
}
function decide(approve, card = main.querySelector('#post-card')) {
  if (view !== 'review' || editing || decisionPending || !state.posts.length || rewritingId !== null || revisionBusy) return;
  drag = null;
  const post = state.posts[0];
  if (post.kind === 'dm' && !approve) {
    if (card) paintSwipe(card, 0);
    rewriteDM();
    return;
  }
  const id = post.id;
  if (!card || reducedMotion()) {
    commitDecision(approve, id);
    return;
  }
  decisionPending = true;
  for (const action of ['approve', 'decline']) {const button = document.querySelector('#' + action); if (button) button.disabled = true;}
  const direction = approve ? 1 : -1;
  paintSwipe(card, direction * 170);
  card.classList.add('exiting');
  card.style.setProperty('--offset', direction * 120 + 'vw');
  card.style.setProperty('--tilt', direction * 14 + 'deg');
  setTimeout(() => commitDecision(approve, id), 280);
}
async function rewriteDM() {
  const post = state.posts[0];
  if (!post || post.kind !== 'dm' || rewritingId !== null) return;
  const owner = state;
  const id = post.id;
  rewritingId = id;
  revisionError = '';
  render();
  let result, failure;
  try {
    result = await lens.revise({brand: state.brand, item: {kind: 'dm', title: post.title, copy: post.copy}, request: DM_REWRITE});
  } catch (error) {failure = error;}
  rewritingId = null;
  if (state !== owner) return;
  const current = state.posts.find(item => item.id === id);
  const copy = str(result?.copy, 3000);
  if (failure) notify('Lens couldn’t write a new version. ' + endSentence(errorText(failure)));
  else if (!copy) notify('Lens didn’t return a new version. Try again.');
  else if (current) {
    current.copy = copy;
    const title = str(result.title, 180);
    if (title) current.title = title;
    save();
    notify('New version ready.');
  }
  if (view === 'review') {
    refresh();
    main.querySelector('#decline')?.focus({preventScroll: true});
  }
}
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText && globalThis.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.append(area);
  area.select();
  let ok = false;
  try {ok = document.execCommand('copy');} catch {}
  area.remove();
  return ok;
}
async function copyMessage(button) {
  const post = state.posts[0];
  if (!post || post.kind !== 'dm') return;
  const ok = await copyText(post.copy);
  button?.focus({preventScroll: true});
  notify(ok ? 'Message copied.' : 'Couldn’t copy. Select the message and copy it.');
}
function queueProposal() {
  if (!state.proposal) return;
  const {title, copy} = state.proposal;
  state.posts.push(newPost({kind: 'post', title, copy}));
  state.proposal = null;
  notify('Draft added to your stack.');
  save();
  render();
}

// ---------------------------------------------------------------- revisions & chat

async function applyRevision(form) {
  const request = field(form, 'message');
  const id = Number(field(form, 'post'));
  const scheduled = form.id === 'scheduled-revise';
  const post = scheduled ? getScheduledPost(selectedPostId) : state.posts[0];
  if (!request || !post || post.id !== id || decisionPending) return;
  if (scheduled ? scheduledBusy : (revisionBusy || rewritingId !== null)) return;
  const owner = state;
  const editor = scheduled ? main.querySelector('#scheduled-edit') : null;
  const originalCopy = editor?.querySelector('[name=copy]')?.value.trim() || post.copy;
  const originalTitle = editor?.querySelector('[name=title]')?.value.trim() || post.title;
  if (scheduled) {
    scheduledBusy = true;
    post.revisionThread = [...(post.revisionThread || []), {role: 'user', text: request}].slice(-16);
    resetForms.add('scheduled-revise');
    save();
  } else {
    revisionBusy = true;
    revisionError = '';
  }
  render();
  if (scheduled) main.querySelector('#scheduled-revise input[name=message]')?.focus();
  let result, failure;
  try {
    result = await lens.revise({brand: state.brand, item: {kind: post.kind === 'dm' ? 'dm' : 'post', title: originalTitle, copy: originalCopy}, request});
  } catch (error) {failure = error;}
  if (scheduled) scheduledBusy = false;
  else revisionBusy = false;
  if (state !== owner) return;
  const current = scheduled ? getScheduledPost(id) : state.posts.find(item => item.id === id);
  if (!current) {refresh(); return;}
  const copy = str(result?.copy, 100000);
  const title = str(result?.title, 180);
  let valid = false;
  let feedback;
  if (failure) feedback = errorText(failure);
  else if (!copy) feedback = 'Lens didn’t return a new draft. Try describing the change differently.';
  else if (copy.length > 3000 || (post.kind !== 'dm' && postLength(title || originalTitle, copy) > LINKEDIN_MAX)) feedback = 'This edit would make the draft too long.';
  else if (copy === originalCopy && (!title || title === originalTitle)) feedback = 'That change is already in the draft.';
  else {
    valid = true;
    feedback = str(result.message, 600) || 'Updated the draft.';
    current.copy = copy;
    if (title) current.title = title;
  }
  if (scheduled) current.revisionThread = [...(current.revisionThread || []), {role: 'agent', text: feedback}].slice(-16);
  else revisionError = valid ? '' : feedback;
  save();
  const stillHere = scheduled ? view === 'scheduled-post' && selectedPostId === id : view === 'review';
  if (!stillHere) return;
  if (!scheduled && valid) resetForms.add('revise-form');
  refresh();
  if (scheduled && valid) {
    const copyField = main.querySelector('#scheduled-edit [name=copy]');
    if (copyField) copyField.value = current.copy;
    const titleField = main.querySelector('#scheduled-edit [name=title]');
    if (titleField && title) titleField.value = current.title;
  }
  main.querySelector('#' + form.id + ' input[name=message]')?.focus();
  if (valid) notify('Draft updated.');
}
function cleanProposal(value) {
  if (!value || typeof value !== 'object') return null;
  const copy = str(value.copy, 3000);
  if (!copy) return null;
  return {title: str(value.title, 180) || oneLine(copy, 90), copy};
}
async function brainstorm(value) {
  if (chatBusy || !state.brand) return;
  const owner = state;
  if (!state.brainstorm.length) state.brainstorm.push({role: 'agent', text: `Let’s find an angle for ${state.brand.name}.`});
  state.brainstorm.push({role: 'user', text: value});
  chatBusy = true;
  resetForms.add('brainstorm-form');
  save();
  render();
  main.querySelector('#brainstorm-form textarea')?.focus();
  let result, failure;
  try {
    result = await lens.brainstorm({brand: state.brand, messages: chatHistory(state.brainstorm), proposal: state.proposal ? {title: state.proposal.title, copy: state.proposal.copy} : null});
  } catch (error) {failure = error;}
  chatBusy = false;
  if (state !== owner) return;
  if (failure) {
    state.brainstorm.push({role: 'agent', text: aiUnavailable(failure), error: true});
  } else {
    const proposal = cleanProposal(result?.proposal);
    let reply = str(result?.reply, 6000);
    if (proposal) {
      state.proposal = proposal;
      if (!reply.includes(proposal.copy.slice(0, 80))) reply = (reply ? reply + '\n\n' : '') + proposal.title + '\n\n' + proposal.copy;
    }
    state.brainstorm.push({role: 'agent', text: reply || 'What should the post be about? Try a customer insight, a product update, or something you learned this week.'});
  }
  state.brainstorm = state.brainstorm.slice(-60);
  save();
  if (view !== 'chat') return;
  refresh();
  const turns = main.querySelectorAll('.thread .turn');
  turns[turns.length - 1]?.classList.add('reply-enter');
  if (!main.contains(document.activeElement) || document.activeElement === document.body) main.querySelector('#brainstorm-form textarea')?.focus();
}

// ---------------------------------------------------------------- visuals

function visualPrompt(title, copy, post) {
  const brand = state.brand || {};
  return [
    `A LinkedIn post visual for ${brand.name || 'a startup'}.`,
    post.visualIdea ? `Idea: ${post.visualIdea}.` : '',
    `Headline: ${title}.`,
    `Post: ${oneLine(copy, 500)}`,
    brand.voice ? `Tone: ${oneLine(brand.voice, 120)}.` : '',
    'Clean, modern composition with little or no text.'
  ].filter(Boolean).join(' ');
}
async function createVisualFor(id, provider, form) {
  if (visualBusy || !VISUAL_PROVIDERS.some(([name]) => name === provider)) return;
  const post = findEditablePost(id);
  if (!post) return;
  const owner = state;
  const title = form?.querySelector('[name=title]')?.value.trim() || post.title;
  const copy = form?.querySelector('[name=copy]')?.value.trim() || post.copy;
  visualBusy = {id, provider};
  refresh();
  try {
    const result = await lens.createVisual({provider, prompt: visualPrompt(title, copy, post)});
    const src = safeImage(result?.src);
    if (!src) throw new Error(`${provider} didn’t return an image.`);
    const current = state === owner ? findEditablePost(id) : null;
    if (current) {
      const link = safeUrl(result.link);
      current.visual = {src, provider: PROVIDERS.includes(result.provider) ? result.provider : provider, ...(link ? {link} : {})};
      save();
      notify(`${provider} visual added.`);
    }
  } catch (error) {
    if (state === owner) notify(`${provider} couldn’t make a visual. ${endSentence(errorText(error))}`);
  }
  visualBusy = null;
  refresh();
  main.querySelector(`[data-action=create-visual][data-provider=${provider}]`)?.focus({preventScroll: true});
}
function removeVisual(id) {
  const post = findEditablePost(id);
  if (!post) return;
  delete post.visual;
  save();
  refresh();
  notify('Visual removed.');
}

// ---------------------------------------------------------------- calendar & publishing

function reschedulePost(id, day) {
  const post = getScheduledPost(id);
  if (!post || dateKey(post.slot) === day) return;
  const slot = recommendedSlot(day, id);
  if (!slot) {notify('Choose another day. No suggested time is available.'); return;}
  post.slot = slot;
  delete post.error; delete post.errorAt; delete post.errorNotified;
  calendarWeek = firstDay(day);
  save();
  render();
  notify('Post moved to ' + formatSlot(slot) + '.');
}
function saveScheduled(form) {
  const post = getScheduledPost(selectedPostId);
  const title = field(form, 'title');
  const copy = field(form, 'copy');
  const day = field(form, 'day');
  if (!post || !title || !copy || !day) return;
  if (postLength(title, copy) > LINKEDIN_MAX) {notify(tooLongMessage(title, copy)); return;}
  const slot = dateKey(post.slot) === day ? post.slot : recommendedSlot(day, post.id);
  if (!slot) {notify('Choose another day. No suggested time is available.'); return;}
  if (slot !== post.slot) {delete post.error; delete post.errorAt; delete post.errorNotified;}
  Object.assign(post, {title, copy, slot});
  calendarWeek = firstDay(day);
  save();
  resetForms.add('scheduled-edit');
  render();
  notify('Scheduled post updated.');
}
function refreshPublishViews() {
  if (view === 'calendar' || view === 'scheduled-post') refresh();
}
function publishPayload(post) {
  const src = safeImage(post.visual?.src);
  return {id: post.id, title: post.title, copy: post.copy, ...(src ? {visual: {src, provider: post.visual.provider}} : {})};
}
// One tab at a time posts: every open Lens tab runs autoPublish on the same saved schedule.
function withPublishLock(task) {
  try {if (navigator.locks?.request) return navigator.locks.request('lens-publish', task);} catch {}
  return task();
}
async function publishPost(id, manual = false) {
  if (!getScheduledPost(id) || publishing.has(id)) return;
  const owner = state;
  publishing.add(id);
  refreshPublishViews();
  try {
    await withPublishLock(async () => {
      if (state !== owner) return;
      adoptSaved(); // another tab may already have posted, moved or edited it
      const post = getScheduledPost(id);
      if (!post || (!manual && (!isDue(post) || (post.errorAt && Date.now() - post.errorAt < PUBLISH_RETRY)))) return;
      let result, failure;
      try {result = await lens.publish(publishPayload(post));}
      catch (error) {failure = error;}
      if (state !== owner) return;
      const current = getScheduledPost(id);
      if (!current) return;
      if (failure && failure.code === 'not-connected') {
        if (manual) notify('Connect LinkedIn to post.');
      } else if (failure) {
        current.error = errorText(failure);
        current.errorAt = Date.now();
        if (manual || !current.errorNotified) {
          current.errorNotified = true;
          notify(`Couldn’t post “${oneLine(current.title, 60)}”. ${endSentence(current.error)}`);
        }
      } else {
        current.status = 'Posted';
        current.postedAt = Date.now();
        const url = safeUrl(result?.url);
        if (url) current.postedUrl = url;
        if (result?.id) current.linkedinId = String(result.id).slice(0, 200);
        delete current.error; delete current.errorAt; delete current.errorNotified;
        notify(result?.imageSkipped ? 'Posted to LinkedIn without its visual. The image couldn’t be attached.' : 'Posted to LinkedIn.');
      }
      save(); // still inside the lock, so the next tab reads “Posted”
    });
  } finally {
    publishing.delete(id);
    refreshPublishViews();
  }
}
// "Post now" sends what is on the page: unsaved headline/copy edits are saved first.
function postNow(id) {
  const form = main.querySelector('#scheduled-edit');
  const post = getScheduledPost(id);
  if (form && post && selectedPostId === id) {
    const title = field(form, 'title');
    const copy = field(form, 'copy');
    if (!title || !copy) {notify('Add a headline and post copy before posting.'); return;}
    if (postLength(title, copy) > LINKEDIN_MAX) {notify(tooLongMessage(title, copy)); return;}
    if (title !== post.title || copy !== post.copy) {
      Object.assign(post, {title, copy});
      save();
    }
  }
  publishPost(id, true);
}
async function autoPublish() {
  if (publishRunning || !state.brand) return;
  const now = Date.now();
  const due = scheduledPosts().filter(post => post.slot <= now);
  const signature = due.map(post => post.id).join(',');
  const changed = signature !== lastDueSignature;
  lastDueSignature = signature;
  const ready = due.filter(post => !publishing.has(post.id) && !(post.errorAt && now - post.errorAt < PUBLISH_RETRY));
  if (!ready.length || !isConnected('LinkedIn')) {
    if (changed) refreshPublishViews();
    return;
  }
  publishRunning = true;
  try {
    for (const post of ready) {
      if (!isConnected('LinkedIn')) break;
      await publishPost(post.id);
    }
  } finally {publishRunning = false;}
}

// ---------------------------------------------------------------- connections & settings

async function toggleConnection(provider) {
  if (connecting.has(provider)) return;
  connecting.add(provider);
  delete connectionErrors[provider];
  refresh();
  await ready; // an OAuth return still being completed decides what this button means
  const connected = isConnected(provider);
  // Connect may leave for the provider's sign-in; remember where to come back to.
  if (!connected) rememberView();
  try {
    if (connected) await lens.disconnect(provider);
    else await lens.connect(provider);
  } catch (error) {
    if (error?.code === 'redirect') return; // the pageshow handler clears "Connecting…" if the founder comes back
    connectionErrors[provider] = errorText(error);
  }
  forgetView();
  connecting.delete(provider);
  if (!connectionErrors[provider]) {
    if (!connected && isConnected(provider)) notify(`${provider} connected.`);
    if (connected && !isConnected(provider)) notify(`${provider} disconnected.`);
  }
  refresh();
  Array.from(main.querySelectorAll('button[data-provider]')).find(item => item.dataset.provider === provider)?.focus({preventScroll: true});
  if (provider === 'LinkedIn') autoPublish();
}
function downloadBrand() {
  const live = getConnections();
  const brandFile = {...state.brand, connections: Object.fromEntries(PROVIDERS.map(provider => [provider, Boolean(live[provider]?.connected)]))};
  downloadFile('lens-brand.json', JSON.stringify(brandFile, null, 2) + '\n', 'application/json');
}
function downloadLogo() {
  const logo = header.querySelector('.wordmark svg');
  if (logo) downloadFile('Lens Logo.svg', new XMLSerializer().serializeToString(logo) + '\n', 'image/svg+xml');
}
function downloadFile(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], {type}));
  const link = Object.assign(document.createElement('a'), {href: url, download: filename});
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function eraseLocalData() {
  main.querySelector('#erase-dialog')?.close();
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(BANNER_KEY);
  } catch {notify('Browser storage could not be cleared.'); return;}
  forgetView();
  resetLocal(structuredClone(INITIAL));
  go('entry');
  let failure;
  try {await lens.disconnectAll();} catch (error) {failure = error;}
  connecting.clear();
  notify(failure ? 'Lens data erased. Some connections couldn’t be cleared: ' + errorText(failure) : 'Lens data erased from this browser.');
}
function resetLocal(next) {
  state = next;
  calendarWeek = undefined;
  selectedPostId = null;
  scheduleDragId = null;
  decisionPending = false;
  onboardBusy = chatBusy = generating = revisionBusy = scheduledBusy = false;
  rewritingId = null;
  visualBusy = null;
  lastDueSignature = '';
  publishing.clear();
  for (const key of Object.keys(connectionErrors)) delete connectionErrors[key];
}
// Take what another tab saved. Objects in flight here look posts up again by id, so they keep working.
function adoptSaved() {
  if (saveFailed) return; // this tab holds changes storage could not take
  let raw;
  try {raw = localStorage.getItem(STORAGE_KEY);} catch {return;}
  if (raw === null && (state.brand || state.onboarding)) {
    resetLocal(structuredClone(INITIAL)); // erased in another tab
    go('entry');
    return;
  }
  const keep = view === 'scan' || onboardBusy ? state.onboarding : undefined;
  Object.assign(state, loadState());
  if (keep !== undefined) state.onboarding = keep;
}
function syncFromOtherTab() {
  adoptSaved();
  const fits = ['entry', 'scan'].includes(view) ? !(view === 'entry' && (state.onboarding || state.brand))
    : view === 'onboard' ? Boolean(state.onboarding) : Boolean(state.brand);
  if (fits) refresh();
  else go(state.onboarding ? 'onboard' : state.brand ? 'review' : 'entry');
}
async function importBrand(file) {
  if (!file) return;
  const currentState = state;
  if (file.size > 100000) {notify('Choose a Lens brand JSON file under 100 KB.'); return;}
  try {
    const data = JSON.parse(await file.text());
    if (state !== currentState || view !== 'settings') return;
    const keys = ['name', 'product', 'audience', 'goal', 'voice'];
    const url = typeof data?.url === 'string' ? normalizedUrl(data.url) : null;
    if (!url || !keys.every(key => typeof data[key] === 'string' && data[key].trim() && data[key].length <= 3000)
      || !Number.isInteger(data.cadence) || data.cadence < 1 || data.cadence > 14) throw Error('Invalid brand file');
    const brand = {...Object.fromEntries(keys.map(key => [key, data[key].trim()])), url: url.href, cadence: data.cadence};
    const summary = str(data.summary, 600);
    if (summary) brand.summary = summary;
    if (Array.isArray(data.keywords)) {
      const keywords = data.keywords.map(word => str(word, 60)).filter(Boolean).slice(0, 12);
      if (keywords.length) brand.keywords = keywords;
    }
    state.brand = brand;
    save();
    render();
    notify('Brand file imported.');
  } catch {notify('Choose a valid Lens brand JSON file.');}
}

// ---------------------------------------------------------------- events

function field(form, key) {return String(new FormData(form).get(key) || '').trim();}
document.addEventListener('submit', event => {
  const form = event.target;
  event.preventDefault();
  if (form.id === 'entry-form') startOnboard(field(form, 'site'));
  if (form.id === 'onboard-form' && field(form, 'message')) onboardAnswer(field(form, 'message'));
  if (form.id === 'brainstorm-form' && field(form, 'message')) brainstorm(field(form, 'message'));
  if (form.id === 'scheduled-edit') saveScheduled(form);
  if (['revise-form', 'scheduled-revise'].includes(form.id)) applyRevision(form);
  if (form.id === 'edit-form' && state.posts[0] && field(form, 'title') && field(form, 'copy')) {
    if (state.posts[0].kind !== 'dm' && postLength(field(form, 'title'), field(form, 'copy')) > LINKEDIN_MAX) {
      notify(tooLongMessage(field(form, 'title'), field(form, 'copy')));
      return;
    }
    Object.assign(state.posts[0], {title: field(form, 'title'), copy: field(form, 'copy')});
    editing = false;
    save();
    render();
    main.querySelector('[data-action=edit]')?.focus({preventScroll: true});
  }
});
document.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const {action, provider} = button.dataset;
  const postId = Number(button.dataset.postId);
  if (['review', 'calendar', 'chat', 'settings'].includes(action) && state.brand) go(action);
  if (action === 'connection' && PROVIDERS.includes(provider)) toggleConnection(provider);
  if (action === 'finish-onboard') finishOnboard();
  if (action === 'retry-onboard') onboardAnswer('', {retry: true});
  if (action === 'edit' && !editing && !decisionPending && rewritingId === null && !revisionBusy) {editing = true; render(false); main.querySelector('input[name="title"]')?.focus();}
  if (action === 'cancel-edit') {editing = false; render(false); main.querySelector('[data-action=edit]')?.focus({preventScroll: true});}
  if (action === 'approve' || action === 'decline') decide(action === 'approve');
  if (action === 'copy-dm') copyMessage(button);
  if (action === 'queue-proposal') queueProposal();
  if (action === 'create-visual') createVisualFor(postId, provider, button.closest('form'));
  if (action === 'remove-visual') removeVisual(postId);
  if (action === 'post-now') postNow(postId);
  if (action === 'select-post') {
    if (getCalendarPost(postId)) {selectedPostId = postId; go('scheduled-post');}
  }
  if (action === 'calendar-today') {calendarWeek = firstDay(dateKey(Date.now())); render();}
  if (action === 'previous-week' || action === 'next-week') {
    calendarWeek = moveDay(calendarWeek, action === 'previous-week' ? -7 : 7);
    render();
    main.querySelector('[data-action=' + action + ']')?.focus();
  }
  if (action === 'dismiss-banner') {
    try {localStorage.setItem(BANNER_KEY, 'dismissed');} catch {}
    render();
    main.querySelector('h1')?.focus({preventScroll: true});
  }
  if (action === 'revise' && !decisionPending && rewritingId === null) {
    revising = true; revisionError = ''; render();
    main.querySelector('#revise-form input[name=message]')?.focus();
  }
  if (action === 'request-erase') main.querySelector('#erase-dialog')?.showModal();
  if (action === 'cancel-erase') main.querySelector('#erase-dialog')?.close();
  if (action === 'confirm-erase' && main.querySelector('#erase-dialog')?.open) eraseLocalData();
  if (action === 'upload') main.querySelector('#brand-upload')?.click();
  if (action === 'generate' && !state.posts.length && !decisionPending) generateStack();
  if (action === 'download') downloadBrand();
  if (action === 'download-logo') downloadLogo();
});
document.addEventListener('change', event => {
  if (event.target.id === 'brand-upload') {
    const file = event.target.files[0];
    event.target.value = '';
    importBrand(file);
  }
});
function clearDropTargets() {
  for (const target of main.querySelectorAll('.drop-target')) target.classList.remove('drop-target');
}
main.addEventListener('dragstart', event => {
  const item = event.target.closest('[data-post-id]');
  if (view !== 'calendar' || !item || !event.dataTransfer || !getScheduledPost(Number(item.dataset.postId))) return;
  scheduleDragId = Number(item.dataset.postId);
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(scheduleDragId));
});
main.addEventListener('dragover', event => {
  const target = event.target.closest('[data-drop-day]');
  if (!target || scheduleDragId === null) return;
  event.preventDefault();
  clearDropTargets();
  target.classList.add('drop-target');
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
});
main.addEventListener('dragleave', event => {
  const target = event.target.closest('[data-drop-day]');
  if (target && !target.contains(event.relatedTarget)) target.classList.remove('drop-target');
});
main.addEventListener('drop', event => {
  const target = event.target.closest('[data-drop-day]');
  if (!target || scheduleDragId === null) return;
  event.preventDefault();
  const id = scheduleDragId;
  scheduleDragId = null;
  clearDropTargets();
  reschedulePost(id, target.dataset.dropDay);
});
main.addEventListener('dragend', () => {scheduleDragId = null; clearDropTargets();});
function paintSwipe(card, delta) {
  const strength = Math.min(0.65, Math.abs(delta) / 180);
  const color = delta < 0 ? '#ffab9e' : '#bdf4c6';
  card.style.setProperty('--offset', delta + 'px');
  card.style.setProperty('--tilt', (delta / 19) + 'deg');
  card.style.setProperty('--strength', strength);
  card.style.setProperty('--tint', color);
  const mark = card.querySelector('#swipe-mark');
  if (mark) mark.innerHTML = icon(delta < 0 ? 'decline' : 'approve');
  for (const [id, direction] of [['decline', -1], ['approve', 1]]) {
    const button = document.querySelector('#' + id);
    if (!button) continue;
    const active = delta * direction > 20;
    button.classList.toggle('lit', active);
    button.style.backgroundColor = active ? `color-mix(in srgb, ${color} ${Math.round(strength * 130)}%, var(--surface))` : '';
    if (active) button.style.color = strength > .43 ? '#15181a' : color;
    else button.style.color = '';
  }
}
main.addEventListener('pointerdown', event => {
  const card = event.target.closest('#post-card');
  if (!card || card.classList.contains('loading-card') || editing || decisionPending || rewritingId !== null || revisionBusy || event.button !== 0
    || event.target.closest('button,a,input,textarea,label,.post-revision')) return;
  drag = {card, id: event.pointerId, x: event.clientX, delta: 0};
  card.setPointerCapture(event.pointerId);
  card.classList.add('dragging');
});
main.addEventListener('pointermove', event => {
  if (!drag || drag.id !== event.pointerId) return;
  drag.delta = event.clientX - drag.x;
  paintSwipe(drag.card, drag.delta);
});
function endSwipe(event, commit) {
  if (!drag || drag.id !== event.pointerId) return;
  const {card, delta} = drag;
  drag = null;
  card.classList.remove('dragging');
  if (commit && Math.abs(delta) >= Math.min(97, card.offsetWidth * .22)) decide(delta > 0, card);
  else paintSwipe(card, 0);
}
main.addEventListener('pointerup', event => endSwipe(event, true));
main.addEventListener('pointercancel', event => endSwipe(event, false));
main.addEventListener('lostpointercapture', event => endSwipe(event, false));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && main.querySelector('dialog[open]')) return;
  if (event.key === 'Enter' && event.target.matches?.('.chat-composer textarea') && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    event.target.form.requestSubmit();
  }
  if (event.key === 'Escape' && view === 'scheduled-post') go('calendar');
  else if (event.key === 'Escape' && editing) {editing = false; render(false); main.querySelector('[data-action=edit]')?.focus({preventScroll: true});}
  else if (event.key === 'Escape' && revising) {revising = false; revisionError = ''; render(false); main.querySelector('[data-action=revise]')?.focus();}
  else if (event.key === 'Escape' && ['calendar', 'chat', 'settings'].includes(view)) go('review');
});

// ---------------------------------------------------------------- boot

/** lensbeta.vercel.app/?reset — start over: clears only Lens's own storage and connections, then the URL screen. */
function resetRequested() {
  let params;
  try {params = new URLSearchParams(location.search);} catch {return false;}
  if (!params.has('reset')) return false;
  params.delete('reset');
  const rest = params.toString();
  try {history.replaceState(null, '', location.pathname + (rest ? '?' + rest : ''));} catch {}
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(BANNER_KEY);
  } catch {}
  forgetView();
  resetLocal(structuredClone(INITIAL));
  view = 'entry';
  return true;
}
function boot() {
  const reset = resetRequested();
  // Render from local state right away; connection status fills in when lens.init() settles.
  ready = attempt(() => lens.init()).then(result => result || {}, error => ({error: errorText(error)}));
  if (reset) ready = ready.then(async result => {
    try {await lens.disconnectAll();} catch {}
    connecting.clear();
    notify('Lens was reset in this browser.');
    return {...result, returnedFrom: undefined};
  });
  const remembered = takeRememberedView();
  if (state.onboarding) {
    view = 'onboard';
    if (!state.onboarding.messages.some(message => message.role === 'agent')) {
      state.onboarding.messages.push({role: 'agent', text: firstQuestion(state.onboarding.name)});
      save();
    }
  } else if (state.brand && remembered && WORKSPACE_VIEWS.includes(remembered.view)) {
    view = remembered.view;
    if (view === 'scheduled-post') {
      if (getCalendarPost(Number(remembered.postId))) selectedPostId = Number(remembered.postId);
      else view = 'calendar';
    }
  }
  render(false);
  main.firstElementChild?.classList.add('screen-enter');
  try {lens.onConnectionsChange(() => {refresh(); autoPublish();});} catch {}
  window.addEventListener('focus', () => autoPublish());
  document.addEventListener('visibilitychange', () => {if (document.visibilityState === 'visible') autoPublish();});
  // Another Lens tab saved: work from its copy so neither tab overwrites the other.
  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY || event.key === null) syncFromOtherTab();
    else if (event.key === BANNER_KEY) refresh();
  });
  // Back from a provider's sign-in through the back/forward cache: nothing is connecting any more.
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    connecting.clear();
    forgetView();
    syncFromOtherTab();
    autoPublish();
  });
  // A refresh skipped while the erase dialog was open happens once it closes.
  main.addEventListener('close', () => refresh(), true);
  ready.then(result => {
    refresh();
    if (result.error) notify(errorText(result.error));
    else if (PROVIDERS.includes(result.returnedFrom)) notify(`${result.returnedFrom} connected.`);
    autoPublish();
    setInterval(autoPublish, PUBLISH_INTERVAL);
  });
}
boot();

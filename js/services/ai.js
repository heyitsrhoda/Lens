// AI provider switch for Lens. Same contract as claude.js:
//   complete({ system, prompt | messages, maxTokens }) → text
//   json({ system, prompt, schemaHint, maxTokens }) → parsed JSON (retries once on a parse failure)
// Provider = state.settings.aiProvider:
//   'you'    (DEFAULT) → the same-origin relay ./api/you?op=agent (You.com Inference Router by default)
//   'claude' → claude.js (direct browser call with the user's own Claude key)

import { getState } from '../store.js';
import * as you from './youcom.js';
import * as claude from './claude.js';

export const PROVIDERS = ['you', 'claude'];

/**
 * Find and parse the first balanced JSON object/array in a string (a wrapping code fence is stripped).
 * `expect` ('{' or '[', e.g. the first char of a schemaHint) skips candidates of the other shape, so a
 * preamble like "Based on [1], here it is: {...}" returns the object, not [1]. Throws if none parses.
 */
export function extractJson(text, expect) {
  const want = expect === '[' || expect === '{' ? expect : null;
  const fits = (v) => !want || (want === '[' ? Array.isArray(v) : v !== null && typeof v === 'object' && !Array.isArray(v));
  const src = stripFences(text);
  try {
    const whole = JSON.parse(src);
    if (fits(whole)) return whole;
  } catch {
    /* fall through to a scan */
  }
  for (let start = 0; start < src.length; start++) {
    const ch = src[start];
    if (ch !== '{' && ch !== '[') continue;
    if (want && ch !== want) continue;
    const close = ch === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < src.length; i++) {
      const c = src[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === ch) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try {
            const v = JSON.parse(src.slice(start, i + 1));
            if (fits(v)) return v;
          } catch {
            /* not JSON — try the next start */
          }
          break;
        }
      }
    }
  }
  throw new Error('No JSON found in the AI response.');
}

// Remove <think> blocks and a code fence that wraps the reply — never ``` inside JSON string values.
function stripFences(text) {
  const t = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  const m = t.match(/^```[a-z]*[ \t]*\n?([\s\S]*?)\n?```\s*$/i);
  if (m) return m[1].trim();
  // A fenced block after a short preamble ("Here it is:\n```json\n{...}\n```").
  const inner = t.match(/```(?:json|javascript|js)?[ \t]*\n([\s\S]*?)\n```/i);
  if (inner && /^\s*[[{]/.test(inner[1])) return inner[1].trim();
  return t;
}

/** The provider that will actually be used: the chosen one if it is usable, else whichever is. */
export function provider() {
  const s = getState().settings || {};
  const chosen = s.aiProvider === 'claude' ? 'claude' : 'you';
  if (chosen === 'claude' && !claude.hasKey() && you.hasKey()) return 'you';
  if (chosen === 'you' && !you.hasKey() && claude.hasKey()) return 'claude';
  return chosen;
}

export function providerLabel(p = provider()) {
  return p === 'claude' ? 'Claude' : 'You.com';
}

/** True when an AI provider can be called (ignores demo mode — lens.js decides that). */
export function available() {
  return provider() === 'claude' ? claude.hasKey() : you.hasKey();
}

/** Async variant that waits for the relay status (owner key) before answering. */
export async function availableAsync() {
  if (provider() === 'claude' && claude.hasKey()) return true;
  if (you.hasUserKey()) return true;
  const st = await you.status();
  if (st.envKey) return true;
  return claude.hasKey();
}

function normalizeMessages(messages, prompt) {
  const list = Array.isArray(messages) && messages.length ? messages : [{ role: 'user', content: prompt || '' }];
  const out = [];
  for (const m of list) {
    if (!m) continue;
    const content = typeof m.content === 'string' ? m.content : '';
    if (!content.trim()) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else out.push({ role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  if (!out.length) throw new Error('Nothing to send to the AI.');
  return out;
}

/** One input string with clear sections, for agents that only take `input`. */
export function foldInput(system, messages) {
  const parts = [];
  if (system) parts.push(`## Instructions\n${system.trim()}`);
  if (messages.length === 1) {
    parts.push(`## Request\n${messages[0].content.trim()}`);
  } else {
    parts.push(`## Conversation\n${messages.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content.trim()}`).join('\n\n')}`);
    parts.push('## Your turn\nReply as the assistant to the last user message.');
  }
  return parts.join('\n\n');
}

async function completeWithYou({ system, messages, maxTokens, signal, webSearch }) {
  const s = getState().settings || {};
  const agentId = String(s.youAgent || '').trim();
  const usesInputOnly = agentId && agentId !== 'router' && agentId !== 'chat';
  const opts = { maxTokens, signal, webSearch };
  if (usesInputOnly) {
    opts.agent = agentId;
    const out = await you.agent(foldInput(system, messages), opts);
    return out.text;
  }
  const out = await you.agent('', { ...opts, system, messages });
  return out.text;
}

/**
 * complete({ system, prompt | messages, maxTokens=1200, effort, signal, webSearch }) → assistant text.
 */
export async function complete({ system, messages, prompt, maxTokens = 1200, model, effort, signal, webSearch } = {}) {
  const p = provider();
  if (p === 'claude') return claude.complete({ system, messages, prompt, maxTokens, model, effort, signal });
  const msgs = normalizeMessages(messages, prompt);
  const text = await completeWithYou({ system, messages: msgs, maxTokens, signal, webSearch });
  return stripThinking(text);
}

function stripThinking(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * json({ system, prompt, schemaHint, maxTokens=2000, signal }) → parsed JSON.
 * Asks for JSON only, strips code fences, retries once with the parse error.
 */
export async function json({ system, prompt, schemaHint, maxTokens = 2000, model, effort, signal } = {}) {
  if (provider() === 'claude') return claude.json({ system, prompt, schemaHint, maxTokens, model, effort, signal });
  const sys = [
    system || 'You are a precise assistant.',
    'Respond with valid JSON only — no prose, no markdown fences, no commentary before or after.',
    schemaHint ? `The JSON must match this shape:\n${typeof schemaHint === 'string' ? schemaHint : JSON.stringify(schemaHint, null, 2)}` : '',
  ].filter(Boolean).join('\n\n');
  const messages = [{ role: 'user', content: String(prompt || '') }];
  const expect = typeof schemaHint === 'string' ? schemaHint.trim()[0] : Array.isArray(schemaHint) ? '[' : schemaHint ? '{' : undefined;
  const first = await completeWithYou({ system: sys, messages, maxTokens, signal });
  try {
    return extractJson(first, expect);
  } catch (e) {
    const retry = await completeWithYou({
      system: sys,
      messages: [
        ...messages,
        { role: 'assistant', content: first.slice(0, 4000) },
        { role: 'user', content: `That was not valid JSON (${e.message}). Reply again with only the JSON value, nothing else.` },
      ],
      maxTokens,
      signal,
    });
    try {
      return extractJson(retry, expect);
    } catch {
      throw new Error(`${providerLabel('you')} did not return valid JSON.`);
    }
  }
}

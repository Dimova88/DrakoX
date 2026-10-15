import type { ChatMessage } from './types.js';
import type { Provider } from './providers/types.js';
import { truncateMiddle } from './util.js';

/** Rough token estimate for a request (system + messages + tool schemas). */
export function estimateRequestTokens(system: string, messages: ChatMessage[], toolSchemaChars: number): number {
  let chars = system.length + toolSchemaChars;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else for (const p of m.content) chars += p.type === 'text' ? p.text.length : 1500 * 4; // images ≈ 1.5k tokens
    if (m.role === 'assistant') {
      for (const tc of m.toolCalls ?? []) chars += JSON.stringify(tc.args).length + tc.name.length + 20;
    }
  }
  return Math.ceil(chars / 4);
}

/** How many trailing messages to keep verbatim: from the last user message, never splitting tool calls from results. */
export function keepCount(messages: ChatMessage[], maxKeep = 8): number {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user') {
      lastUser = i;
      break;
    }
  }
  let start = lastUser >= 0 ? lastUser : messages.length;
  if (messages.length - start > maxKeep) start = messages.length - maxKeep;
  // never start on a tool result (its assistant tool call would be dropped)
  while (start < messages.length && messages[start]!.role === 'tool') start++;
  return messages.length - start;
}

function transcript(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n');
    if (m.role === 'user') lines.push(`USER: ${truncateMiddle(text, 6000)}`);
    else if (m.role === 'assistant') {
      if (text) lines.push(`ASSISTANT: ${truncateMiddle(text, 4000)}`);
      for (const tc of m.toolCalls ?? []) lines.push(`ASSISTANT called ${tc.name}(${truncateMiddle(JSON.stringify(tc.args), 600)})`);
    } else lines.push(`TOOL ${m.name}${m.isError ? ' (error)' : ''}: ${truncateMiddle(text, 1500)}`);
  }
  return lines.join('\n');
}

const SUMMARY_PROMPT = `You are summarizing a coding-agent session so the work can continue seamlessly with a fresh context window.
Write a dense, factual summary in markdown with these sections:
## Goal — what the user wants, including constraints and preferences
## Decisions — key technical decisions and why
## Files — every file read, created or modified (paths) and what changed
## Current state — what works, what is in progress, latest test/build results
## Problems — errors encountered and how they were (or were not) resolved
## Next steps — remaining tasks in order
Be specific: exact paths, function names, commands, error messages. Do not invent anything. Max ~900 words.`;

export async function summarize(provider: Provider, model: string, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const req = {
    model,
    system: SUMMARY_PROMPT,
    messages: [{ role: 'user' as const, content: `Summarize this session:\n\n${truncateMiddle(transcript(messages), 300_000)}` }],
    tools: [],
    maxTokens: 2500,
    signal,
  };
  let out = '';
  for await (const ev of provider.stream(req)) {
    if (ev.type === 'text') out += ev.delta;
  }
  return out.trim() || 'Summary unavailable.';
}

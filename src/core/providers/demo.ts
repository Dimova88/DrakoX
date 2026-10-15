import type { ChatMessage, ToolCall } from '../types.js';
import { sleep, uid } from '../util.js';
import type { ModelInfo, ModelRequest, Provider, StreamEvent } from './types.js';

/**
 * Offline, scripted demo "model". It needs no network and no API key, and drives the real
 * agent loop (tools, approvals, todos, diffs) so you can explore DrakoX before connecting
 * a real model. It is clearly labelled as a demo everywhere in the UI.
 */
export class DemoProvider implements Provider {
  readonly type = 'demo';
  constructor(
    readonly id: string = 'demo',
    private speed = 1,
  ) {}

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: 'drakox-demo', name: 'DrakoX Demo (offline, scripted)', contextWindow: 128_000, tools: true, free: true }];
  }

  /** Heuristic "Tab" completions so the editor experience can be tried offline. */
  async complete(opts: { prompt: string; suffix?: string }): Promise<string> {
    const lines = opts.prompt.split('\n');
    const line = lines.pop() ?? '';
    const prev = lines.filter((l) => l.trim()).pop() ?? '';
    const indent = /^\s*/.exec(line)?.[0] ?? '';
    const fn = /function\s+\w*\s*\(([^)]*)\)/.exec(lines.slice(-12).join('\n'));
    const params = fn?.[1]?.split(',').map((p) => p.trim().split(/[\s:=]/)[0]).filter(Boolean) ?? [];
    const rules: [RegExp, () => string][] = [
      [/function\s+\w*\($/, () => ') {\n  \n}'],
      [/\/\/\s*$/, () => ' TODO: handle the edge cases'],
      [/return\s*$/, () => (params.length >= 2 ? ` ${params[0]} + ${params[1]};` : params.length === 1 ? ` ${params[0]};` : ' result;')],
      [/console\.$/, () => "log('debug', value);"],
      [/import\s*$/, () => "{ useState } from 'react';"],
      [/if\s*\($/, () => 'value == null) {\n' + indent + '  return;\n' + indent + '}'],
      [/for\s*\($/, () => 'const item of items) {\n' + indent + '  console.log(item);\n' + indent + '}'],
      [/\.map\($/, () => '(item) => item.id)'],
      [/\.filter\($/, () => '(item) => Boolean(item))'],
      [/<div$/, () => ' className="container">'],
      [/def\s+\w*$/, () => '(self):\n' + indent + '    pass'],
      [/^\s*$/, () => (/[{:]\s*$/.test(prev) ? '// …continue here' : '')],
    ];
    for (const [re, make] of rules) if (re.test(line)) return make();
    return '';
  }

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    const toolNames = new Set(req.tools.map((t) => t.name));
    const lastUserIdx = findLastIndex(req.messages, (m) => m.role === 'user' && !isToolImageMessage(m));
    const userText = lastUserIdx >= 0 ? textOf(req.messages[lastUserIdx]!) : '';
    let step = req.messages.slice(lastUserIdx + 1).filter((m) => m.role === 'assistant').length;
    const results = req.messages.slice(lastUserIdx + 1).filter((m) => m.role === 'tool') as Extract<ChatMessage, { role: 'tool' }>[];
    const planResult = results.find((r) => r.name === 'submit_plan');
    if (planResult && /approved/i.test(textOf(planResult))) step -= 1;
    const inputChars = req.system.length + req.messages.reduce((n, m) => n + textOf(m).length, 0);

    // Non-agentic calls (compaction, reviews without tools, titles)
    if (!toolNames.size) {
      const text = /summar/i.test(req.system + userText)
        ? '## Summary\n- The user explored DrakoX in demo mode.\n- Files were inspected and a demo note may have been written.\n- Next step: connect a real model in Settings → Models.'
        : 'This is the offline DrakoX demo model. Connect a real model (Ollama, LM Studio, OpenRouter, Gemini, OpenAI, Anthropic, …) for real answers.';
      yield* this.say(text, req.signal);
      yield { type: 'done', stopReason: 'stop', usage: { inputTokens: Math.ceil(inputChars / 4), outputTokens: Math.ceil(text.length / 4) }, toolCalls: [] };
      return;
    }

    const intent = detectIntent(userText);
    const plan = buildPlan(intent);
    let text = '';
    let reasoning = '';
    const calls: ToolCall[] = [];
    const call = (name: string, args: Record<string, unknown>) => {
      if (toolNames.has(name)) calls.push({ id: uid('call_'), name, args });
    };

    const listing = results.find((r) => r.name === 'list_dir');
    const readResult = results.find((r) => r.name === 'read_file');
    const denied = results.some((r) => (r.isError && /denied|rejected/i.test(textOf(r))) || (r.name === 'submit_plan' && /rejected/i.test(textOf(r))));

    const done = (upTo: number) => plan.map((content, i) => ({ content, status: i < upTo ? 'completed' : i === upTo ? 'in_progress' : 'pending' }));
    const allDone = () => plan.map((content) => ({ content, status: 'completed' }));
    const finalStep = intent === 'explain' ? 3 : 4;

    if (denied) {
      text = "Understood — I won't make that change. Let me know if you'd like a different approach, or switch the mode to **Auto-edit** to let me apply edits without asking.";
    } else if (step === 0) {
      reasoning = `The user asked: "${truncate(userText, 120)}". I should orient myself first: list the project, then read the most relevant file before changing anything.`;
      text = "I'll start by getting oriented in the codebase, then work through a short plan.";
      call('todo_write', { todos: done(0) });
      call('list_dir', { path: '.', depth: 2 });
    } else if (step === 1) {
      const target = pickFile(listing ? textOf(listing) : '');
      reasoning = target ? `The listing shows ${target}; reading it will tell me what this project is about.` : 'There are no obvious entry files; I will continue with what I have.';
      text = target ? `Let me read \`${target}\` to understand the project.` : 'The workspace looks empty, which is fine for a demo.';
      call('todo_write', { todos: done(1) });
      if (target) call('read_file', { path: target });
    } else if (step === 2 && toolNames.has('submit_plan') && intent !== 'explain') {
      reasoning = 'Plan mode: I must not change anything yet. I will propose a concrete plan for approval.';
      text = "Here's my plan. Approve it and I'll implement it.";
      call('todo_write', { todos: done(2) });
      call('submit_plan', {
        plan: `## Plan\n\n**Goal:** ${truncate(userText, 160)}\n\n1. Create \`DRAKOX_DEMO.md\` summarizing the request and the workspace\n2. Verify the file with \`ls -la\`\n3. Report back with a summary\n\n**Risk:** low — a single new file, fully reversible with *Rewind*.`,
      });
    } else if (step === 2 && intent === 'explain') {
      text = 'I have what I need — writing up the explanation.';
      call('todo_write', { todos: allDone() });
    } else if (step === 2 && intent === 'test') {
      reasoning = 'To verify the project state I will run a harmless command and inspect the output.';
      text = 'Now let me run a quick check of the workspace.';
      call('todo_write', { todos: done(2) });
      call('bash', { command: 'ls -la', description: 'List workspace files' });
    } else if (step === 2) {
      reasoning = 'I have enough context. I will write a small, self-contained file so the change is easy to review and revert.';
      text = "I have enough context. I'll write the change as a new file so it's easy to review (and rewind) — DrakoX shows you the diff first.";
      call('todo_write', { todos: done(2) });
      call('write_file', { path: 'DRAKOX_DEMO.md', content: demoNote(userText, listing ? textOf(listing) : '') });
    } else if (step === 3 && intent === 'test') {
      text = 'Checks finished.';
      call('todo_write', { todos: allDone() });
    } else if (step === 3 && intent === 'build') {
      reasoning = 'Verify the result before reporting back.';
      text = 'Let me verify the workspace after the change.';
      call('todo_write', { todos: allDone() });
      call('bash', { command: 'ls -la', description: 'Verify the new file exists' });
    } else if (step >= finalStep) {
      text = intent === 'explain' ? explainProject(listing ? textOf(listing) : '', readResult ? textOf(readResult) : '', userText) : finalSummary(intent, results);
    }

    if (reasoning) {
      for (const chunk of chunks(reasoning)) {
        await sleep(6 / this.speed, req.signal);
        yield { type: 'reasoning', delta: chunk };
      }
    }
    yield* this.say(text, req.signal);
    for (const c of calls) yield { type: 'tool_call_start', id: c.id, name: c.name };
    yield {
      type: 'done',
      stopReason: calls.length ? 'tool_calls' : 'stop',
      usage: { inputTokens: Math.ceil(inputChars / 4), outputTokens: Math.ceil((text.length + reasoning.length + JSON.stringify(calls).length) / 4) },
      toolCalls: calls,
    };
  }

  private async *say(text: string, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    for (const chunk of chunks(text)) {
      await sleep(12 / this.speed, signal);
      yield { type: 'text', delta: chunk };
    }
  }
}

type Intent = 'explain' | 'test' | 'build';

function detectIntent(text: string): Intent {
  const t = text.toLowerCase();
  if (/\b(test|tests|lint|verify|check|typecheck|run)\b/.test(t) && !/\b(add|create|write|implement|build|make|generate|scaffold|fix)\b/.test(t)) return 'test';
  if (/\b(explain|what|how|why|describe|overview|summari[sz]e|understand|tell me|review)\b/.test(t)) return 'explain';
  return 'build';
}

function buildPlan(intent: Intent): string[] {
  if (intent === 'explain') return ['Explore the project structure', 'Read the key files', 'Explain the findings'];
  if (intent === 'test') return ['Explore the project structure', 'Read the project manifest', 'Run a verification command', 'Report results'];
  return ['Explore the project structure', 'Read the relevant files', 'Implement the change', 'Verify the result'];
}

function pickFile(listing: string): string | undefined {
  const files = listing
    .split('\n')
    .map((l) => l.replace(/^[\s│├└─]+/, '').trim())
    .filter((l) => l && !l.endsWith('/') && !l.startsWith('('));
  const prefer = ['README.md', 'readme.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'index.html', 'main.py'];
  for (const p of prefer) if (files.includes(p)) return p;
  return files.find((f) => /\.(ts|tsx|js|jsx|py|go|rs|md)$/.test(f));
}

function explainProject(listing: string, file: string, prompt: string): string {
  const entries = listing.split('\n').filter((l) => l.trim() && !l.startsWith('('));
  const dirs = entries.filter((l) => l.trim().endsWith('/')).map((l) => l.replace(/^[\s│├└─]+/, '').trim());
  const heading = file.match(/^\s*\d+\t#\s+(.+)$/m)?.[1];
  const nameMatch = file.match(/"name":\s*"([^"]+)"/)?.[1];
  const scripts = [...file.matchAll(/^\s*\d+\t\s*"(dev|build|test|start|lint)":\s*"([^"]+)"/gm)].map((m) => `\`${m[1]}\` → \`${m[2]}\``);
  return [
    `Here's what I found${prompt ? ' for your question' : ''}:`,
    '',
    `**Project:** ${heading ?? nameMatch ?? 'an unnamed project'}`,
    `**Top-level entries:** ${entries.length} (${dirs.length} directories${dirs.length ? `: ${dirs.slice(0, 6).map((d) => `\`${d}\``).join(', ')}` : ''})`,
    scripts.length ? `**Scripts:** ${scripts.join(', ')}` : '',
    '',
    '> ⚠️ This answer comes from the **offline demo model**, which follows a script. Connect a real model',
    '> (local Ollama / LM Studio for free & unlimited use, or any API key) in **Settings → Models** for real analysis.',
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}

function demoNote(prompt: string, listing: string): string {
  const entries = listing.split('\n').filter((l) => l.trim() && !l.startsWith('(')).slice(0, 12);
  return `# DrakoX demo note

This file was written by the **DrakoX offline demo model** to show how edits, approvals,
diffs and checkpoints work. Rewind the turn (or delete this file) to undo it.

## Your request

> ${prompt.replace(/\n/g, '\n> ')}

## Workspace snapshot

\`\`\`
${entries.join('\n') || '(empty workspace)'}
\`\`\`

## Next steps

1. Open **Settings → Models** and connect a real model:
   - **Free & unlimited (local):** Ollama or LM Studio
   - **Free tiers:** Gemini, Groq, OpenRouter \`:free\` models, GitHub Models, Mistral
   - **Bring your own key:** OpenAI, Anthropic, DeepSeek, xAI, …
2. Ask DrakoX again — the same tools, approvals and checkpoints will be used for real.
`;
}

function finalSummary(intent: Intent, results: Extract<ChatMessage, { role: 'tool' }>[]): string {
  const wrote = results.some((r) => r.name === 'write_file' && !r.isError);
  const ran = results.filter((r) => r.name === 'bash');
  const lines = ['Done! Here is a summary of this demo run:', ''];
  lines.push('- 🔎 Explored the workspace and read the most relevant file');
  if (wrote) lines.push('- ✍️ Created `DRAKOX_DEMO.md` (shown as a reviewable diff, checkpointed so you can rewind)');
  if (ran.length) lines.push(`- ✅ Ran \`ls -la\` to verify (${ran.some((r) => r.isError) ? 'with errors' : 'success'})`);
  if (intent === 'test') lines.push('- 🧪 Verification complete');
  lines.push('', '> This was the **offline demo model**. Connect a real model in **Settings → Models** to do real work — locally for free with Ollama/LM Studio, or with any provider key.');
  return lines.join('\n');
}

function chunks(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const n = 2 + Math.floor(Math.random() * 5);
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}

function textOf(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('\n');
}

function isToolImageMessage(m: ChatMessage): boolean {
  return m.role === 'user' && typeof m.content !== 'string' && m.content.some((p) => p.type === 'text' && p.text.startsWith('Image output from tool'));
}

function findLastIndex<T>(arr: T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return i;
  return -1;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

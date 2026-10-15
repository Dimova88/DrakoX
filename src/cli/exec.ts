import fs from 'node:fs';
import type { Runtime } from '../core/runtime.js';
import { Agent } from '../core/agent.js';
import type { AgentEvent, Mode } from '../core/types.js';
import { resolveSlash } from '../core/slash.js';
import { formatCost } from '../core/util.js';
import { c } from './ansi.js';
import { TerminalRenderer } from './render.js';
import { expandMentions } from './repl.js';

export interface ExecOptions {
  runtime: Runtime;
  prompt: string;
  model?: string;
  mode?: Mode;
  json?: boolean;
  autoApprove?: boolean;
  outputLastMessage?: string;
  resumeId?: string;
  quiet?: boolean;
}

/**
 * Non-interactive run (CI, scripts, pipelines). Progress goes to stderr, the final answer to stdout.
 * With --json every event is printed as one JSON line on stdout.
 * Actions that need approval are denied (with an explanation to the model) unless --yolo / autopilot.
 */
export async function runExec(o: ExecOptions): Promise<number> {
  const rt = o.runtime;
  const agent = o.resumeId
    ? await Agent.resume(rt, o.resumeId, { interactive: false, autoApprove: o.autoApprove, mode: o.mode, model: o.model })
    : await Agent.create({ runtime: rt, model: o.model, mode: o.mode ?? 'auto-edit', interactive: false, autoApprove: o.autoApprove });

  let prompt = o.prompt;
  let display: string | undefined;
  if (prompt.trim().startsWith('/')) {
    const res = await resolveSlash(rt, prompt.trim(), agent.cwd);
    if (res.type === 'prompt') {
      prompt = res.prompt;
      display = res.display;
      if (res.mode) agent.setMode(res.mode);
    } else if (res.type === 'error') {
      process.stderr.write(`${res.message}\n`);
      return 1;
    } else if (res.type === 'unknown') {
      process.stderr.write(`Unknown command /${res.name}\n`);
      return 1;
    } else {
      process.stderr.write(`/${res.name} is interactive-only.\n`);
      return 1;
    }
  }
  const { text, images } = expandMentions(prompt, agent.cwd);

  const renderer = new TerminalRenderer({ out: process.stderr as NodeJS.WriteStream });
  let finalText = '';
  agent.on('event', (e: AgentEvent) => {
    if (o.json) {
      if (e.type === 'text_delta' || e.type === 'reasoning_delta' || e.type === 'tool_output') return; // keep JSONL compact
      process.stdout.write(JSON.stringify(e) + '\n');
      return;
    }
    if (o.quiet) return;
    if (e.type === 'text_delta' || e.type === 'assistant_message' || e.type === 'assistant_start' || e.type === 'reasoning_delta') {
      // the final answer is printed to stdout below; stream progress text to stderr
      renderer.handle(e);
      return;
    }
    renderer.handle(e);
  });

  const onSigint = () => agent.abort();
  process.on('SIGINT', onSigint);
  const reason = await agent.send(text, { images: images.length ? images : undefined, displayText: display });
  process.off('SIGINT', onSigint);
  finalText = agent.lastAssistantText();

  if (!o.json) {
    renderer.spinner.stop();
    if (!o.quiet) process.stderr.write(c.dim(`\n— ${reason} · ${agent.model} · ${formatCost(agent.totals.costUsd, agent.totals.costPartial)} · session ${agent.id}\n`));
    if (!process.stdout.isTTY || o.quiet) process.stdout.write(finalText + (finalText.endsWith('\n') ? '' : '\n'));
  }
  if (o.outputLastMessage) fs.writeFileSync(o.outputLastMessage, finalText);
  await rt.dispose();
  return reason === 'completed' || reason === 'plan_submitted' ? 0 : reason === 'aborted' ? 130 : 1;
}

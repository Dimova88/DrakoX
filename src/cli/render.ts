import type { AgentEvent, ApprovalRequest, Todo, ToolDisplay } from '../core/types.js';
import { c, stripAnsi, termWidth } from './ansi.js';
import { formatCost, formatDuration, formatTokens } from '../core/util.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const KIND_ICON: Record<string, string> = {
  read: '◇',
  edit: '✎',
  execute: '❯',
  network: '◎',
  meta: '◆',
  mcp: '⬡',
};

/** Spinner on one terminal line; cleared before any other output. */
export class Spinner {
  private timer?: NodeJS.Timeout;
  private frame = 0;
  private text = '';
  private started = 0;
  private visible = false;
  constructor(private out: NodeJS.WriteStream = process.stdout) {}

  get active(): boolean {
    return Boolean(this.timer);
  }

  start(text: string): void {
    this.text = text;
    if (!this.out.isTTY) return;
    if (!this.timer) {
      this.started = Date.now();
      this.timer = setInterval(() => this.draw(), 80);
      this.timer.unref?.();
    }
    this.draw();
  }

  update(text: string): void {
    this.text = text;
  }

  private draw(): void {
    this.frame = (this.frame + 1) % FRAMES.length;
    const secs = Math.floor((Date.now() - this.started) / 1000);
    const line = `${c.brand(FRAMES[this.frame]!)} ${this.text} ${c.dim(`(${secs}s · esc to interrupt)`)}`;
    const max = termWidth() - 1;
    const plain = stripAnsi(line);
    this.out.write(`\r\x1b[2K${plain.length > max ? plain.slice(0, max - 1) + '…' : line}`);
    this.visible = true;
  }

  clear(): void {
    if (this.visible && this.out.isTTY) this.out.write('\r\x1b[2K');
    this.visible = false;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.clear();
  }
}

/** Light markdown styling, one line at a time (works while streaming). */
export class MarkdownLines {
  private inFence = false;
  private fenceLang = '';

  render(line: string): string {
    const fence = /^\s*```(\S*)/.exec(line);
    if (fence) {
      this.inFence = !this.inFence;
      this.fenceLang = this.inFence ? fence[1] ?? '' : '';
      return c.dim(this.inFence ? `╭─ ${this.fenceLang || 'code'}` : '╰─');
    }
    if (this.inFence) return `${c.dim('│')} ${c.hunk(line)}`;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) return h[1]!.length <= 2 ? c.bold(c.brand(inline(h[2]!))) : c.bold(inline(h[2]!));
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) return `${c.dim('│')} ${c.italic(inline(quote[1]!))}`;
    const bullet = /^(\s*)[-*+]\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (bullet) {
      const box = bullet[2] ? (/x/i.test(bullet[2]) ? c.ok('☑ ') : '☐ ') : '';
      return `${bullet[1]}${c.brand('•')} ${box}${inline(bullet[3]!)}`;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) return c.dim('─'.repeat(Math.min(40, termWidth() - 4)));
    return inline(line);
  }

  reset(): void {
    this.inFence = false;
  }
}

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_, x) => c.hunk(x))
    .replace(/\*\*([^*]+)\*\*/g, (_, x) => c.bold(x))
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, (_, p, x) => p + c.italic(x))
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, t, u) => `${c.underline(t)} ${c.dim(`(${u})`)}`);
}

export function colorDiff(diff: string, maxLines = 40): string {
  const lines = diff.split('\n').filter((l) => !l.startsWith('Index:') && !/^={10,}/.test(l));
  const out: string[] = [];
  for (const l of lines.slice(0, maxLines)) {
    if (l.startsWith('+++') || l.startsWith('---')) out.push(c.dim(l));
    else if (l.startsWith('+')) out.push(c.added(l));
    else if (l.startsWith('-')) out.push(c.removed(l));
    else if (l.startsWith('@@')) out.push(c.hunk(l));
    else out.push(c.dim(l));
  }
  if (lines.length > maxLines) out.push(c.dim(`… ${lines.length - maxLines} more lines`));
  return out.join('\n');
}

export function renderTodos(todos: Todo[]): string {
  if (!todos.length) return '';
  return todos
    .map((t) => {
      if (t.status === 'completed') return `  ${c.ok('☑')} ${c.dim(c.strike(t.content))}`;
      if (t.status === 'in_progress') return `  ${c.warn('◐')} ${c.bold(t.activeForm || t.content)}`;
      return `  ${c.dim('☐')} ${t.content}`;
    })
    .join('\n');
}

export function indent(text: string, pad = '    '): string {
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

export function box(title: string, body: string, color: (s: string) => string = c.brand): string {
  const width = Math.min(termWidth() - 2, 110);
  const top = color(`╭─ ${title} ${'─'.repeat(Math.max(0, width - stripAnsi(title).length - 5))}╮`);
  const lines = body.split('\n').map((l) => {
    const plain = stripAnsi(l);
    const clipped = plain.length > width - 4 ? `${l.slice(0, width - 5)}…` : l;
    return `${color('│')} ${clipped}`;
  });
  const bottom = color(`╰${'─'.repeat(width - 2)}╯`);
  return [top, ...lines, bottom].join('\n');
}

export function approvalCard(req: ApprovalRequest): string {
  const body: string[] = [];
  body.push(c.bold(req.title));
  body.push(c.dim(req.reason));
  if (req.detail) {
    body.push('');
    const detail = req.detail.length > 6000 ? `${req.detail.slice(0, 6000)}\n…` : req.detail;
    body.push(/^(---|\+\+\+|@@|Index:)/m.test(detail) ? colorDiff(detail, 30) : req.kind === 'execute' ? c.white(detail) : c.dim(detail));
  }
  body.push('');
  body.push(
    `${c.bold(c.ok('y'))} allow once   ${c.bold(c.ok('a'))} always${req.ruleSuggestion ? c.dim(` (${req.ruleSuggestion})`) : ''}   ${c.bold(c.err('n'))} deny   ${c.bold(c.warn('f'))} deny + tell DrakoX why`,
  );
  return box(`Permission · ${req.tool}`, body.join('\n'), c.warn);
}

function resultSummary(name: string, isError: boolean, content: unknown, display?: ToolDisplay): string {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p: any) => (p.type === 'text' ? p.text : `[${p.type}]`)).join(' ') : '';
  if (isError) {
    const first = text.split('\n').slice(0, 4).join('\n');
    return c.err(first.length > 600 ? first.slice(0, 600) + '…' : first);
  }
  if (display?.kind === 'diff') {
    const verb = display.isNew ? 'Created' : display.isDelete ? 'Deleted' : 'Updated';
    return `${verb} ${c.bold(display.path)} ${c.added(`+${display.added}`)} ${c.removed(`−${display.removed}`)}`;
  }
  if (display?.kind === 'terminal') {
    const lines = display.output.trimEnd().split('\n').filter(Boolean);
    const status = display.background ? c.accent('running in background') : display.exitCode === 0 ? c.ok('exit 0') : c.err(`exit ${display.exitCode ?? '?'}`);
    return `${status}${lines.length ? c.dim(` · ${lines.length} line${lines.length === 1 ? '' : 's'}`) : ''}`;
  }
  const first = text.split('\n').find((l) => l.trim()) ?? '';
  return c.dim(first.length > 140 ? first.slice(0, 140) + '…' : first || `${name} done`);
}

export interface RendererOptions {
  showReasoning?: boolean;
  verbose?: boolean;
  out?: NodeJS.WriteStream;
}

/** Renders the agent event stream for a terminal. */
export class TerminalRenderer {
  readonly spinner: Spinner;
  private out: NodeJS.WriteStream;
  private md = new MarkdownLines();
  private lineBuf = '';
  private streaming = false;
  private atBullet = false;
  private reasoningChars = 0;
  private toolTitles = new Map<string, string>();
  private lastOutputLine = new Map<string, string>();

  constructor(private opts: RendererOptions = {}) {
    this.out = opts.out ?? process.stdout;
    this.spinner = new Spinner(this.out);
  }

  print(text = ''): void {
    this.spinner.clear();
    this.out.write(text + '\n');
  }

  private writeLine(line: string): void {
    this.spinner.clear();
    const pad = this.atBullet ? '' : '  ';
    this.atBullet = false;
    this.out.write(`${pad}${this.md.render(line)}\n`);
  }

  private flushLine(final = false): void {
    if (this.lineBuf) this.writeLine(this.lineBuf);
    else if (final && this.atBullet) {
      this.out.write('\n');
      this.atBullet = false;
    }
    this.lineBuf = '';
  }

  endStream(): void {
    if (this.streaming) {
      this.flushLine(true);
      this.streaming = false;
      this.md.reset();
    }
  }

  handle(e: AgentEvent): void {
    switch (e.type) {
      case 'assistant_start':
        this.reasoningChars = 0;
        this.spinner.start(c.dim('Thinking…'));
        break;
      case 'reasoning_delta':
        this.reasoningChars += e.delta.length;
        if (this.opts.showReasoning) {
          this.spinner.clear();
          this.out.write(c.dim(c.italic(e.delta)));
        } else this.spinner.update(c.dim(`Thinking… ${c.italic(`${formatTokens(Math.round(this.reasoningChars / 4))} reasoning tokens`)}`));
        break;
      case 'text_delta': {
        if (!this.streaming) {
          this.spinner.stop();
          this.streaming = true;
          this.atBullet = true;
          this.out.write(`${c.brand('●')} `);
          this.lineBuf = '';
          this.pushText(e.delta.replace(/^\s*\n/, ''));
          break;
        }
        this.pushText(e.delta);
        break;
      }
      case 'assistant_message':
        this.endStream();
        this.spinner.stop();
        break;
      case 'tool_start': {
        this.endStream();
        this.spinner.stop();
        this.toolTitles.set(e.id, e.title);
        const icon = KIND_ICON[e.kind] ?? '◆';
        const color = e.kind === 'edit' ? c.warn : e.kind === 'execute' ? c.accent : e.kind === 'mcp' ? c.hunk : c.gray;
        this.print(`  ${color(icon)} ${c.bold(e.title)}`);
        if (e.kind === 'execute' || e.kind === 'network' || e.kind === 'mcp' || e.name === 'task') this.spinner.start(c.dim(e.title));
        break;
      }
      case 'tool_output': {
        const last = e.delta.trimEnd().split('\n').pop();
        if (last?.trim()) {
          this.lastOutputLine.set(e.id, last);
          const title = this.toolTitles.get(e.id) ?? '';
          this.spinner.update(`${c.dim(title)} ${c.gray('· ' + stripAnsi(last).slice(0, 80))}`);
        }
        if (this.opts.verbose) {
          this.spinner.clear();
          this.out.write(c.dim(e.delta));
        }
        break;
      }
      case 'tool_result': {
        this.spinner.stop();
        const summary = resultSummary(e.name, e.isError, e.content, e.display);
        this.print(`    ${c.dim('⎿')} ${summary.split('\n').join('\n      ')}`);
        if (!e.isError && e.display) this.printDisplay(e.display);
        break;
      }
      case 'approval_response':
        if (e.auto && e.decision === 'deny') this.print(`    ${c.err('⊘')} ${c.dim(e.feedback ?? 'denied by policy')}`);
        else if (e.auto && e.feedback && this.opts.verbose) this.print(`    ${c.dim(`✓ ${e.feedback}`)}`);
        break;
      case 'todos':
        this.endStream();
        this.print(renderTodos(e.todos));
        break;
      case 'compaction':
        this.print(c.dim(`  ⟲ Compacted ${e.removedMessages} earlier messages into a summary (kept ${e.keptMessages}).`));
        break;
      case 'rewind':
        this.print(c.accent(`  ↶ Rewound to before turn ${e.toTurn}${e.restoredFiles.length ? ` · restored ${e.restoredFiles.length} file(s)` : ''}`));
        break;
      case 'notice': {
        this.endStream();
        const icon = e.level === 'warning' ? c.warn('⚠') : e.level === 'error' ? c.err('✗') : c.accent('ℹ');
        this.print(`  ${icon} ${e.level === 'info' ? c.dim(e.message) : e.message}`);
        break;
      }
      case 'error':
        this.endStream();
        this.spinner.stop();
        this.print(`  ${c.err('✗')} ${c.err(e.message)}`);
        break;
      case 'artifact':
        if (e.artifact.kind === 'review' && e.artifact.markdown) {
          this.endStream();
          this.print(box(`${e.artifact.title}`, e.artifact.markdown.split('\n').map((l) => this.md.render(l)).join('\n'), c.accent));
        }
        break;
      case 'subagent':
        this.renderSubagent(e);
        break;
      case 'turn_end':
        this.endStream();
        this.spinner.stop();
        if (e.reason === 'aborted') this.print(c.warn('  ⏹ Interrupted. Tell DrakoX what to do instead.'));
        break;
      default:
        break;
    }
  }

  private pushText(delta: string): void {
    const parts = (this.lineBuf + delta).split('\n');
    this.lineBuf = parts.pop() ?? '';
    for (const p of parts) this.writeLine(p);
  }

  private printDisplay(d: ToolDisplay): void {
    if (d.kind === 'diff') this.print(indent(colorDiff(d.diff.split('\n').filter((l) => !l.startsWith('---') && !l.startsWith('+++')).join('\n'), 24), '      '));
    else if (d.kind === 'terminal') {
      const lines = d.output.trimEnd().split('\n').filter((l) => l.length);
      if (!lines.length) return;
      const show = d.exitCode === 0 ? lines.slice(-5) : lines.slice(-12);
      if (lines.length > show.length) this.print(c.dim(`      … ${lines.length - show.length} lines above`));
      this.print(indent(show.map((l) => c.dim(l.length > termWidth() - 8 ? l.slice(0, termWidth() - 9) + '…' : l)).join('\n'), '      '));
    } else if (d.kind === 'multi') for (const x of d.items) this.printDisplay(x);
  }

  private renderSubagent(e: Extract<AgentEvent, { type: 'subagent' }>): void {
    const inner = e.event;
    const tag = c.accent(`↳ ${e.agent}`);
    switch (inner.type) {
      case 'tool_start':
        this.spinner.update(`${tag} ${c.dim(inner.title)}`);
        if (this.opts.verbose) this.print(`      ${tag} ${c.dim(inner.title)}`);
        break;
      case 'tool_result':
        if (inner.isError && this.opts.verbose) this.print(`      ${tag} ${c.err('✗')} ${c.dim(String(typeof inner.content === 'string' ? inner.content : '').split('\n')[0])}`);
        break;
      case 'approval_request':
        break; // handled by the REPL
      case 'turn_end':
        this.print(`      ${tag} ${inner.reason === 'completed' ? c.ok('done') : c.warn(inner.reason)}`);
        break;
      case 'error':
        this.print(`      ${tag} ${c.err(inner.message)}`);
        break;
      case 'subagent':
        break;
      default:
        break;
    }
  }
}

export function statusLine(s: { model: string; mode: string; contextTokens: number; contextWindow: number; costUsd: number; costPartial?: boolean; durationMs?: number }): string {
  const pct = s.contextWindow ? Math.min(100, Math.round((s.contextTokens / s.contextWindow) * 100)) : 0;
  const ctxColor = pct > 80 ? c.err : pct > 60 ? c.warn : c.dim;
  const parts = [c.dim(s.model), ctxColor(`ctx ${pct}%`), c.dim(formatCost(s.costUsd, s.costPartial))];
  if (s.durationMs) parts.push(c.dim(formatDuration(s.durationMs)));
  return parts.join(c.dim(' · '));
}

import { spawn, type ChildProcess } from 'node:child_process';
import { defaultShell, wrapCommand } from '../sandbox.js';
import { truncateMiddle, uid } from '../util.js';
import { errorResult, textResult, type Tool, type ToolContext } from './types.js';

const MAX_OUTPUT_FOR_MODEL = 30_000;
const MAX_CAPTURE = 2_000_000;

interface ShellRun {
  child: ChildProcess;
  promise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function startShell(command: string, ctx: Pick<ToolContext, 'cwd' | 'config' | 'sandbox' | 'projectRoot'>, onData: (s: string) => void): ShellRun {
  const { shell, args } = defaultShell(ctx.config.shell);
  const wrapped = wrapCommand(shell, args(command), ctx.sandbox, ctx.cwd, [ctx.cwd, ctx.projectRoot]);
  const child = spawn(wrapped.cmd, wrapped.args, {
    cwd: ctx.cwd,
    env: {
      ...process.env,
      DRAKOX: '1',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
      NO_COLOR: process.env.NO_COLOR ?? '1',
      FORCE_COLOR: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  child.stdout?.on('data', (d: Buffer) => onData(d.toString('utf8')));
  child.stderr?.on('data', (d: Buffer) => onData(d.toString('utf8')));
  const promise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('error', (err) => {
      onData(`\n[failed to start: ${err.message}]\n`);
      resolve({ code: 127, signal: null });
    });
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, promise };
}

export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.exitCode !== null || child.killed) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* gone */
    }
  }
}

// ───────────────────────────── background shells ─────────────────────────────

interface BgShell {
  id: string;
  command: string;
  child: ChildProcess;
  output: string;
  readOffset: number;
  exitCode: number | null | undefined;
  startedAt: number;
}

export class BackgroundShells {
  private shells = new Map<string, BgShell>();

  start(command: string, ctx: Pick<ToolContext, 'cwd' | 'config' | 'sandbox' | 'projectRoot'>): BgShell {
    const id = uid('sh_');
    const entry: BgShell = { id, command, child: null as unknown as ChildProcess, output: '', readOffset: 0, exitCode: undefined, startedAt: Date.now() };
    const run = startShell(command, ctx, (d) => {
      entry.output += d;
      if (entry.output.length > MAX_CAPTURE) {
        const drop = entry.output.length - MAX_CAPTURE;
        entry.output = entry.output.slice(drop);
        entry.readOffset = Math.max(0, entry.readOffset - drop);
      }
    });
    entry.child = run.child;
    run.promise.then((r) => (entry.exitCode = r.code ?? (r.signal ? 128 : null)));
    this.shells.set(id, entry);
    return entry;
  }

  get(id: string): BgShell | undefined {
    return this.shells.get(id);
  }

  list(): { id: string; command: string; running: boolean; exitCode: number | null | undefined; startedAt: number }[] {
    return [...this.shells.values()].map((s) => ({ id: s.id, command: s.command, running: s.exitCode === undefined, exitCode: s.exitCode, startedAt: s.startedAt }));
  }

  kill(id: string): boolean {
    const s = this.shells.get(id);
    if (!s) return false;
    killTree(s.child);
    setTimeout(() => killTree(s.child, 'SIGKILL'), 2000).unref();
    return true;
  }

  killAll(): void {
    for (const s of this.shells.values()) killTree(s.child, 'SIGKILL');
  }
}

// ───────────────────────────── tools ─────────────────────────────

export const bashTool: Tool<{ command: string; timeout_ms?: number; run_in_background?: boolean; description?: string }> = {
  name: 'bash',
  kind: 'execute',
  description:
    'Run a shell command in the workspace. Use for builds, tests, git, package managers and scripts. Output is captured (stdout+stderr). ' +
    'Default timeout 120s (max 600s). Set run_in_background for dev servers/watchers, then use bash_output to read their output. ' +
    'Prefer read_file/grep/glob over cat/grep/find. Do not use interactive commands.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to run' },
      description: { type: 'string', description: 'Short description of what the command does (5-10 words)' },
      timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 120000, max 600000)' },
      run_in_background: { type: 'boolean', description: 'Start without waiting (servers, watchers)' },
    },
    required: ['command'],
  },
  title: (a) => (a.description ? `${a.description}` : `Run ${a.command}`),
  command: (a) => String(a.command ?? ''),
  async run(a, ctx) {
    const command = String(a.command ?? '').trim();
    if (!command) return errorResult('"command" is required');
    if (a.run_in_background) {
      const bg = ctx.shells.start(command, ctx);
      await new Promise((r) => setTimeout(r, 1500));
      const early = bg.output.slice(0, 4000);
      bg.readOffset = bg.output.length;
      const status = bg.exitCode === undefined ? 'running' : `exited with code ${bg.exitCode}`;
      return textResult(`Started background process ${bg.id} (${status}).\nInitial output:\n${early || '(none yet)'}\nUse bash_output with id "${bg.id}" to read more, bash_kill to stop it.`, {
        kind: 'terminal',
        command,
        exitCode: bg.exitCode ?? null,
        output: early,
        background: true,
      });
    }
    const timeout = Math.min(600_000, Math.max(1000, a.timeout_ms ?? 120_000));
    let output = '';
    const run = startShell(command, ctx, (d) => {
      if (output.length < MAX_CAPTURE) output += d;
      ctx.output(d);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(run.child);
      setTimeout(() => killTree(run.child, 'SIGKILL'), 2000).unref();
    }, timeout);
    const onAbort = () => {
      killTree(run.child);
      setTimeout(() => killTree(run.child, 'SIGKILL'), 1500).unref();
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const { code, signal } = await run.promise;
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);
    const exitCode = code ?? (signal ? 128 : null);
    const clean = stripAnsi(output);
    const forModel = truncateMiddle(clean, MAX_OUTPUT_FOR_MODEL);
    const suffix = timedOut ? `\n[timed out after ${timeout}ms and was killed]` : ctx.signal.aborted ? '\n[interrupted by user]' : '';
    const header = exitCode === 0 ? '' : `Exit code ${exitCode}${signal ? ` (signal ${signal})` : ''}\n`;
    return {
      content: `${header}${forModel || '(no output)'}${suffix}`,
      isError: exitCode !== 0,
      display: { kind: 'terminal', command, exitCode, output: truncateMiddle(clean, 20_000) },
    };
  },
};

export const bashOutputTool: Tool<{ id: string }> = {
  name: 'bash_output',
  kind: 'read',
  parallelSafe: true,
  description: 'Read new output from a background process started with bash run_in_background.',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  title: (a) => `Read output of ${a.id}`,
  async run(a, ctx) {
    const s = ctx.shells.get(a.id);
    if (!s) return errorResult(`No background process "${a.id}". Active: ${ctx.shells.list().map((x) => x.id).join(', ') || 'none'}`);
    const fresh = s.output.slice(s.readOffset);
    s.readOffset = s.output.length;
    const status = s.exitCode === undefined ? 'running' : `exited (code ${s.exitCode})`;
    return textResult(`[${s.id}: ${status}]\n${truncateMiddle(stripAnsi(fresh), MAX_OUTPUT_FOR_MODEL) || '(no new output)'}`);
  },
};

export const bashKillTool: Tool<{ id: string }> = {
  name: 'bash_kill',
  kind: 'execute',
  description: 'Stop a background process started with bash run_in_background.',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  title: (a) => `Stop ${a.id}`,
  command: () => 'kill',
  async run(a, ctx) {
    return ctx.shells.kill(a.id) ? textResult(`Stopped ${a.id}.`) : errorResult(`No background process "${a.id}".`);
  },
};

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r(?!\n)/g, '\n');
}

import { spawn } from 'node:child_process';
import type { DrakoxConfig, HookConfig, HookEvent } from './types.js';
import { defaultShell } from './sandbox.js';

/**
 * Lifecycle hooks: deterministic shell commands at agent events (formatters, linters, policy checks).
 * The hook receives a JSON payload on stdin. Exit code 2 (or stdout JSON {"decision":"block"})
 * blocks the action and the reason (stderr / "reason") is shown to the model.
 * Claude Code's nested format { matcher, hooks: [{ type: "command", command }] } is also accepted.
 */
export interface HookOutcome {
  blocked: boolean;
  reason?: string;
  /** Extra context to add for the model (stdout of UserPromptSubmit / SessionStart hooks) */
  context?: string;
}

export function normalizeHooks(config: DrakoxConfig): Partial<Record<HookEvent, HookConfig[]>> {
  const out: Partial<Record<HookEvent, HookConfig[]>> = {};
  for (const [event, list] of Object.entries(config.hooks ?? {})) {
    const flat: HookConfig[] = [];
    for (const h of (list ?? []) as any[]) {
      if (Array.isArray(h?.hooks)) {
        for (const inner of h.hooks) if (inner?.command) flat.push({ matcher: h.matcher, command: inner.command, timeoutMs: inner.timeout ? inner.timeout * 1000 : undefined });
      } else if (h?.command) flat.push(h);
    }
    out[event as HookEvent] = flat;
  }
  return out;
}

const CLAUDE_NAMES: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  bash: 'Bash',
  glob: 'Glob',
  grep: 'Grep',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  todo_write: 'TodoWrite',
  task: 'Task',
};

export async function runHooks(
  event: HookEvent,
  config: DrakoxConfig,
  payload: Record<string, unknown>,
  opts: { cwd: string; toolName?: string; trusted: boolean },
): Promise<HookOutcome> {
  const hooks = normalizeHooks(config)[event] ?? [];
  if (!hooks.length) return { blocked: false };
  const contexts: string[] = [];
  for (const h of hooks) {
    if (opts.toolName && h.matcher) {
      let re: RegExp;
      try {
        re = new RegExp(`^(?:${h.matcher})$`);
      } catch {
        continue;
      }
      if (!re.test(opts.toolName) && !re.test(CLAUDE_NAMES[opts.toolName] ?? '')) continue;
    }
    const res = await execHook(h, { hook_event_name: event, ...payload }, opts.cwd);
    if (res.code === 2) return { blocked: true, reason: res.stderr.trim() || res.stdout.trim() || `Blocked by ${event} hook` };
    try {
      const j = JSON.parse(res.stdout);
      if (j?.decision === 'block' || j?.continue === false) return { blocked: true, reason: j.reason ?? j.stopReason ?? `Blocked by ${event} hook` };
      if (typeof j?.additionalContext === 'string') contexts.push(j.additionalContext);
    } catch {
      if (res.stdout.trim() && (event === 'UserPromptSubmit' || event === 'SessionStart')) contexts.push(res.stdout.trim());
    }
  }
  return { blocked: false, context: contexts.join('\n') || undefined };
}

function execHook(h: HookConfig, payload: Record<string, unknown>, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { shell, args } = defaultShell();
  return new Promise((resolve) => {
    const child = spawn(shell, args(h.command), { cwd, env: { ...process.env, DRAKOX_HOOK: '1', DRAKOX_PROJECT_DIR: cwd }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), h.timeoutMs ?? 60_000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

import path from 'node:path';
import type { DrakoxConfig, Mode } from './types.js';
import type { SandboxInfo } from './sandbox.js';
import type { Tool } from './tools/types.js';
import { normalizeToolName } from './tools/index.js';
import { globToRegExp, isPlainObject, wildcardMatch } from './util.js';
import { isInside, toPosix } from './paths.js';

export type PermissionAction = 'allow' | 'ask' | 'deny';

export interface PermissionDecision {
  action: PermissionAction;
  reason: string;
  /** Rule that produced the decision, if any */
  rule?: string;
  /** Rule to add if the user chooses "always allow" */
  suggestion?: string;
}

export interface PermissionContext {
  cwd: string;
  projectRoot: string;
  mode: Mode;
  sandbox: SandboxInfo;
  config: DrakoxConfig;
  /** Rules granted during this session ("always allow") */
  sessionAllow: string[];
}

// ───────────────────────────── rules ─────────────────────────────

interface ParsedRule {
  tool: string;
  pattern?: string;
  raw: string;
}

export function parseRule(raw: string): ParsedRule {
  const m = raw.trim().match(/^([^()]+?)(?:\((.*)\))?$/s);
  if (!m) return { tool: raw.trim(), raw };
  const tool = normalizeToolName(m[1]!.trim());
  let pattern = m[2]?.trim();
  if (pattern?.endsWith(':*')) pattern = pattern.slice(0, -2) + '*'; // Claude Code style `npm run test:*`
  return { tool, pattern: pattern || undefined, raw };
}

function toolMatches(ruleTool: string, toolName: string): boolean {
  if (ruleTool === toolName) return true;
  if (ruleTool.includes('*')) return wildcardMatch(ruleTool, toolName);
  // `edit` rules cover all editing tools, `read` all reading tools (convenience aliases)
  if (ruleTool === 'edit') return ['edit_file', 'write_file', 'apply_patch'].includes(toolName);
  if (ruleTool === 'read') return ['read_file', 'list_dir', 'glob', 'grep'].includes(toolName);
  return false;
}

interface Subject {
  command?: string;
  paths?: string[];
  url?: string;
}

function ruleMatches(rule: ParsedRule, tool: Tool, subject: Subject, ctx: PermissionContext): { matched: boolean; explicit: boolean } {
  if (!toolMatches(rule.tool, tool.name)) return { matched: false, explicit: false };
  if (!rule.pattern) return { matched: true, explicit: false };
  if (subject.command !== undefined) {
    // every segment of a compound command must match for an allow rule to apply
    const segs = splitSegments(subject.command);
    if (!segs.ok) return { matched: false, explicit: false };
    const all = segs.segments.every((s) => wildcardMatch(rule.pattern!, s));
    return { matched: all || wildcardMatch(rule.pattern, subject.command.trim()), explicit: true };
  }
  if (subject.paths?.length) {
    const re = globToRegExp(rule.pattern);
    const ok = subject.paths.every((p) => {
      const rel = toPosix(path.relative(ctx.projectRoot, p));
      return re.test(rel) || re.test(toPosix(p));
    });
    return { matched: ok, explicit: true };
  }
  if (subject.url !== undefined) return { matched: wildcardMatch(rule.pattern, subject.url), explicit: true };
  return { matched: false, explicit: false };
}

// ───────────────────────────── command analysis ─────────────────────────────

/** Split a shell command into simple segments on unquoted ; && || | and newlines. */
export function splitSegments(cmd: string): { ok: boolean; segments: string[]; dangerous: string[] } {
  const segments: string[] = [];
  const dangerous: string[] = [];
  let cur = '';
  let q: '' | "'" | '"' = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    const n = cmd[i + 1];
    if (q === "'") {
      if (c === "'") q = '';
      cur += c;
      continue;
    }
    if (c === '\\' && n !== undefined) {
      cur += c + n;
      i++;
      continue;
    }
    if (q === '"') {
      if (c === '"') q = '';
      else if (c === '`' || (c === '$' && n === '(')) dangerous.push('command substitution');
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      continue;
    }
    if (c === '`' || (c === '$' && n === '(')) dangerous.push('command substitution');
    if ((c === '<' || c === '>') && n === '(') dangerous.push('process substitution');
    if (c === '>') {
      dangerous.push('output redirection');
      cur += c;
      continue;
    }
    if (c === ';' || c === '\n' || (c === '&' && n === '&') || (c === '|' && n === '|') || c === '|') {
      if (cur.trim()) segments.push(cur.trim());
      cur = '';
      if ((c === '&' && n === '&') || (c === '|' && n === '|')) i++;
      continue;
    }
    if (c === '&') {
      dangerous.push('background job');
      if (cur.trim()) segments.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (q) return { ok: false, segments: [], dangerous: ['unbalanced quotes'] };
  if (cur.trim()) segments.push(cur.trim());
  return { ok: true, segments, dangerous };
}

function tokens(seg: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  // drop leading env assignments FOO=bar
  while (out.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0]!)) out.shift();
  return out;
}

const SAFE_COMMANDS = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'printf', 'which', 'whoami', 'date', 'file', 'stat', 'du', 'df', 'tree',
  'basename', 'dirname', 'realpath', 'readlink', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'true', 'false', 'test', 'type',
  'uname', 'hostname', 'id', 'nproc', 'uptime', 'rg', 'grep', 'egrep', 'fgrep', 'find', 'fd', 'jq', 'md5sum', 'sha1sum',
  'sha256sum', 'shasum', 'column', 'nl', 'rev', 'seq', 'cd', 'ps', 'lsof', 'free', 'printenv',
]);

const SAFE_SUB: Record<string, (args: string[]) => boolean> = {
  git: (a) => {
    const sub = a[0];
    const rest = a.slice(1);
    if (!sub) return false;
    if (['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'grep', 'reflog', 'cat-file', 'ls-tree', 'merge-base', 'show-ref', 'count-objects', 'whatchanged'].includes(sub)) {
      return !rest.some((x) => /^--output/.test(x));
    }
    if (sub === 'branch') return rest.every((x) => ['-a', '-r', '-v', '-vv', '--list', '--show-current', '--all', '--remotes', '--merged', '--no-merged', '--contains'].includes(x) || !x.startsWith('-')) && !rest.some((x) => /^-[dDmMcC]$|^--(delete|move|copy|force)/.test(x)) && rest.filter((x) => !x.startsWith('-')).length === 0;
    if (sub === 'remote') return rest.length === 0 || rest.every((x) => ['-v', '--verbose', 'show', 'get-url'].includes(x) || !x.startsWith('-')) && ['-v', '--verbose', 'show', 'get-url', undefined].includes(rest[0]);
    if (sub === 'tag') return rest.length === 0 || ['-l', '--list'].includes(rest[0]!);
    if (sub === 'stash') return rest[0] === 'list' || rest[0] === 'show';
    if (sub === 'config') return rest[0] === '--get' || rest[0] === '--list' || rest[0] === '-l';
    if (sub === 'worktree') return rest[0] === 'list';
    return false;
  },
  npm: (a) => ['ls', 'list', 'view', 'info', 'outdated', '--version', '-v', 'help', 'why', 'explain', 'root', 'prefix'].includes(a[0] ?? '') || (a[0] === 'config' && a[1] === 'get'),
  pnpm: (a) => ['ls', 'list', 'why', '--version', '-v', 'outdated'].includes(a[0] ?? ''),
  yarn: (a) => ['list', 'why', '--version', '-v', 'info'].includes(a[0] ?? ''),
  bun: (a) => ['--version', 'pm'].includes(a[0] ?? '') && (a[0] !== 'pm' || a[1] === 'ls'),
  node: (a) => a.length === 1 && ['--version', '-v'].includes(a[0]!),
  python: (a) => a.length === 1 && ['--version', '-V'].includes(a[0]!),
  python3: (a) => a.length === 1 && ['--version', '-V'].includes(a[0]!),
  pip: (a) => ['list', 'show', 'freeze', '--version'].includes(a[0] ?? ''),
  go: (a) => ['version', 'env', 'list', 'doc'].includes(a[0] ?? ''),
  cargo: (a) => ['--version', 'tree', 'metadata'].includes(a[0] ?? ''),
  rustc: (a) => a[0] === '--version',
  docker: (a) => ['ps', 'images', 'version', 'info'].includes(a[0] ?? '') || (a[0] === 'logs' && a.length >= 2),
  kubectl: (a) => ['get', 'describe', 'version', 'logs', 'explain', 'api-resources'].includes(a[0] ?? ''),
  gh: (a) => (['pr', 'issue', 'repo', 'run', 'release'].includes(a[0] ?? '') && ['view', 'list', 'diff', 'checks', 'status'].includes(a[1] ?? '')) || a[0] === 'status',
};

/** True when every segment is a known read-only command with no redirection/substitution. */
export function isSafeCommand(cmd: string): boolean {
  const { ok, segments, dangerous } = splitSegments(cmd);
  if (!ok || dangerous.length || !segments.length) return false;
  return segments.every((seg) => {
    const t = tokens(seg);
    const bin = t[0];
    if (!bin) return false;
    const base = path.basename(bin);
    const args = t.slice(1);
    if (base === 'find' && args.some((x) => /^-(exec|execdir|delete|ok|okdir|fprint|fprintf|fls)$/.test(x))) return false;
    if (base === 'sort' && args.some((x) => x === '-o' || x.startsWith('--output'))) return false;
    if (base === 'rg' && args.some((x) => x.startsWith('--pre'))) return false;
    if (SAFE_COMMANDS.has(base)) return true;
    const sub = SAFE_SUB[base];
    return sub ? sub(args) : false;
  });
}

const CATASTROPHIC: [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*r[a-zA-Z]*\s+(-[a-zA-Z-]+\s+)*(\/|\/\*|~\/?|\$HOME\/?|\.\.\/\.\.\/?)(\s|$)/, 'recursive delete of a root/home directory'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'fork bomb'],
  [/\bmkfs(\.\w+)?\b/, 'formatting a filesystem'],
  [/\bdd\b[^|;&]*\bof=\/dev\/(sd|nvme|disk|hd|mmcblk)/, 'writing to a raw disk'],
  [/>\s*\/dev\/(sd|nvme|disk|hd|mmcblk)/, 'writing to a raw disk'],
  [/\bchmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/, 'making the root filesystem world-writable'],
];

const RISKY: [RegExp, string][] = [
  [/\b(sudo|doas|su)\b/, 'elevated privileges'],
  [/\b(curl|wget|nc|ncat|netcat|ssh|scp|sftp|rsync|ftp|telnet)\b/, 'network access'],
  [/\bgit\s+push\b/, 'pushes to a remote'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|restore\s)/, 'discards local changes'],
  [/\b(npm|pnpm|yarn|cargo|gem|twine)\s+publish\b/, 'publishes a package'],
  [/\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf]/, 'recursive or forced delete'],
  [/\b(shutdown|reboot|halt|poweroff|killall|pkill)\b/, 'system-level process control'],
  [/\bdocker\s+(run|exec)\b.*--privileged/, 'privileged container'],
  [/\bchmod\s+-R\b|\bchown\b/, 'permission changes'],
];

export function catastrophicReason(cmd: string): string | undefined {
  return CATASTROPHIC.find(([re]) => re.test(cmd))?.[1];
}

export function riskyReason(cmd: string, cwd: string): string | undefined {
  const hit = RISKY.find(([re]) => re.test(cmd));
  if (hit) return hit[1];
  // redirections to absolute paths outside the workspace
  for (const m of cmd.matchAll(/>{1,2}\s*([~/][^\s;&|]*)/g)) {
    const target = m[1]!.startsWith('~') ? path.join(process.env.HOME ?? '', m[1]!.slice(1)) : m[1]!;
    if (target === '/dev/null' || target.startsWith('/dev/std') || target.startsWith('/tmp')) continue;
    if (!isInside(path.resolve(target), cwd)) return 'writes outside the workspace';
  }
  return undefined;
}

export function suggestCommandRule(cmd: string): string {
  const seg = splitSegments(cmd).segments[0] ?? cmd;
  const t = tokens(seg);
  if (!t.length) return `bash(${cmd})`;
  const head = t[1] && !t[1].startsWith('-') && !t[1].includes('/') && !t[1].includes('.') ? `${t[0]} ${t[1]}` : t[0]!;
  return `bash(${head}*)`;
}

// ───────────────────────────── evaluation ─────────────────────────────

function sensitiveMatch(p: string, ctx: PermissionContext): string | undefined {
  const rel = toPosix(path.relative(ctx.projectRoot, p));
  const abs = toPosix(p);
  for (const g of ctx.config.permissions?.sensitivePaths ?? []) {
    const re = globToRegExp(g);
    if (re.test(rel) || re.test(abs) || re.test(path.basename(p))) return g;
  }
  return undefined;
}

function looksLikeExfiltration(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.search.length > 256) return true;
    if (/[A-Za-z0-9+/=_-]{120,}/.test(u.pathname + u.search)) return true;
  } catch {
    return false;
  }
  return false;
}

export function evaluatePermission(tool: Tool, args: Record<string, unknown>, ctx: PermissionContext): PermissionDecision {
  const subject: Subject = {};
  try {
    if (tool.command) subject.command = tool.command(args as any);
    if (tool.paths) subject.paths = tool.paths(args as any, ctx.cwd);
    if (tool.url) subject.url = tool.url(args as any);
  } catch (err) {
    return { action: 'deny', reason: `Invalid arguments: ${(err as Error).message}` };
  }
  const rules = {
    deny: (ctx.config.permissions?.deny ?? []).map(parseRule),
    allow: [...(ctx.config.permissions?.allow ?? []), ...ctx.sessionAllow].map(parseRule),
    ask: (ctx.config.permissions?.ask ?? []).map(parseRule),
  };
  const inWorkspace = (subject.paths ?? []).every((p) => isInside(p, ctx.cwd) || isInside(p, ctx.projectRoot));

  // 1. hard safety rails
  if (subject.command) {
    const cat = catastrophicReason(subject.command);
    if (cat) return { action: 'deny', reason: `Blocked: ${cat}. DrakoX never runs this.` };
  }
  if (tool.kind === 'edit' && (subject.paths ?? []).some((p) => toPosix(p).includes('/.git/') && !toPosix(p).includes('/.git/info/'))) {
    return { action: 'deny', reason: 'Direct edits inside .git/ are blocked — use git commands instead.' };
  }

  // 2. explicit deny rules
  for (const r of rules.deny) if (ruleMatches(r, tool, subject, ctx).matched) return { action: 'deny', reason: `Denied by rule ${r.raw}`, rule: r.raw };

  // 3. plan mode: research only
  if (ctx.mode === 'plan') {
    if (tool.kind === 'edit') return { action: 'deny', reason: 'Plan mode is read-only. Submit your plan with submit_plan; edits are allowed after approval.' };
    if (tool.kind === 'execute') {
      if (subject.command && isSafeCommand(subject.command)) return { action: 'allow', reason: 'read-only command' };
      return { action: 'deny', reason: 'Plan mode only allows read-only commands. Include this step in your plan instead.' };
    }
    if (tool.kind === 'mcp' && !tool.annotations?.readOnly) return { action: 'ask', reason: 'Plan mode: this integration tool may have side effects.', suggestion: tool.name };
  }

  // 4. explicit allow rules (pattern rules override sensitive/outside checks; bare tool rules don't)
  let bareAllow: string | undefined;
  for (const r of rules.allow) {
    const m = ruleMatches(r, tool, subject, ctx);
    if (m.matched && m.explicit) return { action: 'allow', reason: `Allowed by rule ${r.raw}`, rule: r.raw };
    if (m.matched) bareAllow ??= r.raw;
  }
  for (const r of rules.ask) if (ruleMatches(r, tool, subject, ctx).matched) return { action: 'ask', reason: `Rule ${r.raw} requires approval`, rule: r.raw };

  // 5. sensitive files & workspace boundary
  for (const p of subject.paths ?? []) {
    const s = sensitiveMatch(p, ctx);
    if (s) return { action: 'ask', reason: `Sensitive file (${s})`, suggestion: undefined };
  }
  if (subject.paths?.length && !inWorkspace) {
    if (tool.kind === 'read' && (ctx.mode === 'autopilot' || ctx.sandbox.mode === 'full-access')) return { action: 'allow', reason: 'read outside workspace (autopilot)' };
    if (!(ctx.mode === 'autopilot' && ctx.sandbox.mode === 'full-access')) {
      return { action: 'ask', reason: `${tool.kind === 'read' ? 'Reads' : 'Writes'} outside the workspace` };
    }
  }
  if (bareAllow) return { action: 'allow', reason: `Allowed by rule ${bareAllow}`, rule: bareAllow };

  // 6. defaults by tool kind and mode
  switch (tool.kind) {
    case 'read':
    case 'meta':
      return { action: 'allow', reason: 'read-only' };
    case 'edit':
      if (ctx.sandbox.mode === 'read-only') return { action: 'ask', reason: 'Sandbox is read-only' };
      if (ctx.mode === 'ask') return { action: 'ask', reason: 'Edits need approval in Ask mode', suggestion: 'edit' };
      return { action: 'allow', reason: `${ctx.mode} mode` };
    case 'execute': {
      const cmd = subject.command ?? '';
      if (isSafeCommand(cmd)) return { action: 'allow', reason: 'read-only command' };
      const suggestion = suggestCommandRule(cmd);
      if (ctx.mode === 'autopilot') {
        if (ctx.sandbox.mode === 'full-access') return { action: 'allow', reason: 'autopilot (full access)' };
        if (ctx.sandbox.available) {
          const risky = riskyReason(cmd, ctx.cwd);
          if (risky && /network|privileges|publishes|pushes/.test(risky) && !ctx.sandbox.network) return { action: 'allow', reason: `autopilot (sandboxed: ${ctx.sandbox.kind}, no network)` };
          return { action: 'allow', reason: `autopilot (sandboxed: ${ctx.sandbox.kind})` };
        }
        const risky = riskyReason(cmd, ctx.cwd);
        if (risky) return { action: 'ask', reason: `No OS sandbox available and the command ${risky} (fail-closed)`, suggestion };
        return { action: 'allow', reason: 'autopilot' };
      }
      if (ctx.mode === 'auto-edit' && ctx.sandbox.available && ctx.sandbox.mode === 'workspace-write' && !riskyReason(cmd, ctx.cwd)) {
        return { action: 'allow', reason: `sandboxed (${ctx.sandbox.kind})` };
      }
      return { action: 'ask', reason: 'Commands need approval', suggestion };
    }
    case 'network': {
      if (subject.url && looksLikeExfiltration(subject.url)) return { action: 'ask', reason: 'URL carries a large payload (possible data exfiltration)' };
      if (ctx.mode === 'ask') {
        let host = '';
        try {
          host = subject.url ? new URL(subject.url).origin : '';
        } catch {
          /* ignore */
        }
        return { action: 'ask', reason: 'Network access needs approval in Ask mode', suggestion: host ? `${tool.name}(${host}/*)` : tool.name };
      }
      return { action: 'allow', reason: `${ctx.mode} mode` };
    }
    case 'mcp': {
      const server = tool.annotations?.server;
      const auto = server ? ctx.config.mcpServers?.[server]?.autoApprove : undefined;
      if (auto === true || (Array.isArray(auto) && tool.annotations?.tool && auto.includes(tool.annotations.tool))) return { action: 'allow', reason: 'auto-approved integration' };
      if (tool.annotations?.readOnly) return { action: 'allow', reason: 'read-only integration tool' };
      if (tool.annotations?.destructive) return { action: 'ask', reason: 'Integration tool is marked destructive', suggestion: tool.name };
      if (ctx.mode === 'autopilot') return { action: 'allow', reason: 'autopilot' };
      return { action: 'ask', reason: 'Integration tools need approval', suggestion: tool.name };
    }
  }
  return { action: 'ask', reason: 'Unknown tool kind' };
}

/** Summarise a tool call's arguments for an approval prompt. */
export function describeArgs(args: Record<string, unknown>, max = 1200): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    const s = typeof v === 'string' ? v : isPlainObject(v) || Array.isArray(v) ? JSON.stringify(v, null, 2) : String(v);
    parts.push(`${k}: ${s.length > 400 ? s.slice(0, 400) + '…' : s}`);
  }
  const out = parts.join('\n');
  return out.length > max ? out.slice(0, max) + '…' : out;
}

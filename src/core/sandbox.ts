import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SandboxMode } from './types.js';

/**
 * OS-level sandbox for shell commands.
 *  - macOS: sandbox-exec (Seatbelt) profile — writes limited to the workspace + temp dirs
 *  - Linux: bubblewrap (bwrap) — read-only root, writable workspace + /tmp, optional network isolation
 *  - otherwise: no OS sandbox; DrakoX *fails closed* and asks before risky commands
 */
export interface SandboxInfo {
  available: boolean;
  kind: 'seatbelt' | 'bubblewrap' | 'none';
  mode: SandboxMode;
  network: boolean;
}

let detected: SandboxInfo['kind'] | undefined;

export function detectSandbox(): SandboxInfo['kind'] {
  if (detected) return detected;
  if (process.env.DRAKOX_DISABLE_SANDBOX === '1') return (detected = 'none');
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) detected = 'seatbelt';
  else if (process.platform === 'linux') {
    try {
      const r = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', 'true'], { timeout: 3000 });
      detected = r.status === 0 ? 'bubblewrap' : 'none';
    } catch {
      detected = 'none';
    }
  } else detected = 'none';
  return detected;
}

export function sandboxInfo(mode: SandboxMode, network = false): SandboxInfo {
  const kind = mode === 'full-access' ? 'none' : detectSandbox();
  return { available: kind !== 'none', kind, mode, network };
}

/** Wrap a shell invocation so it runs inside the OS sandbox (when available). */
export function wrapCommand(shell: string, shellArgs: string[], info: SandboxInfo, cwd: string, writableRoots: string[]): { cmd: string; args: string[] } {
  if (!info.available || info.mode === 'full-access') return { cmd: shell, args: shellArgs };
  const tmp = os.tmpdir();
  if (info.kind === 'seatbelt') {
    const writable = info.mode === 'read-only' ? [] : [...writableRoots, tmp, '/private/tmp', '/private/var/folders', path.join(os.homedir(), '.npm'), path.join(os.homedir(), '.cache')];
    const profile = [
      '(version 1)',
      '(allow default)',
      '(deny file-write*)',
      '(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/tty"))',
      ...writable.map((w) => `(allow file-write* (subpath ${JSON.stringify(fs.existsSync(w) ? fs.realpathSync(w) : w)}))`),
      ...(info.network ? [] : ['(deny network-outbound (remote ip))', '(allow network-outbound (remote unix-socket))']),
    ].join('\n');
    return { cmd: '/usr/bin/sandbox-exec', args: ['-p', profile, shell, ...shellArgs] };
  }
  if (info.kind === 'bubblewrap') {
    const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent', '--new-session'];
    if (info.mode !== 'read-only') {
      for (const w of [...writableRoots, tmp]) if (fs.existsSync(w)) args.push('--bind', w, w);
      for (const c of [path.join(os.homedir(), '.npm'), path.join(os.homedir(), '.cache')]) if (fs.existsSync(c)) args.push('--bind', c, c);
    } else {
      args.push('--tmpfs', tmp);
    }
    if (!info.network) args.push('--unshare-net');
    args.push('--chdir', cwd, shell, ...shellArgs);
    return { cmd: 'bwrap', args };
  }
  return { cmd: shell, args: shellArgs };
}

export function defaultShell(configured?: string): { shell: string; args: (cmd: string) => string[] } {
  if (configured) {
    const isPwsh = /pwsh|powershell/i.test(configured);
    const isCmd = /cmd(\.exe)?$/i.test(configured);
    return { shell: configured, args: (c) => (isPwsh ? ['-NoProfile', '-Command', c] : isCmd ? ['/d', '/s', '/c', c] : ['-c', c]) };
  }
  if (process.platform === 'win32') {
    // Prefer Git Bash when present so POSIX commands work; otherwise PowerShell.
    const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) => fs.existsSync(p));
    if (gitBash) return { shell: gitBash, args: (c) => ['-c', c] };
    return { shell: 'powershell.exe', args: (c) => ['-NoProfile', '-Command', c] };
  }
  const sh = fs.existsSync('/bin/bash') ? '/bin/bash' : process.env.SHELL || '/bin/sh';
  return { shell: sh, args: (c) => ['-c', c] };
}

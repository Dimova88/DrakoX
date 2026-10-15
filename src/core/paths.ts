import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Root of DrakoX user data. Override with DRAKOX_HOME. */
export function drakoxHome(): string {
  return process.env.DRAKOX_HOME || path.join(os.homedir(), '.drakox');
}

export const paths = {
  home: () => drakoxHome(),
  config: () => path.join(drakoxHome(), 'config.json'),
  credentials: () => path.join(drakoxHome(), 'credentials.json'),
  trust: () => path.join(drakoxHome(), 'trusted.json'),
  sessions: () => path.join(drakoxHome(), 'sessions'),
  worktrees: () => path.join(drakoxHome(), 'worktrees'),
  history: () => path.join(drakoxHome(), 'history'),
  userSkills: () => path.join(drakoxHome(), 'skills'),
  userAgents: () => path.join(drakoxHome(), 'agents'),
  userCommands: () => path.join(drakoxHome(), 'commands'),
  userInstructions: () => path.join(drakoxHome(), 'AGENTS.md'),
};

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Directory of the installed DrakoX package (contains skills/, agents/, dist/web). */
export function packageRoot(): string {
  // dist/core/paths.js or src/core/paths.ts → two levels up
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        if (pkg.name === 'drakox') return dir;
      } catch {
        /* ignore */
      }
    }
    dir = path.dirname(dir);
  }
  return path.resolve(here, '..', '..');
}

export function packageVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Pretty path relative to cwd when inside it, otherwise ~-abbreviated absolute path. */
export function displayPath(abs: string, cwd: string): string {
  if (isInside(abs, cwd)) return toPosix(path.relative(cwd, abs)) || '.';
  const home = os.homedir();
  if (isInside(abs, home)) return '~/' + toPosix(path.relative(home, abs));
  return abs;
}

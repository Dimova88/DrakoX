import fs from 'node:fs';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { structuredPatch } from 'diff';
import type { ToolDisplay } from '../types.js';
import { displayPath, toPosix } from '../paths.js';

export const DEFAULT_IGNORES = ['.git', 'node_modules', '.DS_Store', '.drakox/worktrees', '__pycache__', '.venv', 'venv', '.next', '.nuxt', 'dist', 'build', 'target', '.turbo', '.cache', 'coverage', '.idea'];

export function resolvePath(p: unknown, cwd: string): string {
  if (typeof p !== 'string' || !p.trim()) throw new Error('A non-empty "path" argument is required');
  let s = p.trim();
  if (s.startsWith('~/')) s = path.join(process.env.HOME || process.env.USERPROFILE || '', s.slice(2));
  return path.resolve(cwd, s);
}

const ignoreCache = new Map<string, { ig: Ignore; at: number }>();

/** gitignore-aware filter rooted at `root` (root .gitignore + .git/info/exclude + defaults). */
export function getIgnore(root: string): Ignore {
  const hit = ignoreCache.get(root);
  if (hit && Date.now() - hit.at < 5000) return hit.ig;
  const ig = ignore().add(DEFAULT_IGNORES.map((d) => `${d}`));
  for (const f of ['.gitignore', path.join('.git', 'info', 'exclude')]) {
    try {
      ig.add(fs.readFileSync(path.join(root, f), 'utf8'));
    } catch {
      /* none */
    }
  }
  ignoreCache.set(root, { ig, at: Date.now() });
  return ig;
}

export function isIgnored(ig: Ignore, root: string, abs: string, isDir = false): boolean {
  const rel = toPosix(path.relative(root, abs));
  if (!rel || rel.startsWith('..')) return false;
  try {
    return ig.ignores(isDir ? rel + '/' : rel);
  } catch {
    return false;
  }
}

export function makeDiff(absPath: string, before: string | null, after: string | null, cwd: string): Extract<ToolDisplay, { kind: 'diff' }> {
  const rel = displayPath(absPath, cwd);
  const p = structuredPatch(rel, rel, before ?? '', after ?? '', '', '', { context: 3 });
  const lines: string[] = [];
  let added = 0;
  let removed = 0;
  for (const h of p.hunks) {
    lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines) {
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
      if (l.startsWith('\\')) continue;
      lines.push(l);
    }
  }
  return { kind: 'diff', path: rel, diff: lines.join('\n'), added, removed, isNew: before === null, isDelete: after === null };
}

export function detectEol(text: string): '\r\n' | '\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? '\r\n' : '\n';
}

export function readTextIfExists(abs: string): string | null {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/** Atomic-ish write that creates parent directories. */
export function writeText(abs: string, content: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

const IMAGE_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export function imageMediaType(abs: string): string | undefined {
  return IMAGE_EXT[path.extname(abs).toLowerCase()];
}

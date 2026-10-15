import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureDir, paths } from './paths.js';
import type { WorktreeInfo } from './types.js';
import { sha256 } from './util.js';

function git(cwd: string, args: string[], input?: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { ok: r.status === 0, out: (r.stdout ?? '').toString(), err: (r.stderr ?? '').toString() || (r.error?.message ?? '') };
}

export function gitRoot(cwd: string): string | null {
  const r = git(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok ? path.resolve(r.out.trim()) : null;
}

export interface GitInfo {
  isRepo: boolean;
  root?: string;
  branch?: string;
  changed: number;
  lastCommit?: string;
  remote?: string;
}

export function gitInfo(cwd: string): GitInfo {
  const root = gitRoot(cwd);
  if (!root) return { isRepo: false, changed: 0 };
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
  const status = git(cwd, ['status', '--porcelain']).out.split('\n').filter(Boolean);
  const last = git(cwd, ['log', '-1', '--pretty=%h %s']).out.trim();
  const remote = git(cwd, ['remote', 'get-url', 'origin']).out.trim();
  return { isRepo: true, root, branch, changed: status.length, lastCommit: last || undefined, remote: remote || undefined };
}

export interface GitFileStatus {
  path: string;
  status: string;
}

export function gitStatus(cwd: string): GitFileStatus[] {
  const r = git(cwd, ['status', '--porcelain', '-uall']);
  if (!r.ok) return [];
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ status: l.slice(0, 2).trim() || '?', path: l.slice(3).replace(/^"|"$/g, '') }));
}

/** Diff for review: uncommitted changes (incl. untracked) or against a base ref. */
export function gitDiff(cwd: string, opts: { base?: string; path?: string } = {}): string {
  if (opts.base) {
    const mb = git(cwd, ['merge-base', opts.base, 'HEAD']);
    const base = mb.ok ? mb.out.trim() : opts.base;
    return git(cwd, ['diff', base, ...(opts.path ? ['--', opts.path] : [])]).out;
  }
  const tracked = git(cwd, ['diff', 'HEAD', ...(opts.path ? ['--', opts.path] : [])]);
  let out = tracked.ok ? tracked.out : git(cwd, ['diff', ...(opts.path ? ['--', opts.path] : [])]).out;
  if (!opts.path) {
    const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']).out.split('\n').filter(Boolean);
    for (const f of untracked.slice(0, 50)) {
      const r = git(cwd, ['diff', '--no-index', '--', '/dev/null', f]);
      out += r.out;
    }
  }
  return out;
}

export function gitShowFile(cwd: string, file: string, ref = 'HEAD'): string | null {
  const root = gitRoot(cwd);
  if (!root) return null;
  const rel = path.relative(root, path.resolve(cwd, file)).split(path.sep).join('/');
  const r = git(root, ['show', `${ref}:${rel}`]);
  return r.ok ? r.out : null;
}

// ───────────────────────────── worktrees (parallel isolated agents) ─────────────────────────────

export function createWorktree(repoRoot: string, id: string, baseRef = 'HEAD'): WorktreeInfo {
  const dir = ensureDir(path.join(paths.worktrees(), sha256(repoRoot).slice(0, 10)));
  const wtPath = path.join(dir, id);
  const branch = `drakox/${id}`;
  const base = git(repoRoot, ['rev-parse', baseRef]);
  if (!base.ok) throw new Error(`Cannot create worktree: ${base.err.trim() || 'repository has no commits yet'}`);
  const r = git(repoRoot, ['worktree', 'add', '-b', branch, wtPath, base.out.trim()]);
  if (!r.ok) throw new Error(`git worktree add failed: ${r.err.trim()}`);
  return { path: wtPath, branch, baseRef: base.out.trim(), repoRoot };
}

/** Full diff of everything the agent changed in its worktree (including new files). */
export function worktreeDiff(wt: WorktreeInfo): string {
  git(wt.path, ['add', '-A']);
  const r = git(wt.path, ['diff', '--cached', '--binary', wt.baseRef]);
  git(wt.path, ['reset', '-q']);
  return r.out;
}

export function worktreeStats(wt: WorktreeInfo): { files: number; added: number; removed: number } {
  git(wt.path, ['add', '-A']);
  const r = git(wt.path, ['diff', '--cached', '--numstat', wt.baseRef]);
  git(wt.path, ['reset', '-q']);
  let added = 0;
  let removed = 0;
  const lines = r.out.split('\n').filter(Boolean);
  for (const l of lines) {
    const [a, d] = l.split('\t');
    added += Number(a) || 0;
    removed += Number(d) || 0;
  }
  return { files: lines.length, added, removed };
}

/** Apply a worktree's changes onto the main working tree (3-way merge when needed). */
export function applyWorktree(wt: WorktreeInfo): { ok: boolean; message: string } {
  const diff = worktreeDiff(wt);
  if (!diff.trim()) return { ok: true, message: 'No changes to apply.' };
  const r = git(wt.repoRoot, ['apply', '--3way', '--whitespace=nowarn', '-'], diff);
  if (!r.ok) return { ok: false, message: r.err.trim() || 'git apply failed' };
  return { ok: true, message: 'Changes applied to your working tree.' };
}

/** Commit the worktree's changes on its branch (keeps them for a PR / later merge). */
export function commitWorktree(wt: WorktreeInfo, message: string): { ok: boolean; message: string } {
  git(wt.path, ['add', '-A']);
  const r = git(wt.path, ['-c', 'user.name=DrakoX', '-c', 'user.email=drakox@localhost', 'commit', '-m', message]);
  return { ok: r.ok, message: r.ok ? `Committed on branch ${wt.branch}` : r.err.trim() || r.out.trim() };
}

export function removeWorktree(wt: WorktreeInfo, deleteBranch = true): void {
  git(wt.repoRoot, ['worktree', 'remove', '--force', wt.path]);
  if (fs.existsSync(wt.path)) fs.rmSync(wt.path, { recursive: true, force: true });
  git(wt.repoRoot, ['worktree', 'prune']);
  if (deleteBranch) git(wt.repoRoot, ['branch', '-D', wt.branch]);
}

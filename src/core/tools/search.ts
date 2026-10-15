import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { glob } from 'tinyglobby';
import { displayPath, toPosix } from '../paths.js';
import { getIgnore, isIgnored, resolvePath } from './common.js';
import { errorResult, textResult, type Tool } from './types.js';
import { isBinaryBuffer } from '../util.js';

let rgPath: string | null | undefined;
export function findRipgrep(): string | null {
  if (rgPath !== undefined) return rgPath;
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['rg'], { encoding: 'utf8' });
    rgPath = r.status === 0 ? r.stdout.split(/\r?\n/)[0]!.trim() || null : null;
  } catch {
    rgPath = null;
  }
  return rgPath;
}

export const globTool: Tool<{ pattern: string; path?: string }> = {
  name: 'glob',
  kind: 'read',
  parallelSafe: true,
  description: 'Find files by glob pattern (e.g. "src/**/*.ts", "**/*.{js,jsx}"). Results are sorted by modification time (newest first). gitignore-aware.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern' },
      path: { type: 'string', description: 'Directory to search (default: workspace root)' },
    },
    required: ['pattern'],
  },
  title: (a) => `Glob ${a.pattern}`,
  paths: (a, cwd) => [resolvePath(a.path || '.', cwd)],
  async run(a, ctx) {
    if (!a.pattern) return errorResult('"pattern" is required');
    const base = resolvePath(a.path || '.', ctx.cwd);
    const files = await glob(a.pattern, {
      cwd: base,
      dot: true,
      absolute: true,
      onlyFiles: true,
      ignore: ['**/node_modules/**', '**/.git/**'],
    });
    const ig = getIgnore(ctx.projectRoot);
    const withTime = files
      .filter((f) => !isIgnored(ig, ctx.projectRoot, f))
      .map((f) => {
        let m = 0;
        try {
          m = fs.statSync(f).mtimeMs;
        } catch {
          /* ignore */
        }
        return { f, m };
      })
      .sort((x, y) => y.m - x.m);
    const LIMIT = 200;
    const shown = withTime.slice(0, LIMIT).map((x) => displayPath(x.f, ctx.cwd));
    if (!shown.length) return textResult('No files matched.');
    return textResult(shown.join('\n') + (withTime.length > LIMIT ? `\n(… ${withTime.length - LIMIT} more; refine the pattern)` : ''), {
      kind: 'text',
      text: `${withTime.length} files`,
    });
  },
};

interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  case_insensitive?: boolean;
  output_mode?: 'content' | 'files_with_matches' | 'count';
  context?: number;
  max_results?: number;
}

export const grepTool: Tool<GrepArgs> = {
  name: 'grep',
  kind: 'read',
  parallelSafe: true,
  description:
    'Search file contents with a regular expression (ripgrep syntax). output_mode: "files_with_matches" (default), "content" (matching lines with line numbers) or "count". ' +
    'Filter files with glob (e.g. "*.ts"). gitignore-aware.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression' },
      path: { type: 'string', description: 'File or directory to search (default: workspace root)' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.{ts,tsx}"' },
      case_insensitive: { type: 'boolean' },
      output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
      context: { type: 'number', description: 'Lines of context around matches (content mode)' },
      max_results: { type: 'number', description: 'Max output lines (default 250)' },
    },
    required: ['pattern'],
  },
  title: (a) => `Grep "${a.pattern}"${a.glob ? ` in ${a.glob}` : ''}`,
  paths: (a, cwd) => [resolvePath(a.path || '.', cwd)],
  async run(a, ctx) {
    if (!a.pattern) return errorResult('"pattern" is required');
    const target = resolvePath(a.path || '.', ctx.cwd);
    const mode = a.output_mode ?? 'files_with_matches';
    const max = Math.min(2000, Math.max(1, a.max_results ?? 250));
    const rg = findRipgrep();
    let out: string;
    try {
      out = rg ? await runRipgrep(rg, a, target, mode, ctx.signal) : jsGrep(a, target, mode, ctx.projectRoot);
    } catch (err) {
      return errorResult(`grep failed: ${(err as Error).message}`);
    }
    const lines = out.split('\n').filter(Boolean).map((l) => relativize(l, ctx.cwd));
    if (!lines.length) return textResult('No matches found.');
    const shown = lines.slice(0, max);
    return textResult(shown.join('\n') + (lines.length > max ? `\n(… ${lines.length - max} more lines; narrow the search)` : ''), {
      kind: 'text',
      text: `${lines.length} ${mode === 'files_with_matches' ? 'files' : 'lines'}`,
    });
  },
};

function relativize(line: string, cwd: string): string {
  const prefix = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
  return line.startsWith(prefix) ? toPosix(line.slice(prefix.length)) : line;
}

function runRipgrep(rg: string, a: GrepArgs, target: string, mode: string, signal: AbortSignal): Promise<string> {
  const args = ['--color', 'never', '--no-heading', '--hidden', '--glob', '!.git', '--max-columns', '400', '--max-columns-preview'];
  if (a.case_insensitive) args.push('-i');
  if (a.glob) args.push('--glob', a.glob);
  if (mode === 'files_with_matches') args.push('-l');
  else if (mode === 'count') args.push('-c');
  else {
    args.push('-n');
    if (a.context) args.push('-C', String(Math.min(10, a.context)));
  }
  args.push('-e', a.pattern, target);
  return new Promise((resolve, reject) => {
    const p = spawn(rg, args, { signal });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => {
      if (out.length < 4_000_000) out += d;
    });
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0 || code === 1) resolve(out);
      else reject(new Error(err.trim() || `ripgrep exited with ${code}`));
    });
  });
}

function jsGrep(a: GrepArgs, target: string, mode: string, root: string): string {
  const re = new RegExp(a.pattern, a.case_insensitive ? 'i' : '');
  const globRe = a.glob ? new RegExp('^' + a.glob.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\{([^}]+)\}/g, (_, g) => `(${g.split(',').join('|')})`).replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : null;
  const ig = getIgnore(root);
  const out: string[] = [];
  const visit = (p: string) => {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      if (path.basename(p) === '.git' || isIgnored(ig, root, p, true)) return;
      for (const e of fs.readdirSync(p)) visit(path.join(p, e));
      return;
    }
    if (isIgnored(ig, root, p) || st.size > 2_000_000) return;
    if (globRe && !globRe.test(path.basename(p)) && !globRe.test(toPosix(path.relative(root, p)))) return;
    const buf = fs.readFileSync(p);
    if (isBinaryBuffer(buf)) return;
    const lines = buf.toString('utf8').split(/\r?\n/);
    let count = 0;
    lines.forEach((l, i) => {
      if (re.test(l)) {
        count++;
        if (mode === 'content') out.push(`${p}:${i + 1}:${l.slice(0, 400)}`);
      }
    });
    if (count && mode === 'files_with_matches') out.push(p);
    if (count && mode === 'count') out.push(`${p}:${count}`);
  };
  visit(target);
  return out.join('\n');
}

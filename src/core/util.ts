import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function uid(prefix = ''): string {
  return prefix + crypto.randomBytes(6).toString('hex');
}

export function sessionId(): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, data: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
  if (mode) {
    try {
      fs.chmodSync(file, mode);
    } catch {
      /* windows */
    }
  }
}

/** Deep merge plain objects (arrays are replaced, not concatenated). */
export function deepMerge<T extends Record<string, any>>(...objs: (Partial<T> | undefined)[]): T {
  const out: Record<string, any> = {};
  for (const o of objs) {
    if (!o) continue;
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) continue;
      if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
      else if (isPlainObject(v)) out[k] = deepMerge({}, v);
      else out[k] = v;
    }
  }
  return out as T;
}

export function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Truncate long text keeping head and tail. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n… [${omitted.toLocaleString()} characters omitted] …\n\n${text.slice(-tail)}`;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

/** Very rough token estimate (≈4 chars/token) used only for budgeting decisions. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new AbortError());
      },
      { once: true },
    );
  });
}

export class AbortError extends Error {
  constructor(message = 'Aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message));
}

/** Simple glob → RegExp (supports **, *, ?, {a,b}). Matches whole string. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  let inGroup = false;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more directories
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      inGroup = true;
      re += '(?:';
    } else if (c === '}' && inGroup) {
      inGroup = false;
      re += ')';
    } else if (c === ',' && inGroup) re += '|';
    else if ('.+^$()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
    i++;
  }
  return new RegExp('^' + re + '$');
}

/** Wildcard match for command rules: `*` matches anything (including spaces/slashes). */
export function wildcardMatch(pattern: string, text: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
    's',
  );
  return re.test(text);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatCost(usd: number | null | undefined, partial = false): string {
  if (usd == null) return '—';
  const s = usd === 0 ? '$0.00' : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
  return partial ? `${s}+` : s;
}

export function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

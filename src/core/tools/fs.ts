import fs from 'node:fs';
import path from 'node:path';
import { displayPath } from '../paths.js';
import { isBinaryBuffer } from '../util.js';
import { detectEol, getIgnore, imageMediaType, isIgnored, makeDiff, readTextIfExists, resolvePath, writeText } from './common.js';
import { errorResult, textResult, type Tool, type ToolContext } from './types.js';

const MAX_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function checkFresh(abs: string, ctx: ToolContext): string | null {
  const readAt = ctx.readTracker.get(abs);
  if (readAt === undefined) {
    return `You must read ${displayPath(abs, ctx.cwd)} with read_file before modifying it (prevents blind overwrites).`;
  }
  try {
    const m = fs.statSync(abs).mtimeMs;
    if (m > readAt + 1) return `${displayPath(abs, ctx.cwd)} was modified since you last read it. Read it again before editing.`;
  } catch {
    /* deleted meanwhile */
  }
  return null;
}

function markRead(abs: string, ctx: ToolContext): void {
  try {
    ctx.readTracker.set(abs, fs.statSync(abs).mtimeMs);
  } catch {
    /* ignore */
  }
}

export const readFileTool: Tool<{ path: string; offset?: number; limit?: number }> = {
  name: 'read_file',
  kind: 'read',
  parallelSafe: true,
  description:
    'Read a file from the filesystem. Returns numbered lines (cat -n style). Use offset (1-based line) and limit for large files. ' +
    'Images (png/jpg/gif/webp) are returned visually. Always read a file before editing it.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative to the workspace or absolute)' },
      offset: { type: 'number', description: 'Line number to start reading from (1-based)' },
      limit: { type: 'number', description: `Number of lines to read (default ${MAX_READ_LINES})` },
    },
    required: ['path'],
  },
  title: (a, cwd) => `Read ${safeDisplay(a.path, cwd)}`,
  paths: (a, cwd) => [resolvePath(a.path, cwd)],
  async run(a, ctx) {
    const abs = resolvePath(a.path, ctx.cwd);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return errorResult(`File not found: ${displayPath(abs, ctx.cwd)}`);
    }
    if (st.isDirectory()) return errorResult(`${displayPath(abs, ctx.cwd)} is a directory. Use list_dir instead.`);
    const media = imageMediaType(abs);
    if (media) {
      if (st.size > 5 * 1024 * 1024) return errorResult('Image is larger than 5MB.');
      const data = fs.readFileSync(abs).toString('base64');
      markRead(abs, ctx);
      return {
        content: [
          { type: 'text', text: `Image ${displayPath(abs, ctx.cwd)} (${st.size} bytes):` },
          { type: 'image', mediaType: media, data },
        ],
        display: { kind: 'images', images: [{ mediaType: media, data }] },
      };
    }
    if (st.size > MAX_FILE_BYTES && !a.offset && !a.limit) {
      return errorResult(`File is ${(st.size / 1024 / 1024).toFixed(1)}MB. Use offset/limit to read a part, or grep to search it.`);
    }
    const buf = fs.readFileSync(abs);
    if (isBinaryBuffer(buf)) return textResult(`Binary file ${displayPath(abs, ctx.cwd)} (${buf.length} bytes) — not shown.`);
    const text = buf.toString('utf8');
    markRead(abs, ctx);
    if (!text.length) return textResult(`(${displayPath(abs, ctx.cwd)} is empty)`);
    const lines = text.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const start = Math.max(1, Math.floor(a.offset ?? 1));
    const limit = Math.max(1, Math.floor(a.limit ?? MAX_READ_LINES));
    const slice = lines.slice(start - 1, start - 1 + limit);
    if (!slice.length) return errorResult(`Offset ${start} is past the end of the file (${lines.length} lines).`);
    const body = slice
      .map((l, i) => `${String(start + i).padStart(6)}\t${l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + '… [line truncated]' : l}`)
      .join('\n');
    const end = start + slice.length - 1;
    const note = end < lines.length || start > 1 ? `\n\n(Showing lines ${start}-${end} of ${lines.length}. Use offset/limit to read more.)` : '';
    return textResult(body + note, { kind: 'text', text: `${slice.length} lines` });
  },
};

export const writeFileTool: Tool<{ path: string; content: string }> = {
  name: 'write_file',
  kind: 'edit',
  description:
    'Create a new file or completely overwrite an existing one. Prefer edit_file for changes to existing files. ' +
    'Existing files must be read first. Parent directories are created automatically.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative to the workspace or absolute)' },
      content: { type: 'string', description: 'Full file content' },
    },
    required: ['path', 'content'],
  },
  title: (a, cwd) => `Write ${safeDisplay(a.path, cwd)}`,
  paths: (a, cwd) => [resolvePath(a.path, cwd)],
  async run(a, ctx) {
    if (typeof a.content !== 'string') return errorResult('"content" must be a string');
    const abs = resolvePath(a.path, ctx.cwd);
    const before = readTextIfExists(abs);
    if (before !== null) {
      const stale = checkFresh(abs, ctx);
      if (stale) return errorResult(stale);
    }
    const eol = before !== null ? detectEol(before) : '\n';
    const content = eol === '\r\n' ? a.content.replace(/\r?\n/g, '\r\n') : a.content;
    writeText(abs, content);
    markRead(abs, ctx);
    ctx.recordFileChange(abs, before, content);
    const display = makeDiff(abs, before, content, ctx.cwd);
    const lines = content.split('\n').length;
    return textResult(
      before === null ? `Created ${displayPath(abs, ctx.cwd)} (${lines} lines).` : `Overwrote ${displayPath(abs, ctx.cwd)} (+${display.added} −${display.removed}).`,
      display,
    );
  },
};

export const editFileTool: Tool<{ path: string; old_string: string; new_string: string; replace_all?: boolean }> = {
  name: 'edit_file',
  kind: 'edit',
  description:
    'Replace text in a file. old_string must match the file content (including indentation) and be unique unless replace_all is true. ' +
    'Include enough surrounding lines to make the match unique. Use an empty old_string to create a new file. The file must be read first.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      old_string: { type: 'string', description: 'Exact text to replace' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  title: (a, cwd) => `Edit ${safeDisplay(a.path, cwd)}`,
  paths: (a, cwd) => [resolvePath(a.path, cwd)],
  async run(a, ctx) {
    const abs = resolvePath(a.path, ctx.cwd);
    if (typeof a.old_string !== 'string' || typeof a.new_string !== 'string') return errorResult('old_string and new_string must be strings');
    const before = readTextIfExists(abs);
    if (before === null) {
      if (a.old_string === '') {
        writeText(abs, a.new_string);
        markRead(abs, ctx);
        ctx.recordFileChange(abs, null, a.new_string);
        return textResult(`Created ${displayPath(abs, ctx.cwd)}.`, makeDiff(abs, null, a.new_string, ctx.cwd));
      }
      return errorResult(`File not found: ${displayPath(abs, ctx.cwd)}`);
    }
    const stale = checkFresh(abs, ctx);
    if (stale) return errorResult(stale);
    if (a.old_string === a.new_string) return errorResult('old_string and new_string are identical — nothing to change.');
    if (a.old_string === '') return errorResult('old_string is empty but the file exists. Provide the text to replace, or use write_file.');

    const result = applyEdit(before, a.old_string, a.new_string, Boolean(a.replace_all));
    if ('error' in result) return errorResult(`${result.error}\nFile: ${displayPath(abs, ctx.cwd)}`);
    writeText(abs, result.content);
    markRead(abs, ctx);
    ctx.recordFileChange(abs, before, result.content);
    const display = makeDiff(abs, before, result.content, ctx.cwd);
    const snippet = snippetAround(result.content, result.firstIndex, a.new_string);
    return textResult(
      `Edited ${displayPath(abs, ctx.cwd)}${result.count > 1 ? ` (${result.count} replacements)` : ''}${result.fuzzy ? ' (matched ignoring whitespace differences)' : ''}.\n${snippet}`,
      display,
    );
  },
};

export const listDirTool: Tool<{ path?: string; depth?: number }> = {
  name: 'list_dir',
  kind: 'read',
  parallelSafe: true,
  description: 'List files and directories as a tree (gitignore-aware). Directories end with "/".',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory (default: workspace root)' },
      depth: { type: 'number', description: 'Max depth 1-6 (default 2)' },
    },
  },
  title: (a, cwd) => `List ${safeDisplay(a.path || '.', cwd)}`,
  paths: (a, cwd) => [resolvePath(a.path || '.', cwd)],
  async run(a, ctx) {
    const root = resolvePath(a.path || '.', ctx.cwd);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return errorResult(`Not a directory: ${displayPath(root, ctx.cwd)}`);
    const depth = Math.min(6, Math.max(1, Math.floor(a.depth ?? 2)));
    const ig = getIgnore(ctx.projectRoot);
    const lines: string[] = [];
    const LIMIT = 400;
    let count = 0;
    let truncated = false;
    const walk = (dir: string, level: number) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((x, y) => (x.isDirectory() === y.isDirectory() ? x.name.localeCompare(y.name) : x.isDirectory() ? -1 : 1));
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.name === '.git' || isIgnored(ig, ctx.projectRoot, abs, e.isDirectory())) continue;
        if (count >= LIMIT) {
          truncated = true;
          return;
        }
        count++;
        lines.push(`${'  '.repeat(level)}${e.name}${e.isDirectory() ? '/' : ''}`);
        if (e.isDirectory() && level + 1 < depth) walk(abs, level + 1);
      }
    };
    walk(root, 0);
    if (!lines.length) return textResult('(empty directory)');
    return textResult(lines.join('\n') + (truncated ? `\n(… truncated at ${LIMIT} entries; list a subdirectory for more)` : ''), {
      kind: 'text',
      text: `${count} entries`,
    });
  },
};

// ───────────────────────────── edit matching ─────────────────────────────

export function applyEdit(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
): { content: string; count: number; firstIndex: number; fuzzy: boolean } | { error: string } {
  const eol = detectEol(content);
  // normalise the model's line endings to the file's
  const norm = (s: string) => (eol === '\r\n' ? s.replace(/\r?\n/g, '\r\n') : s.replace(/\r\n/g, '\n'));
  const o = norm(oldStr);
  const n = norm(newStr);

  const occurrences = countOccurrences(content, o);
  if (occurrences > 1 && !replaceAll) {
    return { error: `old_string matches ${occurrences} locations. Add more surrounding context to make it unique, or set replace_all: true.` };
  }
  if (occurrences >= 1) {
    const firstIndex = content.indexOf(o);
    const out = replaceAll ? content.split(o).join(n) : content.slice(0, firstIndex) + n + content.slice(firstIndex + o.length);
    return { content: out, count: replaceAll ? occurrences : 1, firstIndex, fuzzy: false };
  }

  // Flexible match: ignore trailing whitespace, then indentation differences.
  const fuzzy = flexibleFind(content, o, eol);
  if (fuzzy) {
    if (fuzzy.matches > 1 && !replaceAll) {
      return { error: `old_string (ignoring whitespace) matches ${fuzzy.matches} locations. Add more context to make it unique.` };
    }
    const replacement = reindent(n, fuzzy.searchIndent, fuzzy.actualIndent, eol);
    const out = content.slice(0, fuzzy.start) + replacement + content.slice(fuzzy.end);
    return { content: out, count: 1, firstIndex: fuzzy.start, fuzzy: true };
  }
  return { error: `old_string was not found in the file.${closestHint(content, o)}` };
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    count++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return count;
}

function flexibleFind(
  content: string,
  search: string,
  eol: string,
): { start: number; end: number; matches: number; searchIndent: string; actualIndent: string } | null {
  const lines = content.split(eol);
  let sLines = search.split(eol);
  while (sLines.length && sLines[sLines.length - 1]!.trim() === '') sLines.pop();
  while (sLines.length && sLines[0]!.trim() === '') sLines.shift();
  if (!sLines.length) return null;
  const offsets: number[] = [];
  let acc = 0;
  for (const l of lines) {
    offsets.push(acc);
    acc += l.length + eol.length;
  }
  for (const cmp of [(a: string, b: string) => a.trimEnd() === b.trimEnd(), (a: string, b: string) => a.trim() === b.trim()]) {
    const found: number[] = [];
    for (let i = 0; i + sLines.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < sLines.length; j++) {
        if (!cmp(lines[i + j]!, sLines[j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) found.push(i);
    }
    if (found.length) {
      const i = found[0]!;
      const lastLine = i + sLines.length - 1;
      const start = offsets[i]!;
      const end = offsets[lastLine]! + lines[lastLine]!.length;
      const firstNonEmpty = sLines.findIndex((l) => l.trim());
      const searchIndent = sLines[firstNonEmpty]!.match(/^\s*/)![0];
      const actualIndent = lines[i + firstNonEmpty]!.match(/^\s*/)![0];
      return { start, end, matches: found.length, searchIndent, actualIndent };
    }
  }
  return null;
}

function reindent(text: string, from: string, to: string, eol: string): string {
  let lines = text.split(eol);
  // mirror the trimming done on the search side
  while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
  while (lines.length && lines[0]!.trim() === '') lines.shift();
  if (from === to) return lines.join(eol);
  lines = lines.map((l) => (l.startsWith(from) ? to + l.slice(from.length) : l.trim() ? to + l.trimStart() : l));
  return lines.join(eol);
}

function closestHint(content: string, search: string): string {
  const first = search.split(/\r?\n/).find((l) => l.trim())?.trim();
  if (!first) return '';
  const lines = content.split(/\r?\n/);
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const score = similarity(lines[i]!.trim(), first);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0 || bestScore < 0.5) return ' Re-read the file to get its exact current content.';
  const from = Math.max(0, best - 2);
  const snippet = lines
    .slice(from, best + 3)
    .map((l, k) => `${String(from + k + 1).padStart(6)}\t${l}`)
    .join('\n');
  return ` The closest match is around line ${best + 1}:\n${snippet}\nRe-read the file and copy the exact text.`;
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const [g, c] of A) inter += Math.min(c, B.get(g) ?? 0);
  return (2 * inter) / Math.max(1, a.length - 1 + b.length - 1);
}

function snippetAround(content: string, index: number, inserted: string): string {
  const before = content.slice(0, Math.max(0, index));
  const startLine = before.split(/\r?\n/).length;
  const lines = content.split(/\r?\n/);
  const span = inserted.split(/\r?\n/).length;
  const from = Math.max(1, startLine - 3);
  const to = Math.min(lines.length, startLine + span + 2);
  return lines
    .slice(from - 1, to)
    .map((l, i) => `${String(from + i).padStart(6)}\t${l}`)
    .join('\n');
}

function safeDisplay(p: unknown, cwd: string): string {
  try {
    return displayPath(resolvePath(p, cwd), cwd);
  } catch {
    return String(p ?? '');
  }
}

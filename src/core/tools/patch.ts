import fs from 'node:fs';
import { displayPath } from '../paths.js';
import { detectEol, makeDiff, readTextIfExists, resolvePath, writeText } from './common.js';
import { errorResult, textResult, type Tool } from './types.js';
import type { ToolDisplay } from '../types.js';

/**
 * apply_patch — multi-file patch in the "*** Begin Patch" envelope format
 * (an open format used by several agents; many models are trained to emit it).
 *
 *   *** Begin Patch
 *   *** Add File: path/new.ts
 *   +line
 *   *** Update File: path/old.ts
 *   *** Move to: path/renamed.ts        (optional)
 *   @@ optional context header
 *    context
 *   -removed
 *   +added
 *   *** Delete File: path/gone.ts
 *   *** End Patch
 */

export type PatchOp =
  | { type: 'add'; path: string; content: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; moveTo?: string; chunks: Chunk[] };

interface Chunk {
  header?: string;
  oldLines: string[];
  newLines: string[];
  eof: boolean;
}

export function parsePatch(text: string): PatchOp[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && !lines[i]!.startsWith('*** Begin Patch')) {
    if (lines[i]!.startsWith('*** ')) break; // tolerate a missing Begin marker
    i++;
  }
  if (lines[i]?.startsWith('*** Begin Patch')) i++;
  const ops: PatchOp[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('*** End Patch')) break;
    if (line.startsWith('*** Add File:')) {
      const p = line.slice('*** Add File:'.length).trim();
      i++;
      const body: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith('*** ')) {
        const l = lines[i]!;
        body.push(l.startsWith('+') ? l.slice(1) : l);
        i++;
      }
      if (body.length && body[body.length - 1] === '') body.pop();
      ops.push({ type: 'add', path: p, content: body.join('\n') + '\n' });
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      ops.push({ type: 'delete', path: line.slice('*** Delete File:'.length).trim() });
      i++;
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const p = line.slice('*** Update File:'.length).trim();
      i++;
      let moveTo: string | undefined;
      if (lines[i]?.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        i++;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      while (i < lines.length && !(lines[i]!.startsWith('*** ') && !lines[i]!.startsWith('*** End of File'))) {
        const l = lines[i]!;
        if (l.startsWith('@@')) {
          cur = { header: l.slice(2).trim() || undefined, oldLines: [], newLines: [], eof: false };
          chunks.push(cur);
        } else if (l.startsWith('*** End of File')) {
          if (cur) cur.eof = true;
        } else {
          if (!cur) {
            cur = { oldLines: [], newLines: [], eof: false };
            chunks.push(cur);
          }
          if (l.startsWith('+')) cur.newLines.push(l.slice(1));
          else if (l.startsWith('-')) cur.oldLines.push(l.slice(1));
          else {
            const c = l.startsWith(' ') ? l.slice(1) : l;
            cur.oldLines.push(c);
            cur.newLines.push(c);
          }
        }
        i++;
      }
      // drop trailing blank context lines that are artefacts of the envelope
      for (const c of chunks) {
        while (c.oldLines.length && c.newLines.length && c.oldLines[c.oldLines.length - 1] === '' && c.newLines[c.newLines.length - 1] === '') {
          c.oldLines.pop();
          c.newLines.pop();
        }
      }
      ops.push({ type: 'update', path: p, moveTo, chunks: chunks.filter((c) => c.oldLines.length || c.newLines.length) });
      continue;
    }
    i++;
  }
  return ops;
}

export function applyChunks(content: string, chunks: Chunk[]): string {
  const eol = detectEol(content);
  const hadTrailing = content.endsWith('\n');
  const lines = content.split(/\r?\n/);
  if (hadTrailing) lines.pop();
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.header) {
      const h = findSeq(lines, [ch.header], cursor, false);
      if (h !== -1) cursor = h + 1;
    }
    if (!ch.oldLines.length) {
      // pure insertion: at EOF (or right after the header)
      const at = ch.header ? cursor : lines.length;
      lines.splice(at, 0, ...ch.newLines);
      cursor = at + ch.newLines.length;
      continue;
    }
    let at = findSeq(lines, ch.oldLines, cursor, ch.eof);
    if (at === -1) at = findSeq(lines, ch.oldLines, 0, ch.eof);
    if (at === -1) {
      throw new Error(`Could not find the lines to replace:\n${ch.oldLines.slice(0, 6).join('\n')}${ch.oldLines.length > 6 ? '\n…' : ''}`);
    }
    lines.splice(at, ch.oldLines.length, ...ch.newLines);
    cursor = at + ch.newLines.length;
  }
  return lines.join(eol) + (hadTrailing || !content ? eol : '');
}

function findSeq(lines: string[], seq: string[], from: number, preferEnd: boolean): number {
  const cmps = [(a: string, b: string) => a === b, (a: string, b: string) => a.trimEnd() === b.trimEnd(), (a: string, b: string) => a.trim() === b.trim()];
  for (const cmp of cmps) {
    if (preferEnd) {
      const start = lines.length - seq.length;
      if (start >= from && seq.every((s, j) => cmp(lines[start + j]!, s))) return start;
    }
    for (let i = from; i + seq.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < seq.length; j++) {
        if (!cmp(lines[i + j]!, seq[j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
  }
  return -1;
}

export const applyPatchTool: Tool<{ patch: string }> = {
  name: 'apply_patch',
  kind: 'edit',
  description:
    'Apply a multi-file patch. Format:\n*** Begin Patch\n*** Add File: <path>\n+<line>\n*** Update File: <path>\n@@ <optional context line>\n <context>\n-<old>\n+<new>\n*** Delete File: <path>\n*** End Patch\n' +
    'Use 3 lines of context around each change. Files being updated must have been read first.',
  parameters: {
    type: 'object',
    properties: { patch: { type: 'string', description: 'The full patch text' } },
    required: ['patch'],
  },
  title: (a) => {
    try {
      const ops = parsePatch(a.patch ?? '');
      return `Patch ${ops.length} file${ops.length === 1 ? '' : 's'}: ${ops
        .map((o) => o.path)
        .slice(0, 3)
        .join(', ')}${ops.length > 3 ? '…' : ''}`;
    } catch {
      return 'Apply patch';
    }
  },
  paths: (a, cwd) => {
    try {
      return parsePatch(a.patch ?? '').flatMap((o) => [resolvePath(o.path, cwd), ...(o.type === 'update' && o.moveTo ? [resolvePath(o.moveTo, cwd)] : [])]);
    } catch {
      return [];
    }
  },
  async run(a, ctx) {
    if (typeof a.patch !== 'string' || !a.patch.trim()) return errorResult('"patch" is required');
    let ops: PatchOp[];
    try {
      ops = parsePatch(a.patch);
    } catch (err) {
      return errorResult(`Invalid patch: ${(err as Error).message}`);
    }
    if (!ops.length) return errorResult('No file operations found. Use "*** Add File:", "*** Update File:" or "*** Delete File:" sections.');

    // Validate and compute all results before writing anything (all-or-nothing).
    const planned: { abs: string; before: string | null; after: string | null; moveFrom?: string }[] = [];
    for (const op of ops) {
      const abs = resolvePath(op.path, ctx.cwd);
      const before = readTextIfExists(abs);
      if (op.type === 'add') {
        if (before !== null) return errorResult(`Cannot add ${op.path}: file already exists (use Update File).`);
        planned.push({ abs, before: null, after: op.content });
      } else if (op.type === 'delete') {
        if (before === null) return errorResult(`Cannot delete ${op.path}: file not found.`);
        planned.push({ abs, before, after: null });
      } else {
        if (before === null) return errorResult(`Cannot update ${op.path}: file not found.`);
        if (!ctx.readTracker.has(abs)) return errorResult(`Read ${op.path} with read_file before patching it.`);
        let after: string;
        try {
          after = applyChunks(before, op.chunks);
        } catch (err) {
          return errorResult(`Failed to apply hunk to ${op.path}: ${(err as Error).message}\nRe-read the file and retry with exact context.`);
        }
        if (op.moveTo) {
          const dest = resolvePath(op.moveTo, ctx.cwd);
          planned.push({ abs, before, after: null });
          planned.push({ abs: dest, before: readTextIfExists(dest), after, moveFrom: abs });
        } else planned.push({ abs, before, after });
      }
    }
    const displays: ToolDisplay[] = [];
    const summary: string[] = [];
    for (const p of planned) {
      if (p.after === null) fs.rmSync(p.abs, { force: true });
      else writeText(p.abs, p.after);
      ctx.recordFileChange(p.abs, p.before, p.after);
      if (p.after !== null) {
        try {
          ctx.readTracker.set(p.abs, fs.statSync(p.abs).mtimeMs);
        } catch {
          /* ignore */
        }
      }
      const d = makeDiff(p.abs, p.before, p.after, ctx.cwd);
      displays.push(d);
      summary.push(`${p.after === null ? 'D' : p.before === null ? 'A' : 'M'} ${displayPath(p.abs, ctx.cwd)} (+${d.added} −${d.removed})`);
    }
    return textResult(`Patch applied:\n${summary.join('\n')}`, displays.length === 1 ? displays[0] : { kind: 'multi', items: displays });
  },
};

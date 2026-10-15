import { useMemo, useState } from 'react';
import { diffLines } from 'diff';
import { ChevronsUpDown } from 'lucide-react';
import { classNames as cx } from '../lib/format';

interface Line {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'skip';
  text: string;
  old?: number;
  new?: number;
  hidden?: number;
}

/** Render a unified diff (as produced by `diff`/git). */
export function UnifiedDiff({ diff, maxLines = 400, className }: { diff: string; maxLines?: number; className?: string }) {
  const lines = useMemo(() => parseUnified(diff), [diff]);
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, maxLines);
  return (
    <div className={cx('overflow-x-auto rounded-lg border border-line bg-panel font-mono text-[12px] leading-[1.55]', className)}>
      <table className="w-full border-collapse">
        <tbody>
          {shown.map((l, i) => (
            <DiffRow key={i} l={l} />
          ))}
        </tbody>
      </table>
      {lines.length > shown.length && (
        <button onClick={() => setAll(true)} className="w-full border-t border-line py-1.5 text-[11px] text-muted hover:bg-hover hover:text-fg">
          Show {lines.length - shown.length} more lines
        </button>
      )}
    </div>
  );
}

function DiffRow({ l }: { l: Line }) {
  if (l.kind === 'hunk')
    return (
      <tr className="bg-info/5 text-info/80">
        <td colSpan={3} className="px-3 py-0.5 text-[11px]">
          {l.text}
        </td>
      </tr>
    );
  if (l.kind === 'skip')
    return (
      <tr className="bg-elev/60 text-faint">
        <td colSpan={3} className="px-3 py-0.5 text-[11px]">
          <ChevronsUpDown className="mr-1 inline size-3" />
          {l.hidden} unchanged lines
        </td>
      </tr>
    );
  const bg = l.kind === 'add' ? 'bg-ok/[.08]' : l.kind === 'del' ? 'bg-bad/[.08]' : '';
  const fg = l.kind === 'add' ? 'text-ok' : l.kind === 'del' ? 'text-bad' : 'text-fg/80';
  return (
    <tr className={bg}>
      <td className="w-10 select-none border-r border-line px-2 text-right text-[11px] text-faint">{l.old ?? ''}</td>
      <td className="w-10 select-none border-r border-line px-2 text-right text-[11px] text-faint">{l.new ?? ''}</td>
      <td className={cx('whitespace-pre px-3', fg)}>
        <span className="mr-2 select-none opacity-60">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
        {l.text}
      </td>
    </tr>
  );
}

export function parseUnified(diff: string): Line[] {
  const out: Line[] = [];
  let o = 0;
  let n = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('Index:') || raw.startsWith('====') || raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('diff --git') || raw.startsWith('index ') || raw.startsWith('\\ No newline')) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      out.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (raw.startsWith('+')) out.push({ kind: 'add', text: raw.slice(1), new: n++ });
    else if (raw.startsWith('-')) out.push({ kind: 'del', text: raw.slice(1), old: o++ });
    else if (raw.startsWith(' ') || raw === '') {
      if (!out.length && raw === '') continue;
      out.push({ kind: 'ctx', text: raw.slice(1), old: o++, new: n++ });
    }
  }
  while (out.length && out[out.length - 1]!.kind === 'ctx' && out[out.length - 1]!.text === '') out.pop();
  return out;
}

/** Diff two versions of a file with collapsed context. */
export function FileDiff({ before, after, context = 3, className }: { before: string; after: string; context?: number; className?: string }) {
  const lines = useMemo(() => {
    const parts = diffLines(before, after);
    const rows: Line[] = [];
    let o = 1;
    let n = 1;
    for (const p of parts) {
      const ls = p.value.replace(/\n$/, '').split('\n');
      if (p.added) for (const t of ls) rows.push({ kind: 'add', text: t, new: n++ });
      else if (p.removed) for (const t of ls) rows.push({ kind: 'del', text: t, old: o++ });
      else for (const t of ls) rows.push({ kind: 'ctx', text: t, old: o++, new: n++ });
    }
    // collapse long unchanged runs
    const out: Line[] = [];
    let i = 0;
    while (i < rows.length) {
      if (rows[i]!.kind !== 'ctx') {
        out.push(rows[i]!);
        i++;
        continue;
      }
      let j = i;
      while (j < rows.length && rows[j]!.kind === 'ctx') j++;
      const run = rows.slice(i, j);
      const head = i === 0 ? 0 : context;
      const tail = j === rows.length ? 0 : context;
      if (run.length > head + tail + 2) {
        out.push(...run.slice(0, head));
        out.push({ kind: 'skip', text: '', hidden: run.length - head - tail });
        out.push(...run.slice(run.length - tail));
      } else out.push(...run);
      i = j;
    }
    return out;
  }, [before, after, context]);
  return (
    <div className={cx('overflow-x-auto rounded-lg border border-line bg-panel font-mono text-[12px] leading-[1.55]', className)}>
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((l, i) => (
            <DiffRow key={i} l={l} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function diffStats(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const p of diffLines(before, after)) {
    if (p.added) added += p.count ?? 0;
    if (p.removed) removed += p.count ?? 0;
  }
  return { added, removed };
}

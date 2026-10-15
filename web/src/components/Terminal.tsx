import { useEffect, useRef, useState } from 'react';
import { Play, Square, Terminal as TermIcon, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { post } from '../lib/api';
import { useStore } from '../lib/store';
import { classNames as cx } from '../lib/format';

const COLORS: Record<number, string> = { 30: '#6b6b78', 31: '#f87171', 32: '#4ade80', 33: '#fbbf24', 34: '#60a5fa', 35: '#c084fc', 36: '#67e8f9', 37: '#e5e5e5', 90: '#8b8b96', 91: '#fca5a5', 92: '#86efac', 93: '#fde68a', 94: '#93c5fd', 95: '#d8b4fe', 96: '#a5f3fc', 97: '#ffffff' };

/** Minimal ANSI SGR → spans (colors + bold), everything else stripped. */
export function Ansi({ text }: { text: string }) {
  const parts: { t: string; color?: string; bold?: boolean }[] = [];
  let color: string | undefined;
  let bold = false;
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[ -/]*[@-ln-~]|\r(?!\n)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ t: text.slice(last, m.index), color, bold });
    last = re.lastIndex;
    if (m[1] === undefined) continue;
    for (const code of (m[1] || '0').split(';').map(Number)) {
      if (code === 0) {
        color = undefined;
        bold = false;
      } else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) color = undefined;
      else if (COLORS[code]) color = COLORS[code];
    }
  }
  if (last < text.length) parts.push({ t: text.slice(last), color, bold });
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} style={{ color: p.color, fontWeight: p.bold ? 600 : undefined }}>
          {p.t}
        </span>
      ))}
    </>
  );
}

export function TerminalPanel({ agentId }: { agentId?: string }) {
  const terminals = useStore((s) => s.terminals);
  const order = useStore((s) => s.terminalOrder);
  const add = useStore((s) => s.addTerminal);
  const clear = useStore((s) => s.clearTerminals);
  const [cmd, setCmd] = useState('');
  const [hist, setHist] = useState<string[]>(() => JSON.parse(localStorage.getItem('drakox.termhist') ?? '[]'));
  const [hi, setHi] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const totalLen = order.reduce((n, id) => n + (terminals[id]?.output.length ?? 0), 0);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [totalLen, order.length]);
  const run = async () => {
    const c = cmd.trim();
    if (!c) return;
    setCmd('');
    setHi(-1);
    const nh = [c, ...hist.filter((h) => h !== c)].slice(0, 50);
    setHist(nh);
    localStorage.setItem('drakox.termhist', JSON.stringify(nh));
    try {
      const r = await post<{ id: string }>('/api/terminal', { command: c, agent: agentId });
      add({ id: r.id, command: c, output: '', startedAt: Date.now() });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3 text-[11.5px] text-muted">
        <TermIcon className="size-3.5" /> Terminal
        <span className="text-faint">· runs in your workspace with your shell</span>
        <div className="flex-1" />
        <button onClick={clear} title="Clear" className="rounded p-1 hover:bg-hover hover:text-fg">
          <Trash2 className="size-3.5" />
        </button>
      </div>
      <div ref={box} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {order.map((id) => {
          const t = terminals[id]!;
          return (
            <div key={id} className="mb-2">
              <div className="term flex items-center gap-2 text-info">
                <span className="text-brand">❯</span> {t.command}
                {t.code === undefined ? (
                  <button onClick={() => post(`/api/terminal/${id}/kill`)} title="Stop" className="ml-auto rounded p-0.5 text-faint hover:text-bad">
                    <Square className="size-3" />
                  </button>
                ) : (
                  <span className={cx('ml-auto text-[10.5px]', t.code === 0 ? 'text-ok' : 'text-bad')}>exit {t.code}</span>
                )}
              </div>
              <div className="term text-fg/85">
                <Ansi text={t.output} />
              </div>
            </div>
          );
        })}
        {!order.length && <div className="term text-faint">Run tests, builds or git commands. Output streams live.</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-1.5">
        <span className="font-mono text-[12px] text-brand">❯</span>
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run();
            if (e.key === 'ArrowUp' && hist.length) {
              e.preventDefault();
              const n = Math.min(hi + 1, hist.length - 1);
              setHi(n);
              setCmd(hist[n]!);
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              const n = hi - 1;
              setHi(Math.max(-1, n));
              setCmd(n >= 0 ? hist[n]! : '');
            }
          }}
          placeholder="npm test"
          className="h-7 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-faint"
        />
        <button onClick={() => void run()} className="rounded p-1 text-muted hover:bg-hover hover:text-fg" title="Run">
          <Play className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

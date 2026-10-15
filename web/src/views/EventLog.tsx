import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Download, ScrollText } from 'lucide-react';
import { useStore } from '../lib/store';
import { navigate } from '../lib/route';
import { Button, Empty, IconButton, Input } from '../components/ui';
import { classNames as cx } from '../lib/format';

const TONE: Record<string, string> = {
  user_message: 'text-brand',
  assistant_message: 'text-fg',
  tool_start: 'text-info',
  tool_result: 'text-info',
  approval_request: 'text-warn',
  approval_response: 'text-warn',
  file_change: 'text-ok',
  error: 'text-bad',
  notice: 'text-muted',
  subagent: 'text-violet',
};

/** Append-only, replayable event log — the audit trail of everything the agent did. */
export function EventLog({ id }: { id: string }) {
  const data = useStore((s) => s.agents[id]);
  const load = useStore((s) => s.loadAgent);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    void load(id);
  }, [id, load]);
  const events = useMemo(() => (data?.events ?? []).map((e, i) => ({ e, i })).filter(({ e }) => !filter || e.type.includes(filter) || JSON.stringify(e).toLowerCase().includes(filter.toLowerCase())), [data?.events, filter]);
  const download = () => {
    const blob = new Blob([(data?.events ?? []).map((e) => JSON.stringify(e)).join('\n') + '\n'], { type: 'application/x-ndjson' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `drakox-${id}.jsonl`;
    a.click();
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <IconButton label="Back" onClick={() => navigate(`#/agent/${encodeURIComponent(id)}`)}>
          <ArrowLeft className="size-4" />
        </IconButton>
        <ScrollText className="size-4 text-brand" />
        <span className="text-[14px] font-semibold">Event log</span>
        <span className="truncate text-[12.5px] text-muted">{data?.item.title}</span>
        <div className="flex-1" />
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" className="h-8 w-56" />
        <Button size="sm" icon={<Download className="size-3.5" />} onClick={download}>
          Export JSONL
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto font-mono text-[12px]">
        {!events.length && <Empty title="No events" />}
        {events.map(({ e, i }) => (
          <div key={i} className="border-b border-line/60">
            <button onClick={() => setOpen(open === i ? null : i)} className="flex w-full items-center gap-3 px-4 py-1.5 text-left hover:bg-hover/50">
              <span className="w-10 shrink-0 text-right text-faint">{i}</span>
              <span className="w-24 shrink-0 text-faint">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className={cx('w-40 shrink-0', TONE[e.type] ?? 'text-muted')}>{e.type === 'subagent' ? `subagent:${e.event.type}` : e.type}</span>
              <span className="min-w-0 flex-1 truncate text-muted">{preview(e)}</span>
            </button>
            {open === i && <pre className="overflow-x-auto bg-panel px-4 py-2 text-[11.5px] text-fg/80">{JSON.stringify(e, null, 2)}</pre>}
          </div>
        ))}
      </div>
    </div>
  );
}

function preview(e: any): string {
  switch (e.type) {
    case 'user_message':
      return e.displayText ?? e.content;
    case 'assistant_message':
      return e.content || (e.toolCalls?.length ? `→ ${e.toolCalls.map((c: any) => c.name).join(', ')}` : '');
    case 'tool_start':
      return e.title;
    case 'tool_result':
      return `${e.isError ? '✗' : '✓'} ${e.name} (${e.durationMs}ms)`;
    case 'approval_request':
      return e.request.title;
    case 'approval_response':
      return `${e.decision}${e.auto ? ' (auto)' : ''}${e.feedback ? ` — ${e.feedback}` : ''}`;
    case 'file_change':
      return e.path;
    case 'usage':
      return `${e.usage.inputTokens} in / ${e.usage.outputTokens} out`;
    case 'subagent':
      return `${e.agent}: ${preview(e.event)}`;
    default:
      return e.message ?? e.title ?? e.mode ?? e.model ?? '';
  }
}

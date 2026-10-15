import { memo, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  ClipboardList,
  Eye,
  FileEdit,
  Globe,
  HelpCircle,
  History,
  Info,
  Layers,
  ListChecks,
  Loader2,
  Puzzle,
  ShieldAlert,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { AgentEvent, ApprovalRequest, ToolDisplay } from '../lib/types';
import type { AgentData } from '../lib/store';
import { post } from '../lib/api';
import { Markdown } from './Markdown';
import { UnifiedDiff } from './DiffView';
import { Badge, Button, Textarea } from './ui';
import { classNames as cx, formatDuration } from '../lib/format';

type Ev<T extends AgentEvent['type']> = Extract<AgentEvent, { type: T }>;

type Item =
  | { kind: 'user'; e: Ev<'user_message'> }
  | { kind: 'assistant'; id: string; text: string; reasoning?: string; streaming: boolean; durationMs?: number }
  | { kind: 'tool'; id: string; start?: Ev<'tool_start'>; result?: Ev<'tool_result'>; sub: Ev<'subagent'>[] }
  | { kind: 'approval'; req: ApprovalRequest; res?: Ev<'approval_response'>; sub?: string }
  | { kind: 'question'; e: Ev<'question'>; answer?: string }
  | { kind: 'plan'; e: Ev<'plan'>; final?: Ev<'plan'> }
  | { kind: 'notice'; e: Ev<'notice'> | Ev<'error'> }
  | { kind: 'divider'; label: string; icon: ReactNode }
  | { kind: 'turn_end'; e: Ev<'turn_end'>; started?: number; files: number }
  | { kind: 'artifact'; e: Ev<'artifact'> };

function buildItems(events: AgentEvent[], streams: AgentData['streams']): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { kind: 'tool' }>>();
  const approvals = new Map<string, Extract<Item, { kind: 'approval' }>>();
  const questions = new Map<string, Extract<Item, { kind: 'question' }>>();
  const plans = new Map<string, Extract<Item, { kind: 'plan' }>>();
  const assistants = new Map<string, Extract<Item, { kind: 'assistant' }>>();
  let turnStart: number | undefined;
  let turnFiles = new Set<string>();
  const tool = (id: string) => {
    let t = tools.get(id);
    if (!t) {
      t = { kind: 'tool', id, sub: [] };
      tools.set(id, t);
      items.push(t);
    }
    return t;
  };
  for (const e of events) {
    switch (e.type) {
      case 'user_message':
        items.push({ kind: 'user', e });
        turnStart = e.ts;
        turnFiles = new Set();
        break;
      case 'assistant_start': {
        const a: Extract<Item, { kind: 'assistant' }> = { kind: 'assistant', id: e.id, text: '', streaming: true };
        assistants.set(e.id, a);
        items.push(a);
        break;
      }
      case 'assistant_message': {
        const a = assistants.get(e.id);
        if (a) {
          a.text = e.content;
          a.reasoning = e.reasoning;
          a.streaming = false;
          a.durationMs = e.durationMs;
        } else items.push({ kind: 'assistant', id: e.id, text: e.content, reasoning: e.reasoning, streaming: false, durationMs: e.durationMs });
        break;
      }
      case 'tool_start':
        tool(e.id).start = e;
        break;
      case 'tool_result':
        tool(e.id).result = e;
        break;
      case 'subagent':
        if (e.event.type === 'approval_request') {
          const it: Extract<Item, { kind: 'approval' }> = { kind: 'approval', req: e.event.request, sub: e.agent };
          approvals.set(e.event.request.id, it);
          items.push(it);
        } else if (e.event.type === 'approval_response' && approvals.has(e.event.id)) approvals.get(e.event.id)!.res = e.event;
        else tool(e.parentToolCallId).sub.push(e);
        break;
      case 'approval_request': {
        const it: Extract<Item, { kind: 'approval' }> = { kind: 'approval', req: e.request };
        approvals.set(e.request.id, it);
        items.push(it);
        break;
      }
      case 'approval_response':
        if (approvals.has(e.id)) approvals.get(e.id)!.res = e;
        break;
      case 'question': {
        const it: Extract<Item, { kind: 'question' }> = { kind: 'question', e };
        questions.set(e.id, it);
        items.push(it);
        break;
      }
      case 'answer':
        if (questions.has(e.id)) questions.get(e.id)!.answer = e.answer;
        break;
      case 'plan': {
        const existing = plans.get(e.id);
        if (existing) existing.final = e;
        else {
          const it: Extract<Item, { kind: 'plan' }> = { kind: 'plan', e };
          plans.set(e.id, it);
          items.push(it);
        }
        break;
      }
      case 'file_change':
        turnFiles.add(e.path);
        break;
      case 'notice':
      case 'error':
        items.push({ kind: 'notice', e });
        break;
      case 'compaction':
        items.push({ kind: 'divider', label: `Compacted ${e.removedMessages} earlier messages into a summary`, icon: <Layers className="size-3" /> });
        break;
      case 'rewind':
        items.push({ kind: 'divider', label: `Rewound to before turn ${e.toTurn}${e.restoredFiles.length ? ` · restored ${e.restoredFiles.length} file(s)` : ''}`, icon: <History className="size-3" /> });
        break;
      case 'mode_change':
        items.push({ kind: 'divider', label: `Mode → ${e.mode}`, icon: <ShieldAlert className="size-3" /> });
        break;
      case 'model_change':
        items.push({ kind: 'divider', label: `Model → ${e.model}`, icon: <Sparkles className="size-3" /> });
        break;
      case 'turn_end':
        items.push({ kind: 'turn_end', e, started: turnStart, files: turnFiles.size });
        break;
      case 'artifact':
        if (e.artifact.kind !== 'plan') items.push({ kind: 'artifact', e });
        break;
      default:
        break;
    }
  }
  for (const a of assistants.values()) {
    const s = streams[a.id];
    if (s && a.streaming) {
      a.text = s.text;
      a.reasoning = s.reasoning;
    }
  }
  // drop empty finished assistant bubbles (tool-call-only responses)
  return items.filter((i) => !(i.kind === 'assistant' && !i.streaming && !i.text.trim() && !i.reasoning));
}

export function Timeline({ agentId, data }: { agentId: string; data: AgentData }) {
  const items = useMemo(() => buildItems(data.events, data.streams), [data.events, data.streams]);
  const running = data.item.status === 'running' || data.item.status === 'awaiting_input';
  const lastIsActivity = items.length > 0 && (items[items.length - 1]!.kind === 'assistant' || items[items.length - 1]!.kind === 'tool');
  return (
    <div className="space-y-3">
      {items.map((it, i) => (
        <TimelineItem key={i} it={it} agentId={agentId} data={data} />
      ))}
      {running && !lastIsActivity && !Object.keys(data.approvals).length && !Object.keys(data.questions).length && !Object.keys(data.plans).length && (
        <div className="flex items-center gap-2 pl-1 text-[13px]">
          <Loader2 className="size-3.5 animate-spin text-brand" />
          <span className="shimmer-text">Working…</span>
        </div>
      )}
    </div>
  );
}

const TimelineItem = memo(function TimelineItem({ it, agentId, data }: { it: Item; agentId: string; data: AgentData }) {
  switch (it.kind) {
    case 'user':
      return <UserBubble e={it.e} />;
    case 'assistant':
      return <AssistantBlock text={it.text} reasoning={it.reasoning} streaming={it.streaming} />;
    case 'tool':
      return <ToolCard t={it} output={data.toolOutput[it.id]} activity={data.subActivity[it.id]} cwd={data.item.cwd} />;
    case 'approval':
      return <ApprovalCard agentId={agentId} req={it.req} res={it.res} sub={it.sub} pending={Boolean(data.approvals[it.req.id])} />;
    case 'question':
      return <QuestionCard agentId={agentId} e={it.e} answer={it.answer} pending={Boolean(data.questions[it.e.id])} />;
    case 'plan':
      return <PlanCard agentId={agentId} e={it.e} final={it.final} pending={Boolean(data.plans[it.e.id])} />;
    case 'notice':
      return <NoticeLine e={it.e} />;
    case 'divider':
      return (
        <div className="flex items-center gap-3 py-1 text-[11px] text-faint">
          <div className="h-px flex-1 bg-line" />
          <span className="inline-flex items-center gap-1.5">
            {it.icon}
            {it.label}
          </span>
          <div className="h-px flex-1 bg-line" />
        </div>
      );
    case 'turn_end':
      return <TurnEnd e={it.e} started={it.started} files={it.files} />;
    case 'artifact':
      return (
        <div className="rounded-xl border border-violet/30 bg-violet/5 p-3.5">
          <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-violet">
            <Eye className="size-3.5" /> {it.e.artifact.title}
          </div>
          <Markdown text={it.e.artifact.markdown ?? ''} />
        </div>
      );
  }
});

function UserBubble({ e }: { e: Ev<'user_message'> }) {
  const text = e.displayText ?? e.content;
  const isCommand = text.startsWith('/');
  return (
    <div className="flex justify-end fade-in">
      <div className="max-w-[85%] rounded-2xl rounded-br-md border border-line bg-elev px-3.5 py-2.5 text-[14px] leading-relaxed">
        {e.images?.length ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {e.images.map((im, i) => (
              <img key={i} src={`data:${im.mediaType};base64,${im.data}`} className="h-20 rounded-lg border border-line object-cover" alt="" />
            ))}
          </div>
        ) : null}
        <div className={cx('whitespace-pre-wrap break-words', isCommand && 'font-mono text-[13px] text-brand')}>{text.length > 4000 ? text.slice(0, 4000) + '…' : text}</div>
      </div>
    </div>
  );
}

function AssistantBlock({ text, reasoning, streaming }: { text: string; reasoning?: string; streaming: boolean }) {
  const [showReasoning, setShowReasoning] = useState(false);
  return (
    <div className="flex gap-3 fade-in">
      <div className="mt-1 flex size-5 shrink-0 items-center justify-center rounded-md brand-gradient">
        <span className="text-[10px] font-black text-white">X</span>
      </div>
      <div className="min-w-0 flex-1">
        {reasoning ? (
          <button onClick={() => setShowReasoning((s) => !s)} className="mb-1 inline-flex items-center gap-1 text-[12px] text-faint hover:text-muted">
            <Brain className="size-3" />
            {streaming && !text ? <span className="shimmer-text">Thinking…</span> : 'Thought process'}
            {showReasoning ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
        ) : null}
        {showReasoning && reasoning && <div className="mb-2 whitespace-pre-wrap border-l-2 border-line pl-3 text-[12.5px] italic text-muted">{reasoning}</div>}
        {text ? <Markdown text={text} streaming={streaming} /> : streaming && !reasoning ? <span className="shimmer-text text-[13px]">Thinking…</span> : null}
      </div>
    </div>
  );
}

const KIND_ICON: Record<string, ReactNode> = {
  read: <Eye className="size-3.5" />,
  edit: <FileEdit className="size-3.5" />,
  execute: <Terminal className="size-3.5" />,
  network: <Globe className="size-3.5" />,
  meta: <Sparkles className="size-3.5" />,
  mcp: <Puzzle className="size-3.5" />,
};

function toolIcon(name: string, kind?: string): ReactNode {
  if (name === 'task') return <Bot className="size-3.5" />;
  if (name === 'todo_write') return <ListChecks className="size-3.5" />;
  if (name === 'submit_plan') return <ClipboardList className="size-3.5" />;
  if (name === 'ask_user') return <HelpCircle className="size-3.5" />;
  return KIND_ICON[kind ?? 'meta'];
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function ToolCard({ t, output, activity, cwd }: { t: Extract<Item, { kind: 'tool' }>; output?: string; activity?: string; cwd: string }) {
  const name = t.start?.name ?? t.result?.name ?? 'tool';
  const title = t.start?.title ?? name;
  const done = Boolean(t.result);
  const error = t.result?.isError;
  const display = t.result?.display;
  const isTask = name === 'task';
  const quiet = name === 'todo_write' || name === 'skill';
  const defaultOpen = Boolean(error) || display?.kind === 'diff' || isTask || (display?.kind === 'terminal' && display.exitCode !== 0);
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? defaultOpen;
  const kindColor = error ? 'text-bad' : name === 'task' ? 'text-violet' : t.start?.kind === 'edit' ? 'text-warn' : t.start?.kind === 'execute' ? 'text-info' : t.start?.kind === 'mcp' ? 'text-violet' : 'text-muted';
  const text = typeof t.result?.content === 'string' ? t.result.content : Array.isArray(t.result?.content) ? t.result!.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n') : '';
  const summary = summarize(display, text, error);
  if (quiet && !error) {
    return (
      <div className="flex items-center gap-2 pl-8 text-[12px] text-faint">
        {toolIcon(name, t.start?.kind)}
        <span>{title}</span>
      </div>
    );
  }
  return (
    <div className={cx('ml-8 overflow-hidden rounded-xl border bg-panel transition-colors fade-in', error ? 'border-bad/30' : 'border-line', !done && 'border-line-strong')}>
      <button onClick={() => setOpen(!isOpen)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-hover/50">
        <span className={kindColor}>{toolIcon(name, t.start?.kind)}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{title}</span>
        {summary && <span className="hidden shrink-0 text-[11.5px] text-muted sm:inline">{summary}</span>}
        {!done ? <Loader2 className="size-3.5 shrink-0 animate-spin text-brand" /> : error ? <X className="size-3.5 shrink-0 text-bad" /> : <Check className="size-3.5 shrink-0 text-ok" />}
        {t.result && <span className="w-10 shrink-0 text-right text-[10.5px] text-faint">{formatDuration(t.result.durationMs)}</span>}
        {isOpen ? <ChevronDown className="size-3.5 shrink-0 text-faint" /> : <ChevronRight className="size-3.5 shrink-0 text-faint" />}
      </button>
      {!done && !isOpen && output && <div className="term truncate border-t border-line px-3 py-1 text-faint">{stripAnsi(output).trim().split('\n').pop()}</div>}
      {isTask && !done && !isOpen && activity && <div className="truncate border-t border-line px-3 py-1 text-[12px] text-faint">{activity.split('\n').pop()}</div>}
      {isOpen && (
        <div className="space-y-2 border-t border-line px-3 py-2.5">
          {isTask && <SubagentActivity sub={t.sub} activity={done ? undefined : activity} />}
          {display?.kind === 'diff' && <UnifiedDiff diff={display.diff} maxLines={120} />}
          {display?.kind === 'multi' && display.items.map((d, i) => (d.kind === 'diff' ? <UnifiedDiff key={i} diff={d.diff} maxLines={80} /> : null))}
          {(display?.kind === 'terminal' || (!done && output)) && (
            <div className="max-h-80 overflow-auto rounded-lg border border-line bg-bg p-2.5">
              {t.start?.args?.command ? <div className="term mb-1 text-info">$ {String(t.start.args.command)}</div> : null}
              <div className="term text-fg/80">{stripAnsi(display?.kind === 'terminal' ? display.output : output ?? '').slice(-20000) || <span className="text-faint">(no output)</span>}</div>
              {display?.kind === 'terminal' && (
                <div className={cx('mt-1.5 text-[11px]', display.exitCode === 0 ? 'text-ok' : 'text-bad')}>{display.background ? 'running in background' : `exit ${display.exitCode ?? '?'}`}</div>
              )}
            </div>
          )}
          {(!display || display.kind === 'text') && done && !isTask && text && (
            <pre className={cx('max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-bg p-2.5 font-mono text-[11.5px] leading-relaxed', error ? 'text-bad' : 'text-fg/75')}>{text.length > 12000 ? text.slice(0, 12000) + '\n…' : text}</pre>
          )}
          {isTask && done && text && (
            <div className="rounded-lg border border-violet/20 bg-violet/5 p-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-violet">Report</div>
              <Markdown text={text} />
            </div>
          )}
          {t.start?.args && Object.keys(t.start.args).length > 0 && !isTask && <ArgsView args={t.start.args} cwd={cwd} />}
        </div>
      )}
    </div>
  );
}

function summarize(display: ToolDisplay | undefined, text: string, error?: boolean): string {
  if (error) return text.split('\n')[0]!.slice(0, 80);
  if (!display) return '';
  if (display.kind === 'diff') return `${display.isNew ? 'new · ' : ''}+${display.added} −${display.removed}`;
  if (display.kind === 'terminal') return display.background ? 'background' : display.exitCode === 0 ? 'exit 0' : `exit ${display.exitCode}`;
  return '';
}

function ArgsView({ args, cwd }: { args: Record<string, unknown>; cwd: string }) {
  const [open, setOpen] = useState(false);
  const json = JSON.stringify(args, (k, v) => (typeof v === 'string' && v.length > 600 ? v.slice(0, 600) + '…' : v), 2);
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-[11px] text-faint hover:text-muted">
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />} Input
      </button>
      {open && <pre className="mt-1 max-h-60 overflow-auto rounded-lg border border-line bg-bg p-2 font-mono text-[11px] text-muted">{json.replaceAll(cwd + '/', '')}</pre>}
    </div>
  );
}

function SubagentActivity({ sub, activity }: { sub: Ev<'subagent'>[]; activity?: string }) {
  const steps = useMemo(() => {
    const map = new Map<string, { title: string; done: boolean; error: boolean }>();
    for (const s of sub) {
      const e = s.event;
      if (e.type === 'tool_start') map.set(e.id, { title: e.title, done: false, error: false });
      if (e.type === 'tool_result') {
        const cur = map.get(e.id) ?? { title: e.name, done: false, error: false };
        map.set(e.id, { ...cur, done: true, error: e.isError });
      }
    }
    return [...map.values()];
  }, [sub]);
  const agentName = sub[0]?.agent;
  if (!steps.length && !activity) return <div className="text-[12px] text-faint">Sub-agent starting…</div>;
  return (
    <div className="rounded-lg border border-line bg-bg p-2.5">
      {agentName && (
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-violet">
          <Bot className="size-3" /> {agentName}
        </div>
      )}
      <div className="space-y-0.5">
        {steps.slice(-12).map((s, i) => (
          <div key={i} className="flex items-center gap-2 text-[12px]">
            {!s.done ? <Loader2 className="size-3 animate-spin text-brand" /> : s.error ? <X className="size-3 text-bad" /> : <Check className="size-3 text-ok" />}
            <span className={cx('truncate', s.done ? 'text-muted' : 'text-fg')}>{s.title}</span>
          </div>
        ))}
        {steps.length > 12 && <div className="text-[11px] text-faint">+ {steps.length - 12} earlier steps</div>}
      </div>
      {activity && <div className="mt-1.5 truncate text-[12px] italic text-faint">{activity.split('\n').filter(Boolean).pop()}</div>}
    </div>
  );
}

export function ApprovalCard({ agentId, req, res, sub, pending, compact }: { agentId: string; req: ApprovalRequest; res?: Ev<'approval_response'>; sub?: string; pending: boolean; compact?: boolean }) {
  const [feedback, setFeedback] = useState('');
  const [showFb, setShowFb] = useState(false);
  const [busy, setBusy] = useState(false);
  const respond = async (decision: 'allow_once' | 'allow_always' | 'deny') => {
    setBusy(true);
    try {
      await post(`/api/agents/${encodeURIComponent(agentId)}/approvals/${encodeURIComponent(req.id)}`, { decision, feedback: decision === 'deny' ? feedback || undefined : undefined });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!pending) {
    const allowed = res?.decision === 'allow_once' || res?.decision === 'allow_always';
    if (!res) return null;
    return (
      <div className="ml-8 flex items-center gap-2 text-[12px] text-faint">
        {allowed ? <Check className="size-3.5 text-ok" /> : <CircleSlash className="size-3.5 text-bad" />}
        <span>
          {allowed ? (res.decision === 'allow_always' ? 'Always allowed' : 'Allowed') : 'Denied'}: {req.title}
          {res.rule && <span className="ml-1 font-mono text-[11px]">({res.rule})</span>}
          {res.feedback && !allowed && <span className="ml-1 italic">— “{res.feedback}”</span>}
        </span>
      </div>
    );
  }
  const isDiff = req.detail && /^(---|\+\+\+|@@)/m.test(req.detail);
  return (
    <div className={cx('overflow-hidden rounded-xl border border-warn/40 bg-warn/[.04] fade-in', !compact && 'ml-8 glow')}>
      <div className="flex items-start gap-2.5 px-3.5 pt-3">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold">{req.title}</div>
          <div className="text-[12px] text-muted">
            {sub && <Badge tone="violet" className="mr-1.5">{sub}</Badge>}
            {req.reason}
          </div>
        </div>
        <Badge tone="warn">{req.tool}</Badge>
      </div>
      {req.detail && (
        <div className="px-3.5 pt-2.5">
          {isDiff ? <UnifiedDiff diff={req.detail} maxLines={compact ? 30 : 80} /> : <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-bg p-2.5 font-mono text-[12px] text-fg/85">{req.detail}</pre>}
        </div>
      )}
      {showFb && (
        <div className="px-3.5 pt-2.5">
          <Textarea autoFocus rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Tell DrakoX what to do instead…" onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && respond('deny')} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 px-3.5 py-3">
        <Button variant="primary" size="sm" loading={busy} onClick={() => respond('allow_once')} icon={<Check className="size-3.5" />}>
          Allow
        </Button>
        {req.ruleSuggestion && (
          <Button size="sm" disabled={busy} onClick={() => respond('allow_always')} title={`Adds the rule ${req.ruleSuggestion} to .drakox/settings.local.json`}>
            Always allow <span className="font-mono text-[11px] text-muted">{req.ruleSuggestion}</span>
          </Button>
        )}
        <div className="flex-1" />
        {showFb ? (
          <Button variant="danger" size="sm" disabled={busy} onClick={() => respond('deny')}>
            Deny with feedback
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setShowFb(true)}>
              Deny + feedback
            </Button>
            <Button variant="danger" size="sm" disabled={busy} onClick={() => respond('deny')} icon={<X className="size-3.5" />}>
              Deny
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function QuestionCard({ agentId, e, answer, pending }: { agentId: string; e: Ev<'question'>; answer?: string; pending: boolean }) {
  const [text, setText] = useState('');
  const send = async (a: string) => {
    try {
      await post(`/api/agents/${encodeURIComponent(agentId)}/questions/${encodeURIComponent(e.id)}`, { answer: a });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  return (
    <div className={cx('ml-8 rounded-xl border p-3.5 fade-in', pending ? 'border-info/40 bg-info/[.04] glow' : 'border-line bg-panel')}>
      <div className="flex items-start gap-2.5">
        <HelpCircle className="mt-0.5 size-4 shrink-0 text-info" />
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium">{e.question}</div>
          {answer !== undefined && <div className="mt-1 text-[12.5px] text-muted">↳ {answer}</div>}
          {pending && (
            <div className="mt-2.5 space-y-2">
              {e.options?.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {e.options.map((o) => (
                    <Button key={o} size="sm" onClick={() => send(o)}>
                      {o}
                    </Button>
                  ))}
                </div>
              ) : null}
              <div className="flex gap-2">
                <input
                  value={text}
                  onChange={(ev) => setText(ev.target.value)}
                  onKeyDown={(ev) => ev.key === 'Enter' && text.trim() && send(text.trim())}
                  placeholder="Type an answer…"
                  className="h-8 flex-1 rounded-lg border border-line bg-bg px-2.5 text-[13px] outline-none focus:border-info/50"
                />
                <Button size="sm" variant="primary" disabled={!text.trim()} onClick={() => send(text.trim())}>
                  Answer
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PlanCard({ agentId, e, final, pending }: { agentId: string; e: Ev<'plan'>; final?: Ev<'plan'>; pending: boolean }) {
  const [fb, setFb] = useState('');
  const [revise, setRevise] = useState(false);
  const respond = async (approved: boolean, mode?: string) => {
    try {
      await post(`/api/agents/${encodeURIComponent(agentId)}/plans/${encodeURIComponent(e.id)}`, { approved, mode, feedback: fb || undefined });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const status = final?.status ?? e.status;
  return (
    <div className={cx('ml-8 overflow-hidden rounded-xl border fade-in', pending ? 'border-info/40 glow' : 'border-line')}>
      <div className="flex items-center gap-2 border-b border-line bg-info/[.05] px-3.5 py-2">
        <ClipboardList className="size-4 text-info" />
        <span className="flex-1 text-[13px] font-semibold">Implementation plan</span>
        {status === 'approved' && <Badge tone="ok">approved{final?.mode ? ` → ${final.mode}` : ''}</Badge>}
        {status === 'rejected' && <Badge tone="bad">{final?.feedback ? 'revision requested' : 'rejected'}</Badge>}
        {status === 'proposed' && pending && <Badge tone="info">awaiting your review</Badge>}
      </div>
      <div className="bg-panel px-4 py-3">
        <Markdown text={e.markdown} />
        {final?.feedback && <div className="mt-2 border-l-2 border-warn/50 pl-3 text-[12.5px] italic text-muted">Feedback: {final.feedback}</div>}
      </div>
      {pending && (
        <div className="space-y-2 border-t border-line bg-panel px-3.5 py-3">
          {revise && <Textarea autoFocus rows={2} value={fb} onChange={(ev) => setFb(ev.target.value)} placeholder="What should change in the plan?" />}
          <div className="flex flex-wrap items-center gap-2">
            {revise ? (
              <>
                <Button variant="primary" size="sm" disabled={!fb.trim()} onClick={() => respond(false)}>
                  Send feedback
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setRevise(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button variant="primary" size="sm" onClick={() => respond(true, 'auto-edit')} icon={<Check className="size-3.5" />}>
                  Approve · auto-edit
                </Button>
                <Button size="sm" onClick={() => respond(true, 'ask')}>
                  Approve · ask each step
                </Button>
                <Button size="sm" onClick={() => respond(true, 'autopilot')}>
                  Approve · autopilot
                </Button>
                <div className="flex-1" />
                <Button variant="ghost" size="sm" onClick={() => setRevise(true)}>
                  Revise…
                </Button>
                <Button variant="danger" size="sm" onClick={() => respond(false)}>
                  Reject
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NoticeLine({ e }: { e: Ev<'notice'> | Ev<'error'> }) {
  const level = e.type === 'error' ? 'error' : e.level;
  const icon = level === 'error' ? <AlertTriangle className="size-3.5 text-bad" /> : level === 'warning' ? <AlertTriangle className="size-3.5 text-warn" /> : <Info className="size-3.5 text-info" />;
  return (
    <div className={cx('ml-8 flex items-start gap-2 rounded-lg px-3 py-2 text-[12.5px]', level === 'error' ? 'border border-bad/25 bg-bad/5 text-bad' : level === 'warning' ? 'border border-warn/25 bg-warn/5 text-fg/90' : 'text-muted')}>
      <span className="mt-0.5">{icon}</span>
      <span className="whitespace-pre-wrap break-words">{e.message}</span>
    </div>
  );
}

function TurnEnd({ e, started, files }: { e: Ev<'turn_end'>; started?: number; files: number }) {
  const dur = started ? formatDuration(e.ts - started) : '';
  const labels: Record<string, string> = {
    completed: 'Done',
    aborted: 'Interrupted',
    error: 'Stopped after an error',
    max_turns: 'Stopped: reached the step limit',
    budget: 'Stopped: session budget reached',
    plan_submitted: 'Plan submitted',
  };
  const tone = e.reason === 'completed' || e.reason === 'plan_submitted' ? 'text-faint' : 'text-warn';
  return (
    <div className={cx('ml-8 flex items-center gap-2 text-[11.5px]', tone)}>
      {e.reason === 'completed' ? <Check className="size-3" /> : <AlertTriangle className="size-3" />}
      <span>
        {labels[e.reason] ?? e.reason}
        {dur && ` · ${dur}`}
        {files > 0 && ` · ${files} file${files === 1 ? '' : 's'} changed`}
        {e.message && ` · ${e.message}`}
      </span>
    </div>
  );
}

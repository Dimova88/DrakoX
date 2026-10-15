import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, Check, Circle, CircleDot, Code2, FileDiff as FileDiffIcon, GitBranch, GitMerge, History, Layers, ListChecks, MoreHorizontal, PanelRightClose, PanelRightOpen, RotateCcw, ScrollText, Trash2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../lib/store';
import type { AgentEvent } from '../lib/types';

const NO_EVENTS: AgentEvent[] = [];
import { del, get, patch, post } from '../lib/api';
import { navigate } from '../lib/route';
import type { Mode } from '../lib/types';
import { Timeline } from '../components/Timeline';
import { Composer } from '../components/Composer';
import { FileDiff, diffStats } from '../components/DiffView';
import { Badge, Button, ContextRing, Empty, IconButton, Menu, MenuItem, Modal, Progress, Spinner, StatusDot, Tabs } from '../components/ui';
import { MODE_META } from '../components/Pickers';
import { classNames as cx, formatCost, formatTokens } from '../lib/format';

export function AgentView({ id }: { id: string }) {
  const data = useStore((s) => s.agents[id]);
  const loadAgent = useStore((s) => s.loadAgent);
  const [panel, setPanel] = useState(() => localStorage.getItem('drakox.panel') !== '0');
  const [tab, setTab] = useState<'tasks' | 'changes' | 'context'>('tasks');
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    loadAgent(id).catch((err) => toast.error(err.message));
  }, [id, loadAgent]);

  const eventCount = data?.events.length ?? 0;
  const streamLen = useMemo(() => Object.values(data?.streams ?? {}).reduce((n, s) => n + s.text.length + s.reasoning.length, 0), [data?.streams]);
  useEffect(() => {
    const el = scroller.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [eventCount, streamLen, atBottom]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const togglePanel = () => {
    setPanel((p) => {
      localStorage.setItem('drakox.panel', p ? '0' : '1');
      return !p;
    });
  };

  const item = data?.item;
  const running = item?.status === 'running' || item?.status === 'awaiting_input';

  const send = useCallback(
    async (text: string, images: { type: 'image'; mediaType: string; data: string }[]) => {
      setAtBottom(true);
      const res = await post<{ ok: boolean; action?: string; args?: string; message?: string }>(`/api/agents/${encodeURIComponent(id)}/messages`, { text, images });
      if (res.message) toast.success(res.message);
      if (res.action) handleAction(res.action, id, setTab, setPanel);
    },
    [id],
  );

  if (!data || !item || (!data.loaded && data.loading)) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }

  const todosDone = item.todos.filter((t) => t.status === 'completed').length;
  return (
    <div className="flex h-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <AgentHeader id={id} panel={panel} togglePanel={togglePanel} />
        <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-5 pb-8 pt-6">
            {data.events.length === 0 ? (
              <Empty icon={<CircleDot className="size-5" />} title="New agent">
                Describe what you want. DrakoX plans, edits, runs commands and checks its work — you stay in control with approvals, checkpoints and rewind.
              </Empty>
            ) : (
              <Timeline agentId={id} data={data} />
            )}
          </div>
          {!atBottom && (
            <button
              onClick={() => {
                const el = scroller.current;
                if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
              }}
              className="sticky bottom-3 left-1/2 mx-auto flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-line-strong bg-panel text-muted shadow-lg hover:text-fg"
            >
              <ArrowDown className="size-4" />
            </button>
          )}
        </div>
        <div className="mx-auto w-full max-w-3xl px-5 pb-4">
          {item.todos.length > 0 && running && (
            <div className="mb-2 flex items-center gap-3 rounded-xl border border-line bg-panel/80 px-3 py-1.5 text-[12px]">
              <ListChecks className="size-3.5 text-brand" />
              <span className="min-w-0 flex-1 truncate text-muted">{item.todos.find((t) => t.status === 'in_progress')?.activeForm ?? item.todos.find((t) => t.status === 'in_progress')?.content ?? 'Working…'}</span>
              <span className="text-faint">
                {todosDone}/{item.todos.length}
              </span>
              <Progress value={(todosDone / item.todos.length) * 100} className="w-20" />
            </div>
          )}
          <Composer
            agentId={id}
            autoFocus
            running={running}
            onStop={() => post(`/api/agents/${encodeURIComponent(id)}/abort`)}
            onSend={send}
            mode={item.mode}
            onModeChange={(m: Mode) => patch(`/api/agents/${encodeURIComponent(id)}`, { mode: m }).catch((e) => toast.error(e.message))}
            model={item.model}
            onModelChange={(m) => patch(`/api/agents/${encodeURIComponent(id)}`, { model: m }).catch((e) => toast.error(e.message))}
          />
        </div>
      </div>
      {panel && (
        <aside className="hidden w-[380px] shrink-0 flex-col border-l border-line bg-panel/40 lg:flex">
          <div className="px-3 pt-2">
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { value: 'tasks', label: 'Tasks', count: item.todos.length },
                { value: 'changes', label: 'Changes', count: item.filesChanged.length },
                { value: 'context', label: 'Context' },
              ]}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {tab === 'tasks' && <TasksPanel id={id} />}
            {tab === 'changes' && <ChangesPanel id={id} />}
            {tab === 'context' && <ContextPanel id={id} />}
          </div>
        </aside>
      )}
    </div>
  );
}

function handleAction(action: string, id: string, setTab: (t: 'tasks' | 'changes' | 'context') => void, setPanel: (v: boolean) => void) {
  switch (action) {
    case 'new':
      post('/api/agents', {}).then((a) => navigate(`#/agent/${encodeURIComponent(a.id)}`));
      break;
    case 'help':
      useStore.getState().setPalette(true);
      break;
    case 'models':
      navigate('#/settings/models');
      break;
    case 'mcp':
      navigate('#/integrations');
      break;
    case 'skills':
    case 'agents':
      navigate('#/skills');
      break;
    case 'permissions':
      navigate('#/settings/permissions');
      break;
    case 'diff':
      setPanel(true);
      setTab('changes');
      break;
    case 'cost':
    case 'status':
      setPanel(true);
      setTab('context');
      break;
    case 'sessions':
    case 'resume':
      navigate('#/');
      break;
    case 'rewind':
      toast.info('Use the rewind button (↶) in the header to pick a turn.');
      break;
    default:
      if (!['compact', 'undo', 'mode', 'model', 'title', 'trust', 'exit'].includes(action)) toast.info(`/${action} is available in the terminal (drakox).`);
  }
  void id;
}

function AgentHeader({ id, panel, togglePanel }: { id: string; panel: boolean; togglePanel: () => void }) {
  const maybeItem = useStore((s) => s.agents[id]?.item);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(maybeItem?.title ?? '');
  const [rewindOpen, setRewindOpen] = useState(false);
  useEffect(() => setTitle(maybeItem?.title ?? ''), [maybeItem?.title]);
  if (!maybeItem) return null;
  const item = maybeItem;
  const running = item.status === 'running' || item.status === 'awaiting_input';
  const saveTitle = async () => {
    setEditing(false);
    if (title.trim() && title !== item.title) await patch(`/api/agents/${encodeURIComponent(id)}`, { title: title.trim() });
  };
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
      <IconButton label="Mission Control" onClick={() => navigate('#/')}>
        <ArrowLeft className="size-4" />
      </IconButton>
      <StatusDot status={item.status} />
      {editing ? (
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle} onKeyDown={(e) => e.key === 'Enter' && saveTitle()} className="h-7 min-w-0 flex-1 rounded-md border border-line bg-bg px-2 text-[14px] font-semibold outline-none" />
      ) : (
        <button onDoubleClick={() => setEditing(true)} title="Double-click to rename" className="min-w-0 flex-1 truncate text-left text-[14px] font-semibold">
          {item.title || 'Untitled'}
        </button>
      )}
      {item.worktree && (
        <Badge tone="violet" title={item.worktree.path}>
          <GitBranch className="size-3" />
          {item.worktree.branch}
        </Badge>
      )}
      <Badge tone="neutral" className={MODE_META[item.mode].color}>
        {MODE_META[item.mode].label}
      </Badge>
      <div className="hidden items-center gap-1.5 text-[11.5px] text-muted md:flex" title={`${formatTokens(item.contextTokens)} of ${formatTokens(item.contextWindow)} context tokens`}>
        <ContextRing used={item.contextTokens} total={item.contextWindow} size={18} />
        {item.contextWindow ? `${Math.round((item.contextTokens / item.contextWindow) * 100)}%` : ''}
      </div>
      <span className="hidden text-[11.5px] text-muted md:inline" title="Estimated cost (real token counts, no credits)">
        {formatCost(item.totals.costUsd, item.totals.costPartial)}
      </span>
      <IconButton label="Rewind (checkpoints)" onClick={() => setRewindOpen(true)} disabled={item.turn < 1}>
        <History className="size-4" />
      </IconButton>
      <Menu
        align="right"
        trigger={(_o, toggle) => (
          <IconButton label="More" onClick={toggle}>
            <MoreHorizontal className="size-4" />
          </IconButton>
        )}
      >
        {(close) => (
          <>
            <MenuItem
              icon={<Undo2 className="size-3.5" />}
              onClick={async () => {
                close();
                const r = await post(`/api/agents/${encodeURIComponent(id)}/messages`, { text: '/undo' }).catch((e) => toast.error(e.message));
                if (r?.message) toast.success(r.message);
              }}
            >
              Undo last turn
            </MenuItem>
            <MenuItem
              icon={<Layers className="size-3.5" />}
              onClick={async () => {
                close();
                const r = await post(`/api/agents/${encodeURIComponent(id)}/compact`).catch((e) => toast.error(e.message));
                if (r) toast.success(r.compacted ? 'Conversation compacted' : 'Nothing to compact yet');
              }}
            >
              Compact context
            </MenuItem>
            <MenuItem
              icon={<ScrollText className="size-3.5" />}
              onClick={() => {
                close();
                navigate(`#/log/${encodeURIComponent(id)}`);
              }}
            >
              Event log (audit trail)
            </MenuItem>
            <MenuItem
              icon={<Code2 className="size-3.5" />}
              onClick={() => {
                close();
                navigate('#/editor');
              }}
            >
              Open editor
            </MenuItem>
            <div className="my-1 h-px bg-line" />
            <MenuItem
              danger
              icon={<Trash2 className="size-3.5" />}
              onClick={async () => {
                close();
                if (!confirm('Delete this agent and its session history?')) return;
                await del(`/api/agents/${encodeURIComponent(id)}`);
                navigate('#/');
              }}
            >
              Delete agent
            </MenuItem>
          </>
        )}
      </Menu>
      {running && (
        <Button size="sm" variant="outline" onClick={() => post(`/api/agents/${encodeURIComponent(id)}/abort`)}>
          Stop
        </Button>
      )}
      <IconButton label={panel ? 'Hide panel' : 'Show panel'} onClick={togglePanel} className="hidden lg:inline-flex">
        {panel ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
      </IconButton>
      <RewindModal id={id} open={rewindOpen} onClose={() => setRewindOpen(false)} />
    </div>
  );
}

function RewindModal({ id, open, onClose }: { id: string; open: boolean; onClose: () => void }) {
  const events = useStore((s) => s.agents[id]?.events ?? NO_EVENTS);
  const turns = useMemo(() => events.filter((e): e is Extract<typeof e, { type: 'user_message' }> => e.type === 'user_message'), [events]);
  const [turn, setTurn] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (code: boolean, conversation: boolean) => {
    if (turn === null) return;
    setBusy(true);
    try {
      const r = await post<{ restored: string[] }>(`/api/agents/${encodeURIComponent(id)}/rewind`, { turn, code, conversation });
      toast.success(`Rewound to before turn ${turn}${r.restored.length ? ` · restored ${r.restored.length} file(s)` : ''}`);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Rewind to a checkpoint"
      icon={<History className="size-4 text-brand" />}
      footer={
        <>
          <Button variant="ghost" disabled={turn === null || busy} onClick={() => run(false, true)}>
            Conversation only
          </Button>
          <Button variant="ghost" disabled={turn === null || busy} onClick={() => run(true, false)}>
            Code only
          </Button>
          <Button variant="primary" disabled={turn === null} loading={busy} onClick={() => run(true, true)} icon={<RotateCcw className="size-3.5" />}>
            Rewind code + conversation
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-muted">Every file edit is checkpointed. Pick the message to go back to — files are restored to how they were before it.</p>
      <div className="space-y-1">
        {turns.map((t) => (
          <button key={t.id} onClick={() => setTurn(t.turn)} className={cx('flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-[13px]', turn === t.turn ? 'border-brand/50 bg-brand/5' : 'border-line hover:bg-hover')}>
            <span className="mt-px shrink-0 font-mono text-[11px] text-faint">#{t.turn}</span>
            <span className="line-clamp-2 min-w-0 flex-1">{t.displayText ?? t.content}</span>
          </button>
        ))}
        {!turns.length && <div className="py-6 text-center text-[13px] text-muted">No turns yet.</div>}
      </div>
    </Modal>
  );
}

function TasksPanel({ id }: { id: string }) {
  const item = useStore((s) => s.agents[id]?.item);
  const plans = useStore(useShallow((s) => (s.agents[id]?.events ?? NO_EVENTS).filter((e) => e.type === 'plan')));
  if (!item) return null;
  if (!item.todos.length)
    return (
      <Empty icon={<ListChecks className="size-5" />} title="No task list yet">
        For multi-step work DrakoX keeps a live checklist here.
      </Empty>
    );
  const done = item.todos.filter((t) => t.status === 'completed').length;
  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <Progress value={(done / item.todos.length) * 100} />
        <span className="shrink-0 text-[12px] text-muted">
          {done}/{item.todos.length}
        </span>
      </div>
      <div className="space-y-1">
        {item.todos.map((t, i) => (
          <div key={i} className={cx('flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-[13px]', t.status === 'in_progress' && 'bg-brand/5 ring-1 ring-brand/20')}>
            {t.status === 'completed' ? <Check className="mt-0.5 size-3.5 shrink-0 text-ok" /> : t.status === 'in_progress' ? <CircleDot className="mt-0.5 size-3.5 shrink-0 animate-pulse text-brand" /> : <Circle className="mt-0.5 size-3.5 shrink-0 text-faint" />}
            <span className={cx(t.status === 'completed' && 'text-muted line-through decoration-faint')}>{t.status === 'in_progress' ? t.activeForm ?? t.content : t.content}</span>
          </div>
        ))}
      </div>
      {plans.length > 0 && <div className="mt-4 text-[11.5px] text-faint">{plans.length} plan event(s) — see the conversation.</div>}
    </div>
  );
}

interface Change {
  path: string;
  rel: string;
  turns: number[];
  before: string | null;
  after: string | null;
  modifiedSince: boolean;
}

function ChangesPanel({ id }: { id: string }) {
  const item = useStore((s) => s.agents[id]?.item);
  const fileEvents = useStore((s) => (s.agents[id]?.events ?? NO_EVENTS).filter((e) => e.type === 'file_change' || e.type === 'rewind').length);
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const reload = useCallback(() => {
    get<Change[]>(`/api/agents/${encodeURIComponent(id)}/changes`)
      .then(setChanges)
      .catch(() => setChanges([]));
  }, [id]);
  useEffect(reload, [reload, fileEvents]);
  const revert = async (c: Change) => {
    if (!confirm(`Revert ${c.rel} to its original content?`)) return;
    await post(`/api/agents/${encodeURIComponent(id)}/revert-file`, { path: c.path }).catch((e) => toast.error(e.message));
    toast.success(`Reverted ${c.rel}`);
    reload();
  };
  const applyWt = async () => {
    setWtBusy(true);
    try {
      const r = await post<{ ok: boolean; message: string }>(`/api/agents/${encodeURIComponent(id)}/worktree/apply`);
      r.ok ? toast.success(r.message) : toast.error(r.message);
    } finally {
      setWtBusy(false);
    }
  };
  if (!changes || !item) return <Spinner />;
  return (
    <div className="space-y-2">
      {item.worktree && (
        <div className="rounded-xl border border-violet/30 bg-violet/5 p-3">
          <div className="flex items-center gap-2 text-[12.5px] font-medium text-violet">
            <GitBranch className="size-3.5" /> Isolated worktree
          </div>
          <div className="mt-1 break-all font-mono text-[11px] text-muted">{item.worktree.branch}</div>
          {item.worktreeStats && (
            <div className="mt-1 text-[12px] text-muted">
              {item.worktreeStats.files} files · <span className="text-ok">+{item.worktreeStats.added}</span> <span className="text-bad">−{item.worktreeStats.removed}</span>
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <Button size="xs" variant="primary" loading={wtBusy} onClick={applyWt} icon={<GitMerge className="size-3" />}>
              Apply to my working tree
            </Button>
            <Button
              size="xs"
              onClick={async () => {
                const r = await post<{ ok: boolean; message: string }>(`/api/agents/${encodeURIComponent(id)}/worktree/commit`, { message: `DrakoX: ${item.title}` });
                r.ok ? toast.success(r.message) : toast.error(r.message);
              }}
            >
              Commit on branch
            </Button>
          </div>
        </div>
      )}
      {!changes.length && (
        <Empty icon={<FileDiffIcon className="size-5" />} title="No changes yet">
          Every edit DrakoX makes shows up here as a reviewable diff, with one-click revert.
        </Empty>
      )}
      {changes.map((c) => {
        const st = diffStats(c.before ?? '', c.after ?? '');
        const isOpen = open === c.path;
        return (
          <div key={c.path} className="overflow-hidden rounded-xl border border-line bg-panel">
            <button onClick={() => setOpen(isOpen ? null : c.path)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover/50">
              <span className={cx('w-4 text-center font-mono text-[11px] font-bold', c.before === null ? 'text-ok' : c.after === null ? 'text-bad' : 'text-warn')}>{c.before === null ? 'A' : c.after === null ? 'D' : 'M'}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{c.rel}</span>
              <span className="text-[11px] text-ok">+{st.added}</span>
              <span className="text-[11px] text-bad">−{st.removed}</span>
            </button>
            {isOpen && (
              <div className="space-y-2 border-t border-line p-2">
                {c.modifiedSince && <div className="text-[11px] text-warn">The file was modified after DrakoX's last edit.</div>}
                <FileDiff before={c.before ?? ''} after={c.after ?? ''} className="max-h-96 overflow-auto" />
                <div className="flex gap-2">
                  <Button size="xs" variant="danger" onClick={() => revert(c)} icon={<Undo2 className="size-3" />}>
                    Revert file
                  </Button>
                  <Button size="xs" onClick={() => navigate(`#/editor?file=${encodeURIComponent(c.rel)}`)} icon={<Code2 className="size-3" />}>
                    Open in editor
                  </Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ContextPanel({ id }: { id: string }) {
  const item = useStore((s) => s.agents[id]?.item);
  const mcp = useStore((s) => s.mcp);
  const [ins, setIns] = useState<{ files: { label: string; bytes: number; truncated?: boolean }[]; warnings: string[]; totalBytes: number; budget: number } | null>(null);
  useEffect(() => {
    get('/api/instructions').then(setIns).catch(() => undefined);
  }, []);
  if (!item) return null;
  const t = item.totals;
  return (
    <div className="space-y-4 text-[12.5px]">
      <section>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">Usage</div>
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Context" value={`${formatTokens(item.contextTokens)} / ${formatTokens(item.contextWindow)}`} />
          <Stat label="Cost" value={formatCost(t.costUsd, t.costPartial)} />
          <Stat label="Input tokens" value={formatTokens(t.inputTokens)} />
          <Stat label="Output tokens" value={formatTokens(t.outputTokens)} />
          <Stat label="Cached" value={formatTokens(t.cachedInputTokens)} />
          <Stat label="Requests" value={String(t.requests)} />
        </div>
        <p className="mt-2 text-[11.5px] text-faint">Real token counts — no opaque credits. Local models cost $0.</p>
      </section>
      <section>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">Instructions</div>
        {ins?.files.length ? (
          ins.files.map((f) => (
            <div key={f.label} className="flex items-center gap-2 py-0.5">
              <Check className="size-3 text-ok" />
              <span className="min-w-0 flex-1 truncate">{f.label}</span>
              <span className="text-faint">{(f.bytes / 1024).toFixed(1)} KB</span>
            </div>
          ))
        ) : (
          <div className="text-muted">No AGENTS.md yet — send /init to create one.</div>
        )}
        {ins?.warnings.map((w) => (
          <div key={w} className="mt-1 text-warn">
            {w}
          </div>
        ))}
      </section>
      <section>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">Integrations</div>
        {mcp.length ? (
          mcp.map((s) => (
            <div key={s.name} className="flex items-center gap-2 py-0.5">
              <StatusDot status={s.status} />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="text-faint">{s.status === 'connected' ? `${s.tools.length} tools` : s.status}</span>
            </div>
          ))
        ) : (
          <button onClick={() => navigate('#/integrations')} className="text-brand hover:underline">
            Connect apps →
          </button>
        )}
      </section>
      <section>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">Session</div>
        <div className="break-all font-mono text-[11px] text-muted">{item.id}</div>
        <div className="mt-1 break-all font-mono text-[11px] text-faint">{item.cwd}</div>
        <div className="mt-2 text-[11.5px] text-faint">
          Resume in the terminal: <span className="font-mono text-muted">drakox resume {item.id}</span>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-2.5 py-1.5">
      <div className="text-[10.5px] text-faint">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

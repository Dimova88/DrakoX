import { useMemo, useState } from 'react';
import { Bot, Bug, Check, Copy, FlaskConical, GitBranch, GitMerge, Layers, Microscope, Plus, ScanSearch, Shield, ShieldCheck, Sparkles, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import { useStore, selectInbox, type AgentData } from '../lib/store';
import { del, post } from '../lib/api';
import { navigate } from '../lib/route';
import type { AgentItem, Mode } from '../lib/types';
import { Composer } from '../components/Composer';
import { ApprovalCard } from '../components/Timeline';
import { Badge, Button, Card, Empty, Menu, MenuItem, Progress, StatusDot } from '../components/ui';
import { MODE_META } from '../components/Pickers';
import { classNames as cx, formatCost, modelLabel, timeAgo } from '../lib/format';

const SUGGESTIONS = [
  { icon: <ScanSearch className="size-4" />, title: 'Explain this codebase', prompt: 'Give me a tour of this codebase: architecture, key modules, how data flows, and how to run it.' },
  { icon: <Bug className="size-4" />, title: 'Find & fix a bug', prompt: 'Look for likely bugs in this project (run the tests if there are any), then fix the most important one and verify the fix.' },
  { icon: <FlaskConical className="size-4" />, title: 'Add tests', prompt: 'Find the most important untested code paths and add focused tests for them, then run the test suite.' },
  { icon: <Microscope className="size-4" />, title: 'Reverse-engineer (REA)', prompt: '/reverse-engineer How does this project work end to end? Label findings as seen / inferred / unknown.' },
  { icon: <ShieldCheck className="size-4" />, title: 'Security review', prompt: '/review' },
  { icon: <Sparkles className="size-4" />, title: 'Create AGENTS.md', prompt: '/init' },
];

export function MissionControl() {
  const info = useStore((s) => s.info);
  const agents = useStore((s) => s.agents);
  const inbox = useStore(useShallow(selectInbox));
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem('drakox.mode') as Mode) || 'ask');
  const [model, setModel] = useState<string>(() => localStorage.getItem('drakox.model') || '');
  const [isolation, setIsolation] = useState<'none' | 'worktree'>('none');
  const [bestOf, setBestOf] = useState(1);
  const effectiveModel = model || info?.defaultModel || 'demo/drakox-demo';

  const { groups, singles } = useMemo(() => {
    const list = Object.values(agents)
      .map((a) => a.item)
      .filter((a) => !a.parentId)
      .sort((a, b) => {
        const ra = a.status === 'running' || a.status === 'awaiting_input' ? 1 : 0;
        const rb = b.status === 'running' || b.status === 'awaiting_input' ? 1 : 0;
        return rb - ra || b.updatedAt - a.updatedAt;
      });
    const g = new Map<string, AgentItem[]>();
    const s: AgentItem[] = [];
    for (const a of list) {
      if (a.group) g.set(a.group, [...(g.get(a.group) ?? []), a]);
      else s.push(a);
    }
    return { groups: [...g.entries()], singles: s };
  }, [agents]);

  const launch = async (text: string, images: { type: 'image'; mediaType: string; data: string }[] = []) => {
    localStorage.setItem('drakox.mode', mode);
    if (model) localStorage.setItem('drakox.model', model);
    if (bestOf > 1) {
      if (!info?.git.isRepo) throw new Error('Best-of-N runs each attempt in its own git worktree — this folder is not a git repository.');
      const group = `bo_${Date.now().toString(36)}`;
      await Promise.all(Array.from({ length: bestOf }, (_, i) => post<AgentItem>('/api/agents', { prompt: text, images, mode, model: effectiveModel, isolation: 'worktree', group, title: `${text.slice(0, 50)} · #${i + 1}` })));
      toast.success(`Launched ${bestOf} parallel attempts in isolated worktrees`);
      return;
    }
    const a = await post<AgentItem>('/api/agents', { prompt: text, images, mode, model: effectiveModel, isolation });
    navigate(`#/agent/${encodeURIComponent(a.id)}`);
  };

  const running = singles.filter((a) => a.status === 'running' || a.status === 'awaiting_input').length + groups.flatMap(([, g]) => g).filter((a) => a.status === 'running').length;

  return (
    <div className="h-full overflow-y-auto grid-bg">
      <div className="mx-auto max-w-6xl px-6 pb-16 pt-10">
        <div className="mb-6 text-center">
          <h1 className="text-[28px] font-bold tracking-tight">
            What should <span className="brand-text">DrakoX</span> build?
          </h1>
          <p className="mt-1.5 text-[14px] text-muted">
            {info ? (
              <>
                <span className="font-medium text-fg/90">{info.projectName}</span>
                {info.git.isRepo && (
                  <>
                    {' · '}
                    <GitBranch className="inline size-3.5" /> {info.git.branch}
                    {info.git.changed ? ` · ${info.git.changed} changed` : ''}
                  </>
                )}
                {' · '}
                {running > 0 ? <span className="text-brand">{running} agent{running === 1 ? '' : 's'} working</span> : 'agents run in parallel — launch as many as you like'}
              </>
            ) : (
              'Loading workspace…'
            )}
          </p>
        </div>

        <div className="mx-auto max-w-3xl">
          <Composer
            big
            autoFocus
            onSend={launch}
            mode={mode}
            onModeChange={setMode}
            model={effectiveModel}
            onModelChange={setModel}
            placeholder="Describe a feature, a bug, a refactor, a question… DrakoX plans, codes, runs and verifies."
            extra={
              <>
                <Menu
                  width="w-72"
                  trigger={(_o, toggle) => (
                    <button onClick={toggle} title="Workspace isolation" className={cx('inline-flex h-7 items-center gap-1.5 rounded-lg border px-2 text-[12px] font-medium transition-colors', isolation === 'worktree' || bestOf > 1 ? 'border-violet/40 text-violet' : 'border-line bg-panel text-muted hover:border-line-strong')}>
                      <GitBranch className="size-3.5" />
                      {bestOf > 1 ? `Best of ${bestOf}` : isolation === 'worktree' ? 'Worktree' : 'Local'}
                    </button>
                  )}
                >
                  {(close) => (
                    <div className="p-1">
                      <div className="px-2 pb-1 pt-1 text-[10.5px] font-semibold uppercase tracking-wider text-faint">Where the agent works</div>
                      <MenuItem active={isolation === 'none' && bestOf === 1} onClick={() => (setIsolation('none'), setBestOf(1), close())} icon={<Layers className="size-3.5" />} hint="default">
                        Your working tree
                      </MenuItem>
                      <MenuItem active={isolation === 'worktree' && bestOf === 1} onClick={() => (setIsolation('worktree'), setBestOf(1), close())} icon={<GitBranch className="size-3.5" />} hint="git">
                        Isolated worktree
                      </MenuItem>
                      <div className="px-2 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-faint">Best-of-N (parallel attempts)</div>
                      {[2, 3, 4].map((n) => (
                        <MenuItem key={n} active={bestOf === n} onClick={() => (setBestOf(n), setIsolation('worktree'), close())} icon={<Users className="size-3.5" />}>
                          {n} attempts, pick the best
                        </MenuItem>
                      ))}
                    </div>
                  )}
                </Menu>
              </>
            }
          />
        </div>

        {inbox.length > 0 && (
          <section className="mx-auto mt-10 max-w-3xl">
            <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-warn">
              <Shield className="size-3.5" /> Needs your approval · {inbox.length}
            </div>
            <div className="space-y-3">
              {inbox.map((req) => (
                <div key={req.id}>
                  <button onClick={() => navigate(`#/agent/${encodeURIComponent(req.agentId)}`)} className="mb-1 text-[12px] text-muted hover:text-fg">
                    {agents[req.agentId]?.item.title ?? req.agentId} →
                  </button>
                  <ApprovalCard compact agentId={req.agentId} req={req} sub={req.subagent} pending />
                </div>
              ))}
            </div>
          </section>
        )}

        {groups.map(([gid, list]) => (
          <section key={gid} className="mt-10">
            <div className="mb-3 flex items-center gap-2">
              <Users className="size-4 text-violet" />
              <span className="text-[13px] font-semibold">Best-of-{list.length}</span>
              <span className="truncate text-[13px] text-muted">{list[0]?.title.replace(/ · #\d+$/, '')}</span>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {list.map((a) => (
                <AgentCard key={a.id} a={a} data={agents[a.id]} showApply />
              ))}
            </div>
          </section>
        ))}

        <section className="mt-10">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-[13px] font-semibold">
              <Bot className="size-4 text-brand" /> Agents
              <span className="font-normal text-faint">{singles.length}</span>
            </div>
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={async () => navigate(`#/agent/${encodeURIComponent((await post<AgentItem>('/api/agents', { mode, model: effectiveModel })).id)}`)}>
              Empty agent
            </Button>
          </div>
          {singles.length === 0 && groups.length === 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {SUGGESTIONS.map((s) => (
                <Card key={s.title} onClick={() => launch(s.prompt).catch((e) => toast.error(e.message))} className="group p-4">
                  <div className="mb-2 flex size-8 items-center justify-center rounded-lg border border-line bg-elev text-brand transition-colors group-hover:border-brand/40">{s.icon}</div>
                  <div className="text-[13.5px] font-semibold">{s.title}</div>
                  <div className="mt-0.5 line-clamp-2 text-[12px] text-muted">{s.prompt}</div>
                </Card>
              ))}
            </div>
          ) : singles.length === 0 ? (
            <Empty title="No other agents" />
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {singles.map((a) => (
                <AgentCard key={a.id} a={a} data={agents[a.id]} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function AgentCard({ a, data, showApply }: { a: AgentItem; data?: AgentData; showApply?: boolean }) {
  const running = a.status === 'running';
  const waiting = a.status === 'awaiting_input' || Object.keys(data?.approvals ?? {}).length > 0;
  const done = a.todos.filter((t) => t.status === 'completed').length;
  const current = a.todos.find((t) => t.status === 'in_progress');
  const lastTool = useMemo(() => {
    const evs = data?.events ?? [];
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i]!;
      if (e.type === 'tool_start') return e.title;
      if (e.type === 'turn_end') return undefined;
    }
    return undefined;
  }, [data?.events]);
  const streaming = Object.values(data?.streams ?? {}).map((s) => s.text).join('').trim().split('\n').pop();
  const activity = running ? streaming || current?.activeForm || lastTool || 'Working…' : waiting ? 'Waiting for your input' : a.lastMessage?.replace(/[#*`>]/g, '').trim();
  return (
    <Card onClick={() => navigate(`#/agent/${encodeURIComponent(a.id)}`)} className={cx('group relative flex flex-col p-4', running && 'border-brand/30', waiting && 'border-warn/40')}>
      <div className="flex items-start gap-2.5">
        <StatusDot status={waiting ? 'awaiting_input' : a.status} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">{a.title || 'Untitled'}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted">
            <span className="truncate">{modelLabel(a.model)}</span>
            <span className={MODE_META[a.mode]?.color}>· {MODE_META[a.mode]?.label}</span>
            {a.worktree && (
              <Badge tone="violet" className="!py-0">
                <GitBranch className="size-2.5" /> worktree
              </Badge>
            )}
          </div>
        </div>
        <Menu
          align="right"
          width="w-44"
          trigger={(_o, toggle) => (
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggle();
              }}
              className="invisible rounded-md p-1 text-faint hover:bg-hover hover:text-fg group-hover:visible"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        >
          {(close) => (
            <div onClick={(e) => e.stopPropagation()}>
              <MenuItem
                danger
                icon={<Trash2 className="size-3.5" />}
                onClick={async () => {
                  close();
                  await del(`/api/agents/${encodeURIComponent(a.id)}`);
                  toast.success('Agent deleted');
                }}
              >
                Delete agent
              </MenuItem>
              <MenuItem
                icon={<Copy className="size-3.5" />}
                onClick={() => {
                  close();
                  void navigator.clipboard.writeText(`drakox resume ${a.id}`);
                  toast.success('Copied resume command');
                }}
              >
                Copy resume command
              </MenuItem>
            </div>
          )}
        </Menu>
      </div>
      <div className={cx('mt-3 line-clamp-2 min-h-[2.6em] text-[12.5px]', running ? 'text-fg/80' : waiting ? 'text-warn' : 'text-muted')}>{activity || <span className="text-faint">No activity yet</span>}</div>
      {a.todos.length > 0 && (
        <div className="mt-3 flex items-center gap-2">
          <Progress value={(done / a.todos.length) * 100} />
          <span className="shrink-0 text-[11px] text-faint">
            {done}/{a.todos.length}
          </span>
        </div>
      )}
      <div className="mt-3 flex items-center gap-3 border-t border-line pt-2.5 text-[11px] text-faint">
        <span>{timeAgo(a.updatedAt)}</span>
        {a.turn > 0 && <span>{a.turn} turns</span>}
        {(a.worktreeStats?.files ?? a.filesChanged.length) > 0 && (
          <span>
            {a.worktreeStats ? (
              <>
                {a.worktreeStats.files} files <span className="text-ok">+{a.worktreeStats.added}</span> <span className="text-bad">−{a.worktreeStats.removed}</span>
              </>
            ) : (
              `${a.filesChanged.length} files`
            )}
          </span>
        )}
        <span className="ml-auto">{formatCost(a.totals.costUsd, a.totals.costPartial)}</span>
      </div>
      {showApply && a.status === 'idle' && a.worktree && (
        <Button
          size="xs"
          variant="ok"
          className="mt-2.5"
          icon={<GitMerge className="size-3" />}
          onClick={async (e) => {
            e.stopPropagation();
            const r = await post<{ ok: boolean; message: string }>(`/api/agents/${encodeURIComponent(a.id)}/worktree/apply`);
            r.ok ? toast.success(r.message) : toast.error(r.message);
          }}
        >
          <Check className="size-3" /> Pick this one
        </Button>
      )}
    </Card>
  );
}

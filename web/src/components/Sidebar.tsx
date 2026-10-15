import { useMemo } from 'react';
import { Code2, Command, Moon, Plus, Puzzle, Rocket, Settings, Sun, Wand2, Wifi, WifiOff } from 'lucide-react';
import { toast } from 'sonner';
import { useStore } from '../lib/store';
import { navigate, type Route } from '../lib/route';
import { post } from '../lib/api';
import type { AgentItem } from '../lib/types';
import { LogoMark, Wordmark } from './Logo';
import { Kbd, StatusDot } from './ui';
import { classNames as cx, timeAgo } from '../lib/format';

export function Sidebar({ route }: { route: Route }) {
  const agents = useStore((s) => s.agents);
  const connected = useStore((s) => s.connected);
  const info = useStore((s) => s.info);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const mcp = useStore((s) => s.mcp);
  const list = useMemo(
    () =>
      Object.values(agents)
        .map((a) => ({ ...a.item, pending: Object.keys(a.approvals).length + Object.keys(a.questions).length + Object.keys(a.plans).length }))
        .filter((a) => !a.parentId)
        .sort((a, b) => {
          const ra = a.status === 'running' || a.status === 'awaiting_input' || a.pending ? 1 : 0;
          const rb = b.status === 'running' || b.status === 'awaiting_input' || b.pending ? 1 : 0;
          return rb - ra || b.updatedAt - a.updatedAt;
        })
        .slice(0, 40),
    [agents],
  );
  const nav = [
    { to: '#/', icon: <Rocket className="size-4" />, label: 'Mission Control', active: route.name === 'mission' },
    { to: '#/editor', icon: <Code2 className="size-4" />, label: 'Editor', active: route.name === 'editor' },
    { to: '#/integrations', icon: <Puzzle className="size-4" />, label: 'Integrations', active: route.name === 'integrations', badge: mcp.filter((m) => m.status === 'connected').length || undefined },
    { to: '#/skills', icon: <Wand2 className="size-4" />, label: 'Skills & agents', active: route.name === 'skills' },
    { to: '#/settings', icon: <Settings className="size-4" />, label: 'Settings', active: route.name === 'settings' },
  ];
  const newAgent = async () => {
    try {
      const a = await post<AgentItem>('/api/agents', { model: localStorage.getItem('drakox.model') || undefined, mode: localStorage.getItem('drakox.mode') || undefined });
      navigate(`#/agent/${encodeURIComponent(a.id)}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel/60">
      <div className="flex h-12 items-center gap-2 px-3.5">
        <LogoMark size={24} />
        <Wordmark />
        <span className="ml-auto rounded-md border border-line px-1.5 text-[10px] text-faint">v{info?.version ?? '…'}</span>
      </div>
      <div className="px-2.5 pb-2">
        <button onClick={newAgent} className="flex h-9 w-full items-center gap-2 rounded-xl brand-gradient px-3 text-[13px] font-semibold text-white shadow-[0_6px_20px_-8px_rgba(255,90,54,.8)] transition-all hover:brightness-110 active:scale-[.98]">
          <Plus className="size-4" /> New agent
        </button>
      </div>
      <nav className="space-y-0.5 px-2">
        {nav.map((n) => (
          <button key={n.to} onClick={() => navigate(n.to)} className={cx('flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors', n.active ? 'bg-hover font-medium text-fg' : 'text-muted hover:bg-hover/60 hover:text-fg')}>
            {n.icon}
            <span className="flex-1 text-left">{n.label}</span>
            {n.badge ? <span className="rounded-full bg-ok/15 px-1.5 text-[10px] font-medium text-ok">{n.badge}</span> : null}
          </button>
        ))}
      </nav>
      <div className="mt-4 flex items-center justify-between px-4 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-faint">
        <span>Agents</span>
        <span>{list.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {list.map((a) => {
          const active = route.name === 'agent' && route.id === a.id;
          return (
            <button key={a.id} onClick={() => navigate(`#/agent/${encodeURIComponent(a.id)}`)} className={cx('group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors', active ? 'bg-hover' : 'hover:bg-hover/60')}>
              <StatusDot status={a.pending ? 'awaiting_input' : a.status} />
              <span className={cx('min-w-0 flex-1 truncate text-[12.5px]', active ? 'text-fg' : 'text-fg/80')}>{a.title || 'Untitled'}</span>
              {a.pending ? <span className="rounded-full bg-warn/15 px-1.5 text-[10px] font-semibold text-warn">{a.pending}</span> : <span className="hidden shrink-0 text-[10px] text-faint group-hover:inline">{timeAgo(a.updatedAt)}</span>}
            </button>
          );
        })}
        {!list.length && <div className="px-2.5 py-2 text-[12px] text-faint">No agents yet.</div>}
      </div>
      <div className="flex items-center gap-1 border-t border-line px-2.5 py-2">
        <span title={connected ? 'Live connection' : 'Reconnecting…'} className={cx('inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px]', connected ? 'text-ok' : 'text-warn')}>
          {connected ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5 animate-pulse" />}
          {connected ? 'live' : 'offline'}
        </span>
        <div className="flex-1" />
        <button onClick={() => useStore.getState().setPalette(true)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-faint hover:bg-hover hover:text-fg" title="Command palette">
          <Command className="size-3.5" />
          <Kbd>K</Kbd>
        </button>
        <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} className="rounded-md p-1.5 text-faint hover:bg-hover hover:text-fg" title="Toggle theme">
          {theme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
        </button>
      </div>
    </aside>
  );
}

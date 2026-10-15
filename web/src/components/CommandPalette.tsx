import { useEffect, useState } from 'react';
import { Command } from 'cmdk';
import { Bot, Code2, FileText, GitBranch, Moon, Plus, Puzzle, Rocket, Settings, Slash, Sparkles, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { useStore } from '../lib/store';
import { get, post } from '../lib/api';
import { navigate, useRoute } from '../lib/route';
import type { AgentItem } from '../lib/types';
import { StatusDot } from './ui';

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPalette);
  const agents = useStore((s) => s.agents);
  const commands = useStore((s) => s.commands);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const route = useRoute();
  const [q, setQ] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    if (!open) setQ('');
  }, [open]);
  useEffect(() => {
    if (!open || q.length < 2) {
      setFiles([]);
      return;
    }
    const t = setTimeout(() => get<string[]>(`/api/files/search?q=${encodeURIComponent(q)}&limit=8`).then(setFiles).catch(() => undefined), 120);
    return () => clearTimeout(t);
  }, [q, open]);
  if (!open) return null;
  const run = (fn: () => unknown) => {
    setOpen(false);
    Promise.resolve(fn()).catch((e) => toast.error((e as Error).message));
  };
  const newAgent = async (isolation: 'none' | 'worktree' = 'none') => {
    const a = await post<AgentItem>('/api/agents', { isolation, model: localStorage.getItem('drakox.model') || undefined });
    navigate(`#/agent/${encodeURIComponent(a.id)}`);
  };
  const sendCommand = async (name: string) => {
    if (route.name === 'agent') {
      const r = await post<{ message?: string }>(`/api/agents/${encodeURIComponent(route.id)}/messages`, { text: `/${name}` });
      if (r.message) toast.success(r.message);
    } else {
      const a = await post<AgentItem>('/api/agents', { prompt: `/${name}` });
      navigate(`#/agent/${encodeURIComponent(a.id)}`);
    }
  };
  const item = 'flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-fg/90 aria-selected:bg-hover aria-selected:text-fg';
  const group = '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-faint';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[14vh] backdrop-blur-sm fade-in" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <Command className="w-full max-w-xl overflow-hidden rounded-2xl border border-line-strong bg-panel shadow-2xl" loop>
        <Command.Input autoFocus value={q} onValueChange={setQ} placeholder="Search commands, agents, files…" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)} className="h-12 w-full border-b border-line bg-transparent px-4 text-[14px] outline-none placeholder:text-faint" />
        <Command.List className="max-h-[55vh] overflow-y-auto p-1.5">
          <Command.Empty className="px-4 py-8 text-center text-[13px] text-muted">No results.</Command.Empty>
          <Command.Group heading="Actions" className={group}>
            <Command.Item className={item} onSelect={() => run(() => newAgent())}>
              <Plus className="size-4 text-brand" /> New agent
            </Command.Item>
            <Command.Item className={item} onSelect={() => run(() => newAgent('worktree'))}>
              <GitBranch className="size-4 text-violet" /> New agent in an isolated worktree
            </Command.Item>
            <Command.Item className={item} onSelect={() => run(() => navigate('#/settings/models'))}>
              <Sparkles className="size-4 text-ok" /> Connect a model
            </Command.Item>
            <Command.Item className={item} onSelect={() => run(() => navigate('#/integrations/catalog'))}>
              <Puzzle className="size-4 text-info" /> Add an integration
            </Command.Item>
            <Command.Item className={item} onSelect={() => run(() => setTheme(theme === 'dark' ? 'light' : 'dark'))}>
              <Moon className="size-4" /> Toggle theme
            </Command.Item>
          </Command.Group>
          <Command.Group heading="Go to" className={group}>
            <Command.Item className={item} onSelect={() => run(() => navigate('#/'))}>
              <Rocket className="size-4" /> Mission Control
            </Command.Item>
            <Command.Item className={item} onSelect={() => run(() => navigate('#/editor'))}>
              <Code2 className="size-4" /> Editor
            </Command.Item>
            <Command.Item className={item} onSelect={() => run(() => navigate('#/integrations'))}>
              <Puzzle className="size-4" /> Integrations
            </Command.Item>
            <Command.Item className={item} onSelect={() => run(() => navigate('#/skills'))}>
              <Wand2 className="size-4" /> Skills & agents
            </Command.Item>
            <Command.Item className={item} onSelect={() => run(() => navigate('#/settings'))}>
              <Settings className="size-4" /> Settings
            </Command.Item>
          </Command.Group>
          {Object.values(agents).length > 0 && (
            <Command.Group heading="Agents" className={group}>
              {Object.values(agents)
                .sort((a, b) => b.item.updatedAt - a.item.updatedAt)
                .slice(0, 12)
                .map((a) => (
                  <Command.Item key={a.item.id} value={`agent ${a.item.title} ${a.item.id}`} className={item} onSelect={() => run(() => navigate(`#/agent/${encodeURIComponent(a.item.id)}`))}>
                    <StatusDot status={a.item.status} />
                    <Bot className="size-4 text-muted" />
                    <span className="truncate">{a.item.title || 'Untitled'}</span>
                  </Command.Item>
                ))}
            </Command.Group>
          )}
          <Command.Group heading={route.name === 'agent' ? 'Slash commands (this agent)' : 'Slash commands (new agent)'} className={group}>
            {commands
              .filter((c) => c.kind === 'prompt' || ['compact', 'undo'].includes(c.name))
              .slice(0, 30)
              .map((c) => (
                <Command.Item key={c.name} value={`/${c.name} ${c.description}`} className={item} onSelect={() => run(() => sendCommand(c.name))}>
                  <Slash className="size-4 text-brand" />
                  <span className="font-mono">/{c.name}</span>
                  <span className="truncate text-[12px] text-faint">{c.description}</span>
                </Command.Item>
              ))}
          </Command.Group>
          {files.length > 0 && (
            <Command.Group heading="Files" className={group}>
              {files.map((f) => (
                <Command.Item key={f} value={`file ${f}`} className={item} onSelect={() => run(() => navigate(`#/editor?file=${encodeURIComponent(f)}`))}>
                  <FileText className="size-4 text-muted" />
                  <span className="truncate font-mono text-[12.5px]">{f}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
        </Command.List>
      </Command>
    </div>
  );
}

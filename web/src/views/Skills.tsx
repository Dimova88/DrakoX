import { useEffect, useState } from 'react';
import { Bot, BookOpen, Play, Plus, Slash } from 'lucide-react';
import { toast } from 'sonner';
import { get, post, put } from '../lib/api';
import { navigate } from '../lib/route';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../lib/store';
import type { AgentItem, AgentProfile, Skill } from '../lib/types';
import { Badge, Button, Card, Empty, Input, Modal, SectionTitle, Segmented, Spinner, Textarea } from '../components/ui';

export function Skills() {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const commands = useStore(useShallow((s) => s.commands.filter((c) => c.source === 'command')));
  const [open, setOpen] = useState<Skill | null>(null);
  const [creating, setCreating] = useState(false);
  const load = () => {
    get<Skill[]>('/api/skills').then(setSkills).catch((e) => toast.error(e.message));
    get<AgentProfile[]>('/api/agent-profiles').then(setProfiles).catch(() => undefined);
  };
  useEffect(load, []);
  const run = async (prompt: string) => {
    const a = await post<AgentItem>('/api/agents', { prompt });
    navigate(`#/agent/${encodeURIComponent(a.id)}`);
  };
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 pb-16 pt-8">
        <div className="mb-1 flex items-center justify-between">
          <h1 className="text-[22px] font-bold tracking-tight">Skills & agents</h1>
          <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>
            New skill
          </Button>
        </div>
        <p className="mb-6 max-w-3xl text-[13.5px] text-muted">
          Skills are folders with a <span className="font-mono text-[12px]">SKILL.md</span> — instructions DrakoX loads on demand (compatible with Claude Code / Codex skills). Put them in <span className="font-mono text-[12px]">.drakox/skills/</span> (project) or <span className="font-mono text-[12px]">~/.drakox/skills/</span> (you). Invoke one with <span className="font-mono text-[12px]">/name</span> or let the agent pick it.
        </p>
        <SectionTitle>Skills</SectionTitle>
        {!skills ? (
          <Spinner />
        ) : !skills.length ? (
          <Empty icon={<BookOpen className="size-5" />} title="No skills yet" />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {skills.map((s) => (
              <Card key={s.file} className="flex flex-col p-4" onClick={() => setOpen(s)}>
                <div className="flex items-center gap-2">
                  <BookOpen className="size-4 text-brand" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold">/{s.name}</span>
                  <Badge tone={s.source === 'bundled' ? 'brand' : s.source === 'project' ? 'info' : 'neutral'}>{s.source}</Badge>
                </div>
                <div className="mt-2 line-clamp-3 flex-1 text-[12.5px] text-muted">{s.description}</div>
                <div className="mt-3">
                  <Button
                    size="xs"
                    icon={<Play className="size-3" />}
                    onClick={(e) => {
                      e.stopPropagation();
                      void run(`/${s.name}`);
                    }}
                  >
                    Run
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
        <div className="mt-10">
          <SectionTitle>Sub-agents</SectionTitle>
          <p className="mb-3 text-[12.5px] text-muted">DrakoX delegates to these with the task tool (each gets a fresh context, optionally its own git worktree). Add your own as markdown files in .drakox/agents/.</p>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {profiles.map((p) => (
              <Card key={p.name} className="p-4">
                <div className="flex items-center gap-2">
                  <Bot className="size-4 text-violet" />
                  <span className="flex-1 text-[13.5px] font-semibold">{p.name}</span>
                  <Badge>{p.source}</Badge>
                </div>
                <div className="mt-1.5 line-clamp-3 text-[12.5px] text-muted">{p.description}</div>
                {p.tools && <div className="mt-2 truncate font-mono text-[10.5px] text-faint">tools: {p.tools.join(', ')}</div>}
              </Card>
            ))}
          </div>
        </div>
        {commands.length > 0 && (
          <div className="mt-10">
            <SectionTitle>Custom commands</SectionTitle>
            <div className="grid gap-2 md:grid-cols-2">
              {commands.map((c) => (
                <div key={c.name} className="flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-[13px]">
                  <Slash className="size-3.5 text-brand" />
                  <span className="font-mono">{c.name}</span>
                  <span className="truncate text-muted">{c.description}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {open && <SkillModal skill={open} onClose={() => setOpen(null)} />}
      {creating && <CreateSkill onClose={() => setCreating(false)} onDone={load} />}
    </div>
  );
}

function SkillModal({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get<{ content: string }>(`/api/skills/${encodeURIComponent(skill.name)}`).then((r) => setContent(r.content));
  }, [skill.name]);
  const readOnly = skill.source === 'bundled';
  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-3xl"
      title={<span className="font-mono">/{skill.name}</span>}
      footer={
        readOnly ? (
          <span className="text-[12px] text-muted">Bundled skill — copy it into .drakox/skills/ to customise.</span>
        ) : (
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await put(`/api/skills/${encodeURIComponent(skill.name)}`, { content });
                toast.success('Skill saved');
                onClose();
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        )
      }
    >
      <div className="mb-2 font-mono text-[11px] text-faint">{skill.file}</div>
      {content === null ? <Spinner /> : <Textarea rows={22} readOnly={readOnly} value={content} onChange={(e) => setContent(e.target.value)} className="font-mono text-[12px]" />}
    </Modal>
  );
}

function CreateSkill({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [scope, setScope] = useState<'project' | 'user'>('project');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title="New skill"
      width="max-w-2xl"
      footer={
        <Button
          variant="primary"
          loading={busy}
          disabled={!name || !description}
          onClick={async () => {
            setBusy(true);
            try {
              await post('/api/skills', { name, description, body, scope });
              toast.success(`Created /${name}`);
              onDone();
              onClose();
            } catch (e) {
              toast.error((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Create skill
        </Button>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-[12.5px] font-medium">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="release-notes" className="font-mono" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12.5px] font-medium">When should DrakoX use it?</span>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Write release notes from the git log when the user asks for a changelog" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12.5px] font-medium">Instructions (markdown)</span>
          <Textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} className="font-mono text-[12px]" placeholder={'# Release notes\n\n1. Run `git log --oneline <last-tag>..HEAD`\n2. Group by feat / fix / chore\n3. …'} />
        </label>
        <Segmented
          value={scope}
          onChange={setScope}
          options={[
            { value: 'project', label: 'This project (.drakox/skills)' },
            { value: 'user', label: 'All projects (~/.drakox/skills)' },
          ]}
        />
      </div>
    </Modal>
  );
}

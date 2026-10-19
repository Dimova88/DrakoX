import { useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, Cloud, Cpu, ExternalLink, Gift, HardDrive, Heart, KeyRound, Lock, Monitor, Moon, Plus, Search, Shield, Sun, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { del, get, post, put } from '../lib/api';
import { useStore } from '../lib/store';
import { navigate } from '../lib/route';
import type { Mode, ProviderStatus } from '../lib/types';
import { Badge, Button, Card, Input, Kbd, Segmented, Select, Spinner, StatusDot, Tabs, Toggle } from '../components/ui';
import { ModelPicker, MODE_META, MODES } from '../components/Pickers';
import { LogoMark } from '../components/Logo';
import { classNames as cx } from '../lib/format';

type Tab = 'models' | 'permissions' | 'general' | 'about';

export function Settings({ tab: initial }: { tab?: string }) {
  const [tab, setTab] = useState<Tab>((initial as Tab) || 'models');
  useEffect(() => {
    if (initial) setTab(initial as Tab);
  }, [initial]);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 pb-16 pt-8">
        <h1 className="mb-4 text-[22px] font-bold tracking-tight">Settings</h1>
        <Tabs
          value={tab}
          onChange={(t) => {
            setTab(t);
            navigate(`#/settings/${t}`);
          }}
          tabs={[
            { value: 'models', label: 'Models' },
            { value: 'permissions', label: 'Permissions & safety' },
            { value: 'general', label: 'General' },
            { value: 'about', label: 'About' },
          ]}
        />
        <div className="pt-6">
          {tab === 'models' && <Models />}
          {tab === 'permissions' && <Permissions />}
          {tab === 'general' && <General />}
          {tab === 'about' && <About />}
        </div>
      </div>
    </div>
  );
}

function Row({ title, desc, children }: { title: ReactNode; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-b border-line py-4 last:border-0 md:flex-row md:items-center">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium">{title}</div>
        {desc && <div className="mt-0.5 text-[12.5px] text-muted">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

const CATEGORY: Record<string, { label: string; icon: ReactNode; desc: string }> = {
  local: { label: 'Local — free, unlimited, private', icon: <HardDrive className="size-4 text-ok" />, desc: 'Runs on your machine. No account, no rate limits, your code never leaves.' },
  free: { label: 'Free cloud tiers', icon: <Gift className="size-4 text-brand" />, desc: 'Generous free quotas from the providers themselves. Bring a free key.' },
  paid: { label: 'Frontier models (bring your own key)', icon: <Cloud className="size-4 text-info" />, desc: 'Pay the provider directly at cost — DrakoX adds no markup and no credits.' },
  custom: { label: 'Custom endpoints', icon: <Cpu className="size-4 text-violet" />, desc: 'Any OpenAI-compatible API.' },
  demo: { label: 'Demo', icon: <Gift className="size-4 text-warn" />, desc: 'Offline scripted model for trying the UI.' },
};

function Models() {
  const providers = useStore((s) => s.providers);
  const refresh = useStore((s) => s.refreshProviders);
  const info = useStore((s) => s.info);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    setLoading(true);
    refresh(true).finally(() => setLoading(false));
  }, [refresh]);
  const order = ['local', 'free', 'paid', 'custom', 'demo'];
  const groups = order.map((c) => [c, providers.filter((p) => p.category === c)] as const).filter(([, l]) => l.length);
  return (
    <div className="space-y-8">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-medium">Default model</div>
            <div className="text-[12.5px] text-muted">{info?.defaultModelReason}</div>
          </div>
          <ModelPicker
            align="right"
            value={info?.defaultModel ?? ''}
            onChange={async (m) => {
              await put('/api/default-model', { model: m });
              toast.success(`Default model: ${m}`);
            }}
          />
        </div>
      </Card>
      {loading && !providers.length && <Spinner />}
      {groups.map(([cat, list]) => (
        <section key={cat}>
          <div className="mb-1 flex items-center gap-2 text-[14px] font-semibold">
            {CATEGORY[cat]?.icon} {CATEGORY[cat]?.label ?? cat}
          </div>
          <div className="mb-3 text-[12.5px] text-muted">{CATEGORY[cat]?.desc}</div>
          <div className="grid gap-3 md:grid-cols-2">
            {list.map((p) => (
              <ProviderCard key={p.id} p={p} />
            ))}
          </div>
        </section>
      ))}
      <div>
        {adding ? <AddProvider onDone={() => setAdding(false)} /> : <Button icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>Add an OpenAI-compatible provider</Button>}
      </div>
    </div>
  );
}

function ProviderCard({ p }: { p: ProviderStatus }) {
  const [key, setKey] = useState('');
  const [baseURL, setBaseURL] = useState(p.baseURL ?? '');
  const [busy, setBusy] = useState(false);
  const local = p.category === 'local';
  const ok = p.configured && p.reachable !== false && (local ? p.reachable : true);
  const save = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await put(`/api/providers/${encodeURIComponent(p.id)}`, body);
      setKey('');
      const t = await post<{ ok: boolean; models?: number; error?: string; kind?: string }>(`/api/providers/${encodeURIComponent(p.id)}/test`);
      if (t.ok) toast.success(`${p.name}: connected · ${t.models} models`);
      else if (t.kind === 'network') toast.warning(`${p.name}: saved, but DrakoX can't connect right now. ${t.error ?? ''}`, { duration: 15000 });
      else toast.error(`${p.name}: ${t.error}`, { duration: 15000 });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-4">
      <div className="flex items-start gap-2.5">
        <StatusDot status={ok ? 'connected' : p.configured && p.reachable === false ? 'error' : 'idle'} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold">{p.name}</span>
            {ok && <Badge tone="ok">{p.models.length} models</Badge>}
            {p.keySource && p.keySource !== 'none' && <Badge>key: {p.keySource}</Badge>}
          </div>
          <div className="mt-0.5 text-[12px] text-muted">{p.description}</div>
          {local && p.reachable === false && <div className="mt-1 text-[11.5px] text-faint">Not running at {p.baseURL}</div>}
          {p.error && !local && (
            <div title={p.error} className="mt-1 line-clamp-3 text-[11.5px] text-bad">
              {p.error}
            </div>
          )}
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {p.needsKey && (
          <div className="flex gap-2">
            <div className="relative flex-1">
              <KeyRound className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
              <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={p.keySource && p.keySource !== 'none' ? 'Key saved — paste to replace' : 'Paste API key'} className="pl-8" autoComplete="off" />
            </div>
            <Button variant="primary" disabled={!key.trim()} loading={busy} onClick={() => save({ apiKey: key.trim() })}>
              Save
            </Button>
          </div>
        )}
        {(local || p.category === 'custom') && (
          <div className="flex gap-2">
            <Input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="Base URL" className="font-mono text-[12px]" />
            <Button disabled={baseURL === (p.baseURL ?? '')} loading={busy} onClick={() => save({ baseURL })}>
              Save
            </Button>
          </div>
        )}
        <div className="flex items-center gap-3 text-[11.5px]">
          {p.signupUrl && (
            <a href={p.signupUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
              {local ? 'Download' : 'Get a key'} <ExternalLink className="size-3" />
            </a>
          )}
          {p.recommended && <span className="text-faint">Suggested: <span className="font-mono">{p.recommended}</span></span>}
          {p.keySource === 'credentials' && (
            <button
              onClick={async () => {
                await put(`/api/providers/${encodeURIComponent(p.id)}`, { apiKey: '' });
                toast.success('Key removed');
              }}
              className="ml-auto text-faint hover:text-bad"
            >
              Remove key
            </button>
          )}
          {p.category === 'custom' && (
            <button
              onClick={async () => {
                if (!confirm(`Remove provider ${p.name}?`)) return;
                await del(`/api/providers/${encodeURIComponent(p.id)}`);
              }}
              className="ml-auto inline-flex items-center gap-1 text-faint hover:text-bad"
            >
              <Trash2 className="size-3" /> Remove
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}

function AddProvider({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ id: '', name: '', baseURL: '', apiKey: '', models: '' });
  const [busy, setBusy] = useState(false);
  return (
    <Card className="max-w-2xl space-y-3 p-4">
      <div className="text-[14px] font-semibold">Custom provider</div>
      <div className="grid grid-cols-2 gap-3">
        <Input placeholder="id (e.g. mycorp)" value={f.id} onChange={(e) => setF({ ...f, id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })} />
        <Input placeholder="Display name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </div>
      <Input placeholder="Base URL, e.g. https://api.example.com/v1" value={f.baseURL} onChange={(e) => setF({ ...f, baseURL: e.target.value })} className="font-mono text-[12px]" />
      <Input type="password" placeholder="API key (optional)" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} />
      <Input placeholder="Model ids, comma-separated (optional — discovered via /models)" value={f.models} onChange={(e) => setF({ ...f, models: e.target.value })} />
      <div className="flex gap-2">
        <Button
          variant="primary"
          loading={busy}
          disabled={!f.id || !f.baseURL}
          onClick={async () => {
            setBusy(true);
            try {
              await put(`/api/providers/${encodeURIComponent(f.id)}`, { type: 'openai', name: f.name || f.id, baseURL: f.baseURL, ...(f.apiKey ? { apiKey: f.apiKey } : {}), ...(f.models ? { models: f.models.split(',').map((m) => m.trim()).filter(Boolean) } : {}) });
              toast.success('Provider added');
              onDone();
            } catch (e) {
              toast.error((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Add provider
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function Permissions() {
  const info = useStore((s) => s.info);
  const [cfg, setCfg] = useState<any>(null);
  const load = () => get('/api/config').then(setCfg);
  useEffect(() => {
    void load();
  }, []);
  const patchCfg = async (patch: Record<string, unknown>, scope = 'user') => {
    try {
      await put('/api/config', { scope, patch });
      await load();
      toast.success('Saved');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  if (!cfg) return <Spinner />;
  const eff = cfg.effective;
  const user = cfg.scopes.user;
  return (
    <div>
      <Card className="px-5">
        <Row title="Default mode" desc="How much DrakoX may do without asking. Switch any time with Shift+Tab.">
          <Segmented value={(eff.mode ?? 'ask') as Mode} onChange={(m) => patchCfg({ mode: m })} options={MODES.map((m) => ({ value: m, label: MODE_META[m].label, tone: MODE_META[m].color }))} />
        </Row>
        <Row
          title="Sandbox"
          desc={
            <>
              Where commands may write — a separate dial from approvals.{' '}
              {info?.sandbox.available ? <span className="text-ok">OS sandbox active ({info.sandbox.kind}).</span> : <span className="text-warn">No OS sandbox found on this machine — risky commands always ask (fail-closed).</span>}
            </>
          }
        >
          <Segmented
            value={eff.sandbox ?? 'workspace-write'}
            onChange={(v) => patchCfg({ sandbox: v })}
            options={[
              { value: 'read-only', label: 'Read-only' },
              { value: 'workspace-write', label: 'Workspace' },
              { value: 'full-access', label: 'Full access', tone: 'text-bad' },
            ]}
          />
        </Row>
        <Row title="Network inside the sandbox" desc="Allow sandboxed commands to reach the internet (package installs etc.).">
          <Toggle checked={Boolean(eff.permissions?.sandboxNetwork)} onChange={(v) => patchCfg({ permissions: { sandboxNetwork: v } })} />
        </Row>
        <Row title="Background reviewer" desc="After DrakoX edits files, a read-only reviewer agent checks the diff for bugs (Muse-style).">
          <Toggle checked={Boolean(eff.autoReview)} onChange={(v) => patchCfg({ autoReview: v })} />
        </Row>
        <Row title="Session budget" desc="Stop a session when its estimated cost passes this amount (USD). Empty = no limit.">
          <Input type="number" min={0} step={0.5} defaultValue={eff.budget?.sessionUsd ?? ''} onBlur={(e) => patchCfg({ budget: e.target.value ? { sessionUsd: Number(e.target.value) } : null })} className="w-28" placeholder="none" />
        </Row>
        <Row title="Max steps per message" desc="Safety limit on model round-trips per turn.">
          <Input type="number" min={5} defaultValue={eff.maxTurns ?? 60} onBlur={(e) => patchCfg({ maxTurns: Number(e.target.value) || null })} className="w-28" />
        </Row>
      </Card>
      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {(['allow', 'ask', 'deny'] as const).map((list) => (
          <RuleList key={list} list={list} rules={user.permissions?.[list] ?? []} inherited={(eff.permissions?.[list] ?? []).filter((r: string) => !(user.permissions?.[list] ?? []).includes(r))} onChange={(rules) => patchCfg({ permissions: { [list]: rules } })} />
        ))}
      </div>
      <p className="mt-3 text-[12px] text-faint">
        Rule syntax: <span className="font-mono">bash(npm test*)</span>, <span className="font-mono">edit_file(src/**)</span>, <span className="font-mono">web_fetch(domain:github.com)</span>, <span className="font-mono">mcp__github__*</span>. Deny always wins. Project rules live in .drakox/settings.json.
      </p>
      <WebSearch current={eff.webSearch} />
    </div>
  );
}

function RuleList({ list, rules, inherited, onChange }: { list: 'allow' | 'ask' | 'deny'; rules: string[]; inherited: string[]; onChange: (r: string[]) => void }) {
  const [v, setV] = useState('');
  const tone = list === 'allow' ? 'ok' : list === 'ask' ? 'warn' : 'bad';
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <Shield className={cx('size-4', list === 'allow' ? 'text-ok' : list === 'ask' ? 'text-warn' : 'text-bad')} />
        <span className="text-[13.5px] font-semibold capitalize">{list}</span>
      </div>
      <div className="flex min-h-8 flex-wrap gap-1.5">
        {rules.map((r) => (
          <Badge key={r} tone={tone} className="font-mono">
            {r}
            <button onClick={() => onChange(rules.filter((x) => x !== r))} className="hover:text-fg">
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        {inherited.map((r) => (
          <Badge key={r} title="From project/local settings" className="font-mono opacity-70">
            {r}
          </Badge>
        ))}
        {!rules.length && !inherited.length && <span className="text-[12px] text-faint">No rules</span>}
      </div>
      <div className="mt-3 flex gap-2">
        <Input
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && v.trim()) {
              onChange([...rules, v.trim()]);
              setV('');
            }
          }}
          placeholder={list === 'allow' ? 'bash(npm run *)' : list === 'ask' ? 'bash(git push*)' : 'bash(rm -rf*)'}
          className="h-8 font-mono text-[12px]"
        />
      </div>
    </Card>
  );
}

function WebSearch({ current }: { current?: { provider?: string; baseURL?: string } }) {
  const [provider, setProvider] = useState(current?.provider ?? '');
  const [key, setKey] = useState('');
  const [baseURL, setBaseURL] = useState(current?.baseURL ?? '');
  return (
    <Card className="mt-8 p-4">
      <div className="mb-1 flex items-center gap-2 text-[14px] font-semibold">
        <Search className="size-4 text-info" /> Web search
      </div>
      <div className="mb-3 text-[12.5px] text-muted">Lets agents search the web (fetching pages works without it). Brave and Tavily have free tiers; SearXNG is self-hosted and free.</div>
      <div className="flex flex-wrap gap-2">
        <Select
          value={provider}
          onChange={setProvider}
          options={[
            { value: '', label: 'Off' },
            { value: 'brave', label: 'Brave Search' },
            { value: 'tavily', label: 'Tavily' },
            { value: 'exa', label: 'Exa' },
            { value: 'searxng', label: 'SearXNG (self-hosted)' },
          ]}
        />
        {provider === 'searxng' ? <Input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="http://localhost:8080" className="w-64" /> : provider ? <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="API key" className="w-64" /> : null}
        <Button
          onClick={async () => {
            try {
              await put('/api/websearch', { provider: provider || null, ...(key ? { apiKey: key } : {}), baseURL: baseURL || undefined });
              toast.success(provider ? 'Web search configured' : 'Web search off');
              setKey('');
            } catch (e) {
              toast.error((e as Error).message);
            }
          }}
        >
          Save
        </Button>
      </div>
    </Card>
  );
}

function General() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const info = useStore((s) => s.info);
  const [cfg, setCfg] = useState<any>(null);
  useEffect(() => {
    get('/api/config').then(setCfg);
  }, []);
  return (
    <div>
      <Card className="px-5">
        <Row title="Theme">
          <Segmented
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'dark', label: <><Moon className="size-3.5" /> Dark</> },
              { value: 'light', label: <><Sun className="size-3.5" /> Light</> },
              { value: 'system', label: <><Monitor className="size-3.5" /> System</> },
            ]}
          />
        </Row>
        <Row title="Trust this folder" desc="Trusted folders may run their own hooks and local MCP servers (.mcp.json / .drakox/settings.json).">
          <Toggle
            checked={Boolean(info?.trusted)}
            onChange={async (v) => {
              await post('/api/trust', { trusted: v });
              toast.success(v ? 'Folder trusted' : 'Trust removed');
            }}
          />
        </Row>
        <Row title="Show onboarding again">
          <Button onClick={() => useStore.getState().setOnboarding(true)}>Open</Button>
        </Row>
      </Card>
      <div className="mt-8">
        <div className="mb-2 text-[13.5px] font-semibold">Configuration files</div>
        <Card className="divide-y divide-line">
          {cfg?.sources
            ?.filter((s: any) => s.file)
            .map((s: any) => (
              <div key={s.file} className="flex items-center gap-3 px-4 py-2.5 text-[12.5px]">
                {s.exists ? <CheckCircle2 className="size-3.5 text-ok" /> : <span className="size-3.5 rounded-full border border-line-strong" />}
                <span className="w-20 shrink-0 text-muted">{s.scope}</span>
                <span className="min-w-0 truncate font-mono text-[11.5px]">{s.file}</span>
              </div>
            ))}
        </Card>
        <p className="mt-2 text-[12px] text-faint">Layers merge in order (user → .mcp.json → project → local → command line). Secrets live in {info?.home}/credentials.json (mode 600).</p>
      </div>
    </div>
  );
}

function About() {
  const info = useStore((s) => s.info);
  return (
    <div className="space-y-5">
      <Card className="flex items-center gap-4 p-5">
        <LogoMark size={52} />
        <div>
          <div className="text-[18px] font-bold">
            Drako<span className="brand-text">X</span> <span className="text-[13px] font-normal text-muted">v{info?.version}</span>
          </div>
          <div className="text-[13px] text-muted">The open agent harness — terminal, web app and SDK. MIT licensed.</div>
        </div>
      </Card>
      <Card className="p-5">
        <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold">
          <Heart className="size-4 text-brand" /> What “free & unlimited” means
        </div>
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-muted">
          <li>DrakoX itself is open source (MIT), needs no account and imposes no quotas, credits or rate limits.</li>
          <li>With local models (Ollama, LM Studio, llama.cpp, vLLM) usage is truly unlimited and private — you only pay for electricity.</li>
          <li>Cloud models are billed by their provider at cost; DrakoX shows real token counts and costs instead of opaque credits. Free tiers (Gemini, Groq, OpenRouter :free, Cerebras, GitHub Models, Mistral) work out of the box.</li>
          <li>DrakoX never bypasses provider subscriptions or terms of service.</li>
        </ul>
      </Card>
      <Card className="p-5">
        <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold">
          <Lock className="size-4 text-info" /> Clean-room design
        </div>
        <p className="text-[13px] text-muted">
          DrakoX was designed with the REA (Reverse Engineer Anything) methodology applied to public documentation and observable behaviour of Claude Code, Codex, Antigravity, Cursor and Muse — no proprietary code was copied. REA is also built in as an integration for your own reverse-engineering work.
        </p>
      </Card>
      <Card className="p-5">
        <div className="mb-3 text-[14px] font-semibold">Keyboard shortcuts</div>
        <div className="grid gap-2 text-[13px] sm:grid-cols-2">
          {[
            [['Ctrl', 'K'], 'Command palette'],
            [['Shift', 'Tab'], 'Cycle mode (in composer)'],
            [['Esc'], 'Stop the agent'],
            [['@'], 'Mention a file'],
            [['/'], 'Slash commands'],
            [['Tab'], 'Accept AI completion (editor)'],
            [['Ctrl', 'S'], 'Save file (editor)'],
          ].map(([keys, label]) => (
            <div key={label as string} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2">
              <span className="text-muted">{label as string}</span>
              <span className="flex gap-1">
                {(keys as string[]).map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </Card>
      <div className="text-[12px] text-faint">
        Source: <a className="text-brand hover:underline" href="https://github.com/Dimova88/DrakoX" target="_blank" rel="noreferrer">github.com/Dimova88/DrakoX</a> · REA: <a className="text-brand hover:underline" href="https://github.com/morluto/rea" target="_blank" rel="noreferrer">github.com/morluto/rea</a>
      </div>
    </div>
  );
}

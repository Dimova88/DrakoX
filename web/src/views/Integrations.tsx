import { useEffect, useMemo, useState } from 'react';
import { BadgeCheck, ChevronDown, ChevronRight, Download, ExternalLink, Globe, KeyRound, Laptop, LogIn, Plus, Power, RefreshCw, Search, Trash2, Upload, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { del, get, post } from '../lib/api';
import { useStore } from '../lib/store';
import { navigate } from '../lib/route';
import type { CatalogEntry, McpView, RegistryServer } from '../lib/types';
import { Badge, Button, Card, Empty, Input, Modal, Segmented, Select, Spinner, StatusDot, Tabs, Textarea, Toggle } from '../components/ui';
import { classNames as cx } from '../lib/format';

type Tab = 'installed' | 'catalog' | 'registry' | 'custom' | 'import';

export function Integrations({ tab: initial }: { tab?: string }) {
  const mcp = useStore((s) => s.mcp);
  const [tab, setTab] = useState<Tab>((initial as Tab) || (mcp.length ? 'installed' : 'catalog'));
  useEffect(() => {
    if (initial) setTab(initial as Tab);
  }, [initial]);
  const change = (t: Tab) => {
    setTab(t);
    navigate(`#/integrations/${t}`);
  };
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 pb-16 pt-8">
        <div className="mb-1 flex items-center gap-3">
          <h1 className="text-[22px] font-bold tracking-tight">Integrations</h1>
          <Badge tone="brand">MCP</Badge>
        </div>
        <p className="mb-5 max-w-3xl text-[13.5px] text-muted">
          Connect DrakoX to the apps you use. Every integration is a Model Context Protocol server — pick from the catalog, search the official MCP Registry, import from Claude Code / Cursor / VS Code / Codex, or add any server yourself. Secrets stay in <span className="font-mono text-[12px]">~/.drakox/credentials.json</span>.
        </p>
        <Tabs
          value={tab}
          onChange={change}
          tabs={[
            { value: 'installed', label: 'Installed', count: mcp.length },
            { value: 'catalog', label: 'Catalog' },
            { value: 'registry', label: 'MCP Registry' },
            { value: 'custom', label: 'Add custom' },
            { value: 'import', label: 'Import' },
          ]}
        />
        <div className="pt-5">
          {tab === 'installed' && <Installed onBrowse={() => change('catalog')} />}
          {tab === 'catalog' && <Catalog />}
          {tab === 'registry' && <Registry />}
          {tab === 'custom' && <Custom />}
          {tab === 'import' && <Import />}
        </div>
      </div>
    </div>
  );
}

function ServerIcon({ s, size = 'md' }: { s: { color?: string; icon?: string; name: string }; size?: 'md' | 'lg' }) {
  const px = size === 'lg' ? 'size-11 text-[18px] rounded-xl' : 'size-9 text-[15px] rounded-lg';
  return (
    <div className={cx('flex shrink-0 items-center justify-center font-bold text-white shadow-inner', px)} style={{ background: s.color ?? 'linear-gradient(135deg,#3f3f46,#27272a)' }}>
      {s.icon ?? s.name.slice(0, 1).toUpperCase()}
    </div>
  );
}

async function signIn(name: string) {
  const popup = window.open('about:blank', `drakox-oauth-${name}`, 'width=560,height=720');
  try {
    const r = await post<{ status: string; authUrl?: string; error?: string }>(`/api/mcp/${encodeURIComponent(name)}/login`);
    if (r.status === 'connected') {
      popup?.close();
      toast.success(`${name} is connected`);
      return;
    }
    if (r.authUrl) {
      if (popup) popup.location.href = r.authUrl;
      else window.open(r.authUrl, '_blank');
      toast.info('Finish signing in in the popup window…');
    } else {
      popup?.close();
      toast.error(r.error ?? 'Could not start sign-in');
    }
  } catch (e) {
    popup?.close();
    toast.error((e as Error).message);
  }
}

function Installed({ onBrowse }: { onBrowse: () => void }) {
  const mcp = useStore((s) => s.mcp);
  const refresh = useStore((s) => s.refreshMcp);
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.data?.type === 'drakox-oauth') {
        toast.success(`Signed in to ${e.data.server}`);
        void refresh();
      }
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [refresh]);
  if (!mcp.length)
    return (
      <Empty icon={<Plus className="size-5" />} title="No integrations yet" action={<Button variant="primary" onClick={onBrowse}>Browse the catalog</Button>}>
        GitHub, Linear, Notion, Slack, Postgres, browsers, Figma, Stripe, REA reverse-engineering and thousands more.
      </Empty>
    );
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {mcp.map((s) => (
        <InstalledCard key={s.name} s={s} />
      ))}
    </div>
  );
}

function InstalledCard({ s }: { s: McpView }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const enabled = s.status !== 'disabled';
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const summary = s.config?.url ?? [s.config?.command, ...(s.config?.args ?? [])].filter(Boolean).join(' ');
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <ServerIcon s={{ ...s.catalog, name: s.name }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold">{s.catalog?.name ?? s.name}</span>
            <StatusDot status={s.status} />
            <span className={cx('text-[11.5px]', s.status === 'connected' ? 'text-ok' : s.status === 'error' ? 'text-bad' : 'text-muted')}>{s.status === 'needs_auth' ? 'sign-in required' : s.status}</span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-faint" title={summary}>
            {summary}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Badge>{s.transport === 'stdio' ? <Laptop className="size-3" /> : <Globe className="size-3" />} {s.transport === 'stdio' ? 'local' : 'remote'}</Badge>
            {s.scopes.map((sc) => (
              <Badge key={sc} tone={sc === 'user' ? 'neutral' : 'info'}>
                {sc}
              </Badge>
            ))}
            {s.status === 'connected' && <Badge tone="ok">{s.tools.length} tools</Badge>}
            {s.serverInfo && <Badge>v{s.serverInfo.version}</Badge>}
          </div>
        </div>
        <Toggle checked={enabled} disabled={busy} onChange={(v) => act(() => post(`/api/mcp/${encodeURIComponent(s.name)}/toggle`, { enabled: v }))} label="Enabled" />
      </div>
      {s.error && s.status !== 'connected' && <pre className="mt-3 max-h-28 overflow-auto whitespace-pre-wrap rounded-lg border border-bad/20 bg-bad/5 p-2 font-mono text-[11px] text-bad/90">{s.error}</pre>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {s.status === 'needs_auth' && (
          <Button size="xs" variant="primary" icon={<LogIn className="size-3" />} onClick={() => signIn(s.name)}>
            Sign in
          </Button>
        )}
        {s.status === 'untrusted' && (
          <Button size="xs" variant="primary" onClick={() => act(async () => { await post('/api/trust', { trusted: true }); toast.success('Folder trusted'); })}>
            Trust this folder
          </Button>
        )}
        <Button size="xs" variant="ghost" icon={<RefreshCw className="size-3" />} loading={busy} onClick={() => act(() => post(`/api/mcp/${encodeURIComponent(s.name)}/reconnect`))}>
          Reconnect
        </Button>
        {s.tools.length > 0 && (
          <Button size="xs" variant="ghost" icon={open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />} onClick={() => setOpen((o) => !o)}>
            Tools
          </Button>
        )}
        <div className="flex-1" />
        <Button
          size="xs"
          variant="ghost"
          className="hover:!text-bad"
          icon={<Trash2 className="size-3" />}
          onClick={() => {
            if (confirm(`Remove ${s.name}? Its stored secrets are deleted too.`)) void act(() => del(`/api/mcp/${encodeURIComponent(s.name)}`));
          }}
        >
          Remove
        </Button>
      </div>
      {open && (
        <div className="mt-3 max-h-64 space-y-1 overflow-y-auto border-t border-line pt-3">
          {s.tools.map((t) => (
            <div key={t.name} className="text-[12px]">
              <span className="font-mono text-info">{t.name}</span>
              {t.annotations?.readOnlyHint && <Badge tone="ok" className="ml-1.5">read-only</Badge>}
              {t.annotations?.destructiveHint && <Badge tone="bad" className="ml-1.5">destructive</Badge>}
              <div className="line-clamp-2 text-muted">{t.description}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Catalog() {
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('All');
  const [picked, setPicked] = useState<CatalogEntry | null>(null);
  const mcp = useStore((s) => s.mcp);
  useEffect(() => {
    get<CatalogEntry[]>('/api/mcp/catalog').then(setEntries).catch((e) => toast.error(e.message));
  }, [mcp.length]);
  const cats = useMemo(() => ['All', ...new Set((entries ?? []).map((e) => e.category))], [entries]);
  const filtered = (entries ?? []).filter((e) => (cat === 'All' || e.category === cat) && (!q || `${e.name} ${e.description} ${e.publisher} ${e.id}`.toLowerCase().includes(q.toLowerCase())));
  if (!entries) return <Spinner />;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search integrations…" className="pl-8" />
        </div>
        <div className="flex flex-wrap gap-1">
          {cats.map((c) => (
            <button key={c} onClick={() => setCat(c)} className={cx('h-7 rounded-full border px-3 text-[12px] transition-colors', cat === c ? 'border-brand/50 bg-brand/10 text-brand' : 'border-line text-muted hover:text-fg')}>
              {c}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((e) => (
          <Card key={e.id} className={cx('flex flex-col p-4', e.featured && 'ring-1 ring-brand/15')}>
            <div className="flex items-start gap-3">
              <ServerIcon s={e} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[14px] font-semibold">{e.name}</span>
                  {e.official && <BadgeCheck className="size-3.5 shrink-0 text-info" aria-label="Official" />}
                </div>
                <div className="text-[11.5px] text-faint">{e.publisher}</div>
              </div>
              {e.auth === 'oauth' ? <Badge tone="violet">sign-in</Badge> : e.auth === 'token' ? <Badge tone="warn">API key</Badge> : e.auth === 'local-app' ? <Badge>local app</Badge> : <Badge tone="ok">no auth</Badge>}
            </div>
            <div className="mt-2.5 line-clamp-3 flex-1 text-[12.5px] text-muted">{e.description}</div>
            <div className="mt-3 flex items-center gap-2">
              {e.installed ? (
                <Badge tone="ok">Installed</Badge>
              ) : (
                <Button size="xs" variant="primary" icon={<Plus className="size-3" />} onClick={() => setPicked(e)}>
                  Add
                </Button>
              )}
              {e.homepage && (
                <a href={e.homepage} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11.5px] text-faint hover:text-muted">
                  Docs <ExternalLink className="size-3" />
                </a>
              )}
              <span className="ml-auto text-[10.5px] text-faint">{e.category}</span>
            </div>
          </Card>
        ))}
      </div>
      {!filtered.length && (
        <Empty title="Nothing in the catalog matches" action={<Button onClick={() => navigate('#/integrations/registry')}>Search the MCP Registry</Button>}>
          The official MCP Registry has thousands more servers.
        </Empty>
      )}
      {picked && <InstallModal entry={picked} onClose={() => setPicked(null)} />}
    </div>
  );
}

function InstallModal({ entry, onClose }: { entry: CatalogEntry; onClose: () => void }) {
  const [inputs, setInputs] = useState<Record<string, string>>(() => Object.fromEntries((entry.inputs ?? []).map((i) => [i.key, i.default ?? ''])));
  const [scope, setScope] = useState<'user' | 'project' | 'local'>('user');
  const [busy, setBusy] = useState(false);
  const install = async () => {
    setBusy(true);
    try {
      const r = await post<McpView>(`/api/mcp/catalog/${encodeURIComponent(entry.id)}`, { inputs, scope });
      toast.success(`${entry.name} added`);
      if (entry.auth === 'oauth' || r.status === 'needs_auth') void signIn(r.name);
      onClose();
      navigate('#/integrations/installed');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Add ${entry.name}`}
      icon={<ServerIcon s={entry} />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={install}>
            {entry.auth === 'oauth' ? 'Add & sign in' : 'Add integration'}
          </Button>
        </>
      }
    >
      <p className="text-[13px] text-muted">{entry.description}</p>
      {entry.requires && <div className="mt-2 rounded-lg border border-line bg-elev px-3 py-2 text-[12px] text-muted">Requires: {entry.requires}</div>}
      <div className="mt-4 space-y-3">
        {(entry.inputs ?? []).map((i) => (
          <label key={i.key} className="block">
            <span className="mb-1 flex items-center gap-1.5 text-[12.5px] font-medium">
              {i.secret && <KeyRound className="size-3 text-warn" />}
              {i.label}
              {i.optional && <span className="font-normal text-faint">(optional)</span>}
            </span>
            <Input type={i.secret ? 'password' : 'text'} value={inputs[i.key] ?? ''} placeholder={i.placeholder} onChange={(e) => setInputs((cur) => ({ ...cur, [i.key]: e.target.value }))} autoComplete="off" />
            {i.help && <span className="mt-1 block text-[11.5px] text-faint">{i.help}</span>}
          </label>
        ))}
        {entry.auth === 'oauth' && <div className="text-[12.5px] text-muted">You will sign in with {entry.name} in a popup — no API key needed.</div>}
        <div>
          <div className="mb-1 text-[12.5px] font-medium">Available in</div>
          <Segmented
            value={scope}
            onChange={setScope}
            options={[
              { value: 'user', label: 'All my projects' },
              { value: 'project', label: 'This project (shared, .mcp.json)' },
              { value: 'local', label: 'This project (just me)' },
            ]}
          />
        </div>
      </div>
    </Modal>
  );
}

function Registry() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<RegistryServer[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<RegistryServer | null>(null);
  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      setResults(await get<RegistryServer[]>(`/api/mcp/registry?q=${encodeURIComponent(q.trim())}`));
    } catch (e) {
      toast.error((e as Error).message);
      setResults([]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="mb-4 flex max-w-xl gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="Search the official MCP Registry (e.g. jira, postgres, figma)…" className="pl-8" />
        </div>
        <Button variant="primary" loading={busy} onClick={search}>
          Search
        </Button>
      </div>
      {results === null ? (
        <div className="text-[13px] text-muted">
          Results come live from <span className="font-mono text-[12px]">registry.modelcontextprotocol.io</span>. DrakoX turns each entry into a ready-to-run config (npm → npx, PyPI → uvx, OCI → docker, or a remote URL).
        </div>
      ) : results.length === 0 ? (
        <Empty title="No servers found" />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {results.map((r) => (
            <Card key={r.name} className="p-4">
              <div className="flex items-start gap-3">
                <ServerIcon s={{ name: r.title ?? r.name.split('/').pop() ?? r.name }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-semibold">{r.title ?? r.name.split('/').pop()}</div>
                  <div className="truncate font-mono text-[11px] text-faint">{r.name}</div>
                </div>
                <Badge>{r.kind}</Badge>
              </div>
              <div className="mt-2 line-clamp-2 text-[12.5px] text-muted">{r.description}</div>
              <div className="mt-3 flex items-center gap-2">
                <Button size="xs" variant="primary" disabled={!r.install} icon={<Download className="size-3" />} onClick={() => setPicked(r)}>
                  Install
                </Button>
                {r.repository && (
                  <a href={r.repository} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11.5px] text-faint hover:text-muted">
                    Source <ExternalLink className="size-3" />
                  </a>
                )}
                {r.version && <span className="ml-auto text-[10.5px] text-faint">v{r.version}</span>}
              </div>
            </Card>
          ))}
        </div>
      )}
      {picked && <RegistryInstall server={picked} onClose={() => setPicked(null)} />}
    </div>
  );
}

function RegistryInstall({ server, onClose }: { server: RegistryServer; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [name, setName] = useState((server.name.split('/').pop() ?? 'server').replace(/[^a-zA-Z0-9_.-]/g, '-'));
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await post('/api/mcp/registry/install', { server, values, name });
      toast.success(`Installed ${name}`);
      onClose();
      navigate('#/integrations/installed');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Install ${server.title ?? server.name}`} footer={<Button variant="primary" loading={busy} onClick={go}>Install</Button>}>
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-[12.5px] font-medium">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {server.inputs.map((i) => (
          <label key={i.key} className="block">
            <span className="mb-1 flex items-center gap-1.5 text-[12.5px] font-medium">
              {i.secret && <KeyRound className="size-3 text-warn" />}
              <span className="font-mono">{i.key}</span>
              {!i.required && <span className="font-normal text-faint">(optional)</span>}
            </span>
            <Input type={i.secret ? 'password' : 'text'} value={values[i.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [i.key]: e.target.value }))} autoComplete="off" />
            {i.description && <span className="mt-1 block text-[11.5px] text-faint">{i.description}</span>}
          </label>
        ))}
        <pre className="overflow-x-auto rounded-lg border border-line bg-bg p-2 font-mono text-[11px] text-muted">{JSON.stringify(server.install, null, 2)}</pre>
      </div>
    </Modal>
  );
}

function Custom() {
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http' | 'sse'>('stdio');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [rows, setRows] = useState<{ k: string; v: string }[]>([{ k: '', v: '' }]);
  const [scope, setScope] = useState('user');
  const [json, setJson] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      if (mode === 'json') {
        const r = await post<{ added: string[] }>('/api/mcp/paste', { text: json, scope });
        toast.success(`Added ${r.added.join(', ')}`);
      } else {
        const kv = Object.fromEntries(rows.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v]));
        const parts = command.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((p) => p.replace(/^["']|["']$/g, '')) ?? [];
        const config = transport === 'stdio' ? { type: 'stdio', command: parts[0], args: parts.slice(1), ...(Object.keys(kv).length ? { env: kv } : {}) } : { type: transport, url: url.trim(), ...(Object.keys(kv).length ? { headers: kv } : {}) };
        await post('/api/mcp', { name: name.trim(), config, scope });
        toast.success(`Added ${name}`);
      }
      navigate('#/integrations/installed');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="max-w-2xl">
      <div className="mb-4">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'form', label: <><Wrench className="size-3.5" /> Form</> },
            { value: 'json', label: <><Upload className="size-3.5" /> Paste JSON</> },
          ]}
        />
      </div>
      {mode === 'form' ? (
        <div className="space-y-3.5">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[12.5px] font-medium">Name</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12.5px] font-medium">Type</span>
              <Select
                className="w-full"
                value={transport}
                onChange={(v) => setTransport(v as 'stdio')}
                options={[
                  { value: 'stdio', label: 'Local command (stdio)' },
                  { value: 'http', label: 'Remote URL (Streamable HTTP)' },
                  { value: 'sse', label: 'Remote URL (SSE, legacy)' },
                ]}
              />
            </label>
          </div>
          {transport === 'stdio' ? (
            <label className="block">
              <span className="mb-1 block text-[12.5px] font-medium">Command</span>
              <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx -y rea-agents mcp" className="font-mono" />
            </label>
          ) : (
            <label className="block">
              <span className="mb-1 block text-[12.5px] font-medium">URL</span>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" className="font-mono" />
              <span className="mt-1 block text-[11.5px] text-faint">Servers that need browser sign-in (OAuth) are detected automatically.</span>
            </label>
          )}
          <div>
            <div className="mb-1 text-[12.5px] font-medium">{transport === 'stdio' ? 'Environment variables' : 'Headers'}</div>
            <div className="space-y-2">
              {rows.map((r, i) => (
                <div key={i} className="flex gap-2">
                  <Input value={r.k} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} placeholder={transport === 'stdio' ? 'API_KEY' : 'Authorization'} className="w-48 font-mono" />
                  <Input value={r.v} type={/(key|token|secret|auth|password)/i.test(r.k) ? 'password' : 'text'} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} placeholder="value" className="font-mono" />
                  <Button variant="ghost" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
              <Button size="xs" variant="ghost" icon={<Plus className="size-3" />} onClick={() => setRows((rs) => [...rs, { k: '', v: '' }])}>
                Add
              </Button>
            </div>
            <div className="mt-1 text-[11.5px] text-faint">Values that look like secrets are moved to credentials.json automatically.</div>
          </div>
        </div>
      ) : (
        <div>
          <Textarea
            rows={12}
            value={json}
            onChange={(e) => setJson(e.target.value)}
            className="font-mono text-[12px]"
            placeholder={'Paste any MCP config — Claude, Cursor, VS Code, Codex formats all work:\n\n{\n  "mcpServers": {\n    "rea": { "command": "npx", "args": ["-y", "rea-agents", "mcp"] },\n    "linear": { "url": "https://mcp.linear.app/mcp" }\n  }\n}'}
          />
        </div>
      )}
      <div className="mt-4 flex items-center gap-3">
        <Select
          value={scope}
          onChange={setScope}
          options={[
            { value: 'user', label: 'All my projects' },
            { value: 'project', label: 'This project (shared)' },
            { value: 'local', label: 'This project (just me)' },
          ]}
        />
        <Button variant="primary" loading={busy} onClick={submit} disabled={mode === 'form' ? !name.trim() || (transport === 'stdio' ? !command.trim() : !url.trim()) : !json.trim()}>
          Add integration
        </Button>
      </div>
    </div>
  );
}

function Import() {
  const [sources, setSources] = useState<{ id: string; name: string; file: string; servers: { name: string; transport: string; exists: boolean; summary: string }[] }[] | null>(null);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get('/api/mcp/import').then(setSources).catch((e) => toast.error(e.message));
  }, []);
  if (!sources) return <Spinner />;
  if (!sources.length)
    return (
      <Empty icon={<Power className="size-5" />} title="Nothing to import">
        DrakoX looks for MCP configs from Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Codex, Gemini CLI and opencode on this machine and in this project.
      </Empty>
    );
  const chosen = Object.entries(sel).filter(([, v]) => v);
  return (
    <div className="max-w-3xl space-y-4">
      {sources.map((src) => (
        <Card key={src.id} className="p-4">
          <div className="text-[14px] font-semibold">{src.name}</div>
          <div className="mb-2 font-mono text-[11px] text-faint">{src.file}</div>
          {src.servers.map((s) => {
            const key = `${src.id}::${s.name}`;
            return (
              <label key={key} className={cx('flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-hover', s.exists && 'opacity-50')}>
                <input type="checkbox" disabled={s.exists} checked={Boolean(sel[key])} onChange={(e) => setSel((cur) => ({ ...cur, [key]: e.target.checked }))} className="accent-[#ff6b35]" />
                <span className="text-[13px] font-medium">{s.name}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">{s.summary}</span>
                {s.exists && <Badge>already added</Badge>}
              </label>
            );
          })}
        </Card>
      ))}
      <Button
        variant="primary"
        loading={busy}
        disabled={!chosen.length}
        onClick={async () => {
          setBusy(true);
          try {
            const servers = chosen.map(([k]) => ({ source: k.split('::')[0], name: k.split('::')[1] }));
            const r = await post<{ added: string[] }>('/api/mcp/import', { servers });
            toast.success(`Imported ${r.added.length} integration(s)`);
            navigate('#/integrations/installed');
          } catch (e) {
            toast.error((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Import {chosen.length || ''} selected
      </Button>
    </div>
  );
}

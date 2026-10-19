import { useState } from 'react';
import { Check, Cloud, Copy, Gift, HardDrive, KeyRound, Loader2, PlayCircle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { post, put } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Input, Modal } from './ui';
import { LogoMark } from './Logo';
import { classNames as cx } from '../lib/format';

const FREE = [
  { id: 'gemini', name: 'Google Gemini', note: 'Generous free tier, 1M context' },
  { id: 'groq', name: 'Groq', note: 'Very fast open models, free tier' },
  { id: 'openrouter', name: 'OpenRouter', note: 'Many “:free” models' },
  { id: 'cerebras', name: 'Cerebras', note: 'Fast Qwen/Llama, free tier' },
  { id: 'github', name: 'GitHub Models', note: 'Free with a GitHub token' },
  { id: 'mistral', name: 'Mistral', note: 'Free experiment tier (Codestral)' },
];

export function Onboarding() {
  const open = useStore((s) => s.onboardingOpen);
  const setOpen = useStore((s) => s.setOnboarding);
  const providers = useStore((s) => s.providers);
  const refresh = useStore((s) => s.refreshProviders);
  const [tab, setTab] = useState<'local' | 'free' | 'key'>('local');
  const [pick, setPick] = useState('gemini');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const local = providers.filter((p) => p.category === 'local' && p.reachable && p.models.length);
  const copy = (t: string) => {
    void navigator.clipboard.writeText(t);
    toast.success('Copied');
  };
  const useModel = async (ref: string) => {
    await put('/api/default-model', { model: ref });
    toast.success(`Default model: ${ref}`);
    setOpen(false);
  };
  const saveKey = async (id: string) => {
    setBusy(true);
    try {
      await put(`/api/providers/${id}`, { apiKey: key.trim() });
      setKey('');
      const t = await post<{ ok: boolean; error?: string; kind?: string; sample?: string[]; recommended?: string }>(`/api/providers/${id}/test`);
      if (!t.ok) {
        if (t.kind === 'network') {
          // the key is fine as far as we know — the machine running DrakoX just can't reach the provider
          toast.warning(`Key saved, but DrakoX can't connect right now. ${t.error ?? ''}`, { duration: 15000 });
          return;
        }
        throw new Error(t.kind === 'auth' ? `The key was rejected. ${t.error ?? ''} Paste another key to replace it.` : t.error ?? 'Key test failed');
      }
      await refresh(true);
      const model = t.recommended ?? t.sample?.[0];
      if (model) await useModel(`${id}/${model}`);
      else setOpen(false);
    } catch (e) {
      toast.error((e as Error).message, { duration: 15000 });
    } finally {
      setBusy(false);
    }
  };
  const card = (id: typeof tab, icon: React.ReactNode, title: string, desc: string) => (
    <button onClick={() => setTab(id)} className={cx('flex-1 rounded-xl border p-3 text-left transition-all', tab === id ? 'border-brand/50 bg-brand/5 ring-1 ring-brand/20' : 'border-line hover:border-line-strong')}>
      <div className="mb-1 flex items-center gap-2 text-[13.5px] font-semibold">
        {icon} {title}
      </div>
      <div className="text-[12px] text-muted">{desc}</div>
    </button>
  );
  return (
    <Modal open={open} onClose={() => setOpen(false)} width="max-w-2xl" title={<span className="flex items-center gap-2"><LogoMark size={22} /> Welcome to DrakoX</span>}>
      <p className="text-[13.5px] text-muted">An open agent harness — plans, edits, runs and verifies code with any model and any app. Pick how you want to power it (you can change this any time):</p>
      <div className="mt-4 flex gap-2">
        {card('local', <HardDrive className="size-4 text-ok" />, 'Local', 'Free, unlimited, private')}
        {card('free', <Gift className="size-4 text-brand" />, 'Free cloud', 'Free tiers, just a key')}
        {card('key', <Cloud className="size-4 text-info" />, 'Your key', 'Claude, GPT, Gemini…')}
      </div>
      <div className="mt-4 rounded-xl border border-line bg-bg p-4">
        {tab === 'local' && (
          <div className="space-y-3 text-[13px]">
            {local.length ? (
              <>
                <div className="flex items-center gap-2 text-ok">
                  <Check className="size-4" /> Found {local.map((p) => p.name).join(', ')}
                </div>
                <div className="flex flex-wrap gap-2">
                  {local.flatMap((p) => p.models.slice(0, 6).map((m) => `${p.id}/${m.id}`)).map((ref) => (
                    <Button key={ref} size="sm" onClick={() => useModel(ref)}>
                      {ref}
                    </Button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div>
                  1. Install <a className="text-brand hover:underline" href="https://ollama.com/download" target="_blank" rel="noreferrer">Ollama</a> (or LM Studio).
                </div>
                <div className="flex items-center gap-2">
                  2. Pull a coding model:
                  <code className="rounded-md border border-line bg-panel px-2 py-1 font-mono text-[12px]">ollama pull qwen3-coder:30b</code>
                  <button onClick={() => copy('ollama pull qwen3-coder:30b')} className="text-muted hover:text-fg">
                    <Copy className="size-3.5" />
                  </button>
                </div>
                <div className="text-[12px] text-faint">Smaller machine? Try gpt-oss:20b or qwen2.5-coder:7b.</div>
                <Button
                  size="sm"
                  icon={checking ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                  onClick={async () => {
                    setChecking(true);
                    await refresh(true).finally(() => setChecking(false));
                  }}
                >
                  3. Detect again
                </Button>
              </>
            )}
          </div>
        )}
        {tab === 'free' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              {FREE.map((f) => {
                const p = providers.find((x) => x.id === f.id);
                return (
                  <button key={f.id} onClick={() => setPick(f.id)} className={cx('rounded-lg border px-3 py-2 text-left', pick === f.id ? 'border-brand/50 bg-brand/5' : 'border-line hover:bg-hover')}>
                    <div className="text-[13px] font-medium">{f.name}</div>
                    <div className="text-[11.5px] text-muted">{f.note}</div>
                    {p?.signupUrl && pick === f.id && (
                      <a href={p.signupUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-[11.5px] text-brand hover:underline">
                        Get a free key →
                      </a>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <KeyRound className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
                <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={`${FREE.find((f) => f.id === pick)?.name} API key`} className="pl-8" />
              </div>
              <Button variant="primary" loading={busy} disabled={!key.trim()} onClick={() => saveKey(pick)}>
                Connect
              </Button>
            </div>
          </div>
        )}
        {tab === 'key' && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {['anthropic', 'openai', 'gemini', 'deepseek', 'xai', 'mistral', 'moonshot', 'zai'].map((id) => (
                <button key={id} onClick={() => setPick(id)} className={cx('h-8 rounded-lg border px-3 text-[12.5px]', pick === id ? 'border-brand/50 bg-brand/5 text-fg' : 'border-line text-muted hover:text-fg')}>
                  {providers.find((p) => p.id === id)?.name ?? id}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="API key — stored locally in ~/.drakox/credentials.json" />
              <Button variant="primary" loading={busy} disabled={!key.trim()} onClick={() => saveKey(pick)}>
                Connect
              </Button>
            </div>
            <div className="text-[12px] text-faint">You pay the provider directly at cost. DrakoX adds no markup, credits or limits.</div>
          </div>
        )}
      </div>
      <div className="mt-4 flex items-center justify-between">
        <button onClick={() => setOpen(false)} className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg">
          <PlayCircle className="size-4" /> Explore with the offline demo first
        </button>
        <span className="text-[11.5px] text-faint">Everything stays on your machine.</span>
      </div>
    </Modal>
  );
}

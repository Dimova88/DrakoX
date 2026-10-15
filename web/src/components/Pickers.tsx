import { useMemo, useState } from 'react';
import { Check, ChevronDown, Cpu, Globe, HardDrive, Sparkles, Search } from 'lucide-react';
import { useStore } from '../lib/store';
import { Menu, MenuItem } from './ui';
import { classNames as cx, modelLabel } from '../lib/format';
import type { Mode } from '../lib/types';
import { navigate } from '../lib/route';

export const MODE_META: Record<Mode, { label: string; short: string; desc: string; color: string; dot: string }> = {
  plan: { label: 'Plan', short: 'Plan', desc: 'Read-only research, then a plan for your approval', color: 'text-info', dot: 'bg-info' },
  ask: { label: 'Ask', short: 'Ask', desc: 'Asks before edits and risky commands', color: 'text-ok', dot: 'bg-ok' },
  'auto-edit': { label: 'Auto-edit', short: 'Auto', desc: 'Edits files freely, asks for risky commands', color: 'text-warn', dot: 'bg-warn' },
  autopilot: { label: 'Autopilot', short: 'Pilot', desc: 'Runs everything except hard-blocked actions', color: 'text-bad', dot: 'bg-bad' },
};
export const MODES: Mode[] = ['plan', 'ask', 'auto-edit', 'autopilot'];

export function ModePicker({ value, onChange, compact }: { value: Mode; onChange: (m: Mode) => void; compact?: boolean }) {
  const meta = MODE_META[value];
  return (
    <Menu
      width="w-72"
      trigger={(open, toggle) => (
        <button onClick={toggle} title="Mode (Shift+Tab)" className={cx('inline-flex h-7 items-center gap-1.5 rounded-lg border border-line bg-panel px-2 text-[12px] font-medium transition-colors hover:border-line-strong', open && 'border-line-strong')}>
          <span className={cx('size-1.5 rounded-full', meta.dot)} />
          <span className={meta.color}>{compact ? meta.short : meta.label}</span>
          <ChevronDown className="size-3 text-faint" />
        </button>
      )}
    >
      {(close) =>
        MODES.map((m) => (
          <button
            key={m}
            onClick={() => {
              onChange(m);
              close();
            }}
            className={cx('flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-hover', m === value && 'bg-hover')}
          >
            <span className={cx('mt-1.5 size-2 rounded-full', MODE_META[m].dot)} />
            <span className="min-w-0 flex-1">
              <span className={cx('block text-[13px] font-medium', MODE_META[m].color)}>{MODE_META[m].label}</span>
              <span className="block text-[11.5px] text-muted">{MODE_META[m].desc}</span>
            </span>
            {m === value && <Check className="mt-1 size-3.5 text-muted" />}
          </button>
        ))
      }
    </Menu>
  );
}

export function ModelPicker({ value, onChange, align = 'left' }: { value: string; onChange: (ref: string) => void; align?: 'left' | 'right' }) {
  const models = useStore((s) => s.models);
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const filtered = models.filter((m) => !q || m.ref.toLowerCase().includes(q.toLowerCase()));
    const map = new Map<string, typeof filtered>();
    for (const m of filtered) map.set(m.providerName, [...(map.get(m.providerName) ?? []), m]);
    return [...map.entries()];
  }, [models, q]);
  const isDemo = value.startsWith('demo/');
  return (
    <Menu
      width="w-80"
      align={align}
      trigger={(open, toggle) => (
        <button onClick={toggle} title={value} className={cx('inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-lg border border-line bg-panel px-2 text-[12px] font-medium transition-colors hover:border-line-strong', open && 'border-line-strong', isDemo && 'border-warn/40 text-warn')}>
          {isDemo ? <Sparkles className="size-3.5 shrink-0" /> : value.startsWith('ollama/') || value.startsWith('lmstudio/') ? <HardDrive className="size-3.5 shrink-0 text-ok" /> : <Cpu className="size-3.5 shrink-0 text-muted" />}
          <span className="truncate">{isDemo ? 'Demo model' : modelLabel(value)}</span>
          <ChevronDown className="size-3 shrink-0 text-faint" />
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="relative mb-1 p-1">
            <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search models…" className="h-8 w-full rounded-lg border border-line bg-bg pl-8 pr-2 text-[12.5px] outline-none focus:border-brand/50" />
          </div>
          {groups.map(([provider, list]) => (
            <div key={provider} className="mb-1">
              <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-faint">{provider}</div>
              {list.slice(0, 40).map((m) => (
                <MenuItem
                  key={m.ref}
                  active={m.ref === value}
                  onClick={() => {
                    onChange(m.ref);
                    close();
                  }}
                  icon={m.local ? <HardDrive className="size-3.5 text-ok" /> : m.provider === 'demo' ? <Sparkles className="size-3.5 text-warn" /> : <Globe className="size-3.5" />}
                  hint={m.free ? <span className="text-ok">free</span> : undefined}
                >
                  {m.id}
                </MenuItem>
              ))}
            </div>
          ))}
          {!groups.length && <div className="px-3 py-4 text-center text-[12px] text-muted">No models found.</div>}
          <div className="mt-1 border-t border-line p-1">
            <MenuItem
              onClick={() => {
                close();
                navigate('#/settings/models');
              }}
              icon={<Cpu className="size-3.5" />}
            >
              Connect more models…
            </MenuItem>
          </div>
        </div>
      )}
    </Menu>
  );
}

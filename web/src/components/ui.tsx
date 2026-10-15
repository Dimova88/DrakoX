import { createPortal } from 'react-dom';
import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { Loader2, X } from 'lucide-react';
import { classNames as cx } from '../lib/format';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline' | 'ok';

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'xs' | 'sm' | 'md'; loading?: boolean; icon?: ReactNode }>(
  function Button({ variant = 'secondary', size = 'sm', loading, icon, className, children, disabled, ...rest }, ref) {
    const v: Record<Variant, string> = {
      primary: 'brand-gradient text-white shadow-[0_6px_20px_-8px_rgba(255,90,54,.7)] hover:brightness-110 border border-white/10',
      secondary: 'bg-elev text-fg border border-line hover:bg-hover hover:border-line-strong',
      ghost: 'text-muted hover:text-fg hover:bg-hover border border-transparent',
      danger: 'bg-bad/10 text-bad border border-bad/30 hover:bg-bad/20',
      outline: 'border border-line-strong text-fg hover:bg-hover',
      ok: 'bg-ok/15 text-ok border border-ok/30 hover:bg-ok/25',
    };
    const s = { xs: 'h-6 px-2 text-[11px] gap-1 rounded-md', sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg', md: 'h-10 px-4 text-sm gap-2 rounded-xl' }[size];
    return (
      <button ref={ref} disabled={disabled || loading} className={cx('inline-flex shrink-0 items-center justify-center font-medium transition-all select-none disabled:opacity-50 active:scale-[.98] whitespace-nowrap', v[variant], s, className)} {...rest}>
        {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
        {children}
      </button>
    );
  },
);

export function IconButton({ label, className, children, active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button aria-label={label} title={label} className={cx('inline-flex size-8 items-center justify-center rounded-lg transition-colors', active ? 'bg-hover text-fg' : 'text-muted hover:bg-hover hover:text-fg', className)} {...rest}>
      {children}
    </button>
  );
}

type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'bad' | 'info' | 'violet';
export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  const t: Record<Tone, string> = {
    neutral: 'bg-elev text-muted border-line',
    brand: 'bg-brand/10 text-brand border-brand/30',
    ok: 'bg-ok/10 text-ok border-ok/25',
    warn: 'bg-warn/10 text-warn border-warn/25',
    bad: 'bg-bad/10 text-bad border-bad/25',
    info: 'bg-info/10 text-info border-info/25',
    violet: 'bg-violet/10 text-violet border-violet/25',
  };
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-px text-[11px] font-medium', t[tone], className)}>
      {children}
    </span>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx('h-9 w-full rounded-lg border border-line bg-panel px-3 text-[13px] text-fg placeholder:text-faint outline-none transition-colors focus:border-brand/60 focus:ring-2 focus:ring-brand/15', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx('w-full rounded-lg border border-line bg-panel px-3 py-2 text-[13px] text-fg placeholder:text-faint outline-none transition-colors focus:border-brand/60 focus:ring-2 focus:ring-brand/15', className)} {...rest} />;
});

export function Select({ value, onChange, options, className, title }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string; title?: string }) {
  return (
    <select title={title} value={value} onChange={(e) => onChange(e.target.value)} className={cx('h-9 rounded-lg border border-line bg-panel px-2.5 text-[13px] text-fg outline-none focus:border-brand/60', className)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50', checked ? 'border-brand/50 bg-brand' : 'border-line-strong bg-elev')}
    >
      <span className={cx('inline-block size-3.5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-[2px]')} />
    </button>
  );
}

export function Segmented<T extends string>({ value, onChange, options, size = 'sm' }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; title?: string; tone?: string }[]; size?: 'xs' | 'sm' }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-panel p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            'inline-flex items-center gap-1 rounded-md font-medium transition-all',
            size === 'xs' ? 'h-6 px-2 text-[11px]' : 'h-7 px-2.5 text-[12px]',
            value === o.value ? cx('bg-elev text-fg shadow-sm ring-1 ring-line-strong', o.tone) : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, width = 'max-w-lg', icon }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: string; icon?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[8vh] backdrop-blur-sm fade-in" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('w-full rounded-2xl border border-line-strong bg-panel shadow-2xl', width)}>
        <div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5">
          {icon}
          <div className="min-w-0 flex-1 text-[15px] font-semibold">{title}</div>
          <IconButton label="Close" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-elev px-1 font-mono text-[10px] text-muted">{children}</kbd>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-4 animate-spin text-brand', className)} />;
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 flex size-12 items-center justify-center rounded-2xl border border-line bg-elev text-muted">{icon}</div>}
      <div className="text-[15px] font-semibold">{title}</div>
      {children && <div className="mt-1.5 max-w-md text-[13px] text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function StatusDot({ status, className }: { status: string; className?: string }) {
  const c =
    status === 'running' ? 'bg-brand pulse-ring' : status === 'awaiting_input' ? 'bg-warn animate-pulse' : status === 'error' ? 'bg-bad' : status === 'connected' ? 'bg-ok' : status === 'connecting' ? 'bg-warn animate-pulse' : status === 'needs_auth' ? 'bg-warn' : 'bg-faint';
  return <span className={cx('inline-block size-2 shrink-0 rounded-full', c, className)} />;
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; count?: number }[] }) {
  return (
    <div className="flex items-center gap-1 border-b border-line">
      {tabs.map((t) => (
        <button key={t.value} onClick={() => onChange(t.value)} className={cx('relative -mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition-colors', value === t.value ? 'border-brand text-fg' : 'border-transparent text-muted hover:text-fg')}>
          {t.label}
          {t.count !== undefined && t.count > 0 && <span className="rounded-full bg-elev px-1.5 text-[10px] text-muted">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Card({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return (
    <div onClick={onClick} className={cx('rounded-xl border border-line bg-panel', onClick && 'cursor-pointer transition-all hover:border-line-strong hover:bg-elev/60', className)}>
      {children}
    </div>
  );
}

export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cx('h-1 w-full overflow-hidden rounded-full bg-elev', className)}>
      <div className="h-full rounded-full brand-gradient transition-all duration-500" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function ContextRing({ used, total, size = 22 }: { used: number; total: number; size?: number }) {
  const pct = total ? Math.min(1, used / total) : 0;
  const r = size / 2 - 2.5;
  const circ = 2 * Math.PI * r;
  const color = pct > 0.8 ? '#f87171' : pct > 0.6 ? '#fbbf24' : '#ff6b35';
  return (
    <svg width={size} height={size} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-strong)" strokeWidth="2.5" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="2.5" strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)} strokeLinecap="round" className="transition-all duration-500" />
    </svg>
  );
}

/** Dropdown menu anchored to its trigger. */
export function Menu({ trigger, children, align = 'left', width = 'w-56' }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; width?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', on);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', on);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div className={cx('absolute z-40 mt-1 max-h-[60vh] overflow-y-auto rounded-xl border border-line-strong bg-panel p-1 shadow-2xl fade-in', width, align === 'right' ? 'right-0' : 'left-0')}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, onClick, active, icon, hint, danger }: { children: ReactNode; onClick: () => void; active?: boolean; icon?: ReactNode; hint?: ReactNode; danger?: boolean }) {
  return (
    <button onClick={onClick} className={cx('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors', active ? 'bg-hover text-fg' : danger ? 'text-bad hover:bg-bad/10' : 'text-fg/90 hover:bg-hover')}>
      {icon && <span className="text-muted">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-[11px] text-faint">{hint}</span>}
    </button>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">{children}</div>
      {action}
    </div>
  );
}

/** Two panes with a draggable divider. */
export function Split({ left, right, initial = 0.5, min = 0.2, max = 0.8, direction = 'horizontal', storageKey }: { left: ReactNode; right: ReactNode; initial?: number; min?: number; max?: number; direction?: 'horizontal' | 'vertical'; storageKey?: string }) {
  const [ratio, setRatio] = useState(() => {
    const v = storageKey ? Number(localStorage.getItem(`drakox.split.${storageKey}`)) : NaN;
    return Number.isFinite(v) && v > 0 ? v : initial;
  });
  const box = useRef<HTMLDivElement>(null);
  const horiz = direction === 'horizontal';
  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = box.current!.getBoundingClientRect();
    const move = (ev: MouseEvent) => {
      const r = horiz ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      const v = Math.max(min, Math.min(max, r));
      setRatio(v);
      if (storageKey) localStorage.setItem(`drakox.split.${storageKey}`, String(v));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = horiz ? 'col-resize' : 'row-resize';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return (
    <div ref={box} className={cx('flex h-full min-h-0 w-full min-w-0', horiz ? 'flex-row' : 'flex-col')}>
      <div className="min-h-0 min-w-0 overflow-hidden" style={{ flexBasis: `${ratio * 100}%`, flexShrink: 0 }}>
        {left}
      </div>
      <div onMouseDown={onDown} className={cx('group relative shrink-0 bg-line transition-colors hover:bg-brand/60', horiz ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize')}>
        <div className={cx('absolute', horiz ? '-inset-x-1.5 inset-y-0' : '-inset-y-1.5 inset-x-0')} />
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{right}</div>
    </div>
  );
}

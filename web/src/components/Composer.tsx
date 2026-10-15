import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, AtSign, FileText, ImagePlus, Mic, MicOff, Slash, Square, X } from 'lucide-react';
import { toast } from 'sonner';
import { fileToImagePart, get } from '../lib/api';
import { useStore } from '../lib/store';
import type { Mode } from '../lib/types';
import { classNames as cx } from '../lib/format';
import { ModelPicker, ModePicker, MODES } from './Pickers';
import { Kbd } from './ui';

type Img = { type: 'image'; mediaType: string; data: string };

interface Suggestion {
  value: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
}

export interface ComposerProps {
  onSend: (text: string, images: Img[]) => Promise<void> | void;
  onStop?: () => void;
  running?: boolean;
  mode: Mode;
  onModeChange: (m: Mode) => void;
  model: string;
  onModelChange: (m: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  agentId?: string;
  extra?: ReactNode;
  big?: boolean;
  disabled?: boolean;
}

export function Composer(p: ComposerProps) {
  const [text, setText] = useState(() => (p.agentId ? sessionStorage.getItem(`drakox.draft.${p.agentId}`) ?? '' : ''));
  const [images, setImages] = useState<Img[]>([]);
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [sel, setSel] = useState(0);
  const [trigger, setTrigger] = useState<{ kind: '/' | '@'; start: number; query: string } | null>(null);
  const [listening, setListening] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const recog = useRef<any>(null);
  const commands = useStore((s) => s.commands);

  useEffect(() => {
    if (p.agentId) sessionStorage.setItem(`drakox.draft.${p.agentId}`, text);
  }, [text, p.agentId]);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, p.big ? 320 : 260)}px`;
  }, [text, p.big]);

  useEffect(() => {
    if (p.autoFocus) ta.current?.focus();
  }, [p.autoFocus, p.agentId]);

  // detect "/" and "@" triggers at the cursor
  const updateTrigger = (value: string, cursor: number) => {
    const before = value.slice(0, cursor);
    const slash = /^\/([\w:.-]*)$/.exec(before);
    if (slash) return setTrigger({ kind: '/', start: 0, query: slash[1]! });
    const at = /(^|\s)@([^\s]*)$/.exec(before);
    if (at) return setTrigger({ kind: '@', start: cursor - at[2]!.length - 1, query: at[2]! });
    setTrigger(null);
  };

  useEffect(() => {
    if (!trigger) {
      setSugs([]);
      return;
    }
    if (trigger.kind === '/') {
      const q = trigger.query.toLowerCase();
      const list = commands
        .filter((c) => c.name.toLowerCase().startsWith(q) || c.aliases?.some((a) => a.startsWith(q)) || (q.length > 1 && c.name.toLowerCase().includes(q)))
        .slice(0, 12)
        .map((c) => ({ value: `/${c.name} `, label: `/${c.name}${c.args ? ' ' + c.args : ''}`, hint: c.description, icon: <Slash className="size-3.5" /> }));
      setSugs(list);
      setSel(0);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const files = await get<string[]>(`/api/files/search?q=${encodeURIComponent(trigger.query)}&limit=12${p.agentId ? `&agent=${encodeURIComponent(p.agentId)}` : ''}`, ctrl.signal);
        setSugs(files.map((f) => ({ value: `@${f} `, label: f, icon: <FileText className="size-3.5" /> })));
        setSel(0);
      } catch {
        /* aborted */
      }
    }, 90);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [trigger, commands, p.agentId]);

  const applySuggestion = (s: Suggestion) => {
    if (!trigger) return;
    const cursor = ta.current?.selectionStart ?? text.length;
    const next = text.slice(0, trigger.start) + s.value + text.slice(cursor);
    setText(next);
    setTrigger(null);
    requestAnimationFrame(() => {
      const pos = trigger.start + s.value.length;
      ta.current?.setSelectionRange(pos, pos);
      ta.current?.focus();
    });
  };

  const send = async () => {
    const t = text.trim();
    if ((!t && !images.length) || p.disabled) return;
    try {
      await p.onSend(t, images);
      setText('');
      setImages([]);
      setTrigger(null);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (sugs.length && trigger) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSel((s) => (s + 1) % sugs.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((s) => (s - 1 + sugs.length) % sugs.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        applySuggestion(sugs[sel]!);
        return;
      }
      if (e.key === 'Escape') {
        setTrigger(null);
        return;
      }
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      p.onModeChange(MODES[(MODES.indexOf(p.mode) + 1) % MODES.length]!);
      return;
    }
    if (e.key === 'Escape' && p.running) {
      p.onStop?.();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const addFiles = async (files: FileList | File[]) => {
    const imgs = [...files].filter((f) => f.type.startsWith('image/'));
    for (const f of imgs) {
      if (f.size > 8 * 1024 * 1024) {
        toast.error(`${f.name} is larger than 8 MB`);
        continue;
      }
      const part = await fileToImagePart(f);
      setImages((cur) => [...cur, part]);
    }
  };

  const toggleVoice = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      toast.error('Voice input is not supported in this browser (try Chrome, Edge or Safari).');
      return;
    }
    if (listening) {
      recog.current?.stop();
      return;
    }
    const r = new SR();
    r.continuous = true;
    r.interimResults = false;
    r.lang = navigator.language || 'en-US';
    r.onresult = (ev: any) => {
      let chunk = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) if (ev.results[i].isFinal) chunk += ev.results[i][0].transcript;
      if (chunk) setText((t) => (t ? `${t.trimEnd()} ${chunk.trim()}` : chunk.trim()));
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    recog.current = r;
    r.start();
    setListening(true);
  };

  const canSend = (text.trim().length > 0 || images.length > 0) && !p.disabled;
  const sugBox = useMemo(
    () =>
      sugs.length > 0 && trigger ? (
        <div className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-72 overflow-y-auto rounded-xl border border-line-strong bg-panel p-1 shadow-2xl fade-in">
          <div className="px-2.5 pb-1 pt-1 text-[10.5px] font-semibold uppercase tracking-wider text-faint">{trigger.kind === '/' ? 'Commands' : 'Files'}</div>
          {sugs.map((s, i) => (
            <button
              key={s.value + i}
              onMouseDown={(e) => {
                e.preventDefault();
                applySuggestion(s);
              }}
              onMouseEnter={() => setSel(i)}
              className={cx('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left', i === sel ? 'bg-hover' : '')}
            >
              <span className="text-muted">{s.icon}</span>
              <span className={cx('shrink-0 text-[13px]', trigger.kind === '/' ? 'font-mono text-brand' : 'font-mono text-fg/90')}>{s.label}</span>
              {s.hint && <span className="min-w-0 flex-1 truncate text-[12px] text-faint">{s.hint}</span>}
            </button>
          ))}
        </div>
      ) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sugs, sel, trigger],
  );

  return (
    <div
      className={cx('relative rounded-2xl border bg-panel shadow-[0_8px_30px_-12px_rgba(0,0,0,.5)] transition-colors', dragOver ? 'border-brand/60' : 'border-line-strong focus-within:border-brand/40')}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
      }}
    >
      {sugBox}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {images.map((im, i) => (
            <div key={i} className="group relative">
              <img src={`data:${im.mediaType};base64,${im.data}`} className="h-14 w-14 rounded-lg border border-line object-cover" alt="" />
              <button onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))} className="absolute -right-1.5 -top-1.5 hidden size-5 items-center justify-center rounded-full border border-line bg-panel text-muted group-hover:flex hover:text-fg">
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        value={text}
        rows={p.big ? 3 : 1}
        disabled={p.disabled}
        placeholder={p.placeholder ?? 'Ask DrakoX to build, fix or explain anything…  (@ files · / commands)'}
        onChange={(e) => {
          setText(e.target.value);
          updateTrigger(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onClick={(e) => updateTrigger(text, (e.target as HTMLTextAreaElement).selectionStart)}
        onPaste={(e) => {
          const files = [...e.clipboardData.items].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean) as File[];
          if (files.length) {
            e.preventDefault();
            void addFiles(files);
          }
        }}
        className={cx('block w-full resize-none bg-transparent px-4 text-fg placeholder:text-faint outline-none', p.big ? 'pt-4 text-[15px] leading-relaxed' : 'pt-3 text-[14px] leading-relaxed')}
      />
      <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-1.5">
        <ModePicker value={p.mode} onChange={p.onModeChange} />
        <ModelPicker value={p.model} onChange={p.onModelChange} />
        {p.extra}
        <div className="flex-1" />
        <label title="Attach image" className="inline-flex size-7 cursor-pointer items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg">
          <ImagePlus className="size-4" />
          <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => e.target.files && void addFiles(e.target.files)} />
        </label>
        <button
          title="Mention a file (@)"
          onClick={() => {
            setText((t) => (t && !t.endsWith(' ') ? `${t} @` : `${t}@`));
            setTimeout(() => {
              ta.current?.focus();
              const v = ta.current?.value ?? '';
              updateTrigger(v, v.length);
            }, 0);
          }}
          className="inline-flex size-7 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
        >
          <AtSign className="size-4" />
        </button>
        <button title={listening ? 'Stop dictation' : 'Dictate (voice)'} onClick={toggleVoice} className={cx('inline-flex size-7 items-center justify-center rounded-lg hover:bg-hover', listening ? 'text-bad' : 'text-muted hover:text-fg')}>
          {listening ? <MicOff className="size-4 animate-pulse" /> : <Mic className="size-4" />}
        </button>
        {p.running ? (
          <button onClick={p.onStop} title="Stop (Esc)" className="ml-1 inline-flex size-8 items-center justify-center rounded-xl bg-fg text-bg transition-transform active:scale-95">
            <Square className="size-3.5 fill-current" />
          </button>
        ) : (
          <button onClick={() => void send()} disabled={!canSend} title="Send (Enter)" className={cx('ml-1 inline-flex size-8 items-center justify-center rounded-xl transition-all active:scale-95', canSend ? 'brand-gradient text-white shadow-[0_4px_16px_-4px_rgba(255,90,54,.7)]' : 'bg-elev text-faint')}>
            <ArrowUp className="size-4" strokeWidth={2.5} />
          </button>
        )}
      </div>
      {p.big && (
        <div className="pointer-events-none absolute -bottom-6 right-2 hidden items-center gap-1.5 text-[11px] text-faint md:flex">
          <Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Tab</Kbd> mode · <Kbd>@</Kbd> files · <Kbd>/</Kbd> commands
        </div>
      )}
    </div>
  );
}

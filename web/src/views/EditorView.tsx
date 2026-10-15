import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { DiffEditor, type OnMount } from '@monaco-editor/react';
import { ChevronDown, ChevronRight, Diff, File, FileCode2, Folder, FolderOpen, RefreshCw, Save, Search, Sparkles, Wand2, X } from 'lucide-react';
import { toast } from 'sonner';
import { get, post, put } from '../lib/api';
import { completionState, monaco, registerInlineCompletions } from '../lib/monaco';
import { useStore } from '../lib/store';
import { navigate } from '../lib/route';
import type { AgentItem, FileEntry } from '../lib/types';
import { Button, IconButton, Kbd, Modal, Split, Textarea, Toggle } from '../components/ui';
import { TerminalPanel } from '../components/Terminal';
import { basename, classNames as cx, languageFor } from '../lib/format';

interface OpenFile {
  path: string;
  content: string;
  saved: string;
  head: string | null;
  kind: 'text' | 'image' | 'binary' | 'too_large';
  image?: string;
}

export default function EditorView({ file }: { file?: string }) {
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [diff, setDiff] = useState(false);
  const [tab, setTab] = useState(completionState.enabled);
  const [askOpen, setAskOpen] = useState(false);
  const [selection, setSelection] = useState<{ start: number; end: number; text: string } | null>(null);
  const theme = useStore((s) => s.theme);
  const info = useStore((s) => s.info);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => registerInlineCompletions(), []);

  const open = useCallback(async (path: string) => {
    setActive(path);
    if (files.some((f) => f.path === path)) return;
    try {
      const r = await get<any>(`/api/file?path=${encodeURIComponent(path)}`);
      const f: OpenFile = { path, content: r.content ?? '', saved: r.content ?? '', head: r.head ?? null, kind: r.kind, image: r.kind === 'image' ? `data:${r.mediaType};base64,${r.data}` : undefined };
      setFiles((cur) => (cur.some((x) => x.path === path) ? cur : [...cur, f]));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [files]);

  useEffect(() => {
    if (file) void open(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // reload open (unmodified) files when an agent changes them
  const lastChange = useStore((s) => {
    let latest = '';
    for (const a of Object.values(s.agents)) {
      for (let i = a.events.length - 1; i >= 0; i--) {
        const e = a.events[i]!;
        if (e.type === 'file_change') {
          if (`${e.ts}:${e.path}` > latest) latest = `${e.ts}:${e.path}`;
          break;
        }
      }
    }
    return latest;
  });
  useEffect(() => {
    if (!lastChange || !info) return;
    const abs = lastChange.slice(lastChange.indexOf(':') + 1);
    const rel = abs.startsWith(info.projectRoot + '/') ? abs.slice(info.projectRoot.length + 1) : null;
    const f = rel ? files.find((x) => x.path === rel) : undefined;
    if (!f || f.content !== f.saved) return;
    get<any>(`/api/file?path=${encodeURIComponent(f.path)}`)
      .then((r) => setFiles((cur) => cur.map((x) => (x.path === f.path ? { ...x, content: r.content ?? '', saved: r.content ?? '', head: r.head ?? null } : x))))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastChange]);

  const cur = files.find((f) => f.path === active);
  completionState.path = cur?.path ?? '';

  const save = useCallback(async () => {
    if (!cur || cur.kind !== 'text') return;
    try {
      await put('/api/file', { path: cur.path, content: cur.content });
      setFiles((fs) => fs.map((f) => (f.path === cur.path ? { ...f, saved: f.content } : f)));
      toast.success(`Saved ${basename(cur.path)}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [cur]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [save]);

  const close = (path: string) => {
    const f = files.find((x) => x.path === path);
    if (f && f.content !== f.saved && !confirm(`Discard unsaved changes to ${basename(path)}?`)) return;
    const rest = files.filter((x) => x.path !== path);
    setFiles(rest);
    if (active === path) setActive(rest[rest.length - 1]?.path ?? null);
  };

  const onMount: OnMount = (ed) => {
    editorRef.current = ed;
    ed.addAction({
      id: 'drakox.ask',
      label: 'DrakoX: Edit with instructions',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
      run: (e) => {
        const sel = e.getSelection();
        const model = e.getModel();
        if (sel && model) setSelection({ start: sel.startLineNumber, end: sel.endLineNumber, text: model.getValueInRange(sel) });
        setAskOpen(true);
      },
    });
  };

  return (
    <div className="flex h-full">
      <Split
        storageKey="editor-tree"
        initial={0.2}
        min={0.12}
        max={0.4}
        left={<FileTree onOpen={open} active={active} />}
        right={
          <Split
            direction="vertical"
            storageKey="editor-term"
            initial={0.72}
            min={0.3}
            max={0.92}
            left={
              <div className="flex h-full flex-col">
                <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-panel/60">
                  <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
                    {files.map((f) => (
                      <div key={f.path} onClick={() => setActive(f.path)} className={cx('group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-line px-3 text-[12.5px]', f.path === active ? 'bg-bg text-fg' : 'text-muted hover:text-fg')}>
                        <FileCode2 className="size-3.5 text-faint" />
                        <span className="max-w-[180px] truncate">{basename(f.path)}</span>
                        {f.content !== f.saved ? (
                          <span className="size-1.5 rounded-full bg-brand" />
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              close(f.path);
                            }}
                            className="invisible rounded p-0.5 hover:bg-hover group-hover:visible"
                          >
                            <X className="size-3" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  {cur?.kind === 'text' && (
                    <div className="flex shrink-0 items-center gap-1.5 px-2">
                      <label className="flex items-center gap-1.5 text-[11.5px] text-muted" title="AI Tab completion (ghost text)">
                        <Sparkles className="size-3.5 text-brand" /> Tab
                        <Toggle
                          checked={tab}
                          onChange={(v) => {
                            setTab(v);
                            completionState.enabled = v;
                            localStorage.setItem('drakox.tab', v ? '1' : '0');
                          }}
                        />
                      </label>
                      <IconButton label="Diff vs HEAD" active={diff} onClick={() => setDiff((d) => !d)} disabled={cur.head === null}>
                        <Diff className="size-4" />
                      </IconButton>
                      <IconButton label="Edit with DrakoX (Ctrl/Cmd+K)" onClick={() => setAskOpen(true)}>
                        <Wand2 className="size-4" />
                      </IconButton>
                      <IconButton label="Save (Ctrl/Cmd+S)" onClick={save} disabled={cur.content === cur.saved}>
                        <Save className="size-4" />
                      </IconButton>
                    </div>
                  )}
                </div>
                <div className="min-h-0 flex-1">
                  {!cur ? (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[13px] text-muted">
                      <FileCode2 className="size-8 text-faint" />
                      <div>Open a file from the explorer</div>
                      <div className="text-[12px] text-faint">
                        <Kbd>Tab</Kbd> accepts AI completions · <Kbd>Ctrl</Kbd>+<Kbd>K</Kbd> edit with DrakoX · <Kbd>Ctrl</Kbd>+<Kbd>S</Kbd> save
                      </div>
                    </div>
                  ) : cur.kind === 'image' ? (
                    <div className="flex h-full items-center justify-center p-6">
                      <img src={cur.image} className="max-h-full max-w-full rounded-lg border border-line" alt={cur.path} />
                    </div>
                  ) : cur.kind !== 'text' ? (
                    <div className="flex h-full items-center justify-center text-[13px] text-muted">{cur.kind === 'binary' ? 'Binary file' : 'File too large to edit here'}</div>
                  ) : diff && cur.head !== null ? (
                    <DiffEditor
                      original={cur.head}
                      modified={cur.content}
                      language={languageFor(cur.path)}
                      theme={dark ? 'drakox-dark' : 'drakox-light'}
                      options={{ renderSideBySide: true, fontSize: 13, fontFamily: 'JetBrains Mono Variable, monospace', minimap: { enabled: false }, readOnly: true }}
                    />
                  ) : (
                    <Editor
                      path={cur.path}
                      value={cur.content}
                      language={languageFor(cur.path)}
                      theme={dark ? 'drakox-dark' : 'drakox-light'}
                      onMount={onMount}
                      onChange={(v) => setFiles((fs) => fs.map((f) => (f.path === cur.path ? { ...f, content: v ?? '' } : f)))}
                      options={{
                        fontSize: 13,
                        fontFamily: 'JetBrains Mono Variable, monospace',
                        fontLigatures: true,
                        minimap: { enabled: true, scale: 1 },
                        smoothScrolling: true,
                        cursorBlinking: 'smooth',
                        cursorSmoothCaretAnimation: 'on',
                        inlineSuggest: { enabled: true },
                        scrollBeyondLastLine: false,
                        padding: { top: 10 },
                        bracketPairColorization: { enabled: true },
                        renderLineHighlight: 'all',
                      }}
                    />
                  )}
                </div>
              </div>
            }
            right={<TerminalPanel />}
          />
        }
      />
      <AskModal open={askOpen} onClose={() => setAskOpen(false)} file={cur?.path} selection={selection} />
    </div>
  );
}

function AskModal({ open, onClose, file, selection }: { open: boolean; onClose: () => void; file?: string; selection: { start: number; end: number; text: string } | null }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const info = useStore((s) => s.info);
  const go = async () => {
    if (!text.trim()) return;
    setBusy(true);
    const where = file ? `In @${file}${selection && selection.text ? ` (lines ${selection.start}-${selection.end})` : ''}: ` : '';
    try {
      const a = await post<AgentItem>('/api/agents', { prompt: `${where}${text.trim()}\n\nMake the change directly, keep it minimal, and summarise what you changed.`, mode: 'auto-edit', model: localStorage.getItem('drakox.model') || info?.defaultModel });
      toast.success('DrakoX is on it', { action: { label: 'Watch', onClick: () => navigate(`#/agent/${encodeURIComponent(a.id)}`) } });
      setText('');
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Edit with DrakoX" icon={<Wand2 className="size-4 text-brand" />} footer={<Button variant="primary" loading={busy} disabled={!text.trim()} onClick={go}>Apply</Button>}>
      <div className="mb-2 text-[12.5px] text-muted">
        {file ? (
          <>
            {file}
            {selection?.text ? ` · lines ${selection.start}–${selection.end}` : ''}
          </>
        ) : (
          'No file selected — the instruction applies to the project.'
        )}
      </div>
      <Textarea autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && go()} placeholder="e.g. add input validation and handle the empty case" />
      <div className="mt-2 text-[11.5px] text-faint">Runs a new agent in auto-edit mode; the editor refreshes when the file changes.</div>
    </Modal>
  );
}

function FileTree({ onOpen, active }: { onOpen: (p: string) => void; active: string | null }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<string[] | null>(null);
  const [nonce, setNonce] = useState(0);
  const info = useStore((s) => s.info);
  useEffect(() => {
    if (!q.trim()) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => get<string[]>(`/api/files/search?q=${encodeURIComponent(q)}&limit=60`).then(setResults).catch(() => undefined), 100);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="flex h-full flex-col bg-panel/40">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-faint">{info?.projectName ?? 'Explorer'}</span>
        <button onClick={() => setNonce((n) => n + 1)} title="Refresh" className="rounded p-1 text-faint hover:bg-hover hover:text-fg">
          <RefreshCw className="size-3.5" />
        </button>
      </div>
      <div className="relative px-2 py-2">
        <Search className="absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Go to file…" className="h-7 w-full rounded-md border border-line bg-bg pl-7 pr-2 text-[12px] outline-none focus:border-brand/50" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-4">
        {results ? (
          results.map((r) => (
            <button key={r} onClick={() => onOpen(r)} className={cx('flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12px]', active === r ? 'bg-hover text-fg' : 'text-fg/80 hover:bg-hover')}>
              <File className="size-3.5 shrink-0 text-faint" />
              <span className="truncate">{basename(r)}</span>
              <span className="truncate text-[10.5px] text-faint">{r.split('/').slice(0, -1).join('/')}</span>
            </button>
          ))
        ) : (
          <Dir key={nonce} path="" depth={0} onOpen={onOpen} active={active} initiallyOpen />
        )}
      </div>
    </div>
  );
}

function Dir({ path, depth, onOpen, active, initiallyOpen }: { path: string; depth: number; onOpen: (p: string) => void; active: string | null; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(initiallyOpen));
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  useEffect(() => {
    if (open && !entries) get<FileEntry[]>(`/api/files?dir=${encodeURIComponent(path)}`).then(setEntries).catch(() => setEntries([]));
  }, [open, entries, path]);
  const children = useMemo(() => entries ?? [], [entries]);
  if (depth === 0)
    return (
      <div>
        {children.map((e) => (
          <Entry key={e.path} e={e} depth={0} onOpen={onOpen} active={active} />
        ))}
      </div>
    );
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1 rounded px-1 py-[3px] text-left text-[12.5px] text-fg/85 hover:bg-hover" style={{ paddingLeft: depth * 12 }}>
        {open ? <ChevronDown className="size-3 shrink-0 text-faint" /> : <ChevronRight className="size-3 shrink-0 text-faint" />}
        {open ? <FolderOpen className="size-3.5 shrink-0 text-brand/80" /> : <Folder className="size-3.5 shrink-0 text-brand/80" />}
        <span className="truncate">{basename(path)}</span>
      </button>
      {open && children.map((e) => <Entry key={e.path} e={e} depth={depth} onOpen={onOpen} active={active} />)}
    </div>
  );
}

function Entry({ e, depth, onOpen, active }: { e: FileEntry; depth: number; onOpen: (p: string) => void; active: string | null }) {
  if (e.type === 'dir') return <div className={e.ignored ? 'opacity-50' : ''}><Dir path={e.path} depth={depth + 1} onOpen={onOpen} active={active} /></div>;
  return (
    <button onClick={() => onOpen(e.path)} className={cx('flex w-full items-center gap-1.5 rounded py-[3px] pr-1 text-left text-[12.5px]', active === e.path ? 'bg-brand/10 text-fg' : 'text-fg/80 hover:bg-hover', e.ignored && 'opacity-50')} style={{ paddingLeft: (depth + 1) * 12 + 14 }}>
      <File className="size-3.5 shrink-0 text-faint" />
      <span className="truncate">{e.name}</span>
    </button>
  );
}

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, paths } from './paths.js';
import type { AgentEvent, ChatMessage, ContentPart, Mode, Todo, ToolCall, UsageTotals, WorktreeInfo } from './types.js';
import { isPersistent } from './types.js';
import { readJson, sha256, writeJson } from './util.js';

/**
 * Session persistence: an append-only JSONL event log per session (crash-safe, replayable,
 * auditable — every model call, tool run, approval and edit) plus a content-addressed blob
 * store holding file snapshots for checkpoints/rewind.
 */

export interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
  projectRoot: string;
  model: string;
  mode: Mode;
  createdAt: number;
  updatedAt: number;
  parentId?: string;
  worktree?: WorktreeInfo;
  turns: number;
  costUsd: number;
  tokens: number;
  lastMessage?: string;
  archived?: boolean;
}

export function emptyTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, costPartial: false, requests: 0 };
}

export class SessionStore {
  constructor(readonly root: string = paths.sessions()) {}

  dir(id: string): string {
    return path.join(this.root, id);
  }

  create(meta: SessionMeta): void {
    ensureDir(path.join(this.dir(meta.id), 'blobs'));
    this.saveMeta(meta);
  }

  exists(id: string): boolean {
    return fs.existsSync(path.join(this.dir(id), 'meta.json'));
  }

  saveMeta(meta: SessionMeta): void {
    writeJson(path.join(this.dir(meta.id), 'meta.json'), meta);
  }

  meta(id: string): SessionMeta | undefined {
    return readJson<SessionMeta | undefined>(path.join(this.dir(id), 'meta.json'), undefined);
  }

  /** Durable append: synchronous write so the log survives crashes in order. */
  append(id: string, event: AgentEvent): void {
    if (!isPersistent(event)) return;
    fs.appendFileSync(path.join(this.dir(id), 'events.jsonl'), JSON.stringify(event) + '\n');
  }

  events(id: string): AgentEvent[] {
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(this.dir(id), 'events.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const out: AgentEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // a torn final line from a crash is skipped; everything before it is intact
      }
    }
    return out;
  }

  list(filter: { projectRoot?: string; includeChildren?: boolean } = {}): SessionMeta[] {
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(this.root);
    } catch {
      return [];
    }
    const metas = ids.map((id) => this.meta(id)).filter((m): m is SessionMeta => Boolean(m));
    return metas
      .filter((m) => (filter.projectRoot ? m.projectRoot === filter.projectRoot : true))
      .filter((m) => (filter.includeChildren ? true : !m.parentId))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  delete(id: string): void {
    fs.rmSync(this.dir(id), { recursive: true, force: true });
  }

  putBlob(id: string, content: string): string {
    const hash = sha256(content);
    const file = path.join(this.dir(id), 'blobs', hash);
    if (!fs.existsSync(file)) {
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, content);
    }
    return hash;
  }

  getBlob(id: string, hash: string): string | null {
    try {
      return fs.readFileSync(path.join(this.dir(id), 'blobs', hash), 'utf8');
    } catch {
      return null;
    }
  }
}

// ───────────────────────────── replay ─────────────────────────────

export interface ReplayState {
  messages: ChatMessage[];
  todos: Todo[];
  totals: UsageTotals;
  mode?: Mode;
  model?: string;
  title?: string;
  turn: number;
  /** turn → index in `messages` where that turn's user message starts */
  turnStarts: Map<number, number>;
  /** tool calls that never got a result (crash / kill mid-tool) */
  interrupted: ToolCall[];
  contextTokens: number;
}

export function replay(events: AgentEvent[]): ReplayState {
  let messages: ChatMessage[] = [];
  let turnStarts = new Map<number, number>();
  let todos: Todo[] = [];
  let totals = emptyTotals();
  let mode: Mode | undefined;
  let model: string | undefined;
  let title: string | undefined;
  let turn = 0;
  let contextTokens = 0;
  const pending = new Map<string, ToolCall>();

  for (const e of events) {
    switch (e.type) {
      case 'session_start':
        mode = e.mode;
        model = e.model;
        title = e.title ?? title;
        break;
      case 'user_message': {
        // close dangling tool calls before a new user message to keep the transcript valid
        repairPending(messages, pending);
        turnStarts.set(e.turn, messages.length);
        turn = e.turn;
        const content: string | ContentPart[] = e.images?.length ? [{ type: 'text', text: e.content }, ...e.images] : e.content;
        messages.push({ role: 'user', content });
        break;
      }
      case 'assistant_message':
        messages.push({ role: 'assistant', content: e.content, reasoning: e.reasoning, toolCalls: e.toolCalls, providerMeta: e.providerMeta });
        for (const tc of e.toolCalls ?? []) pending.set(tc.id, tc);
        break;
      case 'tool_result':
        messages.push({ role: 'tool', toolCallId: e.id, name: e.name, content: e.content, isError: e.isError });
        pending.delete(e.id);
        break;
      case 'todos':
        todos = e.todos;
        break;
      case 'usage':
        totals = e.totals;
        contextTokens = e.contextTokens;
        break;
      case 'mode_change':
        mode = e.mode;
        break;
      case 'model_change':
        model = e.model;
        break;
      case 'title':
        title = e.title;
        break;
      case 'compaction': {
        repairPending(messages, pending);
        const kept = e.keptMessages > 0 ? messages.slice(-e.keptMessages) : [];
        const dropped = messages.length - kept.length;
        messages = [{ role: 'user', content: compactionMessage(e.summary) }, { role: 'assistant', content: 'Understood. I have the context from the summary and will continue from there.' }, ...kept];
        const shifted = new Map<number, number>();
        for (const [t, idx] of turnStarts) if (idx >= dropped) shifted.set(t, idx - dropped + 2);
        turnStarts = shifted;
        contextTokens = 0;
        break;
      }
      case 'rewind': {
        if (e.conversation === false) break;
        const idx = turnStarts.get(e.toTurn);
        if (idx !== undefined) {
          messages = messages.slice(0, idx);
          for (const t of [...turnStarts.keys()]) if (t >= e.toTurn) turnStarts.delete(t);
        }
        pending.clear();
        turn = e.toTurn - 1;
        todos = [];
        break;
      }
    }
  }
  const interrupted = [...pending.values()];
  repairPending(messages, pending);
  return { messages, todos, totals, mode, model, title, turn, turnStarts, interrupted, contextTokens };
}

/** Give every unanswered tool call a synthetic result (restart-safe transcripts). */
function repairPending(messages: ChatMessage[], pending: Map<string, ToolCall>): void {
  for (const tc of pending.values()) {
    messages.push({
      role: 'tool',
      toolCallId: tc.id,
      name: tc.name,
      content: 'Interrupted: this tool call did not complete (the session was stopped or crashed). Check the current state before retrying.',
      isError: true,
    });
  }
  pending.clear();
}

export function compactionMessage(summary: string): string {
  return `<conversation_summary>\nThe earlier part of this session was compacted to save context. Summary:\n\n${summary}\n</conversation_summary>`;
}

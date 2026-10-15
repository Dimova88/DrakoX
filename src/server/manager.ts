import { EventEmitter } from 'node:events';
import type { Runtime } from '../core/runtime.js';
import { Agent, type AgentSnapshot } from '../core/agent.js';
import type { AgentEvent, ImagePart, Mode, WorktreeInfo } from '../core/types.js';
import { applyWorktree, commitWorktree, createWorktree, gitRoot, removeWorktree, worktreeDiff, worktreeStats } from '../core/git.js';
import { uid } from '../core/util.js';

export interface AgentListItem extends AgentSnapshot {
  live: boolean;
  group?: string;
  lastMessage?: string;
  worktreeStats?: { files: number; added: number; removed: number };
}

/**
 * Mission Control: many agents in one workspace, each optionally isolated in its own git worktree
 * (parallel agents / best-of-N), all streaming to every connected UI.
 */
export class AgentManager extends EventEmitter {
  private live = new Map<string, Agent>();
  private groups = new Map<string, string>();
  private snapshotTimers = new Map<string, NodeJS.Timeout>();
  private statsCache = new Map<string, { at: number; stats?: { files: number; added: number; removed: number } }>();

  constructor(readonly runtime: Runtime) {
    super();
    this.setMaxListeners(200);
  }

  private attach(agent: Agent): Agent {
    this.live.set(agent.id, agent);
    agent.on('event', (event: AgentEvent) => {
      this.emit('event', { agentId: agent.id, event });
      if (['status', 'usage', 'title', 'mode_change', 'model_change', 'todos', 'turn_end', 'approval_request', 'approval_response', 'file_change', 'rewind', 'plan', 'question', 'answer'].includes(event.type) || event.type === 'subagent') {
        this.scheduleSnapshot(agent);
      }
    });
    this.scheduleSnapshot(agent);
    return agent;
  }

  private scheduleSnapshot(agent: Agent): void {
    if (this.snapshotTimers.has(agent.id)) return;
    this.snapshotTimers.set(
      agent.id,
      setTimeout(() => {
        this.snapshotTimers.delete(agent.id);
        this.emit('agent', this.item(agent));
      }, 150),
    );
  }

  item(agent: Agent): AgentListItem {
    const snap = agent.snapshot();
    return {
      ...snap,
      live: true,
      group: this.groups.get(agent.id),
      lastMessage: agent.lastAssistantText().slice(0, 240) || undefined,
      worktreeStats: agent.worktree ? this.stats(agent) : undefined,
    };
  }

  /** Worktree stats touch the git index, so only refresh while the agent is idle (and at most every 3s). */
  private stats(agent: Agent): { files: number; added: number; removed: number } | undefined {
    const hit = this.statsCache.get(agent.id);
    if (hit && (agent.isRunning() || Date.now() - hit.at < 3000)) return hit.stats;
    if (agent.isRunning()) return undefined;
    const stats = safeStats(agent.worktree!);
    this.statsCache.set(agent.id, { at: Date.now(), stats });
    return stats;
  }

  /** Live agents + persisted sessions for this project. */
  list(): AgentListItem[] {
    const out: AgentListItem[] = [...this.live.values()].map((a) => this.item(a));
    const liveIds = new Set(out.map((a) => a.id));
    for (const m of this.runtime.store.list({ projectRoot: this.runtime.projectRoot }).slice(0, 100)) {
      if (liveIds.has(m.id)) continue;
      out.push({
        id: m.id,
        title: m.title,
        cwd: m.cwd,
        projectRoot: m.projectRoot,
        model: m.model,
        mode: m.mode,
        status: 'idle',
        turn: m.turns,
        todos: [],
        totals: { inputTokens: 0, outputTokens: m.tokens, cachedInputTokens: 0, costUsd: m.costUsd, costPartial: false, requests: 0 },
        contextTokens: 0,
        contextWindow: 0,
        worktree: m.worktree,
        pendingApprovals: 0,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        filesChanged: [],
        live: false,
        lastMessage: m.lastMessage,
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Get a live agent, loading it from disk if needed. */
  async get(id: string): Promise<Agent> {
    const hit = this.live.get(id);
    if (hit) return hit;
    if (!this.runtime.store.exists(id)) throw Object.assign(new Error(`Agent ${id} not found`), { status: 404 });
    return this.attach(await Agent.resume(this.runtime, id));
  }

  peek(id: string): Agent | undefined {
    return this.live.get(id);
  }

  async create(opts: { model?: string; mode?: Mode; title?: string; isolation?: 'none' | 'worktree'; group?: string }): Promise<Agent> {
    let worktree: WorktreeInfo | undefined;
    let cwd = this.runtime.cwd;
    if (opts.isolation === 'worktree') {
      const root = gitRoot(this.runtime.cwd);
      if (!root) throw Object.assign(new Error('Worktree isolation needs a git repository with at least one commit.'), { status: 400 });
      worktree = createWorktree(root, uid('').slice(-10));
      cwd = worktree.path;
    }
    const agent = await Agent.create({ runtime: this.runtime, cwd, model: opts.model || undefined, mode: opts.mode, title: opts.title, worktree });
    if (opts.group) this.groups.set(agent.id, opts.group);
    this.attach(agent);
    this.emit('agent', this.item(agent));
    return agent;
  }

  /** Start a turn without waiting for it to finish (progress streams over WebSocket). */
  send(agent: Agent, text: string, opts: { images?: ImagePart[]; displayText?: string } = {}): void {
    agent.send(text, opts).catch((err) => {
      this.emit('event', { agentId: agent.id, event: { type: 'error', message: (err as Error).message, ts: Date.now() } satisfies AgentEvent });
    });
  }

  async remove(id: string, opts: { deleteSession?: boolean } = {}): Promise<void> {
    const agent = this.live.get(id);
    const meta = this.runtime.store.meta(id);
    if (agent) {
      agent.abort();
      await agent.idle();
      agent.removeAllListeners('event');
      this.live.delete(id);
    }
    const wt = agent?.worktree ?? meta?.worktree;
    if (wt && opts.deleteSession) {
      try {
        removeWorktree(wt);
      } catch {
        /* ignore */
      }
    }
    if (opts.deleteSession) this.runtime.store.delete(id);
    this.groups.delete(id);
    this.emit('removed', id);
  }

  worktreeDiff(agent: Agent): string {
    if (!agent.worktree) throw Object.assign(new Error('This agent is not isolated in a worktree'), { status: 400 });
    return worktreeDiff(agent.worktree);
  }

  /** Bring an isolated agent's work into the main working tree. */
  applyWorktree(agent: Agent): { ok: boolean; message: string } {
    if (!agent.worktree) throw Object.assign(new Error('This agent is not isolated in a worktree'), { status: 400 });
    const r = applyWorktree(agent.worktree);
    this.emit('agent', this.item(agent));
    return r;
  }

  commitWorktree(agent: Agent, message: string): { ok: boolean; message: string } {
    if (!agent.worktree) throw Object.assign(new Error('This agent is not isolated in a worktree'), { status: 400 });
    return commitWorktree(agent.worktree, message);
  }

  async dispose(): Promise<void> {
    for (const a of this.live.values()) a.abort();
    await Promise.all([...this.live.values()].map((a) => a.idle()));
  }
}

function safeStats(wt: WorktreeInfo): { files: number; added: number; removed: number } | undefined {
  try {
    return worktreeStats(wt);
  } catch {
    return undefined;
  }
}

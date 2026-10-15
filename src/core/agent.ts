import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type {
  AgentEvent,
  ApprovalDecision,
  ChatMessage,
  ImagePart,
  Mode,
  SessionStatus,
  Todo,
  ToolCall,
  TurnEndReason,
  Usage,
  UsageTotals,
  WorktreeInfo,
} from './types.js';
import type { Runtime } from './runtime.js';
import { SessionStore, compactionMessage, emptyTotals, replay, type SessionMeta } from './session.js';
import { BUILTIN_TOOLS, applyEdit, webSearchAvailable, type PlanDecision, type SubagentRequest, type Tool, type ToolContext, type ToolResult } from './tools/index.js';
import { describeArgs, evaluatePermission } from './permissions.js';
import { buildSystemPrompt } from './prompts.js';
import { contextWindowFor, costFor } from './models.js';
import { estimateRequestTokens, keepCount, summarize } from './compaction.js';
import { runHooks } from './hooks.js';
import { gitInfo, gitRoot, createWorktree, worktreeStats, commitWorktree, removeWorktree } from './git.js';
import { renderSkill } from './skills.js';
import { updateConfigFile } from './config.js';
import type { AgentProfile } from './commands.js';
import { ProviderError, type StreamEvent } from './providers/types.js';
import { displayPath } from './paths.js';
import { errorMessage, isAbortError, sessionId, sleep, truncate, uid } from './util.js';
import { isPersistent } from './types.js';

export interface AgentOptions {
  runtime: Runtime;
  /** Resume an existing session id */
  id?: string;
  cwd?: string;
  model?: string;
  mode?: Mode;
  title?: string;
  /** Can a human answer approvals/questions? (false = headless) */
  interactive?: boolean;
  /** Headless only: approve everything that is not hard-denied */
  autoApprove?: boolean;
  /** Write the session log to disk (default true) */
  persist?: boolean;
  parent?: { agent: Agent; toolCallId: string; profile: AgentProfile };
  worktree?: WorktreeInfo;
}

export interface AgentSnapshot {
  id: string;
  title: string;
  cwd: string;
  projectRoot: string;
  model: string;
  mode: Mode;
  status: SessionStatus;
  turn: number;
  todos: Todo[];
  totals: UsageTotals;
  contextTokens: number;
  contextWindow: number;
  worktree?: WorktreeInfo;
  parentId?: string;
  pendingApprovals: number;
  createdAt: number;
  updatedAt: number;
  filesChanged: string[];
}

interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
  turn: number;
}

const MAX_RETRIES = 3;

export class Agent extends EventEmitter {
  readonly id: string;
  readonly runtime: Runtime;
  readonly cwd: string;
  readonly projectRoot: string;
  readonly interactive: boolean;
  readonly persist: boolean;
  readonly parent?: AgentOptions['parent'];
  readonly worktree?: WorktreeInfo;
  mode: Mode;
  model: string;
  title: string;
  status: SessionStatus = 'idle';
  messages: ChatMessage[] = [];
  todos: Todo[] = [];
  totals: UsageTotals = emptyTotals();
  turn = 0;
  contextTokens = 0;
  createdAt = Date.now();
  updatedAt = Date.now();

  private autoApprove: boolean;
  private abortCtl?: AbortController;
  private running?: Promise<TurnEndReason>;
  private turnStarts = new Map<number, number>();
  private fileChanges: FileChange[] = [];
  private memBlobs = new Map<string, string>();
  /** Integration tools activated through tool_search (when tool loading is deferred). */
  private activeMcp = new Set<string>();
  private readTracker = new Map<string, number>();
  private sessionAllow: string[] = [];
  private pendingApprovals = new Map<string, { resolve: (d: { decision: ApprovalDecision; feedback?: string }) => void; rule?: string }>();
  private pendingQuestions = new Map<string, (answer: string) => void>();
  private pendingPlans = new Map<string, (d: PlanDecision) => void>();
  private children = new Map<string, Agent>();
  private log: AgentEvent[] = [];
  private turnChanged = new Set<string>();

  private constructor(opts: AgentOptions, id: string) {
    super();
    this.setMaxListeners(100);
    this.id = id;
    this.runtime = opts.runtime;
    this.cwd = path.resolve(opts.cwd ?? opts.runtime.cwd);
    this.projectRoot = opts.worktree ? opts.worktree.path : (gitRoot(this.cwd) ?? opts.runtime.projectRoot);
    this.interactive = opts.interactive ?? true;
    this.autoApprove = Boolean(opts.autoApprove);
    this.persist = opts.persist ?? true;
    this.parent = opts.parent;
    this.worktree = opts.worktree;
    this.mode = opts.mode ?? opts.runtime.config.mode ?? 'ask';
    this.model = opts.model ?? 'demo/drakox-demo';
    this.title = opts.title ?? '';
  }

  get store(): SessionStore {
    return this.runtime.store;
  }

  /** Create a new agent session. */
  static async create(opts: AgentOptions): Promise<Agent> {
    const agent = new Agent(opts, sessionId());
    if (!opts.model) agent.model = (await opts.runtime.defaultModel()).ref;
    if (agent.persist) {
      const meta: SessionMeta = {
        id: agent.id,
        title: agent.title || 'New session',
        cwd: agent.cwd,
        projectRoot: opts.runtime.projectRoot,
        model: agent.model,
        mode: agent.mode,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
        parentId: opts.parent?.agent.id,
        worktree: opts.worktree,
        turns: 0,
        costUsd: 0,
        tokens: 0,
      };
      agent.store.create(meta);
    }
    agent.emitEvent({ type: 'session_start', sessionId: agent.id, cwd: agent.cwd, model: agent.model, mode: agent.mode, title: agent.title || undefined, parentId: opts.parent?.agent.id, worktree: opts.worktree, ts: Date.now() });
    const ins = opts.runtime.instructions(agent.cwd);
    for (const w of ins.warnings) agent.emitEvent({ type: 'notice', level: 'warning', message: w, ts: Date.now() });
    if (!opts.parent) void agent.sessionStartHooks();
    return agent;
  }

  /** Resume a persisted session from its event log (crash-safe: interrupted tools are repaired). */
  static async resume(runtime: Runtime, id: string, opts: Partial<AgentOptions> = {}): Promise<Agent> {
    const meta = runtime.store.meta(id);
    if (!meta) throw new Error(`Session ${id} not found`);
    const agent = new Agent({ runtime, cwd: meta.cwd, model: meta.model, mode: meta.mode, title: meta.title, worktree: meta.worktree, ...opts }, id);
    const events = runtime.store.events(id);
    const st = replay(events);
    agent.log = events;
    agent.messages = st.messages;
    agent.todos = st.todos;
    agent.totals = st.totals;
    agent.turn = st.turn;
    agent.turnStarts = st.turnStarts;
    agent.contextTokens = st.contextTokens;
    agent.mode = opts.mode ?? st.mode ?? agent.mode;
    agent.model = opts.model ?? st.model ?? agent.model;
    agent.title = st.title ?? meta.title;
    agent.createdAt = meta.createdAt;
    agent.updatedAt = meta.updatedAt;
    for (const e of events) {
      if (e.type === 'file_change') agent.fileChanges.push({ path: e.path, before: e.before, after: e.after, turn: e.turn });
      if (e.type === 'rewind') agent.fileChanges = agent.fileChanges.filter((c) => c.turn < e.toTurn);
    }
    if (st.interrupted.length) {
      agent.emitEvent({
        type: 'notice',
        level: 'warning',
        message: `Recovered session: ${st.interrupted.length} interrupted tool call(s) (${st.interrupted.map((t) => t.name).join(', ')}) were marked as not completed.`,
        ts: Date.now(),
      });
    }
    return agent;
  }

  /** Every event goes through here: persisted to the log, broadcast to listeners, bubbled to the parent. */
  emitEvent(e: AgentEvent): void {
    if (this.persist) {
      try {
        this.store.append(this.id, e);
      } catch {
        /* disk full etc. — keep running */
      }
    }
    if (isPersistent(e)) this.log.push(e);
    this.emit('event', e);
    if (this.parent) {
      this.parent.agent.emitEvent({ type: 'subagent', parentToolCallId: this.parent.toolCallId, agent: this.parent.profile.name, childId: this.id, event: e, ts: e.ts });
    }
  }

  private setStatus(status: SessionStatus, detail?: string): void {
    this.status = status;
    this.emitEvent({ type: 'status', status, detail, ts: Date.now() });
  }

  /** Persisted events so far (for UIs that attach late). */
  events(): AgentEvent[] {
    return this.log;
  }

  isRunning(): boolean {
    return Boolean(this.running);
  }

  snapshot(): AgentSnapshot {
    return {
      id: this.id,
      title: this.title || 'New session',
      cwd: this.cwd,
      projectRoot: this.projectRoot,
      model: this.model,
      mode: this.mode,
      status: this.status,
      turn: this.turn,
      todos: this.todos,
      totals: this.totals,
      contextTokens: this.contextTokens,
      contextWindow: contextWindowFor(this.model, this.runtime.config),
      worktree: this.worktree,
      parentId: this.parent?.agent.id,
      pendingApprovals: this.pendingApprovals.size + [...this.children.values()].reduce((n, c) => n + c.pendingApprovals.size, 0),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      filesChanged: [...new Set(this.fileChanges.map((c) => c.path))],
    };
  }

  private saveMeta(lastMessage?: string): void {
    if (!this.persist) return;
    const meta = this.store.meta(this.id);
    if (!meta) return;
    this.updatedAt = Date.now();
    this.store.saveMeta({
      ...meta,
      title: this.title || meta.title,
      model: this.model,
      mode: this.mode,
      updatedAt: this.updatedAt,
      turns: this.turn,
      costUsd: this.totals.costUsd,
      tokens: this.totals.inputTokens + this.totals.outputTokens,
      lastMessage: lastMessage ? truncate(lastMessage.replace(/\s+/g, ' '), 160) : meta.lastMessage,
    });
  }

  private async sessionStartHooks(): Promise<void> {
    try {
      await runHooks('SessionStart', this.runtime.config, { session_id: this.id, cwd: this.cwd }, { cwd: this.cwd, trusted: this.runtime.trusted() });
    } catch {
      /* hooks are best-effort */
    }
  }

  // ───────────────────────────── controls ─────────────────────────────

  setMode(mode: Mode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.emitEvent({ type: 'mode_change', mode, ts: Date.now() });
    this.saveMeta();
  }

  setModel(model: string): void {
    if (model === this.model) return;
    this.model = model;
    this.emitEvent({ type: 'model_change', model, ts: Date.now() });
    this.saveMeta();
  }

  setTitle(title: string): void {
    this.title = title.trim().slice(0, 100);
    this.emitEvent({ type: 'title', title: this.title, ts: Date.now() });
    this.saveMeta();
  }

  abort(): void {
    this.abortCtl?.abort();
    for (const [id, p] of this.pendingApprovals) {
      p.resolve({ decision: 'deny', feedback: 'Interrupted by user' });
      this.pendingApprovals.delete(id);
    }
    for (const [id, q] of this.pendingQuestions) {
      q('(no answer — the user interrupted)');
      this.pendingQuestions.delete(id);
    }
    for (const [id, p] of this.pendingPlans) {
      p({ approved: false, feedback: 'Interrupted by user' });
      this.pendingPlans.delete(id);
    }
    for (const c of this.children.values()) c.abort();
  }

  /** Answer an approval request (routes to sub-agents too). Returns false if unknown. */
  respondApproval(id: string, decision: ApprovalDecision, feedback?: string): boolean {
    const p = this.pendingApprovals.get(id);
    if (p) {
      this.pendingApprovals.delete(id);
      p.resolve({ decision, feedback });
      return true;
    }
    for (const c of this.children.values()) if (c.respondApproval(id, decision, feedback)) return true;
    return false;
  }

  answerQuestion(id: string, answer: string): boolean {
    const q = this.pendingQuestions.get(id);
    if (q) {
      this.pendingQuestions.delete(id);
      this.emitEvent({ type: 'answer', id, answer, ts: Date.now() });
      q(answer);
      return true;
    }
    for (const c of this.children.values()) if (c.answerQuestion(id, answer)) return true;
    return false;
  }

  respondPlan(id: string, decision: PlanDecision): boolean {
    const p = this.pendingPlans.get(id);
    if (!p) return false;
    this.pendingPlans.delete(id);
    p(decision);
    return true;
  }

  pending(): { approvals: string[]; questions: string[]; plans: string[] } {
    return { approvals: [...this.pendingApprovals.keys()], questions: [...this.pendingQuestions.keys()], plans: [...this.pendingPlans.keys()] };
  }

  /** The tools offered to the model right now (depends on mode, role, configuration). */
  availableTools(): Tool<any>[] {
    const cfg = this.runtime.config;
    const isSub = Boolean(this.parent);
    const skills = this.runtime.skills().filter((s) => !s.userOnly);
    let tools = BUILTIN_TOOLS.filter((t) => {
      if (t.name === 'submit_plan') return this.mode === 'plan' && !isSub;
      if (t.name === 'task') return !isSub;
      if (t.name === 'ask_user') return this.interactive && !isSub;
      if (t.name === 'web_search') return webSearchAvailable(cfg.webSearch);
      if (t.name === 'skill') return skills.length > 0;
      if (this.mode === 'plan' && t.kind === 'edit') return false;
      return true;
    });
    const mcpTools = this.runtime.mcp.tools().filter((t) => this.toolPermitted(t));
    if (shouldDeferMcp(mcpTools, cfg)) {
      // Large integration catalogs (e.g. REA exposes 200+ tools) are loaded on demand to save context.
      tools = [...tools, ...mcpTools.filter((t) => this.activeMcp.has(t.name)), this.toolSearchTool(mcpTools)];
    } else tools = [...tools, ...mcpTools];
    return tools.filter((t) => this.toolPermitted(t));
  }

  /** Sub-agent profiles can restrict tools (exact names or `prefix*` wildcards). */
  private toolPermitted(t: Tool<any>): boolean {
    const allow = this.parent?.profile.tools;
    if (!allow?.length) return true;
    return allow.includes(t.name) || t.kind === 'meta' || allow.some((a) => a.endsWith('*') && t.name.startsWith(a.slice(0, -1)));
  }

  private toolSearchTool(all: Tool<any>[]): Tool<{ query: string; server?: string; limit?: number }> {
    const servers = new Map<string, number>();
    for (const t of all) {
      const sv = String(t.annotations?.server ?? 'mcp');
      servers.set(sv, (servers.get(sv) ?? 0) + 1);
    }
    const summary = [...servers.entries()].map(([sv, n]) => `${sv} (${n})`).join(', ');
    return {
      name: 'tool_search',
      kind: 'meta',
      parallelSafe: true,
      description:
        `Find and activate tools from connected integrations: ${summary}. Integration tools are loaded on demand to save context — ` +
        'search by what you want to do (e.g. "create issue", "open binary", "query database"); matching tools become directly callable in your next step.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords describing the capability you need' },
          server: { type: 'string', description: 'Optional: only search this integration' },
          limit: { type: 'number', description: 'Max tools to activate (default 6, max 15)' },
        },
        required: ['query'],
      },
      title: (a) => `Search integration tools: ${a.query}`,
      run: async (a) => {
        const words = String(a.query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
        const pool = all.filter((t) => !a.server || t.annotations?.server === a.server);
        const scored = pool
          .map((t) => {
            const name = t.name.toLowerCase();
            const desc = t.description.toLowerCase();
            let score = 0;
            for (const w of words) {
              if (name.includes(w)) score += 3;
              if (desc.includes(w)) score += 1;
            }
            return { t, score };
          })
          .filter((x) => x.score > 0)
          .sort((x, y) => y.score - x.score)
          .slice(0, Math.min(Math.max(Number(a.limit) || 6, 1), 15));
        if (!scored.length) return { content: `No integration tools match "${a.query}". Connected: ${summary}. Try other keywords.` };
        for (const { t } of scored) this.activeMcp.add(t.name);
        const lines = scored.map(({ t }) => {
          const req = ((t.parameters as any)?.required ?? []) as string[];
          return `- ${t.name}${req.length ? ` (required: ${req.join(', ')})` : ''}: ${t.description.slice(0, 300)}`;
        });
        return { content: `Activated ${scored.length} tool(s) — call them directly now:\n${lines.join('\n')}` };
      },
    };
  }

  lastAssistantText(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!;
      if (m.role === 'assistant' && m.content.trim()) return m.content;
    }
    return '';
  }

  private systemPrompt(tools: Tool<any>[]): string {
    const rt = this.runtime;
    return buildSystemPrompt({
      cwd: this.cwd,
      mode: this.mode,
      model: this.model,
      sandbox: rt.sandbox(),
      git: gitInfo(this.cwd),
      instructions: rt.instructions(this.cwd).text,
      skills: rt.skills(),
      agents: rt.agentProfiles(),
      mcpInstructions: rt.mcp.instructions(),
      mcpServers: [...new Set(tools.filter((t) => t.kind === 'mcp').map((t) => t.annotations?.server ?? ''))].filter(Boolean),
      isSubagent: Boolean(this.parent),
      subagentPrompt: this.parent?.profile.prompt,
      hasWebSearch: webSearchAvailable(rt.config.webSearch),
    });
  }

  // ───────────────────────────── the agent loop ─────────────────────────────

  /** Send a user message and run the agent until it finishes the turn. */
  async send(text: string, opts: { images?: ImagePart[]; displayText?: string } = {}): Promise<TurnEndReason> {
    if (this.running) throw new Error('The agent is already working. Wait for it to finish or interrupt it.');
    this.running = this.runTurn(text, opts).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Wait for the current turn (if any) to finish. */
  async idle(): Promise<void> {
    if (this.running) await this.running.catch(() => undefined);
  }

  private async runTurn(text: string, opts: { images?: ImagePart[]; displayText?: string }): Promise<TurnEndReason> {
    const rt = this.runtime;
    const cfg = rt.config;
    this.abortCtl = new AbortController();
    const signal = this.abortCtl.signal;
    this.turnChanged.clear();

    // UserPromptSubmit hooks can block the prompt or add context
    let hookContext = '';
    if (!this.parent) {
      const h = await runHooks('UserPromptSubmit', cfg, { session_id: this.id, prompt: text, cwd: this.cwd }, { cwd: this.cwd, trusted: rt.trusted() });
      if (h.blocked) {
        this.emitEvent({ type: 'notice', level: 'warning', message: `Prompt blocked by hook: ${h.reason}`, ts: Date.now() });
        return 'aborted';
      }
      hookContext = h.context ?? '';
    }

    this.turn += 1;
    const turn = this.turn;
    const content = hookContext ? `${text}\n\n<hook_context>\n${hookContext}\n</hook_context>` : text;
    this.turnStarts.set(turn, this.messages.length);
    this.emitEvent({ type: 'user_message', id: uid('u_'), turn, content, images: opts.images, displayText: opts.displayText, ts: Date.now() });
    this.messages.push({ role: 'user', content: opts.images?.length ? [{ type: 'text', text: content }, ...opts.images] : content });
    if (!this.title) this.setTitle(deriveTitle(opts.displayText ?? text));
    this.setStatus('running');

    let reason: TurnEndReason = 'completed';
    let endMessage: string | undefined;
    const maxSteps = cfg.maxTurns ?? 60;
    try {
      for (let step = 0; ; step++) {
        if (signal.aborted) {
          reason = 'aborted';
          break;
        }
        if (step >= maxSteps) {
          reason = 'max_turns';
          endMessage = `Stopped after ${maxSteps} model calls in one turn (maxTurns). Send "continue" to keep going.`;
          break;
        }
        const budget = cfg.budget?.sessionUsd;
        if (budget && this.totals.costUsd >= budget) {
          reason = 'budget';
          endMessage = `Session budget of $${budget.toFixed(2)} reached (spent ~$${this.totals.costUsd.toFixed(2)}). Raise budget.sessionUsd to continue.`;
          break;
        }
        const tools = this.availableTools();
        const system = this.systemPrompt(tools);
        await this.maybeCompact(system, tools, signal);

        const response = await this.callModel(system, tools, signal);
        if (!response) {
          reason = signal.aborted ? 'aborted' : 'error';
          break;
        }
        if (!response.toolCalls.length) {
          if (response.stopReason === 'length' || response.stopReason === 'max_tokens') {
            this.emitEvent({ type: 'notice', level: 'warning', message: 'The model hit its output limit; the answer may be cut off.', ts: Date.now() });
          }
          break;
        }
        const planOutcome = await this.executeToolCalls(response.toolCalls, tools, signal, turn);
        if (signal.aborted) {
          reason = 'aborted';
          break;
        }
        if (planOutcome === 'stop') {
          reason = 'plan_submitted';
          break;
        }
      }
    } catch (err) {
      if (isAbortError(err) || signal.aborted) reason = 'aborted';
      else {
        reason = 'error';
        endMessage = errorMessage(err);
        this.emitEvent({ type: 'error', message: endMessage, ts: Date.now() });
      }
    }

    this.emitEvent({ type: 'turn_end', turn, reason, message: endMessage, ts: Date.now() });
    if (endMessage && reason !== 'error') this.emitEvent({ type: 'notice', level: 'warning', message: endMessage, ts: Date.now() });
    this.setStatus(reason === 'error' ? 'error' : 'idle');
    this.saveMeta(this.lastAssistantText());
    this.abortCtl = undefined;

    if (!this.parent) {
      void runHooks('Stop', cfg, { session_id: this.id, reason, cwd: this.cwd }, { cwd: this.cwd, trusted: rt.trusted() }).catch(() => undefined);
      if (cfg.autoReview && reason === 'completed' && this.turnChanged.size) void this.backgroundReview([...this.turnChanged]);
    }
    return reason;
  }

  /** Stream one model response, with retries for transient provider errors. */
  private async callModel(system: string, tools: Tool<any>[], signal: AbortSignal): Promise<{ toolCalls: ToolCall[]; stopReason?: string } | undefined> {
    const rt = this.runtime;
    let resolved;
    try {
      resolved = rt.providers.resolve(this.model);
    } catch (err) {
      this.emitEvent({ type: 'error', message: errorMessage(err), ts: Date.now() });
      return undefined;
    }
    const { provider, model, ref } = resolved;
    const specs = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const id = uid('a_');
      const started = Date.now();
      let text = '';
      let reasoning = '';
      let emittedAny = false;
      let done: Extract<StreamEvent, { type: 'done' }> | undefined;
      this.emitEvent({ type: 'assistant_start', id, model: ref, ts: started });
      try {
        for await (const ev of provider.stream({ model, system, messages: this.messages, tools: specs, signal, reasoningEffort: rt.config.reasoningEffort })) {
          if (ev.type === 'text') {
            text += ev.delta;
            emittedAny = true;
            this.emitEvent({ type: 'text_delta', id, delta: ev.delta, ts: Date.now() });
          } else if (ev.type === 'reasoning') {
            reasoning += ev.delta;
            emittedAny = true;
            this.emitEvent({ type: 'reasoning_delta', id, delta: ev.delta, ts: Date.now() });
          } else if (ev.type === 'done') done = ev;
        }
      } catch (err) {
        if (isAbortError(err) || signal.aborted) {
          if (text) this.recordAssistant(id, ref, text, reasoning, [], undefined, undefined, started);
          return undefined;
        }
        const retryable = err instanceof ProviderError ? err.retryable : /ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i.test(errorMessage(err));
        if (retryable && !emittedAny && attempt < MAX_RETRIES) {
          const wait = [1000, 3000, 8000][attempt]!;
          this.emitEvent({ type: 'notice', level: 'info', message: `${errorMessage(err)} — retrying in ${wait / 1000}s (${attempt + 1}/${MAX_RETRIES})`, ts: Date.now() });
          await sleep(wait, signal).catch(() => undefined);
          if (signal.aborted) return undefined;
          continue;
        }
        if (text) this.recordAssistant(id, ref, text, reasoning, [], undefined, undefined, started);
        this.emitEvent({ type: 'error', message: errorMessage(err), recoverable: retryable, ts: Date.now() });
        return undefined;
      }
      const toolCalls = done?.toolCalls ?? [];
      this.recordAssistant(id, ref, text, reasoning, toolCalls, done?.usage, done?.providerMeta, started, done?.stopReason);
      return { toolCalls, stopReason: done?.stopReason };
    }
    return undefined;
  }

  private recordAssistant(id: string, ref: string, text: string, reasoning: string, toolCalls: ToolCall[], usage: Usage | undefined, providerMeta: any, started: number, stopReason?: string): void {
    this.emitEvent({
      type: 'assistant_message',
      id,
      content: text,
      reasoning: reasoning || undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      providerMeta,
      model: ref,
      usage,
      stopReason,
      durationMs: Date.now() - started,
      ts: Date.now(),
    });
    this.messages.push({ role: 'assistant', content: text, reasoning: reasoning || undefined, toolCalls: toolCalls.length ? toolCalls : undefined, providerMeta });
    if (usage) this.addUsage(ref, usage);
  }

  private addUsage(ref: string, usage: Usage): void {
    const cost = costFor(ref, usage, this.runtime.config);
    const t = this.totals;
    this.totals = {
      inputTokens: t.inputTokens + usage.inputTokens,
      outputTokens: t.outputTokens + usage.outputTokens,
      cachedInputTokens: t.cachedInputTokens + (usage.cachedInputTokens ?? 0),
      costUsd: t.costUsd + (cost ?? 0),
      costPartial: t.costPartial || cost === null,
      requests: t.requests + 1,
    };
    this.contextTokens = usage.inputTokens + usage.outputTokens;
    this.emitEvent({ type: 'usage', usage, costUsd: cost, totals: this.totals, contextTokens: this.contextTokens, contextWindow: contextWindowFor(ref, this.runtime.config), ts: Date.now() });
  }

  /** Merge a sub-agent's spend into this session's totals. */
  private absorbUsage(child: UsageTotals): void {
    const t = this.totals;
    this.totals = {
      inputTokens: t.inputTokens + child.inputTokens,
      outputTokens: t.outputTokens + child.outputTokens,
      cachedInputTokens: t.cachedInputTokens + child.cachedInputTokens,
      costUsd: t.costUsd + child.costUsd,
      costPartial: t.costPartial || child.costPartial,
      requests: t.requests + child.requests,
    };
    this.emitEvent({ type: 'usage', usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, totals: this.totals, contextTokens: this.contextTokens, contextWindow: contextWindowFor(this.model, this.runtime.config), ts: Date.now() });
  }

  // ───────────────────────────── tool execution ─────────────────────────────

  /**
   * Execute the tool calls from one model response. Consecutive parallel-safe tools (reads, searches,
   * read-only MCP calls) run concurrently; everything else runs in order. Returns 'stop' if a plan was
   * rejected without feedback or the turn should end.
   */
  private async executeToolCalls(calls: ToolCall[], tools: Tool<any>[], signal: AbortSignal, turn: number): Promise<'continue' | 'stop'> {
    const byName = new Map(tools.map((t) => [t.name, t]));
    // a model may call a deferred integration tool directly (e.g. after resume) — activate it on the fly
    for (const call of calls) {
      if (byName.has(call.name) || !call.name.startsWith('mcp__')) continue;
      const t = this.runtime.mcp.tools().find((x) => x.name === call.name);
      if (t && this.toolPermitted(t)) {
        this.activeMcp.add(t.name);
        byName.set(t.name, t);
      }
    }
    const batches: ToolCall[][] = [];
    for (const call of calls) {
      const tool = byName.get(call.name);
      const last = batches[batches.length - 1];
      const safe = Boolean(tool?.parallelSafe);
      if (safe && last && last.every((c) => byName.get(c.name)?.parallelSafe)) last.push(call);
      else batches.push([call]);
    }
    let outcome: 'continue' | 'stop' = 'continue';
    const results = new Map<string, ToolResult>();
    for (const batch of batches) {
      if (signal.aborted) break;
      const run = async (call: ToolCall) => {
        const r = await this.runTool(call, byName.get(call.name), signal, turn);
        results.set(call.id, r.result);
        if (r.stop) outcome = 'stop';
      };
      if (batch.length > 1) await Promise.all(batch.map(run));
      else await run(batch[0]!);
    }
    // keep the transcript valid: every tool call needs a result, in order
    for (const call of calls) {
      let r = results.get(call.id);
      if (!r) {
        r = { content: 'Not executed: the user interrupted the turn.', isError: true };
        this.emitEvent({ type: 'tool_result', id: call.id, name: call.name, isError: true, content: r.content, durationMs: 0, ts: Date.now() });
      }
      this.messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: r.content, isError: r.isError });
    }
    return outcome;
  }

  private async runTool(call: ToolCall, tool: Tool<any> | undefined, signal: AbortSignal, turn: number): Promise<{ result: ToolResult; stop?: boolean }> {
    const started = Date.now();
    const finish = (result: ToolResult, stop?: boolean) => {
      this.emitEvent({ type: 'tool_result', id: call.id, name: call.name, isError: Boolean(result.isError), content: result.content, display: result.display, durationMs: Date.now() - started, ts: Date.now() });
      return { result, stop };
    };
    if (!tool) {
      const names = this.availableTools().map((t) => t.name);
      return finish({ content: `Unknown tool "${call.name}". Available tools: ${names.join(', ')}`, isError: true });
    }
    const args = call.args ?? {};
    if ('__invalid_json__' in args) {
      return finish({ content: `The arguments for ${call.name} were not valid JSON: ${String(args.__invalid_json__).slice(0, 500)}. Retry with valid JSON.`, isError: true });
    }
    const missing = ((tool.parameters as any)?.required ?? []).filter((k: string) => args[k] === undefined || args[k] === null);
    if (missing.length) return finish({ content: `Missing required argument(s) for ${call.name}: ${missing.join(', ')}`, isError: true });

    let title = tool.name;
    try {
      title = tool.title(args, this.cwd);
    } catch {
      /* ignore */
    }

    // 1. permissions (approval policy) — independent from the OS sandbox
    const rt = this.runtime;
    const decision = evaluatePermission(tool, args, {
      cwd: this.cwd,
      projectRoot: this.projectRoot,
      mode: this.mode,
      sandbox: rt.sandbox(),
      config: rt.config,
      sessionAllow: this.sessionAllow,
    });
    if (decision.action === 'deny') {
      this.emitEvent({ type: 'approval_response', id: call.id, decision: 'deny', auto: true, rule: decision.rule, feedback: decision.reason, ts: Date.now() });
      return finish({ content: `Permission denied: ${decision.reason}`, isError: true });
    }
    if (decision.action === 'ask') {
      const answer = await this.requestApproval(call, tool, title, args, decision.reason, decision.suggestion, signal);
      if (answer.decision === 'deny') {
        const fb = answer.feedback ? ` User feedback: ${answer.feedback}` : '';
        return finish({ content: `The user denied this ${call.name} call.${fb} Do not retry the same action; adjust your approach or ask the user.`, isError: true });
      }
    }

    // 2. PreToolUse hooks
    const trusted = rt.trusted();
    const pre = await runHooks('PreToolUse', rt.config, { session_id: this.id, tool_name: call.name, tool_input: args, cwd: this.cwd }, { cwd: this.cwd, toolName: call.name, trusted });
    if (pre.blocked) return finish({ content: `Blocked by PreToolUse hook: ${pre.reason}`, isError: true });

    // 3. execute
    this.emitEvent({ type: 'tool_start', id: call.id, name: call.name, args, title, kind: tool.kind, ts: started });
    let result: ToolResult;
    let stop = false;
    const ctx = this.toolContext(call, turn, signal, (s) => {
      stop = s;
    });
    try {
      result = await tool.run(args, ctx);
    } catch (err) {
      result = { content: signal.aborted ? 'Interrupted by the user.' : `Tool error: ${errorMessage(err)}`, isError: true };
    }

    // 4. PostToolUse hooks (formatters / linters) — feedback goes back to the model
    if (!signal.aborted) {
      const post = await runHooks('PostToolUse', rt.config, { session_id: this.id, tool_name: call.name, tool_input: args, tool_response: typeof result.content === 'string' ? result.content.slice(0, 20000) : '[content]', cwd: this.cwd }, { cwd: this.cwd, toolName: call.name, trusted });
      if (post.blocked && post.reason) {
        const note = `\n\n[PostToolUse hook feedback]\n${post.reason}`;
        result = { ...result, content: typeof result.content === 'string' ? result.content + note : [...result.content, { type: 'text', text: note }] };
      }
    }
    return finish(result, stop);
  }

  private async requestApproval(
    call: ToolCall,
    tool: Tool<any>,
    title: string,
    args: Record<string, unknown>,
    reason: string,
    suggestion: string | undefined,
    signal: AbortSignal,
  ): Promise<{ decision: ApprovalDecision; feedback?: string }> {
    if (!this.interactive) {
      const decision: ApprovalDecision = this.autoApprove ? 'allow_once' : 'deny';
      this.emitEvent({ type: 'approval_response', id: call.id, decision, auto: true, feedback: this.autoApprove ? 'auto-approved (headless)' : `needs approval: ${reason}`, ts: Date.now() });
      return this.autoApprove ? { decision } : { decision, feedback: `This action needs approval (${reason}) and DrakoX is running non-interactively. Re-run with --mode autopilot, add an allow rule, or pass --yolo.` };
    }
    const id = uid('ap_');
    const detail = approvalDetail(tool, args, this.cwd);
    this.emitEvent({
      type: 'approval_request',
      request: { id, toolCallId: call.id, tool: call.name, kind: tool.kind, title, detail, reason, ruleSuggestion: suggestion, agent: this.id },
      ts: Date.now(),
    });
    const prevStatus = this.status;
    this.setStatus('awaiting_input', 'approval');
    void runHooks('Notification', this.runtime.config, { session_id: this.id, message: `DrakoX needs approval: ${title}` }, { cwd: this.cwd, trusted: this.runtime.trusted() }).catch(() => undefined);
    const answer = await new Promise<{ decision: ApprovalDecision; feedback?: string }>((resolve) => {
      if (signal.aborted) return resolve({ decision: 'deny', feedback: 'Interrupted by user' });
      this.pendingApprovals.set(id, { resolve, rule: suggestion });
      signal.addEventListener('abort', () => {
        if (this.pendingApprovals.delete(id)) resolve({ decision: 'deny', feedback: 'Interrupted by user' });
      }, { once: true });
    });
    if (answer.decision === 'allow_always' && suggestion) {
      this.sessionAllow.push(suggestion);
      try {
        // persist to the git-ignored local project settings (like "always allow" in Claude Code)
        updateConfigFile('local', this.runtime.projectRoot, (cfg) => {
          cfg.permissions ??= {};
          cfg.permissions.allow = [...new Set([...(cfg.permissions.allow ?? []), suggestion])];
        });
      } catch {
        /* session-only if the file cannot be written */
      }
    }
    this.emitEvent({ type: 'approval_response', id, decision: answer.decision, feedback: answer.feedback, rule: answer.decision === 'allow_always' ? suggestion : undefined, ts: Date.now() });
    if (this.status === 'awaiting_input') this.setStatus(prevStatus === 'awaiting_input' ? 'running' : prevStatus);
    return answer;
  }

  private toolContext(call: ToolCall, turn: number, signal: AbortSignal, setStop: (s: boolean) => void): ToolContext {
    const rt = this.runtime;
    return {
      cwd: this.cwd,
      projectRoot: this.projectRoot,
      sessionId: this.id,
      turn,
      toolCallId: call.id,
      signal,
      config: rt.config,
      sandbox: rt.sandbox(),
      mode: this.mode,
      emit: (e) => this.emitEvent(e),
      output: (delta) => this.emitEvent({ type: 'tool_output', id: call.id, delta, ts: Date.now() }),
      recordFileChange: (abs, before, after) => this.recordFileChange(abs, before, after, call.id),
      readTracker: this.readTracker,
      shells: rt.shells,
      todos: {
        get: () => this.todos,
        set: (t) => {
          this.todos = t;
        },
      },
      askUser: this.interactive && !this.parent ? (q, options) => this.askUser(call.id, q, options, signal) : undefined,
      submitPlan: !this.parent ? (md) => this.submitPlan(md, signal, setStop) : undefined,
      runSubagent: !this.parent ? (req) => this.runSubagent(req, call.id, signal) : undefined,
      loadSkill: async (name) => {
        const s = rt.skills().find((x) => x.name === name);
        return s ? renderSkill(s) : undefined;
      },
    };
  }

  private askUser(toolCallId: string, question: string, options: string[] | undefined, signal: AbortSignal): Promise<string> {
    const id = uid('q_');
    return new Promise<string>((resolve) => {
      this.pendingQuestions.set(id, resolve);
      this.emitEvent({ type: 'question', id, toolCallId, question, options, ts: Date.now() });
      this.setStatus('awaiting_input', 'question');
      signal.addEventListener('abort', () => {
        if (this.pendingQuestions.delete(id)) resolve('(no answer — the user interrupted)');
      }, { once: true });
    }).finally(() => {
      if (this.status === 'awaiting_input') this.setStatus('running');
    });
  }

  private async submitPlan(markdown: string, signal: AbortSignal, setStop: (s: boolean) => void): Promise<PlanDecision> {
    const id = uid('plan_');
    this.emitEvent({ type: 'plan', id, markdown, status: 'proposed', ts: Date.now() });
    this.emitEvent({ type: 'artifact', artifact: { id, kind: 'plan', title: 'Implementation plan', markdown }, ts: Date.now() });
    if (!this.interactive) {
      setStop(true);
      return { approved: false, feedback: 'Non-interactive session: the plan was recorded. Stop here.' };
    }
    this.setStatus('awaiting_input', 'plan');
    const d = await new Promise<PlanDecision>((resolve) => {
      this.pendingPlans.set(id, resolve);
      signal.addEventListener('abort', () => {
        if (this.pendingPlans.delete(id)) resolve({ approved: false, feedback: 'Interrupted by user' });
      }, { once: true });
    });
    this.emitEvent({ type: 'plan', id, markdown, status: d.approved ? 'approved' : 'rejected', feedback: d.feedback, mode: d.mode, ts: Date.now() });
    if (d.approved) this.setMode(d.mode && d.mode !== 'plan' ? d.mode : 'auto-edit');
    else if (!d.feedback) setStop(true); // rejected without feedback → hand control back to the user
    if (this.status === 'awaiting_input') this.setStatus('running');
    return d;
  }

  /** Checkpoint a file mutation (content snapshots go to the blob store). */
  recordFileChange(abs: string, before: string | null, after: string | null, toolCallId?: string): void {
    if (this.parent && !this.worktree) {
      // shared working tree: the parent's checkpoints cover sub-agent edits too
      this.parent.agent.recordFileChange(abs, before, after, toolCallId);
      return;
    }
    const b = before === null ? null : this.putBlob(before);
    const a = after === null ? null : this.putBlob(after);
    this.fileChanges.push({ path: abs, before: b, after: a, turn: this.turn });
    this.turnChanged.add(abs);
    this.emitEvent({ type: 'file_change', path: abs, before: b, after: a, turn: this.turn, toolCallId, ts: Date.now() });
  }

  private putBlob(content: string): string {
    if (this.persist) return this.store.putBlob(this.id, content);
    const key = `${content.length}:${hashLite(content)}`;
    this.memBlobs.set(key, content);
    return key;
  }

  getBlob(hash: string): string | null {
    if (this.persist) return this.store.getBlob(this.id, hash);
    return this.memBlobs.get(hash) ?? null;
  }

  /** Files changed by this session with their original (first-seen) and current content hashes. */
  changedFiles(): { path: string; before: string | null; after: string | null; turns: number[] }[] {
    const map = new Map<string, { path: string; before: string | null; after: string | null; turns: number[] }>();
    for (const c of this.fileChanges) {
      const cur = map.get(c.path);
      if (!cur) map.set(c.path, { path: c.path, before: c.before, after: c.after, turns: [c.turn] });
      else {
        cur.after = c.after;
        if (!cur.turns.includes(c.turn)) cur.turns.push(c.turn);
      }
    }
    return [...map.values()];
  }

  private async runSubagent(req: SubagentRequest, toolCallId: string, signal: AbortSignal): Promise<string> {
    const rt = this.runtime;
    const profiles = rt.agentProfiles();
    const known = req.agentType ? profiles.find((p) => p.name === req.agentType) : undefined;
    const profile: AgentProfile = known ?? {
      name: req.agentType && req.agentType !== 'general' ? req.agentType : 'general',
      description: 'General-purpose sub-agent',
      prompt: '',
      source: 'bundled',
    };
    let worktree: WorktreeInfo | undefined;
    let cwd = this.cwd;
    if (req.isolation === 'worktree') {
      const root = gitRoot(this.cwd);
      if (!root) return 'Cannot use worktree isolation: this directory is not a git repository. Retry with isolation "none".';
      try {
        worktree = createWorktree(root, uid('').slice(-10));
        cwd = worktree.path;
      } catch (err) {
        return `Failed to create a git worktree: ${errorMessage(err)}. Retry with isolation "none".`;
      }
    }
    const model = req.model || profile.model || rt.config.models?.fast || this.model;
    const child = await Agent.create({
      runtime: rt,
      cwd,
      model,
      mode: this.mode,
      interactive: this.interactive,
      autoApprove: this.autoApprove,
      persist: false,
      parent: { agent: this, toolCallId, profile },
      title: req.description,
      worktree,
    });
    child.sessionAllow = [...this.sessionAllow];
    this.children.set(child.id, child);
    const onAbort = () => child.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const reason = await child.send(req.prompt);
      let report = child.lastAssistantText() || '(the sub-agent finished without a final report)';
      if (req.agentType && !known) report = `[note: unknown sub-agent type "${req.agentType}", ran as general]\n${report}`;
      if (reason !== 'completed') report += `\n\n[sub-agent ended early: ${reason}]`;
      if (worktree) {
        const stats = worktreeStats(worktree);
        if (stats.files > 0) {
          const c = commitWorktree(worktree, `DrakoX sub-agent: ${req.description}`);
          report +=
            `\n\n[isolated worktree] ${stats.files} file(s) changed (+${stats.added} −${stats.removed}) on branch \`${worktree.branch}\` at ${worktree.path}` +
            `${c.ok ? ' (committed)' : ` (commit failed: ${c.message})`}. The main working tree is untouched. ` +
            `Review with \`git diff HEAD...${worktree.branch}\`; merge with \`git merge ${worktree.branch}\` only if the user wants these changes.`;
        } else {
          removeWorktreeSafe(worktree);
          report += '\n\n[isolated worktree had no changes and was removed]';
        }
      }
      return report;
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.children.delete(child.id);
      this.absorbUsage(child.totals);
    }
  }

  private async maybeCompact(system: string, tools: Tool<any>[], signal: AbortSignal): Promise<void> {
    const cfg = this.runtime.config;
    if (cfg.autoCompact === false) return;
    const window = contextWindowFor(this.model, cfg);
    const schemaChars = tools.reduce((n, t) => n + t.description.length + JSON.stringify(t.parameters).length, 0);
    const estimate = Math.max(estimateRequestTokens(system, this.messages, schemaChars), this.contextTokens);
    if (estimate < (cfg.compactThreshold ?? 0.8) * window) return;
    try {
      await this.compact('auto', signal);
    } catch (err) {
      if (isAbortError(err)) throw err;
      this.emitEvent({ type: 'notice', level: 'warning', message: `Auto-compaction failed: ${errorMessage(err)}`, ts: Date.now() });
    }
  }

  /** Summarise older messages to free context. Returns false if there was nothing to compact. */
  async compact(trigger: 'auto' | 'manual' = 'manual', signal?: AbortSignal): Promise<boolean> {
    const kept = keepCount(this.messages);
    const head = this.messages.slice(0, this.messages.length - kept);
    if (head.length < 2) return false;
    this.emitEvent({ type: 'notice', level: 'info', message: trigger === 'auto' ? 'Context is getting full — compacting older messages…' : 'Compacting the conversation…', ts: Date.now() });
    const { provider, model } = this.runtime.providers.resolve(this.runtime.config.models?.compact ?? this.model);
    const summary = await summarize(provider, model, head, signal);
    const tail = this.messages.slice(this.messages.length - kept);
    const dropped = head.length;
    this.emitEvent({ type: 'compaction', summary, removedMessages: dropped, keptMessages: kept, ts: Date.now() });
    this.messages = [{ role: 'user', content: compactionMessage(summary) }, { role: 'assistant', content: 'Understood. I have the context from the summary and will continue from there.' }, ...tail];
    const shifted = new Map<number, number>();
    for (const [t, idx] of this.turnStarts) if (idx >= dropped) shifted.set(t, idx - dropped + 2);
    this.turnStarts = shifted;
    this.contextTokens = 0;
    return true;
  }

  /**
   * Rewind to just before `toTurn`: restore files changed since then (checkpoints) and/or drop the
   * conversation from that turn on. Returns the restored file paths.
   */
  async rewind(toTurn: number, opts: { code?: boolean; conversation?: boolean } = {}): Promise<string[]> {
    const code = opts.code ?? true;
    const conversation = opts.conversation ?? true;
    if (this.running) {
      this.abort();
      await this.idle();
    }
    const restored = new Set<string>();
    if (code) {
      const changes = this.fileChanges.filter((c) => c.turn >= toTurn).reverse();
      for (const c of changes) {
        try {
          if (c.before === null) fs.rmSync(c.path, { force: true });
          else {
            const content = this.getBlob(c.before);
            if (content === null) continue;
            fs.mkdirSync(path.dirname(c.path), { recursive: true });
            fs.writeFileSync(c.path, content);
          }
          restored.add(c.path);
        } catch (err) {
          this.emitEvent({ type: 'notice', level: 'warning', message: `Could not restore ${c.path}: ${errorMessage(err)}`, ts: Date.now() });
        }
      }
      this.fileChanges = this.fileChanges.filter((c) => c.turn < toTurn);
      this.readTracker.clear();
    }
    if (conversation) {
      const idx = this.turnStarts.get(toTurn);
      if (idx !== undefined) {
        this.messages = this.messages.slice(0, idx);
        for (const t of [...this.turnStarts.keys()]) if (t >= toTurn) this.turnStarts.delete(t);
      }
      this.turn = Math.max(0, toTurn - 1);
      this.todos = [];
    }
    this.emitEvent({ type: 'rewind', toTurn, restoredFiles: [...restored], conversation, ts: Date.now() });
    this.saveMeta();
    return [...restored];
  }

  /** Muse-style background reviewer: a read-only sub-agent reviews this turn's edits. */
  private async backgroundReview(files: string[]): Promise<void> {
    const rt = this.runtime;
    try {
      const diffs = files
        .slice(0, 20)
        .map((f) => {
          const ch = this.changedFiles().find((c) => c.path === f);
          if (!ch) return '';
          const before = ch.before ? (this.getBlob(ch.before) ?? '') : '';
          const after = ch.after ? (this.getBlob(ch.after) ?? '') : '';
          return unifiedDiff(displayPath(f, this.cwd), before, after);
        })
        .join('\n');
      if (!diffs.trim()) return;
      const reviewer: AgentProfile = rt.agentProfiles().find((p) => p.name === 'reviewer') ?? { name: 'reviewer', description: 'Code reviewer', prompt: REVIEW_PROMPT, tools: ['read_file', 'list_dir', 'glob', 'grep'], source: 'bundled' };
      const child = await Agent.create({
        runtime: rt,
        cwd: this.cwd,
        model: rt.config.models?.review ?? reviewer.model ?? this.model,
        mode: 'plan',
        interactive: false,
        persist: false,
        parent: { agent: this, toolCallId: 'auto-review', profile: { ...reviewer, tools: ['read_file', 'list_dir', 'glob', 'grep'] } },
        title: 'Background review',
      });
      await child.send(`Review these changes that were just made. Report only real problems (bugs, security, broken behavior, missing edge cases) with file:line and a fix. If everything looks fine, reply "LGTM" with one sentence.\n\n${truncate(diffs, 60000)}`);
      this.absorbUsage(child.totals);
      const text = child.lastAssistantText();
      if (text) this.emitEvent({ type: 'artifact', artifact: { id: uid('rev_'), kind: 'review', title: 'Background review', markdown: text }, ts: Date.now() });
    } catch (err) {
      this.emitEvent({ type: 'notice', level: 'warning', message: `Background review failed: ${errorMessage(err)}`, ts: Date.now() });
    }
  }
}

// ───────────────────────────── helpers ─────────────────────────────

/** Defer integration tools behind tool_search when there are too many to send on every request. */
function shouldDeferMcp(tools: Tool<any>[], cfg: { mcpToolSearch?: 'auto' | 'on' | 'off' }): boolean {
  const setting = cfg.mcpToolSearch ?? 'auto';
  if (setting === 'off' || !tools.length) return false;
  if (setting === 'on') return true;
  if (tools.length > 40) return true;
  const chars = tools.reduce((n, t) => n + t.description.length + JSON.stringify(t.parameters ?? {}).length, 0);
  return chars > 60_000;
}

const REVIEW_PROMPT =
  'You are a meticulous senior code reviewer. Find correctness bugs, security vulnerabilities, race conditions, error-handling gaps and breaking changes. ' +
  'Ignore style nitpicks. Be specific: file:line, the problem, a concrete fix. Read surrounding code when needed.';

function deriveTitle(text: string): string {
  const line = text.replace(/<[^>]+>/g, ' ').split('\n').map((l) => l.trim()).find(Boolean) ?? 'New session';
  return truncate(line.replace(/\s+/g, ' '), 60);
}

function hashLite(s: string): string {
  let h1 = 0xdeadbeef ^ s.length;
  let h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  return ((h2 >>> 0).toString(16) + (h1 >>> 0).toString(16)).padStart(16, '0');
}

function removeWorktreeSafe(wt: WorktreeInfo): void {
  try {
    removeWorktree(wt);
  } catch {
    /* ignore */
  }
}

export function unifiedDiff(file: string, before: string, after: string): string {
  return createTwoFilesPatch(`a/${file}`, `b/${file}`, before, after, '', '', { context: 3 });
}

/** Human-facing preview for approval prompts (diffs for edits, full command for shell). */
function approvalDetail(tool: Tool<any>, args: Record<string, any>, cwd: string): string | undefined {
  try {
    if (tool.name === 'bash') return [args.description ? `# ${args.description}` : '', String(args.command ?? '')].filter(Boolean).join('\n');
    if (tool.name === 'edit_file' || tool.name === 'write_file') {
      const abs = path.resolve(cwd, String(args.path ?? args.file_path ?? ''));
      const rel = displayPath(abs, cwd);
      let before = '';
      try {
        before = fs.readFileSync(abs, 'utf8');
      } catch {
        /* new file */
      }
      if (tool.name === 'write_file') return truncate(unifiedDiff(rel, before, String(args.content ?? '')), 12000);
      const r = applyEdit(before, String(args.old_string ?? ''), String(args.new_string ?? ''), Boolean(args.replace_all));
      if ('error' in r) return `--- ${rel}\n- ${String(args.old_string ?? '').split('\n').join('\n- ')}\n+ ${String(args.new_string ?? '').split('\n').join('\n+ ')}`;
      return truncate(unifiedDiff(rel, before, r.content), 12000);
    }
    if (tool.name === 'apply_patch') return truncate(String(args.patch ?? args.input ?? ''), 12000);
    if (tool.url) return tool.url(args);
    return describeArgs(args);
  } catch {
    return describeArgs(args);
  }
}

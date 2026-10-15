import { create } from 'zustand';
import { get as apiGet } from './api';
import type { AgentEvent, AgentItem, ApprovalRequest, Info, McpView, ModelOption, ProviderStatus, SlashCommandInfo } from './types';

export interface PendingApproval extends ApprovalRequest {
  agentId: string;
  /** set when the request comes from a sub-agent */
  subagent?: string;
}

export interface PendingQuestion {
  id: string;
  question: string;
  options?: string[];
}

export interface PendingPlan {
  id: string;
  markdown: string;
}

export interface AgentData {
  item: AgentItem;
  events: AgentEvent[];
  streams: Record<string, { text: string; reasoning: string }>;
  toolOutput: Record<string, string>;
  approvals: Record<string, PendingApproval>;
  questions: Record<string, PendingQuestion>;
  plans: Record<string, PendingPlan>;
  /** latest live activity of sub-agents, keyed by the parent's task tool-call id */
  subActivity: Record<string, string>;
  loaded: boolean;
  loading: boolean;
}

export interface TerminalRun {
  id: string;
  command: string;
  output: string;
  code?: number | null;
  startedAt: number;
}

interface State {
  info?: Info;
  connected: boolean;
  agents: Record<string, AgentData>;
  mcp: McpView[];
  providers: ProviderStatus[];
  models: ModelOption[];
  commands: SlashCommandInfo[];
  terminals: Record<string, TerminalRun>;
  terminalOrder: string[];
  paletteOpen: boolean;
  onboardingOpen: boolean;
  theme: 'dark' | 'light' | 'system';

  init(): Promise<void>;
  refreshInfo(): Promise<void>;
  refreshAgents(): Promise<void>;
  loadAgent(id: string, force?: boolean): Promise<void>;
  upsertAgent(item: AgentItem): void;
  removeAgent(id: string): void;
  refreshMcp(): Promise<void>;
  refreshProviders(discover?: boolean): Promise<void>;
  refreshCommands(): Promise<void>;
  handleWs(msg: any): void;
  setPalette(open: boolean): void;
  setOnboarding(open: boolean): void;
  setTheme(t: 'dark' | 'light' | 'system'): void;
  addTerminal(run: TerminalRun): void;
  clearTerminals(): void;
}

function emptyAgent(item: AgentItem): AgentData {
  return { item, events: [], streams: {}, toolOutput: {}, approvals: {}, questions: {}, plans: {}, subActivity: {}, loaded: false, loading: false };
}

/** Apply one event to an agent's state (immutable). */
export function applyEvent(a: AgentData, e: AgentEvent, agentId: string): AgentData {
  switch (e.type) {
    case 'text_delta':
    case 'reasoning_delta': {
      const cur = a.streams[e.id] ?? { text: '', reasoning: '' };
      const next = e.type === 'text_delta' ? { ...cur, text: cur.text + e.delta } : { ...cur, reasoning: cur.reasoning + e.delta };
      return { ...a, streams: { ...a.streams, [e.id]: next } };
    }
    case 'tool_output': {
      const prev = a.toolOutput[e.id] ?? '';
      const out = (prev + e.delta).slice(-200_000);
      return { ...a, toolOutput: { ...a.toolOutput, [e.id]: out } };
    }
    case 'status':
      return { ...a, item: { ...a.item, status: e.status } };
    case 'subagent': {
      const inner = e.event;
      if (inner.type === 'text_delta' || inner.type === 'reasoning_delta' || inner.type === 'tool_output' || inner.type === 'status') {
        if (inner.type !== 'text_delta') return a;
        const prev = a.subActivity[e.parentToolCallId] ?? '';
        return { ...a, subActivity: { ...a.subActivity, [e.parentToolCallId]: (prev + inner.delta).slice(-400) } };
      }
      if (inner.type === 'tool_start') {
        const next0 = { ...a, subActivity: { ...a.subActivity, [e.parentToolCallId]: '' } };
        a = next0;
      }
      break;
    }
    default:
      break;
  }
  const next: AgentData = { ...a, events: [...a.events, e] };
  switch (e.type) {
    case 'assistant_message': {
      const { [e.id]: _done, ...rest } = a.streams;
      next.streams = rest;
      break;
    }
    case 'approval_request':
      next.approvals = { ...a.approvals, [e.request.id]: { ...e.request, agentId } };
      break;
    case 'approval_response': {
      const { [e.id]: _r, ...rest } = a.approvals;
      next.approvals = rest;
      break;
    }
    case 'question':
      next.questions = { ...a.questions, [e.id]: { id: e.id, question: e.question, options: e.options } };
      break;
    case 'answer': {
      const { [e.id]: _q, ...rest } = a.questions;
      next.questions = rest;
      break;
    }
    case 'plan':
      if (e.status === 'proposed') next.plans = { ...a.plans, [e.id]: { id: e.id, markdown: e.markdown } };
      else {
        const { [e.id]: _p, ...rest } = a.plans;
        next.plans = rest;
      }
      break;
    case 'subagent': {
      const inner = e.event;
      if (inner.type === 'approval_request') next.approvals = { ...a.approvals, [inner.request.id]: { ...inner.request, agentId, subagent: e.agent } };
      else if (inner.type === 'approval_response') {
        const { [inner.id]: _s, ...rest } = a.approvals;
        next.approvals = rest;
      }
      break;
    }
    case 'turn_end':
      next.approvals = {};
      next.questions = {};
      next.plans = {};
      next.streams = {};
      break;
    case 'todos':
      next.item = { ...a.item, todos: e.todos };
      break;
    case 'usage':
      next.item = { ...a.item, totals: e.totals, contextTokens: e.contextTokens, contextWindow: e.contextWindow };
      break;
    case 'mode_change':
      next.item = { ...a.item, mode: e.mode };
      break;
    case 'model_change':
      next.item = { ...a.item, model: e.model };
      break;
    case 'title':
      next.item = { ...a.item, title: e.title };
      break;
    case 'user_message':
      next.item = { ...a.item, turn: e.turn };
      break;
    default:
      break;
  }
  return next;
}

export function flattenModels(providers: ProviderStatus[]): ModelOption[] {
  const out: ModelOption[] = [];
  for (const p of providers) {
    if (!p.configured || p.reachable === false) continue;
    for (const m of p.models) out.push({ ref: `${p.id}/${m.id}`, provider: p.id, providerName: p.name, id: m.id, free: m.free || p.category === 'local' || p.category === 'demo', local: p.category === 'local', contextWindow: m.contextWindow });
  }
  return out;
}

function applyTheme(t: 'dark' | 'light' | 'system') {
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.classList.toggle('light', !dark);
}

export const useStore = create<State>((set, get) => ({
  connected: false,
  agents: {},
  mcp: [],
  providers: [],
  models: [],
  commands: [],
  terminals: {},
  terminalOrder: [],
  paletteOpen: false,
  onboardingOpen: false,
  theme: ((): 'dark' | 'light' | 'system' => {
    try {
      return (localStorage.getItem('drakox.theme') as any) || 'dark';
    } catch {
      return 'dark';
    }
  })(),

  async init() {
    await Promise.all([get().refreshInfo(), get().refreshAgents(), get().refreshMcp(), get().refreshProviders(false), get().refreshCommands()]);
    const info = get().info;
    if (info?.demo && !localStorage.getItem('drakox.onboarded')) set({ onboardingOpen: true });
    void get().refreshProviders(true);
  },

  async refreshInfo() {
    set({ info: await apiGet<Info>('/api/info') });
  },

  async refreshAgents() {
    const list = await apiGet<AgentItem[]>('/api/agents');
    set((s) => {
      const agents: Record<string, AgentData> = {};
      for (const item of list) agents[item.id] = s.agents[item.id] ? { ...s.agents[item.id]!, item: { ...s.agents[item.id]!.item, ...item } } : emptyAgent(item);
      return { agents };
    });
  },

  async loadAgent(id, force = false) {
    const cur = get().agents[id];
    if (cur && (cur.loaded || cur.loading) && !force) return;
    set((s) => ({ agents: { ...s.agents, [id]: { ...(s.agents[id] ?? emptyAgent({ id } as AgentItem)), loading: true } } }));
    try {
      const d = await apiGet<{ agent: AgentItem; events: AgentEvent[]; pending: { approvals: string[]; questions: string[]; plans: string[] }; running: boolean }>(`/api/agents/${encodeURIComponent(id)}`);
      let data = emptyAgent(d.agent);
      for (const e of d.events) data = applyEvent(data, e, id);
      // only keep interactions that are really pending on the server
      const keep = <T,>(rec: Record<string, T>, ids: string[]) => Object.fromEntries(Object.entries(rec).filter(([k]) => ids.includes(k)));
      data = {
        ...data,
        item: d.agent,
        approvals: keep(data.approvals, d.pending.approvals),
        questions: keep(data.questions, d.pending.questions),
        plans: keep(data.plans, d.pending.plans),
        streams: {},
        loaded: true,
        loading: false,
      };
      set((s) => ({ agents: { ...s.agents, [id]: data } }));
    } catch (err) {
      set((s) => ({ agents: { ...s.agents, [id]: { ...(s.agents[id] ?? emptyAgent({ id } as AgentItem)), loading: false } } }));
      throw err;
    }
  },

  upsertAgent(item) {
    set((s) => {
      const cur = s.agents[item.id];
      return { agents: { ...s.agents, [item.id]: cur ? { ...cur, item: { ...cur.item, ...item } } : emptyAgent(item) } };
    });
  },

  removeAgent(id) {
    set((s) => {
      const { [id]: _gone, ...rest } = s.agents;
      return { agents: rest };
    });
  },

  async refreshMcp() {
    set({ mcp: await apiGet<McpView[]>('/api/mcp') });
  },

  async refreshProviders(discover = true) {
    const providers = await apiGet<ProviderStatus[]>(`/api/providers${discover ? '?discover=1' : ''}`);
    set({ providers, models: flattenModels(providers) });
  },

  async refreshCommands() {
    set({ commands: await apiGet<SlashCommandInfo[]>('/api/commands') });
  },

  handleWs(msg) {
    switch (msg.type) {
      case 'event': {
        const id: string = msg.agentId;
        const cur = get().agents[id];
        if (!cur) {
          // a new agent we have not seen yet
          void get().refreshAgents();
          return;
        }
        set((s) => ({ agents: { ...s.agents, [id]: applyEvent(s.agents[id]!, msg.event, id) } }));
        break;
      }
      case 'agent':
        get().upsertAgent(msg.agent);
        break;
      case 'removed':
        get().removeAgent(msg.id);
        break;
      case 'mcp':
        void get().refreshMcp();
        void get().refreshCommands();
        break;
      case 'config':
        void get().refreshInfo();
        void get().refreshMcp();
        void get().refreshProviders(true);
        void get().refreshCommands();
        break;
      case 'terminal': {
        const t = get().terminals[msg.id];
        if (!t) return;
        set((s) => ({ terminals: { ...s.terminals, [msg.id]: { ...t, output: (t.output + msg.data).slice(-300_000) } } }));
        break;
      }
      case 'terminal_exit': {
        const t = get().terminals[msg.id];
        if (!t) return;
        set((s) => ({ terminals: { ...s.terminals, [msg.id]: { ...t, code: msg.code } } }));
        break;
      }
      default:
        break;
    }
  },

  setPalette(open) {
    set({ paletteOpen: open });
  },
  setOnboarding(open) {
    if (!open) localStorage.setItem('drakox.onboarded', '1');
    set({ onboardingOpen: open });
  },
  setTheme(t) {
    localStorage.setItem('drakox.theme', t);
    applyTheme(t);
    set({ theme: t });
  },
  addTerminal(run) {
    set((s) => ({ terminals: { ...s.terminals, [run.id]: run }, terminalOrder: [...s.terminalOrder, run.id].slice(-20) }));
  },
  clearTerminals() {
    set({ terminals: {}, terminalOrder: [] });
  },
}));

/** All pending approvals across agents (Mission Control inbox). */
export function selectInbox(s: State): PendingApproval[] {
  return Object.values(s.agents)
    .flatMap((a) => Object.values(a.approvals))
    .sort((a, b) => a.id.localeCompare(b.id));
}

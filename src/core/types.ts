/**
 * DrakoX core types.
 *
 * The event model is the backbone of DrakoX: every agent action is an event.
 * Persistent events are appended to a JSONL log (crash-safe, replayable, auditable);
 * ephemeral events (streaming deltas) only feed live UIs.
 */

// ───────────────────────────── Messages ─────────────────────────────

export interface TextPart {
  type: 'text';
  text: string;
}
export interface ImagePart {
  type: 'image';
  mediaType: string;
  /** base64 (no data: prefix) */
  data: string;
}
export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Opaque provider-specific data that must round-trip (e.g. Anthropic thinking signatures). */
export interface ProviderMeta {
  anthropicThinking?: { thinking: string; signature: string }[];
}

export type ChatMessage =
  | { role: 'user'; content: string | ContentPart[] }
  | {
      role: 'assistant';
      content: string;
      reasoning?: string;
      toolCalls?: ToolCall[];
      providerMeta?: ProviderMeta;
    }
  | {
      role: 'tool';
      toolCallId: string;
      name: string;
      content: string | ContentPart[];
      isError?: boolean;
    };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  /** true when at least one call had unknown pricing */
  costPartial: boolean;
  requests: number;
}

// ───────────────────────────── Modes & permissions ─────────────────────────────

/**
 * Approval presets (the "approval dial").
 * - plan:      research only, no edits/commands with side effects; ends by submitting a plan
 * - ask:       reads are automatic, edits and commands ask
 * - auto-edit: edits inside the workspace are automatic, risky commands ask
 * - autopilot: everything automatic except deny rules (runs inside the OS sandbox when available)
 */
export type Mode = 'plan' | 'ask' | 'auto-edit' | 'autopilot';
export const MODES: Mode[] = ['plan', 'ask', 'auto-edit', 'autopilot'];

/** What commands can technically touch (the "sandbox dial"), independent of approvals. */
export type SandboxMode = 'read-only' | 'workspace-write' | 'full-access';

export type ToolKind = 'read' | 'edit' | 'execute' | 'network' | 'meta' | 'mcp';

export type ApprovalDecision = 'allow_once' | 'allow_always' | 'deny';

export interface ApprovalRequest {
  id: string;
  toolCallId: string;
  tool: string;
  kind: ToolKind;
  title: string;
  /** Extra detail shown to the user: a diff preview, full command, arguments… */
  detail?: string;
  /** Why approval is needed (human-readable) */
  reason: string;
  /** Rule that "always allow" would add, e.g. `bash(npm test*)` */
  ruleSuggestion?: string;
  /** Session id of the agent (or sub-agent) that is waiting */
  agent?: string;
}

// ───────────────────────────── Artifacts ─────────────────────────────

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface Artifact {
  id: string;
  kind: 'plan' | 'walkthrough' | 'review' | 'screenshot' | 'note';
  title: string;
  markdown?: string;
  image?: { mediaType: string; data: string };
}

export type ToolDisplay =
  | {
      kind: 'diff';
      path: string;
      diff: string;
      added: number;
      removed: number;
      isNew?: boolean;
      isDelete?: boolean;
    }
  | { kind: 'terminal'; command: string; exitCode: number | null; output: string; background?: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'images'; images: { mediaType: string; data: string }[] }
  | { kind: 'multi'; items: ToolDisplay[] };

export type SessionStatus = 'idle' | 'running' | 'awaiting_input' | 'error';

export type TurnEndReason = 'completed' | 'aborted' | 'error' | 'max_turns' | 'budget' | 'plan_submitted';

// ───────────────────────────── Events ─────────────────────────────

interface Base {
  ts: number;
}

export type AgentEvent =
  | ({ type: 'session_start'; sessionId: string; cwd: string; model: string; mode: Mode; title?: string; parentId?: string; worktree?: WorktreeInfo } & Base)
  | ({ type: 'user_message'; id: string; turn: number; content: string; images?: ImagePart[]; displayText?: string } & Base)
  | ({ type: 'assistant_start'; id: string; model: string } & Base)
  | ({ type: 'text_delta'; id: string; delta: string } & Base)
  | ({ type: 'reasoning_delta'; id: string; delta: string } & Base)
  | ({
      type: 'assistant_message';
      id: string;
      content: string;
      reasoning?: string;
      toolCalls?: ToolCall[];
      providerMeta?: ProviderMeta;
      model: string;
      usage?: Usage;
      stopReason?: string;
      durationMs?: number;
    } & Base)
  | ({ type: 'tool_start'; id: string; name: string; args: Record<string, unknown>; title: string; kind: ToolKind } & Base)
  | ({ type: 'tool_output'; id: string; delta: string } & Base)
  | ({
      type: 'tool_result';
      id: string;
      name: string;
      isError: boolean;
      content: string | ContentPart[];
      display?: ToolDisplay;
      durationMs: number;
    } & Base)
  | ({ type: 'approval_request'; request: ApprovalRequest } & Base)
  | ({ type: 'approval_response'; id: string; decision: ApprovalDecision; feedback?: string; auto?: boolean; rule?: string } & Base)
  | ({ type: 'question'; id: string; toolCallId: string; question: string; options?: string[] } & Base)
  | ({ type: 'answer'; id: string; answer: string } & Base)
  | ({ type: 'file_change'; path: string; before: string | null; after: string | null; turn: number; toolCallId?: string } & Base)
  | ({ type: 'todos'; todos: Todo[] } & Base)
  | ({ type: 'plan'; id: string; markdown: string; status: 'proposed' | 'approved' | 'rejected'; feedback?: string; mode?: Mode } & Base)
  | ({ type: 'artifact'; artifact: Artifact } & Base)
  | ({ type: 'usage'; usage: Usage; costUsd: number | null; totals: UsageTotals; contextTokens: number; contextWindow: number } & Base)
  | ({ type: 'compaction'; summary: string; removedMessages: number; keptMessages: number } & Base)
  | ({ type: 'rewind'; toTurn: number; restoredFiles: string[]; /** false = code-only rewind */ conversation?: boolean } & Base)
  | ({ type: 'mode_change'; mode: Mode } & Base)
  | ({ type: 'model_change'; model: string } & Base)
  | ({ type: 'status'; status: SessionStatus; detail?: string } & Base)
  | ({ type: 'notice'; level: 'info' | 'warning' | 'error'; message: string } & Base)
  | ({ type: 'error'; message: string; recoverable?: boolean } & Base)
  | ({ type: 'turn_end'; turn: number; reason: TurnEndReason; message?: string } & Base)
  | ({ type: 'subagent'; parentToolCallId: string; agent: string; childId: string; event: AgentEvent } & Base)
  | ({ type: 'title'; title: string } & Base);

export type AgentEventType = AgentEvent['type'];

/** Events that are streamed live but never written to the session log. */
export const EPHEMERAL_EVENTS: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
  'text_delta',
  'reasoning_delta',
  'tool_output',
  'status',
]);

export function isPersistent(e: AgentEvent): boolean {
  if (e.type === 'subagent') return isPersistent(e.event);
  return !EPHEMERAL_EVENTS.has(e.type);
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseRef: string;
  repoRoot: string;
}

// ───────────────────────────── Configuration ─────────────────────────────

export type ProviderType = 'openai' | 'anthropic' | 'ollama' | 'demo';

export interface ProviderConfig {
  type: ProviderType;
  /** Display name */
  name?: string;
  baseURL?: string;
  apiKey?: string;
  /** Environment variable that holds the API key */
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  /** Static model list (merged with discovered models) */
  models?: string[];
  enabled?: boolean;
  /** Ollama: context length to request (num_ctx). Default 32768. */
  numCtx?: number;
}

export type McpTransportType = 'stdio' | 'http' | 'sse';

export interface McpServerConfig {
  type?: McpTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  /** Tools that never need approval. `true` = all tools of this server. */
  autoApprove?: string[] | boolean;
  /** Request timeout for tool calls */
  timeoutMs?: number;
  /** Catalog entry this server was installed from */
  catalogId?: string;
  /** Use OAuth (remote servers that require browser sign-in) */
  oauth?: boolean;
}

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'SessionStart' | 'SessionEnd' | 'Notification';

export interface HookConfig {
  /** Regex matched against the tool name (PreToolUse / PostToolUse). Empty = all. */
  matcher?: string;
  command: string;
  timeoutMs?: number;
}

export interface WebSearchConfig {
  provider: 'brave' | 'tavily' | 'searxng' | 'exa';
  apiKey?: string;
  apiKeyEnv?: string;
  baseURL?: string;
}

export interface DrakoxConfig {
  /** Default model reference: `<provider>/<model>` e.g. `ollama/qwen3-coder:30b` */
  model?: string;
  /** Role-specific models */
  models?: {
    /** Sub-agents / exploration */
    fast?: string;
    /** Code review (/review, auto-review) */
    review?: string;
    /** Editor Tab-completion */
    autocomplete?: string;
    /** Conversation compaction */
    compact?: string;
  };
  mode?: Mode;
  sandbox?: SandboxMode;
  providers?: Record<string, ProviderConfig>;
  mcpServers?: Record<string, McpServerConfig>;
  permissions?: {
    allow?: string[];
    ask?: string[];
    deny?: string[];
    /** Glob patterns that always require approval to read or write */
    sensitivePaths?: string[];
    /** Allow network inside the OS sandbox (default false) */
    sandboxNetwork?: boolean;
  };
  hooks?: Partial<Record<HookEvent, HookConfig[]>>;
  instructions?: {
    /** Budget for project instruction files; overflow is reported, never silent. Default 65536. */
    maxBytes?: number;
    /** Extra instruction files to always include */
    extraFiles?: string[];
    /** Disable reading CLAUDE.md / GEMINI.md / .cursorrules / copilot instructions */
    disableCompat?: boolean;
  };
  webSearch?: WebSearchConfig;
  budget?: {
    /** Stop a session when its estimated cost exceeds this (USD) */
    sessionUsd?: number;
  };
  /** Max model round-trips per user turn. Default 60. */
  maxTurns?: number;
  /** Background reviewer agent after edits (Muse-style). Default false. */
  autoReview?: boolean;
  autoCompact?: boolean;
  /**
   * Load integration (MCP) tools on demand via a `tool_search` tool instead of sending every schema
   * on every request. `auto` (default) defers when there are more than 40 tools or ~60k chars of schemas.
   */
  mcpToolSearch?: 'auto' | 'on' | 'off';
  /** Fraction of the context window that triggers compaction. Default 0.8. */
  compactThreshold?: number;
  /** Price overrides, USD per 1M tokens, keyed by model reference or model id */
  pricing?: Record<string, { input: number; output: number; cachedInput?: number }>;
  /** Context window overrides keyed by model reference or model id */
  contextWindows?: Record<string, number>;
  /** Shell used by the bash tool */
  shell?: string;
  /** Reasoning effort hint for models that support it */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Append Co-authored-by trailers or similar? DrakoX never injects hidden git metadata. */
  gitTrailers?: boolean;
  ui?: {
    theme?: 'dark' | 'light' | 'system';
    accent?: string;
  };
}

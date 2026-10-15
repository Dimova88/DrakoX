import type { AgentEvent, ContentPart, DrakoxConfig, Mode, Todo, ToolDisplay, ToolKind } from '../types.js';
import type { SandboxInfo } from '../sandbox.js';
import type { BackgroundShells } from './shell.js';

export interface ToolResult {
  content: string | ContentPart[];
  isError?: boolean;
  display?: ToolDisplay;
}

export interface SubagentRequest {
  description: string;
  prompt: string;
  agentType?: string;
  model?: string;
  isolation?: 'none' | 'worktree';
}

export interface PlanDecision {
  approved: boolean;
  mode?: Mode;
  feedback?: string;
}

export interface ToolContext {
  /** Working directory of the agent (may be a git worktree) */
  cwd: string;
  /** Project root (git root or cwd) */
  projectRoot: string;
  sessionId: string;
  turn: number;
  toolCallId: string;
  signal: AbortSignal;
  config: DrakoxConfig;
  sandbox: SandboxInfo;
  mode: Mode;
  /** Emit a session event (todos, artifacts…) */
  emit(event: AgentEvent): void;
  /** Stream partial output (bash) to live UIs */
  output(delta: string): void;
  /** Record a file mutation for checkpoints / rewind */
  recordFileChange(absPath: string, before: string | null, after: string | null): void;
  /** abs path → mtimeMs when last read by the agent (read-before-write safety) */
  readTracker: Map<string, number>;
  shells: BackgroundShells;
  todos: { get(): Todo[]; set(todos: Todo[]): void };
  askUser?(question: string, options?: string[]): Promise<string>;
  submitPlan?(markdown: string): Promise<PlanDecision>;
  runSubagent?(req: SubagentRequest): Promise<string>;
  loadSkill?(name: string): Promise<string | undefined>;
}

export interface Tool<A extends Record<string, any> = Record<string, any>> {
  name: string;
  description: string;
  /** JSON Schema for the arguments */
  parameters: Record<string, unknown>;
  kind: ToolKind;
  /** Safe to run concurrently with other parallel-safe tools in the same step */
  parallelSafe?: boolean;
  /** Short human-readable title, e.g. "Edit src/app.ts" */
  title(args: A, cwd: string): string;
  /** Absolute paths touched (used for permission checks) */
  paths?(args: A, cwd: string): string[];
  /** Shell command (execute tools) used for permission rules */
  command?(args: A): string;
  /** URL (network tools) */
  url?(args: A): string | undefined;
  /** MCP tool annotations */
  annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean; server?: string; tool?: string };
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
}

export function textResult(text: string, display?: ToolDisplay): ToolResult {
  return { content: text, display };
}

export function errorResult(text: string): ToolResult {
  return { content: text, isError: true };
}

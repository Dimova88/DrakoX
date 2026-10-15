import type { ChatMessage, ProviderMeta, ToolCall, Usage } from '../types.js';

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (object) */
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  /** A tool call started streaming (for live UI) */
  | { type: 'tool_call_start'; id: string; name: string }
  | {
      type: 'done';
      stopReason?: string;
      usage: Usage;
      toolCalls: ToolCall[];
      providerMeta?: ProviderMeta;
    };

export interface ModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  /** Capability hints */
  tools?: boolean;
  vision?: boolean;
  free?: boolean;
}

export interface Provider {
  readonly id: string;
  readonly type: string;
  stream(req: ModelRequest): AsyncGenerator<StreamEvent>;
  /** Discover models (local servers / `/models` endpoints). */
  listModels?(signal?: AbortSignal): Promise<ModelInfo[]>;
  /** Fill-in-the-middle / short completion for editor Tab completion. */
  complete?(opts: { model: string; prompt: string; suffix?: string; maxTokens?: number; stop?: string[]; signal?: AbortSignal }): Promise<string>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public status?: number,
    public retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Parse tool-call argument JSON leniently (models sometimes emit trailing junk). */
export function parseToolArgs(text: string | undefined | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v };
  } catch {
    // try to recover the largest valid JSON object prefix
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* fallthrough */
      }
    }
    return { __invalid_json__: text };
  }
}

export async function readErrorBody(res: Response): Promise<string> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    /* ignore */
  }
  try {
    const j = JSON.parse(text);
    const msg = j?.error?.message ?? j?.message ?? j?.error ?? j?.detail;
    if (msg) return typeof msg === 'string' ? msg : JSON.stringify(msg);
  } catch {
    /* not json */
  }
  return text.slice(0, 500) || res.statusText;
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

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

export type ProviderErrorKind = 'network' | 'auth' | 'http';

export class ProviderError extends Error {
  /** network = the host could not be reached · auth = the key was rejected · http = other API error */
  readonly kind?: ProviderErrorKind;
  constructor(
    message: string,
    public status?: number,
    public retryable = false,
    kind?: ProviderErrorKind,
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind ?? (status === 401 || status === 403 ? 'auth' : status ? 'http' : undefined);
  }
}

/**
 * Explain a failed connection instead of Node's opaque "fetch failed":
 * which host, what went wrong (DNS, refused, reset, timeout, TLS) and what to check.
 */
export function describeNetworkError(err: unknown, url: string, who?: string): string {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep raw */
  }
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string; errors?: { code?: string }[] } };
  const cause = e?.cause ?? {};
  const code = cause.code ?? cause.errors?.[0]?.code ?? e?.code ?? '';
  const detail = `${code} ${cause.message ?? ''} ${e?.message ?? ''}`;
  let reason: string;
  if (e?.name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || /timed? ?out/i.test(detail)) reason = 'the connection timed out';
  else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') reason = 'the host name could not be resolved (no internet connection, a DNS problem, or a typo in the URL)';
  else if (code === 'ECONNREFUSED') reason = 'the connection was refused (is the server running at that address?)';
  else if (code === 'ECONNRESET' || /socket disconnected|socket hang up|before secure TLS/i.test(detail))
    reason = 'the connection was cut before it was established, which usually means a firewall, proxy or VPN is blocking this host';
  else if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') reason = 'the network is unreachable';
  else if (/CERT|certificate|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(detail))
    reason = 'TLS certificate verification failed (behind a corporate proxy? point NODE_EXTRA_CA_CERTS at its CA certificate)';
  else reason = (cause.message || e?.message || String(err)).replace(/^fetch failed$/, 'network error');
  return `Can't reach ${host}${who ? ` (${who})` : ''}: ${reason}.`;
}

/** fetch() for provider APIs: user aborts pass through, connection failures become network ProviderErrors. */
export async function providerFetch(who: string, url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ProviderError(describeNetworkError(err, url, who), undefined, true, 'network');
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

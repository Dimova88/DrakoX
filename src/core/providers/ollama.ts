import type { ChatMessage, ToolCall, Usage } from '../types.js';
import { parseNDJSON } from './sse.js';
import { ProviderError, readErrorBody, type ModelInfo, type ModelRequest, type Provider, type StreamEvent } from './types.js';
import { uid } from '../util.js';

/**
 * Native Ollama adapter (local, free, unlimited, private).
 * Uses /api/chat so we can request a real context length (num_ctx) — Ollama's OpenAI-compatible
 * endpoint silently uses a small default context, which cripples coding agents.
 */
export class OllamaProvider implements Provider {
  readonly type = 'ollama';
  constructor(
    readonly id: string,
    private opts: { baseURL?: string; numCtx?: number; headers?: Record<string, string> },
  ) {}

  private base(): string {
    return (this.opts.baseURL || 'http://localhost:11434').replace(/\/+$/, '').replace(/\/v1$/, '').replace(/\/api$/, '');
  }

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model: req.model,
      stream: true,
      messages: toOllamaMessages(req.system, req.messages),
      options: { num_ctx: this.opts.numCtx ?? 32768, ...(req.temperature != null ? { temperature: req.temperature } : {}) },
    };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    let res: Response;
    try {
      res = await fetch(`${this.base()}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.opts.headers ?? {}) },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new ProviderError(`Cannot reach Ollama at ${this.base()} — is it running? (ollama serve)`, undefined, true);
    }
    if (!res.ok || !res.body) {
      const msg = await readErrorBody(res);
      if (/does not support tools/i.test(msg)) {
        throw new ProviderError(`${req.model} does not support tool calling. Try qwen3-coder, qwen2.5-coder, llama3.1, mistral-small or gpt-oss.`, res.status);
      }
      if (res.status === 404) throw new ProviderError(`Model "${req.model}" not found in Ollama. Run: ollama pull ${req.model}`, 404);
      throw new ProviderError(`ollama (${res.status}): ${msg}`, res.status, res.status >= 500);
    }
    const toolCalls: ToolCall[] = [];
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: string | undefined;
    let inThink = false;
    for await (const chunk of parseNDJSON(res.body)) {
      if (chunk.error) throw new ProviderError(`ollama: ${chunk.error}`);
      const msg = chunk.message ?? {};
      if (msg.thinking) yield { type: 'reasoning', delta: msg.thinking };
      if (msg.content) {
        let text: string = msg.content;
        // handle inline <think> blocks for models without native thinking support
        while (text.length) {
          if (inThink) {
            const end = text.indexOf('</think>');
            if (end === -1) {
              yield { type: 'reasoning', delta: text };
              text = '';
            } else {
              if (end) yield { type: 'reasoning', delta: text.slice(0, end) };
              text = text.slice(end + 8);
              inThink = false;
            }
          } else {
            const start = text.indexOf('<think>');
            if (start === -1) {
              yield { type: 'text', delta: text };
              text = '';
            } else {
              if (start) yield { type: 'text', delta: text.slice(0, start) };
              text = text.slice(start + 7);
              inThink = true;
            }
          }
        }
      }
      for (const tc of msg.tool_calls ?? []) {
        const id = tc.id || uid('call_');
        const name = tc.function?.name ?? '';
        let args = tc.function?.arguments ?? {};
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            args = { __invalid_json__: args };
          }
        }
        toolCalls.push({ id, name, args });
        yield { type: 'tool_call_start', id, name };
      }
      if (chunk.done) {
        usage.inputTokens = chunk.prompt_eval_count ?? 0;
        usage.outputTokens = chunk.eval_count ?? 0;
        stopReason = chunk.done_reason ?? 'stop';
      }
    }
    yield { type: 'done', stopReason, usage, toolCalls };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await fetch(`${this.base()}/api/tags`, { signal, headers: this.opts.headers });
    if (!res.ok) throw new ProviderError(`ollama: ${await readErrorBody(res)}`, res.status);
    const j: any = await res.json();
    return (j.models ?? []).map((m: any) => ({
      id: m.name ?? m.model,
      name: m.details?.parameter_size ? `${m.name} (${m.details.parameter_size})` : m.name,
      free: true,
    }));
  }

  async complete(opts: { model: string; prompt: string; suffix?: string; maxTokens?: number; stop?: string[]; signal?: AbortSignal }): Promise<string> {
    // Native fill-in-the-middle for FIM-capable models (qwen2.5-coder, codestral, starcoder2, deepseek-coder…)
    const res = await fetch(`${this.base()}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.opts.headers ?? {}) },
      signal: opts.signal,
      body: JSON.stringify({
        model: opts.model,
        prompt: opts.prompt,
        suffix: opts.suffix ?? '',
        stream: false,
        options: { temperature: 0.1, num_predict: opts.maxTokens ?? 128, stop: opts.stop },
      }),
    });
    if (!res.ok) throw new ProviderError(`ollama: ${await readErrorBody(res)}`, res.status);
    const j: any = await res.json();
    return String(j.response ?? '');
  }
}

export function toOllamaMessages(system: string, messages: ChatMessage[]): any[] {
  const out: any[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') out.push({ role: 'user', content: m.content });
      else {
        out.push({
          role: 'user',
          content: m.content
            .filter((p) => p.type === 'text')
            .map((p) => (p as { text: string }).text)
            .join('\n'),
          images: m.content.filter((p) => p.type === 'image').map((p) => (p as { data: string }).data),
        });
      }
    } else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls?.length ? m.toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.args ?? {} } })) : undefined,
      });
    } else {
      const text = typeof m.content === 'string' ? m.content : m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
      const images = typeof m.content === 'string' ? [] : m.content.filter((p) => p.type === 'image').map((p) => (p as { data: string }).data);
      out.push({ role: 'tool', content: text, tool_name: m.name, ...(images.length ? { images } : {}) });
    }
  }
  return out;
}

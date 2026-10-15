import type { ChatMessage, ContentPart, ProviderMeta, ToolCall, Usage } from '../types.js';
import { parseSSE } from './sse.js';
import {
  ProviderError,
  isRetryableStatus,
  parseToolArgs,
  readErrorBody,
  type ModelInfo,
  type ModelRequest,
  type Provider,
  type StreamEvent,
} from './types.js';
import { stripFences } from './openai.js';

/** Native Anthropic Messages API adapter with prompt caching and extended thinking. */
export class AnthropicProvider implements Provider {
  readonly type = 'anthropic';
  constructor(
    readonly id: string,
    private opts: { baseURL?: string; apiKey?: string; headers?: Record<string, string> },
  ) {}

  private base(): string {
    return (this.opts.baseURL || 'https://api.anthropic.com').replace(/\/+$/, '').replace(/\/v1$/, '');
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(this.opts.apiKey ? { 'x-api-key': this.opts.apiKey } : {}),
      ...(this.opts.headers ?? {}),
    };
  }

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    const thinkingBudget = req.reasoningEffort ? { low: 2048, medium: 8192, high: 24000 }[req.reasoningEffort] : 0;
    const maxTokens = Math.max(req.maxTokens ?? 16000, thinkingBudget + 4096);
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: maxTokens,
      stream: true,
      system: req.system ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }] : undefined,
      messages: toAnthropicMessages(req.messages),
    };
    if (req.tools.length) {
      const tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      (tools[tools.length - 1] as any).cache_control = { type: 'ephemeral' };
      body.tools = tools;
    }
    if (thinkingBudget) body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
    else if (req.temperature != null) body.temperature = req.temperature;

    let res: Response;
    try {
      res = await fetch(`${this.base()}/v1/messages`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: req.signal });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new ProviderError(`Cannot reach Anthropic: ${(err as Error).message}`, undefined, true);
    }
    if (!res.ok || !res.body) {
      throw new ProviderError(`${this.id} (${res.status}): ${await readErrorBody(res)}`, res.status, isRetryableStatus(res.status));
    }

    const blocks: Record<number, { type: string; id?: string; name?: string; json: string; thinking?: string; signature?: string }> = {};
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: string | undefined;

    for await (const ev of parseSSE(res.body)) {
      let d: any;
      try {
        d = JSON.parse(ev.data);
      } catch {
        continue;
      }
      switch (d.type) {
        case 'message_start': {
          const u = d.message?.usage ?? {};
          usage.inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          usage.cachedInputTokens = u.cache_read_input_tokens ?? 0;
          usage.outputTokens = u.output_tokens ?? 0;
          break;
        }
        case 'content_block_start': {
          const b = d.content_block ?? {};
          blocks[d.index] = { type: b.type, id: b.id, name: b.name, json: '', thinking: '', signature: '' };
          if (b.type === 'tool_use') yield { type: 'tool_call_start', id: b.id, name: b.name };
          break;
        }
        case 'content_block_delta': {
          const blk = blocks[d.index];
          const delta = d.delta ?? {};
          if (delta.type === 'text_delta') yield { type: 'text', delta: delta.text };
          else if (delta.type === 'thinking_delta') {
            if (blk) blk.thinking += delta.thinking;
            yield { type: 'reasoning', delta: delta.thinking };
          } else if (delta.type === 'signature_delta' && blk) blk.signature += delta.signature;
          else if (delta.type === 'input_json_delta' && blk) blk.json += delta.partial_json;
          break;
        }
        case 'message_delta':
          if (d.delta?.stop_reason) stopReason = d.delta.stop_reason;
          if (d.usage?.output_tokens != null) usage.outputTokens = d.usage.output_tokens;
          break;
        case 'error':
          throw new ProviderError(`${this.id}: ${d.error?.message ?? 'stream error'}`, undefined, d.error?.type === 'overloaded_error');
      }
    }

    const ordered = Object.keys(blocks)
      .map(Number)
      .sort((a, b) => a - b)
      .map((i) => blocks[i]!);
    const toolCalls: ToolCall[] = ordered
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id!, name: b.name!, args: parseToolArgs(b.json || '{}') }));
    const thinking = ordered.filter((b) => b.type === 'thinking' && b.signature).map((b) => ({ thinking: b.thinking ?? '', signature: b.signature! }));
    const providerMeta: ProviderMeta | undefined = thinking.length ? { anthropicThinking: thinking } : undefined;
    yield { type: 'done', stopReason, usage, toolCalls, providerMeta };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await fetch(`${this.base()}/v1/models?limit=100`, { headers: this.headers(), signal });
    if (!res.ok) throw new ProviderError(`${this.id}: ${await readErrorBody(res)}`, res.status);
    const j: any = await res.json();
    return (j.data ?? []).map((m: any) => ({ id: m.id, name: m.display_name, contextWindow: 200_000, tools: true, vision: true }));
  }

  async complete(opts: { model: string; prompt: string; suffix?: string; maxTokens?: number; stop?: string[]; signal?: AbortSignal }): Promise<string> {
    const res = await fetch(`${this.base()}/v1/messages`, {
      method: 'POST',
      headers: this.headers(),
      signal: opts.signal,
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 128,
        temperature: 0.1,
        stop_sequences: opts.stop?.length ? opts.stop : undefined,
        system: 'You are a code completion engine. Output ONLY the code to insert at <CURSOR>. No explanations, no markdown fences.',
        messages: [{ role: 'user', content: `${opts.prompt}<CURSOR>${opts.suffix ?? ''}` }],
      }),
    });
    if (!res.ok) throw new ProviderError(`${this.id}: ${await readErrorBody(res)}`, res.status);
    const j: any = await res.json();
    return stripFences((j.content ?? []).map((c: any) => c.text ?? '').join(''));
  }
}

function partsToAnthropic(content: string | ContentPart[]): any[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return content.map((p) =>
    p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } },
  );
}

export function toAnthropicMessages(messages: ChatMessage[]): any[] {
  const out: { role: 'user' | 'assistant'; content: any[] }[] = [];
  const push = (role: 'user' | 'assistant', blocks: any[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', partsToAnthropic(m.content));
    else if (m.role === 'assistant') {
      const blocks: any[] = [];
      for (const t of m.providerMeta?.anthropicThinking ?? []) blocks.push({ type: 'thinking', thinking: t.thinking, signature: t.signature });
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args ?? {} });
      if (!blocks.length) blocks.push({ type: 'text', text: '(no content)' });
      push('assistant', blocks);
    } else {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: typeof m.content === 'string' ? m.content || '(empty)' : partsToAnthropic(m.content),
          is_error: m.isError || undefined,
        },
      ]);
    }
  }
  // cache breakpoint on the last block of the final message (incremental conversation caching)
  const last = out[out.length - 1];
  if (last?.content.length) {
    const blk = last.content[last.content.length - 1];
    if (blk && blk.type !== 'thinking') blk.cache_control = { type: 'ephemeral' };
  }
  return out;
}

import type { ChatMessage, ContentPart, ToolCall, Usage } from '../types.js';
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

/**
 * OpenAI-compatible Chat Completions adapter.
 * Works with OpenAI, OpenRouter, Groq, Gemini (OpenAI endpoint), Mistral, DeepSeek, xAI, Together,
 * Fireworks, Cerebras, GitHub Models, LM Studio, llama.cpp server, vLLM, Ollama `/v1` and more.
 */
export class OpenAICompatibleProvider implements Provider {
  readonly type = 'openai';
  constructor(
    readonly id: string,
    private opts: { baseURL: string; apiKey?: string; headers?: Record<string, string> },
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...(this.opts.headers ?? {}) };
    if (this.opts.apiKey) h.authorization = `Bearer ${this.opts.apiKey}`;
    if (this.opts.baseURL.includes('openrouter.ai')) {
      h['HTTP-Referer'] ??= 'https://github.com/Dimova88/DrakoX';
      h['X-Title'] ??= 'DrakoX';
    }
    return h;
  }

  private url(p: string): string {
    return this.opts.baseURL.replace(/\/+$/, '') + p;
  }

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    const isOpenAI = /api\.openai\.com/.test(this.opts.baseURL);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAIMessages(req.system, req.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (req.maxTokens) body[isOpenAI ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens;
    if (req.temperature != null) body.temperature = req.temperature;
    if (req.reasoningEffort && isOpenAI) body.reasoning_effort = req.reasoningEffort;

    let res: Response;
    try {
      res = await fetch(this.url('/chat/completions'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new ProviderError(`Cannot reach ${this.id} at ${this.opts.baseURL}: ${(err as Error).message}`, undefined, true);
    }
    if (!res.ok || !res.body) {
      const msg = await readErrorBody(res);
      // Some providers reject stream_options; retry once without it.
      if (res.status === 400 && /stream_options/i.test(msg)) {
        delete body.stream_options;
        res = await fetch(this.url('/chat/completions'), { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: req.signal });
        if (!res.ok || !res.body) throw new ProviderError(`${this.id}: ${await readErrorBody(res)}`, res.status, isRetryableStatus(res.status));
      } else {
        throw new ProviderError(`${this.id} (${res.status}): ${msg}`, res.status, isRetryableStatus(res.status));
      }
    }

    const calls: { id: string; name: string; args: string }[] = [];
    const byIndex = new Map<number, number>();
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: string | undefined;
    let inThink = false; // <think> tag handling for models that inline reasoning

    for await (const ev of parseSSE(res.body)) {
      if (ev.data === '[DONE]') break;
      let chunk: any;
      try {
        chunk = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (chunk.error) throw new ProviderError(`${this.id}: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? undefined,
          reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? undefined,
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? choice.message ?? {};
      const reasoning = d.reasoning_content ?? d.reasoning;
      if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning', delta: reasoning };
      if (typeof d.content === 'string' && d.content) {
        // split inline <think>…</think> blocks (DeepSeek-R1 / Qwen style) into reasoning
        let text: string = d.content;
        while (text.length) {
          if (inThink) {
            const end = text.indexOf('</think>');
            if (end === -1) {
              yield { type: 'reasoning', delta: text };
              text = '';
            } else {
              if (end > 0) yield { type: 'reasoning', delta: text.slice(0, end) };
              text = text.slice(end + 8);
              inThink = false;
            }
          } else {
            const start = text.indexOf('<think>');
            if (start === -1) {
              yield { type: 'text', delta: text };
              text = '';
            } else {
              if (start > 0) yield { type: 'text', delta: text.slice(0, start) };
              text = text.slice(start + 7);
              inThink = true;
            }
          }
        }
      }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          let slot: number | undefined;
          if (typeof tc.index === 'number') slot = byIndex.get(tc.index);
          else if (tc.id) slot = calls.findIndex((c) => c.id === tc.id);
          if (slot === undefined || slot === -1) {
            slot = calls.length;
            calls.push({ id: tc.id || `call_${Math.random().toString(36).slice(2, 11)}`, name: '', args: '' });
            if (typeof tc.index === 'number') byIndex.set(tc.index, slot);
          }
          const c = calls[slot]!;
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) {
            const wasEmpty = !c.name;
            c.name += tc.function.name;
            if (wasEmpty) yield { type: 'tool_call_start', id: c.id, name: c.name };
          }
          const a = tc.function?.arguments;
          if (typeof a === 'string') c.args += a;
          else if (a && typeof a === 'object') c.args = JSON.stringify(a);
        }
      }
      if (choice.finish_reason) stopReason = choice.finish_reason;
    }

    const toolCalls: ToolCall[] = calls.filter((c) => c.name).map((c) => ({ id: c.id, name: c.name, args: parseToolArgs(c.args) }));
    yield { type: 'done', stopReason, usage, toolCalls };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await fetch(this.url('/models'), { headers: this.headers(), signal });
    if (!res.ok) throw new ProviderError(`${this.id}: ${await readErrorBody(res)}`, res.status);
    const j: any = await res.json();
    const list: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : Array.isArray(j) ? j : [];
    return list
      .map((m) => {
        const id: string = String(m.id ?? m.name ?? '').replace(/^models\//, '');
        return {
          id,
          name: m.name && m.name !== id ? m.name : undefined,
          contextWindow: m.context_length ?? m.context_window ?? m.max_context_length ?? undefined,
          free: id.endsWith(':free') || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0) || undefined,
          tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes('tools') : undefined,
        } as ModelInfo;
      })
      .filter((m) => m.id);
  }

  async complete(opts: { model: string; prompt: string; suffix?: string; maxTokens?: number; stop?: string[]; signal?: AbortSignal }): Promise<string> {
    // Prefer a chat request instructing the model to fill the gap — works everywhere.
    const res = await fetch(this.url('/chat/completions'), {
      method: 'POST',
      headers: this.headers(),
      signal: opts.signal,
      body: JSON.stringify({
        model: opts.model,
        temperature: 0.1,
        max_tokens: opts.maxTokens ?? 128,
        stop: opts.stop,
        messages: [
          {
            role: 'system',
            content:
              'You are a code completion engine. Output ONLY the code that should be inserted at <CURSOR>. No explanations, no markdown fences, no repetition of the surrounding code.',
          },
          { role: 'user', content: `${opts.prompt}<CURSOR>${opts.suffix ?? ''}` },
        ],
      }),
    });
    if (!res.ok) throw new ProviderError(`${this.id}: ${await readErrorBody(res)}`, res.status);
    const j: any = await res.json();
    return stripFences(String(j?.choices?.[0]?.message?.content ?? ''));
  }
}

export function stripFences(s: string): string {
  const m = s.match(/^```[\w-]*\n([\s\S]*?)\n?```\s*$/);
  return m ? m[1]! : s;
}

function partsToOpenAI(content: string | ContentPart[]): any {
  if (typeof content === 'string') return content;
  return content.map((p) =>
    p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } },
  );
}

export function toOpenAIMessages(system: string, messages: ChatMessage[]): any[] {
  const out: any[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: partsToOpenAI(m.content) });
    else if (m.role === 'assistant') {
      const msg: any = { role: 'assistant', content: m.content || (m.toolCalls?.length ? null : '') };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
        }));
      }
      out.push(msg);
    } else {
      // tool results: text only; images are forwarded in a follow-up user message
      const images = typeof m.content === 'string' ? [] : m.content.filter((p) => p.type === 'image');
      const text =
        typeof m.content === 'string'
          ? m.content
          : m.content
              .filter((p) => p.type === 'text')
              .map((p) => (p as { text: string }).text)
              .join('\n') || (images.length ? '[image output attached below]' : '');
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: text });
      if (images.length) {
        out.push({ role: 'user', content: [{ type: 'text', text: `Image output from tool ${m.name}:` }, ...partsToOpenAI(images)] });
      }
    }
  }
  return out;
}

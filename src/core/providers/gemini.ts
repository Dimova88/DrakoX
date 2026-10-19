import type { ChatMessage, ContentPart, ToolCall, Usage } from '../types.js';
import { parseSSE } from './sse.js';
import { stripFences } from './openai.js';
import { ProviderError, isRetryableStatus, providerFetch, type ModelInfo, type ModelRequest, type Provider, type StreamEvent, type ToolSpec } from './types.js';

/**
 * Native Gemini API adapter (generativelanguage.googleapis.com).
 *
 * Why native instead of Gemini's OpenAI-compatible endpoint: since June 2026 Google AI Studio only
 * issues "AQ." auth keys, which the OpenAI-compatible endpoint rejects. The native API accepts both
 * key formats via the `x-goog-api-key` header. It also lets us round-trip Gemini's thought signatures,
 * which Gemini 3 requires for multi-step function calling.
 */
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Documented placeholder for function calls Gemini did not produce itself (history from other models). */
const SKIP_SIGNATURE = 'skip_thought_signature_validator';

type Json = Record<string, any>;

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Json; id?: string };
  functionResponse?: { name: string; response: Json; id?: string };
  inlineData?: { mimeType: string; data: string };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export class GeminiProvider implements Provider {
  readonly type = 'gemini';
  constructor(
    readonly id: string,
    private opts: { baseURL?: string; apiKey?: string; headers?: Record<string, string> },
  ) {}

  private base(): string {
    return (this.opts.baseURL || GEMINI_BASE_URL).replace(/\/+$/, '');
  }

  /** The key goes ONLY in x-goog-api-key: adding an Authorization header makes Google reject AQ. keys. */
  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...(this.opts.headers ?? {}) };
    if (this.opts.apiKey) h['x-goog-api-key'] = this.opts.apiKey;
    return h;
  }

  private modelUrl(model: string): string {
    const m = model.replace(/^models\//, '');
    const path = m.startsWith('tunedModels/') ? m : `models/${m}`;
    return `${this.base()}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    const names = new Map(req.tools.map((t) => [geminiToolName(t.name), t.name]));
    const body: Json = { contents: toGeminiContents(req.messages) };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    if (req.tools.length) {
      body.tools = [{ functionDeclarations: req.tools.map(toDeclaration) }];
      body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }
    const gen: Json = {};
    if (req.maxTokens) gen.maxOutputTokens = req.maxTokens;
    if (req.temperature != null) gen.temperature = req.temperature;
    const thinking = thinkingConfig(req.model, req.reasoningEffort);
    if (thinking) gen.thinkingConfig = thinking;
    if (Object.keys(gen).length) body.generationConfig = gen;

    const url = `${this.modelUrl(req.model)}:streamGenerateContent?alt=sse`;
    const send = () => providerFetch(this.id, url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: req.signal });
    let res = await send();
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      // older models reject thinking options: retry once without them
      if (res.status === 400 && gen.thinkingConfig && /thinking/i.test(text)) {
        delete gen.thinkingConfig;
        if (!Object.keys(gen).length) delete body.generationConfig;
        res = await send();
        if (!res.ok || !res.body) throw geminiError(res.status, await res.text().catch(() => ''), this.id);
      } else throw geminiError(res.status, text, this.id);
    }

    const calls: ToolCall[] = [];
    const raw: GeminiPart[] = [];
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let finish: string | undefined;
    let produced = false;
    for await (const ev of parseSSE(res.body)) {
      let chunk: any;
      try {
        chunk = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (chunk.error) throw geminiError(Number(chunk.error.code) || 500, ev.data, this.id);
      if (chunk.usageMetadata) usage = toUsage(chunk.usageMetadata);
      const blocked = chunk.promptFeedback?.blockReason;
      if (blocked) throw new ProviderError(`${this.id}: Gemini blocked the request (${blocked}).`, undefined, false, 'http');
      const cand = chunk.candidates?.[0];
      if (!cand) continue;
      for (const part of (cand.content?.parts ?? []) as GeminiPart[]) {
        appendPart(raw, part);
        if (part.functionCall?.name) {
          const id = part.functionCall.id || `gemcall_${Math.random().toString(36).slice(2, 12)}`;
          const name = names.get(part.functionCall.name) ?? part.functionCall.name;
          calls.push({ id, name, args: (part.functionCall.args ?? {}) as Record<string, unknown> });
          produced = true;
          yield { type: 'tool_call_start', id, name };
        } else if (typeof part.text === 'string' && part.text) {
          produced = true;
          yield part.thought ? { type: 'reasoning', delta: part.text } : { type: 'text', delta: part.text };
        }
      }
      if (cand.finishReason) finish = cand.finishReason;
    }
    if (finish && !produced && !['STOP', 'MAX_TOKENS', 'FINISH_REASON_UNSPECIFIED'].includes(finish)) {
      const retryable = ['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'OTHER'].includes(finish);
      throw new ProviderError(`${this.id}: Gemini ended the response without output (finishReason: ${finish}).`, undefined, retryable, 'http');
    }
    const stopReason = finish === 'MAX_TOKENS' ? 'max_tokens' : calls.length ? 'tool_use' : finish?.toLowerCase();
    // unsigned thought summaries are already kept as `reasoning`; only parts Gemini needs back are stored
    const keep = raw.filter((p) => !(p.thought && !p.thoughtSignature));
    yield { type: 'done', stopReason, usage, toolCalls: calls, providerMeta: keep.length ? { geminiParts: keep } : undefined };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page++) {
      const url = `${this.base()}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await providerFetch(this.id, url, { headers: this.headers(), signal });
      if (!res.ok) throw geminiError(res.status, await res.text().catch(() => ''), this.id);
      const j: any = await res.json();
      for (const m of j.models ?? []) {
        const id = String(m.name ?? '').replace(/^models\//, '');
        const methods: string[] = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
        // keep chat models that can call tools; skip embeddings, media generation, TTS, live/audio, Gemma (no tools)…
        if (!id.startsWith('gemini') || !methods.includes('generateContent')) continue;
        if (/embedding|aqa|imagen|veo|tts|image|audio|live|robotics|computer-use/.test(id)) continue;
        out.push({ id, name: m.displayName, contextWindow: m.inputTokenLimit, tools: true, vision: true });
      }
      pageToken = j.nextPageToken;
      if (!pageToken) break;
    }
    // "-latest" aliases first, then newest versions
    return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  async complete(opts: { model: string; prompt: string; suffix?: string; maxTokens?: number; stop?: string[]; signal?: AbortSignal }): Promise<string> {
    const gen: Json = { temperature: 0.1, maxOutputTokens: Math.max(opts.maxTokens ?? 128, 1024) };
    if (opts.stop?.length) gen.stopSequences = opts.stop.slice(0, 5);
    // thinking tokens count against the output budget; turn thinking off where the model allows it
    if (/gemini-2\.5-flash/.test(opts.model)) gen.thinkingConfig = { thinkingBudget: 0 };
    const body = {
      systemInstruction: {
        parts: [{ text: 'You are a code completion engine. Output ONLY the code that should be inserted at <CURSOR>. No explanations, no markdown fences, no repetition of the surrounding code.' }],
      },
      contents: [{ role: 'user', parts: [{ text: `${opts.prompt}<CURSOR>${opts.suffix ?? ''}` }] }],
      generationConfig: gen,
    };
    const res = await providerFetch(this.id, `${this.modelUrl(opts.model)}:generateContent`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: opts.signal });
    if (!res.ok) throw geminiError(res.status, await res.text().catch(() => ''), this.id);
    const j: any = await res.json();
    const parts: GeminiPart[] = j.candidates?.[0]?.content?.parts ?? [];
    return stripFences(parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join(''));
  }
}

// ───────────────────────────── request building ─────────────────────────────

/** Gemini function names: start with a letter/underscore, [A-Za-z0-9_.:-], ≤ 64 chars. Deterministic. */
export function geminiToolName(name: string): string {
  let n = name.replace(/[^a-zA-Z0-9_.:-]/g, '_');
  if (!/^[a-zA-Z_]/.test(n)) n = `_${n}`;
  if (n.length > 64) n = `${n.slice(0, 55)}_${fnv1a(name)}`;
  return n;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function toDeclaration(t: ToolSpec): Json {
  const d: Json = { name: geminiToolName(t.name), description: t.description };
  const schema = toGeminiSchema(t.parameters);
  if (schema) d.parametersJsonSchema = schema;
  return d;
}

/**
 * Normalise an MCP / JSON Schema tool schema into the subset Gemini reliably acts on: local $refs are
 * inlined, allOf merged, nullable unions collapsed, type lists reduced, and annotation keywords
 * (additionalProperties, default, examples, $schema, pattern…) dropped. Returns undefined for tools
 * without parameters (Gemini rejects object schemas with no properties).
 */
export function toGeminiSchema(schema: unknown): Json | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  const root = schema as Json;
  const out = convertSchema(root, root, 0, new Set());
  if (out.type !== 'object' || !out.properties || !Object.keys(out.properties).length) return undefined;
  return out;
}

function resolveRef(ref: string, root: Json): Json | undefined {
  if (ref === '#') return root;
  const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
  if (!m) return undefined;
  const key = decodeURIComponent(m[2]!).replace(/~1/g, '/').replace(/~0/g, '~');
  const target = root[m[1]!]?.[key];
  return target && typeof target === 'object' ? target : undefined;
}

function mergeSchemas(a: Json, b: Json): Json {
  const out: Json = { ...a, ...b };
  if (a.properties || b.properties) out.properties = { ...(a.properties ?? {}), ...(b.properties ?? {}) };
  if (a.required || b.required) out.required = [...new Set([...(a.required ?? []), ...(b.required ?? [])])];
  if (a.description && b.description && a.description !== b.description) out.description = `${a.description} ${b.description}`;
  return out;
}

const isNullSchema = (o: unknown) => Boolean(o && typeof o === 'object' && ((o as Json).type === 'null' || (Array.isArray((o as Json).type) && (o as Json).type.every((t: string) => t === 'null'))));

function convertSchema(s: Json, root: Json, depth: number, seen: Set<string>): Json {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return {};
  const description = typeof s.description === 'string' && s.description ? s.description : depth > 0 && typeof s.title === 'string' && s.title ? s.title : undefined;
  const withDesc = (o: Json): Json => (description && !o.description ? { ...o, description } : o);
  if (depth > 12) return withDesc({ type: 'object' });

  if (typeof s.$ref === 'string') {
    // recursive references are cut off rather than expanded forever
    if (seen.has(s.$ref)) return withDesc({ type: 'object' });
    const target = resolveRef(s.$ref, root);
    if (!target) return description ? { description } : {};
    const { $ref: _ref, ...siblings } = s;
    return convertSchema({ ...target, ...siblings }, root, depth + 1, new Set(seen).add(s.$ref));
  }
  if (Array.isArray(s.allOf) && s.allOf.length) {
    const { allOf, ...rest } = s;
    const parts = allOf.map((p: Json) => convertSchema(p, root, depth + 1, seen));
    return withDesc(parts.reduce((acc: Json, p: Json) => mergeSchemas(acc, p), convertSchema(rest, root, depth, seen)));
  }
  const union = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : undefined;
  if (union) {
    const options = union.filter((o: unknown) => !isNullSchema(o));
    if (options.length === 1) return withDesc(convertSchema(options[0], root, depth + 1, seen));
    if (options.length > 1) return withDesc({ anyOf: options.map((o: Json) => convertSchema(o, root, depth + 1, seen)) });
  }

  let type: unknown = s.type;
  if (Array.isArray(type)) {
    const types = type.filter((t) => t !== 'null');
    if (types.length > 1) return withDesc({ anyOf: types.map((t) => convertSchema({ ...s, type: t, description: undefined }, root, depth + 1, seen)) });
    type = types[0] ?? 'string';
  }
  const enumValues = Array.isArray(s.enum) ? s.enum : s.const !== undefined ? [s.const] : undefined;
  if (!type) {
    if (s.properties) type = 'object';
    else if (s.items || s.prefixItems) type = 'array';
    else if (enumValues?.length) type = typeof enumValues[0] === 'number' ? 'number' : 'string';
  }

  const out: Json = {};
  if (typeof type === 'string') out.type = type;
  if (description) out.description = description;
  if (enumValues) {
    const prim = enumValues.filter((v: unknown) => typeof v === 'string' || typeof v === 'number');
    if (prim.length) out.enum = prim;
  }
  if (type === 'object' && s.properties && typeof s.properties === 'object') {
    const props: Json = {};
    for (const [k, v] of Object.entries(s.properties)) props[k] = convertSchema(v as Json, root, depth + 1, seen);
    out.properties = props;
    const required = Array.isArray(s.required) ? s.required.filter((r: unknown) => typeof r === 'string' && r in props) : [];
    if (required.length) out.required = required;
  }
  if (type === 'array') {
    const items = Array.isArray(s.items) ? s.items[0] : s.items ?? (Array.isArray(s.prefixItems) ? s.prefixItems[0] : undefined);
    if (items && typeof items === 'object') out.items = convertSchema(items, root, depth + 1, seen);
    if (typeof s.minItems === 'number') out.minItems = s.minItems;
    if (typeof s.maxItems === 'number') out.maxItems = s.maxItems;
  }
  if (type === 'number' || type === 'integer') {
    if (typeof s.minimum === 'number') out.minimum = s.minimum;
    if (typeof s.maximum === 'number') out.maximum = s.maximum;
  }
  if (type === 'string' && typeof s.format === 'string' && ['date-time', 'date', 'time'].includes(s.format)) out.format = s.format;
  return out;
}

function userParts(content: string | ContentPart[]): GeminiPart[] {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  const parts: GeminiPart[] = [];
  for (const p of content) {
    if (p.type === 'text') {
      if (p.text) parts.push({ text: p.text });
    } else parts.push({ inlineData: { mimeType: p.mediaType, data: p.data } });
  }
  return parts;
}

/** Convert the provider-neutral transcript to Gemini `contents` (consecutive same-role turns are merged). */
export function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  const geminiCallIds = new Set<string>(); // call ids issued by Gemini itself — only these are echoed back
  const push = (role: GeminiContent['role'], parts: GeminiPart[]) => {
    if (!parts.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts: [...parts] });
  };
  for (const m of messages) {
    if (m.role === 'user') {
      push('user', userParts(m.content));
    } else if (m.role === 'assistant') {
      const raw = m.providerMeta?.geminiParts as GeminiPart[] | undefined;
      if (Array.isArray(raw) && raw.length) {
        // replay Gemini's own parts verbatim (keeps thought signatures); unsigned thought summaries are not needed
        const parts = raw.filter((p) => !(p.thought && !p.thoughtSignature)).map((p) => ({ ...p }));
        for (const p of parts) if (p.functionCall?.id) geminiCallIds.add(p.functionCall.id);
        push('model', parts);
        continue;
      }
      const parts: GeminiPart[] = [];
      if (m.content) parts.push({ text: m.content });
      (m.toolCalls ?? []).forEach((tc, i) => {
        const part: GeminiPart = { functionCall: { name: geminiToolName(tc.name), args: tc.args ?? {} } };
        if (i === 0) part.thoughtSignature = SKIP_SIGNATURE;
        parts.push(part);
      });
      push('model', parts);
    } else {
      const text = typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).filter(Boolean).join('\n');
      const images = typeof m.content === 'string' ? [] : m.content.filter((p): p is Extract<ContentPart, { type: 'image' }> => p.type === 'image');
      const fr: GeminiPart = { functionResponse: { name: geminiToolName(m.name), response: m.isError ? { error: text } : { result: text } } };
      if (geminiCallIds.has(m.toolCallId)) fr.functionResponse!.id = m.toolCallId;
      push('user', [fr, ...images.map((im) => ({ inlineData: { mimeType: im.mediaType, data: im.data } }))]);
    }
  }
  return out;
}

/** Merge streamed text chunks; never merge across a thought signature or a non-text part. */
function appendPart(raw: GeminiPart[], part: GeminiPart): void {
  const last = raw[raw.length - 1];
  const plainText = (p?: GeminiPart) => Boolean(p && typeof p.text === 'string' && !p.functionCall && !p.functionResponse && !p.inlineData && !p.thoughtSignature);
  if (last && plainText(last) && plainText(part) && Boolean(last.thought) === Boolean(part.thought)) {
    last.text = (last.text ?? '') + (part.text ?? '');
    return;
  }
  raw.push({ ...part });
}

function thinkingConfig(model: string, effort?: 'low' | 'medium' | 'high'): Json | undefined {
  const m = model.toLowerCase();
  const major = Number(/gemini-(\d+)/.exec(m)?.[1] ?? NaN);
  const v25 = /gemini-2\.5/.test(m);
  if (!(v25 || major >= 3 || /-latest$/.test(m) || /thinking/.test(m))) return undefined;
  const cfg: Json = { includeThoughts: true };
  if (effort && major >= 3) cfg.thinkingLevel = effort === 'high' ? 'high' : 'low';
  else if (effort && v25) cfg.thinkingBudget = effort === 'low' ? 1024 : effort === 'medium' ? 8192 : 24576;
  return cfg;
}

function toUsage(u: any): Usage {
  const thoughts = Number(u.thoughtsTokenCount) || 0;
  return {
    inputTokens: Number(u.promptTokenCount) || 0,
    outputTokens: (Number(u.candidatesTokenCount) || 0) + thoughts,
    cachedInputTokens: Number(u.cachedContentTokenCount) || undefined,
    reasoningTokens: thoughts || undefined,
  };
}

/** Turn Google's error JSON into an actionable ProviderError. */
export function geminiError(status: number, text: string, who: string): ProviderError {
  let message = text.trim().slice(0, 600) || `HTTP ${status}`;
  let reason = '';
  try {
    const j = JSON.parse(text);
    const e = Array.isArray(j) ? j[0]?.error : j?.error;
    if (e?.message) message = String(e.message);
    reason = e?.details?.find((d: any) => d?.reason)?.reason ?? (e?.status && e.status !== 'INVALID_ARGUMENT' ? e.status : '');
  } catch {
    /* not JSON */
  }
  const invalidKey = /API key not valid|API_KEY_INVALID/i.test(`${message} ${reason}`);
  let hint = '';
  if (invalidKey) hint = ' Copy the key again from https://aistudio.google.com/apikey.';
  else if (reason === 'ACCESS_TOKEN_TYPE_UNSUPPORTED') hint = ' Google did not accept this key type — use a Gemini API key from Google AI Studio (https://aistudio.google.com/apikey).';
  else if (status === 429) hint = ' Rate limit or free-tier quota reached — wait a moment, or check your quota in Google AI Studio.';
  else if (status === 404 && /model/i.test(message)) hint = ' Pick another model (the model picker or /models lists what your key can use).';
  const kind = status === 401 || status === 403 || invalidKey ? 'auth' : 'http';
  return new ProviderError(`${who} (${status}${reason ? ` ${reason}` : ''}): ${message}${hint}`, status, isRetryableStatus(status), kind);
}

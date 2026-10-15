import type { DrakoxConfig, Usage } from './types.js';

/**
 * Model metadata used for context management and transparent cost estimates.
 * Prices are public list prices in USD per 1M tokens at the time of writing — they are
 * *estimates*; override them in config (`pricing`). Local models are always $0.
 */

const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'llamacpp', 'vllm', 'demo']);

interface Price {
  input: number;
  output: number;
  cachedInput?: number;
}

const PRICES: [RegExp, Price][] = [
  [/:free$/, { input: 0, output: 0 }],
  [/claude-opus-4-(5|6|7)|claude-opus-4\.(5|6|7)/, { input: 5, output: 25, cachedInput: 0.5 }],
  [/claude-opus-4|claude-3-opus/, { input: 15, output: 75, cachedInput: 1.5 }],
  [/claude-sonnet-4|claude-3-7-sonnet|claude-3-5-sonnet|claude-sonnet/, { input: 3, output: 15, cachedInput: 0.3 }],
  [/claude-haiku-4|claude-4-haiku/, { input: 1, output: 5, cachedInput: 0.1 }],
  [/claude-3-5-haiku/, { input: 0.8, output: 4, cachedInput: 0.08 }],
  [/gpt-5(\.\d)?-nano/, { input: 0.05, output: 0.4, cachedInput: 0.005 }],
  [/gpt-5(\.\d)?-mini/, { input: 0.25, output: 2, cachedInput: 0.025 }],
  [/gpt-5/, { input: 1.25, output: 10, cachedInput: 0.125 }],
  [/gpt-4\.1-nano/, { input: 0.1, output: 0.4 }],
  [/gpt-4\.1-mini/, { input: 0.4, output: 1.6 }],
  [/gpt-4\.1/, { input: 2, output: 8 }],
  [/gpt-4o-mini/, { input: 0.15, output: 0.6 }],
  [/gpt-4o/, { input: 2.5, output: 10 }],
  [/o4-mini/, { input: 1.1, output: 4.4 }],
  [/\bo3\b|\/o3$|^o3/, { input: 2, output: 8 }],
  [/gpt-oss-120b/, { input: 0.15, output: 0.6 }],
  [/gpt-oss-20b/, { input: 0.05, output: 0.2 }],
  [/gemini-2\.5-pro/, { input: 1.25, output: 10 }],
  [/gemini-2\.5-flash-lite/, { input: 0.1, output: 0.4 }],
  [/gemini-2\.5-flash/, { input: 0.3, output: 2.5 }],
  [/deepseek-(chat|reasoner)|deepseek-v3/, { input: 0.28, output: 0.42 }],
  [/grok-code-fast/, { input: 0.2, output: 1.5 }],
  [/grok-4/, { input: 3, output: 15 }],
  [/muse-spark/, { input: 1.25, output: 4.25 }],
  [/devstral-small|codestral/, { input: 0.1, output: 0.3 }],
  [/devstral-medium/, { input: 0.4, output: 2 }],
  [/kimi-k2/, { input: 0.6, output: 2.5 }],
  [/glm-4\.6|glm-4\.5/, { input: 0.6, output: 2.2 }],
];

const CONTEXT: [RegExp, number][] = [
  [/claude/, 200_000],
  [/gpt-5/, 400_000],
  [/gpt-4\.1/, 1_000_000],
  [/gpt-4o|o4-mini|\bo3\b/, 128_000],
  [/gpt-oss/, 131_072],
  [/gemini/, 1_000_000],
  [/deepseek/, 128_000],
  [/qwen3-coder|qwen-3-coder/, 262_144],
  [/qwen/, 131_072],
  [/kimi|moonshot/, 262_144],
  [/glm/, 131_072],
  [/grok/, 256_000],
  [/llama-?4/, 1_000_000],
  [/llama/, 131_072],
  [/devstral|codestral|mistral/, 131_072],
  [/muse/, 1_000_000],
  [/drakox-demo/, 128_000],
];

export function splitModelRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf('/');
  if (i === -1) return { provider: '', model: ref };
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

export function contextWindowFor(ref: string, config?: DrakoxConfig, ollamaNumCtx?: number): number {
  const { provider, model } = splitModelRef(ref);
  const override = config?.contextWindows?.[ref] ?? config?.contextWindows?.[model];
  if (override) return override;
  if (provider === 'ollama') return ollamaNumCtx ?? config?.providers?.ollama?.numCtx ?? 32_768;
  const lower = model.toLowerCase();
  for (const [re, n] of CONTEXT) if (re.test(lower)) return n;
  return LOCAL_PROVIDERS.has(provider) ? 32_768 : 128_000;
}

export function priceFor(ref: string, config?: DrakoxConfig): Price | null {
  const { provider, model } = splitModelRef(ref);
  const override = config?.pricing?.[ref] ?? config?.pricing?.[model];
  if (override) return override;
  if (LOCAL_PROVIDERS.has(provider)) return { input: 0, output: 0 };
  const lower = model.toLowerCase();
  for (const [re, p] of PRICES) if (re.test(lower)) return p;
  return null;
}

/** Estimated cost in USD, or null when the price is unknown. */
export function costFor(ref: string, usage: Usage, config?: DrakoxConfig): number | null {
  const p = priceFor(ref, config);
  if (!p) return null;
  const cached = usage.cachedInputTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - cached);
  const cachedPrice = p.cachedInput ?? p.input;
  return (uncached * p.input + cached * cachedPrice + usage.outputTokens * p.output) / 1_000_000;
}

export function isLocalProvider(id: string): boolean {
  return LOCAL_PROVIDERS.has(id);
}

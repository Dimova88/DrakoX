import type { DrakoxConfig, ProviderConfig } from '../types.js';
import type { Credentials } from '../config.js';
import { splitModelRef } from '../models.js';
import { AnthropicProvider } from './anthropic.js';
import { PROVIDER_PRESETS, getPreset, type ProviderPreset } from './catalog.js';
import { DemoProvider } from './demo.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatibleProvider } from './openai.js';
import type { ModelInfo, Provider } from './types.js';

export * from './types.js';
export { PROVIDER_PRESETS, getPreset } from './catalog.js';

export interface ResolvedProviderConfig extends ProviderConfig {
  id: string;
  apiKey?: string;
  keySource?: 'config' | 'credentials' | 'env' | 'none';
  preset?: ProviderPreset;
}

export interface ProviderStatus {
  id: string;
  name: string;
  type: string;
  category: string;
  description?: string;
  signupUrl?: string;
  baseURL?: string;
  configured: boolean;
  keySource?: string;
  needsKey: boolean;
  models: ModelInfo[];
  reachable?: boolean;
  error?: string;
  recommended?: string;
}

const PREFERRED_LOCAL = [/qwen3-coder/, /gpt-oss/, /devstral/, /qwen2\.5-coder/, /qwen3/, /llama3\.[13]/, /mistral/, /deepseek/];

export class ProviderRegistry {
  private cache = new Map<string, Provider>();

  constructor(
    private config: DrakoxConfig,
    private creds: Credentials = {},
  ) {}

  update(config: DrakoxConfig, creds: Credentials): void {
    this.config = config;
    this.creds = creds;
    this.cache.clear();
  }

  /** All provider ids: presets + custom providers from config. */
  ids(): string[] {
    return [...new Set([...PROVIDER_PRESETS.map((p) => p.id), ...Object.keys(this.config.providers ?? {})])];
  }

  resolveConfig(id: string): ResolvedProviderConfig | undefined {
    const preset = getPreset(id);
    const cfg = this.config.providers?.[id];
    if (!preset && !cfg) return undefined;
    const merged: ResolvedProviderConfig = {
      id,
      type: cfg?.type ?? preset!.type,
      name: cfg?.name ?? preset?.name ?? id,
      baseURL: cfg?.baseURL ?? preset?.baseURL,
      headers: cfg?.headers,
      models: cfg?.models,
      enabled: cfg?.enabled,
      numCtx: cfg?.numCtx,
      apiKeyEnv: cfg?.apiKeyEnv,
      preset,
    };
    if (cfg?.apiKey) {
      merged.apiKey = cfg.apiKey;
      merged.keySource = 'config';
    } else if (this.creds.providers?.[id]?.apiKey) {
      merged.apiKey = this.creds.providers[id]!.apiKey;
      merged.keySource = 'credentials';
    } else {
      const envs = [...(cfg?.apiKeyEnv ? [cfg.apiKeyEnv] : []), ...(preset?.apiKeyEnv ?? [])];
      for (const e of envs) {
        if (process.env[e]) {
          merged.apiKey = process.env[e];
          merged.keySource = 'env';
          break;
        }
      }
      merged.keySource ??= 'none';
    }
    return merged;
  }

  get(id: string): Provider {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const cfg = this.resolveConfig(id);
    if (!cfg) throw new Error(`Unknown provider "${id}". Known: ${this.ids().join(', ')}`);
    let p: Provider;
    switch (cfg.type) {
      case 'anthropic':
        p = new AnthropicProvider(id, { baseURL: cfg.baseURL, apiKey: cfg.apiKey, headers: cfg.headers });
        break;
      case 'ollama':
        p = new OllamaProvider(id, { baseURL: cfg.baseURL, numCtx: cfg.numCtx, headers: cfg.headers });
        break;
      case 'demo':
        p = new DemoProvider(id);
        break;
      case 'openai':
      default:
        if (!cfg.baseURL) throw new Error(`Provider "${id}" needs a baseURL`);
        p = new OpenAICompatibleProvider(id, { baseURL: cfg.baseURL, apiKey: cfg.apiKey, headers: cfg.headers });
    }
    this.cache.set(id, p);
    return p;
  }

  /** Resolve `provider/model` into a provider instance. */
  resolve(ref: string): { provider: Provider; model: string; ref: string } {
    let { provider, model } = splitModelRef(ref);
    if (!provider) {
      // bare model name → guess provider from known suggestions
      const preset = PROVIDER_PRESETS.find((p) => p.models.includes(model));
      provider = preset?.id ?? 'openai';
    }
    return { provider: this.get(provider), model, ref: `${provider}/${model}` };
  }

  isConfigured(id: string): boolean {
    const cfg = this.resolveConfig(id);
    if (!cfg) return false;
    if (cfg.preset?.noKey || cfg.type === 'ollama' || cfg.type === 'demo') return true;
    if (!cfg.preset && cfg.type === 'openai') return true; // custom endpoint, key optional
    return Boolean(cfg.apiKey);
  }

  /** Pick a sensible default model when none is configured. */
  async detectDefaultModel(signal?: AbortSignal): Promise<{ ref: string; reason: string }> {
    if (this.config.model) return { ref: this.config.model, reason: 'configured' };
    const envOrder: [string, string][] = [
      ['anthropic', 'claude-sonnet-4-5'],
      ['openai', 'gpt-5'],
      ['gemini', 'gemini-2.5-flash'],
      ['openrouter', 'qwen/qwen3-coder:free'],
      ['groq', 'openai/gpt-oss-120b'],
      ['deepseek', 'deepseek-chat'],
      ['mistral', 'devstral-medium-latest'],
      ['xai', 'grok-code-fast-1'],
      ['cerebras', 'qwen-3-coder-480b'],
    ];
    for (const [id, model] of envOrder) {
      const c = this.resolveConfig(id);
      if (c?.apiKey) return { ref: `${id}/${model}`, reason: `found ${c.keySource === 'env' ? 'environment' : 'saved'} key for ${c.name}` };
    }
    // local servers
    const timeout = AbortSignal.timeout(1200);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const models = await this.get('ollama').listModels!(sig);
      if (models.length) {
        const pick = PREFERRED_LOCAL.map((re) => models.find((m) => re.test(m.id))).find(Boolean) ?? models[0]!;
        return { ref: `ollama/${pick.id}`, reason: 'Ollama is running locally' };
      }
    } catch {
      /* not running */
    }
    try {
      const models = await this.get('lmstudio').listModels!(AbortSignal.timeout(1200));
      const chat = models.filter((m) => !/embed/i.test(m.id));
      if (chat.length) return { ref: `lmstudio/${chat[0]!.id}`, reason: 'LM Studio is running locally' };
    } catch {
      /* not running */
    }
    return { ref: 'demo/drakox-demo', reason: 'no model configured — using the offline demo model' };
  }

  /** Status of every provider, with model discovery for local and configured ones. */
  async statuses(opts: { discover?: boolean; signal?: AbortSignal } = {}): Promise<ProviderStatus[]> {
    const out = await Promise.all(
      this.ids().map(async (id): Promise<ProviderStatus> => {
        const cfg = this.resolveConfig(id)!;
        const preset = cfg.preset;
        const configured = this.isConfigured(id);
        const staticModels: ModelInfo[] = [...new Set([...(cfg.models ?? []), ...(preset?.models ?? [])])].map((m) => ({ id: m, free: m.endsWith(':free') || preset?.category === 'local' || undefined }));
        const status: ProviderStatus = {
          id,
          name: cfg.name ?? id,
          type: cfg.type,
          category: preset?.category ?? 'custom',
          description: preset?.description,
          signupUrl: preset?.signupUrl,
          baseURL: cfg.baseURL,
          configured,
          keySource: cfg.keySource,
          needsKey: !(preset?.noKey || cfg.type === 'ollama' || cfg.type === 'demo' || (!preset && cfg.type === 'openai')),
          models: staticModels,
          recommended: preset?.recommended,
        };
        const shouldDiscover = opts.discover && configured && (preset?.category === 'local' || preset?.category === 'demo' || cfg.keySource !== 'none' || !preset);
        if (shouldDiscover) {
          try {
            const p = this.get(id);
            if (p.listModels) {
              const timeout = AbortSignal.timeout(preset?.category === 'local' ? 1500 : 6000);
              const discovered = await p.listModels(opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout);
              status.reachable = true;
              const seen = new Set(discovered.map((m) => m.id));
              status.models = [...discovered, ...staticModels.filter((m) => !seen.has(m.id) && preset?.category !== 'local')];
            }
          } catch (err) {
            status.reachable = false;
            status.error = (err as Error).message;
            if (preset?.category === 'local') status.models = [];
          }
        }
        return status;
      }),
    );
    return out;
  }
}

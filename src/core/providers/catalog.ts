import type { ProviderType } from '../types.js';

export type ProviderCategory = 'local' | 'free' | 'byok' | 'demo';

export interface ProviderPreset {
  id: string;
  name: string;
  type: ProviderType;
  baseURL?: string;
  /** Environment variables checked for an API key (first match wins) */
  apiKeyEnv?: string[];
  category: ProviderCategory;
  description: string;
  signupUrl?: string;
  docsUrl?: string;
  /** Suggested models (live lists are discovered when possible) */
  models: string[];
  recommended?: string;
  noKey?: boolean;
}

/**
 * Built-in provider presets. Every OpenAI-compatible endpoint works — add your own with
 * `type: "openai"` and a `baseURL` in config.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  // ── Local: free, unlimited, private ─────────────────────────────
  {
    id: 'ollama',
    name: 'Ollama',
    type: 'ollama',
    baseURL: 'http://localhost:11434',
    category: 'local',
    noKey: true,
    description: 'Run open models locally. Free, unlimited and private. DrakoX requests a 32k context automatically.',
    signupUrl: 'https://ollama.com/download',
    docsUrl: 'https://github.com/ollama/ollama',
    models: ['qwen3-coder:30b', 'gpt-oss:20b', 'devstral:24b', 'qwen2.5-coder:14b', 'llama3.1:8b'],
    recommended: 'qwen3-coder:30b',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    type: 'openai',
    baseURL: 'http://localhost:1234/v1',
    category: 'local',
    noKey: true,
    description: 'Desktop app for local models with an OpenAI-compatible server.',
    signupUrl: 'https://lmstudio.ai',
    models: [],
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp server',
    type: 'openai',
    baseURL: 'http://localhost:8080/v1',
    category: 'local',
    noKey: true,
    description: 'llama-server from llama.cpp (start with --jinja for tool calling).',
    docsUrl: 'https://github.com/ggml-org/llama.cpp',
    models: [],
  },
  {
    id: 'vllm',
    name: 'vLLM',
    type: 'openai',
    baseURL: 'http://localhost:8000/v1',
    category: 'local',
    noKey: true,
    description: 'High-throughput self-hosted inference server (enable --enable-auto-tool-choice).',
    docsUrl: 'https://github.com/vllm-project/vllm',
    models: [],
  },
  // ── Free tiers (rate-limited by the provider, not by DrakoX) ─────
  {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: ['OPENROUTER_API_KEY'],
    category: 'free',
    description: 'One key for 300+ models, including many free `:free` models.',
    signupUrl: 'https://openrouter.ai/keys',
    models: ['qwen/qwen3-coder:free', 'openai/gpt-oss-120b:free', 'z-ai/glm-4.5-air:free', 'deepseek/deepseek-chat-v3.1:free', 'anthropic/claude-sonnet-4.5', 'openai/gpt-5'],
    recommended: 'qwen/qwen3-coder:free',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    type: 'openai',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    category: 'free',
    description: 'Gemini models via Google AI Studio. Generous free tier, 1M-token context.',
    signupUrl: 'https://aistudio.google.com/apikey',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'],
    recommended: 'gemini-2.5-flash',
  },
  {
    id: 'groq',
    name: 'Groq',
    type: 'openai',
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeyEnv: ['GROQ_API_KEY'],
    category: 'free',
    description: 'Extremely fast inference with a free tier.',
    signupUrl: 'https://console.groq.com/keys',
    models: ['openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct-0905', 'qwen/qwen3-32b', 'llama-3.3-70b-versatile'],
    recommended: 'openai/gpt-oss-120b',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    type: 'openai',
    baseURL: 'https://api.cerebras.ai/v1',
    apiKeyEnv: ['CEREBRAS_API_KEY'],
    category: 'free',
    description: 'Wafer-scale inference, very fast, free tier available.',
    signupUrl: 'https://cloud.cerebras.ai',
    models: ['qwen-3-coder-480b', 'gpt-oss-120b', 'llama-3.3-70b'],
  },
  {
    id: 'github',
    name: 'GitHub Models',
    type: 'openai',
    baseURL: 'https://models.github.ai/inference',
    apiKeyEnv: ['GITHUB_MODELS_TOKEN', 'GITHUB_TOKEN'],
    category: 'free',
    description: 'Free, rate-limited access to many models with a GitHub token (models:read).',
    signupUrl: 'https://github.com/settings/tokens',
    models: ['openai/gpt-4.1', 'openai/gpt-4.1-mini', 'deepseek/DeepSeek-V3-0324', 'meta/Llama-4-Maverick-17B-128E-Instruct-FP8'],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    type: 'openai',
    baseURL: 'https://api.mistral.ai/v1',
    apiKeyEnv: ['MISTRAL_API_KEY'],
    category: 'free',
    description: 'Devstral & Codestral coding models; free "Experiment" tier.',
    signupUrl: 'https://console.mistral.ai/api-keys',
    models: ['devstral-medium-latest', 'devstral-small-latest', 'codestral-latest', 'mistral-large-latest'],
  },
  // ── Bring your own key ───────────────────────────────────────────
  {
    id: 'anthropic',
    name: 'Anthropic',
    type: 'anthropic',
    apiKeyEnv: ['ANTHROPIC_API_KEY'],
    category: 'byok',
    description: 'Claude models via the Anthropic API (prompt caching enabled automatically).',
    signupUrl: 'https://console.anthropic.com/settings/keys',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    recommended: 'claude-sonnet-4-5',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: ['OPENAI_API_KEY'],
    category: 'byok',
    description: 'GPT models via the OpenAI API.',
    signupUrl: 'https://platform.openai.com/api-keys',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-5-codex', 'gpt-4.1'],
    recommended: 'gpt-5',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'openai',
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyEnv: ['DEEPSEEK_API_KEY'],
    category: 'byok',
    description: 'Strong, very low-cost models.',
    signupUrl: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'xai',
    name: 'xAI',
    type: 'openai',
    baseURL: 'https://api.x.ai/v1',
    apiKeyEnv: ['XAI_API_KEY'],
    category: 'byok',
    description: 'Grok models.',
    signupUrl: 'https://console.x.ai',
    models: ['grok-code-fast-1', 'grok-4'],
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    type: 'openai',
    baseURL: 'https://api.moonshot.ai/v1',
    apiKeyEnv: ['MOONSHOT_API_KEY'],
    category: 'byok',
    description: 'Kimi K2 agentic coding models.',
    signupUrl: 'https://platform.moonshot.ai',
    models: ['kimi-k2-0905-preview'],
  },
  {
    id: 'zai',
    name: 'Z.ai (GLM)',
    type: 'openai',
    baseURL: 'https://api.z.ai/api/paas/v4',
    apiKeyEnv: ['ZAI_API_KEY'],
    category: 'byok',
    description: 'GLM coding models.',
    signupUrl: 'https://z.ai',
    models: ['glm-4.6'],
  },
  {
    id: 'together',
    name: 'Together AI',
    type: 'openai',
    baseURL: 'https://api.together.xyz/v1',
    apiKeyEnv: ['TOGETHER_API_KEY'],
    category: 'byok',
    description: 'Hosted open models.',
    signupUrl: 'https://api.together.ai',
    models: ['Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8', 'moonshotai/Kimi-K2-Instruct-0905'],
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    type: 'openai',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnv: ['FIREWORKS_API_KEY'],
    category: 'byok',
    description: 'Fast hosted open models.',
    signupUrl: 'https://fireworks.ai',
    models: ['accounts/fireworks/models/qwen3-coder-480b-a35b-instruct'],
  },
  {
    id: 'demo',
    name: 'Demo (offline)',
    type: 'demo',
    category: 'demo',
    noKey: true,
    description: 'Scripted offline model to explore DrakoX without any setup. Not a real AI.',
    models: ['drakox-demo'],
    recommended: 'drakox-demo',
  },
];

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

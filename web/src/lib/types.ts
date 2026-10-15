export type * from '../../../src/core/types';
import type { Mode, SessionStatus, Todo, UsageTotals, WorktreeInfo, McpServerConfig, ToolKind } from '../../../src/core/types';

export interface AgentItem {
  id: string;
  title: string;
  cwd: string;
  projectRoot: string;
  model: string;
  mode: Mode;
  status: SessionStatus;
  turn: number;
  todos: Todo[];
  totals: UsageTotals;
  contextTokens: number;
  contextWindow: number;
  worktree?: WorktreeInfo;
  parentId?: string;
  pendingApprovals: number;
  createdAt: number;
  updatedAt: number;
  filesChanged: string[];
  live: boolean;
  group?: string;
  lastMessage?: string;
  worktreeStats?: { files: number; added: number; removed: number };
}

export interface Info {
  version: string;
  cwd: string;
  projectRoot: string;
  projectName: string;
  git: { isRepo: boolean; root?: string; branch?: string; changed?: number };
  trusted: boolean;
  sandbox: { available: boolean; kind: string; mode: string; network: boolean };
  defaultModel: string;
  defaultModelReason: string;
  demo: boolean;
  platform: string;
  home: string;
  needsTrust: boolean;
  config: { mode: Mode; autoReview: boolean; budget: number | null };
}

export interface McpTool {
  name: string;
  drakoxName: string;
  description: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean; title?: string };
}

export interface McpView {
  name: string;
  status: 'disabled' | 'connecting' | 'connected' | 'error' | 'needs_auth' | 'untrusted';
  error?: string;
  transport: 'stdio' | 'http' | 'sse';
  tools: McpTool[];
  prompts: { name: string; description?: string }[];
  serverInfo?: { name: string; version: string };
  authUrl?: string;
  source: 'user' | 'project';
  catalogId?: string;
  config?: McpServerConfig;
  scopes: string[];
  catalog?: { id: string; name: string; color: string; icon: string };
}

export interface CatalogInput {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  help?: string;
  optional?: boolean;
  default?: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  category: string;
  description: string;
  color: string;
  icon: string;
  publisher: string;
  official?: boolean;
  auth: 'none' | 'token' | 'oauth' | 'local-app';
  homepage?: string;
  inputs?: CatalogInput[];
  config: McpServerConfig;
  requires?: string;
  featured?: boolean;
  installed?: boolean;
}

export interface RegistryServer {
  name: string;
  title?: string;
  description: string;
  version?: string;
  repository?: string;
  website?: string;
  install?: McpServerConfig;
  inputs: { key: string; description?: string; required: boolean; secret: boolean; target: 'env' | 'header' }[];
  kind: 'npm' | 'pypi' | 'oci' | 'remote' | 'unknown';
}

export interface ModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  tools?: boolean;
  vision?: boolean;
  free?: boolean;
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

export interface ModelOption {
  ref: string;
  provider: string;
  providerName: string;
  id: string;
  free?: boolean;
  local?: boolean;
  contextWindow?: number;
}

export interface SlashCommandInfo {
  name: string;
  description: string;
  args?: string;
  source: 'builtin' | 'command' | 'skill' | 'mcp';
  kind: 'action' | 'prompt';
  aliases?: string[];
}

export interface Skill {
  name: string;
  description: string;
  dir: string;
  file: string;
  source: 'project' | 'user' | 'bundled';
  origin: string;
  userOnly: boolean;
}

export interface AgentProfile {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  source: 'project' | 'user' | 'bundled';
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  ignored: boolean;
}

export type { Mode, ToolKind };

import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';
import type { DrakoxConfig, McpServerConfig } from './types.js';
import { deepMerge, readJson, writeJson } from './util.js';

/**
 * Configuration layers (later wins):
 *   built-in defaults
 *   < ~/.drakox/config.json                (user)
 *   < <project>/.mcp.json                  (de-facto standard shared MCP config; Claude Code compatible)
 *   < <project>/.drakox/settings.json      (project, commit this)
 *   < <project>/.drakox/settings.local.json (personal overrides, gitignored)
 *   < CLI flags / runtime overrides
 */

export const DEFAULT_CONFIG: DrakoxConfig = {
  mode: 'ask',
  sandbox: 'workspace-write',
  maxTurns: 60,
  autoCompact: true,
  compactThreshold: 0.8,
  autoReview: false,
  gitTrailers: false,
  instructions: { maxBytes: 65536 },
  permissions: {
    allow: [],
    ask: [],
    deny: [],
    sensitivePaths: [
      '**/.env',
      '**/.env.*',
      '**/*.pem',
      '**/*.key',
      '**/id_rsa*',
      '**/id_ed25519*',
      '**/.ssh/**',
      '**/.aws/credentials',
      '**/.npmrc',
      '**/.netrc',
      '**/.git-credentials',
      '**/.drakox/credentials.json',
    ],
    sandboxNetwork: false,
  },
};

export type ConfigScope = 'user' | 'project' | 'local';

export interface LoadedConfig {
  config: DrakoxConfig;
  /** Where each layer came from (for UIs / doctor) */
  sources: { scope: ConfigScope | 'mcp.json' | 'default'; file?: string; exists: boolean }[];
  projectRoot: string;
  /** MCP servers defined by project files (require workspace trust to start) */
  projectMcpServers: string[];
  hasProjectHooks: boolean;
}

export function projectConfigFile(root: string, scope: 'project' | 'local'): string {
  return path.join(root, '.drakox', scope === 'project' ? 'settings.json' : 'settings.local.json');
}

export function loadConfig(projectRoot: string, overrides: Partial<DrakoxConfig> = {}): LoadedConfig {
  const userFile = paths.config();
  const mcpFile = path.join(projectRoot, '.mcp.json');
  const projFile = projectConfigFile(projectRoot, 'project');
  const localFile = projectConfigFile(projectRoot, 'local');

  const user = readJson<DrakoxConfig>(userFile, {});
  const mcpJson = readJson<{ mcpServers?: Record<string, McpServerConfig>; servers?: Record<string, McpServerConfig> }>(mcpFile, {});
  const project = readJson<DrakoxConfig>(projFile, {});
  const local = readJson<DrakoxConfig>(localFile, {});

  const projectMcp = { ...(mcpJson.mcpServers ?? mcpJson.servers ?? {}), ...(project.mcpServers ?? {}), ...(local.mcpServers ?? {}) };

  const config = deepMerge<DrakoxConfig>(
    DEFAULT_CONFIG,
    user,
    { mcpServers: mcpJson.mcpServers ?? mcpJson.servers },
    project,
    local,
    overrides,
  );
  // permission lists accumulate across layers rather than replace
  config.permissions = {
    ...config.permissions,
    allow: uniq([...(user.permissions?.allow ?? []), ...(project.permissions?.allow ?? []), ...(local.permissions?.allow ?? []), ...(overrides.permissions?.allow ?? [])]),
    ask: uniq([...(user.permissions?.ask ?? []), ...(project.permissions?.ask ?? []), ...(local.permissions?.ask ?? []), ...(overrides.permissions?.ask ?? [])]),
    deny: uniq([...(user.permissions?.deny ?? []), ...(project.permissions?.deny ?? []), ...(local.permissions?.deny ?? []), ...(overrides.permissions?.deny ?? [])]),
    sensitivePaths: uniq([...(DEFAULT_CONFIG.permissions?.sensitivePaths ?? []), ...(user.permissions?.sensitivePaths ?? []), ...(project.permissions?.sensitivePaths ?? [])]),
  };

  return {
    config,
    projectRoot,
    sources: [
      { scope: 'default', exists: true },
      { scope: 'user', file: userFile, exists: fs.existsSync(userFile) },
      { scope: 'mcp.json', file: mcpFile, exists: fs.existsSync(mcpFile) },
      { scope: 'project', file: projFile, exists: fs.existsSync(projFile) },
      { scope: 'local', file: localFile, exists: fs.existsSync(localFile) },
    ],
    projectMcpServers: Object.keys(projectMcp),
    hasProjectHooks: Boolean(project.hooks && Object.keys(project.hooks).length) || Boolean(local.hooks && Object.keys(local.hooks).length),
  };
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export function configFileFor(scope: ConfigScope, projectRoot: string): string {
  return scope === 'user' ? paths.config() : projectConfigFile(projectRoot, scope);
}

export function readConfigFile(scope: ConfigScope, projectRoot: string): DrakoxConfig {
  return readJson<DrakoxConfig>(configFileFor(scope, projectRoot), {});
}

/** Apply a mutation to one config layer and save it. */
export function updateConfigFile(scope: ConfigScope, projectRoot: string, mutate: (cfg: DrakoxConfig) => void): DrakoxConfig {
  const file = configFileFor(scope, projectRoot);
  const cfg = readJson<DrakoxConfig>(file, {});
  mutate(cfg);
  writeJson(file, cfg);
  if (scope === 'local') ensureLocalIgnored(projectRoot);
  return cfg;
}

/** Keep personal settings and worktrees out of the user's commits. */
function ensureLocalIgnored(projectRoot: string): void {
  const gi = path.join(projectRoot, '.drakox', '.gitignore');
  try {
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# DrakoX personal files (not shared)\nsettings.local.json\nworktrees/\nlocal/\n');
  } catch {
    /* ignore */
  }
}

// ───────────────────────────── Credentials ─────────────────────────────

export interface Credentials {
  providers?: Record<string, { apiKey?: string }>;
  webSearch?: { apiKey?: string };
  mcp?: Record<string, McpCredential>;
}

export interface McpCredential {
  tokens?: Record<string, unknown>;
  clientInformation?: Record<string, unknown>;
  codeVerifier?: string;
  state?: string;
  /** Secret values for catalog inputs (env/headers), stored outside config files */
  secrets?: Record<string, string>;
}

export function readCredentials(): Credentials {
  return readJson<Credentials>(paths.credentials(), {});
}

export function writeCredentials(c: Credentials): void {
  writeJson(paths.credentials(), c, 0o600);
}

export function updateCredentials(mutate: (c: Credentials) => void): Credentials {
  const c = readCredentials();
  mutate(c);
  writeCredentials(c);
  return c;
}

export function redactKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}••••${key.slice(-4)}`;
}

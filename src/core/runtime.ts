import { EventEmitter } from 'node:events';
import path from 'node:path';
import { loadConfig, readCredentials, type LoadedConfig } from './config.js';
import { ProviderRegistry } from './providers/index.js';
import { McpManager } from './mcp/manager.js';
import { SessionStore } from './session.js';
import { BackgroundShells } from './tools/shell.js';
import { discoverSkills, type Skill } from './skills.js';
import { discoverAgentProfiles, discoverCommands, type AgentProfile, type CustomCommand } from './commands.js';
import { loadInstructions, type LoadedInstructions } from './instructions.js';
import { sandboxInfo, type SandboxInfo } from './sandbox.js';
import { gitRoot } from './git.js';
import { isTrusted } from './trust.js';
import type { DrakoxConfig, SandboxMode } from './types.js';

export interface RuntimeOptions {
  cwd: string;
  overrides?: Partial<DrakoxConfig>;
  /** Base URL used for OAuth redirects (set by the web server) */
  oauthRedirectBase?: () => string | undefined;
  /** Connect MCP servers immediately (default true) */
  connectMcp?: boolean;
}

/**
 * Process-wide services shared by every agent in a workspace: configuration, model providers,
 * MCP connections, session storage and background shells.
 */
export class Runtime extends EventEmitter {
  readonly cwd: string;
  readonly projectRoot: string;
  loaded!: LoadedConfig;
  readonly providers: ProviderRegistry;
  readonly mcp: McpManager;
  readonly store = new SessionStore();
  readonly shells = new BackgroundShells();
  private overrides: Partial<DrakoxConfig>;
  private cache = new Map<string, { at: number; value: unknown }>();
  private detectedModel?: { ref: string; reason: string };

  private constructor(opts: RuntimeOptions) {
    super();
    this.cwd = path.resolve(opts.cwd);
    this.projectRoot = gitRoot(this.cwd) ?? this.cwd;
    this.overrides = opts.overrides ?? {};
    this.loaded = loadConfig(this.projectRoot, this.overrides);
    this.providers = new ProviderRegistry(this.loaded.config, readCredentials());
    this.mcp = new McpManager({
      cwd: this.projectRoot,
      isTrusted: () => this.trusted(),
      projectServers: () => new Set(this.loaded.projectMcpServers),
      oauthRedirectBase: opts.oauthRedirectBase,
    });
    this.mcp.on('change', (s) => this.emit('mcp', s));
    this.mcp.on('auth_url', (x) => this.emit('mcp_auth', x));
  }

  static async create(opts: RuntimeOptions): Promise<Runtime> {
    const rt = new Runtime(opts);
    if (opts.connectMcp !== false) {
      // connect in the background; agents pick up tools as servers come online
      void rt.mcp.sync(rt.config.mcpServers ?? {});
    }
    return rt;
  }

  get config(): DrakoxConfig {
    return this.loaded.config;
  }

  /** Re-read config files and credentials (after settings changes) and resync integrations. */
  async reload(overrides?: Partial<DrakoxConfig>): Promise<void> {
    if (overrides) this.overrides = { ...this.overrides, ...overrides };
    this.loaded = loadConfig(this.projectRoot, this.overrides);
    this.providers.update(this.loaded.config, readCredentials());
    this.cache.clear();
    this.detectedModel = undefined;
    await this.mcp.sync(this.config.mcpServers ?? {});
    this.emit('config', this.config);
  }

  trusted(): boolean {
    return isTrusted(this.projectRoot);
  }

  private cached<T>(key: string, ttl: number, fn: () => T): T {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value as T;
    const value = fn();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  skills(): Skill[] {
    return this.cached('skills', 3000, () => discoverSkills(this.projectRoot));
  }

  agentProfiles(): AgentProfile[] {
    return this.cached('agents', 3000, () => discoverAgentProfiles(this.projectRoot));
  }

  commands(): CustomCommand[] {
    return this.cached('commands', 3000, () => discoverCommands(this.projectRoot));
  }

  instructions(cwd: string = this.cwd): LoadedInstructions {
    return this.cached(`instr:${cwd}`, 3000, () => loadInstructions(this.projectRoot, cwd, this.config));
  }

  sandbox(mode?: SandboxMode): SandboxInfo {
    return sandboxInfo(mode ?? this.config.sandbox ?? 'workspace-write', Boolean(this.config.permissions?.sandboxNetwork));
  }

  async defaultModel(): Promise<{ ref: string; reason: string }> {
    if (this.config.model) return { ref: this.config.model, reason: 'configured' };
    if (!this.detectedModel) this.detectedModel = await this.providers.detectDefaultModel();
    return this.detectedModel;
  }

  async dispose(): Promise<void> {
    this.shells.killAll();
    await this.mcp.closeAll();
  }
}

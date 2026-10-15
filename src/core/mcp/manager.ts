import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ContentPart, McpServerConfig, McpTransportType } from '../types.js';
import { readCredentials, updateCredentials } from '../config.js';
import type { Tool, ToolResult } from '../tools/types.js';
import { quarantine } from '../tools/web.js';
import { packageVersion } from '../paths.js';
import { errorMessage, sha256 } from '../util.js';

export type McpStatus = 'disabled' | 'connecting' | 'connected' | 'error' | 'needs_auth' | 'untrusted';

export interface McpToolInfo {
  name: string;
  drakoxName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean; title?: string };
}

export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface McpServerState {
  name: string;
  status: McpStatus;
  error?: string;
  transport: McpTransportType;
  tools: McpToolInfo[];
  prompts: McpPromptInfo[];
  instructions?: string;
  serverInfo?: { name: string; version: string };
  authUrl?: string;
  source: 'user' | 'project';
  catalogId?: string;
  connectedAt?: number;
}

interface Entry {
  state: McpServerState;
  config: McpServerConfig;
  client?: Client;
  transport?: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
  stderrTail: string;
}

export interface McpManagerOptions {
  cwd: string;
  isTrusted: () => boolean;
  projectServers: () => Set<string>;
  /** Base URL for OAuth callbacks, e.g. http://127.0.0.1:4545 */
  oauthRedirectBase?: () => string | undefined;
}

const EXTRA_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'JAVA_HOME', 'DISPLAY', 'WAYLAND_DISPLAY'];

export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  const full = `mcp__${clean(server)}__${clean(tool)}`;
  if (full.length <= 64) return full;
  return `${full.slice(0, 55)}_${sha256(full).slice(0, 8)}`;
}

/** Strip JSON-Schema keywords some providers reject, and make sure it is an object schema. */
export function sanitizeSchema(schema: unknown): Record<string, unknown> {
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        if (k === '$schema' || k === '$id' || k === '$comment') continue;
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  const s = walk(schema ?? {}) as Record<string, unknown>;
  if (s.type !== 'object') return { type: 'object', properties: {} };
  if (!s.properties) s.properties = {};
  return s;
}

/** Resolve ${secret:KEY}, ${env:VAR} and ${VAR} placeholders. */
export function resolvePlaceholders(server: string, cfg: McpServerConfig): { config: McpServerConfig; missing: string[] } {
  const secrets = readCredentials().mcp?.[server]?.secrets ?? {};
  const missing: string[] = [];
  const sub = (s: string) =>
    s.replace(/\$\{(secret:|env:)?([A-Za-z0-9_.-]+)\}/g, (_m, kind: string | undefined, key: string) => {
      const v = kind === 'secret:' ? secrets[key] : process.env[key];
      if (v === undefined) {
        missing.push(kind === 'secret:' ? `secret ${key}` : `environment variable ${key}`);
        return '';
      }
      return v;
    });
  const mapObj = (o?: Record<string, string>) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, sub(String(v))])) : undefined);
  return {
    config: {
      ...cfg,
      command: cfg.command ? sub(cfg.command) : undefined,
      args: cfg.args?.map((a) => sub(String(a))),
      url: cfg.url ? sub(cfg.url) : undefined,
      env: mapObj(cfg.env),
      headers: mapObj(cfg.headers),
    },
    missing,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// ───────────────────────────── OAuth ─────────────────────────────

/** OAuth 2.1 + PKCE client for remote MCP servers, persisting to ~/.drakox/credentials.json. */
export class DrakoxOAuthProvider implements OAuthClientProvider {
  authUrl?: string;
  constructor(
    private server: string,
    private redirect: string,
    private onAuthUrl: (url: string) => void,
  ) {
    const cred = readCredentials().mcp?.[server] as any;
    if (cred?.redirectUri && cred.redirectUri !== redirect) {
      // registered with another callback URL → force re-registration
      this.save({ clientInformation: undefined, redirectUri: redirect } as any);
    } else if (!cred?.redirectUri) this.save({ redirectUri: redirect } as any);
  }
  private cred(): Record<string, any> {
    return (readCredentials().mcp?.[this.server] as any) ?? {};
  }
  private save(patch: Record<string, unknown>): void {
    updateCredentials((c) => {
      c.mcp ??= {};
      c.mcp[this.server] = { ...(c.mcp[this.server] ?? {}), ...patch } as any;
    });
  }
  get redirectUrl(): string {
    return this.redirect;
  }
  get clientMetadata(): any {
    return {
      client_name: 'DrakoX',
      client_uri: 'https://github.com/Dimova88/DrakoX',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state(): string {
    const s = crypto.randomBytes(16).toString('hex');
    this.save({ state: s });
    return s;
  }
  clientInformation(): any {
    return this.cred().clientInformation;
  }
  saveClientInformation(info: any): void {
    this.save({ clientInformation: info });
  }
  tokens(): any {
    return this.cred().tokens;
  }
  saveTokens(tokens: any): void {
    this.save({ tokens });
  }
  redirectToAuthorization(url: URL): void {
    this.authUrl = url.toString();
    this.onAuthUrl(this.authUrl);
  }
  saveCodeVerifier(v: string): void {
    this.save({ codeVerifier: v });
  }
  codeVerifier(): string {
    const v = this.cred().codeVerifier;
    if (!v) throw new Error('No PKCE code verifier saved — restart sign-in.');
    return v;
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') this.save({ tokens: undefined, clientInformation: undefined, codeVerifier: undefined });
    else if (scope === 'client') this.save({ clientInformation: undefined });
    else if (scope === 'tokens') this.save({ tokens: undefined });
    else if (scope === 'verifier') this.save({ codeVerifier: undefined });
  }
  expectedState(): string | undefined {
    return this.cred().state;
  }
}

// ───────────────────────────── manager ─────────────────────────────

export class McpManager extends EventEmitter {
  private entries = new Map<string, Entry>();
  private oauth = new Map<string, DrakoxOAuthProvider>();

  constructor(private opts: McpManagerOptions) {
    super();
  }

  private changed(): void {
    this.emit('change', this.states());
  }

  states(): McpServerState[] {
    return [...this.entries.values()].map((e) => ({ ...e.state, tools: [...e.state.tools] }));
  }

  state(name: string): McpServerState | undefined {
    return this.entries.get(name)?.state;
  }

  /** Connect new/changed servers and disconnect removed ones. */
  async sync(configs: Record<string, McpServerConfig>): Promise<void> {
    for (const name of [...this.entries.keys()]) if (!configs[name]) await this.disconnect(name, true);
    await Promise.all(
      Object.entries(configs).map(async ([name, cfg]) => {
        const e = this.entries.get(name);
        if (e && JSON.stringify(e.config) === JSON.stringify(cfg) && e.state.status !== 'error' && e.state.status !== 'untrusted') return;
        await this.connect(name, cfg);
      }),
    );
  }

  async connect(name: string, cfg: McpServerConfig): Promise<McpServerState> {
    await this.disconnect(name, false);
    const transport: McpTransportType = cfg.type ?? (cfg.url ? (/\/sse\/?$/.test(cfg.url) ? 'sse' : 'http') : 'stdio');
    const state: McpServerState = {
      name,
      status: 'connecting',
      transport,
      tools: [],
      prompts: [],
      source: this.opts.projectServers().has(name) ? 'project' : 'user',
      catalogId: cfg.catalogId,
    };
    const entry: Entry = { state, config: cfg, stderrTail: '' };
    this.entries.set(name, entry);
    if (cfg.disabled) {
      state.status = 'disabled';
      this.changed();
      return state;
    }
    if (transport === 'stdio' && state.source === 'project' && !this.opts.isTrusted()) {
      state.status = 'untrusted';
      state.error = 'Defined by this project. Trust the workspace to allow it to start local commands.';
      this.changed();
      return state;
    }
    this.changed();
    try {
      await withTimeout(this.open(entry, transport), transport === 'stdio' ? 120_000 : 30_000, `Connecting to ${name}`);
      state.status = 'connected';
      state.error = undefined;
      state.authUrl = undefined;
      state.connectedAt = Date.now();
    } catch (err) {
      const provider = this.oauth.get(name);
      if (err instanceof UnauthorizedError || provider?.authUrl) {
        state.status = 'needs_auth';
        state.authUrl = provider?.authUrl;
        state.error = state.authUrl ? 'Sign-in required' : 'Sign-in required (open DrakoX UI to authorize)';
      } else {
        state.status = 'error';
        const tail = entry.stderrTail.trim().split('\n').slice(-6).join('\n');
        state.error = errorMessage(err) + (tail ? `\n${tail}` : '');
      }
      // keep the transport for finishAuth(); close anything else
      if (state.status !== 'needs_auth') await this.closeEntry(entry);
    }
    this.changed();
    return state;
  }

  private async open(entry: Entry, type: McpTransportType): Promise<void> {
    const name = entry.state.name;
    const { config, missing } = resolvePlaceholders(name, entry.config);
    if (missing.length) throw new Error(`Missing ${missing.join(', ')}. Edit the integration to provide it.`);
    const client = new Client({ name: 'drakox', version: packageVersion() }, { capabilities: {} });
    let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
    if (type === 'stdio') {
      if (!config.command) throw new Error('stdio server needs a "command"');
      const env: Record<string, string> = { ...getDefaultEnvironment() };
      for (const k of EXTRA_ENV) if (process.env[k]) env[k] = process.env[k]!;
      Object.assign(env, config.env ?? {});
      const t = new StdioClientTransport({ command: config.command, args: config.args ?? [], env, cwd: config.cwd ?? this.opts.cwd, stderr: 'pipe' });
      t.stderr?.on('data', (d: Buffer) => {
        entry.stderrTail = (entry.stderrTail + d.toString()).slice(-4000);
      });
      transport = t;
    } else {
      if (!config.url) throw new Error('remote server needs a "url"');
      const url = new URL(config.url);
      const requestInit: RequestInit = { headers: config.headers ?? {} };
      const authProvider = entry.config.oauth ? this.oauthProvider(name) : undefined;
      transport = type === 'sse' ? new SSEClientTransport(url, { requestInit, authProvider }) : new StreamableHTTPClientTransport(url, { requestInit, authProvider });
    }
    entry.client = client;
    entry.transport = transport;
    try {
      await client.connect(transport);
    } catch (err) {
      // Auto-fallback for legacy servers: Streamable HTTP failed (not auth) → try SSE once.
      if (type === 'http' && !entry.config.type && !(err instanceof UnauthorizedError)) {
        const sse = new SSEClientTransport(new URL(config.url!), { requestInit: { headers: config.headers ?? {} } });
        const c2 = new Client({ name: 'drakox', version: packageVersion() }, { capabilities: {} });
        entry.client = c2;
        entry.transport = sse;
        await c2.connect(sse);
        entry.state.transport = 'sse';
      } else throw err;
    }
    const c = entry.client!;
    const info = c.getServerVersion();
    entry.state.serverInfo = info ? { name: info.name, version: info.version } : undefined;
    entry.state.instructions = c.getInstructions();
    await this.refreshTools(entry);
    try {
      if (c.getServerCapabilities()?.prompts) {
        const p = await c.listPrompts();
        entry.state.prompts = p.prompts.map((x) => ({ name: x.name, description: x.description, arguments: x.arguments as McpPromptInfo['arguments'] }));
      }
    } catch {
      /* prompts optional */
    }
    c.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await this.refreshTools(entry);
      this.changed();
    });
    entry.transport!.onclose = () => {
      if (entry.state.status === 'connected') {
        entry.state.status = 'error';
        entry.state.error = 'Connection closed' + (entry.stderrTail ? `\n${entry.stderrTail.trim().split('\n').slice(-4).join('\n')}` : '');
        this.changed();
      }
    };
  }

  private async refreshTools(entry: Entry): Promise<void> {
    const c = entry.client;
    if (!c) return;
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const res = await c.listTools(cursor ? { cursor } : undefined);
      for (const t of res.tools) {
        tools.push({
          name: t.name,
          drakoxName: mcpToolName(entry.state.name, t.name),
          description: t.description ?? t.title ?? t.name,
          inputSchema: sanitizeSchema(t.inputSchema),
          annotations: t.annotations as McpToolInfo['annotations'],
        });
      }
      cursor = res.nextCursor;
    } while (cursor);
    entry.state.tools = tools;
  }

  private oauthProvider(name: string): DrakoxOAuthProvider {
    const base = this.opts.oauthRedirectBase?.() ?? 'http://127.0.0.1:4546';
    const redirect = `${base.replace(/\/+$/, '')}/oauth/callback/${encodeURIComponent(name)}`;
    const existing = this.oauth.get(name);
    if (existing && existing.redirectUrl === redirect) {
      existing.authUrl = undefined;
      return existing;
    }
    const p = new DrakoxOAuthProvider(name, redirect, (url) => {
      const e = this.entries.get(name);
      if (e) e.state.authUrl = url;
      this.emit('auth_url', { server: name, url });
    });
    this.oauth.set(name, p);
    return p;
  }

  /** Complete OAuth after the browser redirected back with ?code=…&state=… */
  async finishAuth(name: string, code: string, state?: string): Promise<McpServerState> {
    const entry = this.entries.get(name);
    const provider = this.oauth.get(name);
    if (!entry || !provider) throw new Error(`No pending sign-in for ${name}`);
    const expected = provider.expectedState();
    if (expected && state && expected !== state) throw new Error('OAuth state mismatch — please retry sign-in.');
    const t = entry.transport as StreamableHTTPClientTransport | SSEClientTransport | undefined;
    if (!t || !('finishAuth' in t)) throw new Error('Transport does not support OAuth');
    await t.finishAuth(code);
    return this.connect(name, entry.config);
  }

  async disconnect(name: string, remove: boolean): Promise<void> {
    const e = this.entries.get(name);
    if (!e) return;
    await this.closeEntry(e);
    if (remove) {
      this.entries.delete(name);
      this.changed();
    }
  }

  private async closeEntry(e: Entry): Promise<void> {
    const t = e.transport;
    const c = e.client;
    e.client = undefined;
    e.transport = undefined;
    try {
      if (t) t.onclose = undefined;
      await c?.close();
    } catch {
      /* ignore */
    }
    try {
      await t?.close();
    } catch {
      /* ignore */
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((n) => this.disconnect(n, false)));
  }

  /** DrakoX tool wrappers for every connected server's tools. */
  tools(): Tool<any>[] {
    const out: Tool<any>[] = [];
    for (const e of this.entries.values()) {
      if (e.state.status !== 'connected') continue;
      for (const t of e.state.tools) {
        const server = e.state.name;
        out.push({
          name: t.drakoxName,
          description: `[${server}] ${t.description}`.slice(0, 1024),
          parameters: t.inputSchema,
          kind: 'mcp',
          parallelSafe: Boolean(t.annotations?.readOnlyHint),
          annotations: {
            readOnly: t.annotations?.readOnlyHint,
            destructive: t.annotations?.destructiveHint,
            openWorld: t.annotations?.openWorldHint,
            server,
            tool: t.name,
          },
          title: () => `${server} › ${t.annotations?.title ?? t.name}`,
          run: (args, ctx) => this.callTool(server, t.name, args, ctx.signal),
        });
      }
    }
    return out;
  }

  instructions(): { server: string; text: string }[] {
    return [...this.entries.values()].filter((e) => e.state.status === 'connected' && e.state.instructions).map((e) => ({ server: e.state.name, text: e.state.instructions! }));
  }

  async callTool(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const e = this.entries.get(server);
    if (!e?.client || e.state.status !== 'connected') return { content: `Integration "${server}" is not connected.`, isError: true };
    try {
      const res: any = await e.client.callTool({ name: tool, arguments: args }, undefined, {
        signal,
        timeout: e.config.timeoutMs ?? 300_000,
        resetTimeoutOnProgress: true,
      });
      return convertResult(server, tool, res);
    } catch (err) {
      return { content: `${server}.${tool} failed: ${errorMessage(err)}`, isError: true };
    }
  }

  async getPrompt(server: string, name: string, args: Record<string, string>): Promise<string> {
    const e = this.entries.get(server);
    if (!e?.client) throw new Error(`Integration "${server}" is not connected.`);
    const res = await e.client.getPrompt({ name, arguments: args });
    return res.messages
      .map((m: any) => (m.content?.type === 'text' ? m.content.text : m.content?.resource?.text ?? ''))
      .filter(Boolean)
      .join('\n\n');
  }
}

function convertResult(server: string, tool: string, res: any): ToolResult {
  const parts: ContentPart[] = [];
  const texts: string[] = [];
  const images: { mediaType: string; data: string }[] = [];
  for (const c of res?.content ?? []) {
    if (c.type === 'text') texts.push(c.text);
    else if (c.type === 'image') images.push({ mediaType: c.mimeType, data: c.data });
    else if (c.type === 'audio') texts.push(`[audio ${c.mimeType}, ${Math.round((c.data?.length ?? 0) * 0.75)} bytes]`);
    else if (c.type === 'resource') texts.push(c.resource?.text ?? `[resource ${c.resource?.uri} (${c.resource?.mimeType ?? 'binary'})]`);
    else if (c.type === 'resource_link') texts.push(`[resource link] ${c.name ?? ''} ${c.uri}`);
  }
  if (!texts.length && res?.structuredContent) texts.push(JSON.stringify(res.structuredContent, null, 2));
  const body = texts.join('\n').slice(0, 100_000) || (images.length ? '' : '(no output)');
  if (body) parts.push({ type: 'text', text: quarantine(`mcp:${server}/${tool}`, body) });
  for (const img of images) parts.push({ type: 'image', mediaType: img.mediaType, data: img.data });
  return {
    content: parts.length === 1 && parts[0]!.type === 'text' ? parts[0]!.text : parts,
    isError: Boolean(res?.isError),
    display: images.length ? { kind: 'images', images } : { kind: 'text', text: body.slice(0, 300) },
  };
}

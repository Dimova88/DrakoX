import { readConfigFile, updateConfigFile, updateCredentials, type ConfigScope } from './config.js';
import { buildCatalogConfig, catalogEntry } from './mcp/catalog.js';
import type { McpServerConfig } from './types.js';
import { readJson, writeJson } from './util.js';
import path from 'node:path';
import { describeNetworkError } from './providers/types.js';

/**
 * Add / remove / toggle integrations (MCP servers) in the right config layer, keeping secrets in
 * ~/.drakox/credentials.json (0600) instead of config files that may be committed.
 */

export function validServerName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name);
}

export function saveMcpSecrets(name: string, secrets: Record<string, string>): void {
  if (!Object.keys(secrets).length) return;
  updateCredentials((c) => {
    c.mcp ??= {};
    c.mcp[name] ??= {};
    c.mcp[name]!.secrets = { ...(c.mcp[name]!.secrets ?? {}), ...secrets };
  });
}

/**
 * Move literal secrets out of a pasted config: values of env vars / headers that look like credentials
 * become ${secret:KEY} references.
 */
export function extractSecrets(cfg: McpServerConfig): { config: McpServerConfig; secrets: Record<string, string> } {
  const secrets: Record<string, string> = {};
  const isSecretKey = (k: string) => /(token|secret|key|password|passwd|auth|credential|pat)\b|_KEY$|_TOKEN$/i.test(k);
  const out: McpServerConfig = { ...cfg };
  if (cfg.env) {
    out.env = {};
    for (const [k, v] of Object.entries(cfg.env)) {
      if (isSecretKey(k) && v && !/^\$\{/.test(v)) {
        secrets[k] = v;
        out.env[k] = `\${secret:${k}}`;
      } else out.env[k] = v;
    }
  }
  if (cfg.headers) {
    out.headers = {};
    for (const [k, v] of Object.entries(cfg.headers)) {
      const m = /^(Bearer|Token|Basic)\s+(.+)$/i.exec(v);
      if ((/authorization/i.test(k) || isSecretKey(k)) && v && !/\$\{/.test(v)) {
        const key = k.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
        secrets[key] = m ? m[2]! : v;
        out.headers[k] = m ? `${m[1]} \${secret:${key}}` : `\${secret:${key}}`;
      } else out.headers[k] = v;
    }
  }
  return { config: out, secrets };
}

function mcpJsonFile(projectRoot: string): string {
  return path.join(projectRoot, '.mcp.json');
}

export function addMcpServer(projectRoot: string, name: string, config: McpServerConfig, scope: ConfigScope = 'user', secrets: Record<string, string> = {}): void {
  if (!validServerName(name)) throw new Error(`Invalid integration name "${name}" (letters, digits, - _ . only)`);
  const clean: McpServerConfig = { ...config };
  for (const k of Object.keys(clean) as (keyof McpServerConfig)[]) if (clean[k] === undefined) delete clean[k];
  if (scope === 'project') {
    // project-shared servers go to .mcp.json (the cross-tool standard), never with secrets inline
    const file = mcpJsonFile(projectRoot);
    const data = readJson<{ mcpServers?: Record<string, McpServerConfig> }>(file, {});
    data.mcpServers = { ...(data.mcpServers ?? {}), [name]: clean };
    writeJson(file, data);
  } else {
    updateConfigFile(scope, projectRoot, (cfg) => {
      cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [name]: clean };
    });
  }
  saveMcpSecrets(name, secrets);
}

export function installCatalogServer(projectRoot: string, id: string, inputs: Record<string, string>, opts: { scope?: ConfigScope; name?: string } = {}): { name: string; config: McpServerConfig } {
  const entry = catalogEntry(id);
  if (!entry) throw new Error(`Unknown catalog integration "${id}"`);
  const { config, secrets } = buildCatalogConfig(entry, inputs);
  if (entry.auth === 'oauth') config.oauth = true;
  const name = opts.name ?? entry.id;
  addMcpServer(projectRoot, name, config, opts.scope ?? 'user', secrets);
  return { name, config };
}

/** Which layers define a server. */
export function serverScopes(projectRoot: string, name: string): (ConfigScope | 'mcp.json')[] {
  const out: (ConfigScope | 'mcp.json')[] = [];
  for (const scope of ['user', 'project', 'local'] as ConfigScope[]) if (readConfigFile(scope, projectRoot).mcpServers?.[name]) out.push(scope);
  const mj = readJson<{ mcpServers?: Record<string, unknown>; servers?: Record<string, unknown> }>(mcpJsonFile(projectRoot), {});
  if (mj.mcpServers?.[name] || mj.servers?.[name]) out.push('mcp.json');
  return out;
}

export function removeMcpServer(projectRoot: string, name: string): string[] {
  const removed: string[] = [];
  for (const scope of ['user', 'project', 'local'] as ConfigScope[]) {
    if (readConfigFile(scope, projectRoot).mcpServers?.[name]) {
      updateConfigFile(scope, projectRoot, (cfg) => {
        if (cfg.mcpServers) delete cfg.mcpServers[name];
      });
      removed.push(scope);
    }
  }
  const file = mcpJsonFile(projectRoot);
  const mj = readJson<{ mcpServers?: Record<string, unknown>; servers?: Record<string, unknown> }>(file, {});
  if (mj.mcpServers?.[name] || mj.servers?.[name]) {
    delete mj.mcpServers?.[name];
    delete mj.servers?.[name];
    writeJson(file, mj);
    removed.push('.mcp.json');
  }
  updateCredentials((c) => {
    if (c.mcp?.[name]) delete c.mcp[name];
  });
  return removed;
}

/** Enable/disable without deleting (written to the layer that defines it, else local). */
export function setMcpEnabled(projectRoot: string, name: string, enabled: boolean): void {
  const scopes = serverScopes(projectRoot, name).filter((s): s is ConfigScope => s !== 'mcp.json');
  const scope: ConfigScope = scopes.includes('local') ? 'local' : scopes[0] ?? 'local';
  updateConfigFile(scope, projectRoot, (cfg) => {
    cfg.mcpServers ??= {};
    const cur = cfg.mcpServers[name] ?? {};
    cfg.mcpServers[name] = { ...cur, disabled: !enabled };
  });
}

// ───────────────────────────── official MCP Registry ─────────────────────────────

export interface RegistryServer {
  name: string;
  title?: string;
  description: string;
  version?: string;
  repository?: string;
  website?: string;
  /** Ready-to-install configuration (best transport found) */
  install?: McpServerConfig;
  /** Inputs the user must provide (env vars / headers) */
  inputs: { key: string; description?: string; required: boolean; secret: boolean; target: 'env' | 'header' }[];
  kind: 'npm' | 'pypi' | 'oci' | 'remote' | 'unknown';
}

export const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';

export async function searchRegistry(query: string, limit = 30, signal?: AbortSignal): Promise<RegistryServer[]> {
  const url = `${REGISTRY_URL}?search=${encodeURIComponent(query)}&limit=${limit}&version=latest`;
  let res: Response;
  try {
    res = await fetch(url, { signal: signal ?? AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new Error(describeNetworkError(err, url, 'MCP Registry'));
  }
  if (!res.ok) throw new Error(`MCP Registry returned ${res.status}`);
  const data: any = await res.json();
  const list: any[] = data.servers ?? data.data ?? [];
  const out: RegistryServer[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const s = item.server ?? item;
    if (!s?.name || seen.has(s.name)) continue;
    seen.add(s.name);
    out.push(fromRegistry(s));
  }
  return out;
}

export function fromRegistry(s: any): RegistryServer {
  const inputs: RegistryServer['inputs'] = [];
  let install: McpServerConfig | undefined;
  let kind: RegistryServer['kind'] = 'unknown';
  const remotes: any[] = s.remotes ?? [];
  const packages: any[] = s.packages ?? [];
  const pkg = packages.find((p) => (p.registryType ?? p.registry_type ?? p.registry_name) === 'npm') ?? packages.find((p) => (p.registryType ?? p.registry_type ?? p.registry_name) === 'pypi') ?? packages[0];
  if (pkg) {
    const type = pkg.registryType ?? pkg.registry_type ?? pkg.registry_name;
    const id = pkg.identifier ?? pkg.name;
    const version = pkg.version && pkg.version !== 'latest' ? pkg.version : undefined;
    const pkgArgs: string[] = [];
    for (const a of pkg.packageArguments ?? pkg.package_arguments ?? []) {
      if (a.type === 'positional' && (a.value ?? a.default ?? a.valueHint)) pkgArgs.push(String(a.value ?? a.default ?? a.valueHint));
      else if (a.type === 'named' && a.name && a.value) pkgArgs.push(String(a.name), String(a.value));
    }
    const env: Record<string, string> = {};
    for (const ev of pkg.environmentVariables ?? pkg.environment_variables ?? []) {
      const key = ev.name;
      if (!key) continue;
      const secret = Boolean(ev.isSecret ?? ev.is_secret) || /(token|key|secret|password)/i.test(key);
      inputs.push({ key, description: ev.description, required: Boolean(ev.isRequired ?? ev.is_required), secret, target: 'env' });
      env[key] = secret ? `\${secret:${key}}` : `{{${key}}}`;
    }
    const transport = pkg.transport?.type ?? pkg.transport_type ?? 'stdio';
    if (transport === 'stdio') {
      if (type === 'npm') {
        kind = 'npm';
        install = { type: 'stdio', command: 'npx', args: ['-y', version ? `${id}@${version}` : id, ...pkgArgs] };
      } else if (type === 'pypi') {
        kind = 'pypi';
        install = { type: 'stdio', command: 'uvx', args: [version ? `${id}==${version}` : id, ...pkgArgs] };
      } else if (type === 'oci' || type === 'docker') {
        kind = 'oci';
        const envFlags = Object.keys(env).flatMap((k) => ['-e', k]);
        install = { type: 'stdio', command: 'docker', args: ['run', '-i', '--rm', ...envFlags, version ? `${id}:${version}` : id, ...pkgArgs] };
      }
      if (install && Object.keys(env).length) install.env = env;
    }
  }
  if (!install && remotes.length) {
    const r = remotes.find((x) => (x.type ?? x.transport_type) === 'streamable-http') ?? remotes[0];
    kind = 'remote';
    const headers: Record<string, string> = {};
    for (const h of r.headers ?? []) {
      if (!h.name) continue;
      const key = h.name.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
      const secret = Boolean(h.isSecret ?? h.is_secret) || /authorization|token|key/i.test(h.name);
      inputs.push({ key, description: h.description, required: Boolean(h.isRequired ?? h.is_required), secret, target: 'header' });
      headers[h.name] = /authorization/i.test(h.name) ? `Bearer \${secret:${key}}` : secret ? `\${secret:${key}}` : `{{${key}}}`;
    }
    install = { type: (r.type ?? r.transport_type) === 'sse' ? 'sse' : 'http', url: r.url, ...(Object.keys(headers).length ? { headers } : {}) };
  }
  return {
    name: s.name,
    title: s.title,
    description: s.description ?? '',
    version: s.version ?? s.version_detail?.version,
    repository: s.repository?.url,
    website: s.websiteUrl ?? s.website_url,
    install,
    inputs,
    kind,
  };
}

/** Turn a registry entry + user inputs into a config (+ secrets). */
export function buildRegistryConfig(server: RegistryServer, values: Record<string, string>): { config: McpServerConfig; secrets: Record<string, string> } {
  if (!server.install) throw new Error('This registry entry has no installable package or remote endpoint.');
  const secrets: Record<string, string> = {};
  for (const inp of server.inputs) {
    const v = (values[inp.key] ?? '').trim();
    if (!v && inp.required) throw new Error(`${inp.key} is required`);
    if (inp.secret && v) secrets[inp.key] = v;
  }
  const fill = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => values[k] ?? '');
  const c = server.install;
  const config: McpServerConfig = {
    ...c,
    args: c.args?.map(fill),
    env: c.env ? Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, fill(v)]).filter(([k, v]) => v !== '' || server.inputs.find((i) => i.key === k)?.required)) : undefined,
    headers: c.headers ? Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k, fill(v)])) : undefined,
  };
  // drop secret refs the user left empty (optional inputs)
  for (const inp of server.inputs) {
    if (inp.secret && !secrets[inp.key]) {
      if (config.env) delete config.env[inp.key];
      if (config.headers) for (const [h, v] of Object.entries(config.headers)) if (v.includes(`\${secret:${inp.key}}`)) delete config.headers[h];
    }
  }
  for (const k of Object.keys(config) as (keyof McpServerConfig)[]) if (config[k] === undefined) delete config[k];
  return { config, secrets };
}

export function registryServerName(fullName: string): string {
  const last = fullName.split('/').pop() ?? fullName;
  return last.replace(/^mcp-server-|-mcp-server$|^server-|-mcp$|^mcp-/g, '').replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 40) || 'server';
}

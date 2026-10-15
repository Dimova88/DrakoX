import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { McpServerConfig } from '../types.js';

/** Discover MCP servers already configured in other agents/IDEs so users can import them in one click. */
export interface ImportSource {
  id: string;
  name: string;
  file: string;
  servers: Record<string, McpServerConfig>;
}

function readJsonFile(file: string): any {
  try {
    // tolerate JSONC comments (VS Code)
    const raw = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Normalize the many dialects (mcpServers / servers / serverUrl / httpUrl / opencode local+remote). */
export function normalizeServer(raw: any): McpServerConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  // opencode: { type: "local", command: ["npx","x"], environment } | { type: "remote", url, headers }
  if (raw.type === 'local' && Array.isArray(raw.command)) {
    return { type: 'stdio', command: raw.command[0], args: raw.command.slice(1), env: raw.environment, disabled: raw.enabled === false || undefined };
  }
  if (raw.type === 'remote') return { type: 'http', url: raw.url, headers: raw.headers, disabled: raw.enabled === false || undefined };
  const url = raw.url ?? raw.serverUrl ?? raw.httpUrl;
  if (url) {
    const type = raw.type === 'sse' || raw.transport === 'sse' ? 'sse' : raw.type === 'http' || raw.type === 'streamable-http' || raw.httpUrl ? 'http' : undefined;
    return { type, url, headers: raw.headers, disabled: raw.disabled || undefined };
  }
  if (raw.command) {
    return {
      type: 'stdio',
      command: String(raw.command),
      args: Array.isArray(raw.args) ? raw.args.map(String) : undefined,
      env: raw.env,
      cwd: raw.cwd,
      disabled: raw.disabled || raw.enabled === false || undefined,
    };
  }
  return undefined;
}

function collect(obj: Record<string, any> | undefined): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(obj ?? {})) {
    const s = normalizeServer(raw);
    if (s) out[name] = s;
  }
  return out;
}

export function discoverImportSources(projectRoot: string): ImportSource[] {
  const home = os.homedir();
  const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const claudeDesktop =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : process.platform === 'win32'
        ? path.join(appData, 'Claude', 'claude_desktop_config.json')
        : path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  const vscodeUser =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
      : process.platform === 'win32'
        ? path.join(appData, 'Code', 'User', 'mcp.json')
        : path.join(home, '.config', 'Code', 'User', 'mcp.json');

  const candidates: { id: string; name: string; file: string; pick: (j: any) => Record<string, any> | undefined }[] = [
    { id: 'claude-desktop', name: 'Claude Desktop', file: claudeDesktop, pick: (j) => j?.mcpServers },
    { id: 'claude-code', name: 'Claude Code (user)', file: path.join(home, '.claude.json'), pick: (j) => j?.mcpServers },
    { id: 'claude-code-project', name: 'Claude Code (this project)', file: path.join(home, '.claude.json'), pick: (j) => j?.projects?.[projectRoot]?.mcpServers },
    { id: 'cursor', name: 'Cursor (global)', file: path.join(home, '.cursor', 'mcp.json'), pick: (j) => j?.mcpServers },
    { id: 'cursor-project', name: 'Cursor (this project)', file: path.join(projectRoot, '.cursor', 'mcp.json'), pick: (j) => j?.mcpServers },
    { id: 'vscode', name: 'VS Code (user)', file: vscodeUser, pick: (j) => j?.servers },
    { id: 'vscode-project', name: 'VS Code (this project)', file: path.join(projectRoot, '.vscode', 'mcp.json'), pick: (j) => j?.servers },
    { id: 'windsurf', name: 'Windsurf', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), pick: (j) => j?.mcpServers },
    { id: 'gemini-cli', name: 'Gemini CLI', file: path.join(home, '.gemini', 'settings.json'), pick: (j) => j?.mcpServers },
    { id: 'antigravity', name: 'Antigravity', file: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'), pick: (j) => j?.mcpServers },
    { id: 'opencode', name: 'opencode', file: path.join(home, '.config', 'opencode', 'opencode.json'), pick: (j) => j?.mcp },
  ];
  const out: ImportSource[] = [];
  for (const c of candidates) {
    if (!fs.existsSync(c.file)) continue;
    const servers = collect(c.pick(readJsonFile(c.file)));
    if (Object.keys(servers).length) out.push({ id: c.id, name: c.name, file: c.file, servers });
  }
  // Codex CLI: ~/.codex/config.toml [mcp_servers.<name>]
  const codex = path.join(process.env.CODEX_HOME ?? path.join(home, '.codex'), 'config.toml');
  if (fs.existsSync(codex)) {
    try {
      const t: any = parseToml(fs.readFileSync(codex, 'utf8'));
      const servers = collect(t?.mcp_servers);
      if (Object.keys(servers).length) out.push({ id: 'codex', name: 'Codex CLI', file: codex, servers });
    } catch {
      /* invalid toml */
    }
  }
  return out;
}

/** Parse pasted JSON in any common dialect: {mcpServers:{…}}, {servers:{…}}, a single server, or {name: server}. */
export function parsePastedConfig(text: string, fallbackName = 'custom'): Record<string, McpServerConfig> {
  const j = JSON.parse(text);
  if (j?.mcpServers) return collect(j.mcpServers);
  if (j?.servers) return collect(j.servers);
  if (j?.mcp && typeof j.mcp === 'object') return collect(j.mcp);
  const single = normalizeServer(j);
  if (single) return { [fallbackName]: single };
  return collect(j);
}

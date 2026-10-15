import http from 'node:http';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { Runtime } from '../core/runtime.js';
import { CATALOG, catalogEntry } from '../core/mcp/catalog.js';
import { discoverImportSources, parsePastedConfig } from '../core/mcp/import.js';
import {
  addMcpServer,
  buildRegistryConfig,
  extractSecrets,
  installCatalogServer,
  registryServerName,
  removeMcpServer,
  searchRegistry,
  serverScopes,
  setMcpEnabled,
} from '../core/integrations.js';
import { readCredentials, updateConfigFile, updateCredentials, type ConfigScope } from '../core/config.js';
import { PROVIDER_PRESETS } from '../core/providers/index.js';
import { setTrusted } from '../core/trust.js';
import { packageVersion, paths } from '../core/paths.js';
import { detectSandbox } from '../core/sandbox.js';
import type { McpServerConfig } from '../core/types.js';
import { c } from './ansi.js';
import { mcpLine, modelsText, sessionsText } from './info.js';
import { formatCost } from '../core/util.js';

// ───────────────────────────── prompts ─────────────────────────────

export function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  return new Promise((resolve) => {
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
}

export function promptHidden(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  const anyRl = rl as any;
  let asking = true;
  const orig = anyRl._writeToOutput?.bind(rl);
  if (orig) {
    anyRl._writeToOutput = (s: string) => {
      if (!asking || s.includes(question)) orig(s);
      else orig(s.replace(/[^\r\n]/g, '•'));
    };
  }
  return new Promise((resolve) => {
    rl.question(question, (a) => {
      asking = false;
      rl.close();
      resolve(a.trim());
    });
  });
}

export function openBrowser(url: string): void {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    /* no browser available */
  }
}

function parseKV(list: string[], sep: '=' | ':'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list) {
    const i = item.indexOf(sep);
    if (i <= 0) throw new Error(`Expected KEY${sep}VALUE, got "${item}"`);
    out[item.slice(0, i).trim()] = item.slice(i + 1).trim();
  }
  return out;
}

// ───────────────────────────── mcp ─────────────────────────────

export interface McpArgs {
  sub: string;
  positionals: string[];
  rest: string[];
  scope?: ConfigScope;
  env: string[];
  headers: string[];
  transport?: string;
  name?: string;
  set: string[];
  from?: string;
}

export async function mcpCommand(rt: Runtime, a: McpArgs): Promise<number> {
  const root = rt.projectRoot;
  switch (a.sub) {
    case 'list':
    case 'ls':
    case undefined:
    case '': {
      const names = Object.keys(rt.config.mcpServers ?? {});
      if (!names.length) {
        console.log(c.dim('No integrations configured.'));
        console.log(`Browse the catalog: ${c.brand('drakox mcp catalog')} · add your own: ${c.brand('drakox mcp add <name> -- <command>')} · import: ${c.brand('drakox mcp import')}`);
        return 0;
      }
      console.log(c.dim(`Connecting to ${names.length} integration(s)…`));
      await rt.mcp.sync(rt.config.mcpServers ?? {});
      for (const s of rt.mcp.states()) console.log(mcpLine(s));
      return 0;
    }
    case 'catalog': {
      const q = a.positionals.join(' ').toLowerCase();
      const entries = CATALOG.filter((e) => !q || `${e.id} ${e.name} ${e.description} ${e.category}`.toLowerCase().includes(q));
      const cats = [...new Set(entries.map((e) => e.category))];
      for (const cat of cats) {
        console.log(`\n${c.bold(cat)}`);
        for (const e of entries.filter((x) => x.category === cat)) {
          const auth = e.auth === 'oauth' ? c.accent('sign-in') : e.auth === 'token' ? c.warn('token') : e.auth === 'local-app' ? c.dim('local app') : c.ok('no auth');
          console.log(`  ${c.brand(e.id.padEnd(20))} ${e.name.padEnd(22)} ${auth} ${c.dim('· ' + e.description.slice(0, 70))}`);
        }
      }
      console.log(`\nInstall: ${c.brand('drakox mcp install <id>')} · search thousands more: ${c.brand('drakox mcp search <query>')}`);
      return 0;
    }
    case 'install': {
      const id = a.positionals[0];
      const entry = id ? catalogEntry(id) : undefined;
      if (!entry) {
        console.error(`Unknown catalog id "${id ?? ''}". See: drakox mcp catalog`);
        return 1;
      }
      const preset = parseKV(a.set, '=');
      const inputs: Record<string, string> = { ...preset };
      if (entry.requires) console.log(c.dim(`Requires: ${entry.requires}`));
      for (const inp of entry.inputs ?? []) {
        if (inputs[inp.key]) continue;
        const label = `${inp.label}${inp.optional ? c.dim(' (optional)') : ''}${inp.help ? c.dim(` — ${inp.help}`) : ''}${inp.default ? c.dim(` [${inp.default}]`) : ''}: `;
        inputs[inp.key] = inp.secret ? await promptHidden(label) : await prompt(label);
      }
      const { name } = installCatalogServer(root, entry.id, inputs, { scope: a.scope ?? 'user', name: a.name });
      console.log(c.ok(`✓ Installed ${entry.name} as "${name}" (${a.scope ?? 'user'} scope).`));
      await rt.reload();
      const st = rt.mcp.state(name);
      if (st) console.log(mcpLine(st));
      if (st?.status === 'needs_auth') console.log(`Sign in: ${c.brand(`drakox mcp login ${name}`)}`);
      return 0;
    }
    case 'add': {
      const name = a.positionals[0];
      if (!name) {
        console.error('Usage: drakox mcp add <name> [--scope user|project|local] [-e KEY=VAL] [-H "Header: value"] -- <command> [args…]\n       drakox mcp add <name> <https://server/mcp>');
        return 1;
      }
      let cfg: McpServerConfig;
      const url = a.positionals[1];
      if (a.rest.length) {
        cfg = { type: 'stdio', command: a.rest[0]!, args: a.rest.slice(1) };
        if (a.env.length) cfg.env = parseKV(a.env, '=');
      } else if (url && /^https?:\/\//.test(url)) {
        cfg = { type: a.transport === 'sse' ? 'sse' : 'http', url };
        if (a.headers.length) cfg.headers = parseKV(a.headers, ':');
      } else if (url) {
        cfg = { type: 'stdio', command: url, args: a.positionals.slice(2) };
        if (a.env.length) cfg.env = parseKV(a.env, '=');
      } else {
        console.error('Provide a command after "--" or a URL.');
        return 1;
      }
      const { config, secrets } = extractSecrets(cfg);
      addMcpServer(root, name, config, a.scope ?? 'user', secrets);
      console.log(c.ok(`✓ Added "${name}" (${a.scope ?? 'user'} scope)${Object.keys(secrets).length ? ` · ${Object.keys(secrets).length} secret(s) stored in ~/.drakox/credentials.json` : ''}`));
      await rt.reload();
      const st = rt.mcp.state(name);
      if (st) console.log(mcpLine(st));
      return st?.status === 'error' ? 1 : 0;
    }
    case 'paste': {
      const text = fs.readFileSync(0, 'utf8');
      const servers = parsePastedConfig(text, a.name ?? 'custom');
      for (const [name, cfg] of Object.entries(servers)) {
        const { config, secrets } = extractSecrets(cfg);
        addMcpServer(root, name, config, a.scope ?? 'user', secrets);
        console.log(c.ok(`✓ Added "${name}"`));
      }
      await rt.reload();
      return 0;
    }
    case 'search': {
      const q = a.positionals.join(' ');
      if (!q) {
        console.error('Usage: drakox mcp search <query>');
        return 1;
      }
      try {
        const results = await searchRegistry(q, 25);
        if (!results.length) console.log(c.dim('No results in the MCP Registry.'));
        for (const r of results) {
          console.log(`${c.brand(r.name)} ${c.dim(`${r.version ?? ''} · ${r.kind}`)}\n  ${r.description.slice(0, 140)}${r.inputs.length ? c.dim(`\n  needs: ${r.inputs.map((i) => i.key).join(', ')}`) : ''}`);
        }
        if (results.length) console.log(`\nInstall: ${c.brand('drakox mcp add-registry <name>')}`);
      } catch (err) {
        console.error(c.err(`Registry search failed: ${(err as Error).message}`));
        return 1;
      }
      return 0;
    }
    case 'add-registry': {
      const full = a.positionals[0];
      if (!full) {
        console.error('Usage: drakox mcp add-registry <registry-name>');
        return 1;
      }
      const results = await searchRegistry(full, 50);
      const server = results.find((r) => r.name === full) ?? results[0];
      if (!server?.install) {
        console.error(`No installable registry entry for "${full}".`);
        return 1;
      }
      const values: Record<string, string> = parseKV(a.set, '=');
      for (const inp of server.inputs) {
        if (values[inp.key]) continue;
        const label = `${inp.key}${inp.required ? '' : c.dim(' (optional)')}${inp.description ? c.dim(` — ${inp.description.slice(0, 80)}`) : ''}: `;
        values[inp.key] = inp.secret ? await promptHidden(label) : await prompt(label);
      }
      const { config, secrets } = buildRegistryConfig(server, values);
      const name = a.name ?? registryServerName(server.name);
      addMcpServer(root, name, config, a.scope ?? 'user', secrets);
      console.log(c.ok(`✓ Installed ${server.name} as "${name}"`));
      await rt.reload();
      const st = rt.mcp.state(name);
      if (st) console.log(mcpLine(st));
      return 0;
    }
    case 'remove':
    case 'rm': {
      const name = a.positionals[0];
      if (!name) return usage('drakox mcp remove <name>');
      const removed = removeMcpServer(root, name);
      if (!removed.length) {
        console.error(`No integration named "${name}".`);
        return 1;
      }
      console.log(c.ok(`✓ Removed "${name}" from ${removed.join(', ')}`));
      return 0;
    }
    case 'enable':
    case 'disable': {
      const name = a.positionals[0];
      if (!name) return usage(`drakox mcp ${a.sub} <name>`);
      setMcpEnabled(root, name, a.sub === 'enable');
      console.log(c.ok(`✓ ${a.sub === 'enable' ? 'Enabled' : 'Disabled'} "${name}"`));
      return 0;
    }
    case 'get': {
      const name = a.positionals[0];
      const cfg = name ? rt.config.mcpServers?.[name] : undefined;
      if (!name || !cfg) {
        console.error(`No integration named "${name ?? ''}".`);
        return 1;
      }
      console.log(`${c.bold(name)} ${c.dim(`(defined in: ${serverScopes(root, name).join(', ')})`)}`);
      console.log(JSON.stringify(cfg, null, 2));
      const st = await rt.mcp.connect(name, cfg);
      console.log(mcpLine(st));
      for (const t of st.tools) console.log(`  ${c.hunk(t.name)} ${c.dim(t.description.split('\n')[0]!.slice(0, 100))}`);
      return 0;
    }
    case 'import': {
      const sources = discoverImportSources(root).filter((s) => !a.from || s.id === a.from || a.from === 'all');
      if (!sources.length) {
        console.log(c.dim('No MCP configs found from Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Codex, Gemini CLI or opencode.'));
        return 0;
      }
      const existing = new Set(Object.keys(rt.config.mcpServers ?? {}));
      let count = 0;
      for (const src of sources) {
        console.log(`${c.bold(src.name)} ${c.dim(src.file)}`);
        for (const [name, cfg] of Object.entries(src.servers)) {
          if (existing.has(name)) {
            console.log(c.dim(`  - ${name} (already configured, skipped)`));
            continue;
          }
          const { config, secrets } = extractSecrets(cfg);
          addMcpServer(root, name, config, a.scope ?? 'user', secrets);
          existing.add(name);
          count++;
          console.log(c.ok(`  ✓ ${name}`));
        }
      }
      console.log(c.ok(`Imported ${count} integration(s).`));
      return 0;
    }
    case 'login': {
      const name = a.positionals[0];
      if (!name) return usage('drakox mcp login <name>');
      return mcpLogin(rt, name);
    }
    default:
      console.error(`Unknown mcp command "${a.sub}". Try: list, catalog, install, add, add-registry, search, import, paste, get, enable, disable, remove, login`);
      return 1;
  }
}

function usage(text: string): number {
  console.error(`Usage: ${text}`);
  return 1;
}

async function mcpLogin(rt: Runtime, name: string): Promise<number> {
  const cfg = rt.config.mcpServers?.[name];
  if (!cfg) {
    console.error(`No integration named "${name}".`);
    return 1;
  }
  if (!cfg.url) {
    console.error(`"${name}" is a local (stdio) server; it does not use browser sign-in.`);
    return 1;
  }
  let resolveDone!: (ok: boolean) => void;
  const done = new Promise<boolean>((r) => (resolveDone = r));
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1:4546');
    const m = /^\/oauth\/callback\/([^/]+)$/.exec(u.pathname);
    if (!m) {
      res.writeHead(404).end();
      return;
    }
    const code = u.searchParams.get('code');
    const err = u.searchParams.get('error');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (err || !code) {
      res.end(authPage(false, err ?? 'No authorization code received'));
      resolveDone(false);
      return;
    }
    try {
      const st = await rt.mcp.finishAuth(decodeURIComponent(m[1]!), code, u.searchParams.get('state') ?? undefined);
      res.end(authPage(st.status === 'connected', st.error));
      resolveDone(st.status === 'connected');
    } catch (e) {
      res.end(authPage(false, (e as Error).message));
      resolveDone(false);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(4546, '127.0.0.1', () => resolve());
  }).catch((e) => {
    console.error(c.err(`Cannot listen on 127.0.0.1:4546 for the OAuth callback: ${(e as Error).message}`));
    process.exit(1);
  });
  rt.on('mcp_auth', ({ server: s, url }: { server: string; url: string }) => {
    if (s !== name) return;
    console.log(`Opening your browser to sign in to ${c.bold(name)}…\nIf it does not open, visit:\n${c.underline(url)}`);
    openBrowser(url);
  });
  const st = await rt.mcp.connect(name, { ...cfg, oauth: true });
  if (st.status === 'connected') {
    console.log(c.ok(`✓ ${name} is connected (${st.tools.length} tools).`));
    server.close();
    return 0;
  }
  if (st.status !== 'needs_auth') {
    console.error(c.err(`Could not start sign-in: ${st.error ?? st.status}`));
    server.close();
    return 1;
  }
  const timeout = setTimeout(() => resolveDone(false), 5 * 60_000);
  const ok = await done;
  clearTimeout(timeout);
  server.close();
  const final = rt.mcp.state(name);
  if (ok) console.log(c.ok(`✓ Signed in. ${name} is connected (${final?.tools.length ?? 0} tools).`));
  else console.error(c.err(`Sign-in failed${final?.error ? `: ${final.error}` : ''}.`));
  return ok ? 0 : 1;
}

export function authPage(ok: boolean, detail?: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
  return `<!doctype html><meta charset="utf-8"><title>DrakoX</title><body style="font-family:system-ui;background:#0b0b0f;color:#e7e7ea;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:48px">${ok ? '✅' : '⚠️'}</div><h2>${ok ? 'Connected to DrakoX' : 'Sign-in failed'}</h2><p style="color:#9a9aa5">${ok ? 'You can close this tab and return to DrakoX.' : esc(detail ?? '')}</p></div><script>${ok ? 'setTimeout(()=>window.close(),1500)' : ''}</script></body>`;
}

// ───────────────────────────── models / setup ─────────────────────────────

export async function modelsCommand(rt: Runtime): Promise<number> {
  console.log(await modelsText(rt, (await rt.defaultModel()).ref));
  return 0;
}

export async function setupCommand(rt: Runtime): Promise<number> {
  console.log(`\n${c.bold(c.brand('DrakoX setup'))} ${c.dim('— connect a model. Everything is stored locally in ~/.drakox.')}\n`);
  const statuses = await rt.providers.statuses({ discover: true });
  const local = statuses.filter((s) => s.category === 'local' && s.reachable && s.models.length);
  if (local.length) {
    console.log(c.ok('Found local model servers (free & unlimited):'));
    const options: string[] = [];
    for (const s of local) for (const m of s.models.slice(0, 10)) options.push(`${s.id}/${m.id}`);
    options.forEach((o, i) => console.log(`  ${c.brand(String(i + 1).padStart(2))}. ${o}`));
    const pick = await prompt(`Use one as default? (number, or Enter to configure a cloud provider) `);
    const n = Number(pick);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      updateConfigFile('user', rt.projectRoot, (cfg) => {
        cfg.model = options[n - 1]!;
      });
      console.log(c.ok(`✓ Default model: ${options[n - 1]}`));
      return 0;
    }
  } else {
    console.log(`${c.dim('No local model server detected.')} For free, unlimited, private use install ${c.bold('Ollama')} (https://ollama.com) and run:`);
    console.log(`  ${c.brand('ollama pull qwen3-coder:30b')}   ${c.dim('(or gpt-oss:20b / qwen2.5-coder:7b on smaller machines)')}\n`);
  }
  const cloud = PROVIDER_PRESETS.filter((p) => p.category !== 'local' && p.category !== 'demo');
  console.log(c.bold('Cloud providers') + c.dim(' (free tiers marked)'));
  cloud.forEach((p, i) => console.log(`  ${c.brand(String(i + 1).padStart(2))}. ${p.name.padEnd(16)} ${p.category === 'free' ? c.ok('free tier') : c.dim('paid    ')} ${c.dim(p.description.slice(0, 70))}`));
  const pick = await prompt('Provider number (Enter to skip): ');
  const n = Number(pick);
  if (!Number.isInteger(n) || n < 1 || n > cloud.length) {
    console.log(c.dim('Skipped. Run `drakox setup` any time, or configure providers in the web UI (drakox ui).'));
    return 0;
  }
  const preset = cloud[n - 1]!;
  if (preset.signupUrl) console.log(c.dim(`Get a key at ${preset.signupUrl}`));
  const key = await promptHidden(`${preset.name} API key: `);
  if (!key) return 0;
  updateCredentials((cr) => {
    cr.providers ??= {};
    cr.providers[preset.id] = { ...(cr.providers[preset.id] ?? {}), apiKey: key };
  });
  await rt.reload();
  let models: string[] = preset.models;
  try {
    const listed = await rt.providers.get(preset.id).listModels?.(AbortSignal.timeout(8000));
    if (listed?.length) models = listed.map((m) => m.id);
    console.log(c.ok(`✓ Key works — ${listed?.length ?? 0} models available.`));
  } catch (err) {
    console.log(c.warn(`⚠ Could not verify the key (${(err as Error).message}). It was saved anyway.`));
  }
  const suggested = preset.recommended ?? models[0];
  const model = (await prompt(`Default model [${suggested}]: `)) || suggested;
  if (model) {
    updateConfigFile('user', rt.projectRoot, (cfg) => {
      cfg.model = `${preset.id}/${model}`;
    });
    console.log(c.ok(`✓ Default model: ${preset.id}/${model}`));
  }
  return 0;
}

// ───────────────────────────── doctor ─────────────────────────────

export async function doctorCommand(rt: Runtime): Promise<number> {
  const ok = (m: string) => console.log(`  ${c.ok('✓')} ${m}`);
  const warn = (m: string) => console.log(`  ${c.warn('⚠')} ${m}`);
  const bad = (m: string) => console.log(`  ${c.err('✗')} ${m}`);
  let problems = 0;
  console.log(`${c.bold('DrakoX doctor')} ${c.dim('v' + packageVersion())}\n`);
  const [maj, min] = process.versions.node.split('.').map(Number) as [number, number];
  if (maj > 20 || (maj === 20 && min >= 18)) ok(`Node ${process.versions.node}`);
  else {
    bad(`Node ${process.versions.node} — DrakoX needs Node 20.18+ (22+ recommended)`);
    problems++;
  }
  const has = (cmd: string, args = ['--version']) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
  if (has('git')) ok('git');
  else warn('git not found — checkpoints still work, but worktrees, /review and diffs need git');
  if (has('rg')) ok('ripgrep (fast search)');
  else warn('ripgrep not found — search falls back to a slower built-in walker (install: https://github.com/BurntSushi/ripgrep)');
  const sb = detectSandbox();
  if (sb !== 'none') ok(`OS sandbox: ${sb}`);
  else warn(process.platform === 'linux' ? 'No OS sandbox (install bubblewrap: apt install bubblewrap) — risky commands will always ask for approval' : 'No OS sandbox — risky commands will always ask for approval');
  if (has('npx')) ok('npx (for npm-based integrations)');
  else warn('npx not found — npm-based integrations will not start');
  if (has('uvx')) ok('uvx (for Python-based integrations)');
  else warn('uvx not found — Python-based integrations need it (https://docs.astral.sh/uv/)');

  console.log(`\n${c.bold('Configuration')}`);
  for (const s of rt.loaded.sources) if (s.file) console.log(`  ${s.exists ? c.ok('●') : c.dim('○')} ${s.scope.padEnd(9)} ${c.dim(s.file)}`);
  const creds = readCredentials();
  try {
    const mode = fs.statSync(paths.credentials()).mode & 0o777;
    if (mode & 0o077) {
      warn(`credentials.json is readable by others (mode ${mode.toString(8)}) — run: chmod 600 ${paths.credentials()}`);
      problems++;
    } else ok('credentials.json permissions (600)');
  } catch {
    /* no credentials yet */
  }

  console.log(`\n${c.bold('Models')}`);
  const def = await rt.defaultModel();
  console.log(`  default: ${c.bold(def.ref)} ${c.dim(`(${def.reason})`)}`);
  const statuses = await rt.providers.statuses({ discover: true });
  for (const s of statuses.filter((x) => x.configured && x.category !== 'demo')) {
    if (s.reachable === false) {
      bad(`${s.name}: ${s.error ?? 'unreachable'}`);
      if (s.category !== 'local') problems++;
    } else ok(`${s.name}: ${s.models.length} models${s.keySource && s.keySource !== 'none' ? c.dim(` · key from ${s.keySource}`) : ''}`);
  }
  if (def.ref.startsWith('demo/')) warn('Only the offline demo model is available — run `drakox setup`');
  void creds;

  console.log(`\n${c.bold('Integrations')}`);
  const servers = Object.keys(rt.config.mcpServers ?? {});
  if (!servers.length) console.log(c.dim('  none'));
  else {
    await rt.mcp.sync(rt.config.mcpServers ?? {});
    for (const s of rt.mcp.states()) {
      console.log(mcpLine(s));
      if (s.status === 'error') problems++;
    }
  }
  const ins = rt.instructions();
  console.log(`\n${c.bold('Instructions')}`);
  if (!ins.files.length) console.log(c.dim('  no AGENTS.md — run /init inside DrakoX'));
  for (const f of ins.files) ok(`${f.label} ${c.dim(`${(f.bytes / 1024).toFixed(1)} KB`)}`);
  for (const w of ins.warnings) warn(w);
  console.log(problems ? `\n${c.warn(`${problems} problem(s) found.`)}` : `\n${c.ok('All good.')}`);
  return problems ? 1 : 0;
}

// ───────────────────────────── sessions / trust ─────────────────────────────

export function sessionsCommand(rt: Runtime, all: boolean): number {
  if (!all) {
    console.log(sessionsText(rt, 30));
    return 0;
  }
  for (const m of rt.store.list().slice(0, 50)) {
    console.log(`${c.bold(m.title || 'Untitled')} ${c.dim(`· ${m.turns} turns · ${formatCost(m.costUsd)} · ${new Date(m.updatedAt).toLocaleString()}`)}\n  ${c.dim(`${m.id} · ${m.projectRoot}`)}`);
  }
  return 0;
}

export function trustCommand(dir: string, trusted: boolean): number {
  setTrusted(dir, trusted);
  console.log(trusted ? c.ok(`✓ Trusted ${dir}`) : c.ok(`✓ Removed trust for ${dir}`));
  return 0;
}

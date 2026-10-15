import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { Runtime } from '../core/runtime.js';
import type { AgentManager } from './manager.js';
import { HttpError, Router, requireString } from './http.js';
import type { ApprovalDecision, DrakoxConfig, ImagePart, McpServerConfig, Mode } from '../core/types.js';
import { resolveSlash, listSlashCommands } from '../core/slash.js';
import { expandMentions } from '../core/mentions.js';
import { gitInfo, gitStatus, gitDiff, gitShowFile, gitRoot } from '../core/git.js';
import { readConfigFile, readCredentials, redactKey, updateConfigFile, updateCredentials, type ConfigScope } from '../core/config.js';
import { CATALOG, catalogEntry } from '../core/mcp/catalog.js';
import { discoverImportSources, parsePastedConfig } from '../core/mcp/import.js';
import { addMcpServer, buildRegistryConfig, extractSecrets, installCatalogServer, registryServerName, removeMcpServer, searchRegistry, serverScopes, setMcpEnabled, type RegistryServer } from '../core/integrations.js';
import { setTrusted } from '../core/trust.js';
import { createSkillTemplate } from '../core/skills.js';
import { packageVersion, paths, isInside, toPosix } from '../core/paths.js';
import { defaultShell } from '../core/sandbox.js';
import { killTree } from '../core/tools/shell.js';
import { getIgnore, isIgnored } from '../core/tools/common.js';
import { isPlainObject, isBinaryBuffer, uid } from '../core/util.js';
import { PROVIDER_PRESETS } from '../core/providers/index.js';

export interface RouteDeps {
  runtime: Runtime;
  manager: AgentManager;
  broadcast(msg: unknown): void;
  setPublicBase(base: string): void;
  publicBase(): string;
}

const MODES: Mode[] = ['plan', 'ask', 'auto-edit', 'autopilot'];
const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

export function registerRoutes(r: Router, d: RouteDeps): void {
  const { runtime: rt, manager } = d;

  // ───────────── info ─────────────
  r.get('/api/info', async () => {
    const def = await rt.defaultModel();
    return {
      version: packageVersion(),
      cwd: rt.cwd,
      projectRoot: rt.projectRoot,
      projectName: path.basename(rt.projectRoot),
      git: gitInfo(rt.projectRoot),
      trusted: rt.trusted(),
      sandbox: rt.sandbox(),
      defaultModel: def.ref,
      defaultModelReason: def.reason,
      demo: def.ref.startsWith('demo/'),
      platform: process.platform,
      home: paths.home(),
      needsTrust: !rt.trusted() && (rt.loaded.hasProjectHooks || rt.loaded.projectMcpServers.length > 0),
      config: { mode: rt.config.mode ?? 'ask', autoReview: Boolean(rt.config.autoReview), budget: rt.config.budget?.sessionUsd ?? null },
    };
  });

  r.post('/api/trust', async ({ body }) => {
    setTrusted(rt.projectRoot, Boolean(body.trusted));
    await rt.reload();
    d.broadcast({ type: 'config' });
    return { trusted: rt.trusted() };
  });

  // ───────────── agents ─────────────
  r.get('/api/agents', () => manager.list());

  r.post('/api/agents', async ({ body }) => {
    const mode = MODES.includes(body.mode) ? (body.mode as Mode) : undefined;
    const agent = await manager.create({ model: body.model || undefined, mode, title: body.title, isolation: body.isolation === 'worktree' ? 'worktree' : 'none', group: body.group });
    if (typeof body.prompt === 'string' && body.prompt.trim()) await sendMessage(agent.id, body.prompt, body.images);
    return manager.item(agent);
  });

  r.get('/api/agents/:id', async ({ params }) => {
    const agent = await manager.get(params.id!);
    return { agent: manager.item(agent), events: agent.events(), pending: agent.pending(), running: agent.isRunning() };
  });

  r.patch('/api/agents/:id', async ({ params, body }) => {
    const agent = await manager.get(params.id!);
    if (body.mode) {
      if (!MODES.includes(body.mode)) throw new HttpError(400, 'Invalid mode');
      agent.setMode(body.mode);
    }
    if (body.model) {
      rt.providers.resolve(body.model);
      agent.setModel(body.model);
    }
    if (typeof body.title === 'string') agent.setTitle(body.title);
    return manager.item(agent);
  });

  r.delete('/api/agents/:id', async ({ params, query }) => {
    await manager.remove(params.id!, { deleteSession: query.get('delete') !== '0' });
    return { ok: true };
  });

  async function sendMessage(id: string, text: string, images?: ImagePart[]): Promise<{ ok: true; action?: string; args?: string; message?: string }> {
    const agent = await manager.get(id);
    if (agent.isRunning()) throw new HttpError(409, 'The agent is still working. Interrupt it or wait.');
    const trimmed = text.trim();
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
      const res = await resolveSlash(rt, trimmed, agent.cwd);
      if (res.type === 'error') throw new HttpError(400, res.message);
      if (res.type === 'unknown') throw new HttpError(400, `Unknown command /${res.name}`);
      if (res.type === 'action') {
        switch (res.name) {
          case 'compact': {
            const ok = await agent.compact('manual');
            return { ok: true, action: 'compact', message: ok ? 'Conversation compacted.' : 'Nothing to compact yet.' };
          }
          case 'undo': {
            if (agent.turn < 1) return { ok: true, action: 'undo', message: 'Nothing to undo.' };
            const restored = await agent.rewind(agent.turn);
            return { ok: true, action: 'undo', message: `Rewound the last turn${restored.length ? ` and restored ${restored.length} file(s)` : ''}.` };
          }
          case 'mode':
            if (MODES.includes(res.args as Mode)) agent.setMode(res.args as Mode);
            return { ok: true, action: 'mode', args: res.args };
          case 'model':
            if (res.args) {
              rt.providers.resolve(res.args);
              agent.setModel(res.args);
            }
            return { ok: true, action: 'model', args: res.args };
          case 'title':
            if (res.args) agent.setTitle(res.args);
            return { ok: true, action: 'title' };
          case 'trust':
            setTrusted(rt.projectRoot, true);
            await rt.reload();
            return { ok: true, action: 'trust', message: 'Folder trusted.' };
          default:
            // UI-level actions (help, models, mcp, new, diff, cost, status, …)
            return { ok: true, action: res.name, args: res.args };
        }
      }
      if (res.mode) agent.setMode(res.mode);
      if (res.model) agent.setModel(res.model);
      manager.send(agent, res.prompt, { displayText: res.display, images });
      return { ok: true };
    }
    const expanded = expandMentions(text, agent.cwd, { confine: true });
    const allImages = [...(images ?? []), ...expanded.images];
    manager.send(agent, expanded.text, { images: allImages.length ? allImages : undefined, displayText: expanded.text !== text ? text : undefined });
    return { ok: true };
  }

  r.post('/api/agents/:id/messages', async ({ params, body }) => {
    const text = requireString(body.text, 'text');
    if (body.mode && MODES.includes(body.mode)) (await manager.get(params.id!)).setMode(body.mode);
    return sendMessage(params.id!, text, Array.isArray(body.images) ? body.images : undefined);
  });

  r.post('/api/agents/:id/abort', async ({ params }) => {
    manager.peek(params.id!)?.abort();
    return { ok: true };
  });

  r.post('/api/agents/:id/approvals/:approvalId', async ({ params, body }) => {
    const agent = await manager.get(params.id!);
    const decision = body.decision as ApprovalDecision;
    if (!['allow_once', 'allow_always', 'deny'].includes(decision)) throw new HttpError(400, 'Invalid decision');
    if (!agent.respondApproval(params.approvalId!, decision, body.feedback || undefined)) throw new HttpError(404, 'This approval is no longer pending');
    return { ok: true };
  });

  r.post('/api/agents/:id/questions/:qid', async ({ params, body }) => {
    const agent = await manager.get(params.id!);
    if (!agent.answerQuestion(params.qid!, String(body.answer ?? ''))) throw new HttpError(404, 'This question is no longer pending');
    return { ok: true };
  });

  r.post('/api/agents/:id/plans/:pid', async ({ params, body }) => {
    const agent = await manager.get(params.id!);
    const mode = MODES.includes(body.mode) ? body.mode : undefined;
    if (!agent.respondPlan(params.pid!, { approved: Boolean(body.approved), mode, feedback: body.feedback || undefined })) throw new HttpError(404, 'This plan is no longer pending');
    return { ok: true };
  });

  r.post('/api/agents/:id/rewind', async ({ params, body }) => {
    const agent = await manager.get(params.id!);
    const turn = Number(body.turn);
    if (!Number.isInteger(turn) || turn < 1) throw new HttpError(400, 'Invalid turn');
    const restored = await agent.rewind(turn, { code: body.code !== false, conversation: body.conversation !== false });
    return { restored };
  });

  r.post('/api/agents/:id/compact', async ({ params }) => {
    const agent = await manager.get(params.id!);
    return { compacted: await agent.compact('manual') };
  });

  r.get('/api/agents/:id/changes', async ({ params }) => {
    const agent = await manager.get(params.id!);
    const MAX = 400_000;
    return agent.changedFiles().map((f) => {
      const before = f.before ? agent.getBlob(f.before) : null;
      const after = f.after ? agent.getBlob(f.after) : null;
      let current: string | null = null;
      try {
        current = fs.readFileSync(f.path, 'utf8');
      } catch {
        current = null;
      }
      return {
        path: f.path,
        rel: toPosix(path.relative(agent.cwd, f.path)),
        turns: f.turns,
        before: before && before.length > MAX ? before.slice(0, MAX) : before,
        after: after && after.length > MAX ? after.slice(0, MAX) : after,
        modifiedSince: current !== after,
      };
    });
  });

  /** Reject one file: restore its original content (checkpointed, so it can be undone too). */
  r.post('/api/agents/:id/revert-file', async ({ params, body }) => {
    const agent = await manager.get(params.id!);
    const file = requireString(body.path, 'path');
    const ch = agent.changedFiles().find((f) => f.path === file);
    if (!ch) throw new HttpError(404, 'File was not changed by this agent');
    let current: string | null = null;
    try {
      current = fs.readFileSync(file, 'utf8');
    } catch {
      current = null;
    }
    const original = ch.before ? agent.getBlob(ch.before) : null;
    if (original === null) fs.rmSync(file, { force: true });
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, original);
    }
    agent.recordFileChange(file, current, original);
    return { ok: true };
  });

  r.get('/api/agents/:id/worktree/diff', async ({ params }) => ({ diff: manager.worktreeDiff(await manager.get(params.id!)) }));
  r.post('/api/agents/:id/worktree/apply', async ({ params }) => manager.applyWorktree(await manager.get(params.id!)));
  r.post('/api/agents/:id/worktree/commit', async ({ params, body }) => manager.commitWorktree(await manager.get(params.id!), body.message || 'DrakoX agent changes'));

  r.get('/api/commands', () => listSlashCommands(rt));

  // ───────────── files (explorer / editor / @mentions) ─────────────
  function workspaceRoot(agentId?: string | null): string {
    if (agentId) {
      const a = manager.peek(agentId);
      if (a) return a.cwd;
    }
    return rt.projectRoot;
  }

  function safePath(rel: string | null | undefined, root: string): string {
    const abs = path.resolve(root, rel || '.');
    if (!isInside(abs, root)) throw new HttpError(403, 'Path is outside the workspace');
    return abs;
  }

  r.get('/api/files', ({ query }) => {
    const root = workspaceRoot(query.get('agent'));
    const dir = safePath(query.get('dir'), root);
    const ig = getIgnore(root);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new HttpError(404, (err as Error).message);
    }
    return entries
      .filter((e) => e.name !== '.git' && e.name !== '.DS_Store')
      .map((e) => {
        const abs = path.join(dir, e.name);
        const isDir = e.isDirectory();
        return { name: e.name, path: toPosix(path.relative(root, abs)), type: isDir ? 'dir' : 'file', ignored: isIgnored(ig, root, abs, isDir) || e.name === 'node_modules' };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  });

  r.get('/api/file', ({ query }) => {
    const root = workspaceRoot(query.get('agent'));
    const abs = safePath(requireString(query.get('path'), 'path'), root);
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (!st || !st.isFile()) throw new HttpError(404, 'File not found');
    const ext = path.extname(abs).toLowerCase();
    if (IMAGE_MIME[ext] && st.size < 10 * 1024 * 1024) return { path: query.get('path'), kind: 'image', mediaType: IMAGE_MIME[ext], data: fs.readFileSync(abs).toString('base64'), size: st.size };
    if (st.size > 2 * 1024 * 1024) return { path: query.get('path'), kind: 'too_large', size: st.size };
    const buf = fs.readFileSync(abs);
    if (isBinaryBuffer(buf)) return { path: query.get('path'), kind: 'binary', size: st.size };
    const root2 = gitRoot(root);
    const head = root2 ? gitShowFile(root2, toPosix(path.relative(root2, abs))) : null;
    return { path: query.get('path'), kind: 'text', content: buf.toString('utf8'), head, size: st.size, mtime: st.mtimeMs };
  });

  r.put('/api/file', ({ body, query }) => {
    const root = workspaceRoot(query.get('agent'));
    const abs = safePath(requireString(body.path, 'path'), root);
    if (typeof body.content !== 'string') throw new HttpError(400, '"content" is required');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body.content);
    return { ok: true, mtime: fs.statSync(abs).mtimeMs };
  });

  let fileIndex: { at: number; root: string; files: string[] } | undefined;
  function listAllFiles(root: string): string[] {
    if (fileIndex && fileIndex.root === root && Date.now() - fileIndex.at < 5000) return fileIndex.files;
    let files: string[] = [];
    const g = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (g.status === 0) files = g.stdout.split('\n').filter(Boolean);
    else {
      const ig = getIgnore(root);
      const walk = (dir: string) => {
        if (files.length > 30000) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name === '.git' || e.name === 'node_modules') continue;
          const abs = path.join(dir, e.name);
          if (isIgnored(ig, root, abs, e.isDirectory())) continue;
          if (e.isDirectory()) walk(abs);
          else files.push(toPosix(path.relative(root, abs)));
        }
      };
      try {
        walk(root);
      } catch {
        /* ignore */
      }
    }
    fileIndex = { at: Date.now(), root, files };
    return files;
  }

  r.get('/api/files/search', ({ query }) => {
    const root = workspaceRoot(query.get('agent'));
    const q = (query.get('q') ?? '').toLowerCase();
    const limit = Math.min(Number(query.get('limit')) || 50, 200);
    const files = listAllFiles(root);
    if (!q) return files.slice(0, limit);
    const scored: { f: string; s: number }[] = [];
    for (const f of files) {
      const s = fuzzyScore(f.toLowerCase(), q);
      if (s > 0) scored.push({ f, s });
    }
    return scored
      .sort((a, b) => b.s - a.s || a.f.length - b.f.length)
      .slice(0, limit)
      .map((x) => x.f);
  });

  r.get('/api/git', ({ query }) => {
    const root = workspaceRoot(query.get('agent'));
    return { info: gitInfo(root), status: gitRoot(root) ? gitStatus(root) : [] };
  });

  r.get('/api/git/diff', ({ query }) => {
    const root = workspaceRoot(query.get('agent'));
    if (!gitRoot(root)) return { diff: '' };
    return { diff: gitDiff(root, { path: query.get('path') ?? undefined, base: query.get('base') ?? undefined }) };
  });

  // ───────────── editor Tab completion (Cursor-style) ─────────────
  r.post('/api/complete', async ({ body }) => {
    const prefix = String(body.prefix ?? '').slice(-6000);
    const suffix = String(body.suffix ?? '').slice(0, 2000);
    const ref = rt.config.models?.autocomplete ?? (await rt.defaultModel()).ref;
    const { provider, model } = rt.providers.resolve(ref);
    if (!provider.complete) return { completion: '' };
    const header = body.path ? `// File: ${body.path}${body.language ? ` (${body.language})` : ''}\n` : '';
    try {
      const completion = await provider.complete({ model, prompt: header + prefix, suffix, maxTokens: 96, stop: ['\n\n\n'], signal: AbortSignal.timeout(6000) });
      return { completion: cleanCompletion(completion, suffix), model: ref };
    } catch (err) {
      return { completion: '', error: (err as Error).message };
    }
  });

  registerSettingsRoutes(r, d);
  registerTerminalRoutes(r, d, workspaceRoot);
}

function cleanCompletion(text: string, suffix: string): string {
  let t = text.replace(/^```[\w-]*\n?/, '').replace(/\n?```\s*$/, '');
  // avoid duplicating what follows the cursor
  const firstSuffixLine = suffix.split('\n')[0]?.trim();
  if (firstSuffixLine && t.trimEnd().endsWith(firstSuffixLine)) t = t.trimEnd().slice(0, -firstSuffixLine.length);
  return t.slice(0, 2000);
}

export function fuzzyScore(text: string, q: string): number {
  if (text.includes(q)) {
    const base = text.endsWith(q) || text.split('/').pop()!.startsWith(q) ? 1000 : 600;
    return base - text.length;
  }
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const idx = text.indexOf(ch, ti);
    if (idx === -1) return 0;
    streak = idx === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - Math.min(idx - ti, 10);
    ti = idx + 1;
  }
  return score;
}

// ───────────────────────────── settings & integrations ─────────────────────────────

function redactConfig(cfg: DrakoxConfig): DrakoxConfig {
  const out: DrakoxConfig = JSON.parse(JSON.stringify(cfg));
  for (const p of Object.values(out.providers ?? {})) if (p.apiKey) p.apiKey = redactKey(p.apiKey);
  if (out.webSearch?.apiKey) out.webSearch.apiKey = redactKey(out.webSearch.apiKey);
  for (const s of Object.values(out.mcpServers ?? {})) redactServer(s);
  return out;
}

function redactServer(s: McpServerConfig): McpServerConfig {
  const hide = (v: string) => (/\$\{(secret|env):/.test(v) ? v : /(token|key|secret|bearer|password)/i.test(v) || v.length > 24 ? '••••••' : v);
  if (s.env) s.env = Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, /(token|key|secret|password|pat)/i.test(k) && !/\$\{/.test(v) ? '••••••' : v]));
  if (s.headers) s.headers = Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k, /authorization|token|key/i.test(k) ? hide(v) : v]));
  return s;
}

/** Merge a JSON patch into a config object; `null` deletes a key. */
function applyPatch(target: Record<string, any>, patch: Record<string, any>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v === null) delete target[k];
    else if (isPlainObject(v) && isPlainObject(target[k])) applyPatch(target[k], v);
    else target[k] = v;
  }
}

function registerSettingsRoutes(r: Router, d: RouteDeps): void {
  const rt = d.runtime;
  const root = rt.projectRoot;
  const reload = async () => {
    await rt.reload();
    d.broadcast({ type: 'config' });
  };

  r.get('/api/config', () => ({
    effective: redactConfig(rt.config),
    sources: rt.loaded.sources,
    scopes: {
      user: redactConfig(readConfigFile('user', root)),
      project: redactConfig(readConfigFile('project', root)),
      local: redactConfig(readConfigFile('local', root)),
    },
  }));

  r.put('/api/config', async ({ body }) => {
    const scope = (body.scope ?? 'user') as ConfigScope;
    if (!['user', 'project', 'local'].includes(scope)) throw new HttpError(400, 'Invalid scope');
    if (!isPlainObject(body.patch)) throw new HttpError(400, '"patch" must be an object');
    updateConfigFile(scope, root, (cfg) => applyPatch(cfg as Record<string, any>, body.patch));
    await reload();
    return { ok: true };
  });

  // ── providers / models ──
  r.get('/api/providers', async ({ query }) => rt.providers.statuses({ discover: query.get('discover') === '1' }));

  r.put('/api/providers/:id', async ({ params, body }) => {
    const id = params.id!;
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) throw new HttpError(400, 'Invalid provider id');
    if (typeof body.apiKey === 'string') {
      updateCredentials((c) => {
        c.providers ??= {};
        if (body.apiKey) c.providers[id] = { ...(c.providers[id] ?? {}), apiKey: body.apiKey.trim() };
        else delete c.providers[id];
      });
    }
    const patch: Record<string, unknown> = {};
    for (const k of ['baseURL', 'enabled', 'name', 'type', 'models', 'headers'] as const) if (body[k] !== undefined) patch[k] = body[k];
    const isPreset = PROVIDER_PRESETS.some((p) => p.id === id);
    if (!isPreset && !patch.type && !rt.config.providers?.[id]) patch.type = 'openai';
    if (Object.keys(patch).length) {
      updateConfigFile('user', root, (cfg) => {
        cfg.providers ??= {};
        cfg.providers[id] = { ...(cfg.providers[id] ?? {}), ...patch } as any;
      });
    }
    await reload();
    return { ok: true };
  });

  r.delete('/api/providers/:id', async ({ params }) => {
    const id = params.id!;
    updateCredentials((c) => {
      if (c.providers) delete c.providers[id];
    });
    updateConfigFile('user', root, (cfg) => {
      if (cfg.providers) delete cfg.providers[id];
    });
    await reload();
    return { ok: true };
  });

  r.post('/api/providers/:id/test', async ({ params }) => {
    try {
      const p = rt.providers.get(params.id!);
      const models = (await p.listModels?.(AbortSignal.timeout(10000))) ?? [];
      return { ok: true, models: models.length, sample: models.slice(0, 5).map((m) => m.id) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  r.put('/api/default-model', async ({ body }) => {
    const model = requireString(body.model, 'model');
    rt.providers.resolve(model);
    updateConfigFile((body.scope as ConfigScope) ?? 'user', root, (cfg) => {
      cfg.model = model;
    });
    await reload();
    return { ok: true };
  });

  r.put('/api/websearch', async ({ body }) => {
    const provider = body.provider;
    if (provider && !['brave', 'tavily', 'searxng', 'exa'].includes(provider)) throw new HttpError(400, 'Invalid provider');
    if (typeof body.apiKey === 'string') {
      updateCredentials((c) => {
        c.webSearch = body.apiKey ? { apiKey: body.apiKey.trim() } : undefined;
      });
    }
    updateConfigFile('user', root, (cfg) => {
      if (!provider) delete cfg.webSearch;
      else cfg.webSearch = { provider, ...(body.baseURL ? { baseURL: body.baseURL } : {}) };
    });
    await reload();
    return { ok: true, configured: Boolean(readCredentials().webSearch?.apiKey) || provider === 'searxng' };
  });

  // ── MCP integrations ──
  const mcpView = () => {
    const cfg = rt.config.mcpServers ?? {};
    return rt.mcp.states().map((s) => ({
      ...s,
      config: cfg[s.name] ? redactServer(JSON.parse(JSON.stringify(cfg[s.name]))) : undefined,
      scopes: serverScopes(root, s.name),
      catalog: s.catalogId ? catalogEntry(s.catalogId) && { id: s.catalogId, name: catalogEntry(s.catalogId)!.name, color: catalogEntry(s.catalogId)!.color, icon: catalogEntry(s.catalogId)!.icon } : undefined,
    }));
  };
  r.get('/api/mcp', () => mcpView());
  r.get('/api/mcp/catalog', () => CATALOG.map((e) => ({ ...e, installed: Boolean(rt.config.mcpServers?.[e.id]) })));

  r.post('/api/mcp', async ({ body }) => {
    const name = requireString(body.name, 'name');
    if (!isPlainObject(body.config)) throw new HttpError(400, '"config" is required');
    const cfg = body.config as McpServerConfig;
    if (!cfg.command && !cfg.url) throw new HttpError(400, 'Provide a command (local server) or a URL (remote server)');
    const { config, secrets } = extractSecrets(cfg);
    addMcpServer(root, name, config, (body.scope as ConfigScope) ?? 'user', { ...secrets, ...(isPlainObject(body.secrets) ? body.secrets : {}) });
    await reload();
    return mcpView().find((s) => s.name === name) ?? { name };
  });

  r.post('/api/mcp/catalog/:id', async ({ params, body }) => {
    const { name } = installCatalogServer(root, params.id!, isPlainObject(body.inputs) ? body.inputs : {}, { scope: body.scope, name: body.name || undefined });
    await reload();
    return mcpView().find((s) => s.name === name) ?? { name };
  });

  r.post('/api/mcp/paste', async ({ body }) => {
    const servers = parsePastedConfig(requireString(body.text, 'text'), body.name || 'custom');
    const names: string[] = [];
    for (const [name, cfg] of Object.entries(servers)) {
      const { config, secrets } = extractSecrets(cfg);
      addMcpServer(root, name, config, (body.scope as ConfigScope) ?? 'user', secrets);
      names.push(name);
    }
    if (!names.length) throw new HttpError(400, 'No MCP servers found in the pasted text');
    await reload();
    return { added: names };
  });

  r.get('/api/mcp/import', () => {
    const existing = new Set(Object.keys(rt.config.mcpServers ?? {}));
    return discoverImportSources(root).map((s) => ({ id: s.id, name: s.name, file: s.file, servers: Object.entries(s.servers).map(([n, c]) => ({ name: n, transport: c.url ? 'remote' : 'local', exists: existing.has(n), summary: c.url ?? [c.command, ...(c.args ?? [])].join(' ') })) }));
  });

  r.post('/api/mcp/import', async ({ body }) => {
    const wanted: { source: string; name: string }[] = Array.isArray(body.servers) ? body.servers : [];
    const sources = discoverImportSources(root);
    const added: string[] = [];
    for (const w of wanted) {
      const cfg = sources.find((s) => s.id === w.source)?.servers[w.name];
      if (!cfg) continue;
      const { config, secrets } = extractSecrets(cfg);
      addMcpServer(root, w.name, config, (body.scope as ConfigScope) ?? 'user', secrets);
      added.push(w.name);
    }
    await reload();
    return { added };
  });

  r.get('/api/mcp/registry', async ({ query }) => {
    const q = requireString(query.get('q'), 'q');
    try {
      return await searchRegistry(q, 30);
    } catch (err) {
      throw new HttpError(502, `MCP Registry unavailable: ${(err as Error).message}`);
    }
  });

  r.post('/api/mcp/registry/install', async ({ body }) => {
    const server = body.server as RegistryServer;
    if (!server?.name || !server.install) throw new HttpError(400, 'Invalid registry server');
    const { config, secrets } = buildRegistryConfig(server, isPlainObject(body.values) ? body.values : {});
    const name = body.name || registryServerName(server.name);
    addMcpServer(root, name, config, (body.scope as ConfigScope) ?? 'user', secrets);
    await reload();
    return mcpView().find((s) => s.name === name) ?? { name };
  });

  r.delete('/api/mcp/:name', async ({ params }) => {
    const removed = removeMcpServer(root, params.name!);
    await reload();
    return { removed };
  });

  r.post('/api/mcp/:name/toggle', async ({ params, body }) => {
    setMcpEnabled(root, params.name!, Boolean(body.enabled));
    await reload();
    return { ok: true };
  });

  r.post('/api/mcp/:name/reconnect', async ({ params }) => {
    const cfg = rt.config.mcpServers?.[params.name!];
    if (!cfg) throw new HttpError(404, 'Unknown integration');
    return rt.mcp.connect(params.name!, cfg);
  });

  r.post('/api/mcp/:name/login', async ({ params, req }) => {
    const cfg = rt.config.mcpServers?.[params.name!];
    if (!cfg) throw new HttpError(404, 'Unknown integration');
    if (!cfg.url) throw new HttpError(400, 'Local servers do not use browser sign-in');
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? 'http';
    const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
    if (host) d.setPublicBase(`${proto}://${host}`);
    const st = await rt.mcp.connect(params.name!, { ...cfg, oauth: true });
    return { status: st.status, authUrl: st.authUrl, error: st.error };
  });

  r.get('/api/mcp/:name/tools', ({ params }) => rt.mcp.state(params.name!)?.tools ?? []);

  // ── skills, agents, instructions ──
  r.get('/api/skills', () => rt.skills());
  r.post('/api/skills', async ({ body }) => {
    const name = requireString(body.name, 'name');
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new HttpError(400, 'Skill names use lowercase letters, digits and dashes');
    const dir = body.scope === 'user' ? paths.userSkills() : path.join(root, '.drakox', 'skills');
    const file = createSkillTemplate(dir, name, String(body.description ?? 'Describe when to use this skill'));
    if (typeof body.body === 'string' && body.body.trim()) fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${String(body.description ?? '').replace(/\n/g, ' ')}\n---\n\n${body.body.trim()}\n`);
    return { file };
  });
  r.get('/api/skills/:name', ({ params }) => {
    const s = rt.skills().find((x) => x.name === params.name);
    if (!s) throw new HttpError(404, 'Unknown skill');
    return { ...s, content: fs.readFileSync(s.file, 'utf8') };
  });
  r.put('/api/skills/:name', ({ params, body }) => {
    const s = rt.skills().find((x) => x.name === params.name);
    if (!s) throw new HttpError(404, 'Unknown skill');
    if (s.source === 'bundled') throw new HttpError(400, 'Bundled skills are read-only — copy it to your project to customise');
    fs.writeFileSync(s.file, requireString(body.content, 'content'));
    return { ok: true };
  });
  r.get('/api/agent-profiles', () => rt.agentProfiles());
  r.get('/api/instructions', () => rt.instructions());
}

// ───────────────────────────── terminal runner ─────────────────────────────

function registerTerminalRoutes(r: Router, d: RouteDeps, workspaceRoot: (agent?: string | null) => string): void {
  const procs = new Map<string, ChildProcess>();
  r.post('/api/terminal', ({ body, query }) => {
    const command = requireString(body.command, 'command');
    const cwd = workspaceRoot(query.get('agent') ?? body.agent);
    const { shell, args } = defaultShell(d.runtime.config.shell);
    const id = uid('term_');
    const child = spawn(shell, args(command), { cwd, env: { ...process.env, FORCE_COLOR: '1', DRAKOX_TERMINAL: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    procs.set(id, child);
    const send = (data: Buffer) => d.broadcast({ type: 'terminal', id, data: data.toString('utf8') });
    child.stdout?.on('data', send);
    child.stderr?.on('data', send);
    child.on('close', (code) => {
      procs.delete(id);
      d.broadcast({ type: 'terminal_exit', id, code });
    });
    child.on('error', (err) => d.broadcast({ type: 'terminal', id, data: `\r\n${err.message}\r\n` }));
    return { id, cwd };
  });
  r.post('/api/terminal/:id/kill', ({ params }) => {
    const p = procs.get(params.id!);
    if (p) killTree(p);
    return { ok: true };
  });
}

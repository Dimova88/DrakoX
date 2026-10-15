import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Runtime } from '../core/runtime.js';
import { Agent } from '../core/agent.js';
import type { AgentEvent, ApprovalRequest, Mode } from '../core/types.js';
import { expandMentions } from '../core/mentions.js';
import { listSlashCommands, resolveSlash } from '../core/slash.js';
import { paths, packageVersion, ensureDir } from '../core/paths.js';
import { setTrusted } from '../core/trust.js';
import { defaultShell } from '../core/sandbox.js';
import { stripAnsi as stripAnsiShell } from '../core/tools/shell.js';
import { c, logo, MODE_HELP, MODE_LABEL, modeColor } from './ansi.js';
import { approvalCard, box, MarkdownLines, statusLine, TerminalRenderer } from './render.js';
import { agentsText, costText, diffText, helpText, mcpLine, modelsText, modesText, permissionsText, sessionsText, skillsText, statusText } from './info.js';

const MODES: Mode[] = ['plan', 'ask', 'auto-edit', 'autopilot'];

export interface ReplOptions {
  runtime: Runtime;
  agent: Agent;
  initialPrompt?: string;
  showReasoning?: boolean;
  verbose?: boolean;
}

export async function startRepl(opts: ReplOptions): Promise<void> {
  const rt = opts.runtime;
  let agent = opts.agent;
  const r = new TerminalRenderer({ showReasoning: opts.showReasoning, verbose: opts.verbose });
  const history = loadHistory();

  let running = false;
  let interacting = false;
  let muted = false;
  let lastSigint = 0;
  let turnStarted = 0;
  const queued: string[] = [];
  const shellContext: string[] = [];
  let interactionChain: Promise<void> = Promise.resolve();
  let pasteBuf: string[] = [];
  let pasteTimer: NodeJS.Timeout | undefined;
  let continuation: string[] = [];

  readline.emitKeypressEvents(process.stdin);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
    history,
    historySize: 1000,
    removeHistoryDuplicates: true,
    completer: (line: string) => complete(line),
    prompt: promptStr(),
  });
  const rlAny = rl as any;
  const origWrite = rlAny._writeToOutput?.bind(rl);
  if (origWrite) {
    rlAny._writeToOutput = (s: string) => {
      if (!muted) origWrite(s);
    };
  }
  const mute = () => {
    muted = true;
  };
  const unmute = () => {
    muted = false;
  };
  const clearInputLine = () => {
    rlAny.line = '';
    rlAny.cursor = 0;
  };

  function promptStr(): string {
    if (continuation.length) return c.dim('  … ');
    return `${modeColor(agent.mode)(MODE_LABEL[agent.mode]!)} ${c.brand('❯')} `;
  }

  function refreshPrompt(): void {
    rl.setPrompt(promptStr());
    if (!running && !interacting) rl.prompt(true);
  }

  // ── completion: /commands and @paths ──
  function complete(line: string): [string[], string] {
    if (/^\/[\w:.-]*$/.test(line)) {
      const names = listSlashCommands(rt).flatMap((x) => [x.name, ...(x.aliases ?? [])]);
      const hits = names.filter((n) => `/${n}`.startsWith(line)).map((n) => `/${n} `);
      return [hits, line];
    }
    const m = /(@[^\s]*)$/.exec(line);
    if (m) {
      const token = m[1]!;
      const partial = token.slice(1);
      const dir = partial.endsWith('/') ? partial : path.dirname(partial) === '.' && !partial.startsWith('./') ? '' : path.dirname(partial) + '/';
      const base = partial.slice(dir.length);
      try {
        const entries = fs.readdirSync(path.resolve(agent.cwd, dir || '.'), { withFileTypes: true });
        const hits = entries
          .filter((e) => e.name.startsWith(base) && (base.startsWith('.') || !e.name.startsWith('.')) && e.name !== 'node_modules')
          .slice(0, 50)
          .map((e) => `@${dir}${e.name}${e.isDirectory() ? '/' : ''}`);
        return [hits, token];
      } catch {
        return [[], token];
      }
    }
    return [[], line];
  }

  // ── event handling ──
  const onEvent = (e: AgentEvent) => {
    r.handle(e);
    if (e.type === 'approval_request') queueInteraction(() => handleApproval(e.request));
    else if (e.type === 'subagent' && e.event.type === 'approval_request') {
      const req = e.event.request;
      queueInteraction(() => handleApproval({ ...req, title: `[${e.agent}] ${req.title}` }));
    } else if (e.type === 'question') queueInteraction(() => handleQuestion(e.id, e.question, e.options));
    else if (e.type === 'plan' && e.status === 'proposed' && agent.interactive) queueInteraction(() => handlePlan(e.id, e.markdown));
  };

  function attach(a: Agent): void {
    agent.off('event', onEvent);
    agent = a;
    agent.on('event', onEvent);
    refreshPrompt();
  }
  agent.on('event', onEvent);

  function queueInteraction(fn: () => Promise<void>): void {
    interactionChain = interactionChain.then(async () => {
      interacting = true;
      r.spinner.stop();
      try {
        await fn();
      } catch {
        /* ignore */
      } finally {
        interacting = false;
        clearInputLine();
      }
    });
  }

  function readKey(valid: string[]): Promise<string> {
    return new Promise((resolve) => {
      const onKey = (str: string | undefined, key: readline.Key | undefined) => {
        if (key?.name === 'escape' || (key?.ctrl && key.name === 'c')) return done('n');
        const k = (str ?? '').toLowerCase();
        if (valid.includes(k)) done(k);
      };
      const done = (k: string) => {
        process.stdin.off('keypress', onKey);
        setImmediate(clearInputLine);
        resolve(k);
      };
      process.stdin.on('keypress', onKey);
    });
  }

  function ask(question: string): Promise<string> {
    clearInputLine();
    unmute();
    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        if (running) mute();
        resolve(answer);
      });
    });
  }

  async function handleApproval(req: ApprovalRequest): Promise<void> {
    if (!agent.pending().approvals.includes(req.id) && !(await isChildPending(req.id))) return;
    r.print('');
    r.print(approvalCard(req));
    process.stdout.write(c.dim('  choose [y/a/n/f] › '));
    const k = await readKey(['y', 'a', 'n', 'f']);
    process.stdout.write(`${k}\n`);
    if (k === 'y') agent.respondApproval(req.id, 'allow_once');
    else if (k === 'a') agent.respondApproval(req.id, 'allow_always');
    else if (k === 'n') agent.respondApproval(req.id, 'deny');
    else {
      const fb = await ask(c.warn('  Tell DrakoX what to do instead: '));
      agent.respondApproval(req.id, 'deny', fb.trim() || undefined);
    }
    if (running) r.spinner.start(c.dim('Working…'));
  }

  async function isChildPending(_id: string): Promise<boolean> {
    // sub-agent approvals are routed through the parent; assume pending
    return true;
  }

  async function handleQuestion(id: string, question: string, options?: string[]): Promise<void> {
    r.print('');
    const body = [c.bold(question), ...(options?.length ? ['', ...options.map((o, i) => `  ${c.brand(String(i + 1))}. ${o}`)] : [])].join('\n');
    r.print(box('DrakoX asks', body, c.accent));
    const ans = await ask(c.accent(options?.length ? '  Answer (number or text): ' : '  Answer: '));
    const n = Number(ans.trim());
    const answer = options?.length && Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1]! : ans.trim() || '(no answer)';
    agent.answerQuestion(id, answer);
  }

  async function handlePlan(id: string, markdown: string): Promise<void> {
    const md = new MarkdownLines();
    r.print('');
    r.print(box('Plan for approval', markdown.split('\n').map((l) => md.render(l)).join('\n'), c.hunk));
    r.print(`  ${c.bold(c.ok('y'))} approve → auto-edit   ${c.bold(c.err('a'))} approve → autopilot   ${c.bold(c.dim('k'))} approve, keep asking   ${c.bold(c.warn('f'))} revise with feedback   ${c.bold(c.err('n'))} reject`);
    process.stdout.write(c.dim('  choose [y/a/k/f/n] › '));
    const k = await readKey(['y', 'a', 'k', 'f', 'n']);
    process.stdout.write(`${k}\n`);
    if (k === 'y') agent.respondPlan(id, { approved: true, mode: 'auto-edit' });
    else if (k === 'a') agent.respondPlan(id, { approved: true, mode: 'autopilot' });
    else if (k === 'k') agent.respondPlan(id, { approved: true, mode: 'ask' });
    else if (k === 'f') {
      const fb = await ask(c.warn('  What should change? '));
      agent.respondPlan(id, { approved: false, feedback: fb.trim() || 'Please revise the plan.' });
    } else agent.respondPlan(id, { approved: false });
    refreshPrompt();
  }

  // ── keys: shift+tab (mode), esc (interrupt) ──
  process.stdin.on('keypress', (_str: string | undefined, key: readline.Key | undefined) => {
    if (!key || interacting) return;
    if (key.name === 'tab' && key.shift) {
      const next = MODES[(MODES.indexOf(agent.mode) + 1) % MODES.length]!;
      agent.setMode(next);
      if (running) {
        r.print(c.dim(`  mode → ${MODE_LABEL[next]} (${MODE_HELP[next]})`));
      } else {
        // clear completion artefacts and redraw the prompt with the new mode
        refreshPrompt();
      }
      return;
    }
    if (key.name === 'escape' && running) {
      agent.abort();
    }
  });

  rl.on('SIGINT', () => {
    if (running) {
      agent.abort();
      return;
    }
    if (rlAny.line) {
      clearInputLine();
      process.stdout.write('\n');
      rl.prompt();
      return;
    }
    const now = Date.now();
    if (now - lastSigint < 2000) {
      rl.close();
      return;
    }
    lastSigint = now;
    process.stdout.write(c.dim('\n  (press ctrl+c again to exit)\n'));
    rl.prompt();
  });

  // ── input: paste-aware line handling ──
  rl.on('line', (line: string) => {
    if (interacting) return;
    pasteBuf.push(line);
    if (pasteTimer) clearTimeout(pasteTimer);
    pasteTimer = setTimeout(() => {
      const lines = pasteBuf;
      pasteBuf = [];
      let text = lines.join('\n');
      if (text.endsWith('\\')) {
        continuation.push(text.slice(0, -1));
        rl.setPrompt(promptStr());
        rl.prompt();
        return;
      }
      if (continuation.length) {
        text = [...continuation, text].join('\n');
        continuation = [];
        rl.setPrompt(promptStr());
      }
      if (!text.trim()) {
        if (!running) rl.prompt();
        return;
      }
      saveHistory(text);
      if (running) {
        queued.push(text);
        r.print(c.dim(`  ⧗ queued: ${text.slice(0, 80)}`));
        return;
      }
      void submit(text);
    }, 12);
  });

  let closed = false;
  const closedPromise = new Promise<void>((resolve) => {
    rl.on('close', () => {
      closed = true;
      resolve();
    });
  });

  // ── submission ──
  async function submit(text: string): Promise<void> {
    const t = text.trim();
    if (t.startsWith('!') && t.length > 1) {
      await runShell(t.slice(1).trim());
      return finishInput();
    }
    if (t.startsWith('/') && !t.startsWith('//')) {
      const res = await resolveSlash(rt, t, agent.cwd);
      if (res.type === 'action') {
        await runAction(res.name, res.args);
        return finishInput();
      }
      if (res.type === 'error') {
        r.print(`  ${c.warn('⚠')} ${res.message}`);
        return finishInput();
      }
      if (res.type === 'unknown') {
        r.print(`  ${c.warn('⚠')} Unknown command /${res.name}. Type /help.`);
        return finishInput();
      }
      if (res.mode) agent.setMode(res.mode);
      if (res.model) agent.setModel(res.model);
      return runAgent(res.prompt, res.display);
    }
    return runAgent(t);
  }

  function finishInput(): void {
    if (closed) return;
    if (queued.length) {
      void submit(queued.shift()!);
      return;
    }
    rl.setPrompt(promptStr());
    rl.prompt();
  }

  async function runAgent(prompt: string, display?: string): Promise<void> {
    const { text, images, attached } = expandMentions(prompt, agent.cwd);
    for (const a of attached) r.print(c.dim(`  ⎘ attached ${a}`));
    const full = shellContext.length ? `${shellContext.splice(0).join('\n\n')}\n\n${text}` : text;
    running = true;
    turnStarted = Date.now();
    mute();
    try {
      await agent.send(full, { images: images.length ? images : undefined, displayText: display ?? (full !== prompt ? prompt : undefined) });
    } catch (err) {
      r.print(`  ${c.err('✗')} ${(err as Error).message}`);
    }
    await interactionChain;
    running = false;
    r.spinner.stop();
    unmute();
    const snap = agent.snapshot();
    r.print(`  ${statusLine({ model: agent.model, mode: agent.mode, contextTokens: snap.contextTokens, contextWindow: snap.contextWindow, costUsd: snap.totals.costUsd, costPartial: snap.totals.costPartial, durationMs: Date.now() - turnStarted })}`);
    r.print('');
    finishInput();
  }

  async function runShell(cmd: string): Promise<void> {
    const { shell, args } = defaultShell(rt.config.shell);
    r.print(c.dim(`  $ ${cmd}`));
    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      let text = '';
      const child = spawn(shell, args(cmd), { cwd: agent.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      const onData = (d: Buffer) => {
        const s = d.toString();
        text += s;
        process.stdout.write(c.dim(s));
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('close', (code) => resolve({ code, text }));
      child.on('error', (err) => resolve({ code: 1, text: err.message }));
    });
    const clean = stripAnsiShell(out.text);
    shellContext.push(`<user_shell_command exit_code="${out.code}">\n$ ${cmd}\n${clean.length > 20000 ? clean.slice(0, 10000) + '\n…\n' + clean.slice(-10000) : clean}\n</user_shell_command>`);
    r.print(c.dim(`  ⎿ exit ${out.code} · output will be shared with DrakoX in your next message`));
  }

  async function runAction(name: string, args: string): Promise<void> {
    switch (name) {
      case 'help':
        r.print(helpText(rt));
        break;
      case 'exit':
        rl.close();
        break;
      case 'mode': {
        const m = args.trim() as Mode;
        if (!args) r.print(modesText(agent.mode));
        else if (MODES.includes(m)) {
          agent.setMode(m);
          r.print(`  mode → ${modeColor(m)(MODE_LABEL[m]!)} ${c.dim(MODE_HELP[m]!)}`);
        } else r.print(c.warn(`  Unknown mode "${args}". Use plan, ask, auto-edit or autopilot.`));
        break;
      }
      case 'model': {
        if (!args) {
          r.print(`  current model: ${c.bold(agent.model)}`);
          r.print(c.dim('  /models lists everything available; /model <provider/model> switches.'));
          break;
        }
        try {
          rt.providers.resolve(args.trim());
          agent.setModel(args.trim());
          r.print(`  model → ${c.bold(args.trim())}`);
        } catch (err) {
          r.print(c.warn(`  ${(err as Error).message}`));
        }
        break;
      }
      case 'models':
        r.spinner.start(c.dim('Discovering models…'));
        try {
          const text = await modelsText(rt, agent.model);
          r.spinner.stop();
          r.print(text);
        } finally {
          r.spinner.stop();
        }
        break;
      case 'new': {
        const a = await Agent.create({ runtime: rt, cwd: agent.cwd, model: agent.model, mode: agent.mode });
        attach(a);
        r.print(c.ok('  ✓ New session') + c.dim(` (${a.id})`));
        break;
      }
      case 'compact':
        r.spinner.start(c.dim('Compacting…'));
        try {
          const ok = await agent.compact('manual');
          r.spinner.stop();
          if (!ok) r.print(c.dim('  Nothing to compact yet.'));
        } catch (err) {
          r.spinner.stop();
          r.print(c.err(`  Compaction failed: ${(err as Error).message}`));
        }
        break;
      case 'undo': {
        if (agent.turn < 1) {
          r.print(c.dim('  Nothing to undo.'));
          break;
        }
        const lastUser = [...agent.messages].reverse().find((m) => m.role === 'user');
        const restored = await agent.rewind(agent.turn);
        if (restored.length) r.print(c.dim(restored.map((f) => `    ↶ ${path.relative(agent.cwd, f) || f}`).join('\n')));
        if (lastUser && typeof lastUser.content === 'string' && !lastUser.content.startsWith('<')) {
          setImmediate(() => rl.write(lastUser.content as string));
        }
        break;
      }
      case 'rewind': {
        const [turnStr, scope] = args.split(/\s+/);
        const turn = Number(turnStr);
        if (!Number.isInteger(turn) || turn < 1 || turn > agent.turn) {
          r.print(c.warn(`  Usage: /rewind <turn 1-${agent.turn}> [code|chat]`));
          break;
        }
        const restored = await agent.rewind(turn, { code: scope !== 'chat', conversation: scope !== 'code' });
        if (restored.length) r.print(c.dim(restored.map((f) => `    ↶ ${path.relative(agent.cwd, f) || f}`).join('\n')));
        break;
      }
      case 'diff':
        r.print(diffText(agent));
        break;
      case 'cost':
        r.print(costText(agent));
        break;
      case 'status':
        r.print(statusText(rt, agent));
        break;
      case 'mcp': {
        const states = rt.mcp.states();
        r.print(states.length ? states.map(mcpLine).join('\n') : c.dim('  No integrations yet.'));
        r.print(c.dim('  Add: drakox mcp add <name> -- <command>  ·  catalog: drakox mcp catalog  ·  or use the web UI (drakox ui)'));
        break;
      }
      case 'skills':
        r.print(skillsText(rt));
        break;
      case 'agents':
        r.print(agentsText(rt));
        break;
      case 'permissions':
        r.print(permissionsText(rt));
        break;
      case 'sessions':
        r.print(sessionsText(rt));
        break;
      case 'resume': {
        let id = args.trim();
        if (!id) {
          const list = rt.store.list({ projectRoot: rt.projectRoot }).slice(0, 15);
          if (!list.length) {
            r.print(c.dim('  No previous sessions.'));
            break;
          }
          r.print(sessionsText(rt));
          const pick = await ask(c.accent('  Resume which? (number) '));
          const n = Number(pick);
          if (!Number.isInteger(n) || n < 1 || n > list.length) break;
          id = list[n - 1]!.id;
        }
        try {
          const a = await Agent.resume(rt, id);
          attach(a);
          r.print(c.ok(`  ✓ Resumed "${a.title}"`) + c.dim(` · ${a.turn} turns`));
          printRecap(a);
        } catch (err) {
          r.print(c.err(`  ${(err as Error).message}`));
        }
        break;
      }
      case 'trust':
        setTrusted(rt.projectRoot, true);
        await rt.reload();
        r.print(c.ok(`  ✓ Trusted ${rt.projectRoot}. Project hooks and MCP servers are enabled.`));
        break;
      case 'title':
        if (args) agent.setTitle(args);
        r.print(`  title: ${agent.title}`);
        break;
      default:
        r.print(c.warn(`  /${name} is not available in the terminal yet.`));
    }
  }

  function printRecap(a: Agent): void {
    const msgs = a.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim());
    for (const m of msgs.slice(-4)) {
      const text = String(m.content).replace(/\s+/g, ' ');
      r.print(`  ${m.role === 'user' ? c.brand('❯') : c.accent('●')} ${c.dim(text.slice(0, 160))}${text.length > 160 ? c.dim('…') : ''}`);
    }
  }

  // ── banner ──
  printBanner(rt, agent, r);
  await maybeAskTrust();

  if (opts.initialPrompt) {
    r.print(`${modeColor(agent.mode)(MODE_LABEL[agent.mode]!)} ${c.brand('❯')} ${opts.initialPrompt}`);
    void submit(opts.initialPrompt);
  } else rl.prompt();

  async function maybeAskTrust(): Promise<void> {
    if (rt.trusted() || (!rt.loaded.hasProjectHooks && !rt.loaded.projectMcpServers.length)) return;
    const what = [rt.loaded.hasProjectHooks ? 'hooks' : '', rt.loaded.projectMcpServers.length ? `MCP servers (${rt.loaded.projectMcpServers.join(', ')})` : ''].filter(Boolean).join(' and ');
    r.print(box('Trust this folder?', `This project defines ${what} that can run commands on your machine.\nOnly trust folders whose code you trust.`, c.warn));
    interacting = true;
    process.stdout.write(c.dim('  trust? [y/n] › '));
    const k = await readKey(['y', 'n']);
    process.stdout.write(`${k}\n`);
    interacting = false;
    if (k === 'y') {
      setTrusted(rt.projectRoot, true);
      await rt.reload();
      r.print(c.ok('  ✓ Trusted.'));
    } else r.print(c.dim('  Not trusted — project hooks and local MCP servers stay off (/trust to change).'));
  }

  await closedPromise;
  agent.abort();
  r.spinner.stop();
  process.stdout.write(c.dim(`\n  Session saved · resume with: drakox resume ${agent.id}\n`));
}

function printBanner(rt: Runtime, agent: Agent, r: TerminalRenderer): void {
  const sb = rt.sandbox();
  r.print('');
  r.print(logo());
  r.print(`  ${c.dim(`v${packageVersion()} · open-source agent harness · free & unlimited with local models`)}`);
  r.print('');
  r.print(`  ${c.dim('model    ')} ${c.bold(agent.model)}`);
  r.print(`  ${c.dim('mode     ')} ${modeColor(agent.mode)(MODE_LABEL[agent.mode]!)} ${c.dim(`· ${MODE_HELP[agent.mode]} · shift+tab to change`)}`);
  r.print(`  ${c.dim('sandbox  ')} ${sb.mode}${sb.available ? c.ok(` · ${sb.kind}`) : sb.mode !== 'full-access' ? c.dim(' · approval-guarded (no OS sandbox available)') : ''}`);
  r.print(`  ${c.dim('folder   ')} ${agent.cwd}`);
  const mcp = rt.mcp.states();
  if (mcp.length) r.print(`  ${c.dim('apps     ')} ${mcp.map((s) => `${s.status === 'connected' ? c.ok('●') : s.status === 'connecting' ? c.warn('◌') : c.dim('○')} ${s.name}`).join('  ')}`);
  r.print('');
  if (agent.model.startsWith('demo/')) {
    r.print(
      box(
        'Demo mode',
        [
          'No model is connected yet, so DrakoX is using its offline demo model.',
          `Connect one for real work — free options: ${c.bold('Ollama')} (local, unlimited), Gemini, Groq, OpenRouter :free…`,
          `Run ${c.brand('drakox setup')} or ${c.brand('/model ollama/qwen3-coder:30b')} after \`ollama pull qwen3-coder:30b\`.`,
        ].join('\n'),
        c.accent,
      ),
    );
    r.print('');
  }
  r.print(c.dim('  /help commands · @ mention files · ! run shell · esc interrupt · ctrl+c twice to quit'));
  r.print('');
}

function loadHistory(): string[] {
  try {
    const out: string[] = [];
    for (const l of fs.readFileSync(paths.history(), 'utf8').split('\n').filter(Boolean).reverse()) {
      try {
        const v = JSON.parse(l);
        if (typeof v === 'string' && !out.includes(v)) out.push(v);
      } catch {
        /* skip corrupt line */
      }
      if (out.length >= 1000) break;
    }
    return out;
  } catch {
    return [];
  }
}

function saveHistory(line: string): void {
  try {
    ensureDir(path.dirname(paths.history()));
    fs.appendFileSync(paths.history(), JSON.stringify(line) + '\n');
  } catch {
    /* ignore */
  }
}

export { c as colors };
export const _internal = { stripAnsi: stripAnsiShell };

export { expandMentions };

import fs from 'node:fs';
import path from 'node:path';
import { Runtime } from '../core/runtime.js';
import { Agent } from '../core/agent.js';
import type { DrakoxConfig, Mode, SandboxMode } from '../core/types.js';
import { packageVersion } from '../core/paths.js';
import type { ConfigScope } from '../core/config.js';
import { c, logo } from './ansi.js';

interface Flags {
  model?: string;
  mode?: Mode;
  sandbox?: SandboxMode;
  cwd?: string;
  yolo: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
  continue: boolean;
  resume?: string | true;
  port?: number;
  host?: string;
  noOpen: boolean;
  noAuth: boolean;
  showReasoning: boolean;
  verbose: boolean;
  quiet: boolean;
  noMcp: boolean;
  all: boolean;
  scope?: ConfigScope;
  env: string[];
  headers: string[];
  set: string[];
  transport?: string;
  name?: string;
  from?: string;
  outputLastMessage?: string;
}

const SUBCOMMANDS = new Set(['exec', 'e', 'ui', 'web', 'app', 'resume', 'sessions', 'mcp', 'models', 'setup', 'init', 'review', 'doctor', 'trust', 'untrust', 'help', 'version']);
const MODES = ['plan', 'ask', 'auto-edit', 'autopilot'];
const SANDBOXES = ['read-only', 'workspace-write', 'full-access'];

function parse(argv: string[]): { cmd?: string; positionals: string[]; rest: string[]; flags: Flags } {
  const flags: Flags = { yolo: false, json: false, help: false, version: false, continue: false, noOpen: false, noAuth: false, showReasoning: false, verbose: false, quiet: false, noMcp: false, all: false, env: [], headers: [], set: [] };
  const positionals: string[] = [];
  let rest: string[] = [];
  let cmd: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--') {
      rest = argv.slice(i + 1);
      break;
    }
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const val = () => inline ?? next();
    switch (name) {
      case '-m':
      case '--model':
        flags.model = val();
        break;
      case '--mode': {
        const v = val();
        if (!MODES.includes(v)) throw new Error(`--mode must be one of ${MODES.join(', ')}`);
        flags.mode = v as Mode;
        break;
      }
      case '--plan':
        flags.mode = 'plan';
        break;
      case '-s':
      case '--sandbox': {
        const v = val();
        if (!SANDBOXES.includes(v)) throw new Error(`--sandbox must be one of ${SANDBOXES.join(', ')}`);
        flags.sandbox = v as SandboxMode;
        break;
      }
      case '-C':
      case '--cd':
        flags.cwd = val();
        break;
      case '--yolo':
      case '--dangerously-skip-permissions':
        flags.yolo = true;
        break;
      case '--json':
        flags.json = true;
        break;
      case '-h':
      case '--help':
        flags.help = true;
        break;
      case '-v':
      case '-V':
      case '--version':
        flags.version = true;
        break;
      case '-c':
      case '--continue':
        flags.continue = true;
        break;
      case '-r':
      case '--resume': {
        const v = inline ?? argv[i + 1];
        if (v && !v.startsWith('-') && !inline) i++;
        flags.resume = v && !v.startsWith('-') ? v : true;
        break;
      }
      case '-p':
      case '--port':
        flags.port = Number(val());
        break;
      case '--host':
        flags.host = val();
        break;
      case '--no-open':
        flags.noOpen = true;
        break;
      case '--no-auth':
        flags.noAuth = true;
        break;
      case '--reasoning':
        flags.showReasoning = true;
        break;
      case '--verbose':
        flags.verbose = true;
        break;
      case '-q':
      case '--quiet':
        flags.quiet = true;
        break;
      case '--no-mcp':
        flags.noMcp = true;
        break;
      case '--all':
        flags.all = true;
        break;
      case '--scope': {
        const v = val();
        if (!['user', 'project', 'local'].includes(v)) throw new Error('--scope must be user, project or local');
        flags.scope = v as ConfigScope;
        break;
      }
      case '-e':
      case '--env':
        flags.env.push(val());
        break;
      case '-H':
      case '--header':
        flags.headers.push(val());
        break;
      case '--set':
        flags.set.push(val());
        break;
      case '-t':
      case '--transport':
        flags.transport = val();
        break;
      case '--name':
        flags.name = val();
        break;
      case '--from':
        flags.from = val();
        break;
      case '-o':
      case '--output-last-message':
        flags.outputLastMessage = val();
        break;
      default:
        if (a.startsWith('-') && a.length > 1) throw new Error(`Unknown option ${a}. See drakox --help`);
        if (!cmd && positionals.length === 0 && SUBCOMMANDS.has(a)) cmd = a;
        else positionals.push(a);
    }
  }
  return { cmd, positionals, rest, flags };
}

function help(): string {
  const b = c.brand;
  const d = c.dim;
  const row = (cmd: string, args: string, desc: string, w = 34) => {
    const plain = cmd + (args ? ' ' + args : '');
    return `  ${b(cmd)}${args ? ' ' + d(args) : ''}${' '.repeat(Math.max(1, w - plain.length))}${desc}`;
  };
  return [
    logo(),
    `  ${d(`v${packageVersion()} — the open agent harness. Any model, any app, no limits.`)}`,
    '',
    c.bold('Usage'),
    row('drakox', '[prompt]', 'interactive session (terminal)'),
    row('drakox ui', '', 'web app: Mission Control, editor, integrations'),
    row('drakox exec', '"<prompt>"', `non-interactive run (CI / scripts) ${d('--json for JSONL events')}`),
    row('drakox resume', '[id] | -c', 'resume a session (or continue the latest)'),
    row('drakox review', '[base]', 'code review of your changes'),
    row('drakox init', '', 'create/improve AGENTS.md'),
    row('drakox setup', '', 'connect a model (Ollama, free tiers, API keys)'),
    row('drakox models', '', 'list models from all providers'),
    row('drakox mcp', '<cmd>', 'integrations: list, catalog, install, add, search, import, login…'),
    row('drakox sessions', '[--all]', 'recent sessions'),
    row('drakox doctor', '', 'check your environment'),
    row('drakox trust', '[dir]', "allow this folder's hooks & MCP servers (untrust to revoke)"),
    '',
    c.bold('Options'),
    row('-m, --model', '<provider/model>', 'e.g. ollama/qwen3-coder:30b, anthropic/claude-sonnet-4-5'),
    row('--mode', '<mode>', 'plan | ask (default) | auto-edit | autopilot'),
    row('-s, --sandbox', '<level>', 'read-only | workspace-write (default) | full-access'),
    row('-C, --cd', '<dir>', 'run in another directory'),
    row('-c, --continue', '', 'continue the most recent session'),
    row('--yolo', '', `autopilot + no sandbox ${c.err('(dangerous)')}`),
    row('--no-mcp', '', 'do not start integrations'),
    row('--reasoning', '', 'show model reasoning'),
    row('--verbose', '', 'stream tool output live'),
    row('ui: -p, --port', '<n>', 'web port (default 4545) · --host <addr> · --no-open'),
    '',
    c.bold('Integration examples'),
    `  ${d('drakox mcp install github')}                        ${d('# from the built-in catalog')}`,
    `  ${d('drakox mcp add rea -- npx -y rea-agents mcp')}      ${d('# any local (stdio) server')}`,
    `  ${d('drakox mcp add linear https://mcp.linear.app/mcp')} ${d('# remote server; then: drakox mcp login linear')}`,
    `  ${d('drakox mcp search postgres')}                       ${d('# official MCP Registry')}`,
    `  ${d('drakox mcp import')}                                ${d('# from Claude Code, Cursor, VS Code, Codex, Gemini…')}`,
    '',
    d('Docs & source: https://github.com/Dimova88/DrakoX'),
  ].join('\n');
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const ch of process.stdin) chunks.push(ch as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parse(process.argv.slice(2));
  } catch (err) {
    console.error(c.err((err as Error).message));
    return 2;
  }
  const { cmd, positionals, rest, flags } = parsed;
  if (flags.version || cmd === 'version') {
    console.log(packageVersion());
    return 0;
  }
  if (flags.help || cmd === 'help') {
    console.log(help());
    return 0;
  }
  const cwd = path.resolve(flags.cwd ?? process.cwd());
  if (!fs.existsSync(cwd)) {
    console.error(c.err(`Directory not found: ${cwd}`));
    return 2;
  }
  const overrides: Partial<DrakoxConfig> = {};
  if (flags.sandbox) overrides.sandbox = flags.sandbox;
  if (flags.mode) overrides.mode = flags.mode;
  if (flags.yolo) {
    overrides.sandbox = 'full-access';
    overrides.mode = 'autopilot';
    if (!flags.quiet && !flags.json) console.error(c.err('⚠ --yolo: no approvals and no sandbox. Only use this in a disposable environment.'));
  }

  const needsMcp = !flags.noMcp && !['setup', 'models', 'sessions', 'trust', 'untrust', 'doctor', 'mcp'].includes(cmd ?? '');
  const runtime = async (connectMcp = needsMcp, oauthRedirectBase?: () => string | undefined) => Runtime.create({ cwd, overrides, connectMcp, oauthRedirectBase });

  switch (cmd) {
    case 'ui':
    case 'web':
    case 'app': {
      const { startServer } = await import('../server/index.js');
      await startServer({ cwd, overrides, port: flags.port, host: flags.host, open: !flags.noOpen, auth: !flags.noAuth, connectMcp: !flags.noMcp });
      return -1; // keep running
    }
    case 'exec':
    case 'e':
    case 'review':
    case 'init': {
      const { runExec } = await import('./exec.js');
      let prompt = positionals.join(' ');
      if (cmd === 'review') prompt = `/review ${positionals.join(' ')}`.trim();
      if (cmd === 'init') prompt = '/init';
      const stdin = await readStdin();
      if (prompt === '-' || !prompt) prompt = stdin;
      else if (stdin.trim()) prompt = `${prompt}\n\n<stdin>\n${stdin}\n</stdin>`;
      if (!prompt.trim()) {
        console.error('Usage: drakox exec "<prompt>"');
        return 2;
      }
      const rt = await runtime();
      if (cmd === 'init' || cmd === 'review') {
        // these need edits (init) or are read-only (review); run interactively-safe defaults
        const mode: Mode = cmd === 'review' ? 'plan' : flags.mode ?? 'auto-edit';
        return runExec({ runtime: rt, prompt, model: flags.model, mode, json: flags.json, autoApprove: flags.yolo, outputLastMessage: flags.outputLastMessage, quiet: flags.quiet });
      }
      return runExec({ runtime: rt, prompt, model: flags.model, mode: flags.mode, json: flags.json, autoApprove: flags.yolo, outputLastMessage: flags.outputLastMessage, quiet: flags.quiet, resumeId: typeof flags.resume === 'string' ? flags.resume : undefined });
    }
    case 'mcp': {
      const { mcpCommand } = await import('./commands.js');
      const rt = await runtime(false);
      const code = await mcpCommand(rt, { sub: positionals[0] ?? 'list', positionals: positionals.slice(1), rest, scope: flags.scope, env: flags.env, headers: flags.headers, transport: flags.transport, name: flags.name, set: flags.set, from: flags.from });
      await rt.dispose();
      return code;
    }
    case 'models': {
      const { modelsCommand } = await import('./commands.js');
      return modelsCommand(await runtime(false));
    }
    case 'setup': {
      const { setupCommand } = await import('./commands.js');
      return setupCommand(await runtime(false));
    }
    case 'doctor': {
      const { doctorCommand } = await import('./commands.js');
      const rt = await runtime(false);
      const code = await doctorCommand(rt);
      await rt.dispose();
      return code;
    }
    case 'sessions': {
      const { sessionsCommand } = await import('./commands.js');
      return sessionsCommand(await runtime(false), flags.all);
    }
    case 'trust':
    case 'untrust': {
      const { trustCommand } = await import('./commands.js');
      return trustCommand(path.resolve(positionals[0] ?? cwd), cmd === 'trust');
    }
    case 'resume':
      flags.resume = positionals[0] ?? true;
      positionals.length = 0;
      break;
    default:
      break;
  }

  // ── interactive (default) ──
  const stdin = await readStdin();
  const initial = positionals.join(' ');
  if (!process.stdin.isTTY) {
    // piped input → behave like exec
    const { runExec } = await import('./exec.js');
    const prompt = initial ? `${initial}${stdin.trim() ? `\n\n<stdin>\n${stdin}\n</stdin>` : ''}` : stdin;
    if (!prompt.trim()) {
      console.error('No prompt given. Run drakox in a terminal, or pass a prompt.');
      return 2;
    }
    return runExec({ runtime: await runtime(), prompt, model: flags.model, mode: flags.mode, json: flags.json, autoApprove: flags.yolo, quiet: flags.quiet });
  }
  const rt = await runtime();
  let agent: Agent;
  if (flags.continue || flags.resume) {
    let id = typeof flags.resume === 'string' ? flags.resume : undefined;
    if (!id) {
      const latest = rt.store.list({ projectRoot: rt.projectRoot })[0];
      if (!latest) {
        console.error(c.dim('No previous session in this project — starting a new one.'));
      } else if (flags.continue || flags.resume === true) id = latest.id;
    }
    if (flags.resume === true && !flags.continue) {
      const { sessionsText } = await import('./info.js');
      const list = rt.store.list({ projectRoot: rt.projectRoot }).slice(0, 15);
      if (list.length) {
        console.log(sessionsText(rt));
        const { prompt } = await import('./commands.js');
        const pick = Number(await prompt(c.accent('Resume which? (number, Enter = latest) ')));
        if (Number.isInteger(pick) && pick >= 1 && pick <= list.length) id = list[pick - 1]!.id;
      }
    }
    agent = id ? await Agent.resume(rt, id, { model: flags.model, mode: flags.mode }) : await Agent.create({ runtime: rt, model: flags.model, mode: flags.mode });
  } else {
    agent = await Agent.create({ runtime: rt, model: flags.model, mode: flags.mode });
  }
  const { startRepl } = await import('./repl.js');
  await startRepl({ runtime: rt, agent, initialPrompt: initial || undefined, showReasoning: flags.showReasoning, verbose: flags.verbose });
  await rt.dispose();
  return 0;
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err) => {
    console.error(c.err(`DrakoX crashed: ${(err as Error)?.stack ?? err}`));
    process.exit(1);
  },
);

import type { Runtime } from './runtime.js';
import type { Mode } from './types.js';
import { gitDiff, gitRoot, gitStatus } from './git.js';
import { expandCommand } from './commands.js';
import { renderSkill } from './skills.js';
import { truncateMiddle } from './util.js';

/**
 * Slash commands shared by the CLI and the web UI.
 * - "action" commands are handled by the front-end (mode switch, undo, …)
 * - "prompt" commands expand into a prompt for the agent (/review, /init, custom commands, skills, MCP prompts)
 */
export interface SlashCommandInfo {
  name: string;
  description: string;
  args?: string;
  source: 'builtin' | 'command' | 'skill' | 'mcp';
  kind: 'action' | 'prompt';
  aliases?: string[];
}

export const BUILTIN_COMMANDS: SlashCommandInfo[] = [
  { name: 'help', description: 'Commands, shortcuts and tips', source: 'builtin', kind: 'action', aliases: ['?'] },
  { name: 'mode', args: '[plan|ask|auto-edit|autopilot]', description: 'Show or change the approval mode', source: 'builtin', kind: 'action' },
  { name: 'model', args: '[provider/model]', description: 'Show or switch the model (any provider, any time)', source: 'builtin', kind: 'action' },
  { name: 'models', description: 'List models from all configured providers', source: 'builtin', kind: 'action' },
  { name: 'plan', args: '<task>', description: 'Plan first: read-only research, then a plan for approval', source: 'builtin', kind: 'prompt' },
  { name: 'review', args: '[base-branch]', description: 'Review uncommitted changes (or the diff against a branch)', source: 'builtin', kind: 'prompt' },
  { name: 'init', description: 'Create or improve AGENTS.md for this repository', source: 'builtin', kind: 'prompt' },
  { name: 'new', description: 'Start a fresh session', source: 'builtin', kind: 'action', aliases: ['clear'] },
  { name: 'compact', description: 'Summarise the conversation to free up context', source: 'builtin', kind: 'action' },
  { name: 'undo', description: 'Rewind the last turn (restores files and conversation)', source: 'builtin', kind: 'action' },
  { name: 'rewind', args: '<turn> [code|chat]', description: 'Rewind to before a turn', source: 'builtin', kind: 'action' },
  { name: 'diff', description: 'Files changed in this session', source: 'builtin', kind: 'action' },
  { name: 'cost', description: 'Token usage and estimated cost', source: 'builtin', kind: 'action', aliases: ['usage'] },
  { name: 'status', description: 'Session, model, sandbox, instructions, integrations', source: 'builtin', kind: 'action' },
  { name: 'mcp', description: 'Integrations (MCP servers) and their tools', source: 'builtin', kind: 'action' },
  { name: 'skills', description: 'Available skills', source: 'builtin', kind: 'action' },
  { name: 'agents', description: 'Sub-agent profiles', source: 'builtin', kind: 'action' },
  { name: 'permissions', description: 'Permission rules in effect', source: 'builtin', kind: 'action' },
  { name: 'sessions', description: 'Recent sessions for this project', source: 'builtin', kind: 'action' },
  { name: 'resume', args: '[session-id]', description: 'Resume a previous session', source: 'builtin', kind: 'action' },
  { name: 'trust', description: 'Trust this folder (enables its hooks and MCP servers)', source: 'builtin', kind: 'action' },
  { name: 'title', args: '<title>', description: 'Rename this session', source: 'builtin', kind: 'action' },
  { name: 'exit', description: 'Quit DrakoX', source: 'builtin', kind: 'action', aliases: ['quit', 'q'] },
];

export function listSlashCommands(rt: Runtime): SlashCommandInfo[] {
  const out: SlashCommandInfo[] = [...BUILTIN_COMMANDS];
  const taken = new Set(out.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
  for (const c of rt.commands()) {
    if (taken.has(c.name)) continue;
    taken.add(c.name);
    out.push({ name: c.name, description: c.description || `Custom command (${c.source})`, args: c.argumentHint, source: 'command', kind: 'prompt' });
  }
  for (const s of rt.skills()) {
    if (taken.has(s.name)) continue;
    taken.add(s.name);
    out.push({ name: s.name, description: s.description, source: 'skill', kind: 'prompt' });
  }
  for (const st of rt.mcp.states()) {
    if (st.status !== 'connected') continue;
    for (const p of st.prompts) {
      const name = `mcp__${st.name}__${p.name}`;
      out.push({ name, description: p.description || `Prompt from ${st.name}`, args: p.arguments?.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' '), source: 'mcp', kind: 'prompt' });
    }
  }
  return out;
}

export type SlashResolution =
  | { type: 'action'; name: string; args: string }
  | { type: 'prompt'; prompt: string; display: string; mode?: Mode; model?: string }
  | { type: 'unknown'; name: string }
  | { type: 'error'; message: string };

export function parseSlash(input: string): { name: string; args: string } | null {
  const m = /^\/([\w:.\-]+|\?)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!m) return null;
  return { name: m[1]!.toLowerCase(), args: (m[2] ?? '').trim() };
}

export async function resolveSlash(rt: Runtime, input: string, cwd: string): Promise<SlashResolution> {
  const parsed = parseSlash(input);
  if (!parsed) return { type: 'unknown', name: input };
  const { name, args } = parsed;
  const builtin = BUILTIN_COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
  if (builtin) {
    if (builtin.name === 'review') return reviewPrompt(cwd, args);
    if (builtin.name === 'init') return { type: 'prompt', prompt: INIT_PROMPT, display: '/init' };
    if (builtin.name === 'plan') {
      if (!args) return { type: 'action', name: 'mode', args: 'plan' };
      return { type: 'prompt', prompt: args, display: `/plan ${args}`, mode: 'plan' };
    }
    return { type: 'action', name: builtin.name, args };
  }
  const cmd = rt.commands().find((c) => c.name.toLowerCase() === name);
  if (cmd) return { type: 'prompt', prompt: expandCommand(cmd, args), display: input.trim(), model: cmd.model };
  const skill = rt.skills().find((s) => s.name.toLowerCase() === name);
  if (skill) {
    const body = renderSkill(skill, args);
    return {
      type: 'prompt',
      prompt: `The user invoked the "${skill.name}" skill. Follow its instructions.\n\n<skill name="${skill.name}">\n${body}\n</skill>\n\n${args ? `Request: ${args}` : 'Apply the skill to the current context.'}`,
      display: input.trim(),
    };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    try {
      const argMap: Record<string, string> = {};
      const state = rt.mcp.state(mcp[1]!);
      const def = state?.prompts.find((p) => p.name.toLowerCase() === mcp[2]);
      const positional: string[] = [];
      for (const tok of args.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
        const kv = /^([\w-]+)=(.*)$/.exec(tok);
        if (kv) argMap[kv[1]!] = kv[2]!.replace(/^"|"$/g, '');
        else positional.push(tok.replace(/^"|"$/g, ''));
      }
      for (const a of def?.arguments ?? []) if (argMap[a.name] === undefined && positional.length) argMap[a.name] = positional.shift()!;
      const text = await rt.mcp.getPrompt(mcp[1]!, def?.name ?? mcp[2]!, argMap);
      return { type: 'prompt', prompt: text, display: input.trim() };
    } catch (err) {
      return { type: 'error', message: `MCP prompt failed: ${(err as Error).message}` };
    }
  }
  return { type: 'unknown', name };
}

function reviewPrompt(cwd: string, base: string): SlashResolution {
  if (!gitRoot(cwd)) return { type: 'error', message: '/review needs a git repository.' };
  const diff = gitDiff(cwd, base ? { base } : {});
  const untracked = gitStatus(cwd)
    .filter((f) => f.status === '??')
    .map((f) => f.path);
  if (!diff.trim() && !untracked.length) return { type: 'error', message: base ? `No differences against ${base}.` : 'No uncommitted changes to review.' };
  const scope = base ? `the changes on this branch compared to \`${base}\`` : 'the uncommitted changes in the working tree';
  return {
    type: 'prompt',
    display: base ? `/review ${base}` : '/review',
    prompt:
      `Review ${scope} as a meticulous senior engineer (read-only — do not modify files).\n\n` +
      'Focus on: correctness bugs, security vulnerabilities, data loss, race conditions, error handling, edge cases, performance regressions and breaking API changes. Skip style nitpicks.\n' +
      'Read the surrounding code when needed to confirm a finding. For every finding give: **severity** (critical / major / minor), `file:line`, what is wrong, and a concrete fix. ' +
      'Finish with a short verdict and the tests that should be added. If the changes look good, say so plainly.\n\n' +
      (untracked.length ? `New untracked files (read them):\n${untracked.slice(0, 50).map((f) => `- ${f}`).join('\n')}\n\n` : '') +
      (diff.trim() ? `<diff>\n${truncateMiddle(diff, 80000)}\n</diff>` : ''),
  };
}

const INIT_PROMPT = `Analyze this repository and create (or improve, if it exists) an AGENTS.md file at the repository root. AGENTS.md is read automatically by DrakoX, Codex, Cursor and other coding agents.

Explore first (README, package manifests, build configs, CI workflows, directory layout, a few representative source files). Then write a concise file (aim for under 150 lines) with:
1. Project overview — what it is, in 2-3 sentences
2. Tech stack and key dependencies
3. Repository layout — the important directories and what lives there
4. Commands — install, dev, build, test (incl. a single test), lint/format, typecheck — exactly as they work in this repo
5. Code conventions actually used here (naming, patterns, error handling, testing style)
6. Gotchas — non-obvious things an agent must know (generated files, env vars, slow tests, things not to touch)

Only include facts you verified in the repository. If an AGENTS.md or CLAUDE.md already exists, preserve its valuable content and improve it rather than replacing it.`;

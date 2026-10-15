import { diffLines } from 'diff';
import type { Runtime } from '../core/runtime.js';
import type { Agent } from '../core/agent.js';
import { BUILTIN_COMMANDS, listSlashCommands } from '../core/slash.js';
import { displayPath, packageVersion } from '../core/paths.js';
import { formatCost, formatTokens } from '../core/util.js';
import { c, MODE_HELP, MODE_LABEL, modeColor } from './ansi.js';

const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));

export function helpText(rt: Runtime): string {
  const cmds = listSlashCommands(rt);
  const builtin = cmds.filter((x) => x.source === 'builtin');
  const custom = cmds.filter((x) => x.source !== 'builtin');
  const lines = [
    c.bold('Commands'),
    ...builtin.map((x) => `  ${c.brand(pad(`/${x.name}${x.args ? ' ' + x.args : ''}`, 34))}${c.dim(x.description)}`),
  ];
  if (custom.length) {
    lines.push('', c.bold('Custom commands, skills & MCP prompts'));
    for (const x of custom.slice(0, 40)) lines.push(`  ${c.accent(pad(`/${x.name}${x.args ? ' ' + x.args : ''}`, 34))}${c.dim(`${x.description} · ${x.source}`)}`);
  }
  lines.push(
    '',
    c.bold('Shortcuts'),
    `  ${c.brand(pad('shift+tab', 34))}${c.dim('cycle mode: plan → ask → auto-edit → autopilot')}`,
    `  ${c.brand(pad('esc / ctrl+c', 34))}${c.dim('interrupt the agent (ctrl+c twice to quit)')}`,
    `  ${c.brand(pad('@path', 34))}${c.dim('attach a file, folder or image (tab completes)')}`,
    `  ${c.brand(pad('!command', 34))}${c.dim('run a shell command; output is shared with DrakoX')}`,
    `  ${c.brand(pad('line ending with \\', 34))}${c.dim('continue on the next line')}`,
    `  ${c.brand(pad('enter while working', 34))}${c.dim('queue your next message')}`,
    '',
    c.dim(`Docs: https://github.com/Dimova88/DrakoX · Web UI: drakox ui`),
  );
  return lines.join('\n');
}

export function modesText(current: string): string {
  return ['plan', 'ask', 'auto-edit', 'autopilot']
    .map((m) => `  ${m === current ? c.bold('›') : ' '} ${modeColor(m)(pad(MODE_LABEL[m]!, 14))} ${c.dim(MODE_HELP[m]!)}`)
    .join('\n');
}

export function statusText(rt: Runtime, agent: Agent): string {
  const sb = rt.sandbox();
  const ins = rt.instructions(agent.cwd);
  const mcp = rt.mcp.states();
  const snap = agent.snapshot();
  const lines = [
    `${c.bold('DrakoX')} ${c.dim('v' + packageVersion())}`,
    `  ${c.dim(pad('session', 14))}${agent.id}${agent.title ? c.dim(` · ${agent.title}`) : ''}`,
    `  ${c.dim(pad('directory', 14))}${agent.cwd}`,
    `  ${c.dim(pad('model', 14))}${agent.model}`,
    `  ${c.dim(pad('mode', 14))}${modeColor(agent.mode)(MODE_LABEL[agent.mode]!)} ${c.dim(MODE_HELP[agent.mode]!)}`,
    `  ${c.dim(pad('sandbox', 14))}${sb.mode} ${sb.available ? c.ok(`(${sb.kind} enforced)`) : sb.mode === 'full-access' ? c.warn('(off)') : c.warn('(no OS sandbox found — risky commands always ask)')}`,
    `  ${c.dim(pad('trusted', 14))}${rt.trusted() ? c.ok('yes') : c.dim('no (project hooks & stdio MCP servers disabled — /trust)')}`,
    `  ${c.dim(pad('context', 14))}${formatTokens(snap.contextTokens)} / ${formatTokens(snap.contextWindow)}`,
    `  ${c.dim(pad('cost', 14))}${formatCost(snap.totals.costUsd, snap.totals.costPartial)}`,
    '',
    c.bold('Instructions'),
    ...(ins.files.length
      ? ins.files.map((f) => `  ${c.ok('✓')} ${f.label} ${c.dim(`${(f.bytes / 1024).toFixed(1)} KB${f.truncated ? ' (truncated)' : ''}`)}`)
      : [c.dim('  none — run /init to create AGENTS.md')]),
    ...ins.warnings.map((w) => `  ${c.warn('⚠')} ${w}`),
    '',
    c.bold('Integrations'),
    ...(mcp.length ? mcp.map(mcpLine) : [c.dim('  none — add some with `drakox mcp add` or in the web UI (drakox ui)')]),
  ];
  return lines.join('\n');
}

export function mcpLine(s: ReturnType<Runtime['mcp']['states']>[number]): string {
  const icon =
    s.status === 'connected' ? c.ok('●') : s.status === 'connecting' ? c.warn('◌') : s.status === 'needs_auth' ? c.warn('🔑') : s.status === 'disabled' ? c.dim('○') : s.status === 'untrusted' ? c.dim('⊘') : c.err('●');
  const detail =
    s.status === 'connected'
      ? c.dim(`${s.tools.length} tools${s.prompts.length ? `, ${s.prompts.length} prompts` : ''} · ${s.transport}`)
      : s.status === 'needs_auth'
        ? c.warn(`sign-in required — drakox mcp login ${s.name}`)
        : c.dim((s.error ?? s.status).split('\n')[0]!);
  return `  ${icon} ${pad(s.name, 22)} ${detail}`;
}

export async function modelsText(rt: Runtime, current?: string): Promise<string> {
  const statuses = await rt.providers.statuses({ discover: true });
  const lines: string[] = [];
  const order = ['local', 'free', 'paid', 'custom', 'demo'];
  statuses.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
  for (const s of statuses) {
    const ok = s.configured && s.reachable !== false;
    if (!ok && s.category !== 'local' && s.category !== 'free') continue;
    const head = `${ok ? c.ok('●') : c.dim('○')} ${c.bold(s.name)} ${c.dim(`(${s.id} · ${s.category})`)}`;
    if (!ok) {
      lines.push(`${head} ${c.dim(s.category === 'local' ? 'not running' : `add a key: drakox setup${s.signupUrl ? ` · ${s.signupUrl}` : ''}`)}`);
      continue;
    }
    lines.push(head);
    const models = s.models.slice(0, 12);
    for (const m of models) {
      const ref = `${s.id}/${m.id}`;
      lines.push(`    ${ref === current ? c.brand('›') : ' '} ${ref === current ? c.bold(ref) : ref}${m.free ? c.ok(' free') : ''}${m.contextWindow ? c.dim(` · ${formatTokens(m.contextWindow)} ctx`) : ''}`);
    }
    if (s.models.length > models.length) lines.push(c.dim(`      … ${s.models.length - models.length} more`));
  }
  lines.push('', c.dim('Switch with /model <provider/model> · any OpenAI-compatible endpoint works (see docs/configuration.md)'));
  return lines.join('\n');
}

export function sessionsText(rt: Runtime, limit = 15): string {
  const list = rt.store.list({ projectRoot: rt.projectRoot }).slice(0, limit);
  if (!list.length) return c.dim('No sessions yet for this project.');
  return list
    .map((m, i) => {
      const when = new Date(m.updatedAt).toLocaleString();
      return `${c.dim(String(i + 1).padStart(2))}. ${c.bold(m.title || 'Untitled')} ${c.dim(`· ${m.turns} turns · ${formatCost(m.costUsd)} · ${when}`)}\n    ${c.dim(m.id)}${m.lastMessage ? c.dim(` — ${m.lastMessage.slice(0, 80)}`) : ''}`;
    })
    .join('\n');
}

export function costText(agent: Agent): string {
  const t = agent.totals;
  return [
    `  ${c.dim(pad('requests', 16))}${t.requests}`,
    `  ${c.dim(pad('input tokens', 16))}${formatTokens(t.inputTokens)}${t.cachedInputTokens ? c.dim(` (${formatTokens(t.cachedInputTokens)} cached)`) : ''}`,
    `  ${c.dim(pad('output tokens', 16))}${formatTokens(t.outputTokens)}`,
    `  ${c.dim(pad('estimated cost', 16))}${formatCost(t.costUsd, t.costPartial)}${t.costPartial ? c.dim(' (some models have unknown prices)') : ''}`,
    c.dim('  Local models cost $0. DrakoX shows real token counts — no opaque credits.'),
  ].join('\n');
}

export function diffText(agent: Agent): string {
  const files = agent.changedFiles();
  if (!files.length) return c.dim('No files changed in this session.');
  return files
    .map((f) => {
      const before = f.before ? (agent.getBlob(f.before) ?? '') : '';
      const after = f.after ? (agent.getBlob(f.after) ?? '') : '';
      let added = 0;
      let removed = 0;
      for (const part of diffLines(before, after)) {
        if (part.added) added += part.count ?? 0;
        if (part.removed) removed += part.count ?? 0;
      }
      const tag = f.before === null ? c.ok('A') : f.after === null ? c.err('D') : c.warn('M');
      return `  ${tag} ${displayPath(f.path, agent.cwd)} ${c.added(`+${added}`)} ${c.removed(`−${removed}`)} ${c.dim(`turn ${f.turns.join(',')}`)}`;
    })
    .join('\n');
}

export function permissionsText(rt: Runtime): string {
  const p = rt.config.permissions ?? {};
  const list = (label: string, arr: string[] | undefined, color: (s: string) => string) =>
    `${c.bold(label)}\n${arr?.length ? arr.map((r) => `  ${color('•')} ${r}`).join('\n') : c.dim('  (none)')}`;
  return [
    list('Allow', p.allow, c.ok),
    list('Ask', p.ask, c.warn),
    list('Deny', p.deny, c.err),
    c.dim('Rules: tool(pattern) e.g. bash(npm test*), edit_file(src/**), web_fetch(domain:github.com), mcp__github__*'),
    c.dim('Edit in ~/.drakox/config.json, .drakox/settings.json, or the web UI → Settings → Permissions.'),
  ].join('\n');
}

export function skillsText(rt: Runtime): string {
  const skills = rt.skills();
  if (!skills.length) return c.dim('No skills found. Add folders with SKILL.md to .drakox/skills/ or ~/.drakox/skills/.');
  return skills.map((s) => `  ${c.accent('/' + s.name)} ${c.dim(`(${s.source})`)}\n    ${c.dim(s.description.slice(0, 160))}`).join('\n');
}

export function agentsText(rt: Runtime): string {
  const agents = rt.agentProfiles();
  if (!agents.length) return c.dim('No sub-agent profiles. Add markdown files to .drakox/agents/.');
  return agents.map((a) => `  ${c.accent(a.name)} ${c.dim(`(${a.source}${a.model ? ` · ${a.model}` : ''})`)}\n    ${c.dim(a.description.slice(0, 160))}`).join('\n');
}

export { BUILTIN_COMMANDS };

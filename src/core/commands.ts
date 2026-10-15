import fs from 'node:fs';
import path from 'node:path';
import { packageRoot, paths } from './paths.js';
import { parseFrontmatter } from './instructions.js';
import { normalizeToolName } from './tools/index.js';

/** Custom slash commands: markdown prompt templates ($ARGUMENTS, $1…$9). Claude Code compatible locations. */
export interface CustomCommand {
  name: string;
  description: string;
  argumentHint?: string;
  file: string;
  source: 'project' | 'user';
  template: string;
  model?: string;
}

export function discoverCommands(projectRoot: string): CustomCommand[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs: { dir: string; source: CustomCommand['source'] }[] = [
    { dir: path.join(projectRoot, '.drakox', 'commands'), source: 'project' },
    { dir: path.join(projectRoot, '.claude', 'commands'), source: 'project' },
    { dir: path.join(projectRoot, '.cursor', 'commands'), source: 'project' },
    { dir: paths.userCommands(), source: 'user' },
    { dir: path.join(home, '.claude', 'commands'), source: 'user' },
  ];
  const out: CustomCommand[] = [];
  const seen = new Set<string>();
  for (const { dir, source } of dirs) {
    const walk = (d: string, prefix: string) => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) walk(abs, `${prefix}${e.name}:`);
        else if (e.name.endsWith('.md')) {
          const name = prefix + e.name.slice(0, -3);
          if (seen.has(name)) continue;
          seen.add(name);
          const { data, body } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
          out.push({
            name,
            description: String(data.description ?? body.split('\n').find((l) => l.trim())?.slice(0, 80) ?? ''),
            argumentHint: data['argument-hint'] ? String(data['argument-hint']) : undefined,
            file: abs,
            source,
            template: body.trim(),
            model: data.model ? String(data.model) : undefined,
          });
        }
      }
    };
    walk(dir, '');
  }
  return out;
}

export function expandCommand(cmd: CustomCommand, args: string): string {
  const parts = args.match(/"[^"]*"|\S+/g)?.map((s) => s.replace(/^"|"$/g, '')) ?? [];
  let text = cmd.template.replace(/\$ARGUMENTS/g, args);
  for (let i = 1; i <= 9; i++) text = text.replace(new RegExp(`\\$${i}\\b`, 'g'), parts[i - 1] ?? '');
  if (!cmd.template.includes('$ARGUMENTS') && args.trim()) text += `\n\n${args}`;
  return text;
}

// ───────────────────────────── sub-agent profiles ─────────────────────────────

export interface AgentProfile {
  name: string;
  description: string;
  /** Allowed tool names (undefined = all non-recursive tools) */
  tools?: string[];
  model?: string;
  prompt: string;
  source: 'project' | 'user' | 'bundled';
  file?: string;
}

export function discoverAgentProfiles(projectRoot: string): AgentProfile[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs: { dir: string; source: AgentProfile['source'] }[] = [
    { dir: path.join(projectRoot, '.drakox', 'agents'), source: 'project' },
    { dir: path.join(projectRoot, '.claude', 'agents'), source: 'project' },
    { dir: paths.userAgents(), source: 'user' },
    { dir: path.join(home, '.claude', 'agents'), source: 'user' },
    { dir: path.join(packageRoot(), 'agents'), source: 'bundled' },
  ];
  const out: AgentProfile[] = [];
  const seen = new Set<string>();
  for (const { dir, source } of dirs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of files.sort()) {
      const abs = path.join(dir, f);
      try {
        const { data, body } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
        const name = String(data.name ?? f.slice(0, -3));
        if (seen.has(name)) continue;
        seen.add(name);
        const tools = Array.isArray(data.tools)
          ? data.tools.map(String)
          : typeof data.tools === 'string'
            ? data.tools.split(/[,\s]+/).filter(Boolean)
            : undefined;
        out.push({
          name,
          description: String(data.description ?? ''),
          tools: tools?.map(normalizeToolName),
          // Claude-style aliases (sonnet/opus/haiku/inherit) mean "use the session model"
          model: data.model && String(data.model).includes('/') ? String(data.model) : undefined,
          prompt: body.trim(),
          source,
          file: abs,
        });
      } catch {
        /* skip */
      }
    }
  }
  if (!seen.has('general')) {
    out.push({
      name: 'general',
      description: 'General-purpose agent for multi-step research and implementation tasks.',
      prompt: 'You are a capable software engineering sub-agent. Complete the task fully, verify your work, and report concisely.',
      source: 'bundled',
    });
  }
  return out;
}

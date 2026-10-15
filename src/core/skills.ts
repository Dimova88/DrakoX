import fs from 'node:fs';
import path from 'node:path';
import { packageRoot, paths, toPosix } from './paths.js';
import { parseFrontmatter } from './instructions.js';

/**
 * Agent Skills (open SKILL.md standard, agentskills.io) with progressive disclosure:
 * only name + description are in the system prompt; the body is loaded on demand.
 * Compatible locations: .drakox/skills, .agents/skills, .claude/skills (project and user) + bundled skills.
 */
export interface Skill {
  name: string;
  description: string;
  dir: string;
  file: string;
  source: 'project' | 'user' | 'bundled';
  origin: string;
  /** Only invocable by the user via /name, not auto-selected by the model */
  userOnly: boolean;
  allowedTools?: string[];
}

export function skillDirs(projectRoot: string): { dir: string; source: Skill['source']; origin: string }[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return [
    { dir: path.join(projectRoot, '.drakox', 'skills'), source: 'project', origin: '.drakox/skills' },
    { dir: path.join(projectRoot, '.agents', 'skills'), source: 'project', origin: '.agents/skills' },
    { dir: path.join(projectRoot, '.claude', 'skills'), source: 'project', origin: '.claude/skills' },
    { dir: paths.userSkills(), source: 'user', origin: '~/.drakox/skills' },
    { dir: path.join(home, '.agents', 'skills'), source: 'user', origin: '~/.agents/skills' },
    { dir: path.join(home, '.claude', 'skills'), source: 'user', origin: '~/.claude/skills' },
    { dir: path.join(packageRoot(), 'skills'), source: 'bundled', origin: 'bundled' },
  ];
}

export function discoverSkills(projectRoot: string): Skill[] {
  const out: Skill[] = [];
  const seen = new Set<string>();
  for (const { dir, source, origin } of skillDirs(projectRoot)) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries.sort()) {
      const file = path.join(dir, e, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      try {
        const { data } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
        const name = String(data.name ?? e).trim();
        if (!name || seen.has(name)) continue; // closer scopes win
        seen.add(name);
        out.push({
          name,
          description: String(data.description ?? '').trim() || '(no description)',
          dir: path.join(dir, e),
          file,
          source,
          origin,
          userOnly: data['disable-model-invocation'] === true,
          allowedTools: Array.isArray(data['allowed-tools'])
            ? data['allowed-tools'].map(String)
            : typeof data['allowed-tools'] === 'string'
              ? data['allowed-tools'].split(/[,\s]+/).filter(Boolean)
              : undefined,
        });
      } catch {
        /* skip broken skill */
      }
    }
  }
  return out;
}

/** Full skill text for the model: body + list of bundled resource files. */
export function renderSkill(skill: Skill, args?: string): string {
  const raw = fs.readFileSync(skill.file, 'utf8');
  let { body } = parseFrontmatter(raw);
  if (args !== undefined) body = body.replace(/\$ARGUMENTS/g, args);
  const resources: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs, depth + 1);
      else if (abs !== skill.file) resources.push(abs);
    }
  };
  try {
    walk(skill.dir, 0);
  } catch {
    /* ignore */
  }
  const res = resources.length
    ? `\n\n<skill_resources base="${toPosix(skill.dir)}">\n${resources
        .slice(0, 50)
        .map((r) => `- ${toPosix(r)}`)
        .join('\n')}\n</skill_resources>\nRead these files with read_file when the instructions reference them.`
    : '';
  return `<skill name="${skill.name}">\n${body.trim()}\n</skill>${res}`;
}

export function createSkillTemplate(dir: string, name: string, description: string): string {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const file = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDescribe when to use this skill and the exact steps to follow.\n\n## Steps\n1. …\n2. …\n\n## Checklist\n- [ ] …\n`,
    );
  }
  return file;
}

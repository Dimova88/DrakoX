import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { paths, toPosix } from './paths.js';
import type { DrakoxConfig } from './types.js';

/**
 * Universal project instructions.
 * DrakoX reads the instruction files of every major agent so a repo works out of the box:
 *   AGENTS.md (+ AGENTS.override.md), DRAKOX.md, CLAUDE.md, CLAUDE.local.md, GEMINI.md,
 *   .cursorrules, .cursor/rules/*.mdc, .windsurfrules, .clinerules, .github/copilot-instructions.md
 * Files are layered global → repo root → … → current directory (closest wins on conflict).
 * If the budget is exceeded, DrakoX tells you exactly what was cut — never silently.
 */

export interface InstructionFile {
  path: string;
  /** Display label, e.g. "AGENTS.md (repo root)" */
  label: string;
  bytes: number;
  content: string;
  scope: 'global' | 'project' | 'directory';
  truncated?: boolean;
  /** Cursor "agent requested" rules are listed by description only */
  mode?: 'always' | 'listed';
  description?: string;
}

export interface LoadedInstructions {
  files: InstructionFile[];
  text: string;
  totalBytes: number;
  budget: number;
  warnings: string[];
}

const PER_DIR = ['AGENTS.md', 'DRAKOX.md', 'CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md'];
const ROOT_ONLY_COMPAT = ['.cursorrules', '.windsurfrules', '.clinerules', path.join('.github', 'copilot-instructions.md')];

export function loadInstructions(projectRoot: string, cwd: string, config: DrakoxConfig): LoadedInstructions {
  const budget = config.instructions?.maxBytes ?? 65536;
  const compat = !config.instructions?.disableCompat;
  const files: InstructionFile[] = [];
  const seenContent = new Set<string>();
  const seenPath = new Set<string>();

  const add = (abs: string, scope: InstructionFile['scope'], label: string, extra: Partial<InstructionFile> = {}) => {
    let real = abs;
    try {
      real = fs.realpathSync(abs);
    } catch {
      return;
    }
    if (seenPath.has(real)) return;
    let content: string;
    try {
      const st = fs.statSync(real);
      if (!st.isFile()) return;
      content = fs.readFileSync(real, 'utf8');
    } catch {
      return;
    }
    const trimmed = content.trim();
    if (!trimmed) return;
    const key = trimmed.replace(/\s+/g, ' ');
    seenPath.add(real);
    if (seenContent.has(key)) return; // e.g. CLAUDE.md symlinked/copied from AGENTS.md
    seenContent.add(key);
    files.push({ path: abs, label, bytes: Buffer.byteLength(trimmed), content: trimmed, scope, ...extra });
  };

  // global
  add(paths.userInstructions(), 'global', '~/.drakox/AGENTS.md');
  add(path.join(paths.home(), 'DRAKOX.md'), 'global', '~/.drakox/DRAKOX.md');

  // repo root → cwd
  const chain: string[] = [];
  let dir = path.resolve(cwd);
  const root = path.resolve(projectRoot);
  while (true) {
    chain.unshift(dir);
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir || !dir.startsWith(root)) break;
    dir = parent;
  }
  for (const d of chain) {
    const where = d === root ? 'repo root' : toPosix(path.relative(root, d));
    const override = path.join(d, 'AGENTS.override.md');
    const hasOverride = fs.existsSync(override);
    if (hasOverride) add(override, d === root ? 'project' : 'directory', `AGENTS.override.md (${where})`);
    for (const name of PER_DIR) {
      if (name === 'AGENTS.md' && hasOverride) continue;
      if (!compat && name !== 'AGENTS.md' && name !== 'DRAKOX.md') continue;
      add(path.join(d, name), d === root ? 'project' : 'directory', `${name} (${where})`);
    }
  }
  if (compat) {
    for (const f of ROOT_ONLY_COMPAT) add(path.join(root, f), 'project', toPosix(f));
    // Cursor project rules
    const rulesDir = path.join(root, '.cursor', 'rules');
    try {
      for (const f of fs.readdirSync(rulesDir).filter((x) => x.endsWith('.mdc') || x.endsWith('.md')).sort()) {
        const abs = path.join(rulesDir, f);
        const raw = fs.readFileSync(abs, 'utf8');
        const { data, body } = parseFrontmatter(raw);
        const always = data.alwaysApply === true || data.alwaysApply === 'true';
        if (always) add(abs, 'project', `.cursor/rules/${f}`, { mode: 'always' });
        else if (data.description) {
          files.push({
            path: abs,
            label: `.cursor/rules/${f}`,
            bytes: 0,
            content: '',
            scope: 'project',
            mode: 'listed',
            description: `${String(data.description)}${data.globs ? ` (applies to ${String(data.globs)})` : ''}`,
          });
          void body;
        }
      }
    } catch {
      /* no cursor rules */
    }
  }
  for (const extra of config.instructions?.extraFiles ?? []) add(path.resolve(root, extra), 'project', toPosix(extra));

  // budget: keep the most specific files intact; truncate from the least specific (global) first
  const warnings: string[] = [];
  let total = files.reduce((n, f) => n + f.bytes, 0);
  if (total > budget) {
    const order = [...files].sort((a, b) => rank(a.scope) - rank(b.scope));
    for (const f of order) {
      if (total <= budget) break;
      const over = total - budget;
      const keep = Math.max(0, f.bytes - over);
      const cut = f.bytes - keep;
      f.content = keep > 0 ? f.content.slice(0, keep) + `\n…[truncated ${cut} bytes — raise instructions.maxBytes to include everything]` : '';
      f.truncated = true;
      total -= cut;
      warnings.push(`${f.label}: ${cut.toLocaleString()} bytes not loaded (instruction budget ${budget.toLocaleString()} bytes). Raise "instructions.maxBytes" or split the file.`);
    }
  }

  const sections = files
    .filter((f) => f.mode !== 'listed' && f.content)
    .map((f) => `<instructions source="${f.label}">\n${f.content}\n</instructions>`);
  const listed = files.filter((f) => f.mode === 'listed');
  if (listed.length) {
    sections.push(
      `<conditional_rules>\nThese project rules apply only in some situations. Read the file with read_file when relevant:\n${listed.map((f) => `- ${toPosix(path.relative(root, f.path))}: ${f.description}`).join('\n')}\n</conditional_rules>`,
    );
  }
  return { files, text: sections.join('\n\n'), totalBytes: files.reduce((n, f) => n + f.bytes, 0), budget, warnings };
}

function rank(scope: InstructionFile['scope']): number {
  return scope === 'global' ? 0 : scope === 'project' ? 1 : 2;
}

export function parseFrontmatter(raw: string): { data: Record<string, any>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw };
  try {
    const data = YAML.parse(m[1]!) ?? {};
    return { data: typeof data === 'object' ? data : {}, body: m[2] ?? '' };
  } catch {
    return { data: {}, body: m[2] ?? '' };
  }
}

import fs from 'node:fs';
import path from 'node:path';
import type { ImagePart } from './types.js';
import { isInside } from './paths.js';

const IMAGE_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** Expand @file / @dir / @image mentions into context blocks. */
export function expandMentions(text: string, cwd: string, opts: { confine?: boolean } = {}): { text: string; images: ImagePart[]; attached: string[] } {
  const images: ImagePart[] = [];
  const attached: string[] = [];
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/(?:^|\s)@((?:[^\s"'`]|\\ )+)/g)) {
    const rel = m[1]!.replace(/[.,;:!?)]+$/, '').replace(/\\ /g, ' ');
    if (seen.has(rel)) continue;
    const abs = path.resolve(cwd, rel);
    if (opts.confine && !isInside(abs, cwd)) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    seen.add(rel);
    const ext = path.extname(abs).toLowerCase();
    if (st.isDirectory()) {
      const entries = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.name !== 'node_modules' && e.name !== '.git').slice(0, 200);
      blocks.push(`<directory path="${rel}">\n${entries.map((e) => e.name + (e.isDirectory() ? '/' : '')).join('\n')}\n</directory>`);
      attached.push(`${rel}/ (${entries.length} entries)`);
    } else if (IMAGE_EXT[ext] && st.size < 8 * 1024 * 1024) {
      images.push({ type: 'image', mediaType: IMAGE_EXT[ext]!, data: fs.readFileSync(abs).toString('base64') });
      attached.push(`${rel} (image)`);
    } else if (st.size < 512 * 1024) {
      const content = fs.readFileSync(abs, 'utf8');
      blocks.push(`<file path="${rel}">\n${content.length > 100_000 ? content.slice(0, 100_000) + '\n…[truncated]' : content}\n</file>`);
      attached.push(`${rel} (${content.split('\n').length} lines)`);
    } else {
      attached.push(`${rel} (too large to inline — DrakoX can read it with tools)`);
    }
  }
  if (!blocks.length) return { text, images, attached };
  return { text: `${text}\n\n<attached_context>\n${blocks.join('\n\n')}\n</attached_context>`, images, attached };
}


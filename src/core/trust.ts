import path from 'node:path';
import { paths } from './paths.js';
import { readJson, writeJson } from './util.js';

/**
 * Workspace trust. Project files can define hooks and stdio MCP servers, i.e. commands
 * that execute on your machine. DrakoX only runs them after you trust the folder
 * (defends against "malicious repo config" attacks that hit other agent IDEs).
 */
interface TrustFile {
  trusted: string[];
}

export function isTrusted(dir: string): boolean {
  const t = readJson<TrustFile>(paths.trust(), { trusted: [] });
  const abs = path.resolve(dir);
  return t.trusted.some((p) => abs === p || abs.startsWith(p + path.sep));
}

export function setTrusted(dir: string, trusted: boolean): void {
  const t = readJson<TrustFile>(paths.trust(), { trusted: [] });
  const abs = path.resolve(dir);
  t.trusted = t.trusted.filter((p) => p !== abs);
  if (trusted) t.trusted.push(abs);
  writeJson(paths.trust(), t);
}

#!/usr/bin/env node
// Try DrakoX on a sample project in one command:
//
//   npm run demo                         # fresh git-initialised copy of examples/acme-shop → drakox ui
//   npm run demo -- --dir ~/acme-shop    # choose where the copy lives
//   npm run demo -- --reset              # start over from a pristine copy
//   npm run demo -- --prepare-only       # only create the copy (then run `drakox` in it yourself)
//
// Any other flags are passed to `drakox ui` (e.g. --port 4546 --no-open).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const take = (flag) => {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const has = (flag) => {
  const i = args.indexOf(flag);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
};

const dirArg = take('--dir');
const dir = path.resolve(dirArg ? dirArg.replace(/^~(?=$|\/)/, os.homedir()) : path.join(os.tmpdir(), 'drakox-demo', 'acme-shop'));
const reset = has('--reset');
const prepareOnly = has('--prepare-only');
const source = path.join(root, 'examples', 'acme-shop');

if (reset) fs.rmSync(dir, { recursive: true, force: true });
if (fs.existsSync(path.join(dir, 'package.json'))) {
  console.log(`Using the existing sample project at ${dir} (add --reset for a fresh copy)`);
} else {
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(source, dir, { recursive: true });
  // a git repository lets you try worktree agents, best-of-N, /review and diffs vs HEAD
  const git = (...a) => spawnSync('git', a, { cwd: dir, stdio: 'ignore' });
  const init = git('init', '-q');
  if (init.status === 0) {
    git('add', '-A');
    git('-c', 'user.name=Acme Dev', '-c', 'user.email=dev@acme.test', 'commit', '-qm', 'Acme Shop: catalog, cart, API');
  }
  console.log(`Sample project ready at ${dir}${init.status === 0 ? '' : ' (git not found — worktree features disabled)'}`);
  console.log('Try: "fix the failing discount test"');
}
if (prepareOnly) process.exit(0);

const cli = path.join(root, 'dist', 'cli', 'index.js');
if (!fs.existsSync(cli)) {
  console.error('DrakoX is not built yet — run `npm run build` first.');
  process.exit(1);
}
const child = spawn(process.execPath, [cli, 'ui', ...args], { cwd: dir, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 0 : 1)));

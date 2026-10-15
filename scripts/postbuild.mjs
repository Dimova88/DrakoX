// Make the CLI entry executable and give it a shebang (tsc does not emit one).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'cli', 'index.js');
let src = fs.readFileSync(cli, 'utf8');
if (!src.startsWith('#!')) {
  src = '#!/usr/bin/env node\n' + src;
  fs.writeFileSync(cli, src);
}
fs.chmodSync(cli, 0o755);
console.log('postbuild: dist/cli/index.js is executable');

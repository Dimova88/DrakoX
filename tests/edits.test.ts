import { describe, expect, it } from 'vitest';
import { applyEdit } from '../src/core/tools/fs';
import { applyChunks, parsePatch } from '../src/core/tools/patch';

describe('edit_file matching', () => {
  it('replaces a unique occurrence', () => {
    const r = applyEdit('const a = 1;\nconst b = 2;\n', 'const b = 2;', 'const b = 3;', false);
    expect('content' in r && r.content).toBe('const a = 1;\nconst b = 3;\n');
  });
  it('refuses ambiguous matches unless replace_all', () => {
    const r = applyEdit('x\nx\n', 'x', 'y', false);
    expect('error' in r).toBe(true);
    const r2 = applyEdit('x\nx\n', 'x', 'y', true);
    expect('content' in r2 && r2.content).toBe('y\ny\n');
  });
  it('tolerates indentation differences', () => {
    const r = applyEdit('function f() {\n    return 1;\n}\n', 'return 1;', 'return 2;', false);
    expect('content' in r && r.content.includes('return 2;')).toBe(true);
  });
  it('preserves CRLF line endings', () => {
    const r = applyEdit('a\r\nb\r\n', 'a\nb', 'a\nc', false);
    expect('content' in r && r.content).toBe('a\r\nc\r\n');
  });
});

describe('apply_patch (Codex format)', () => {
  it('parses add / update / delete operations', () => {
    const ops = parsePatch(`*** Begin Patch
*** Add File: hello.txt
+Hello
+World
*** Update File: src/app.ts
@@ function main
-  console.log('old');
+  console.log('new');
*** Delete File: old.txt
*** End Patch`);
    expect(ops.map((o) => o.type)).toEqual(['add', 'update', 'delete']);
    const upd = ops[1]!;
    if (upd.type !== 'update') throw new Error('expected update');
    const out = applyChunks("function main() {\n  console.log('old');\n}\n", upd.chunks);
    expect(out).toContain("console.log('new')");
  });
});

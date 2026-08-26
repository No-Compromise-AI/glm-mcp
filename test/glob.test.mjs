// Glob ignore-directory behaviour (issue #2): default skip set, explicit-name
// bypass, and GLM_MCP_GLOB_IGNORE override — exercised against a hermetic
// fixture tree so the assertions don't depend on this repository's contents.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandGlob } from '../dist/glob.js';

const DEFAULT_IGNORED = [
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo', 'vendor', 'target',
];
const VISIBLE_IGNORED = DEFAULT_IGNORED.filter((n) => !n.startsWith('.'));

let root;
const put = (dir, name) => {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, name), 'x');
};

before(() => {
  delete process.env.GLM_MCP_GLOB_IGNORE;
  root = mkdtempSync(join(tmpdir(), 'glm-glob-test-'));

  for (const name of DEFAULT_IGNORED) put(name, 'a.ts');
  put('src', 'a.ts');
  // A node_modules nested under ordinary source: wildcards must skip it too.
  put('src/node_modules', 'b.ts');
  // Wildcard route (src) and accidental route (node_modules) to the same shape.
  put('node_modules/body-parser/node_modules/content-type/dist', 'index.d.ts');
  put('src/body-parser/node_modules/content-type/dist', 'index.d.ts');
  put('node_modules/sdk', 'index.d.ts');
  put('.git', 'HEAD');
});

after(() => rmSync(root, { recursive: true, force: true }));

test('wildcards never enter any default-ignored directory', () => {
  assert.deepEqual(expandGlob('**/*.ts', root), ['src/a.ts']);
});

test('every default-ignored directory is entered when named explicitly', () => {
  for (const name of DEFAULT_IGNORED) {
    assert.deepEqual(expandGlob(`${name}/a.ts`, root), [`${name}/a.ts`], name);
  }
});

test('a later literal segment does not unlock a wildcard earlier in the pattern', () => {
  // The leading `*` matches both `src` and `node_modules`; only the route the
  // pattern spells out may enter a node_modules.
  const hit = 'src/body-parser/node_modules/content-type/dist/index.d.ts';
  assert.deepEqual(
    expandGlob('*/body-parser/node_modules/content-type/dist/*.d.ts', root),
    [hit],
  );
});

test('an escaped segment still names its directory explicitly', () => {
  assert.deepEqual(expandGlob('\\.git/**/*', root), ['.git/HEAD', '.git/a.ts']);
  assert.deepEqual(expandGlob('node\\_modules/sdk/*.d.ts', root), [
    'node_modules/sdk/index.d.ts',
  ]);
});

test('nested ignored directories are skipped along with top-level ones', () => {
  assert.deepEqual(expandGlob('src/**/a.ts', root), ['src/a.ts']);
  assert.deepEqual(expandGlob('src/node_modules/b.ts', root), ['src/node_modules/b.ts']);
});

test('GLM_MCP_GLOB_IGNORE replaces the default set outright', (t) => {
  t.after(() => delete process.env.GLM_MCP_GLOB_IGNORE);
  process.env.GLM_MCP_GLOB_IGNORE = 'dist,coverage';
  const found = expandGlob('**/*.ts', root);
  assert.ok(found.includes('node_modules/a.ts'), 'defaults must not linger after replacement');
  assert.ok(found.includes('build/a.ts'), 'unlisted names must not be ignored');
  assert.ok(!found.includes('dist/a.ts'), 'named replacement entries must be ignored');
  assert.ok(!found.includes('coverage/a.ts'), 'named replacement entries must be ignored');
});

test('GLM_MCP_GLOB_IGNORE entries are trimmed', (t) => {
  t.after(() => delete process.env.GLM_MCP_GLOB_IGNORE);
  process.env.GLM_MCP_GLOB_IGNORE = ' dist ';
  assert.ok(!expandGlob('**/*.ts', root).includes('dist/a.ts'));
});

test('an empty GLM_MCP_GLOB_IGNORE disables skipping entirely', (t) => {
  t.after(() => delete process.env.GLM_MCP_GLOB_IGNORE);
  process.env.GLM_MCP_GLOB_IGNORE = '';
  // Every non-hidden fixture file is reachable once nothing is ignored.
  assert.deepEqual(expandGlob('**/*.ts', root), [
    ...VISIBLE_IGNORED.map((n) => `${n}/a.ts`),
    'node_modules/body-parser/node_modules/content-type/dist/index.d.ts',
    'node_modules/sdk/index.d.ts',
    'src/a.ts',
    'src/body-parser/node_modules/content-type/dist/index.d.ts',
    'src/node_modules/b.ts',
  ].sort());
});

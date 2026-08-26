// Glob ignore-directory behaviour (issue #2): default skip set, explicit-name
// bypass, and GLM_MCP_GLOB_IGNORE override — exercised against a hermetic
// fixture tree so the assertions don't depend on this repository's contents.
// The suite below that covers issue #3: `./`/`../` prefixes, order-independent
// de-duplication, literal paths containing glob metacharacters, and symlinked
// directories.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { expandGlob } from '../dist/glob.js';
import { buildFileContext } from '../dist/glm.js';

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

// --- issue #3 ---

let fx;
const occurrences = (ctx, marker) => ctx.text.split(marker).length - 1;

before(() => {
  delete process.env.GLM_MCP_GLOB_IGNORE;
  fx = mkdtempSync(join(tmpdir(), 'glm-glob-issue3-'));
  const put = (dir, name, body = 'x') => {
    mkdirSync(join(fx, dir), { recursive: true });
    writeFileSync(join(fx, dir, name), body);
  };
  put('src', 'a.ts', 'A');
  put('src', 'b.ts', 'B');
  put('src', 'glm.ts', 'GLM');
  put('lib', 'x.ts');
  put('', 'report[final].md', 'FINAL REPORT');
  put('cls', 'a.md', 'A-MD');
  put('cls', 'b.md', 'B-MD');
  symlinkSync(join(fx, 'src'), join(fx, 'linked'), 'dir');
  symlinkSync(join(fx, 'src'), join(fx, 'dirlink'), 'dir');
  symlinkSync(join(fx, 'src', 'a.ts'), join(fx, 'filelink'), 'file');
});
after(() => rmSync(fx, { recursive: true, force: true }));

test('a ./ prefix resolves against the expansion cwd', () => {
  const expected = ['src/a.ts', 'src/b.ts', 'src/glm.ts'];
  assert.deepEqual(expandGlob('src/*.ts', fx), expected);
  assert.deepEqual(expandGlob('./src/*.ts', fx), expected);
  assert.deepEqual(expandGlob('./src/**/*.ts', fx), expandGlob('src/**/*.ts', fx));
});

test('a ../ prefix climbs out of the cwd and back in', () => {
  const pattern = `../${basename(fx)}/src/*.ts`;
  assert.deepEqual(expandGlob(pattern, fx), ['src/a.ts', 'src/b.ts', 'src/glm.ts'].map(
    (f) => `../${basename(fx)}/${f}`,
  ));
  // The expanded names must still resolve to the files they name.
  const ctx = buildFileContext([pattern], fx);
  assert.equal(occurrences(ctx, '--- ../'), 3);
  assert.ok(ctx.text.includes('GLM'), 'the climbed-out files must be read');
  assert.deepEqual(ctx.notes, []);
});

test('dot segments inside a leading literal run resolve', () => {
  assert.deepEqual(expandGlob('src/../lib/*.ts', fx), ['lib/x.ts']);
  assert.deepEqual(expandGlob('./src/./glm.ts', fx), ['src/glm.ts']);
});

test('a fully literal pattern still names its file', () => {
  // Guards the leading-literal resolution against swallowing the whole pattern.
  assert.deepEqual(expandGlob('src/glm.ts', fx), ['src/glm.ts']);
  assert.deepEqual(expandGlob('lib', fx), []); // directories are never listed
});

test('de-duplication does not depend on argument order', () => {
  for (const paths of [['src/*.ts', 'src/glm.ts'], ['src/glm.ts', 'src/*.ts']]) {
    const ctx = buildFileContext(paths, fx);
    assert.equal(occurrences(ctx, '--- src/glm.ts ---'), 1, JSON.stringify(paths));
    for (const f of ['src/a.ts', 'src/b.ts']) {
      assert.ok(ctx.text.includes(`--- ${f} ---`), `${f} went missing`);
    }
  }
});

test('a repeated literal path appears exactly once', () => {
  const ctx = buildFileContext(['src/glm.ts', 'src/glm.ts'], fx);
  assert.equal(occurrences(ctx, '--- src/glm.ts ---'), 1);
});

test('a literal path wins over pattern interpretation', () => {
  const ctx = buildFileContext(['report[final].md'], fx);
  assert.ok(ctx.text.includes('FINAL REPORT'), 'the existing file must be read');
  assert.deepEqual(ctx.notes, []);
});

test('metacharacter spellings without a literal file still expand as patterns', () => {
  const ctx = buildFileContext(['cls/[ab].md'], fx);
  assert.ok(ctx.text.includes('A-MD'));
  assert.ok(ctx.text.includes('B-MD'));
  assert.deepEqual(ctx.notes, []);
});

test('an explicitly named symlinked directory is followed', () => {
  assert.deepEqual(expandGlob('linked/*.ts', fx), [
    'linked/a.ts', 'linked/b.ts', 'linked/glm.ts',
  ]);
});

test('wildcards still never follow symlinked directories', () => {
  assert.deepEqual(expandGlob('*/a.ts', fx), ['src/a.ts']);
});

test('a symlink to a directory is not listed as a file', () => {
  assert.deepEqual(expandGlob('dirlink', fx), []);
  assert.deepEqual(expandGlob('dir*', fx), []);
});

test('a symlink to a file still matches', () => {
  assert.deepEqual(expandGlob('filelink', fx), ['filelink']);
});

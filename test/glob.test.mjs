// Glob ignore-directory behaviour (issue #2): default skip set, explicit-name
// bypass, and GLM_MCP_GLOB_IGNORE override — exercised against a hermetic
// fixture tree so the assertions don't depend on this repository's contents.
// The suite below that covers issue #3: `./`/`../` prefixes, order-independent
// de-duplication, literal paths containing glob metacharacters, and symlinked
// directories.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
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
  // The reads below go through buildFileContext, which confines to the
  // operator's roots — by default the process's own startup cwd, this
  // repository. The fixture is under tmpdir, so the root is declared over it.
  // Configuration only: every assertion is unchanged from #3.
  process.env.GLM_MCP_ROOTS = fx;
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
  put('case', 'glob.ts', 'CASEBODY');
  put('real', 'f.ts', 'F');
  mkdirSync(join(fx, 'a'), { recursive: true });
  symlinkSync(join(fx, 'real'), join(fx, 'a', 'linked'), 'dir');
  // A dangling symlink named with glob metacharacters, plus the file its
  // pattern reading would wrongly pick up instead.
  put('dang', 'reportv.md', 'WILDBODY');
  symlinkSync(join(fx, 'nowhere'), join(fx, 'dang', 'report[v2].md'));
  symlinkSync(join(fx, 'nowhere'), join(fx, 'broken'));
  symlinkSync(join(fx, 'src'), join(fx, 'linked'), 'dir');
  symlinkSync(join(fx, 'src'), join(fx, 'dirlink'), 'dir');
  symlinkSync(join(fx, 'src', 'a.ts'), join(fx, 'filelink'), 'file');
});
after(() => {
  delete process.env.GLM_MCP_ROOTS;
  rmSync(fx, { recursive: true, force: true });
});

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

test('de-duplication tracks files, not spellings: symlink alias', () => {
  // linked/a.ts and src/a.ts are the same file on disk; whichever way it is
  // reached, directly or through a glob, it is read exactly once.
  for (const paths of [['linked/a.ts', 'src/*.ts'], ['src/*.ts', 'linked/a.ts']]) {
    const ctx = buildFileContext(paths, fx);
    assert.equal(occurrences(ctx, 'A'), 1, JSON.stringify(paths));
    assert.equal(
      occurrences(ctx, '--- linked/a.ts ---') + occurrences(ctx, '--- src/a.ts ---'),
      1,
      `the same file must have exactly one header: ${JSON.stringify(ctx.text.match(/--- [^\n]+ ---/g))}`,
    );
  }
});

test('de-duplication tracks files, not spellings: case variants', (t) => {
  // On a case-insensitive filesystem (macOS/Windows default) case/GLOB.ts and
  // case/glob.ts name the same file; on a case-sensitive one they do not, and
  // the literal simply does not exist.
  if (!existsSync(join(fx, 'CASE'))) t.skip('filesystem is case-sensitive');
  for (const paths of [['case/GLOB.ts', 'case/*.ts'], ['case/*.ts', 'case/GLOB.ts']]) {
    const ctx = buildFileContext(paths, fx);
    assert.equal(occurrences(ctx, 'CASEBODY'), 1, JSON.stringify(paths));
  }
});

test('a dangling symlink is not reinterpreted as a pattern', () => {
  // dang/report[v2].md exists as a name (the link) even though nothing is
  // behind it: it must be read literally — and so fail to be read — rather
  // than expand as [v2] and pick up the unrelated dang/reportv.md.
  const ctx = buildFileContext(['dang/report[v2].md'], fx);
  assert.ok(!ctx.text.includes('WILDBODY'), `the pattern reading leaked through: ${ctx.text}`);
  assert.equal(ctx.text, '');
  assert.equal(ctx.notes.length, 1);
  assert.ok(ctx.notes[0].includes('dang/report[v2].md'), JSON.stringify(ctx.notes));
});

test('a nested symlinked directory is followed when a literal segment names it', () => {
  // Unlike linked/*.ts (whose leading literal is resolved before the walk),
  // this pattern meets the symlink mid-walk, through its own segment.
  assert.deepEqual(expandGlob('*/linked/*.ts', fx), ['a/linked/f.ts']);
  assert.deepEqual(expandGlob('**/linked/*.ts', fx), [
    'a/linked/f.ts', 'linked/a.ts', 'linked/b.ts', 'linked/glm.ts',
  ]);
});

test('** never follows a symlinked directory itself', () => {
  const found = expandGlob('**/f.ts', fx);
  assert.ok(!found.includes('a/linked/f.ts'), `** rode a symlink: ${JSON.stringify(found)}`);
  assert.deepEqual(found, ['real/f.ts']);
});

test('a broken symlink matches nothing', () => {
  const star = expandGlob('*', fx);
  assert.ok(!star.includes('broken'), `a broken link was listed: ${JSON.stringify(star)}`);
  assert.ok(star.includes('filelink'), 'a working file link must still match');
  assert.deepEqual(expandGlob('broken', fx), []);
  assert.deepEqual(expandGlob('brok*', fx), []);
});

// --- issue #3, Windows path handling ---
// `C:/repo/src/*.ts` is absolute on Windows; off Windows `C:` is an ordinary
// directory name. A POSIX host cannot address a drive, so the Windows case
// fakes the platform and anchors its fixture at the process cwd — the one
// place a `C:/`-rooted walk can land there. That still exercises drive
// detection, base construction and the emitted names, and proves the cwd
// argument never re-anchors a drive pattern (before the fix, Windows ran
// `resolve(cwd, "C:")`, which searched `C:\repo\repo\src` and matched nothing).

const driveFixture = () => {
  const drive = mkdtempSync(join(tmpdir(), 'glm-glob-drive-'));
  mkdirSync(join(drive, 'C:', 'repo', 'src'), { recursive: true });
  writeFileSync(join(drive, 'C:', 'repo', 'src', 'a.ts'), 'A');
  return drive;
};

test('a drive-letter pattern is absolute on Windows', () => {
  const realPlatform = process.platform;
  const realCwd = process.cwd();
  const drive = driveFixture();
  process.chdir(drive);
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    for (const cwd of ['Z:\\elsewhere', join(drive, 'unrelated')]) {
      assert.deepEqual(expandGlob('C:/repo/src/*.ts', cwd), ['C:/repo/src/a.ts'],
        `the cwd argument must not re-anchor a drive pattern (cwd=${cwd})`);
    }
    // A `..` inside the drive pops the same way it does under `/`.
    assert.deepEqual(expandGlob('C:/repo/../repo/src/*.ts', 'Z:\\elsewhere'), ['C:/repo/src/a.ts']);
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    process.chdir(realCwd);
    rmSync(drive, { recursive: true, force: true });
  }
});

test('off Windows a `C:` segment is an ordinary directory name', (t) => {
  if (process.platform === 'win32') t.skip('drive letters are absolute here');
  const drive = driveFixture();
  try {
    assert.deepEqual(expandGlob('C:/repo/src/*.ts', drive), ['C:/repo/src/a.ts']);
  } finally {
    rmSync(drive, { recursive: true, force: true });
  }
});

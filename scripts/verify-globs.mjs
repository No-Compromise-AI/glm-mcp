// verify-globs.mjs — acceptance gate for the glob fixes in #3: `./` and `../`
// prefixes resolve against cwd, de-duplication does not depend on argument
// order, and a literal path wins over pattern interpretation even when its
// name contains glob metacharacters. The issue's symlink P2 is covered too:
// an explicitly named symlinked directory is followed, wildcards and terminal
// directory links are not. So is its Windows P2, in the forward-slash forms
// that do not collide with `\` escape syntax: drive-letter patterns anchor at
// their drive. Checks run against this repository and a throwaway fixture
// tree.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { expandGlob } from '../dist/glob.js';
import { buildFileContext } from '../dist/glm.js';

const fail = (msg) => { throw new Error(msg); };
const occurrences = (ctx, marker) => ctx.text.split(marker).length - 1;

// This repository, the exact shape the issue reproduces: ./ and ../ variants
// must return exactly what the plain pattern returns.
const repo = process.cwd();
const plain = expandGlob('src/**/*.ts', repo);
if (plain.length === 0 || !plain.includes('src/glob.ts')) fail('src/**/*.ts must match own source');
for (const [pattern, expected, what] of [
  ['./src/**/*.ts', plain, 'a ./ prefix must resolve against cwd'],
  // The ../-climbed names keep their prefix; the files behind them are the same.
  [`../${basename(repo)}/src/**/*.ts`, plain.map((f) => `../${basename(repo)}/${f}`),
    'a ../ prefix must climb out of cwd and back in'],
]) {
  const got = expandGlob(pattern, repo);
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    fail(`${what}: ${pattern} returned [${got.join(', ')}], expected [${expected.join(', ')}]`);
  }
}

// Fixture tree for the dedupe, metacharacter and symlink cases.
const root = mkdtempSync(join(tmpdir(), 'glm-globs-verify-'));
const put = (dir, name, body = 'x') => {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, name), body);
};
try {
  const hadEnv = 'GLM_MCP_GLOB_IGNORE' in process.env;
  const savedEnv = process.env.GLM_MCP_GLOB_IGNORE;
  delete process.env.GLM_MCP_GLOB_IGNORE;

  put('src', 'a.ts', 'A');
  put('src', 'b.ts', 'B');
  put('src', 'glm.ts', 'GLM');
  put('lib', 'x.ts');
  put('', 'report[final].md', 'FINAL REPORT');

  // De-duplication is order-independent: the same file reached directly and
  // through a glob appears exactly once, whichever argument names it first.
  for (const paths of [['src/*.ts', 'src/glm.ts'], ['src/glm.ts', 'src/*.ts']]) {
    const ctx = buildFileContext(paths, root);
    if (occurrences(ctx, '--- src/glm.ts ---') !== 1) {
      fail(`${paths.join(', ')}: src/glm.ts must appear exactly once, text was:\n${ctx.text}`);
    }
    for (const f of ['src/a.ts', 'src/b.ts']) {
      if (!ctx.text.includes(`--- ${f} ---`)) fail(`${paths.join(', ')}: ${f} went missing`);
    }
  }
  if (occurrences(buildFileContext(['src/glm.ts', 'src/glm.ts'], root), '--- src/glm.ts ---') !== 1) {
    fail('a repeated literal path must appear exactly once');
  }

  // A literal file whose name contains metacharacters is used as itself; the
  // same spelling with no such file on disk still expands as a pattern.
  const literal = buildFileContext(['report[final].md'], root);
  if (!literal.text.includes('FINAL REPORT')) fail('an existing file named report[final].md must be read literally');
  if (literal.notes.length > 0) fail(`report[final].md must not be treated as a pattern: ${literal.notes.join('; ')}`);
  put('cls', 'a.md', 'A-MD');
  put('cls', 'b.md', 'B-MD');
  const classy = buildFileContext(['cls/[ab].md'], root);
  if (!classy.text.includes('A-MD') || !classy.text.includes('B-MD')) {
    fail(`[ab].md must still expand as a character class: ${classy.text}`);
  }

  // Symlinked directories: explicit names follow, everything else does not.
  symlinkSync(join(root, 'src'), join(root, 'linked'), 'dir');
  symlinkSync(join(root, 'src'), join(root, 'dirlink'), 'dir');
  symlinkSync(join(root, 'src', 'a.ts'), join(root, 'filelink'), 'file');
  const named = expandGlob('linked/*.ts', root);
  if (JSON.stringify(named) !== JSON.stringify(['linked/a.ts', 'linked/b.ts', 'linked/glm.ts'])) {
    fail(`an explicitly named symlinked directory must be followed: [${named.join(', ')}]`);
  }
  const wild = expandGlob('*/a.ts', root);
  if (wild.some((f) => f.startsWith('linked/'))) fail('a wildcard must not follow a symlinked directory');
  if (!wild.includes('src/a.ts')) fail('real directories must still match through wildcards');
  if (expandGlob('dirlink', root).length !== 0 || expandGlob('dir*', root).length !== 0) {
    fail('a symlink to a directory must not be listed as a file');
  }
  if (!expandGlob('filelink', root).includes('filelink')) fail('a symlink to a file must still match');

  // The same explicit-name policy one level down, where the segment meets the
  // symlink mid-walk instead of being resolved away as a leading literal, plus
  // the broken link that must never match anything.
  put('real', 'f.ts', 'F');
  mkdirSync(join(root, 'pkg'), { recursive: true });
  symlinkSync(join(root, 'real'), join(root, 'pkg', 'linked'), 'dir');
  const nested = expandGlob('*/linked/*.ts', root);
  if (JSON.stringify(nested) !== JSON.stringify(['pkg/linked/f.ts'])) {
    fail(`a literal segment must follow a nested symlinked directory: [${nested.join(', ')}]`);
  }
  const globstar = expandGlob('**/f.ts', root);
  if (globstar.includes('pkg/linked/f.ts') || !globstar.includes('real/f.ts')) {
    fail(`** must ride only real directories: [${globstar.join(', ')}]`);
  }
  symlinkSync(join(root, 'nowhere'), join(root, 'broken'));
  if (expandGlob('*', root).includes('broken') || expandGlob('broken', root).length !== 0) {
    fail('a broken symlink must match nothing');
  }

  // Windows drive-letter patterns (the issue's path-handling P2): `C:/...` is
  // absolute there. The platform is faked and the fixture anchored at the
  // process cwd — the one place a `C:/`-rooted walk can land on a POSIX host —
  // which still proves the drive anchors the search and shapes the emitted
  // names. Native backslashed patterns are deliberately out of scope: `\` is
  // the escape syntax on every platform.
  {
    const realPlatform = process.platform;
    const realCwd = process.cwd();
    const drive = mkdtempSync(join(tmpdir(), 'glm-globs-drive-verify-'));
    mkdirSync(join(drive, 'C:', 'repo', 'src'), { recursive: true });
    writeFileSync(join(drive, 'C:', 'repo', 'src', 'a.ts'), 'W');
    process.chdir(drive);
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      for (const cwd of ['Z:\\elsewhere', join(drive, 'unrelated')]) {
        const got = expandGlob('C:/repo/src/*.ts', cwd);
        if (JSON.stringify(got) !== JSON.stringify(['C:/repo/src/a.ts'])) {
          fail(`a drive-letter pattern must anchor at its drive, not cwd=${cwd}: [${got.join(', ')}]`);
        }
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform });
      process.chdir(realCwd);
      rmSync(drive, { recursive: true, force: true });
    }
  }

  if (hadEnv) process.env.GLM_MCP_GLOB_IGNORE = savedEnv;
  else delete process.env.GLM_MCP_GLOB_IGNORE;
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('GLOBS OK');

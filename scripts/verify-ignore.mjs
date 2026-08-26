// verify-ignore.mjs — acceptance gate for glob ignore-directory handling (#2):
// wildcards never enter ignored directories, an explicit segment still names
// one, and GLM_MCP_GLOB_IGNORE replaces the default set. Most checks run
// against a throwaway fixture tree so every default directory is exercised,
// not just the ones this repository happens to contain.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandGlob } from '../dist/glob.js';

const fail = (msg) => { throw new Error(msg); };
const sorted = (a) => [...a].sort();

// This repository: wildcards stay out of ignored directories, own source still
// matches, and an explicit node_modules pattern returns only what it names.
const repoTs = expandGlob('**/*.ts', process.cwd());
if (repoTs.some((f) => f.startsWith('node_modules/'))) fail('node_modules leaked into **');
if (!repoTs.includes('src/glob.ts')) fail('own source went missing');
const sdk = expandGlob('node_modules/@anthropic-ai/sdk/*.d.ts', process.cwd());
if (sdk.length === 0) fail('explicit node_modules pattern must still match');
if (!sdk.every((f) => f.startsWith('node_modules/@anthropic-ai/sdk/'))) {
  fail(`explicit pattern returned entries it cannot match: ${sdk.join(', ')}`);
}

// Fixture tree: one file in every default-ignored directory plus decoys.
const IGNORED = [
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo', 'vendor', 'target',
];
const VISIBLE = IGNORED.filter((n) => !n.startsWith('.'));
const root = mkdtempSync(join(tmpdir(), 'glm-glob-verify-'));
const put = (dir, name) => {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, name), 'x');
};
try {
  const hadEnv = 'GLM_MCP_GLOB_IGNORE' in process.env;
  const savedEnv = process.env.GLM_MCP_GLOB_IGNORE;
  delete process.env.GLM_MCP_GLOB_IGNORE;

  for (const name of IGNORED) put(name, 'a.ts');
  put('.git', 'HEAD'); // a non-.ts file, so only `**/*`-shaped patterns can reach it
  put('src', 'a.ts');
  put('src/node_modules', 'b.ts');
  put('node_modules/body-parser/node_modules/content-type/dist', 'index.d.ts');
  put('node_modules/sdk', 'a.ts');
  put('src/body-parser/node_modules/content-type/dist', 'index.d.ts');

  const globTs = sorted(VISIBLE.map((n) => `${n}/a.ts`));
  const eq = (pattern, expected, what) => {
    const got = expandGlob(pattern, root);
    if (JSON.stringify(got) !== JSON.stringify(sorted(expected))) {
      fail(`${what}: ${pattern} returned [${got.join(', ')}], expected [${expected.join(', ')}]`);
    }
  };

  eq('**/*.ts', ['src/a.ts'], 'wildcard must skip every default-ignored directory');
  for (const name of IGNORED) {
    eq(`${name}/a.ts`, [`${name}/a.ts`], `explicit pattern must enter ${name}`);
  }
  eq('src/**/a.ts', ['src/a.ts'], 'wildcard must skip nested ignored directories too');
  eq('src/node_modules/b.ts', ['src/node_modules/b.ts'], 'explicit nested pattern must match');
  eq(
    '*/body-parser/node_modules/content-type/dist/*.d.ts',
    ['src/body-parser/node_modules/content-type/dist/index.d.ts'],
    'a later literal segment must not unlock a wildcard earlier in the pattern',
  );
  eq('\\.git/**/*', ['.git/HEAD', '.git/a.ts'], 'an escaped segment still names its directory');
  eq(
    'node\\_modules/*/a.ts',
    ['node_modules/sdk/a.ts'],
    'an escaped directory name still receives the explicit bypass',
  );

  process.env.GLM_MCP_GLOB_IGNORE = 'dist,coverage';
  let replaced = expandGlob('**/*.ts', root);
  if (!replaced.includes('node_modules/a.ts')) fail('GLM_MCP_GLOB_IGNORE must replace, not extend, the defaults');
  if (!replaced.includes('build/a.ts')) fail('names absent from GLM_MCP_GLOB_IGNORE must not be ignored');
  if (replaced.includes('dist/a.ts') || replaced.includes('coverage/a.ts')) {
    fail('GLM_MCP_GLOB_IGNORE entries must be ignored');
  }

  process.env.GLM_MCP_GLOB_IGNORE = ' dist ';
  if (expandGlob('**/*.ts', root).includes('dist/a.ts')) fail('GLM_MCP_GLOB_IGNORE entries must be trimmed');

  process.env.GLM_MCP_GLOB_IGNORE = '';
  eq('**/*.ts', [
    ...globTs,
    'node_modules/body-parser/node_modules/content-type/dist/index.d.ts',
    'node_modules/sdk/a.ts',
    'src/a.ts',
    'src/body-parser/node_modules/content-type/dist/index.d.ts',
    'src/node_modules/b.ts',
  ], 'an empty GLM_MCP_GLOB_IGNORE must disable skipping entirely');

  if (hadEnv) process.env.GLM_MCP_GLOB_IGNORE = savedEnv;
  else delete process.env.GLM_MCP_GLOB_IGNORE;
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('IGNORE OK');

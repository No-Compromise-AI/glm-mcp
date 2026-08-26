// Path confinement (issues #13, #14): the operator-set boundary, the cwd
// refusal, the credential denylist, and the GLM_MCP_ALLOW_ANY_PATH escape
// hatch — exercised against real files, real symlinks and a real fake $HOME.
// GLM_MCP_ROOTS is pinned per test the way an operator pins it at startup;
// refusal notes are asserted to carry the caller's own spelling so the caller
// can tell which of its arguments was dropped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFileContext } from '../dist/glm.js';
import { expandGlob, patternAnchor } from '../dist/glob.js';

// mkdtemp lands under a symlinked prefix on macOS (/var -> /private/var), so
// RAW is the spelling an operator would paste into GLM_MCP_ROOTS and ROOT is
// what it resolves to. Roots that were compared unresolved would refuse
// everything; using both spellings is what catches that.
const RAW = mkdtempSync(join(tmpdir(), 'glm-confine-test-'));
const ROOT = realpathSync.native(RAW);
const at = (...p) => join(ROOT, ...p);
const put = (rel, body) => {
  mkdirSync(join(ROOT, rel, '..'), { recursive: true });
  writeFileSync(at(rel), body);
};
const dir = (rel) => mkdirSync(at(rel), { recursive: true });

const A = at('rootA');
const B = at('rootB');
const HOME = at('home');

// Pin the operator's side of the boundary for one test and restore it after.
const pin = (t, { roots, home, allowAny } = {}) => {
  const saved = {
    roots: process.env.GLM_MCP_ROOTS,
    any: process.env.GLM_MCP_ALLOW_ANY_PATH,
    home: process.env.HOME,
    profile: process.env.USERPROFILE,
  };
  if (roots === undefined) delete process.env.GLM_MCP_ROOTS;
  else process.env.GLM_MCP_ROOTS = roots;
  delete process.env.GLM_MCP_ALLOW_ANY_PATH;
  if (allowAny) process.env.GLM_MCP_ALLOW_ANY_PATH = '1';
  if (home !== undefined) {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
};

before(() => {
  delete process.env.GLM_MCP_ROOTS;
  delete process.env.GLM_MCP_ALLOW_ANY_PATH;

  dir('rootA/src');
  dir('rootB');
  dir('rootC');
  dir('rootA-evil');
  dir('outside/secretdir');
  dir('home/.config/zai');
  dir('home/.zcode/v2');

  put('rootA/a.txt', 'AAA-IN-ROOT-A');
  put('rootA/inner.md', 'INNER-MARKDOWN');
  put('rootA/src/one.ts', 'ONE-TS');
  put('rootB/b.txt', 'BBB-IN-ROOT-B');
  put('rootC/c.txt', 'CCC-IN-ROOT-C');
  put('rootA-evil/e.txt', 'EVIL-SIBLING-PREFIX');
  put('outside/secret.env', 'TOPSECRET=hunter2');
  put('outside/secret.md', 'PRIVATE_KEY_MATERIAL=leaked');
  put('outside/secretdir/leak.txt', 'DEEP_SECRET=exfiltrated');

  put('home/.config/zai/api-key', 'SECRET-ZAI-KEY-VALUE');
  put('home/.config/zai/other-file', 'ORDINARY-NEIGHBOUR-A');
  put('home/.zcode/v2/config.json', '{"apiKey":"SECRET-ZCODE-KEY"}');
  put('home/.zcode/v2/other.json', '{"ordinary":"NEIGHBOUR-B"}');

  symlinkSync(at('outside/secret.md'), at('rootA/notes.md')); // file link, wildcard-matched
  symlinkSync(at('outside/secretdir'), at('rootA/docs'));    // dir link, named literally
  symlinkSync(at('rootA/a.txt'), at('rootA/alias.txt'));     // in-root link: still fine
  symlinkSync(at('home/.config/zai/api-key'), at('home/link-to-key'));
  symlinkSync(at('rootA'), at('linkroot'));                   // a root spelled through a link
});

after(() => rmSync(ROOT, { recursive: true, force: true }));

const refusedNote = (ctx, ...spellings) =>
  ctx.notes.some((n) => /refused/i.test(n) && spellings.some((s) => n.includes(s)));

// ---------------------------------------------------------------- decision 1

test('an in-root read is unchanged by confinement', (t) => {
  pin(t, { roots: `${RAW}/rootA` });
  const ctx = buildFileContext(['a.txt'], A);
  assert.ok(ctx.text.includes('AAA-IN-ROOT-A'));
  assert.equal(ctx.refusedCall, false);
  assert.deepEqual(ctx.notes, []);
});

test('the caller may narrow within a root, and an in-root symlink alias still dedupes', (t) => {
  pin(t, { roots: A });
  assert.ok(buildFileContext(['one.ts'], at('rootA/src')).text.includes('ONE-TS'));
  const ctx = buildFileContext(['a.txt', 'alias.txt'], A);
  assert.equal(ctx.text.split('AAA-IN-ROOT-A').length - 1, 1);
});

test('an in-root glob still expands under confinement', (t) => {
  pin(t, { roots: A });
  const ctx = buildFileContext(['src/**/*.ts'], A);
  assert.ok(ctx.text.includes('ONE-TS'));
  assert.deepEqual(ctx.notes, []);
});

test('a ../ escape is refused, and does not take the good entries down with it', (t) => {
  pin(t, { roots: A });
  const ctx = buildFileContext(['a.txt', '../outside/secret.env', 'inner.md'], A);
  assert.ok(!ctx.text.includes('TOPSECRET'), `content leaked: ${ctx.text}`);
  assert.ok(refusedNote(ctx, '../outside/secret.env'), JSON.stringify(ctx.notes));
  assert.ok(ctx.text.includes('AAA-IN-ROOT-A'));
  assert.ok(ctx.text.includes('INNER-MARKDOWN'));
  assert.equal(ctx.refusedCall, false);
});

test('an absolute path outside the roots is refused', (t) => {
  pin(t, { roots: A });
  const ctx = buildFileContext([at('outside/secret.env')], A);
  assert.ok(!ctx.text.includes('TOPSECRET'));
  assert.ok(refusedNote(ctx, at('outside/secret.env')), JSON.stringify(ctx.notes));
});

test('a directory sharing the root’s textual prefix is outside it', (t) => {
  pin(t, { roots: A });
  const ctx = buildFileContext([at('rootA-evil/e.txt')], A);
  assert.ok(!ctx.text.includes('EVIL-SIBLING-PREFIX'));
  assert.ok(refusedNote(ctx, 'rootA-evil'), JSON.stringify(ctx.notes));
});

test('several roots: each named root reads, an unnamed sibling does not', (t) => {
  pin(t, { roots: `${A}:${B}` });
  const ctx = buildFileContext(['a.txt', join(B, 'b.txt'), at('rootC/c.txt')], A);
  assert.ok(ctx.text.includes('AAA-IN-ROOT-A'));
  assert.ok(ctx.text.includes('BBB-IN-ROOT-B'));
  assert.ok(!ctx.text.includes('CCC-IN-ROOT-C'));
  assert.ok(refusedNote(ctx, 'rootC'), JSON.stringify(ctx.notes));
});

test('a root is resolved before comparison: through a symlink, with a trailing slash', (t) => {
  pin(t, { roots: at('linkroot') });
  assert.ok(buildFileContext(['a.txt'], A).text.includes('AAA-IN-ROOT-A'));
  pin(t, { roots: `${A}/` });
  assert.ok(buildFileContext(['a.txt'], A).text.includes('AAA-IN-ROOT-A'));
});

test('with GLM_MCP_ROOTS unset the call cwd is the boundary', (t) => {
  pin(t); // no roots: confine to the cwd the call resolves against
  const inside = buildFileContext(['a.txt', 'src/one.ts'], A);
  assert.ok(inside.text.includes('AAA-IN-ROOT-A'));
  assert.deepEqual(inside.notes, []);
  const outside = buildFileContext(['../outside/secret.env'], A);
  assert.ok(!outside.text.includes('TOPSECRET'));
  assert.ok(refusedNote(outside, '../outside/secret.env'), JSON.stringify(outside.notes));
});

test('a cwd outside every root refuses the call outright', (t) => {
  pin(t, { roots: A });
  const ctx = buildFileContext(['a.txt'], at('outside'));
  assert.equal(ctx.refusedCall, true);
  assert.equal(ctx.text, '');
  assert.ok(!ctx.text.includes('AAA-IN-ROOT-A'), 'the cwd must not be narrowed to a root');
  assert.ok(refusedNote(ctx, at('outside'), 'cwd'), JSON.stringify(ctx.notes));
});

// ---------------------------------------------------------------- decision 3

// Rooted at '/', nothing can be refused for being out of root: any refusal
// below is the credential rule and only the credential rule.
const anywhere = (t) => pin(t, { roots: '/', home: HOME });

test('the zai key file is refused even inside a root', (t) => {
  anywhere(t);
  const ctx = buildFileContext(['.config/zai/api-key'], HOME);
  assert.ok(!ctx.text.includes('SECRET-ZAI-KEY-VALUE'));
  assert.ok(refusedNote(ctx, '.config/zai/api-key'), JSON.stringify(ctx.notes));
});

test('the zcode config file is refused even inside a root', (t) => {
  anywhere(t);
  const ctx = buildFileContext(['.zcode/v2/config.json'], HOME);
  assert.ok(!ctx.text.includes('SECRET-ZCODE-KEY'));
  assert.ok(refusedNote(ctx, '.zcode/v2/config.json'), JSON.stringify(ctx.notes));
});

test('/proc/self/environ is refused, not reported missing, where it does not exist', (t) => {
  anywhere(t);
  const ctx = buildFileContext(['/proc/self/environ'], HOME);
  assert.ok(refusedNote(ctx, '/proc/self/environ'), JSON.stringify(ctx.notes));
});

test('only the three credential files are refused, not their neighbours', (t) => {
  anywhere(t);
  const ctx = buildFileContext(['.config/zai/other-file', '.zcode/v2/other.json'], HOME);
  assert.ok(ctx.text.includes('ORDINARY-NEIGHBOUR-A'));
  assert.ok(ctx.text.includes('NEIGHBOUR-B'));
  assert.deepEqual(ctx.notes, []);
});

test('the credential rule compares resolved real paths, not spellings', (t) => {
  anywhere(t);
  for (const p of ['link-to-key', '.config/zai/../zai/api-key']) {
    const ctx = buildFileContext([p], HOME);
    assert.ok(!ctx.text.includes('SECRET-ZAI-KEY-VALUE'), p);
    assert.ok(refusedNote(ctx, p), JSON.stringify(ctx.notes));
  }
});

// ---------------------------------------------------------------- decision 4

test('GLM_MCP_ALLOW_ANY_PATH=1 restores unconfined reads and walks', (t) => {
  pin(t, { roots: A, allowAny: true });
  assert.ok(buildFileContext(['../outside/secret.env'], A).text.includes('TOPSECRET'));
  assert.ok(buildFileContext([at('outside/secret.env')], A).text.includes('TOPSECRET'));
  assert.ok(buildFileContext(['**/*.md'], A).text.includes('PRIVATE_KEY_MATERIAL'));
  const out = buildFileContext(['secret.env'], at('outside'));
  assert.equal(out.refusedCall, false);
  assert.ok(out.text.includes('TOPSECRET'));
});

test('GLM_MCP_ALLOW_ANY_PATH=1 does not re-open the server’s own credentials', (t) => {
  pin(t, { roots: A, home: HOME, allowAny: true });
  const ctx = buildFileContext(['.config/zai/api-key'], HOME);
  assert.ok(!ctx.text.includes('SECRET-ZAI-KEY-VALUE'));
  assert.ok(refusedNote(ctx, '.config/zai/api-key'), JSON.stringify(ctx.notes));
});

// ------------------------------------------------------- the walk, not the read

test('a file symlink matched by a wildcard is refused at read time, its neighbour survives', (t) => {
  pin(t, { roots: A });
  const ctx = buildFileContext(['**/*.md'], A);
  assert.ok(!ctx.text.includes('PRIVATE_KEY_MATERIAL'));
  assert.ok(refusedNote(ctx, 'notes.md', '**/*.md'), JSON.stringify(ctx.notes));
  assert.ok(ctx.text.includes('INNER-MARKDOWN'));
});

test('a pattern anchored at an escaping directory symlink is refused before it walks', (t) => {
  pin(t, { roots: A });
  const ctx = buildFileContext(['docs/**/*.txt'], A);
  assert.ok(!ctx.text.includes('DEEP_SECRET'));
  assert.ok(refusedNote(ctx, 'docs'), JSON.stringify(ctx.notes));
});

test('expandGlob with roots never walks a base outside them', (t) => {
  // An absolute pattern must not traverse the volume before being refused;
  // patternAnchor names where the walk would start so callers can refuse first.
  assert.equal(patternAnchor('/**/*.md', A), '/');
  assert.deepEqual(expandGlob('/**/*.md', A, [A]), []);
  assert.equal(patternAnchor('../outside/**/*.txt', A), at('outside'));
  assert.deepEqual(expandGlob('../outside/**/*.txt', A, [A]), []);
});

test('expandGlob without roots stays unconfined', () => {
  // The two-argument form predates confinement and must keep today's shape:
  // a climb out of the cwd still expands to real matches.
  assert.deepEqual(expandGlob('../outside/*.md', A), ['../outside/secret.md']);
  assert.deepEqual(expandGlob('../*/secret.md', A), ['../outside/secret.md']);
});

test('expandGlob does not descend into a directory whose realpath leaves the roots', (t) => {
  pin(t, { roots: A });
  // `docs` is met mid-walk (after the `*` segment), so only walk containment
  // can stop it; the leading-literal anchor cannot see this one.
  assert.deepEqual(expandGlob('*/docs/*.txt', A, [A]), []);
  // The same shape one level deeper, through a real directory.
  const ctx = buildFileContext(['*/docs/*.txt'], A);
  assert.ok(!ctx.text.includes('DEEP_SECRET'));
});

test('an in-root symlinked directory is still descended when a segment names it', (t) => {
  // Containment is additional to the #3 rules, not a replacement for them.
  symlinkSync(at('rootA/src'), at('rootA/srclink'), 'dir');
  t.after(() => rmSync(at('rootA/srclink')));
  pin(t, { roots: A });
  assert.deepEqual(expandGlob('srclink/*.ts', A, [A]), ['srclink/one.ts']);
});

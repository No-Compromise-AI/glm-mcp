// Path confinement (issues #13, #14): the operator-set boundary, the cwd
// refusal, the credential denylist, and the GLM_MCP_ALLOW_ANY_PATH escape
// hatch — exercised against real files, real symlinks and a real fake $HOME.
// GLM_MCP_ROOTS is pinned per test the way an operator pins it at startup;
// refusal notes are asserted to carry the caller's own spelling so the caller
// can tell which of its arguments was dropped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildFileContext } from '../dist/glm.js';
import { expandGlob, patternAnchor, patternAnchors } from '../dist/glob.js';
import { insideRoots, splitRoots } from '../dist/confine.js';

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

// A path spelled the way a pattern must be: `/` separators throughout. The
// globber reads a backslash as an escape on every platform, never a separator,
// so a pattern interpolated from a native `join()` path would stop being the
// absolute pattern it is meant to be on Windows — and the paths the expander
// emits and reports refusals by are `/`-separated everywhere regardless.
const slashed = (p) => p.split(sep).join('/');

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
  dir('rootA/teams/team1');
  dir('rootA/teams/team2');
  dir('rootB');
  dir('rootC');
  dir('rootA-evil');
  dir('outside/secretdir');
  dir('home/.config/zai');
  dir('home/.zcode/v2');

  put('rootA/a.txt', 'AAA-IN-ROOT-A');
  put('rootA/inner.md', 'INNER-MARKDOWN');
  put('rootA/src/one.ts', 'ONE-TS');
  // The honest match that must survive beside the rootA/docs symlink, and the
  // two brace-spelled files: one inside the root (a literal before it is ever
  // a pattern), one outside it (containment must survive the same literal
  // reading). #3 settled that a path existing on disk is read literally even
  // when its name contains metacharacters.
  put('rootA/sub/docs/fine.txt', 'HONEST-DOCS');
  put('rootA/{..,safe}', 'LITERAL-BRACE-BODY');
  put('outside/{..,secret}.env', 'BRACED-OUTSIDE-SECRET');
  put('rootB/b.txt', 'BBB-IN-ROOT-B');
  put('rootC/c.txt', 'CCC-IN-ROOT-C');
  put('rootA-evil/e.txt', 'EVIL-SIBLING-PREFIX');
  // A directory tree a `C:/…`-spelled root can be anchored at: on Windows that
  // is a drive, off Windows a directory literally named `C:`. Off Windows the
  // spelling is relative, so the test that uses it chdirs into the fixture.
  put('C:/repo/drive.txt', 'DRIVE-LOOKING-ROOT-BODY');
  put('outside/secret.env', 'TOPSECRET=hunter2');
  put('outside/secret.md', 'PRIVATE_KEY_MATERIAL=leaked');
  put('outside/secretdir/leak.txt', 'DEEP_SECRET=exfiltrated');

  put('home/.config/zai/api-key', 'SECRET-ZAI-KEY-VALUE');
  put('home/.config/zai/other-file', 'ORDINARY-NEIGHBOUR-A');
  put('home/.zcode/v2/config.json', '{"apiKey":"SECRET-ZCODE-KEY"}');
  put('home/.zcode/v2/other.json', '{"ordinary":"NEIGHBOUR-B"}');

  symlinkSync(at('outside/secret.md'), at('rootA/notes.md')); // file link, wildcard-matched
  symlinkSync(at('outside/secretdir'), at('rootA/docs'));    // dir link, named literally
  // Two distinct links in the tree to one directory outside it: the caller
  // has two problems to fix, not one, so a refusal report that de-duplicated
  // by where a link points would hide the second. (Same fixture as the gate.)
  symlinkSync(at('outside/secretdir'), at('rootA/teams/team1/docs'));
  symlinkSync(at('outside/secretdir'), at('rootA/teams/team2/docs'));
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

test('a real file whose name contains braces is read literally, not anchored by its branches', (t) => {
  pin(t, { roots: A });
  // `{..,safe}` exists on disk, so it is a literal before it is a pattern: the
  // synthetic `..` branch of a pattern reading must not be allowed to anchor a
  // file that is sitting inside the root all along.
  const ctx = buildFileContext(['{..,safe}'], A);
  assert.ok(ctx.text.includes('LITERAL-BRACE-BODY'), JSON.stringify(ctx.notes));
  assert.deepEqual(ctx.notes, []);
  assert.equal(ctx.refusedCall, false);
});

test('a literal path outside the roots is still refused, by its own realpath', (t) => {
  pin(t, { roots: A });
  // The same brace-literal shape, but the file really is outside the root:
  // judging the literal branch by the file's own resolved identity — rather
  // than by any anchor — must not weaken containment one direction while it
  // fixes it in the other.
  const ctx = buildFileContext(['../outside/{..,secret}.env'], A);
  assert.ok(!ctx.text.includes('BRACED-OUTSIDE-SECRET'), JSON.stringify(ctx.text));
  assert.ok(refusedNote(ctx, '../outside/{..,secret}.env'), JSON.stringify(ctx.notes));
  assert.equal(ctx.refusedCall, false);
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

// A colon that carries a drive prefix (`C:/repo`, `C:\repo`) is the only way to
// spell a root on Windows, and the globber already treats `C:/…` patterns as
// absolute there — so it must survive the colon that separates roots. Off
// Windows the same spelling is a directory named `C:`, and it must survive too.
test('GLM_MCP_ROOTS splits on colons but keeps drive prefixes whole', () => {
  assert.deepEqual(splitRoots('C:/repo'), ['C:/repo']);
  assert.deepEqual(splitRoots('C:\\repo'), ['C:\\repo']);
  assert.deepEqual(splitRoots('C:'), ['C:']);
  assert.deepEqual(splitRoots('C:/a:C:/b'), ['C:/a', 'C:/b']);
  // Every colon that is not a drive prefix still separates, as before —
  // including a root whose final segment is a single letter, the POSIX shape
  // (/mnt/c, /mnt/d) that looks most like a drive and must not merge.
  assert.deepEqual(splitRoots('/srv/a:/srv/b'), ['/srv/a', '/srv/b']);
  assert.deepEqual(splitRoots('/mnt/c:/mnt/d'), ['/mnt/c', '/mnt/d']);
  assert.deepEqual(splitRoots(`${A}:${B}`), [A, B]);
  assert.deepEqual(splitRoots(' /srv/a : /srv/b '), ['/srv/a', '/srv/b']);
  assert.deepEqual(splitRoots('/srv/a:C'), ['/srv/a', 'C']); // a lone root still ends there
  assert.deepEqual(splitRoots(''), []);
  assert.deepEqual(splitRoots('::'), []);
});

test('a drive-letter root is one root, not two', (t) => {
  // `C:/repo` is how a Windows operator must spell a root. Off Windows the same
  // spelling is relative, so the process stands in the fixture to resolve it —
  // the same trick glob.test.mjs uses for its drive patterns.
  if (process.platform === 'win32') {
    t.skip('covered by splitRoots here: C:/ would name the real drive');
    return;
  }
  const realCwd = process.cwd();
  process.chdir(ROOT);
  t.after(() => process.chdir(realCwd));
  pin(t, { roots: 'C:/repo' });
  const ctx = buildFileContext(['drive.txt'], at('C:/repo'));
  assert.ok(ctx.text.includes('DRIVE-LOOKING-ROOT-BODY'), JSON.stringify(ctx.notes));
  assert.deepEqual(ctx.notes, []);
});

// The default boundary is read from the process's own working directory when
// the module loads — the only honest way to test it is a child process started
// in the directory that should be the root, since env and cwd have to be set
// before the module loads to be tested at all (the acceptance gate does the
// same). The child runs both calls so the two share one startup cwd.
const CHILD = `
import { buildFileContext } from ${JSON.stringify(pathToFileURL(new URL('../dist/glm.js', import.meta.url).pathname).href)};
const one = (paths, cwd) => {
  const r = buildFileContext(paths, cwd);
  return { leaked: r.text.includes('TOPSECRET=hunter2'), notes: r.notes, refusedCall: r.refusedCall === true };
};
process.stdout.write(JSON.stringify({
  standing: one(['a.txt'], process.argv[1]),
  elsewhere: one(['secret.env'], process.argv[2]),
}));
`;

test('with GLM_MCP_ROOTS unset the boundary is the startup cwd, not the caller’s cwd', (t) => {
  pin(t); // no roots, no escape hatch: the default boundary
  const out = JSON.parse(execFileSync(
    process.execPath,
    ['--input-type=module', '-e', CHILD, A, at('outside')],
    { cwd: A, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ));
  // Standing where the process started: readable, no notes.
  assert.equal(out.standing.refusedCall, false, JSON.stringify(out.standing));
  assert.equal(out.standing.notes.length, 0, JSON.stringify(out.standing));
  // Naming /etc (or any directory) as `cwd` must not move the boundary there:
  // the call is refused outright rather than answered from the caller's ground.
  assert.equal(out.elsewhere.refusedCall, true, JSON.stringify(out.elsewhere));
  assert.equal(out.elsewhere.leaked, false, JSON.stringify(out.elsewhere));
  assert.ok(refusedNote(out.elsewhere, at('outside'), 'cwd'), JSON.stringify(out.elsewhere.notes));
});

test('a caller-chosen cwd cannot widen the default boundary in-process either', (t) => {
  pin(t); // no roots: the boundary is this process's own startup cwd
  // Skipped only where the fixture happens to live inside the process's own
  // working directory (TMPDIR inside the checkout); there the call is legal.
  const own = realpathSync.native(process.cwd());
  if (insideRoots(realpathSync.native(at('outside')), [own])) {
    t.skip('fixture is inside the process cwd');
    return;
  }
  const ctx = buildFileContext(['secret.env'], at('outside'));
  assert.equal(ctx.refusedCall, true);
  assert.equal(ctx.text, '');
  assert.ok(!ctx.text.includes('TOPSECRET'));
  assert.ok(refusedNote(ctx, at('outside'), 'cwd'), JSON.stringify(ctx.notes));
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

// Braces are expanded before the anchor is judged: the anchor of `{a,b}` as
// written is the anchor of neither branch, so a branch that escapes would
// otherwise be dropped inside expandGlob with no note at all — the silent
// narrowing decision 1 exists to prevent.
test('a brace branch that escapes the roots is refused, not silently dropped', (t) => {
  pin(t, { roots: A });
  // One branch in root, one out: the entry is refused and says so, rather than
  // reading the in-root branch and reporting nothing about the other.
  const mixed = buildFileContext(['{a.txt,../outside/secret.env}'], A);
  assert.ok(!mixed.text.includes('TOPSECRET'), JSON.stringify(mixed.notes));
  assert.ok(!mixed.text.includes('AAA-IN-ROOT-A'), 'the whole entry is refused, not half-read');
  assert.ok(refusedNote(mixed, '{a.txt,../outside/secret.env}'), JSON.stringify(mixed.notes));
  assert.equal(mixed.refusedCall, false);

  // A single-member brace whose branch escapes must be called a refusal, not
  // "skipped (no matches)" — a refusal that depends on how many branches the
  // pattern happened to have is not a reportable boundary.
  const alone = buildFileContext(['{../outside/secret.env}'], A);
  assert.ok(!alone.text.includes('TOPSECRET'));
  assert.ok(refusedNote(alone, '{../outside/secret.env}'), JSON.stringify(alone.notes));
  assert.ok(!alone.notes.some((n) => n.includes('skipped (no matches)')), JSON.stringify(alone.notes));

  // An absolute branch, the form a caller is most likely to reach for.
  const absolute = buildFileContext([`{src/one.ts,${at('outside/secret.env')}}`], A);
  assert.ok(!absolute.text.includes('TOPSECRET'));
  assert.ok(refusedNote(absolute, 'outside/secret.env'), JSON.stringify(absolute.notes));
});

test('a brace pattern whose branches all stay in root still expands', (t) => {
  pin(t, { roots: A });
  const ctx = buildFileContext(['{a.txt,src/*.ts}'], A);
  assert.ok(ctx.text.includes('AAA-IN-ROOT-A'), JSON.stringify(ctx.notes));
  assert.ok(ctx.text.includes('ONE-TS'), JSON.stringify(ctx.notes));
  assert.deepEqual(ctx.notes, []);
});

test('patternAnchors names where each brace branch’s walk would start', () => {
  assert.deepEqual(patternAnchors('{src/*.ts,inner.md}', A), [join(A, 'src'), join(A, 'inner.md')]);
  assert.deepEqual(patternAnchors(`{src/*.ts,${at('outside')}/**}`, A), [join(A, 'src'), at('outside')]);
  // No braces, no change: the single anchor the walk would use.
  assert.deepEqual(patternAnchors('src/**/*.ts', A), [patternAnchor('src/**/*.ts', A)]);
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
  // `**` may swallow zero segments, so the literal `docs` segment meets the
  // hostile symlink mid-walk, where the leading-literal anchor cannot see it.
  // (The old `*/docs/*.txt` shape never reached it — a wildcard segment never
  // follows a symlinked directory — and passed whatever the walker did.)
  assert.deepEqual(expandGlob('**/docs/*.txt', A, [A]), ['sub/docs/fine.txt']);
  const refused = [];
  expandGlob('**/docs/*.txt', A, [A], (r) => refused.push(r));
  // Every escaping link in range says so — the rootA/docs one and the two
  // team ones — each once.
  assert.deepEqual(
    [...refused].sort(),
    ['docs', 'teams/team1/docs', 'teams/team2/docs'],
    JSON.stringify(refused),
  );
  // And through buildFileContext the pruned directory is a refusal note like
  // any other: partial context must not read as complete when the thing being
  // hidden is a hostile symlink.
  const ctx = buildFileContext(['**/docs/*.txt'], A);
  assert.ok(!ctx.text.includes('DEEP_SECRET'), JSON.stringify(ctx.notes));
  assert.ok(ctx.text.includes('HONEST-DOCS'), JSON.stringify(ctx.notes));
  assert.ok(refusedNote(ctx, 'docs', '**/docs/*.txt'), JSON.stringify(ctx.notes));
  assert.equal(ctx.refusedCall, false);
  // One reported path refused once: each brace branch below meets the same
  // three escaping links, and the caller does not need any of them said twice.
  const twice = buildFileContext(['{**,**}/docs/*.txt'], A);
  assert.deepEqual(
    twice.notes.filter((n) => n.startsWith('refused: ')).sort(),
    [
      'docs', 'teams/team1/docs', 'teams/team2/docs',
    ].map((x) => `refused: ${x} (matched by {**,**}/docs/*.txt) resolves outside the allowed roots`)
      .sort(),
    JSON.stringify(twice.notes),
  );
});

test('a pruned directory is refused once per reported path', (t) => {
  pin(t, { roots: A });
  // `{A/**,**}` reaches every escaping link in range twice: once through the
  // absolute branch, which reports it with the whole prefix attached, and
  // once through the relative branch, bare. Two spellings of one physical
  // link — but two REPORTED paths, and the reported path is what the caller
  // can act on. Keying the de-duplication on the directory's resolved
  // identity would collapse each pair (and two distinct links that merely
  // share a target into one), hiding problems the caller then cannot see.
  const mixed = `{${A}/**,**}/docs/*.txt`;
  const paths = [
    `${A}/docs`, 'docs',
    `${A}/teams/team1/docs`, 'teams/team1/docs',
    `${A}/teams/team2/docs`, 'teams/team2/docs',
  ];
  const refused = [];
  expandGlob(mixed, A, [A], (r) => refused.push(r));
  assert.deepEqual([...refused].sort(), [...paths].sort(), JSON.stringify(refused));

  // A cwd reached through the /var -> /private/var prefix link anchors the
  // relative branch at the same directories by another joined spelling; one
  // report per path still.
  const throughPrefix = [];
  expandGlob(mixed, join(RAW, 'rootA'), [A], (r) => throughPrefix.push(r));
  assert.deepEqual([...throughPrefix].sort(), [...paths].sort(), JSON.stringify(throughPrefix));

  // And through buildFileContext each reported path is a note, spelled the
  // way a match there would have been — not a collapsed pair that reads as
  // one hostile link where there are three.
  const ctx = buildFileContext([mixed], A);
  assert.ok(!ctx.text.includes('DEEP_SECRET'), JSON.stringify(ctx.notes));
  assert.ok(ctx.text.includes('HONEST-DOCS'), JSON.stringify(ctx.notes));
  assert.deepEqual(
    ctx.notes.filter((n) => n.startsWith('refused: ')).sort(),
    paths
      .map((x) => `refused: ${x} (matched by ${mixed}) resolves outside the allowed roots`)
      .sort(),
    JSON.stringify(ctx.notes),
  );
});

// --------------------------------------------- what the refusal reports say
// Reporting fidelity, decided: distinct links are distinct reports, refusals
// carry the spelling a match would, and a refused pattern is not also filed
// under "no matches". Each test below was confirmed failing against the build
// that exhibited the defect it names.

test('two distinct links to one outside directory are two refusals, not one', (t) => {
  pin(t, { roots: A });
  // teams/team1/docs and teams/team2/docs are different symlinks pointing at
  // one directory outside the root. De-duplicating by the resolved target
  // reports one and silently drops the other: the caller is told about one
  // link to fix and has two.
  const refused = [];
  expandGlob('teams/**/docs/*.txt', A, [A], (r) => refused.push(r));
  assert.deepEqual(
    [...refused].sort(),
    ['teams/team1/docs', 'teams/team2/docs'],
    JSON.stringify(refused),
  );
  // The notes name each link and the pattern that reached it — the content,
  // not just the count.
  const ctx = buildFileContext(['teams/**/docs/*.txt'], A);
  assert.ok(!ctx.text.includes('DEEP_SECRET'), JSON.stringify(ctx.notes));
  assert.deepEqual(
    ctx.notes.filter((n) => n.startsWith('refused: ')).sort(),
    [
      'refused: teams/team1/docs (matched by teams/**/docs/*.txt) resolves outside the allowed roots',
      'refused: teams/team2/docs (matched by teams/**/docs/*.txt) resolves outside the allowed roots',
    ],
    JSON.stringify(ctx.notes),
  );
});

test('a refusal carries the root an absolute pattern’s matches would', (t) => {
  pin(t, { roots: A });
  // Emitted matches are `root + rel`; a refusal spelled with bare `rel`
  // names a path that is not the caller's (`private/var/…` with no leading
  // `/`) and the note becomes unactionable. The absolute case is checked
  // here with a `/`-separated pattern and expectation — the only spelling
  // anchorOf honours on Windows, where a native `join()` path would carry
  // backslashes and stop being absolute at all; the drive (`C:/`) and UNC
  // (`//`) prefixes get the same treatment in their own tests below.
  const P = slashed(A);
  const pattern = `${P}/teams/**/docs/*.txt`;
  const refused = [];
  expandGlob(pattern, A, [A], (r) => refused.push(r));
  assert.deepEqual(
    [...refused].sort(),
    [slashed(join(A, 'teams/team1/docs')), slashed(join(A, 'teams/team2/docs'))].sort(),
    JSON.stringify(refused),
  );
  const ctx = buildFileContext([pattern], A);
  assert.ok(!ctx.text.includes('DEEP_SECRET'), JSON.stringify(ctx.notes));
  for (const p of [slashed(join(A, 'teams/team1/docs')), slashed(join(A, 'teams/team2/docs'))]) {
    assert.ok(
      ctx.notes.includes(
        `refused: ${p} (matched by ${pattern}) resolves outside the allowed roots`,
      ),
      `${p} missing from ${JSON.stringify(ctx.notes)}`,
    );
  }
});

// `C:/` and `//` are `root` values anchorOf produces on Windows only, so these
// two spellings are exercised the way glob.test.mjs exercises its drive
// patterns: the platform is faked and the fixture is anchored at the process
// cwd — the one place a `C:/`-rooted walk can land on a POSIX host. Both were
// confirmed failing against a build whose refusals carried bare `rel`.
test('a drive pattern’s refusal carries the `C:/` its matches would', (t) => {
  if (process.platform === 'win32') {
    t.skip('a directory literally named `C:` cannot exist beside the real drive');
    return;
  }
  // The fixture's escaping links under a directory literally named `C:` — the
  // Windows drive form of the same walk, with the same two links to fix.
  for (const team of ['team1', 'team2']) {
    dir(`C:/w/teams/${team}`);
    symlinkSync(at('outside/secretdir'), at(`C:/w/teams/${team}/docs`));
  }
  t.after(() => rmSync(at('C:/w'), { recursive: true, force: true }));
  // The root pinned the way a Windows operator spells it — splitRoots keeps a
  // leading `C:` whole — and resolved against the process cwd the fixture
  // stands in, exactly like the drive-letter root test above. (Pinning
  // at('C:/w') instead would be split at that colon: mid-path is not a drive.)
  pin(t, { roots: 'C:/w' });
  const realPlatform = process.platform;
  const realCwd = process.cwd();
  process.chdir(ROOT);
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    process.chdir(realCwd);
  });
  const pattern = 'C:/w/teams/**/docs/*.txt';
  const refused = [];
  expandGlob(pattern, at('C:/w'), [at('C:/w')], (r) => refused.push(r));
  assert.deepEqual(
    [...refused].sort(),
    ['C:/w/teams/team1/docs', 'C:/w/teams/team2/docs'],
    JSON.stringify(refused),
  );
  const ctx = buildFileContext([pattern], at('C:/w'));
  assert.ok(!ctx.text.includes('DEEP_SECRET'), JSON.stringify(ctx.notes));
  assert.deepEqual(
    ctx.notes.filter((n) => n.startsWith('refused: ')).sort(),
    ['C:/w/teams/team1/docs', 'C:/w/teams/team2/docs']
      .map((x) => `refused: ${x} (matched by ${pattern}) resolves outside the allowed roots`)
      .sort(),
    JSON.stringify(ctx.notes),
  );
});

test('a UNC pattern’s refusal carries the `//` its matches would', (t) => {
  if (process.platform === 'win32') {
    t.skip('`//` is UNC here and no POSIX fixture can stand in for its target');
    return;
  }
  pin(t, { roots: A });
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', { value: realPlatform }));
  // The fixture addressed through a `//` prefix: on Windows that is UNC; on a
  // POSIX host the filesystem reads it as the same tree while the reported
  // spelling keeps both slashes. The links are the fixture's own team ones.
  const pattern = `//${ROOT.slice(1)}/rootA/teams/**/docs/*.txt`;
  const refused = [];
  expandGlob(pattern, A, [A], (r) => refused.push(r));
  const paths = ['team1', 'team2']
    .map((team) => `//${ROOT.slice(1)}/rootA/teams/${team}/docs`);
  assert.deepEqual([...refused].sort(), [...paths].sort(), JSON.stringify(refused));
  const ctx = buildFileContext([pattern], A);
  assert.ok(!ctx.text.includes('DEEP_SECRET'), JSON.stringify(ctx.notes));
  assert.deepEqual(
    ctx.notes.filter((n) => n.startsWith('refused: ')).sort(),
    paths
      .map((x) => `refused: ${x} (matched by ${pattern}) resolves outside the allowed roots`)
      .sort(),
    JSON.stringify(ctx.notes),
  );
});

test('a pattern whose matches were refused is not also reported as matching nothing', (t) => {
  pin(t, { roots: A });
  // Every match this pattern could have had was stopped at the boundary:
  // "skipped (no matches)" beside those refusals reads as a pattern that was
  // simply wrong, and contradicts them.
  const ctx = buildFileContext(['teams/**/docs/*.txt'], A);
  assert.ok(ctx.notes.some((n) => n.startsWith('refused: teams/')), JSON.stringify(ctx.notes));
  assert.ok(!ctx.notes.some((n) => /no matches/i.test(n)), JSON.stringify(ctx.notes));
  assert.equal(ctx.refusedCall, false);
  // A pattern that matched nothing AND refused nothing still says so.
  const none = buildFileContext(['nowhere/**/x.txt'], A);
  assert.deepEqual(none.notes, ['skipped (no matches): nowhere/**/x.txt']);
});

test('an in-root symlinked directory is still descended when a segment names it', (t) => {
  // Containment is additional to the #3 rules, not a replacement for them.
  symlinkSync(at('rootA/src'), at('rootA/srclink'), 'dir');
  t.after(() => rmSync(at('rootA/srclink')));
  pin(t, { roots: A });
  assert.deepEqual(expandGlob('srclink/*.ts', A, [A]), ['srclink/one.ts']);
});

// The #18 regression suite: a glob segment's matching cost is bounded by the
// pattern's own length, never by how the subject name happens to be shaped.
//
// compileSegment() built one RegExp per segment, every `*` a `[^/]*` group,
// and a name that nearly matched made V8 try every distribution of its
// characters across those groups before giving up — synchronously, on the
// thread serving every other MCP call. Measured on the build this suite was
// written against, against one 40-character name: `*a`×5+`b` took 3.4s,
// `*a`×12+`b` took 50.8s. GLM_MCP_GLOB_TIMEOUT_MS cannot help, because a single
// RegExp.test() is never interrupted and the walk's clock is not consulted
// again until it returns. The bound has to come from the matcher itself.
//
// So the cost tests assert the property #18 names — a pathological pattern
// finishes inside a bound a linear matcher meets by three orders of magnitude —
// and the FILES it always matched, because fast and wrong would pass a timing
// test alone. Shapes that would hang a regressed build for minutes run in child
// processes the clock can kill; synchronous backtracking cannot be interrupted
// any other way. The in-process canary is the issue's own ×5 measurement.
//
// Below those sit the semantics #3 settled and this issue must not reopen, and
// the uncompilable character class that stays a note rather than a throw (the
// half of #28 that lives in the globber).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expandGlob } from '../dist/glob.js';
import { buildFileContext } from '../dist/glm.js';

// Generous by three orders of magnitude: the matcher this suite guards runs
// every pattern here in well under a millisecond, and the behaviour it exists
// to exclude was measured in seconds and tens of seconds.
const BUDGET_MS = 1_000;
const CHILD_TIMEOUT_MS = 10_000;

const GLOB = pathToFileURL(new URL('../dist/glob.js', import.meta.url).pathname).href;
const CHILD = `
import { expandGlob } from ${JSON.stringify(GLOB)};
const job = JSON.parse(process.argv[1]);
const started = process.hrtime.bigint();
const matches = expandGlob(job.pattern, job.cwd);
process.stdout.write(JSON.stringify({
  matches,
  ms: Number(process.hrtime.bigint() - started) / 1e6,
}));
`;

/** Expand `pattern` in a child the clock can kill, with the match list and its time. */
function expandTimed(pattern, cwd) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GLM_MCP_')) delete env[k];
  let out;
  try {
    out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', CHILD, JSON.stringify({ pattern, cwd })],
      { cwd, env, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    if (e.killed) {
      assert.fail(
        `${JSON.stringify(pattern.slice(0, 48))} did not finish within ${CHILD_TIMEOUT_MS}ms` +
          ' — the #18 backtracking blowup is still present',
      );
    }
    assert.fail(`expandGlob(${JSON.stringify(pattern.slice(0, 48))}…) threw\n${e.stderr || e.message}`);
  }
  return JSON.parse(out);
}

// Three fixtures: the semantics battery's names, the pathological subjects, and
// the uncompilable-class case. Keeping them apart is what lets `*` have an
// expectation short enough to read.
const NAMES = ['a.ts', 'b.ts', 'ab.ts', 'abc.ts', 'axb', 'a*b', 'a?b', 'a[b', '1.ts',
  '-.ts', '.hidden', '.h.ts', 'xaybz', 'aaa', 'a', 'ab', '[]x', '*'];

let sem;
let cost;
let canary;
let note;
let starve;

before(() => {
  delete process.env.GLM_MCP_GLOB_IGNORE;
  const put = (root, name, body = 'x') => writeFileSync(join(root, name), body);
  sem = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-redos-sem-')));
  for (const n of NAMES) put(sem, n);
  cost = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-redos-cost-')));
  // One long all-`a` name is the whole fixture: #18 needs no large tree, just
  // subjects the stars can be distributed across in exponentially many ways.
  // a×30+b is a genuine match for every pattern below — fast must not become
  // wrong — while a×40 and a×200, with no trailing b, are the near-misses.
  put(cost, 'a'.repeat(40));
  put(cost, 'a'.repeat(200));
  put(cost, 'a'.repeat(30) + 'b');
  put(cost, 'ab');
  // The in-thread canary gets its own, deliberately smaller fixture. It is the
  // one cost assertion with no child process between it and the matcher, so a
  // regression runs here uninterruptibly: against a×200 that is minutes and it
  // would WEDGE `npm test` rather than fail it, which is the opposite of what a
  // regression test is for. a×40 is the issue's own subject and cost 3.4s
  // regressed — over the budget, so the test fails, and bounded, so it fails.
  canary = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-redos-canary-')));
  put(canary, 'a'.repeat(40));
  put(canary, 'a'.repeat(30) + 'b');
  note = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-redos-note-')));
  put(note, 'ok.ts', 'OK-BODY');
  // The budget-starvation fixture: src/ holds the neighbour's 8 files, and six
  // sibling directories of 8 files each are what a walk for a never-matching
  // `**` pattern would read before giving up. An entries budget of 10 covers
  // src/ alone and nothing past it, so a single wasted directory read shows up
  // as the neighbour losing files.
  starve = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-redos-starve-')));
  mkdirSync(join(starve, 'src'), { recursive: true });
  for (let i = 0; i < 8; i++) put(starve, join('src', `f${i}.ts`), `SRC-${i}`);
  for (let d = 0; d < 6; d++) {
    mkdirSync(join(starve, `d${d}`), { recursive: true });
    for (let i = 0; i < 8; i++) put(starve, join(`d${d}`, `g${i}.ts`));
  }
});

after(() => {
  for (const root of [sem, cost, canary, note, starve]) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the cost

test('the issue’s own shape matches its file inside the bound', () => {
  for (const k of [5, 12, 30]) {
    const r = expandTimed('*a'.repeat(k) + 'b', cost);
    assert.ok(r.ms < BUDGET_MS,
      `*a×${k}+b took ${Math.round(r.ms)}ms — cost must be bounded by the pattern, not the subject`);
    assert.deepEqual(r.matches, ['a'.repeat(30) + 'b'], `*a×${k}+b`);
  }
});

test('the ×5 measurement runs in this thread inside the bound', () => {
  // The one cost assertion no child process stands between: the expansion runs
  // on the test's own thread, exactly as it runs on the thread serving MCP
  // calls. On the build this suite was written against it took 3.4 seconds.
  const started = process.hrtime.bigint();
  const matches = expandGlob('*a'.repeat(5) + 'b', canary);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < BUDGET_MS, `*a×5+b took ${Math.round(ms)}ms in this thread`);
  assert.deepEqual(matches, ['a'.repeat(30) + 'b']);
});

test('other shapes that backtrack for the same reason stay bounded', () => {
  // Alternating literals, wildcards beside single-character wildcards, classes
  // in place of literals: a fix aimed only at the `*a` shape fails here. None
  // of these matches anything — no name ends in the tail character — which is
  // precisely the failing near-match that made the RegExp sweat.
  for (const [label, pattern] of [
    ['*a*b×20+c', '*a*b'.repeat(20) + 'c'],
    ['*?×25+z', '*?'.repeat(25) + 'z'],
    ['*[a-z]×20+9', '*[a-z]'.repeat(20) + '9'],
    ['a*×30+zz', 'a*'.repeat(30) + 'zz'],
    ['?*×25+zz', '?*'.repeat(25) + 'zz'],
  ]) {
    const r = expandTimed(pattern, cost);
    assert.ok(r.ms < BUDGET_MS, `${label} took ${Math.round(r.ms)}ms — still superlinear`);
    assert.deepEqual(r.matches, [], label);
  }
});

// ------------------------------------------------------------- the semantics

test('ordinary patterns still match exactly what they matched', () => {
  const visible = NAMES.filter((n) => !n.startsWith('.')).sort();
  const cases = {
    '*': visible,
    '?': ['*', 'a'],
    '??': ['ab'],
    '??.ts': ['ab.ts'],
    'a?c': [],
    // `?` is exactly one character, never zero.
    'a?b': ['a*b', 'a?b', 'a[b', 'axb'],
    '[ab].ts': ['a.ts', 'b.ts'],
    // `[!...]` and `[^...]` negate alike.
    '[!ab].ts': ['-.ts', '1.ts'],
    '[^ab].ts': ['-.ts', '1.ts'],
    // Hidden entries match only when the pattern spells the dot out.
    '.hidden': ['.hidden'],
    '.*': ['.h.ts', '.hidden'],
    '*hidden': [],
    // A `\` escape makes `*` literal — and an escaped meta before a real one
    // exercises the escape inside the matcher, not only in the literal route.
    'a\\*b*': ['a*b'],
    '[]x': ['[]x'],
    'a[b': ['a[b'],
  };
  for (const [pattern, expected] of Object.entries(cases)) {
    assert.deepEqual(expandGlob(pattern, sem), expected, JSON.stringify(pattern));
  }
});

test('consecutive stars collapse inside a segment', () => {
  // `**` inside a segment means the same as `*`; only a whole `**` segment is
  // the recursive wildcard, and that is decided before segments compile.
  assert.deepEqual(expandGlob('a**b', sem), ['a*b', 'a?b', 'a[b', 'ab', 'axb']);
  assert.deepEqual(expandGlob('a**b', sem), expandGlob('a*b', sem));
});

test('a 200-character subject is matched inside the bound', () => {
  // The near-miss is worse the longer the name; the bound must not care.
  const r = expandTimed('*a'.repeat(30) + 'b', cost);
  assert.ok(r.ms < BUDGET_MS, `a 200-character name took ${Math.round(r.ms)}ms`);
  assert.deepEqual(r.matches, ['a'.repeat(30) + 'b']);
});

// ------------------------------------------- an uncompilable class (#28's half)

test('a reversed character class matches nothing, quietly', () => {
  // `[z-a]` cannot become a matcher. The segment it sits in compiles to
  // nothing, so the pattern reports no matches rather than throwing past
  // expandGlob — the note is the caller's business, taken care of below.
  assert.deepEqual(expandGlob('[z-a].ts', note), []);
});

// Naming the pattern is not enough. "skipped (no matches): [z-a].ts" names it
// too, and says the wrong thing: a pattern that CANNOT match is a different
// report from one that merely didn't, and the caller fixes them differently.
const assertMalformed = (notes, spelling) => {
  assert.ok(
    notes.some((n) => n.includes(spelling) && /expansion failed|invalid|malformed|cannot|could not/i.test(n)),
    `${spelling} must be reported as malformed, not merely as matching nothing — notes=${JSON.stringify(notes)}`,
  );
  assert.ok(
    !notes.some((n) => n.includes(spelling) && /no matches/i.test(n)),
    `${spelling} must not be filed under "no matches" — notes=${JSON.stringify(notes)}`,
  );
};

test('an uncompilable class stays a note, and the files beside it are read', () => {
  const hadRoots = 'GLM_MCP_ROOTS' in process.env;
  const savedRoots = process.env.GLM_MCP_ROOTS;
  process.env.GLM_MCP_ROOTS = note;
  try {
    const ctx = buildFileContext(['[z-a].ts', 'ok.ts'], note);
    assertMalformed(ctx.notes, '[z-a].ts');
    assert.ok(ctx.text.includes('OK-BODY'), `a good file beside it must still be read — text=${JSON.stringify(ctx.text)}`);
  } finally {
    if (hadRoots) process.env.GLM_MCP_ROOTS = savedRoots;
    else delete process.env.GLM_MCP_ROOTS;
  }
});

test('an uncompilable class inside braces stays a named note, and the good branch is read', () => {
  // The same failure reaching compileSegment through `{a,b}` expansion is the
  // case a note per thrown pattern never covered: the old throw named the
  // whole pattern but took the good branch's matches down with it, while a
  // catch that only makes the segment match nothing keeps the matches and
  // drops the note — the invalid branch vanishes without a word. Both halves
  // have to hold at once: the pattern named, and ok.ts still read through the
  // branch beside the uncompilable one.
  const hadRoots = 'GLM_MCP_ROOTS' in process.env;
  const savedRoots = process.env.GLM_MCP_ROOTS;
  process.env.GLM_MCP_ROOTS = note;
  try {
    const ctx = buildFileContext(['{[z-a].ts,ok.ts}'], note);
    assertMalformed(ctx.notes, '{[z-a].ts,ok.ts}');
    assert.ok(ctx.text.includes('OK-BODY'),
      `the good branch must still be read — text=${JSON.stringify(ctx.text)}`);
  } finally {
    if (hadRoots) process.env.GLM_MCP_ROOTS = savedRoots;
    else delete process.env.GLM_MCP_ROOTS;
  }
});

test('a pattern that can never match costs its neighbour no budget', () => {
  // The entry budget is the CALL's, shared across its patterns, so what a
  // malformed argument costs is measured on the honest pattern beside it:
  // src/*.ts must return the same files whether or not `**/[z-a].ts` — which
  // can match nothing, ever — sits in front of it. Before the short-circuit
  // the never-matching walk read every directory first, and the neighbour
  // came back with 0 of its 8 files under the same GLM_MCP_MAX_ENTRIES=10.
  const saved = {};
  for (const k of ['GLM_MCP_ROOTS', 'GLM_MCP_MAX_ENTRIES']) {
    saved[k] = { had: k in process.env, value: process.env[k] };
  }
  const srcFilesRead = (ctx) => (ctx.text.match(/--- src\/f\d+\.ts ---/g) ?? []).length;
  process.env.GLM_MCP_ROOTS = starve;
  process.env.GLM_MCP_MAX_ENTRIES = '10';
  try {
    const alone = buildFileContext(['src/*.ts'], starve);
    assert.equal(srcFilesRead(alone), 8, 'src/*.ts on its own must read its 8 files');
    const both = buildFileContext(['**/[z-a].ts', 'src/*.ts'], starve);
    assert.equal(srcFilesRead(both), srcFilesRead(alone),
      'a pattern that can never match must not spend the budget its neighbour needed');
    assertMalformed(both.notes, '**/[z-a].ts');
  } finally {
    for (const [k, { had, value }] of Object.entries(saved)) {
      if (had) process.env[k] = value;
      else delete process.env[k];
    }
  }
});

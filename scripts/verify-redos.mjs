// verify-redos.mjs — acceptance gate for #18: a glob segment must be matched in
// time bounded by its own length, never by how the subject happens to be shaped.
//
// `compileSegment` turned each `*` into `[^/]*`, so `*a*a…*b` compiled to a
// regex whose failing near-matches forced V8 to try every distribution of the
// subject's `a`s across the star groups. Measured on main before this gate: one
// pattern against one 40-character filename ran 50.8 SECONDS, synchronously, on
// the thread that serves every other MCP call. GLM_MCP_GLOB_TIMEOUT_MS does not
// help — a single RegExp.test() cannot be interrupted between clock samples, so
// the walk's budget is never consulted again.
//
// Two things have to hold at once, and the second is the harder one:
//   1. pathological patterns finish promptly;
//   2. every ordinary pattern still matches exactly what it matched before.
// The corpus in §2 was generated from the implementation this gate was written
// against and hand-checked, so a rewrite that is fast but subtly wrong fails
// here rather than in someone's repository.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (msg) => { throw new Error(msg); };
const GLOB = pathToFileURL(new URL('../dist/glob.js', import.meta.url).pathname).href;
const GLM = pathToFileURL(new URL('../dist/glm.js', import.meta.url).pathname).href;

// Matching runs in a child so a pattern that is still catastrophic is killed by
// the clock instead of hanging this script for the rest of the afternoon.
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

function expand(pattern, cwd, timeoutMs = 30_000) {
  let out;
  try {
    out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', CHILD, JSON.stringify({ pattern, cwd })],
      { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    if (e.killed) {
      fail(`matching ${JSON.stringify(pattern.slice(0, 48))}… did not finish within ${timeoutMs}ms — this is the #18 backtracking blowup, still present`);
    }
    fail(`expandGlob(${JSON.stringify(pattern.slice(0, 48))}…) threw\n${e.stderr || e.message}`);
  }
  return JSON.parse(out);
}

// Generous by five orders of magnitude: a segment matcher whose cost depends on
// its own length runs this in well under a millisecond, and the behaviour being
// excluded took 50,800ms.
const BUDGET_MS = 1_000;

const ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-redos-')));
const put = (name) => writeFileSync(join(ROOT, name), 'x');

try {
  // ------------------------------------------------- 1. the blowup itself
  // One long all-`a` name is the whole fixture: #18 needs no large tree, just a
  // subject the stars can be distributed across in exponentially many ways.
  put('a'.repeat(40));
  put('a'.repeat(200));
  put('ab');

  // The issue's own shape, at the K values it measured and past them. K=10 was
  // already unbounded; K=30 is included so a fix that merely raises the
  // exponent's base does not pass.
  for (const k of [5, 10, 12, 15, 20, 30]) {
    const pattern = '*a'.repeat(k) + 'b';
    const r = expand(pattern, ROOT);
    if (r.ms > BUDGET_MS) fail(`*a×${k}+b took ${Math.round(r.ms)}ms — matching must be bounded by the pattern, not by the subject`);
    // Fast and wrong is not a fix: nothing here ends in 'b' after that many a's.
    if (r.matches.length !== 0) fail(`*a×${k}+b matched ${JSON.stringify(r.matches)}, expected nothing`);
  }

  // Other shapes that backtrack for the same reason: alternating literals,
  // wildcards next to single-character wildcards, and classes in place of
  // literals. A fix aimed only at the `*a` shape fails here.
  for (const [label, pattern] of [
    ['*a*b×20', '*a*b'.repeat(20) + 'c'],
    ['*?×25', '*?'.repeat(25) + 'z'],
    ['*[a-z]×20', '*[a-z]'.repeat(20) + '9'],
    ['a*×30', 'a*'.repeat(30) + 'zz'],
    ['?*×25', '?*'.repeat(25) + 'zz'],
  ]) {
    const r = expand(pattern, ROOT);
    if (r.ms > BUDGET_MS) fail(`${label} took ${Math.round(r.ms)}ms — still superlinear`);
  }

  // A 200-character subject, where the blowup is worse still.
  const long = expand('*a'.repeat(30) + 'b', ROOT);
  if (long.ms > BUDGET_MS) fail(`a 200-character name took ${Math.round(long.ms)}ms`);

  // ------------------------------------- 2. ordinary patterns still match
  // Generated from the implementation this gate was written against, then read
  // through by hand. A matcher that is fast but disagrees with any line of this
  // has changed glob semantics, which #3 settled and this issue does not reopen.
  const NAMES = ['a.ts', 'b.ts', 'ab.ts', 'abc.ts', 'axb', 'a*b', 'a?b', 'a[b', 'ABC.ts',
    '1.ts', '-.ts', '.hidden', '.h.ts', 'xaybz', 'aaa', 'a', 'ab', 'abcd', 'z.ts', 'a.b.ts'];
  const CORPUS = {
    '*': ['-.ts', '1.ts', 'a', 'a*b', 'a.b.ts', 'a.ts', 'a?b', 'a[b', 'aaa', 'ab', 'ab.ts', 'abc.ts', 'abcd', 'axb', 'b.ts', 'xaybz', 'z.ts'],
    '*.ts': ['-.ts', '1.ts', 'a.b.ts', 'a.ts', 'ab.ts', 'abc.ts', 'b.ts', 'z.ts'],
    'a*': ['a', 'a*b', 'a.b.ts', 'a.ts', 'a?b', 'a[b', 'aaa', 'ab', 'ab.ts', 'abc.ts', 'abcd', 'axb'],
    '*a*': ['a', 'a*b', 'a.b.ts', 'a.ts', 'a?b', 'a[b', 'aaa', 'ab', 'ab.ts', 'abc.ts', 'abcd', 'axb', 'xaybz'],
    '*a*b*': ['a*b', 'a.b.ts', 'a?b', 'a[b', 'ab', 'ab.ts', 'abc.ts', 'abcd', 'axb', 'xaybz'],
    '?': ['a'],
    '??': ['ab'],
    'a?c': [],
    'a?b': ['a*b', 'a?b', 'a[b', 'axb'],
    '[a-z].ts': ['a.ts', 'b.ts', 'z.ts'],
    '[!a-z].ts': ['-.ts', '1.ts'],
    '[^a-z].ts': ['-.ts', '1.ts'],
    '[abc].ts': ['a.ts', 'b.ts'],
    '\\*.ts': [],
    'a\\*b': ['a*b'],
    'a\\?b': ['a?b'],
    'a\\[b': ['a[b'],
    '.hidden': ['.hidden'],
    '.*': ['.h.ts', '.hidden'],
    '*hidden': [],
    '*.*.ts': ['a.b.ts'],
    '[a-z]*.ts': ['a.b.ts', 'a.ts', 'ab.ts', 'abc.ts', 'b.ts', 'z.ts'],
    '*[0-9].ts': ['1.ts'],
    'a[b': ['a[b'],
    '??.ts': ['ab.ts'],
    '*b*': ['a*b', 'a.b.ts', 'a?b', 'a[b', 'ab', 'ab.ts', 'abc.ts', 'abcd', 'axb', 'b.ts', 'xaybz'],
    'aa*': ['aaa'],
    '*aa*': ['aaa'],
    '[!.]*': ['-.ts', '1.ts', 'a', 'a*b', 'a.b.ts', 'a.ts', 'a?b', 'a[b', 'aaa', 'ab', 'ab.ts', 'abc.ts', 'abcd', 'axb', 'b.ts', 'xaybz', 'z.ts'],
  };

  const corpusRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-redos-corpus-')));
  try {
    for (const n of NAMES) writeFileSync(join(corpusRoot, n), 'x');
    for (const [pattern, expected] of Object.entries(CORPUS)) {
      const got = expand(pattern, corpusRoot).matches;
      if (JSON.stringify(got) !== JSON.stringify(expected)) {
        fail(`${JSON.stringify(pattern)} matched\n  ${JSON.stringify(got)}\nexpected\n  ${JSON.stringify(expected)}`);
      }
    }
  } finally {
    rmSync(corpusRoot, { recursive: true, force: true });
  }

  // ------------------------------- 3. an uncompilable class stays a note (#28)
  // A reversed range cannot be turned into a matcher at all. It must be
  // reported and skipped, taking neither the call nor the process with it.
  const bad = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-redos-bad-')));
  try {
    writeFileSync(join(bad, 'ok.ts'), 'OK-BODY');
    const child = `
import { buildFileContext } from ${JSON.stringify(GLM)};
process.env.GLM_MCP_ROOTS = ${JSON.stringify(bad)};
const r = buildFileContext(['[z-a].ts', 'ok.ts'], ${JSON.stringify(bad)});
process.stdout.write(JSON.stringify({ text: r.text, notes: r.notes }));
`;
    let res;
    try {
      res = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', child],
        { cwd: bad, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (e) {
      fail(`a reversed character class took the whole call down — it must be a note\n${e.stderr || e.message}`);
    }
    // Naming the pattern is not enough: "no matches" would do that too, and it
    // is the wrong thing to say. A pattern that CANNOT match is a different
    // report from one that merely didn't, and the caller fixes them differently.
    const malformed = (notes, spelling) => notes.some((n) =>
      n.includes(spelling) && /expansion failed|invalid|malformed|cannot|could not/i.test(n));
    if (!malformed(res.notes, '[z-a].ts')) {
      fail(`an uncompilable pattern must be reported as malformed, not merely as matching nothing — notes=${JSON.stringify(res.notes)}`);
    }
    if (res.notes.some((n) => n.includes('[z-a].ts') && /no matches/i.test(n))) {
      fail(`an uncompilable pattern must not be filed under "no matches" — notes=${JSON.stringify(res.notes)}`);
    }
    if (!res.text.includes('OK-BODY')) {
      fail(`a good file beside an uncompilable pattern must still be read — text=${JSON.stringify(res.text)}`);
    }

    // The same class inside a brace alternation, where another branch succeeds.
    // Returning the good branch and saying nothing is the silent-narrowing shape
    // this project keeps removing — and the branch that vanished is a malformed
    // pattern the caller almost certainly wants to know about.
    const braced = `
import { buildFileContext } from ${JSON.stringify(GLM)};
process.env.GLM_MCP_ROOTS = ${JSON.stringify(bad)};
const r = buildFileContext(['{[z-a].ts,ok.ts}', 'absent-*.zzz'], ${JSON.stringify(bad)});
process.stdout.write(JSON.stringify({ text: r.text, notes: r.notes }));
`;
    let br;
    try {
      br = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', braced],
        { cwd: bad, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (e) {
      fail(`an uncompilable class inside braces took the call down\n${e.stderr || e.message}`);
    }
    if (!br.text.includes('OK-BODY')) {
      fail(`the good brace branch must still be read — text=${JSON.stringify(br.text)}`);
    }
    if (!malformed(br.notes, '{[z-a].ts,ok.ts}')) {
      fail(`an uncompilable brace branch must be reported even when another branch succeeds — notes=${JSON.stringify(br.notes)}`);
    }
    // And the correction must not swallow the ordinary case: a pattern that
    // genuinely matched nothing still says so.
    if (!br.notes.some((n) => n.includes('absent-*.zzz') && /no matches/i.test(n))) {
      fail(`a pattern that genuinely matched nothing must still say so — notes=${JSON.stringify(br.notes)}`);
    }
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log('REDOS OK');

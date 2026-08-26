// Resource limits (issues #15, #16, #17, #19): every unbounded operation in
// glm_ask gets a bound, and hitting one stops that operation with a note naming
// the knob — never a silent truncation. Exercised against real fixtures: a real
// oversized file, a real FIFO, a real 30-level tree, real 60-entry directories.
//
// Two groups run in a child process rather than in-process. The
// GLM_MCP_MAX_FILE_CHARS cases because that cap is read once at module load;
// the regular-file cases because a build where that check has regressed blocks
// forever inside readFileSync, and no node:test timeout can fire while the test
// process is blocked — the child has an external timeout, and being killed at
// it is how the regression fails in bounded time instead of hanging the suite.
// Everything else pins the env per test the way an operator pins it at startup.
// Each test asserts note CONTENT, not counts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync,
  openSync, ftruncateSync, closeSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildFileContext } from '../dist/glm.js';

const RAW = mkdtempSync(join(tmpdir(), 'glm-limits-test-'));
const ROOT = realpathSync.native(RAW);
const at = (...p) => join(ROOT, ...p);

const sparse = (rel, bytes) => {
  const fd = openSync(at(rel), 'w');
  ftruncateSync(fd, bytes);
  closeSync(fd);
};

let socket;
let socketError;

before(async () => {
  mkdirSync(at('src/a'), { recursive: true });
  mkdirSync(at('src/b'), { recursive: true });
  writeFileSync(at('src/a/one.ts'), 'BRANCH-A-BODY');
  writeFileSync(at('src/b/two.ts'), 'BRANCH-B-BODY');
  writeFileSync(at('small.txt'), 'AAA-SMALL-BODY');
  writeFileSync(at('hundred-k.txt'), 'K'.repeat(100_000));
  sparse('over-6mb.bin', 6 * 1024 * 1024);

  // Shallow file at depth 3, deep one at depth 31 — one limit has to separate
  // them, and the shallow one has to survive the cut.
  mkdirSync(at('deep/d1/d2/d3'), { recursive: true });
  writeFileSync(at('deep/d1/d2/d3/shallow.txt'), 'SHALLOW-BODY');
  const deepPath = at('deep', ...Array.from({ length: 30 }, (_, i) => `n${i}`));
  mkdirSync(deepPath, { recursive: true });
  writeFileSync(join(deepPath, 'bottom.txt'), 'DEEP-BOTTOM-BODY');

  // Two directories of 60 entries: neither exceeds a 100-entry budget alone,
  // together they must — the budget is per call, not per pattern.
  for (const side of ['twoA', 'twoB']) {
    mkdirSync(at(side), { recursive: true });
    for (let f = 0; f < 60; f++) writeFileSync(at(side, `f${String(f).padStart(2, '0')}.txt`), 'x');
  }
  writeFileSync(at('twoA/f00.txt'), 'TWOA-ZERO-BODY');

  // Enough directories that a 1 ms wall-clock budget cannot be beaten.
  for (let d = 0; d < 150; d++) {
    const dd = at('wide', `d${String(d).padStart(3, '0')}`);
    mkdirSync(dd, { recursive: true });
    for (let f = 0; f < 10; f++) writeFileSync(join(dd, `f${f}.txt`), '');
  }

  // One directory wide enough that scanning it is itself the expensive part.
  // A deadline checked only on the way INTO a walk never fires here: flat/*
  // enters once and can then run as long as the directory is wide — the entry
  // budget bites on this shape but the wall clock has to be re-checked while
  // the entries are being examined.
  mkdirSync(at('flat'), { recursive: true });
  for (let f = 0; f < 8_000; f++) writeFileSync(at('flat', `g${String(f).padStart(4, '0')}.txt`), '');

  // 300 empty files: zero body bytes, one header each — the #19 bypass.
  mkdirSync(at('many'), { recursive: true });
  for (let f = 0; f < 300; f++) writeFileSync(at('many', `empty-${String(f).padStart(4, '0')}.txt`), '');
  writeFileSync(at('three-hundred.txt'), 'B'.repeat(300));
  // Every code point is a surrogate pair, so an odd-sized truncation window
  // bisects one.
  writeFileSync(at('emoji.txt'), '\u{1F600}'.repeat(300));

  execFileSync('mkfifo', [at('the-fifo')]);

  // A real unix socket for the regular-file rule: it has to be refused as a
  // FIFO is, and where one cannot exist (path too long for the platform's
  // sun_path, say) the test says so instead of failing.
  try {
    socket = createServer();
    await new Promise((resolve, reject) => {
      socket.once('listening', resolve);
      socket.once('error', reject);
      socket.listen(at('the-sock'));
    });
  } catch (e) {
    socketError = e;
    socket = undefined;
  }
});

after(() => {
  if (socket) socket.close();
  rmSync(ROOT, { recursive: true, force: true });
});

// Pin one call's configuration and restore it after, the way confinement.test
// pins the operator's side of the boundary.
const pin = (t, env = {}) => {
  const saved = {};
  for (const name of [
    'GLM_MCP_ROOTS', 'GLM_MCP_MAX_FILE_BYTES', 'GLM_MCP_MAX_DEPTH',
    'GLM_MCP_MAX_ENTRIES', 'GLM_MCP_GLOB_TIMEOUT_MS', 'GLM_MCP_MAX_BRACE_EXPANSIONS',
  ]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.GLM_MCP_ROOTS = ROOT;
  for (const [k, v] of Object.entries(env)) process.env[k] = String(v);
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
};

// ----------------------------------------------------------- #15: per-file size

test('a file over GLM_MCP_MAX_FILE_BYTES is refused by stat, its neighbour survives', (t) => {
  pin(t, { GLM_MCP_MAX_FILE_BYTES: 1024 });
  const ctx = buildFileContext(['hundred-k.txt', 'small.txt'], ROOT);
  assert.ok(
    ctx.notes.some((n) => n.includes('GLM_MCP_MAX_FILE_BYTES') && n.includes('hundred-k.txt')),
    `the note must name the knob and the file: ${JSON.stringify(ctx.notes)}`,
  );
  assert.ok(!ctx.text.includes('KKKK'), 'an oversize file must not be read');
  assert.ok(ctx.text.includes('AAA-SMALL-BODY'), 'the neighbour must survive');
});

test('a 6 MB file is refused against the 5 MB default', (t) => {
  pin(t);
  const ctx = buildFileContext(['over-6mb.bin'], ROOT);
  assert.ok(
    ctx.notes.some((n) => n.includes('GLM_MCP_MAX_FILE_BYTES') && n.includes('over-6mb.bin')),
    JSON.stringify(ctx.notes),
  );
});

test('an unparsable GLM_MCP_MAX_FILE_BYTES falls back to the 5 MB default', (t) => {
  pin(t, { GLM_MCP_MAX_FILE_BYTES: 'not-a-number' });
  const ctx = buildFileContext(['over-6mb.bin'], ROOT);
  assert.ok(
    ctx.notes.some((n) => n.includes('GLM_MCP_MAX_FILE_BYTES') && n.includes('over-6mb.bin')),
    `a typo must not silently remove the cap: ${JSON.stringify(ctx.notes)}`,
  );
});

// ------------------------------------------------------ #15: regular files only
// The tests for it live with the other child-process cases at the bottom of
// this file: a build where the check has regressed blocks forever inside
// readFileSync, which an in-process test cannot even fail.

// --------------------------------------------------------------- #16: walk depth

test('a walk past GLM_MCP_MAX_DEPTH stops, notes the knob, keeps the shallow file', (t) => {
  pin(t, { GLM_MCP_MAX_DEPTH: 5 });
  const ctx = buildFileContext(['deep/**/*.txt'], ROOT);
  assert.ok(
    ctx.notes.some((n) => n.includes('GLM_MCP_MAX_DEPTH') && n.includes('deep/**/*.txt')),
    JSON.stringify(ctx.notes),
  );
  assert.ok(!ctx.text.includes('DEEP-BOTTOM-BODY'), 'a file 31 levels down must not be reached');
  assert.ok(ctx.text.includes('SHALLOW-BODY'), 'the shallow file must survive the cut-off');
});

test('a 31-level walk is stopped by the default depth of 24', (t) => {
  pin(t);
  const ctx = buildFileContext(['deep/**/*.txt'], ROOT);
  assert.ok(
    ctx.notes.some((n) => n.includes('GLM_MCP_MAX_DEPTH')),
    JSON.stringify(ctx.notes),
  );
  assert.ok(!ctx.text.includes('DEEP-BOTTOM-BODY'));
  assert.ok(ctx.text.includes('SHALLOW-BODY'));
});

// -------------------------------------------------- #16: entries and wall clock

test('the entry budget is per call: two patterns of 60 entries against 100', (t) => {
  pin(t, { GLM_MCP_MAX_ENTRIES: 100 });
  const ctx = buildFileContext(['twoA/*.txt', 'twoB/*.txt'], ROOT);
  assert.ok(
    ctx.notes.some((n) => n.includes('GLM_MCP_MAX_ENTRIES')),
    JSON.stringify(ctx.notes),
  );
  assert.ok(
    ctx.text.includes('TWOA-ZERO-BODY'),
    'the pattern that fitted the budget must keep its work',
  );
});

test('a walk past GLM_MCP_GLOB_TIMEOUT_MS stops and notes the knob', (t) => {
  pin(t, { GLM_MCP_GLOB_TIMEOUT_MS: 1 });
  const ctx = buildFileContext(['wide/**/*.txt'], ROOT);
  assert.ok(
    ctx.notes.some((n) => n.includes('GLM_MCP_GLOB_TIMEOUT_MS') && n.includes('wide/**/*.txt')),
    JSON.stringify(ctx.notes),
  );
});

test('a single wide directory cannot outlive the wall-clock budget', (t) => {
  pin(t, { GLM_MCP_GLOB_TIMEOUT_MS: 1 });
  // flat/* enters its one directory once, so a deadline checked only on the
  // way in never sees it again: 8,000 entries ran hundreds of times past a
  // 1 ms budget with nothing in notes. The check has to fire while the
  // entries are being examined, not only between directories.
  const ctx = buildFileContext(['flat/*'], ROOT);
  assert.ok(
    ctx.notes.some((n) => n.includes('GLM_MCP_GLOB_TIMEOUT_MS') && n.includes('flat/*')),
    `8,000 entries against a 1 ms budget must be cut short with a note: ${JSON.stringify(ctx.notes)}`,
  );
});

test('an already-spent budget stops the literal brace branches before branch one', (t) => {
  pin(t, { GLM_MCP_GLOB_TIMEOUT_MS: 1 });
  // wide/** burns the call's wall clock. The brace pattern after it expands to
  // fully literal branches — no wildcard anywhere, so collect never enters
  // walk() and its on-the-way-in check — and the branch loop's own clock is
  // sampled every 64th branch, which a 2-branch expansion never reaches: both
  // files sailed through on an expired budget with nothing in notes.
  const literal = 'src/{a/one.ts,b/two.ts}';
  const ctx = buildFileContext(['wide/**/*.txt', literal], ROOT);
  assert.ok(
    ctx.notes.some((n) => n.includes('GLM_MCP_GLOB_TIMEOUT_MS') && n.includes(literal)),
    `an expired budget must stop the brace loop before its first branch: ${JSON.stringify(ctx.notes)}`,
  );
  assert.ok(
    !ctx.text.includes('BRANCH-A-BODY') && !ctx.text.includes('BRANCH-B-BODY'),
    'branches processed after the deadline must not be matched',
  );
});

test('the 1,500-entry walk stays under the 200,000 default without a note', (t) => {
  pin(t);
  const ctx = buildFileContext(['wide/**/*.txt'], ROOT);
  assert.ok(
    !ctx.notes.some((n) => n.includes('GLM_MCP_MAX_ENTRIES') || n.includes('GLM_MCP_GLOB_TIMEOUT_MS')),
    JSON.stringify(ctx.notes),
  );
});

// ------------------------------------------------------------ #17: brace blows up

test('a million brace combinations are refused before expanding, never thrown', (t) => {
  pin(t);
  const hostile = `nowhere/${'{a,b}'.repeat(20)}/*.txt`;
  // Before the cap this reached `RangeError: Maximum call stack size exceeded`
  // straight through buildFileContext.
  const ctx = buildFileContext([hostile], ROOT);
  assert.ok(
    ctx.notes.some((n) => n.includes('GLM_MCP_MAX_BRACE_EXPANSIONS') && n.includes(hostile)),
    JSON.stringify(ctx.notes),
  );
  assert.equal(ctx.refusedCall, false);
});

test('an unparsable brace cap falls back to the 1,024 default', (t) => {
  pin(t, { GLM_MCP_MAX_BRACE_EXPANSIONS: 'not-a-number' });
  const ctx = buildFileContext([`nowhere/${'{a,b}'.repeat(12)}/*.txt`], ROOT);
  assert.ok(
    ctx.notes.some((n) => n.includes('GLM_MCP_MAX_BRACE_EXPANSIONS')),
    JSON.stringify(ctx.notes),
  );
});

test('ordinary brace use still expands under the cap', (t) => {
  pin(t);
  const ctx = buildFileContext(['src/{a,b}/*.ts'], ROOT);
  assert.ok(ctx.text.includes('BRANCH-A-BODY'), JSON.stringify(ctx.notes));
  assert.ok(ctx.text.includes('BRANCH-B-BODY'), JSON.stringify(ctx.notes));
  assert.ok(
    !ctx.notes.some((n) => n.includes('GLM_MCP_MAX_BRACE_EXPANSIONS')),
    JSON.stringify(ctx.notes),
  );
});

test("a limit on one pattern does not swallow the next pattern's own note", (t) => {
  pin(t, { GLM_MCP_MAX_BRACE_EXPANSIONS: 1 });
  // The first pattern is refused by the cap; the second genuinely matches
  // nothing. Not saying "no matches" about the first is right — it was
  // refused, not wrong. Not saying it about the second is a second silent
  // drop: a limit stops the pattern that hit it and leaves the call alone.
  const ctx = buildFileContext(['src/{a,b}/*.none', 'definitely-missing-*.zzz'], ROOT);
  assert.ok(
    ctx.notes.some((n) => n.includes('refused (too many brace expansions): src/{a,b}/*.none')),
    `the refused pattern keeps its refusal note: ${JSON.stringify(ctx.notes)}`,
  );
  assert.ok(
    ctx.notes.some((n) => n.includes('skipped (no matches): definitely-missing-*.zzz')),
    `the pattern after it still says it matched nothing: ${JSON.stringify(ctx.notes)}`,
  );
});

test('a repeated refused pattern keeps its refusal and gains no no-matches note', (t) => {
  pin(t, { GLM_MCP_MAX_BRACE_EXPANSIONS: 1 });
  // A, B, A: both brace patterns are refused, and the second A's refusal is a
  // repeat of the first's — de-duplicated by the note sink, so the callback
  // does not fire again for it. Remembering only the latest limited pattern
  // goes stale when B's refusal overwrites A's, and the repeated A lands in
  // notes as "no matches" right beside the refusal that says otherwise.
  const again = 'src/{a,b}/*.none';
  const ctx = buildFileContext([again, 'docs/{x,y}/*.none', again], ROOT);
  assert.ok(
    ctx.notes.some((n) => n.includes(`refused (too many brace expansions): ${again}`)),
    `the repeated pattern keeps its refusal note: ${JSON.stringify(ctx.notes)}`,
  );
  assert.ok(
    ctx.notes.some((n) => n.includes('refused (too many brace expansions): docs/{x,y}/*.none')),
    `the pattern between them keeps its own refusal: ${JSON.stringify(ctx.notes)}`,
  );
  assert.ok(
    !ctx.notes.some((n) => n.includes(`skipped (no matches): ${again}`)),
    `a pattern that was refused must not also be filed as no matches: ${JSON.stringify(ctx.notes)}`,
  );
});

// ----------------- child-process harness: the #15 and #19 cases below use it
// Two reasons to leave the test process. GLM_MCP_MAX_FILE_CHARS is read at
// module load, so that cap has to be in the environment before the module is
// imported to be testable at all; and the regular-file cases drive the
// synchronous read path, which a regressed build blocks inside forever.
const CHILD = `
import { buildFileContext } from ${JSON.stringify(pathToFileURL(new URL('../dist/glm.js', import.meta.url).pathname).href)};
const job = JSON.parse(process.argv[1]);
const r = buildFileContext(job.paths, job.cwd);
process.stdout.write(JSON.stringify({ text: String(r.text ?? ''), notes: (r.notes ?? []).map(String) }));
`;

const childCtx = (t, { paths, env = {}, timeoutMs = 30_000 }) => {
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (k.startsWith('GLM_MCP_')) delete childEnv[k];
  childEnv.GLM_MCP_ROOTS = ROOT;
  for (const [k, v] of Object.entries(env)) childEnv[k] = String(v);
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', CHILD, JSON.stringify({ paths, cwd: ROOT })],
    // A file under the byte cap is read and then truncated to the char cap,
    // and JSON escapes a NUL to six characters, so a legitimate result can
    // run to several MB. The 1 MB default would abort the child and the
    // failure would read as the implementation's — the same ENOBUFS the
    // acceptance gate guards itself against.
    { cwd: ROOT, env: childEnv, encoding: 'utf8', timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(out);
};

// ------------------------------------------- #15: regular files only — in a child
// These drive the synchronous read path, so against a build where the
// regular-file check has regressed the child blocks inside readFileSync — a
// FIFO with no writer blocks forever, /dev/zero reads forever — and the
// external timeout is the only thing that can intervene. Being killed at it
// is this test FAILING, in bounded time; an in-process version would instead
// hang the whole suite, which is not a failure anyone gets to see.

test('a FIFO is refused as not a regular file, its neighbour survives', (t) => {
  // No writer will ever open this FIFO, so the refusal has to come from the
  // stat that precedes the read — never from the read discovering it.
  let r;
  try {
    r = childCtx(t, { paths: ['the-fifo', 'small.txt'], timeoutMs: 8_000 });
  } catch (e) {
    assert.fail(
      'the FIFO read blocked until the child had to be killed — a FIFO must be ' +
        `refused by stat before anything reads it (${e.killed ? 'killed at the timeout' : e.message})`,
    );
  }
  assert.ok(
    r.notes.some((n) => /not a regular file/i.test(n) && n.includes('the-fifo')),
    JSON.stringify(r.notes),
  );
  assert.ok(r.text.includes('AAA-SMALL-BODY'), 'the FIFO must not take its neighbour down');
});

test('a character device is refused as not a regular file', (t) => {
  // Rooted at '/' so the device sits inside the boundary and the only rule
  // that can refuse it is the regular-file one.
  let r;
  try {
    r = childCtx(t, { paths: ['/dev/zero'], env: { GLM_MCP_ROOTS: '/' }, timeoutMs: 8_000 });
  } catch (e) {
    assert.fail(
      '/dev/zero was read rather than refused — a device has no size worth ' +
        `capping, it must be refused by stat (${e.killed ? 'killed at the timeout' : e.message})`,
    );
  }
  assert.ok(
    r.notes.some((n) => /not a regular file/i.test(n) && n.includes('/dev/zero')),
    JSON.stringify(r.notes),
  );
  assert.equal(r.text.length, 0, 'nothing of a device may enter the prompt');
});

test('a unix socket is refused as not a regular file, its neighbour survives', (t) => {
  if (socketError) {
    t.skip(`could not create one here: ${socketError.code ?? socketError.message}`);
    return;
  }
  let r;
  try {
    r = childCtx(t, { paths: ['the-sock', 'small.txt'], timeoutMs: 8_000 });
  } catch (e) {
    assert.fail(
      'the socket was read rather than refused as not a regular file ' +
        `(${e.killed ? 'killed at the timeout' : e.message})`,
    );
  }
  assert.ok(
    r.notes.some((n) => /not a regular file/i.test(n) && n.includes('the-sock')),
    JSON.stringify(r.notes),
  );
  assert.ok(r.text.includes('AAA-SMALL-BODY'), 'the socket must not take its neighbour down');
});

test('headers and separators count toward GLM_MCP_MAX_FILE_CHARS', (t) => {
  const r = childCtx(t, { paths: ['many/*.txt'], env: { GLM_MCP_MAX_FILE_CHARS: 2000 } });
  assert.ok(
    r.notes.some((n) => /truncat/i.test(n) && n.includes('many/empty-')),
    `300 empty files must be truncated and noted: ${JSON.stringify(r.notes)}`,
  );
  assert.ok(r.text.length <= 2000, `assembled text is ${r.text.length} chars against a 2,000-char cap`);
});

test('a body file and the headers after it share one cap', (t) => {
  const r = childCtx(t, {
    paths: ['three-hundred.txt', 'many/*.txt'],
    env: { GLM_MCP_MAX_FILE_CHARS: 500 },
  });
  assert.ok(r.text.length <= 500, `assembled text is ${r.text.length} chars against a 500-char cap`);
  assert.ok(r.notes.some((n) => /truncat/i.test(n)), JSON.stringify(r.notes));
});

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test('truncation slices on code points, not UTF-16 units', (t) => {
  // Three adjacent caps over a body of surrogate pairs: at least one window is
  // necessarily odd-sized, whatever the header costs.
  for (const cap of [100, 101, 102]) {
    const r = childCtx(t, { paths: ['emoji.txt'], env: { GLM_MCP_MAX_FILE_CHARS: cap } });
    assert.ok(
      !LONE_SURROGATE.test(r.text),
      `truncating at ${cap} chars split a surrogate pair`,
    );
    assert.ok(r.text.length <= cap, `text is ${r.text.length} chars against a ${cap}-char cap`);
    assert.ok(r.notes.some((n) => /truncat/i.test(n)), `cap ${cap}: ${JSON.stringify(r.notes)}`);
  }
});

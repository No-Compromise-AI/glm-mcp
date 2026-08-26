// Resource limits (issues #15, #16, #17, #19): every unbounded operation in
// glm_ask gets a bound, and hitting one stops that operation with a note naming
// the knob — never a silent truncation. Exercised against real fixtures: a real
// oversized file, a real FIFO, a real 30-level tree, real 60-entry directories.
//
// The GLM_MCP_MAX_FILE_CHARS cases run in a child process because that cap is
// read once at module load; everything else pins the env per test the way an
// operator pins it at startup. Each test asserts note CONTENT, not counts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync,
  openSync, ftruncateSync, closeSync,
} from 'node:fs';
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

before(() => {
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

  // 300 empty files: zero body bytes, one header each — the #19 bypass.
  mkdirSync(at('many'), { recursive: true });
  for (let f = 0; f < 300; f++) writeFileSync(at('many', `empty-${String(f).padStart(4, '0')}.txt`), '');
  writeFileSync(at('three-hundred.txt'), 'B'.repeat(300));
  // Every code point is a surrogate pair, so an odd-sized truncation window
  // bisects one.
  writeFileSync(at('emoji.txt'), '\u{1F600}'.repeat(300));

  execFileSync('mkfifo', [at('the-fifo')]);
});

after(() => rmSync(ROOT, { recursive: true, force: true }));

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

test('a FIFO is refused as not a regular file, its neighbour survives', { timeout: 10_000 }, (t) => {
  pin(t);
  // No writer will ever open this FIFO; reading it would block forever, so the
  // timeout is what turns a regression into a failure instead of a hang.
  const ctx = buildFileContext(['the-fifo', 'small.txt'], ROOT);
  assert.ok(
    ctx.notes.some((n) => /not a regular file/i.test(n) && n.includes('the-fifo')),
    JSON.stringify(ctx.notes),
  );
  assert.ok(ctx.text.includes('AAA-SMALL-BODY'), 'the FIFO must not take its neighbour down');
});

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

// ------------------------- #19: headers, separators, code points — child process
// GLM_MCP_MAX_FILE_CHARS is read at module load, so the cap has to be in the
// environment before the module is imported to be testable at all.
const CHILD = `
import { buildFileContext } from ${JSON.stringify(pathToFileURL(new URL('../dist/glm.js', import.meta.url).pathname).href)};
const job = JSON.parse(process.argv[1]);
const r = buildFileContext(job.paths, job.cwd);
process.stdout.write(JSON.stringify({ text: String(r.text ?? ''), notes: (r.notes ?? []).map(String) }));
`;

const childCtx = (t, { paths, env = {} }) => {
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (k.startsWith('GLM_MCP_')) delete childEnv[k];
  childEnv.GLM_MCP_ROOTS = ROOT;
  for (const [k, v] of Object.entries(env)) childEnv[k] = String(v);
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', CHILD, JSON.stringify({ paths, cwd: ROOT })],
    { cwd: ROOT, env: childEnv, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(out);
};

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

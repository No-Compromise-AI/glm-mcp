// Numbered file context and line ranges (#53): the regressions review found in
// the first cut, pinned here so they stay fixed.
//
// Two of them, one per finding. First, the numbering was assembled WHOLE and
// only then measured against the char cap — the cap decided what to keep, but
// everything had already been built by then. A file at the byte limit whose
// body is nothing but newlines numbers to 5,242,880 lines and a ~47M-char
// string before the cap ever gets a say, dying on a 128 MiB heap to deliver a
// 2,000-char answer. Reading the file was always bounded by
// GLM_MCP_MAX_FILE_BYTES; numbering it has to be bounded by the same budget
// the answer is measured against (#19: work done to satisfy a budget is still
// work, and a budget that only constrains its own output has not constrained
// its own cost).
//
// Second, the range de-duplication key was the resolved file plus a NUL plus
// the range — sound on its own, since a RESOLVED path cannot contain a NUL on
// any platform — but it shared one set with the resolved paths of ordinary
// arguments, and keyOf's lexical fallback for a path that resolves to nothing
// keeps whatever bytes the caller sent, NUL included. An invalid literal like
// "readme.txt\0" + "2-3" therefore inserts the very string that the VALID
// range "readme.txt:2-3" later computes as ITS key, and the range is dropped
// as a duplicate of a file that does not exist. Ranges are asks in their own
// right ("two ranges of one file are two asks"); their de-duplication has to
// run against other ranges, not against the phantom spellings of arguments
// that resolved to nothing.
//
// The three de-duplication cases that existed before ranges are pinned too:
// the separate set must fold a repeated range without folding anything else.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildFileContext } from '../dist/glm.js';

// Canonical, the way verify-lines.mjs builds its own root: on a machine whose
// tmpdir sits behind a symlink (/var -> /private/var), the spellings of cwd
// and of keyOf's realpath differ by that prefix, which by itself keeps the
// NUL collision from triggering. The bug is real wherever the root is already
// canonical — every Linux tmpdir, and every root an operator spells in full.
const RAW = mkdtempSync(join(tmpdir(), 'glm-lines-test-'));
const ROOT = realpathSync.native(RAW);
const at = (...p) => join(ROOT, ...p);

before(() => {
  // Exactly DEFAULT_MAX_FILE_BYTES, not one byte over: the size refusal is
  // st.size > max, so this file is permitted and read. Every line is empty,
  // which is the shape that maximises numbering overhead per body byte —
  // 8 chars of number and tab for every 1 char of newline.
  writeFileSync(at('newlines-5mb.txt'), '\n'.repeat(5 * 1024 * 1024));
  writeFileSync(at('rangehost.txt'), 'alpha\nbeta\ngamma\ndelta\n');
});

after(() => rmSync(ROOT, { recursive: true, force: true }));

const pin = (t) => {
  const saved = {};
  for (const name of [
    'GLM_MCP_ROOTS', 'GLM_MCP_MAX_FILE_BYTES', 'GLM_MCP_MAX_FILE_CHARS',
  ]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.GLM_MCP_ROOTS = ROOT;
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
};

// ------------------------- the numbering must fit the budget it is measured in
// The child carries the same 128 MiB heap the OOM was reproduced under, so a
// regression dies inside the child — loudly, in bounded time — instead of
// taking the whole suite's process with it.
const CHILD = `
import { buildFileContext } from ${JSON.stringify(pathToFileURL(new URL('../dist/glm.js', import.meta.url).pathname).href)};
const job = JSON.parse(process.argv[1]);
const r = buildFileContext(job.paths, job.cwd);
process.stdout.write(JSON.stringify({ text: String(r.text ?? ''), notes: (r.notes ?? []).map(String) }));
`;

test('a permitted file is numbered within the char cap, not before it', (t) => {
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (k.startsWith('GLM_MCP_')) delete childEnv[k];
  childEnv.GLM_MCP_ROOTS = ROOT;
  childEnv.GLM_MCP_MAX_FILE_CHARS = 2000;
  let r;
  try {
    const out = execFileSync(
      process.execPath,
      ['--max-old-space-size=128', '--input-type=module', '-e', CHILD,
        JSON.stringify({ paths: ['newlines-5mb.txt'], cwd: ROOT })],
      { cwd: ROOT, env: childEnv, encoding: 'utf8', timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    r = JSON.parse(out);
  } catch (e) {
    assert.fail(
      'numbering a 5 MiB file of newlines under a 2,000-char cap exhausted a ' +
        '128 MiB heap — the numbered text was assembled whole before the cap ' +
        'measured it, so the work bounded nothing, not even itself ' +
        `(${/out of memory/i.test(String(e.stderr)) ? 'heap out of memory' : e.message})`,
    );
  }
  assert.ok(r.text.length <= 2000, `assembled text is ${r.text.length} chars against a 2,000-char cap`);
  assert.ok(r.notes.some((n) => /truncat/i.test(n)), JSON.stringify(r.notes));
  // The delivered prefix still carries the file's own numbering: line 1 with
  // the width of the file's last line number (5,242,880 — seven digits).
  assert.match(
    r.text,
    /--- newlines-5mb\.txt \(truncated\) ---\n {6}1\t\n {6}2\t/,
    'the truncated excerpt must open with the file\'s first lines, cat -n wide',
  );
});

// ---------------------------- a NUL-bearing literal cannot squat on a range key

test('an invalid NUL literal does not swallow a valid range of the same file', (t) => {
  pin(t);
  const NUL = String.fromCharCode(0);
  // The first argument resolves to nothing on any platform — no filesystem
  // names a file with a NUL in it — so its lexical fallback key keeps the NUL.
  // The second is an ordinary range ask, and it must arrive.
  const ctx = buildFileContext([`rangehost.txt${NUL}2-3`, 'rangehost.txt:2-3'], ROOT);
  assert.ok(
    ctx.text.includes('2\tbeta') && ctx.text.includes('3\tgamma'),
    `the valid range was dropped beside a NUL-bearing literal: ${JSON.stringify(ctx)}`,
  );
  assert.ok(!ctx.text.includes('alpha') && !ctx.text.includes('delta'),
    'nothing outside the range 2-3 may arrive');
});

// ------------------------- the de-duplication ranges already had, kept as was

test('the same range twice folds into one excerpt, the repeat is answered', (t) => {
  pin(t);
  const ctx = buildFileContext(['rangehost.txt:2-3', 'rangehost.txt:2-3'], ROOT);
  assert.equal(
    ctx.text,
    '--- rangehost.txt:2-3 ---\n2\tbeta\n3\tgamma',
    `a repeated range is one ask made twice: ${JSON.stringify(ctx)}`,
  );
  assert.ok(
    ctx.notes.some((n) => n === 'skipped (no matches): rangehost.txt:2-3'),
    `the repeat is answered in its own spelling, as every unfulfilled position is: ${JSON.stringify(ctx.notes)}`,
  );
});

test('a whole file and a range of it are two asks and both arrive', (t) => {
  pin(t);
  const ctx = buildFileContext(['rangehost.txt', 'rangehost.txt:2-3'], ROOT);
  assert.match(ctx.text, /--- rangehost\.txt ---\n1\talpha/);
  assert.match(ctx.text, /--- rangehost\.txt:2-3 ---\n2\tbeta/);
  assert.deepEqual(ctx.notes, [], JSON.stringify(ctx));
});

test('two ranges of one file are two asks and both arrive', (t) => {
  pin(t);
  const ctx = buildFileContext(['rangehost.txt:1-2', 'rangehost.txt:3-4'], ROOT);
  assert.match(ctx.text, /--- rangehost\.txt:1-2 ---\n1\talpha/);
  assert.match(ctx.text, /--- rangehost\.txt:3-4 ---\n3\tgamma/);
  assert.deepEqual(ctx.notes, [], JSON.stringify(ctx));
});

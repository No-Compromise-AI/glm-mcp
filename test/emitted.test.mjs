// The char cap measures the text that is EMITTED — numbered, headered,
// assembled — never the bytes that are read (src/glm.ts's own rule, #19 and
// #53). On source-shaped files the emitted text is LONGER than the bytes on
// disk: every line carries a right-aligned number and a tab, every file a
// header, every file after the first a separator. The #44 measurement learned
// this the hard way and the README followed it into the trap: a fixture of
// 400 files x 198,000 bytes (79.2 MB) was measured under
// GLM_MCP_MAX_FILE_CHARS=80000000, a cap chosen because 80,000,000 > 79,200,000
// looks generous. It is not: numbering swells each 198,000-byte file to
// 212,999 characters, the assembled whole is 85,208,288, and the cap cut the
// walk at the 376th file — 24 files were never read — while the README said
// "a call reading 400 files (79 MB)" about a call that had read 74.4 MB of
// them. A review caught it; these tests hold the line it redrew.
//
// Two pins. First the trap itself: a cap set to EXACTLY the bytes on disk
// still cuts the walk, because what the cap measures is bigger than what `du`
// reports — so nobody sizes a cap from byte counts again, and a change that
// quietly stops counting line numbers or headers toward the cap (silently
// loosening every operator's pin) fails here. Measured at exactly that cap on
// this fixture: 371 files whole, the 372nd truncated mid-body, 28 never read.
//
// Those counts are asserted EXACTLY, and that is deliberate. Two review rounds
// of the change this file accompanies each quoted a figure under conditions
// that did not produce it — "400 files" under a cap admitting 375, then
// 376/24, which is the 80,000,000 cap's answer, offered for the 79,200,000
// cap. The test that stood over the second claim asserted only
// `delivered > 0 && delivered < FILES`, a range no wrong number can fail.
// A pin that cannot fail cannot hold a line, so the counts are now numbers,
// measured at this fixture and this cap; if the accounting drifts by one file,
// this says which direction rather than shrugging. The unread count is its own
// measurement, not arithmetic on the delivered one: the child asks the
// directory which files never got a header at all, so a count that drifts
// while the disk does not (a header double-counted, a file's header lost)
// fails here rather than cancelling inside FILES - delivered.
//
// Second, the README's own claim — the same half of the biconditional
// verify-blocking holds for the serialisation sentence. The README discloses
// the cap its measured run used; this test reads that number out of the
// README, runs the workload the README names under it, and requires the whole
// workload to arrive. If the README stops disclosing a cap, or discloses one
// that does not admit the tree it quotes, this fails: the documentation is
// checked against the behaviour, not against itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The import specifier the child is told to load, from this file's own URL.
// Kept as a named thing because a review found the construction matters: the
// URL is already absolute, and anything that routes it through a PATH first
// (.pathname, then pathToFileURL again) re-encodes every percent-escape the
// path carries — a checkout under `/tmp/glm repo` reached the child as %2520
// and died with ERR_MODULE_NOT_FOUND before the first assertion ran. The
// specifier is the URL itself.
const specifierFor = (moduleUrl) => new URL('../dist/glm.js', moduleUrl).href;

const RAW = mkdtempSync(join(tmpdir(), 'glm-emitted-test-'));
const ROOT = realpathSync.native(RAW);
const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

// The workload the README's Limits paragraph names: 400 files of 3,000 lines
// each, 66 bytes to the line — 198,000 bytes a file, 79.2 MB the tree.
// Line-shaped on purpose, because the expansion the trap turns on is per LINE
// (number + tab), and 4-digit numbers over 65-char code lines are the shape
// that turned 79 MB of files into 85.2M characters of prompt.
const LINE = 'export const filler = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";\n'; // 66 bytes
const FILES = 400;

before(() => {
  mkdirSync(join(ROOT, 'src'), { recursive: true });
  const body = LINE.repeat(3_000); // 198,000 bytes
  for (let i = 0; i < FILES; i++) writeFileSync(join(ROOT, 'src', `f${i}.ts`), body);
});

after(() => rmSync(ROOT, { recursive: true, force: true }));

// GLM_MCP_MAX_FILE_CHARS is read at module load, so the cap has to be in the
// environment before the module is imported — the same child-process reason
// limits.test.mjs states. The child counts what arrived rather than shipping
// 85M characters back over stdout; the numbered body never starts a line with
// `--- `, so the headers are unambiguous in the assembled text.
const CHILD = `
import { buildFileContext } from ${JSON.stringify(specifierFor(import.meta.url))};
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
const job = JSON.parse(process.argv[1]);
const r = buildFileContext(job.paths, job.cwd);
const delivered = [...String(r.text ?? '').matchAll(/--- src\\/f\\d+\\.ts(?: \\(truncated\\))? ---/g)];
const named = new Set(delivered.map((m) => /--- (src\\/f\\d+\\.ts)/.exec(m[0])[1]));
const onDisk = readdirSync(join(job.cwd, 'src')).filter((f) => f.endsWith('.ts')).map((f) => 'src/' + f);
const unread = onDisk.filter((f) => !named.has(f)).length;
process.stdout.write(JSON.stringify({
  delivered: delivered.length,
  truncated: delivered.filter((m) => m[0].includes('(truncated)')).length,
  unread,
  chars: String(r.text ?? '').length,
  notes: (r.notes ?? []).map(String),
}));
`;

test('the import specifier survives a checkout path that needs percent-encoding', () => {
  // The construction above, exercised on a URL whose path is NOT already
  // plain: a space reaches a URL as %20, and the specifier has to carry that
  // escape once — not encode the percent itself.
  const spaced = new URL('file:///tmp/glm%20repo/test/emitted.test.mjs');
  assert.equal(
    fileURLToPath(specifierFor(spaced)), '/tmp/glm repo/dist/glm.js',
    'the specifier handed to the child must resolve to the real dist/glm.js ' +
      'when the checkout lives under a path that percent-encoding exists for',
  );
});

const run = (cap) => {
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (k.startsWith('GLM_MCP_')) delete childEnv[k];
  childEnv.GLM_MCP_ROOTS = ROOT;
  childEnv.GLM_MCP_MAX_FILE_CHARS = String(cap);
  return JSON.parse(execFileSync(
    process.execPath,
    // The whole 85M-character text is assembled inside the child, so it gets a
    // heap to hold it — the default has no business being enough for a prompt
    // three times the flagship model's context.
    ['--max-old-space-size=1024', '--input-type=module', '-e', CHILD,
      JSON.stringify({ paths: ['src/**/*.ts'], cwd: ROOT })],
    { cwd: ROOT, env: childEnv, encoding: 'utf8', timeout: 60_000 },
  ));
};

// ------------------------------------------------------------- the trap itself

test('a cap set to the bytes on disk is still cut: emitted text is longer than bytes read', () => {
  const bytes = FILES * LINE.length * 3_000; // 79,200,000 — exactly what `du` reports
  const r = run(bytes);
  // 372 / 1 / 28, measured: 371 files arrive whole, the 372nd arrives truncated
  // mid-body (it is `src/f73.ts` — the 372nd spelling in the walk's sorted
  // order), and the 28 after it are never read. Every number exact, so a drift
  // of one file in either direction fails here rather than hiding inside a
  // range. Re-measure if the fixture changes; these are the walk's answers for
  // THIS fixture at THIS cap, not constants of nature.
  assert.equal(
    r.delivered, 372,
    `${FILES} files of ${bytes} bytes assemble to more than ${bytes} CHARACTERS once numbered ` +
      `and headered, and the cap sized to the byte count delivered ${r.delivered} of them — ` +
      `the trap still cuts, but no longer where it did when this number was pinned`,
  );
  assert.equal(
    r.truncated, 1,
    `exactly one file — the one the cap landed on — must be delivered truncated, not dropped ` +
      `whole, and only one: ${JSON.stringify(r.notes)}`,
  );
  assert.equal(
    r.unread, 28,
    `the files after the cut were never read: ${r.unread} of the ${FILES} on disk arrived ` +
      `with no header at all, against the 28 this pin holds — measured from the directory, ` +
      `not as arithmetic on the delivered count`,
  );
  assert.ok(
    r.notes.some((n) => /truncated at \d+ total chars/.test(n)),
    `the cut must be said, naming the cap: ${JSON.stringify(r.notes)}`,
  );
  assert.ok(r.chars <= bytes, `assembled text is ${r.chars} chars against a ${bytes}-char cap`);
});

// ------------------------------------------- the README's disclosure, kept honest

test('the cap the README discloses for its measured run admits the whole workload it names', () => {
  const disclosed = README.match(/`GLM_MCP_MAX_FILE_CHARS`\s+raised to\s+([\d,]+)/);
  assert.ok(
    disclosed,
    'the README must disclose the cap its measured run used — an undisclosed cap is how a ' +
      'benchmark comes to describe a workload it truncated instead of the one it read',
  );
  const cap = Number(disclosed[1].replace(/,/g, ''));
  const r = run(cap);
  assert.equal(
    r.delivered, FILES,
    `the README names a ${FILES}-file read measured under GLM_MCP_MAX_FILE_CHARS=${cap}, and ` +
      `that run delivered ${r.delivered} of them — the disclosure and the behaviour have drifted apart`,
  );
  assert.equal(r.truncated, 0, `nothing arrived truncated: ${JSON.stringify(r.notes)}`);
  assert.equal(
    r.unread, 0,
    `every file on disk arrived with a header: ${r.unread} did not — the disclosure and ` +
      `the behaviour have drifted apart`,
  );
  assert.ok(
    !r.notes.some((n) => /truncated at/.test(n)),
    `no truncation note may stand over a run the README reports as reading the whole tree: ${JSON.stringify(r.notes)}`,
  );
});

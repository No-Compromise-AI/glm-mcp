// verify-limits.mjs — acceptance gate for the resource limits of decision 5
// (#15, #16, #17, #19) in glm-mcp-design/TRUST-BOUNDARY.md.
//
// Every row of decision 5's table has to actually fire here and say so in
// notes. "Hitting any limit stops that operation and records why in notes.
// Silent truncation is the failure mode this project has spent the most effort
// eliminating; do not introduce one here."
//
//   per-file size, stat'd BEFORE the read   GLM_MCP_MAX_FILE_BYTES        5 MB   #15
//   regular files only (no FIFO/dev/sock)   —                              —     #15
//   walk depth                              GLM_MCP_MAX_DEPTH             24     #16
//   directory entries examined per call     GLM_MCP_MAX_ENTRIES      200,000     #16
//   wall-clock budget for expansion         GLM_MCP_GLOB_TIMEOUT_MS   10,000     #16
//   total brace expansions                  GLM_MCP_MAX_BRACE_EXPANSIONS 1,024   #17
//   headers and separators counted in cap   —                              —     #19
//
// Contract this gate holds the implementation to, beyond the table itself:
//   * a note for an env-configurable limit NAMES its env var, so a caller who
//     trips one learns which knob to turn;
//   * a limit stops the operation that hit it and leaves the rest of the call
//     alone, exactly as a refused path does (decision 2);
//   * an unparsable env value falls back to the documented default — a cap a
//     typo silently removes is not a cap;
//   * buildFileContext never throws, however hostile the input.
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync,
  openSync, ftruncateSync, closeSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (msg) => { throw new Error(msg); };
const GLM = pathToFileURL(new URL('../dist/glm.js', import.meta.url).pathname).href;
const skipped = [];

// rss is sampled around the call: the "stat before reading" row is the
// difference between bounding a read and materialising it first.
const CHILD = `
import { buildFileContext } from ${JSON.stringify(GLM)};
const job = JSON.parse(process.argv[1]);
const rss0 = process.memoryUsage().rss;
const started = process.hrtime.bigint();
const r = buildFileContext(job.paths, job.cwd);
process.stdout.write(JSON.stringify({
  text: String(r.text ?? ''),
  notes: (r.notes ?? []).map(String),
  refusedCall: r.refusedCall === true,
  ms: Number(process.hrtime.bigint() - started) / 1e6,
  rssMB: (process.memoryUsage().rss - rss0) / 1048576,
}));
`;

function ctx({ paths, cwd, roots, env = {}, timeoutMs = 60_000 }) {
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (k.startsWith('GLM_MCP_')) delete childEnv[k];
  if (roots !== undefined) childEnv.GLM_MCP_ROOTS = roots;
  for (const [k, v] of Object.entries(env)) childEnv[k] = String(v);
  let out;
  try {
    out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', CHILD, JSON.stringify({ paths, cwd })],
      { cwd, env: childEnv, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    if (e.killed) fail(`buildFileContext(${JSON.stringify(paths)}) did not return within ${timeoutMs}ms — a limit must stop it, not the clock`);
    fail(`buildFileContext(${JSON.stringify(paths)}) threw — limits are notes, never throws\n${e.stderr || e.message}`);
  }
  try {
    return JSON.parse(out);
  } catch {
    return fail(`child produced no parsable result for ${JSON.stringify(paths)}: ${out}`);
  }
}

const show = (r) => `text.length=${r.text.length} notes=${JSON.stringify(r.notes)} ms=${Math.round(r.ms)}`;
const noteHas = (r, needle) => r.notes.some((n) => n.includes(needle));
// An env-configurable limit reports itself by name.
function firesNaming(r, envVar, what) {
  if (!noteHas(r, envVar)) fail(`${what}: the limit must fire and name ${envVar} in notes — ${show(r)}`);
}
function quiet(r, envVar, what) {
  if (noteHas(r, envVar)) fail(`${what}: ${envVar} must not fire here — ${show(r)}`);
}
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ---------------------------------------------------------------- fixtures
const RAW = mkdtempSync(join(tmpdir(), 'glm-limits-'));
const ROOT = realpathSync.native(RAW);
const WORK = join(ROOT, 'work');
const at = (...p) => join(WORK, ...p);
const sparse = (rel, bytes) => {
  const fd = openSync(at(rel), 'w');
  ftruncateSync(fd, bytes);
  closeSync(fd);
};
let socket;

try {
  mkdirSync(WORK, { recursive: true });
  writeFileSync(at('small.txt'), 'SMALL-FILE-BODY');
  writeFileSync(at('over-4k.txt'), 'X'.repeat(4096));
  sparse('mb1.bin', 1 * 1024 * 1024);
  sparse('mb6.bin', 6 * 1024 * 1024);
  sparse('mb512.bin', 512 * 1024 * 1024);

  // An all-emoji body: every code point is a surrogate pair, so any odd-sized
  // truncation window bisects one. Testing three adjacent caps guarantees at
  // least one window is odd whatever the header costs.
  writeFileSync(at('emoji.txt'), '\u{1F600}'.repeat(300));

  mkdirSync(at('braces'), { recursive: true });
  writeFileSync(at('braces/one.ts'), 'BRACE-ONE');
  writeFileSync(at('braces/two.ts'), 'BRACE-TWO');

  // Depth: one file just below the surface, one far past any sane default.
  mkdirSync(at('deep/d1/d2/d3'), { recursive: true });
  writeFileSync(at('deep/d1/d2/d3/shallow.txt'), 'SHALLOW-BODY');
  const deepPath = at('deep', ...Array.from({ length: 30 }, (_, i) => `n${i}`));
  mkdirSync(deepPath, { recursive: true });
  writeFileSync(join(deepPath, 'bottom.txt'), 'BOTTOM-BODY');

  // Breadth: enough directories that a 1 ms budget cannot be beaten and a
  // small entry cap is reached well before the walk ends.
  for (let d = 0; d < 150; d++) {
    const dd = at('wide', `d${String(d).padStart(3, '0')}`);
    mkdirSync(dd, { recursive: true });
    for (let f = 0; f < 10; f++) writeFileSync(join(dd, `f${f}.txt`), '');
  }
  // Two directories under 100 entries each, over 100 together: the difference
  // between a per-pattern budget and the per-call budget the design specifies.
  for (const side of ['twoA', 'twoB']) {
    mkdirSync(at(side), { recursive: true });
    for (let f = 0; f < 60; f++) writeFileSync(at(side, `f${String(f).padStart(2, '0')}.txt`), '');
  }
  // Empty files: zero body bytes, one header each. The #19 bypass.
  mkdirSync(at('many'), { recursive: true });
  for (let f = 0; f < 300; f++) writeFileSync(at('many', `empty-${String(f).padStart(4, '0')}.txt`), '');

  execFileSync('mkfifo', [at('pipe')]);
  try {
    socket = createServer().listen(at('sock'));
  } catch (e) {
    skipped.push(`unix socket case: could not create one (${e.code || e.message})`);
  }

  const IN = { cwd: WORK, roots: WORK };

  // -------------------------------------- 1. per-file size, stat'd before read
  let r = ctx({ ...IN, paths: ['over-4k.txt', 'small.txt'], env: { GLM_MCP_MAX_FILE_BYTES: 1024 } });
  firesNaming(r, 'GLM_MCP_MAX_FILE_BYTES', 'a file over GLM_MCP_MAX_FILE_BYTES');
  if (r.text.includes('XXXX')) fail(`an oversize file must not be read — ${show(r)}`);
  if (!r.text.includes('SMALL-FILE-BODY')) fail(`an oversize file must not take its neighbours down — ${show(r)}`);

  r = ctx({ ...IN, paths: ['mb6.bin'] });
  firesNaming(r, 'GLM_MCP_MAX_FILE_BYTES', 'a 6 MB file against the 5 MB default');

  r = ctx({ ...IN, paths: ['mb1.bin'] });
  quiet(r, 'GLM_MCP_MAX_FILE_BYTES', 'a 1 MB file against the 5 MB default');

  // The row says "checked by stat BEFORE reading". Reading first and measuring
  // afterwards is what #15 reproduced at 852 MB resident for one file.
  r = ctx({ ...IN, paths: ['mb512.bin'], timeoutMs: 30_000 });
  firesNaming(r, 'GLM_MCP_MAX_FILE_BYTES', 'a 512 MB file');
  if (r.rssMB > 150) fail(`a 512 MB file grew rss by ${Math.round(r.rssMB)}MB — stat the size before reading, do not read then measure`);

  // A cap a typo silently removes is not a cap.
  r = ctx({ ...IN, paths: ['mb6.bin'], env: { GLM_MCP_MAX_FILE_BYTES: 'not-a-number' } });
  firesNaming(r, 'GLM_MCP_MAX_FILE_BYTES', 'an unparsable GLM_MCP_MAX_FILE_BYTES falling back to the default');

  // ------------------------------------------------- 2. regular files only
  // No writer will ever open this FIFO; readFileSync on it blocks forever.
  r = ctx({ ...IN, paths: ['pipe', 'small.txt'], timeoutMs: 15_000 });
  if (!r.notes.some((n) => /regular file/i.test(n))) fail(`a FIFO must be refused as not a regular file — ${show(r)}`);
  if (!r.text.includes('SMALL-FILE-BODY')) fail(`a FIFO must not take its neighbours down — ${show(r)}`);

  if (socket) {
    r = ctx({ ...IN, paths: ['sock'], timeoutMs: 15_000 });
    if (!r.notes.some((n) => /regular file/i.test(n))) fail(`a unix socket must be refused as not a regular file — ${show(r)}`);
  }

  // Rooted at '/' so the device is inside the boundary and the only thing that
  // can refuse it is the regular-file rule.
  r = ctx({ paths: ['/dev/zero'], cwd: WORK, roots: '/', timeoutMs: 15_000 });
  if (!r.notes.some((n) => /regular file/i.test(n))) fail(`a character device must be refused as not a regular file — ${show(r)}`);
  if (r.text.length > 4096) fail(`/dev/zero was read into the prompt — ${r.text.length} chars`);

  // ------------------------------------------------------------ 3. walk depth
  r = ctx({ ...IN, paths: ['deep/**/*.txt'], env: { GLM_MCP_MAX_DEPTH: 3 } });
  firesNaming(r, 'GLM_MCP_MAX_DEPTH', 'a walk past GLM_MCP_MAX_DEPTH=3');
  if (r.text.includes('BOTTOM-BODY')) fail(`a file 30 levels down must not be reached at depth 3 — ${show(r)}`);

  r = ctx({ ...IN, paths: ['deep/**/*.txt'] });
  firesNaming(r, 'GLM_MCP_MAX_DEPTH', 'a walk 30 levels deep against the default of 24');
  if (r.text.includes('BOTTOM-BODY')) fail(`a file 30 levels down must not be reached at the default depth — ${show(r)}`);
  if (!r.text.includes('SHALLOW-BODY')) fail(`a shallow file must survive the depth cut-off — ${show(r)}`);

  // ------------------------------------------- 4. directory entries per call
  r = ctx({ ...IN, paths: ['wide/**/*.txt'], env: { GLM_MCP_MAX_ENTRIES: 100 } });
  firesNaming(r, 'GLM_MCP_MAX_ENTRIES', 'a walk past GLM_MCP_MAX_ENTRIES=100');

  // Per call, not per pattern: 60 + 60 exceeds 100 although neither half does.
  r = ctx({ ...IN, paths: ['twoA/*.txt', 'twoB/*.txt'], env: { GLM_MCP_MAX_ENTRIES: 100 } });
  firesNaming(r, 'GLM_MCP_MAX_ENTRIES', 'two patterns of 60 entries against a 100-entry call budget');

  r = ctx({ ...IN, paths: ['wide/**/*.txt'] });
  quiet(r, 'GLM_MCP_MAX_ENTRIES', '1,500 entries against the 200,000 default');

  // --------------------------------------------------- 5. wall-clock budget
  r = ctx({ ...IN, paths: ['wide/**/*.txt'], env: { GLM_MCP_GLOB_TIMEOUT_MS: 1 } });
  firesNaming(r, 'GLM_MCP_GLOB_TIMEOUT_MS', 'a 150-directory walk against a 1 ms budget');

  r = ctx({ ...IN, paths: ['wide/**/*.txt'] });
  quiet(r, 'GLM_MCP_GLOB_TIMEOUT_MS', 'a 150-directory walk against the 10 s default');

  // ------------------------------------------------- 6. brace expansions
  const braces = (n) => `nowhere/${'{a,b}'.repeat(n)}/*.txt`;
  r = ctx({ ...IN, paths: [braces(12)], timeoutMs: 20_000 });
  firesNaming(r, 'GLM_MCP_MAX_BRACE_EXPANSIONS', '4,096 brace combinations against the 1,024 default');
  if (r.ms > 2_000) fail(`4,096 brace combinations took ${Math.round(r.ms)}ms — refuse before expanding, not after`);

  // #17's second failure mode: at ~18 groups the spread-push overflows the
  // stack. The cap has to bite before the RangeError can happen.
  r = ctx({ ...IN, paths: [braces(20)], timeoutMs: 20_000 });
  firesNaming(r, 'GLM_MCP_MAX_BRACE_EXPANSIONS', 'a million brace combinations');
  if (r.ms > 2_000) fail(`a million brace combinations took ${Math.round(r.ms)}ms — refuse before expanding`);

  r = ctx({ ...IN, paths: [braces(12)], env: { GLM_MCP_MAX_BRACE_EXPANSIONS: 8192 } });
  quiet(r, 'GLM_MCP_MAX_BRACE_EXPANSIONS', '4,096 combinations under a raised cap');

  r = ctx({ ...IN, paths: [braces(20)], env: { GLM_MCP_MAX_BRACE_EXPANSIONS: 'not-a-number' }, timeoutMs: 20_000 });
  firesNaming(r, 'GLM_MCP_MAX_BRACE_EXPANSIONS', 'an unparsable cap falling back to the default');

  // Ordinary brace use is settled behaviour from #3 and must not regress.
  r = ctx({ ...IN, paths: ['braces/{one,two}.ts'] });
  if (!r.text.includes('BRACE-ONE') || !r.text.includes('BRACE-TWO')) {
    fail(`a two-way brace pattern must still expand — ${show(r)}`);
  }

  // ------------------------------- 7. headers and separators count toward the cap
  // 300 empty files contribute no body bytes and 300 headers. Before #19 that
  // produced a five-figure prompt under an 800,000-char "cap" without a word
  // in notes.
  const CAP = 2000;
  r = ctx({ ...IN, paths: ['many/*.txt'], env: { GLM_MCP_MAX_FILE_CHARS: CAP } });
  if (!r.notes.some((n) => /truncat/i.test(n))) {
    fail(`headers alone exceeded the cap and must be truncated and noted — ${show(r)}`);
  }
  if (r.text.length > CAP) fail(`assembled text is ${r.text.length} chars against a ${CAP}-char cap — headers and separators must count`);

  writeFileSync(at('three-hundred.txt'), 'B'.repeat(300));
  r = ctx({ ...IN, paths: ['three-hundred.txt', 'many/*.txt'], env: { GLM_MCP_MAX_FILE_CHARS: 500 } });
  if (r.text.length > 500) fail(`assembled text is ${r.text.length} chars against a 500-char cap — ${show(r)}`);

  // Truncation must not bisect a surrogate pair. One of three adjacent caps
  // necessarily leaves an odd-sized window over a body of surrogate pairs.
  for (const cap of [100, 101, 102]) {
    r = ctx({ ...IN, paths: ['emoji.txt'], env: { GLM_MCP_MAX_FILE_CHARS: cap } });
    if (LONE_SURROGATE.test(r.text)) {
      fail(`truncating at ${cap} chars split a surrogate pair — truncate on code points, not code units`);
    }
    if (!r.notes.some((n) => /truncat/i.test(n))) fail(`truncating at ${cap} chars must be noted — ${show(r)}`);
  }
} finally {
  if (socket) socket.close();
  rmSync(ROOT, { recursive: true, force: true });
}

for (const s of skipped) console.log(`note: skipped ${s}`);
console.log('LIMITS OK');

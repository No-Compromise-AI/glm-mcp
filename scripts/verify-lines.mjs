// verify-lines.mjs — acceptance gate for file context the model can cite (#53).
//
// buildFileContext emits `--- path ---` and then raw file text. No line numbers
// reach the model. The README's own example of a good answer is
//
//     session.ts:88 reads `expiresAt` before taking the lock
//
// and GLM-5.3, reviewing this server, pointed out that IT is the thing expected
// to produce that 88 — while counting lines it cannot see, which models are
// reliably bad at. The package documents a capability its input format does not
// support. Either the format grows line numbers or the README stops promising
// answers that need them, and the first is better.
//
// The rules are about what the model can CITE, not about a format:
//
//   1. every line carries its own number, and the number is that line's real
//      position — checked against a fixture whose content states its own line
//      numbers, so an off-by-one cannot pass;
//   2. a range argument sends that range and numbers it with the FILE's
//      numbers, not the excerpt's — an excerpt renumbered from 1 is worse than
//      no numbers, because a citation off it points confidently at the wrong
//      place;
//   3. the budget counts what is actually emitted. Numbering makes the text
//      longer than the bytes read, and a cap measured against the raw body
//      would overshoot silently — #19's whole subject;
//   4. a path that really exists is read literally even when its name ends in
//      something a range could be parsed out of, the same rule literal paths
//      already have against glob characters (#13);
//   5. a range that names nothing readable is answered in the CALLER's own
//      spelling, and says nothing about what exists (#26, #40).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (msg) => { throw new Error(msg); };
const GLM = pathToFileURL(new URL('../dist/glm.js', import.meta.url).pathname).href;
const SENTINEL = '<<<RESULT>>>';

function child(body, env = {}, timeoutMs = 60_000) {
  const src = `
import * as glm from ${JSON.stringify(GLM)};
const out = {};
try {
${body}
} catch (e) {
  out.threw = String(e && e.message ? e.message : e);
}
process.stdout.write(${JSON.stringify(SENTINEL)} + JSON.stringify(out), () => process.exit(0));
`;
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (/^(GLM_MCP_|ZAI_)/.test(k)) delete childEnv[k];
  childEnv.ZAI_API_KEY = 'dummy-key-for-the-local-server';
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = String(v);
  }
  let out = '';
  try {
    out = execFileSync(process.execPath, ['--input-type=module', '-e', src],
      { encoding: 'utf8', env: childEnv, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (e.killed) fail(`a case did not return within ${timeoutMs}ms`);
    out = e.stdout ?? '';
    if (!out.includes(SENTINEL)) fail(`child failed\n${e.stderr || e.message}`);
  }
  const at = out.indexOf(SENTINEL);
  if (at < 0) fail(`unparsable child output: ${out.slice(0, 400)}`);
  return JSON.parse(out.slice(at + SENTINEL.length));
}

const ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-lines-')));

try {
  // A fixture that states its own line numbers, so the emitted numbering is
  // checked against the CONTENT rather than against this gate's arithmetic.
  // An off-by-one is then a disagreement between the file and the prompt, which
  // is exactly the error a caller would suffer.
  const LINES = 200;
  const body = Array.from({ length: LINES }, (_, i) => `content of line ${i + 1} here`).join('\n');
  writeFileSync(join(ROOT, 'numbered.txt'), body);

  const read = (args, env = {}) => {
    const r = child(`
process.env.GLM_MCP_ROOTS = ${JSON.stringify(ROOT)};
const c = glm.buildFileContext(${JSON.stringify(args)}, ${JSON.stringify(ROOT)});
out.text = c.text; out.notes = c.notes; out.refused = c.refusedCall;`, env);
    if (r.threw) fail(`buildFileContext(${JSON.stringify(args)}) threw — ${r.threw}`);
    return r;
  };

  // The number a given line was shown with: find the line of output carrying
  // that content and read the digits in front of it. Format-agnostic on
  // purpose — `cat -n` alignment, a colon, a pipe, a tab are all fine, and
  // pinning one would be pinning a spelling rather than the property.
  const shownNumber = (text, n) => {
    const marker = `content of line ${n} here`;
    const line = text.split('\n').find((l) => l.includes(marker));
    if (line === undefined) return { missing: true };
    const before = line.slice(0, line.indexOf(marker));
    const digits = before.match(/(\d+)\D*$/);
    return digits ? { num: Number(digits[1]) } : { unnumbered: true, line };
  };

  // ------------------------------- rule 1: every line carries its real number
  {
    const r = read(['numbered.txt']);
    for (const n of [1, 2, 42, 99, 100, LINES]) {
      const got = shownNumber(r.text, n);
      if (got.missing) fail(`#53: line ${n} of the fixture is missing from the assembled context entirely — ${JSON.stringify(r.notes)}`);
      if (got.unnumbered) {
        fail(`#53: the context still emits raw file text — line ${n} arrived as ${JSON.stringify(got.line.slice(0, 60))} with no number in front of it. The README's own example answer cites "session.ts:88", and the model is being asked to produce that 88 by counting lines it cannot see.`);
      }
      if (got.num !== n) {
        fail(`#53: the fixture's line ${n} was numbered ${got.num}. The file says which line it is and the prompt disagrees — a citation off this context points at the wrong place, which is worse than no numbers at all.`);
      }
    }
  }

  // ------------- rule 2: a range sends that range, with the FILE's numbering
  {
    const r = read(['numbered.txt:40-60']);
    if (r.refused) fail(`#53: a line range was refused outright — ${JSON.stringify(r.notes)}. Ranges are how a region is sent without the whole file.`);

    const inside = shownNumber(r.text, 40);
    if (inside.missing) {
      fail(`#53: "numbered.txt:40-60" did not deliver line 40 — ${JSON.stringify(r.notes)}. Either the range was not understood, or it was read as a filename.`);
    }
    if (inside.unnumbered) fail(`#53: the ranged excerpt carries no line numbers — ${JSON.stringify(inside.line.slice(0, 60))}`);
    if (inside.num !== 40) {
      fail(`#53: the first line of "numbered.txt:40-60" was numbered ${inside.num}, but it is line 40 of the file. An excerpt renumbered from 1 is worse than no numbers: a citation off it is confidently wrong, and the caller cannot tell.`);
    }

    // The range is a range: what is outside it must not arrive.
    if (!shownNumber(r.text, 39).missing || !shownNumber(r.text, 61).missing) {
      fail(`#53: "numbered.txt:40-60" delivered lines outside 40-60. The point of a range is sending a region without the whole file — it also cuts prefill, which is why #51 wants this first.`);
    }
    if (shownNumber(r.text, 60).missing) fail('#53: the range excluded its own last line — 40-60 must include 60');
  }

  // ------------------------- rule 3: the budget counts what is actually sent
  // Numbering makes the emitted text longer than the bytes read. A cap measured
  // against the raw body would overshoot by exactly the numbering, silently,
  // which is the failure #19 exists to prevent.
  {
    const cap = 2_000;
    const r = read(['numbered.txt'], { GLM_MCP_MAX_FILE_CHARS: cap });
    if (r.text.length > cap) {
      fail(`#53: with GLM_MCP_MAX_FILE_CHARS=${cap} the assembled context is ${r.text.length} chars. The cap has to bound what is EMITTED, numbering included — measuring the raw body instead overshoots by the width of every number added, and #19 is about a budget that quietly grows to fit its own bookkeeping.`);
    }
    if (!(r.notes ?? []).some((n) => /truncat/i.test(n))) {
      fail(`#53: the cap bound the text but nothing said so — ${JSON.stringify(r.notes)}`);
    }
  }

  // ---- rule 4: a real file whose name looks like a range is read literally
  // The same rule a literal path already has against glob characters (#13):
  // what exists on disk wins over what the syntax could mean.
  {
    const odd = 'weird:10-20.txt';
    writeFileSync(join(ROOT, odd), 'the whole of a file that is named like a range\n');
    const r = read([odd]);
    if (!r.text.includes('the whole of a file that is named like a range')) {
      fail(`#53: "${odd}" exists on disk and was not read — ${JSON.stringify(r.notes)}. A path that exists is used literally even when it contains characters the syntax would otherwise claim; that is already the rule for glob characters, and a range suffix cannot be greedier than a glob.`);
    }
  }

  // ---- rule 5: a range naming nothing readable answers in the caller's words
  {
    const spelling = 'no-such-file.txt:1-5';
    const r = read([spelling]);
    const said = (r.notes ?? []).join(' ');
    if (!said.includes(spelling)) {
      fail(`#53: a range that matched nothing was answered without the caller's own spelling — ${JSON.stringify(r.notes)}. #13 and #40: the note names the argument the caller sent, so it knows which of its arguments did not arrive.`);
    }
    const homeish = [process.env.HOME, ROOT].filter(Boolean);
    for (const secret of homeish) {
      if (said.includes(secret)) {
        fail(`#53: the note for a missing range names ${JSON.stringify(secret)} — this machine's layout is not the caller's business (#26).`);
      }
    }
  }

  // ------------------------------ rule 6: the README stops over-promising
  // #53's own framing: either the format grows line numbers or the README
  // stops documenting answers that need them. Having done the first, say so —
  // a caller that does not know the numbers are there will not ask for
  // citations, and a caller that does not know ranges exist sends whole files.
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  if (!/line number/i.test(readme)) {
    fail('#53: the README never mentions that file context carries line numbers. Its example answer already cites "session.ts:88", so it promised the capability before the format had it; now that the format has it, the promise should be a description.');
  }
  if (!/\d+-\d+|line range/i.test(readme)) {
    fail('#53: the README documents no way to send a line range, so callers keep sending whole files — which is the prefill this was partly meant to cut.');
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log('LINES OK');

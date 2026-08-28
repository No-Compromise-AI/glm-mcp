// glm_review beyond what scripts/verify-review.mjs drives (#65).
//
// The gate is the specification and already covers the refusal, the spec
// reaching the model, both pathologies in the prompt, and the rubber stamp —
// bare and behind a long prompt alike. What it does not exercise, and these
// tests do: the verdict extraction itself (last line wins, none found), the
// floor's env knob, the prompt's shape with and without each kind of
// material, a reply that never delivers a verdict at all, and the files
// route going through glm_ask's own resolver.
//
// npm test's file list is fixed in package.json's "test" script, so this
// file is run directly:  node --test test/review.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  buildReviewPrompt,
  minSubstance,
  substanceOf,
  verdictOf,
} from '../dist/review.js';

const INDEX = new URL('../dist/index.js', import.meta.url).pathname;

// ------------------------------------------------------- the verdict line

test('verdictOf reads the last verdict line and nothing less exact', () => {
  assert.equal(verdictOf('analysis\nVERDICT: PASS'), 'PASS');
  assert.equal(verdictOf('VERDICT: PASS\nreconsidered below\nVERDICT: CHANGES_REQUIRED'),
    'CHANGES_REQUIRED', 'the final word wins, as bin/glm-review\'s tail -1 has it');
  // Strict on purpose. bin/glm-review parses with
  // `grep -oE '^VERDICT: (PASS|CHANGES_REQUIRED)$'`, so anything this accepts
  // that the grep rejects is a reply the shell tools cannot read — the exact
  // drift this tool exists to remove.
  assert.equal(verdictOf('  VERDICT: PASS'), undefined, 'indented is not the canonical spelling');
  assert.equal(verdictOf('VERDICT:PASS'), undefined, 'the single space is part of the spelling');
  assert.equal(verdictOf('VERDICT: PASS\r'), undefined, 'a CR is not the canonical spelling either');
  // The verdict must END the reply, not merely appear in it: a verdict accepted
  // from the middle is one that can be accepted from a reply the output cap
  // severed just after it.
  assert.equal(verdictOf('VERDICT: PASS\nstill thinking about it'), undefined,
    'a verdict followed by more prose is not the reply\'s final word');
  assert.equal(verdictOf('analysis\nVERDICT: PASS\n\n  \n'), 'PASS',
    'trailing blank lines are manners, not meaning');
  assert.equal(verdictOf('VERDICT: PASSISH'), undefined, 'a longer word is not the verdict');
  assert.equal(verdictOf('The verdict: pass, in prose.'), undefined, 'prose is not a verdict line');
  assert.equal(verdictOf(''), undefined);
});

// ------------------------------------------------- the substance floor

test('substanceOf measures the reply with the verdict taken out', () => {
  assert.equal(substanceOf('VERDICT: PASS'), 0, 'the recorded rubber stamp measures nothing');
  assert.equal(substanceOf('VERDICT: CHANGES_REQUIRED'), 0);
  assert.equal(substanceOf('   \n\nVERDICT: PASS\n\n  '), 0,
    'whitespace around a verdict is not analysis');
  const prose = 'session.ts:88 reads expiresAt before the lock at :94, so two callers both refresh.';
  assert.equal(substanceOf(`${prose}\n\nVERDICT: CHANGES_REQUIRED`), prose.length,
    'the analysis is measured as written, verdict line aside');
});

test('minSubstance defaults to 200 and follows the env knob', () => {
  const saved = process.env.GLM_REVIEW_MIN_SUBSTANCE;
  try {
    delete process.env.GLM_REVIEW_MIN_SUBSTANCE;
    assert.equal(minSubstance(), 200, 'bin/glm-review\'s own default');
    process.env.GLM_REVIEW_MIN_SUBSTANCE = '50';
    assert.equal(minSubstance(), 50);
    process.env.GLM_REVIEW_MIN_SUBSTANCE = 'not a number';
    assert.equal(minSubstance(), 200, 'an unparsable value is an absent limit, never a zero one');
  } finally {
    if (saved === undefined) delete process.env.GLM_REVIEW_MIN_SUBSTANCE;
    else process.env.GLM_REVIEW_MIN_SUBSTANCE = saved;
  }
});

// -------------------------------------------------------- the prompt

test('buildReviewPrompt carries the spec verbatim and warns off both pathologies', () => {
  const spec = 'SPEC-SENTINEL «verbatim»:\nrequire the answer to be 42 — exactly.';
  const p = buildReviewPrompt({ diff: '--- a/f\n+++ b/f\n', spec });
  assert.ok(p.includes(spec), 'the spec is the caller\'s own statement of intent, untransformed');
  // The gate's own regexes, asserted here so the prompt cannot drift between
  // gate runs.
  assert.match(p, /fabricat|invent|pad(ded|ding)?\b|do not manufactur/i,
    'nothing warns against padded or fabricated findings');
  assert.match(p, /stub|mock|hardcod/i,
    'nothing tells the reviewer to hunt stubbed, mocked or hardcoded work');
  assert.ok(p.includes('VERDICT: PASS') && p.includes('VERDICT: CHANGES_REQUIRED'),
    'the reply must be required to end in the shared vocabulary');
  assert.ok(p.includes('--- DIFF'), 'a supplied diff is presented as the change');
  assert.ok(p.includes('no written spec supplied') === false,
    'a given spec must replace the no-spec placeholder');
});

test('buildReviewPrompt names a missing spec and drops empty sections', () => {
  const p = buildReviewPrompt({ diff: '--- a/f\n+++ b/f\n' });
  assert.ok(p.includes('no written spec supplied'),
    'the reviewer must know it is inferring intent instead of checking it');
  assert.ok(!p.includes('--- FILES'), 'no file context, no files section');
  const withFiles = buildReviewPrompt({ fileContext: '--- src/a.ts ---\nbody' });
  assert.ok(withFiles.includes('--- FILES'), 'file context is presented as surrounding context');
  assert.ok(withFiles.includes('--- DIFF') === false, 'no diff, no diff section');
});

// ------------------------------------------- through the tool, against a stub

// The stand-in for z.ai, in the gate's own shape: `seen` records every
// request body so the tests can read what was actually sent.
function stub() {
  const seen = [];
  let reply = 'placeholder';
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        model: 'glm-5.3',
        content: [{ type: 'text', text: reply }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
    });
  });
  return {
    server, seen,
    setReply: (t) => { reply = t; },
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
  };
}

const SUBSTANTIVE = 'session.ts:88 reads expiresAt before taking the lock at :94, so two\n'
  + 'callers can both see it expired and both refresh; swapping the two lines\n'
  + 'closes the race. The spec asked for single-flight refresh and nothing in\n'
  + 'the change enforces it, and no test covers the concurrent path at all.\n\nVERDICT: CHANGES_REQUIRED';

test('glm_review refuses, relays, and stamps as the gate demands — and more', async () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'glm-review-test-')));
  writeFileSync(join(work, 'changed.ts'), 'export const answer = 42;\n');

  const up = stub();
  const origin = await up.listen();
  const client = new Client({ name: 'glm-review-test', version: '1' }, { capabilities: {} });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [INDEX],
      // The startup cwd is the default confinement boundary, so relative
      // files under `work` resolve inside it without configuring roots.
      cwd: work,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ZAI_API_KEY: 'dummy-key-for-the-local-server',
        ZAI_BASE_URL: origin,
      },
    }));

    const call = (args) => client.callTool({ name: 'glm_review', arguments: args })
      .then((r) => ({ isError: r.isError, text: r.content?.map((c) => c.text ?? '').join('\n') ?? '' }),
        (e) => ({ isError: true, text: String(e.message ?? e) }));

    // Neither diff nor files: refused, and the model is never asked — the
    // gate reads the refusal, this reads the absence of a request.
    const empty = await call({ spec: 'anything' });
    assert.ok(empty.isError, 'a review of nothing must not come back as a result');
    assert.match(empty.text, /refus/i);
    assert.equal(up.seen.length, 0, 'the refusal happens before the model is called');

    // Files that name nothing readable are the same refusal one step later.
    const matchless = await call({ files: ['zz-nothing-*.ts'] });
    assert.ok(matchless.isError, 'files that matched nothing leave no material to review');
    assert.equal(up.seen.length, 0, 'no material means no request');

    // A real review: the spec reaches the model verbatim, the file arrives
    // through glm_ask's own resolver, and the analysis comes back intact
    // with the verdict as its last line and the footer behind it.
    up.setReply(SUBSTANTIVE);
    const real = await call({
      files: ['changed.ts'],
      spec: 'SPEC-SENTINEL-7f3a: the answer must become 42.',
    });
    assert.ok(!real.isError, `a substantive review must come back intact — ${real.text.slice(0, 200)}`);
    const sent = up.seen[up.seen.length - 1]?.body;
    assert.ok(JSON.stringify(sent).includes('SPEC-SENTINEL-7f3a'),
      'the spec never reached the model');
    assert.ok(sent?.messages?.[0]?.content?.includes('--- changed.ts ---'),
      'the named file never reached the model through glm_ask\'s resolver');
    assert.match(real.text, /^VERDICT: CHANGES_REQUIRED$/m, 'the verdict stays the reply\'s own last line');
    assert.match(real.text, /\n\[glm-5\.3/, 'the usage footer follows the analysis');

    // A reply with analysis but no verdict is a shape error: every consumer
    // reads the verdict line first.
    up.setReply('The lock is taken after the read; the race is real and the fix is a\n'
      + 'two-line swap. No verdict follows this sentence.');
    const noVerdict = await call({ diff: '--- a/f\n+++ b/f\n@@\n-x\n+y\n' });
    assert.ok(noVerdict.isError, 'a verdict-less reply must not relay as a clean review');
    assert.match(noVerdict.text, /without a verdict/i);

    // The rubber stamp, refused with the floor named.
    up.setReply('VERDICT: PASS');
    const stamp = await call({ diff: '--- a/f\n+++ b/f\n@@\n-x\n+y\n' });
    assert.ok(stamp.isError, 'a bare verdict is a rubber stamp, not a review');
    assert.match(stamp.text, /GLM_REVIEW_MIN_SUBSTANCE/, 'the refusal names the knob that floored it');
  } finally {
    await client.close().catch(() => {});
    up.server.close();
  }
});

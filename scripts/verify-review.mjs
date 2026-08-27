// verify-review.mjs — acceptance gate for glm_review (#65).
//
// Why the tool exists: the review half of the delegate → review loop currently
// lives in bin/glm-review, a bash script that only a shell can call. Claude,
// Codex and Antigravity can all reach this server, so putting the review prompt
// here is what stops it being hand-rolled three times and drifting three ways.
//
// Why this gate is strict about ONE thing above all: a reviewer that returns
// "looks good" is worse than no reviewer, because it converts an unexamined
// change into a change with a clean bill of health. That is not hypothetical
// here — the scorecard for this toolchain records a reviewer returning a bare
// 14-byte `VERDICT: PASS` with zero analysis while a real bug was present.
// bin/glm-review answers that with a substance floor, and the floor is the part
// of it most worth carrying across.
//
// The rules:
//
//   1. The tool is advertised, and its own description tells a caller it
//      returns a verdict — a review tool whose output shape is a surprise
//      cannot be consumed by anything but a human reading prose.
//   2. Called with neither a diff nor files, it REFUSES. Reviewing nothing and
//      reporting a pass is the failure mode this whole file is about.
//   3. The spec reaches the model when one is given. Review against intent is
//      the entire difference between this and "read the diff and opine"; the
//      recorded failure mode of the delegation loop is silent scope-narrowing,
//      which only a spec can catch.
//   4. The prompt warns against BOTH recorded reviewer pathologies: padded or
//      fabricated findings, and work that is stubbed, mocked or hardcoded
//      rather than implemented.
//   5. A model reply with no analysis behind it is NOT relayed as a pass. This
//      is the rubber-stamp rule and it is checked by driving a stub upstream
//      that returns exactly that.
//   7. A reply the output cap SEVERED is never relayed as a review, even when
//      it already contains a verdict. Found in review: the truncation check sat
//      inside the no-verdict branch, so a capped reply that had written its
//      verdict early came back as a clean review and a downstream grep read an
//      interrupted review as approval.
//   8. The verdict spelling this tool accepts is EXACTLY the spelling
//      bin/glm-review can parse. Read out of that script's own grep rather than
//      copied, so the two cannot drift. Also found in review: `VERDICT:PASS`
//      was accepted here and is unparsable there, which is the drift the tool
//      exists to remove.
//   6. And the rule that forbids the wrong fix: the floor must measure the
//      MODEL'S REPLY, not the prompt. A floor satisfied by a long prompt is not
//      a floor at all — it would pass every rubber stamp ever sent, which is
//      precisely the bug, reintroduced while looking fixed.
//
// A structural change this gate cannot read is a failure, not a pass.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fail = (msg) => { throw new Error(msg); };

// A stub standing in for z.ai. `reply` is what the "model" says, so a case can
// hand back a rubber stamp on purpose; `seen` is every request body, so the gate
// can read what was actually sent rather than trusting that it was.
function stub() {
  const seen = [];
  let reply = 'placeholder';
  let stop = 'end_turn';
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        model: 'glm-5.3',
        content: [{ type: 'text', text: reply }],
        stop_reason: stop,
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
    });
  });
  return {
    server, seen,
    setReply: (t) => { reply = t; },
    setStop: (t) => { stop = t; },
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
  };
}

// bin/glm-review's own parser, read rather than restated. If that grep changes,
// this gate changes with it and rule 8 keeps meaning what it says.
const SHELL = readFileSync(new URL('../bin/glm-review', import.meta.url), 'utf8');
const grepLine = SHELL.split('\n').find((l) => l.includes("grep -oE") && l.includes('VERDICT'))
  ?? fail('rule 8: cannot find bin/glm-review\'s verdict grep — this gate can no longer compare the two parsers');
const ere = grepLine.match(/'([^']*VERDICT[^']*)'/)?.[1]
  ?? fail(`rule 8: cannot read the ERE out of bin/glm-review's grep line: ${grepLine.trim()}`);
const SHELL_VERDICT = new RegExp(ere);
const SPELLINGS = ['VERDICT: PASS', 'VERDICT:PASS', '  VERDICT: PASS', 'VERDICT:  PASS', 'VERDICT: CHANGES_REQUIRED'];

const work = realpathSync(mkdtempSync(join(tmpdir(), 'glm-review-gate-')));
writeFileSync(join(work, 'changed.ts'), 'export const answer = 42;\n');

const up = stub();
const origin = await up.listen();
const client = new Client({ name: 'verify-review', version: '1' }, { capabilities: {} });

let tools, results = {};
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../dist/index.js', import.meta.url).pathname],
    cwd: work,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ZAI_API_KEY: 'dummy-key-for-the-local-server',
      ZAI_BASE_URL: origin,
    },
  }));
  tools = (await client.listTools()).tools;

  const text = (r) => r.content?.map((c) => c.text ?? '').join('\n') ?? '';

  // no diff, no files
  results.empty = await client.callTool({ name: 'glm_review', arguments: { spec: 'anything' } }).then(
    (r) => ({ isError: r.isError, text: text(r) }), (e) => ({ isError: true, text: String(e.message ?? e) }));

  // a real review, with a spec, against a substantive reply
  up.setReply('The refresh path reads expiresAt before taking the lock, so two callers can both\n'
    + 'observe it as expired and both refresh. Line 88 of session.ts is where the read\n'
    + 'happens and line 94 is where the lock is taken; swapping them closes it.\n\nVERDICT: CHANGES_REQUIRED');
  results.real = await client.callTool({ name: 'glm_review', arguments: {
    diff: '--- a/changed.ts\n+++ b/changed.ts\n@@\n-export const answer = 41;\n+export const answer = 42;\n',
    spec: 'SPEC-SENTINEL-7f3a: the answer must become 42.',
  } }).then((r) => ({ isError: r.isError, text: text(r) }), (e) => ({ isError: true, text: String(e.message ?? e) }));
  results.realBody = up.seen[up.seen.length - 1]?.body;

  // the rubber stamp: a verdict with nothing behind it
  up.setReply('VERDICT: PASS');
  results.stamp = await client.callTool({ name: 'glm_review', arguments: {
    diff: '--- a/changed.ts\n+++ b/changed.ts\n@@\n-export const answer = 41;\n+export const answer = 42;\n',
    spec: 'SPEC-SENTINEL-7f3a: the answer must become 42.',
  } }).then((r) => ({ isError: r.isError, text: text(r) }), (e) => ({ isError: true, text: String(e.message ?? e) }));

  // the same rubber stamp behind a very long prompt — rule 6. If the floor were
  // measuring the prompt, this would pass where the case above failed.
  results.stampLongPrompt = await client.callTool({ name: 'glm_review', arguments: {
    diff: '--- a/changed.ts\n+++ b/changed.ts\n@@\n' + '-// padding\n+// padding\n'.repeat(400),
    spec: 'SPEC-SENTINEL-7f3a: ' + 'the answer must become 42. '.repeat(200),
  } }).then((r) => ({ isError: r.isError, text: text(r) }), (e) => ({ isError: true, text: String(e.message ?? e) }));
  // rule 7 — a severed reply, carrying a verdict AND ample analysis, so the
  // only thing that can refuse it is the truncation check itself.
  up.setStop('max_tokens');
  up.setReply('B'.repeat(400) + '\nVERDICT: PASS');
  results.capped = await client.callTool({ name: 'glm_review', arguments: {
    diff: '--- a\n+++ b\n@@\n-x\n+y\n', spec: 's',
  } }).then((r) => ({ isError: r.isError, text: text(r) }), (e) => ({ isError: true, text: String(e.message ?? e) }));
  up.setStop('end_turn');

  // rule 8 — one call per candidate spelling, each with ample analysis so the
  // substance floor cannot be what refuses it.
  results.spellings = {};
  for (const cand of SPELLINGS) {
    up.setReply('C'.repeat(400) + '\n' + cand);
    const r = await client.callTool({ name: 'glm_review', arguments: {
      diff: '--- a\n+++ b\n@@\n-x\n+y\n', spec: 's',
    } }).then((r) => ({ isError: r.isError }), () => ({ isError: true }));
    results.spellings[cand] = !r.isError;
  }
} finally {
  await client.close().catch(() => {});
  up.server.close();
}

let checks = 0;
const check = (ok, msg) => { checks++; if (!ok) fail(msg); };

// ------------------------------------------------------------------- rule 1
const tool = tools.find((t) => t.name === 'glm_review')
  ?? fail(`rule 1: no glm_review tool in the listing (saw: ${tools.map((t) => t.name).join(', ') || 'nothing'})`);
const advertised = [tool.description ?? '', ...Object.values(tool.inputSchema?.properties ?? {}).map((p) => p?.description ?? '')].join('\n');
check(/verdict/i.test(advertised),
  'rule 1: glm_review never says it returns a verdict, so a caller cannot know what shape the answer takes');

// ------------------------------------------------------------------- rule 2
check(results.empty.isError || /refus|requir|no (diff|change)/i.test(results.empty.text),
  `rule 2: called with neither diff nor files, glm_review answered instead of refusing — it reviewed nothing and said something. Got: ${JSON.stringify(results.empty.text.slice(0, 200))}`);

// --------------------------------------------------------------- rules 3 & 4
const sent = JSON.stringify(results.realBody ?? {});
check(sent.includes('SPEC-SENTINEL-7f3a'),
  'rule 3: the spec was given and never reached the model — a review that cannot see intent cannot catch silent scope-narrowing, which is this loop\'s recorded failure mode');
check(/fabricat|invent|pad(ded|ding)?\b|do not manufactur/i.test(sent),
  'rule 4: nothing in the prompt warns against padded or fabricated findings');
check(/stub|mock|hardcod/i.test(sent),
  'rule 4: nothing in the prompt tells the reviewer to hunt stubbed, mocked or hardcoded work — the failure that produced a beautiful UI over a fabricated implementation');

// ------------------------------------------------------------------- rule 5
check(!results.real.isError && /CHANGES_REQUIRED/.test(results.real.text),
  `rule 5 (control): a substantive review must come back intact, or the rubber-stamp check below proves nothing. Got: ${JSON.stringify(results.real.text.slice(0, 200))}`);
check(results.stamp.isError || !/^\s*VERDICT:\s*PASS\s*$/im.test(results.stamp.text.replace(/\[.*?\]/gs, '').trim()),
  `rule 5: a bare "VERDICT: PASS" with no analysis was relayed as a clean review. That is the 14-byte rubber stamp this gate exists for. Got: ${JSON.stringify(results.stamp.text.slice(0, 200))}`);

// ------------------------------------------------------------------- rule 6
check(results.stampLongPrompt.isError || !/^\s*VERDICT:\s*PASS\s*$/im.test(results.stampLongPrompt.text.replace(/\[.*?\]/gs, '').trim()),
  'rule 6: the same rubber stamp passed once the PROMPT was made long. The substance floor must measure the model\'s reply, not the request — measuring the request passes every rubber stamp ever sent');

// ------------------------------------------------------------------- rule 7
check(results.capped.isError,
  `rule 7: a reply severed by the output cap came back as a review. It carried a verdict and 400 characters of "analysis", so neither the verdict check nor the substance floor refused it — only a truncation check placed BEFORE the verdict is read can. Got: ${JSON.stringify(results.capped.text.slice(0, 200))}`);

// ------------------------------------------------------------------- rule 8
for (const [cand, accepted] of Object.entries(results.spellings)) {
  const shellTakesIt = SHELL_VERDICT.test(cand);
  check(accepted === shellTakesIt,
    `rule 8: glm_review ${accepted ? 'ACCEPTS' : 'REJECTS'} ${JSON.stringify(cand)} but bin/glm-review's grep ${shellTakesIt ? 'accepts' : 'rejects'} it. The two parsers must agree, or this tool hands the shell tools replies they cannot read`);
}

console.log(`verify-review: ${checks} checks passed`);

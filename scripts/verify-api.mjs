// verify-api.mjs — acceptance gate for the API and configuration contracts
// (#20, #22, #24, #25).
//
//   #24  a mistyped env var must not silently remove a limit. `Number("abc")`
//        is NaN, and every `total > NaN` is false, so the size cap turned OFF.
//   #25  error codes were matched as bare substrings, so a request id
//        containing "1113" reported a context-length error as "no balance".
//   #22  glm_models hardcoded api.z.ai, shipping the bearer there even when
//        the operator had set ZAI_BASE_URL precisely to scope egress, and the
//        call had no timeout.
//   #20  max_tokens is documented as an output cap but reasoning made it a
//        floor: a requested cap of 1 was sent as 28672.
//
// Requests are captured against a local server, the way #20's reproduction
// captured them, rather than asserted against a mock of our own code. Each case
// runs in a child because the client and the char cap are resolved once per
// process.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (msg) => { throw new Error(msg); };
const GLM = pathToFileURL(new URL('../dist/glm.js', import.meta.url).pathname).href;

/**
 * Runs `body` in a child with `env` applied, having started a local server that
 * records what reached it. The child prints whatever it puts in `out`.
 */
function child(body, env = {}, timeoutMs = 20_000) {
  const src = `
import { createServer } from 'node:http';
import * as glm from ${JSON.stringify(GLM)};
const seen = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    seen.push({ url: req.url, method: req.method, auth: req.headers.authorization ?? null,
                body: raw ? JSON.parse(raw) : null });
    if (globalThis.__silent) return;              // never answer: exercises the timeout
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.includes('models')
      ? { data: [{ id: 'glm-5.3' }, { id: 'glm-4.6' }] }
      : { model: 'glm-5.3', content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const out = {};
try {
${body}
} catch (e) {
  out.threw = String(e && e.message ? e.message : e);
}
out.seen = seen;
process.stdout.write(JSON.stringify(out));
server.close();
process.exit(0);
`;
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (/^(GLM_MCP_|ZAI_)/.test(k)) delete childEnv[k];
  childEnv.ZAI_API_KEY = 'dummy-key-for-the-local-server';
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = String(v);
  }
  let out;
  try {
    out = execFileSync(process.execPath, ['--input-type=module', '-e', src],
      { encoding: 'utf8', env: childEnv, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (e.killed) fail(`a case did not return within ${timeoutMs}ms — a hang is not a result`);
    fail(`child failed\n${e.stderr || e.message}`);
  }
  let parsed;
  try { parsed = JSON.parse(out); } catch { return fail(`unparsable child output: ${out}`); }
  // A case that threw where the caller expected a value would otherwise show up
  // as a mysterious `undefined`; say what actually happened.
  if (parsed.threw && !body.includes('out.threw')) {
    fail(`the case threw instead of producing a result: ${parsed.threw}`);
  }
  return parsed;
}

// ------------------------------------------- #24 env numerics are validated
// The client's own timeout is the observable: a value that cannot be parsed
// must leave the documented default in place, not NaN.
for (const [value, expected, what] of [
  [undefined, 600_000, 'unset'],
  ['abc', 600_000, 'unparsable'],
  ['', 600_000, 'empty'],
  ['0', 600_000, 'zero'],
  ['-5', 600_000, 'negative'],
  ['1e9999', 600_000, 'infinite'],
  ['30000', 30_000, 'a real value'],
]) {
  const r = child(`out.timeout = glm.getClient().timeout;`, { GLM_MCP_TIMEOUT_MS: value });
  if (r.timeout !== expected) {
    fail(`#24: GLM_MCP_TIMEOUT_MS ${what} (${JSON.stringify(value)}) gave timeout ${r.timeout}, expected ${expected}`);
  }
}

// The char cap has the same defect and a louder consequence: with NaN, nothing
// is ever truncated and the whole file is sent.
const fixture = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-api-')));
try {
  // Larger than any plausible default, so the cap always bites here, and
  // still under the 5 MB per-file byte cap.
  writeFileSync(join(fixture, 'big.txt'), 'x'.repeat(4_000_000));
  const ctxBody = `
process.env.GLM_MCP_ROOTS = ${JSON.stringify(fixture)};
const c = glm.buildFileContext(['big.txt'], ${JSON.stringify(fixture)});
out.len = c.text.length; out.notes = c.notes;`;

  // The property is "an unusable value is the same as no value", stated
  // against the default's BEHAVIOUR rather than its number — #35 moves that
  // number, and a gate that hardcodes it would have to be edited every time
  // the default is resized, which is how a gate quietly stops checking.
  const baseline = child(ctxBody);
  if (!(baseline.notes ?? []).some((n) => /truncat/i.test(n))) {
    fail(`#24: the fixture must exceed the default so the cap is observable here — notes=${JSON.stringify(baseline.notes)}`);
  }
  for (const [value, what] of [['abc', 'unparsable'], ['', 'empty'], ['-1', 'negative']]) {
    const r = child(ctxBody, { GLM_MCP_MAX_FILE_CHARS: value });
    if (r.len !== baseline.len || JSON.stringify(r.notes) !== JSON.stringify(baseline.notes)) {
      fail(`#24: GLM_MCP_MAX_FILE_CHARS ${what} (${JSON.stringify(value)}) did not fall back to the default:\n  with it:  ${r.len} chars, ${JSON.stringify(r.notes)}\n  without:  ${baseline.len} chars, ${JSON.stringify(baseline.notes)}`);
    }
  }
  const honoured = child(ctxBody, { GLM_MCP_MAX_FILE_CHARS: '2000' });
  if (honoured.len > 2000) fail(`#24: a valid GLM_MCP_MAX_FILE_CHARS must still be honoured, got ${honoured.len} chars`);

  // ------------------------------------------ #25 error codes are not substrings
  const explain = (jobs) => child(`
out.results = ${JSON.stringify(jobs)}.map((j) => {
  const e = j.structured
    ? Object.assign(new Error(j.message), { error: { error: { code: j.structured } } })
    : new Error(j.message);
  return glm.explainError(e);
});`);

  const BALANCE = /no balance|resource package/i;
  const REASONING = /always reasons|reasoning disabled/i;
  const CREDENTIAL = /captcha|ZCode Start Plan/i;

  // A code is a whole token. `(?!\d)` stops "11130" but not "1113abc", and a
  // 400 whose body carries a vendor-suffixed code is not error 1113.
  const suffixed = explain([
    { message: '400 {"error":{"code":"1113abc"}}' },
    { message: '400 {"error":{"code":"1113_retry"}}' },
    { message: '400 {"error":{"code":"1210x"}}' },
    { message: 'rate limited at 1113.0 requests per second' },
    // Inside quotes the value ends at the closing quote, so a period there is
    // part of the code, not the end of a sentence.
    { message: '400 {"error":{"code":"1113.retry"}}' },
    { message: '400 {"error":{"code":"1113."}}' },
  ]).results;
  for (const [i, text] of suffixed.entries()) {
    if (BALANCE.test(text) || REASONING.test(text) || CREDENTIAL.test(text)) {
      fail(`#25: a code with a suffix is a different code; case ${i} was translated anyway:\n  ${text.split('\n')[0]}`);
    }
  }

  const incidental = explain([
    { message: 'Request rejected: prompt is 12103 tokens over the model limit (request id req-5f1113ac)' },
    { message: 'upstream timeout after 1210 ms (trace 9f3007bd)' },
    { message: 'read /var/data/3007/chunk-1113.bin failed' },
  ]).results;
  for (const [i, text] of incidental.entries()) {
    for (const [label, re] of [['balance', BALANCE], ['reasoning', REASONING], ['credential', CREDENTIAL]]) {
      if (re.test(text)) {
        fail(`#25: message ${i} contains a code's digits only incidentally but was explained as a ${label} problem:\n  ${text.split('\n')[0]}`);
      }
    }
  }

  // The mapping still has to work where the code is genuinely the error's code.
  const genuine = explain([
    { message: 'z.ai error', structured: 1113 },
    { message: 'z.ai error', structured: '1210' },
    { message: 'z.ai error', structured: 3007 },
  ]).results;
  if (!BALANCE.test(genuine[0])) fail(`#25: a structured code 1113 must still explain the balance problem — got ${JSON.stringify(genuine[0])}`);
  if (!REASONING.test(genuine[1])) fail(`#25: a structured code 1210 must still explain the reasoning requirement — got ${JSON.stringify(genuine[1])}`);
  if (!CREDENTIAL.test(genuine[2])) fail(`#25: a structured code 3007 must still explain the credential type — got ${JSON.stringify(genuine[2])}`);

  // A period that ends a sentence is punctuation, not part of the number. The
  // digits before it are still the whole code.
  const prose = explain([
    { message: 'Upstream refused. Error code: 1113.' },
    { message: 'Error code: 1210; retry with reasoning enabled' },
    { message: 'Error code: 3007!' },
  ]).results;
  if (!BALANCE.test(prose[0])) fail(`#25: a code ending a sentence is still the code — got ${JSON.stringify(prose[0])}`);
  if (!REASONING.test(prose[1])) fail(`#25: a semicolon-delimited code must translate — got ${JSON.stringify(prose[1])}`);
  if (!CREDENTIAL.test(prose[2])) fail(`#25: punctuation after a code must not hide it — got ${JSON.stringify(prose[2])}`);

  // An error nobody has a translation for passes through, as it always has.
  const unknown = explain([{ message: 'something entirely unexpected' }]).results[0];
  if (!unknown.includes('something entirely unexpected')) {
    fail(`#25: an unrecognised error must pass through unchanged — got ${JSON.stringify(unknown)}`);
  }

  // ------------------------------------------------ #22 the models endpoint
  // Unset, the endpoint is exactly what it has always been.
  const def = child(`out.url = glm.MODELS_URL;`);
  if (def.url !== 'https://api.z.ai/api/paas/v4/models') {
    fail(`#22: with ZAI_MODELS_URL unset the endpoint must be unchanged, got ${JSON.stringify(def.url)}`);
  }

  // Set, the bearer goes where the operator said and nowhere else.
  const viaLocal = child(`
process.env.ZAI_MODELS_URL = origin + '/scoped/models';
out.ids = await glm.listModels();`);
  if (!Array.isArray(viaLocal.ids) || !viaLocal.ids.includes('glm-5.3')) {
    fail(`#22: listModels must read from ZAI_MODELS_URL — got ${JSON.stringify(viaLocal.ids ?? viaLocal.threw)}`);
  }
  if (viaLocal.seen.length !== 1 || !viaLocal.seen[0].url.includes('/scoped/models')) {
    fail(`#22: the request did not go to ZAI_MODELS_URL — saw ${JSON.stringify(viaLocal.seen.map((s) => s.url))}`);
  }
  if (!/^Bearer /.test(viaLocal.seen[0].auth ?? '')) {
    fail(`#22: the key must still be sent to the configured endpoint — auth=${JSON.stringify(viaLocal.seen[0].auth)}`);
  }

  // A server that never answers must not hang the server forever.
  const hung = child(`
globalThis.__silent = true;
process.env.ZAI_MODELS_URL = origin + '/never';
process.env.GLM_MCP_TIMEOUT_MS = '400';
const t = Date.now();
try { await glm.listModels(); out.resolved = true; } catch (e) { out.error = String(e.message).slice(0, 80); }
out.ms = Date.now() - t;`, {}, 15_000);
  if (hung.resolved) fail('#22: a request to a server that never answers must not resolve');
  // The request has to have been made: a failure before it left the process
  // would satisfy every assertion below without exercising a timeout at all.
  if (!(hung.seen?.length >= 1)) {
    fail(`#22: the timeout case never reached the server, so it proves nothing about timeouts — ${JSON.stringify(hung.error ?? hung)}`);
  }
  if (!(hung.ms < 10_000)) fail(`#22: listModels waited ${hung.ms}ms with no timeout — it must give up`);

  // ------------------------------------------ #20 max_tokens is a cap
  const ask = (args, env = {}) => child(`
process.env.ZAI_BASE_URL = origin;
try {
  out.result = await glm.ask(${JSON.stringify(args)});
} catch (e) { out.threw = String(e.message); }`, env);

  // A generous cap: the reasoning budget is what was asked for, and the cap
  // still bounds the request.
  let r = ask({ prompt: 'hi', model: 'glm-5.3', reasoning: 'max', maxTokens: 40_000 });
  let sent = r.seen?.[0]?.body;
  if (!sent) fail(`#20: no request was captured — ${JSON.stringify(r.threw ?? r)}`);
  if (sent.max_tokens > 40_000) fail(`#20: max_tokens ${sent.max_tokens} exceeds the caller's cap of 40000`);
  if (!sent.thinking || sent.thinking.budget_tokens !== 24_576) {
    fail(`#20: a generous cap must still allow the requested reasoning budget — got ${JSON.stringify(sent.thinking)}`);
  }

  // A cap smaller than the requested budget: the cap wins, and the budget is
  // scaled to fit beneath it. It must never be raised to meet the budget.
  r = ask({ prompt: 'hi', model: 'glm-5.3', reasoning: 'max', maxTokens: 5_000 });
  sent = r.seen?.[0]?.body;
  if (!sent) fail(`#20: no request was captured for the small-cap case — ${JSON.stringify(r.threw ?? r)}`);
  if (sent.max_tokens > 5_000) {
    fail(`#20: a requested cap of 5000 was sent as ${sent.max_tokens} — the cap is a ceiling, not a floor`);
  }
  if (sent.thinking && sent.thinking.budget_tokens >= sent.max_tokens) {
    fail(`#20: the thinking budget (${sent.thinking.budget_tokens}) must leave room under max_tokens (${sent.max_tokens})`);
  }

  // A cap too small for any reasoning on a model that always reasons: refused,
  // loudly, rather than silently inflated into a large billable request.
  r = ask({ prompt: 'hi', model: 'glm-5.3', reasoning: 'max', maxTokens: 1 });
  if (r.seen.length > 0) {
    fail(`#20: a cap of 1 must not reach the API at all — it was sent with max_tokens ${r.seen[0].body?.max_tokens}`);
  }
  if (!r.threw) fail('#20: a cap too small for a model that always reasons must be refused, not silently raised');
  if (!/max_tokens|cap|reasoning/i.test(r.threw)) {
    fail(`#20: the refusal must say what is wrong and what to change — got ${JSON.stringify(r.threw)}`);
  }

  // Every cap must land on one of two honest outcomes: a request that satisfies
  // the API's own constraints, or a refusal before anything is sent. Sweeping
  // the boundary is what catches the band where a budget is scaled to fit the
  // cap but falls under the minimum the API accepts — a payload that is invalid
  // on arrival is not a cap being honoured, it is a 400 with extra steps.
  const MIN_BUDGET = 1024;   // Messages API minimum for thinking.budget_tokens
  // Two different numbers, and conflating them was a mistake worth naming.
  // ANSWER_ROOM is the headroom the file PREFERS to leave for the answer when
  // the cap is generous. MIN_ANSWER is the least that still constitutes an
  // answer, and it alone decides whether a request can be made at all.
  // Refusing everything under MIN_BUDGET + ANSWER_ROOM turned away caps that
  // work perfectly well — a 5,000 cap leaves 3,976 tokens for the reply — and
  // the decision recorded for this issue was to refuse only a cap "too small
  // to allow any reasoning", not one that merely reasons less than the default.
  const ANSWER_ROOM = 4096;
  const MIN_ANSWER = 1024;
  const sweep = child(`
process.env.ZAI_BASE_URL = origin;
out.cases = [];
for (const cap of ${JSON.stringify([1, 100, 1024, 2047, 2048, 2049, 3000, 4096, 5000, 5120, 8192, 30000])}) {
  const before = seen.length;
  try {
    await glm.ask({ prompt: 'hi', model: 'glm-5.3', reasoning: 'max', maxTokens: cap });
    out.cases.push({ cap, sent: seen[before] ? seen[before].body : null });
  } catch (e) {
    out.cases.push({ cap, refused: String(e.message).slice(0, 90), reached: seen.length > before });
  }
}`);
  for (const c of sweep.cases ?? []) {
    if (c.refused !== undefined) {
      if (c.reached) fail(`#20: cap ${c.cap} was refused only after reaching the API — refuse before sending`);
      continue;
    }
    if (!c.sent) fail(`#20: cap ${c.cap} neither sent a request nor refused`);
    if (c.sent.max_tokens > c.cap) fail(`#20: cap ${c.cap} was sent as max_tokens ${c.sent.max_tokens}`);
    if (c.sent.thinking) {
      const b = c.sent.thinking.budget_tokens;
      if (b < MIN_BUDGET) {
        fail(`#20: cap ${c.cap} sent budget_tokens ${b}, under the API minimum of ${MIN_BUDGET} — a request that is invalid on arrival is not a cap being honoured; refuse instead`);
      }
      if (c.sent.max_tokens - b < MIN_ANSWER) {
        fail(`#20: cap ${c.cap} sent budget_tokens ${b} with max_tokens ${c.sent.max_tokens}, leaving ${c.sent.max_tokens - b} for the answer — under ${MIN_ANSWER} there is no answer to give. Refuse instead.`);
      }
      // Where the cap can afford the preferred headroom, it must be taken:
      // scaling reasoning down further than necessary would be its own quiet
      // narrowing.
      if (c.cap >= 24_576 + ANSWER_ROOM && c.sent.max_tokens - b < ANSWER_ROOM) {
        fail(`#20: cap ${c.cap} is generous enough for the full ${ANSWER_ROOM} of headroom but left ${c.sent.max_tokens - b}`);
      }
    }
  }
  // The threshold follows from the two constants rather than being asserted as
  // a number: below the minimum budget plus the answer room, no honest request
  // exists, so the call must be refused.
  for (const c of sweep.cases ?? []) {
    const viable = c.cap >= MIN_BUDGET + MIN_ANSWER;
    if (!viable && c.sent && c.sent.thinking) {
      fail(`#20: cap ${c.cap} cannot fit ${MIN_BUDGET} of reasoning plus ${MIN_ANSWER} of answer, yet a request was sent`);
    }
    if (viable && c.refused !== undefined) {
      fail(`#20: cap ${c.cap} can fit ${MIN_BUDGET} + ${MIN_ANSWER} and must not be refused — ${c.refused}`);
    }
  }
  if (!(sweep.cases ?? []).some((c) => c.refused !== undefined)) {
    fail('#20: no cap in the sweep was refused — the smallest ones cannot possibly be satisfiable');
  }
  if (!(sweep.cases ?? []).some((c) => c.sent)) {
    fail('#20: no cap in the sweep produced a request — the largest ones must work');
  }

  // Reasoning off, on a model that permits it: nothing is inflated.
  r = ask({ prompt: 'hi', model: 'glm-4.6', reasoning: 'none', maxTokens: 100 });
  sent = r.seen?.[0]?.body;
  if (!sent) fail(`#20: no request captured with reasoning off — ${JSON.stringify(r.threw ?? r)}`);
  if (sent.max_tokens !== 100) fail(`#20: with reasoning off, max_tokens must be exactly what was asked — got ${sent.max_tokens}`);
  if (sent.thinking) fail(`#20: reasoning "none" must send no thinking block — got ${JSON.stringify(sent.thinking)}`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log('API OK');

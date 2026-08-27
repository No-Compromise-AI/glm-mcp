// The API and configuration contracts (#20, #22, #24, #25):
//
//   #24  a mistyped GLM_MCP_TIMEOUT_MS / GLM_MCP_MAX_FILE_CHARS must fall back
//        to the documented default. Number("abc") is NaN, and no total is ever
//        greater than NaN, so the cap was not merely wrong — it was off, and
//        the whole file was read and sent.
//   #25  an error message that merely contains a code's digits is not that
//        error: a request id holding "1113" is not a balance problem.
//   #22  glm_models must send the bearer where the operator configured it,
//        within a timeout, rather than hardcoding api.z.ai with neither.
//   #20  max_tokens is a cap: never exceeded, the thinking budget scaled down
//        to fit beneath it, and a cap too small to reason on a model that
//        always reasons refused before anything is sent.
//
// #20 and #22 are captured against a real local HTTP server rather than a mock
// of our own code — that is how #20 was reproduced. #20's server lives in this
// process with ZAI_BASE_URL pinned at child startup, so the request lands here
// whatever the client resolves at import time; #22's lives in the child beside
// the call, because its whole point is where the request goes when the endpoint
// is configured at call time. Every other case that depends on process state —
// the client is cached, the char cap is read once at module load — runs in a
// child of its own for the same reason.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';

const execFileAsync = promisify(execFile);
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { explainError } from '../dist/glm.js';

const GLM = pathToFileURL(new URL('../dist/glm.js', import.meta.url).pathname).href;

// A throwaway tree holding one 900,000-char file — over the 800,000 default cap
// but under the 5 MB byte cap, so the only limit that can stop it is the one
// under test.
const RAW = mkdtempSync(join(tmpdir(), 'glm-api-test-'));
const FIXTURE = realpathSync.native(RAW);
writeFileSync(join(FIXTURE, 'big.txt'), 'x'.repeat(900_000));

// The stand-in for z.ai: every request that reaches it is recorded verbatim,
// and it answers the shape `ask` and `listModels` expect.
const respond = (res, url) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(url.includes('models')
    ? { data: [{ id: 'glm-5.3' }, { id: 'glm-4.6' }] }
    : { model: 'glm-5.3', content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 } }));
};

// #20's capture point. ZAI_BASE_URL points here in the child's startup
// environment — before the module is imported — so the request arrives on any
// build of the client, including one that resolved its base URL at load.
const upstreamSeen = [];
const upstream = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    upstreamSeen.push({ url: req.url, auth: req.headers.authorization ?? null,
                        body: raw ? JSON.parse(raw) : null });
    respond(res, req.url);
  });
});

before(async () => {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
});

after(async () => {
  await new Promise((resolve) => upstream.close(resolve));
  rmSync(FIXTURE, { recursive: true, force: true });
});

/**
 * Runs `body` in a child that owns a local HTTP server recording what reaches
 * it, with every GLM_MCP_ and ZAI_ variable scrubbed from the inherited
 * environment and `env` applied — the child pins its own configuration the way
 * an operator pins it at startup. `fetch` is fenced to the loopback so a
 * failing build shows where the request tried to go (#22 is precisely a bearer
 * shipped somewhere the operator had ruled out) without actually shipping it
 * there to show it; what the local server captures is a real request through
 * the real fetch.
 *
 * The child is spawned asynchronously because #20's child calls THIS process's
 * server: a synchronous spawn would block the event loop serving it, and the
 * two would wait on each other until the timeout killed them both.
 */
async function child(body, env = {}, timeoutMs = 20_000) {
  const src = `
import { createServer } from 'node:http';
import * as glm from ${JSON.stringify(GLM)};
const respond = ${respond.toString()};
const seen = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    seen.push({ url: req.url, method: req.method,
                auth: req.headers.authorization ?? null,
                body: raw ? JSON.parse(raw) : null });
    if (globalThis.__silent) return;              // never answer: exercises the timeout
    respond(res, req.url);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const realFetch = fetch;
globalThis.fetch = (url, init) => {
  const target = new URL(String(url));
  if (target.hostname !== '127.0.0.1') {
    throw new Error('request left the loopback for ' + target.origin);
  }
  return realFetch(url, init);
};
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
    const r = await execFileAsync(process.execPath, ['--input-type=module', '-e', src],
      { encoding: 'utf8', env: childEnv, timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    out = r.stdout;
  } catch (e) {
    if (e.killed) {
      assert.fail(`the case did not return within ${timeoutMs}ms — a hang is not a result`);
    }
    assert.fail(`child failed\n${e.stderr || e.message}`);
  }
  return JSON.parse(out);
}

// ------------------------------------------- #24: env numerics are validated

test('#24 an unparsable GLM_MCP_TIMEOUT_MS leaves the documented default in place', async () => {
  // NaN as a timeout degrades every request to waiting forever; 0 (from an
  // empty value) degrades it to nothing. Neither may pass through.
  for (const [value, expected] of [
    ['abc', 600_000], ['', 600_000], ['0', 600_000], ['-5', 600_000],
    ['1e9999', 600_000], ['30000', 30_000],
  ]) {
    const r = await child('out.timeout = glm.getClient().timeout;', { GLM_MCP_TIMEOUT_MS: value });
    assert.equal(r.timeout, expected,
      `GLM_MCP_TIMEOUT_MS=${JSON.stringify(value)} gave ${JSON.stringify(r.timeout ?? r.threw)}`);
  }
});

test('#24 a mistyped GLM_MCP_MAX_FILE_CHARS must not remove the cap', async () => {
  const ctx = `
process.env.GLM_MCP_ROOTS = ${JSON.stringify(FIXTURE)};
const c = glm.buildFileContext(['big.txt'], ${JSON.stringify(FIXTURE)});
out.len = c.text.length; out.notes = c.notes;`;
  for (const value of ['abc', '', '-1']) {
    const r = await child(ctx, { GLM_MCP_MAX_FILE_CHARS: value });
    assert.ok(r.len <= 800_100,
      `GLM_MCP_MAX_FILE_CHARS=${JSON.stringify(value)} removed the cap — ${r.len} of 900,000 chars came through`);
    assert.ok((r.notes ?? []).some((n) => /truncat/i.test(n)),
      `GLM_MCP_MAX_FILE_CHARS=${JSON.stringify(value)} must fall back to the default AND still say it truncated — notes=${JSON.stringify(r.notes)}`);
  }
});

test('#24 a valid GLM_MCP_MAX_FILE_CHARS is still honoured', async () => {
  const ctx = `
process.env.GLM_MCP_ROOTS = ${JSON.stringify(FIXTURE)};
const c = glm.buildFileContext(['big.txt'], ${JSON.stringify(FIXTURE)});
out.len = c.text.length;`;
  const r = await child(ctx, { GLM_MCP_MAX_FILE_CHARS: '2000' });
  assert.ok(r.len <= 2000, `the configured cap must hold, got ${r.len} chars`);
});

// --------------------------------- #25: error codes are not bare substrings

const BALANCE = /no balance|resource package/i;
const REASONING = /always reasons|reasoning disabled/i;
const CREDENTIAL = /captcha|ZCode Start Plan/i;

test('#25 digits that merely appear in a message are not error codes', () => {
  // Each carries a code's digits incidentally — a token count, a trace id, a
  // path — and none says anything about balance, reasoning or credentials.
  // The substring match explained all three as something they are not, which
  // is how a context-length problem sends someone to top up a fine account.
  const incidental = [
    'Request rejected: prompt is 12103 tokens over the model limit (request id req-5f1113ac)',
    'upstream timeout after 1210 ms (trace 9f3007bd)',
    'read /var/data/3007/chunk-1113.bin failed',
  ];
  for (const message of incidental) {
    const explained = explainError(new Error(message));
    for (const [label, re] of [['balance', BALANCE], ['reasoning', REASONING], ['credential', CREDENTIAL]]) {
      assert.ok(!re.test(explained), `${JSON.stringify(message)} was explained as a ${label} problem`);
    }
    assert.ok(explained.includes(message), 'the original message must survive untranslated');
  }
});

test('#25 a structured code in the parsed body still maps to its explanation', () => {
  // The SDK attaches the parsed response body to the error, and z.ai nests the
  // code inside it; a number or a string must both work.
  const coded = (code) => Object.assign(new Error('z.ai error'), { error: { error: { code } } });
  assert.match(explainError(coded(1113)), BALANCE);
  assert.match(explainError(coded('1210')), REASONING);
  assert.match(explainError(coded('3007')), CREDENTIAL);
});

test('#25 a code the message itself labels as a code still maps', () => {
  // When the body has no message field the SDK stringifies all of it into the
  // message, where the code sits in a labelled, delimited position — unlike
  // the loose digits above.
  const body = '400 {"error":{"code":"1113","message":"Insufficient balance"}}';
  assert.match(explainError(new Error(body)), BALANCE);
});

test('#25 a code is a whole token, not the prefix of one', () => {
  // `1113abc`, `1113_retry`, `1113-retry`, `1113.0` and `1113é` are all
  // different codes from `1113`. A guard that stops a trailing digit but not a
  // trailing letter, underscore, hyphen, dot or accented letter explains a
  // vendor-suffixed code as the bare code's problem — the same mistake the bare
  // substring made, one character narrower.
  const suffixed = [
    '400 {"error":{"code":"1113abc"}}',
    '400 {"error":{"code":"1113_retry"}}',
    '400 {"error":{"code":"1113-retry"}}',
    '400 {"error":{"code":"1113.0"}}',
    '400 {"error":{"code":"1113é"}}',
    '400 {"error":{"code":"1210x"}}',
    '400 {"error":{"code":"1210.1"}}',
  ];
  for (const message of suffixed) {
    const explained = explainError(new Error(message));
    for (const [label, re] of [['balance', BALANCE], ['reasoning', REASONING], ['credential', CREDENTIAL]]) {
      assert.ok(!re.test(explained),
        `${JSON.stringify(message)} carries a suffixed code, which is not the bare ${label} code`);
    }
    assert.ok(explained.includes(message), 'a code that is not ours to explain passes through untranslated');
  }
  // The whole value still maps — the guard narrows the token, not the code —
  // in the quoted form and in the labelled prose one, where a space, not a
  // value character, follows the digits.
  assert.match(explainError(new Error('400 {"error":{"code":"1113"}}')), BALANCE);
  assert.match(explainError(new Error('Error code: 1113 - {"error":{}}')), BALANCE);
});

test('#25 an error nobody has a translation for passes through unchanged', () => {
  assert.equal(explainError(new Error('something entirely unexpected')),
    'something entirely unexpected');
});

// --------------------------------------- #22: the models endpoint is configured

test('#22 with ZAI_MODELS_URL unset the endpoint is exactly what it has always been', async () => {
  const r = await child('out.url = glm.MODELS_URL;');
  assert.equal(r.url, 'https://api.z.ai/api/paas/v4/models',
    `operators who set nothing must get today's URL, got ${JSON.stringify(r.url)}`);
});

test('#22 listModels sends the bearer to ZAI_MODELS_URL and nowhere else', async () => {
  const r = await child(`
process.env.ZAI_MODELS_URL = origin + '/scoped/models';
out.ids = await glm.listModels();`);
  assert.ok(Array.isArray(r.ids) && r.ids.includes('glm-5.3'),
    `listModels must list from the configured endpoint — got ${JSON.stringify(r.ids ?? r.threw)}`);
  assert.equal(r.seen.length, 1,
    `exactly one request belongs here — saw ${JSON.stringify(r.seen.map((s) => s.url))}`);
  assert.match(r.seen[0].url, /\/scoped\/models$/);
  assert.match(r.seen[0].auth ?? '', /^Bearer /,
    'the key must still be sent to the configured endpoint');
});

test('#22 a models endpoint that never answers is cut off by GLM_MCP_TIMEOUT_MS', async () => {
  const r = await child(`
globalThis.__silent = true;
process.env.ZAI_MODELS_URL = origin + '/never';
process.env.GLM_MCP_TIMEOUT_MS = '400';
const t = Date.now();
try { await glm.listModels(); out.resolved = true; }
catch (e) { out.error = (e && e.name ? e.name + ': ' : '') + String(e && e.message ? e.message : e); }
out.ms = Date.now() - t;`, {}, 15_000);
  assert.equal(r.resolved, undefined, 'a request to a server that never answers must not resolve');
  assert.match(String(r.error), /timeout|abort/i,
    `the refusal must be the timeout, not something else — got ${JSON.stringify(r.error)}`);
    // The request must actually have been made: a failure before it left the
  // process would satisfy the other assertions without exercising a timeout.
  assert.ok(r.seen.length >= 1, `the timeout case never reached the server: ${JSON.stringify(r.error ?? r)}`);
assert.ok(r.ms < 5_000, `listModels waited ${r.ms}ms — the timeout must cut it off`);
});

// ------------------------------------------ #20: max_tokens is a cap

const ask = (args) => {
  upstreamSeen.length = 0;
  return child(`
try { out.result = await glm.ask(${JSON.stringify(args)}); }
catch (e) { out.threw = String(e && e.message ? e.message : e); }`,
  { ZAI_BASE_URL: `http://127.0.0.1:${upstream.address().port}` });
};

test('#20 a generous cap bounds the request and keeps the asked-for budget', async () => {
  const r = await ask({ prompt: 'hi', model: 'glm-5.3', reasoning: 'max', maxTokens: 40_000 });
  const sent = upstreamSeen[0]?.body;
  assert.ok(sent, `a request must have been captured — ${JSON.stringify(r.threw ?? upstreamSeen)}`);
  assert.ok(sent.max_tokens <= 40_000, `max_tokens ${sent.max_tokens} exceeds the caller's cap of 40000`);
  assert.equal(sent.thinking?.budget_tokens, 24_576,
    'a generous cap must still allow the requested reasoning budget');
});

test('#20 a cap smaller than the budget scales the budget down, never the cap up', async () => {
  const r = await ask({ prompt: 'hi', model: 'glm-5.3', reasoning: 'max', maxTokens: 5_000 });
  const sent = upstreamSeen[0]?.body;
  assert.ok(sent, `a request must have been captured — ${JSON.stringify(r.threw ?? upstreamSeen)}`);
  assert.equal(sent.max_tokens, 5_000,
    `the cap is a ceiling, not a floor — it was sent as ${sent.max_tokens}`);
  assert.ok(sent.thinking && sent.thinking.budget_tokens < sent.max_tokens,
    `the thinking budget (${sent.thinking?.budget_tokens}) must leave room under max_tokens (${sent.max_tokens})`);
});

test('#20 a cap too small to reason on a model that always reasons is refused before anything is sent', async () => {
  const r = await ask({ prompt: 'hi', model: 'glm-5.3', reasoning: 'max', maxTokens: 1 });
  assert.equal(upstreamSeen.length, 0,
    `nothing may reach the API — it was sent ${JSON.stringify(upstreamSeen[0]?.body)}`);
  assert.ok(r.threw, 'the call must be refused, not silently inflated into a billable request');
  assert.match(r.threw, /max_tokens/, 'the refusal must name max_tokens');
  assert.match(r.threw, /at least \d+/, 'the refusal must say what to change');
});

test('#20 reasoning "none" is raised on glm-5.3, and a cap too small for even that is refused', async () => {
  const r = await ask({ prompt: 'hi', model: 'glm-5.3', reasoning: 'none', maxTokens: 100 });
  assert.equal(upstreamSeen.length, 0,
    `nothing may reach the API — it was sent ${JSON.stringify(upstreamSeen[0]?.body)}`);
  assert.match(String(r.threw), /max_tokens/,
    `glm-5.3 cannot run with reasoning off; a cap of 100 cannot hold it — got ${JSON.stringify(r.threw)}`);
});

test('#20 with reasoning off on a model that permits it, max_tokens goes through exactly', async () => {
  const r = await ask({ prompt: 'hi', model: 'glm-4.6', reasoning: 'none', maxTokens: 100 });
  const sent = upstreamSeen[0]?.body;
  assert.ok(sent, `a request must have been captured — ${JSON.stringify(r.threw ?? upstreamSeen)}`);
  assert.equal(sent.max_tokens, 100,
    `with reasoning off, max_tokens must be exactly what was asked — got ${sent.max_tokens}`);
  assert.equal(sent.thinking, undefined, 'reasoning "none" must send no thinking block');
});

test('#20 every cap sends a request the API accepts, or is refused before sending', async () => {
  // One cap is exactly what missed this: a whole band of caps scaled the
  // thinking budget under the minimum the Messages API accepts for
  // budget_tokens, so the cap was "honoured" locally and rejected on arrival
  // with a 400. Sweeping the caps around both boundaries holds the invariant
  // everywhere instead of at the one value the author thought of.
  const caps = [1, 100, 1024, 1025, 2000, 4096, 4097, 4200, 5000, 5119, 5120, 5200, 8192, 30000];
  const r = await child(`
process.env.ZAI_BASE_URL = origin;
out.cases = [];
for (const cap of ${JSON.stringify(caps)}) {
  const before = seen.length;
  try {
    await glm.ask({ prompt: 'hi', model: 'glm-5.3', reasoning: 'max', maxTokens: cap });
    out.cases.push({ cap, sent: seen[before] ? seen[before].body : null });
  } catch (e) {
    out.cases.push({ cap, refused: String(e && e.message ? e.message : e), reached: seen.length > before });
  }
}`);
  const MIN_BUDGET = 1024; // the Messages API minimum for thinking.budget_tokens
  let sentCount = 0;
  let refusedCount = 0;
  for (const c of r.cases ?? []) {
    if (c.refused !== undefined) {
      refusedCount++;
      assert.ok(!c.reached,
        `cap ${c.cap} was refused only after reaching the API — a refusal must come before a request exists`);
      assert.match(c.refused, /max_tokens/,
        `cap ${c.cap}: the refusal must name max_tokens — got ${JSON.stringify(c.refused)}`);
      assert.match(c.refused, /at least \d+/,
        `cap ${c.cap}: the refusal must say what to change — got ${JSON.stringify(c.refused)}`);
      continue;
    }
    sentCount++;
    assert.ok(c.sent, `cap ${c.cap} neither sent a request nor refused — ${JSON.stringify(r.threw ?? c)}`);
    assert.ok(c.sent.max_tokens <= c.cap,
      `cap ${c.cap} was sent as max_tokens ${c.sent.max_tokens} — the cap is a ceiling`);
    assert.ok(c.sent.thinking,
      `cap ${c.cap} sent no thinking block — reasoning was asked for and glm-5.3 rejects a request without one`);
    const b = c.sent.thinking.budget_tokens;
    assert.ok(b >= MIN_BUDGET,
      `cap ${c.cap} sent budget_tokens ${b}, under the API minimum of ${MIN_BUDGET} — a request invalid on arrival honours the cap nowhere`);
    assert.ok(b < c.sent.max_tokens,
      `cap ${c.cap} sent budget_tokens ${b} with max_tokens ${c.sent.max_tokens} — nothing left to answer with`);
  }
  assert.ok(refusedCount > 0, 'the smallest caps cannot hold any thinking budget — at least one must be refused');
  assert.ok(sentCount > 0, 'the largest caps must produce requests');
});

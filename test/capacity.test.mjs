// Capacity (#35, #36): the tool is sized against what GLM actually accepts,
// not against round guesses from the first commit.
//
//   #36  output limits are per model, from z.ai's published table: the model's
//        own default when the caller omits max_tokens, the model's own ceiling
//        enforced locally before anything is sent — and NO ceiling for a model
//        the table does not know. A table cannot know about a model released
//        tomorrow, and refusing one to protect a stale guess is the exact
//        failure this issue exists to fix, moved to a new place.
//   #35  the input budget is derived from the context window — window minus
//        the output and prompt reserves, converted at an English-and-code
//        chars-per-token rate — so moving the window moves the budget, and
//        GLM_MCP_MAX_FILE_CHARS remains the override.
//
// The resolver and its table are pure functions, so those cases run in
// process. Everything that depends on module-load environment (the resolved
// cap) or on a real request (the ask cases) runs in a child of its own with a
// scrubbed environment, the same split the rest of this suite uses — the cap
// is read once at module load, so it has to be in the environment before the
// module is imported to be testable at all.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as glm from '../dist/glm.js';

const GLM = pathToFileURL(new URL('../dist/glm.js', import.meta.url).pathname).href;

// Runs `body` in a child that owns a local HTTP server recording what reaches
// it, with every GLM_MCP_ and ZAI_ variable scrubbed from the inherited
// environment and `env` applied — the child pins its own configuration the way
// an operator pins it at startup.
function child(body, env = {}, timeoutMs = 20_000) {
  const src = `
import { createServer } from 'node:http';
import * as glm from ${JSON.stringify(GLM)};
const seen = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    seen.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'm', content: [{ type: 'text', text: 'ok' }], usage: {} }));
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
      { encoding: 'utf8', env: childEnv, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (e.killed) assert.fail(`a case did not return within ${timeoutMs}ms`);
    assert.fail(`child failed\n${e.stderr || e.message}`);
  }
  try { return JSON.parse(out); } catch { return assert.fail(`unparsable child output: ${out}`); }
}

// ------------------------------------------------------------ #36: the table

// z.ai's published table, verbatim: [model, default max_tokens, ceiling].
const PUBLISHED = [
  ['glm-5.3', 65_536, 131_072],
  ['glm-5.3-flash', 65_536, 131_072],
  ['glm-5.2', 65_536, 131_072],
  ['glm-5.1', 65_536, 131_072],
  ['glm-5', 65_536, 131_072],
  ['glm-5-turbo', 65_536, 131_072],
  ['glm-5v-turbo', 65_536, 131_072],
  ['glm-4.7', 65_536, 131_072],
  ['glm-4.6', 65_536, 131_072],
  ['glm-4.5', 65_536, 98_304],
  ['glm-4.5-air', 65_536, 98_304],
  ['glm-4.5-x', 65_536, 98_304],
  ['glm-4.5-airx', 65_536, 98_304],
  ['glm-4.5-flash', 65_536, 98_304],
  ['glm-4.6v', 16_384, 32_768],
  ['glm-4.6v-flash', 16_384, 32_768],
  ['glm-4.6v-flashx', 16_384, 32_768],
  ['glm-4.5v', 16_384, 16_384],
  ['glm-4-32b-0414-128k', 16_384, 16_384],
];

test("#36 z.ai's published output table is reproduced exactly", () => {
  for (const [model, def, max] of PUBLISHED) {
    assert.deepEqual(glm.outputLimits(model), { def, max },
      `${model} must be ${def}/${max} per z.ai's table`);
  }
});

test('#36 a model the table does not know gets a default and no ceiling', () => {
  const limits = glm.outputLimits('glm-99-unreleased');
  assert.equal(limits.max, undefined,
    'an unknown model has no locally known ceiling — z.ai is the authority on its own');
  assert.equal(limits.def, glm.DEFAULT_MAX_TOKENS,
    `an unknown model still needs a usable default, got ${JSON.stringify(limits)}`);
});

// ------------------------------------------------- #36: what ask() sends

const ask = (args) => child(`
process.env.ZAI_BASE_URL = origin;
out.result = await glm.ask(${JSON.stringify(args)});`);

test("#36 an omitted max_tokens sends the model's own default, not a constant", () => {
  // Three models, two different defaults: only the model's own number proves
  // the default travels with the table rather than living in ours as 8,192 did.
  for (const [model, def] of [['glm-5.3', 65_536], ['glm-4.5', 65_536], ['glm-4.6v', 16_384]]) {
    const r = ask({ prompt: 'hi', model, reasoning: 'low' });
    const sent = r.seen?.[0]?.body;
    assert.ok(sent, `a request must have been captured for ${model} — ${JSON.stringify(r.threw ?? r)}`);
    assert.equal(sent.max_tokens, def,
      `an omitted cap must send ${model}'s own default of ${def}, got ${sent.max_tokens}`);
  }
});

test("#36 a cap over the model's ceiling is refused locally, naming the ceiling", () => {
  for (const [model, ceiling] of [['glm-5.3', 131_072], ['glm-4.5', 98_304], ['glm-4.6v', 32_768]]) {
    const r = ask({ prompt: 'hi', model, reasoning: 'low', maxTokens: ceiling * 2 });
    assert.equal(r.seen.length, 0,
      `${model}: a cap over the ceiling reached the API — refuse before sending, do not learn it from a 400`);
    assert.ok(r.threw, `${model}: a cap over the ceiling must be refused`);
    assert.ok(r.threw.includes(String(ceiling)),
      `the refusal must name ${model}'s ceiling of ${ceiling} — got ${JSON.stringify(r.threw)}`);
  }
});

test("#36 a cap exactly at the model's ceiling is allowed through", () => {
  const r = ask({ prompt: 'hi', model: 'glm-5.3', reasoning: 'low', maxTokens: 131_072 });
  assert.ok(!r.threw, `131,072 is glm-5.3's documented ceiling — ${JSON.stringify(r.threw)}`);
  assert.equal(r.seen.length, 1, 'the request should have been sent');
  assert.equal(r.seen[0].body.max_tokens, 131_072);
});

test('#36 an unknown model is not capped against the table', () => {
  const r = ask({ prompt: 'hi', model: 'glm-99-unreleased', reasoning: 'low', maxTokens: 200_000 });
  assert.ok(!r.threw,
    `a model the table cannot know must be z.ai's to judge — got ${JSON.stringify(r.threw)}`);
  assert.equal(r.seen.length, 1, 'the request should have been sent anyway');
  assert.equal(r.seen[0].body.max_tokens, 200_000, 'the asked-for cap goes through untouched');
});

test('#36 an unknown model gets a default that actually works', async () => {
  // Comparing outputLimits(x).def to DEFAULT_MAX_TOKENS compares the
  // implementation with itself: set that constant to 1 and the comparison
  // still holds, while an omitted cap with reasoning is then refused locally
  // for having no room. Assert what the value has to DO instead.
  const d = glm.outputLimits('glm-99-unreleased').def;
  assert.ok(d >= glm.MIN_BUDGET_TOKENS + glm.MIN_ANSWER_TOKENS,
    `an unknown model's default (${d}) must leave room to reason and answer, or an omitted cap becomes a refusal`);
  const r = await child(`
process.env.ZAI_BASE_URL = origin;
out.result = await glm.ask({ prompt: 'hi', model: 'glm-99-unreleased', reasoning: 'low' });`);
  assert.equal(r.threw, undefined, `an unknown model with no cap must be sent, not refused — ${r.threw}`);
  assert.equal(r.seen.length, 1, 'the request should have reached the endpoint');
  assert.equal(r.seen[0].body.max_tokens, d, "the request must carry the unknown model's default");
});

// ------------------------------------------------- #35: the derived input budget

// A throwaway tree holding one 3,200,000-char file — over the derived default
// budget but under the 5 MB byte cap, so the only limit that can stop it is
// the char budget under test.
const RAW = mkdtempSync(join(tmpdir(), 'glm-capacity-test-'));
const FIXTURE = realpathSync.native(RAW);
writeFileSync(join(FIXTURE, 'big.txt'), 'x'.repeat(3_200_000));

after(() => rmSync(FIXTURE, { recursive: true, force: true }));

const ctx = (env) => child(`
process.env.GLM_MCP_ROOTS = ${JSON.stringify(FIXTURE)};
const c = glm.buildFileContext(['big.txt'], ${JSON.stringify(FIXTURE)});
out.len = c.text.length; out.notes = c.notes; out.cap = glm.MAX_FILE_CHARS;`, env);

// The derivation restated from the module's own constants, so the test fails
// on the derivation changing, not on a mystery number. The default model's
// window is the #35 case; #59 made it per model, and the reserve it subtracts
// is the REQUESTED model's own default.
const derivedFor = (model, windowTokens) => Math.floor(
  (windowTokens - glm.outputLimits(model).def - glm.PROMPT_RESERVE_TOKENS)
    * glm.CHARS_PER_TOKEN);
const derived = (windowTokens) => derivedFor(glm.DEFAULT_MODEL, windowTokens);

test('#35 the input budget is derived from the window, not guessed', () => {
  const r = ctx({});
  assert.equal(typeof r.cap, 'number', `MAX_FILE_CHARS must be exported — got ${JSON.stringify(r.threw ?? r)}`);
  assert.ok(r.cap > 800_000, `the 800,000 round guess must be gone — got ${r.cap}`);

  // The inputs are asserted BEFORE the derivation that uses them. Computing
  // the expectation from the module's own constants and comparing it to a cap
  // built from those same constants is a tautology: it would hold just as well
  // if the window were 1,000,000 or the ratio 2.9. These are the values this
  // change was specified against, so they are stated here independently.
  assert.equal(glm.CONTEXT_WINDOW_TOKENS, 1_048_576,
    "GLM-5.3's window per the model listings — z.ai publishes output limits but not context length");
  assert.equal(glm.CHARS_PER_TOKEN, 3.0,
    'the English-and-code ratio this default is deliberately sized for');
  assert.ok(glm.PROMPT_RESERVE_TOKENS > 0 && glm.PROMPT_RESERVE_TOKENS <= 32_768,
    `the prompt reserve must be real but modest — got ${glm.PROMPT_RESERVE_TOKENS}`);
  assert.equal(glm.outputLimits(glm.DEFAULT_MODEL).def, 65_536,
    "the output reserve is the default model's own default");

  assert.ok(r.cap >= 2_500_000,
    `at ~3 chars/token the budget must use most of the 1,048,576-token window — got ${r.cap}`);
  assert.equal(r.cap, derived(glm.CONTEXT_WINDOW_TOKENS),
    'the cap must be the window minus the output and prompt reserves, not a magic number');
});

test('#35 the budget moves when the window moves', () => {
  const dflt = ctx({});
  const smaller = ctx({ GLM_MCP_CONTEXT_TOKENS: 500_000 });
  assert.ok(smaller.cap < dflt.cap,
    `GLM_MCP_CONTEXT_TOKENS=500000 must shrink the budget — ${smaller.cap} against ${dflt.cap}`);
  assert.equal(smaller.cap, derived(500_000),
    'the shrunken budget must be the same derivation over the smaller window');
  // The window knob is an env limit like the others: an unparsable value falls
  // back to the assumed default rather than removing the budget (#24's rule).
  const garbage = ctx({ GLM_MCP_CONTEXT_TOKENS: 'abc' });
  assert.equal(garbage.cap, dflt.cap,
    `an unparsable GLM_MCP_CONTEXT_TOKENS must fall back to the default — got ${garbage.cap}`);
});

test('#35 the explicit char cap still overrides the derived budget', () => {
  const pinned = ctx({ GLM_MCP_MAX_FILE_CHARS: 1000 });
  assert.equal(pinned.cap, 1000, 'GLM_MCP_MAX_FILE_CHARS must still win');
  assert.ok(pinned.len <= 1000, `the pinned cap did not bind — ${pinned.len} chars`);
  assert.ok((pinned.notes ?? []).some((n) => /truncat/i.test(n)),
    `truncation must still be reported — ${JSON.stringify(pinned.notes)}`);
  const garbage = ctx({ GLM_MCP_MAX_FILE_CHARS: 'abc' });
  assert.equal(garbage.cap, ctx({}).cap,
    'an unparsable cap must fall back to the derived default (#24)');
});

test('#35 a bigger budget is not permission to go quiet: the derived cap still truncates and still says so', () => {
  const r = ctx({});
  assert.ok(r.len <= r.cap, `${r.len} chars assembled against a ${r.cap}-char budget`);
  assert.ok((r.notes ?? []).some((n) => /truncated at \d+ total chars/i.test(n)),
    `a 3.2M-char file over the derived budget must be truncated AND noted — ${JSON.stringify(r.notes)}`);
});

// ------------------------------------------------ #59: which bound the note names
// A truncation note names the bound that cut it — the model's window, or the
// operator's cap — because the reader's next move depends on which it was
// (#59, rule 7). The attribution has to be read from whether an override is in
// force, never inferred from the cap's NUMBER: a pin set to exactly a model's
// derived budget is indistinguishable from the derivation by value yet follows
// the caller to every wider-window model, and a note that names the window
// there sends the caller model-shopping for relief the cap still denies.

test("#59 a cap pinned to exactly the model's derived budget is still named as the cap", () => {
  // glm-4.5: a 128,000-token window (z.ai's published figure, stated here
  // independently per this file's convention) against its own 65,536 default.
  const glm45 = derivedFor('glm-4.5', 128_000);
  const cut = (env) => child(`
process.env.GLM_MCP_ROOTS = ${JSON.stringify(FIXTURE)};
const c = glm.buildFileContext(['big.txt'], ${JSON.stringify(FIXTURE)}, 'glm-4.5');
out.len = c.text.length; out.notes = c.notes;`, env)
    .notes.find((n) => /truncat/i.test(n)) ?? '';

  const pinned = cut({ GLM_MCP_MAX_FILE_CHARS: glm45 });
  assert.ok(pinned.includes('GLM_MCP_MAX_FILE_CHARS'),
    `GLM_MCP_MAX_FILE_CHARS=${glm45} is in force — it is exactly glm-4.5's derived budget, and under the same pin glm-4.6's 200K window is cut at it too — so the bound is the cap and the note must say so: ${JSON.stringify(pinned)}`);
  assert.ok(!pinned.includes('context window'),
    `the window did not bind this cut; naming it tells the caller to change models, which the cap survives: ${JSON.stringify(pinned)}`);

  // The other branch must survive the fix, not be flattened into always saying
  // "cap": with no override — and with an unparsable one, which supplies no
  // cap at all (#24) — it is glm-4.5's own window that binds.
  for (const env of [{}, { GLM_MCP_MAX_FILE_CHARS: 'abc' }]) {
    const free = cut(env);
    assert.ok(/glm-4\.5's 128000-token context window/.test(free),
      `with ${JSON.stringify(env)} the derivation binds, and the note must name glm-4.5's window: ${JSON.stringify(free)}`);
  }
});

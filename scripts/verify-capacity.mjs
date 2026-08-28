// verify-capacity.mjs — acceptance gate for sizing against what GLM actually
// accepts (#35, #36).
//
// The tool sells itself on GLM-5.3's million-token window and then hands it a
// quarter of one. Both numbers were round guesses from the first commit,
// never derived from the model:
//
//                    ours          GLM-5.3 (z.ai's own docs)
//   max_tokens       8,192         65,536 default, 131,072 ceiling
//   input context    800,000 chars ~1,048,576 tokens
//
// Measured this session for comparison: the delegation path (claude-glm) runs
// the SAME model at CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000 and
// CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000 and produces work that passes
// independent verification. glm_ask has simply never been allowed the room.
//
// Two things this gate insists on beyond the numbers:
//   * the ceiling is PER MODEL and comes from z.ai's published table — the
//     vision models stop at 32,768 and the 4.5 family at 98,304, so one
//     number for everything would break them;
//   * an UNKNOWN model is not capped locally. z.ai ships models faster than
//     this table can be updated, and a tool that refuses tomorrow's model to
//     protect a guess is the same mistake in a new place.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (msg) => { throw new Error(msg); };
const GLM = pathToFileURL(new URL('../dist/glm.js', import.meta.url).pathname).href;

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
    if (e.killed) fail(`a case did not return within ${timeoutMs}ms`);
    fail(`child failed\n${e.stderr || e.message}`);
  }
  try { return JSON.parse(out); } catch { return fail(`unparsable child output: ${out}`); }
}

// z.ai's published table, verbatim. The gate reads the implementation's own
// resolver rather than a copy, so a wrong entry fails here.
const PUBLISHED = [
  ['glm-5.3', 65_536, 131_072],
  ['glm-5.3-flash', 65_536, 131_072],
  ['glm-5.2', 65_536, 131_072],
  ['glm-4.7', 65_536, 131_072],
  ['glm-4.6', 65_536, 131_072],
  ['glm-4.6v', 16_384, 32_768],
  ['glm-4.5', 65_536, 98_304],
  ['glm-4.5-flash', 65_536, 98_304],
];

// --------------------------------------------------- 1. the output defaults
for (const [model, def, ceiling] of PUBLISHED) {
  const r = child(`out.limits = glm.outputLimits(${JSON.stringify(model)});`);
  if (!r.limits) fail(`#36: outputLimits(${model}) returned nothing — ${JSON.stringify(r.threw ?? r)}`);
  if (r.limits.def !== def || r.limits.max !== ceiling) {
    fail(`#36: ${model} should be ${def}/${ceiling} per z.ai's table, got ${r.limits.def}/${r.limits.max}`);
  }
}

// A caller that says nothing gets the model's own default, not 8,192.
let r = child(`
process.env.ZAI_BASE_URL = origin;
out.result = await glm.ask({ prompt: 'hi', model: 'glm-5.3', reasoning: 'low' });`);
let sent = r.seen?.[0]?.body;
if (!sent) fail(`#36: no request captured for the default case — ${JSON.stringify(r.threw ?? r)}`);
if (sent.max_tokens < 65_536) {
  fail(`#36: with no max_tokens the request asked for ${sent.max_tokens}; glm-5.3's own default is 65,536 and the old 8,192 truncated every answer to an eighth of it`);
}

// ------------------------------------------- 2. ceilings are local, per model
const asked = (model, maxTokens) => child(`
process.env.ZAI_BASE_URL = origin;
out.result = await glm.ask({ prompt: 'hi', model: ${JSON.stringify(model)}, reasoning: 'low', maxTokens: ${maxTokens} });`);

r = asked('glm-5.3', 131_072);
if (r.threw) fail(`#36: 131,072 is glm-5.3's documented ceiling and must be allowed — ${r.threw}`);

r = asked('glm-5.3', 200_000);
if (r.seen.length > 0) fail(`#36: a max_tokens over the ceiling reached the API — refuse locally, do not learn it from a 400`);
if (!r.threw || !/131072|131,072/.test(r.threw)) {
  fail(`#36: the refusal must name the model's ceiling — got ${JSON.stringify(r.threw)}`);
}

// The vision models stop far lower; one global number would send them past it.
r = asked('glm-4.6v', 40_000);
if (r.seen.length > 0) fail(`#36: glm-4.6v's ceiling is 32,768 and 40,000 reached the API anyway`);
if (!r.threw) fail(`#36: glm-4.6v must refuse 40,000 locally`);

// An unknown model is z.ai's to judge, not ours.
r = asked('glm-99-unreleased', 120_000);
if (r.threw) {
  fail(`#36: an unknown model must not be capped against a table that cannot know it — got ${JSON.stringify(r.threw)}`);
}
if (r.seen.length !== 1) fail(`#36: the unknown-model request should have been sent`);

// --------------------------------------------------- 3. the input budget
const fixture = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-cap-')));
try {
  // Big enough to prove the old 800,000 no longer binds, without writing
  // megabytes of fixture for every run.
  writeFileSync(join(fixture, 'big.txt'), 'x'.repeat(1_500_000));
  const ctx = (env) => child(`
process.env.GLM_MCP_ROOTS = ${JSON.stringify(fixture)};
const c = glm.buildFileContext(['big.txt'], ${JSON.stringify(fixture)});
out.len = c.text.length; out.notes = c.notes; out.cap = glm.MAX_FILE_CHARS;`, env);

  const dflt = ctx({});
  if (!(dflt.cap >= 2_500_000)) {
    fail(`#35: the default input budget is ${dflt.cap} chars — at ~3 chars/token that is ~${Math.round(dflt.cap / 3 / 1000)}k of a 1,048,576-token window. Size it to the window.`);
  }
  // Exact, but computed rather than written down: #19 made the header part of
  // the assembled text, so an untruncated read is the body plus its header —
  // and #53 gave every line a number, so a one-line file's body grows by its
  // `1\t` prefix. A lower bound would accept a duplicated or padded result as
  // success.
  const expected = 1_500_000 + '--- big.txt ---\n'.length + '1\t'.length;
  if (dflt.len !== expected) {
    fail(`#35: a 1.5M-char file assembled to ${dflt.len}, expected exactly ${expected} (body plus its header) — ${JSON.stringify(dflt.notes)}`);
  }
  if ((dflt.notes ?? []).some((n) => /truncat/i.test(n))) {
    fail(`#35: 1.5M chars must fit under a budget sized for a million-token window — ${JSON.stringify(dflt.notes)}`);
  }

  // Derived, not a new magic number: moving the window moves the budget.
  const smaller = ctx({ GLM_MCP_CONTEXT_TOKENS: 200_000 });
  if (!(smaller.cap < dflt.cap)) {
    fail(`#35: the budget must derive from the context window — GLM_MCP_CONTEXT_TOKENS=200000 left it at ${smaller.cap}`);
  }

  // The explicit knob still wins, and the cap still fires and still says so:
  // #19 and #24 must not regress behind a bigger number.
  const pinned = ctx({ GLM_MCP_MAX_FILE_CHARS: 1000 });
  if (pinned.cap !== 1000) fail(`#35: GLM_MCP_MAX_FILE_CHARS must still override, got ${pinned.cap}`);
  if (pinned.len > 1000) fail(`#35: the explicit cap did not bind — ${pinned.len} chars`);
  if (!(pinned.notes ?? []).some((n) => /truncat/i.test(n))) {
    fail(`#35: truncation must still be reported — ${JSON.stringify(pinned.notes)}`);
  }
  const garbage = ctx({ GLM_MCP_MAX_FILE_CHARS: 'abc' });
  if (garbage.cap !== dflt.cap) {
    fail(`#24 regression: an unparsable GLM_MCP_MAX_FILE_CHARS must fall back to the default, got ${garbage.cap}`);
  }
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

// ------------------------------- 4. the tool, not just the function beneath it
// Everything above calls ask() directly. index.ts is what an MCP client
// actually reaches, and it had its own `?? 8192`: restoring that would leave
// every check above green while real callers stayed capped at an eighth of
// the model's default. So drive the server over stdio, the way smoke.mjs
// does, and read what comes out the other end.
{
  const captured = [];
  const upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      captured.push(raw ? JSON.parse(raw) : null);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        model: 'glm-5.3',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${upstream.address().port}`;

  const entry = new URL('../dist/index.js', import.meta.url).pathname;
  const client = new Client({ name: 'glm-mcp-capacity-gate', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ZAI_API_KEY: 'dummy-key-for-the-local-server',
        ZAI_BASE_URL: origin,
      },
    }));
    // Two models with DIFFERENT defaults, both with max_tokens omitted. One
    // model proves nothing: `?? 65_536` in index.ts would satisfy a glm-5.3
    // check and then hand glm-4.6v a value above its own 32,768 ceiling, which
    // the local check would reject — an omitted cap turning into a refusal.
    for (const [model, expect] of [['glm-5.3', 65_536], ['glm-4.6v', 16_384]]) {
      const before = captured.length;
      const res = await client.callTool({
        name: 'glm_ask',
        arguments: { prompt: 'hi', model, reasoning: 'low' },
      });
      if (res.isError) {
        fail(`#36: glm_ask with no max_tokens failed for ${model} — an omitted cap must never become a refusal:\n  ${res.content?.[0]?.text}`);
      }
      if (captured.length !== before + 1) {
        fail(`#36: ${model} produced ${captured.length - before} upstream requests, expected 1`);
      }
      const viaTool = captured[before];
      if (viaTool.max_tokens !== expect) {
        fail(`#36: through the MCP tool, ${model} with no max_tokens asked for ${viaTool.max_tokens}; its own default is ${expect}. The default must come from the model, not from one constant.`);
      }
    }
  } finally {
    await client.close().catch(() => {});
    upstream.close();
  }
}

console.log('CAPACITY OK');

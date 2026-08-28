// Threads (#52): glm_ask's `messages` parameter, pinned at the layer that
// owns each half of the contract. ask() owns the WIRE — prior turns in order
// with their roles, `prompt` appended as the final user turn, a bad role
// refused before a request exists — so its cases run against a local stand-in
// for z.ai and assert on the request that actually left. buildFileContext
// owns the BUDGET — the thread spends the same characters the files do
// (#19's rule meeting a new rider) — so its cases pin the crowding and the
// note that reports it.
//
// The server-level contract (file context riding the FIRST turn, the
// no-thread call unchanged through the tool itself) is verify-thread.mjs's,
// driven over stdio; these are the unit floor beneath it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildFileContext } from '../dist/glm.js';

const execFileAsync = promisify(execFile);
const GLM = pathToFileURL(new URL('../dist/glm.js', import.meta.url).pathname).href;

// ------------------------------------------------------------ the wire shape
// A child with its own recording stand-in for z.ai. The base URL is pointed
// at the child's own server after it listens and before the call — ask()
// re-resolves the endpoint per call (#42), so this is the same repoint an
// operator makes, and every request the child's client builds lands on the
// child's own loopback server.
async function askSent(args) {
  const src = `
import { createServer } from 'node:http';
import * as glm from ${JSON.stringify(GLM)};
const seen = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    seen.push(raw ? JSON.parse(raw) : null);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'm', content: [{ type: 'text', text: 'ok' }], usage: {} }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.ZAI_BASE_URL = 'http://127.0.0.1:' + server.address().port;
const out = {};
try {
  await glm.ask({ model: 'glm-4.6', reasoning: 'none', ...${JSON.stringify(args)} });
} catch (e) { out.threw = String(e && e.message ? e.message : e); }
out.sent = seen;
server.close();
process.stdout.write(JSON.stringify(out));
`;
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (/^(GLM_MCP_|ZAI_)/.test(k)) delete childEnv[k];
  childEnv.ZAI_API_KEY = 'dummy-key-for-the-local-server';
  const { stdout } = await execFileAsync(
    process.execPath, ['--input-type=module', '-e', src],
    { encoding: 'utf8', env: childEnv, timeout: 20_000, maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

test('#52 prior turns arrive in order with their roles, and prompt is the final user turn', async () => {
  const r = await askSent({
    prompt: 'THE-NEW-QUESTION',
    messages: [
      { role: 'user', content: 'FIRST-USER-TURN' },
      { role: 'assistant', content: 'FIRST-ASSISTANT-TURN' },
      { role: 'user', content: 'SECOND-USER-TURN' },
    ],
  });
  assert.equal(r.threw, undefined, `the thread must be askable — ${JSON.stringify(r.threw)}`);
  assert.deepEqual(
    r.sent[0].messages,
    [
      { role: 'user', content: 'FIRST-USER-TURN' },
      { role: 'assistant', content: 'FIRST-ASSISTANT-TURN' },
      { role: 'user', content: 'SECOND-USER-TURN' },
      { role: 'user', content: 'THE-NEW-QUESTION' },
    ],
    `flattened into one voice, the model cannot tell its own prior answer from the caller's words — the turns must arrive as they were handed over, with the new question last: ${JSON.stringify(r.sent[0].messages)}`,
  );
});

test('#52 without messages the request is the single user turn it has always been', async () => {
  for (const args of [{ prompt: 'PLAIN' }, { prompt: 'PLAIN', messages: [] }]) {
    const r = await askSent(args);
    assert.equal(r.threw, undefined, JSON.stringify(r.threw));
    assert.deepEqual(
      r.sent[0].messages,
      [{ role: 'user', content: 'PLAIN' }],
      `an empty \`messages\` is no thread at all — it must be word-for-word the no-parameter call: ${JSON.stringify(r.sent[0].messages)}`,
    );
  }
});

test('#52 a role outside user/assistant is refused here, naming the value, before anything is sent', async () => {
  const r = await askSent({
    prompt: 'hi',
    messages: [{ role: 'user', content: 'fine' }, { role: 'operator', content: 'x' }],
  });
  assert.equal(r.sent.length, 0,
    `nothing may reach the API — z.ai answers that role with a 422 after the round trip, and the round trip is what the refusal exists to save: ${JSON.stringify(r.sent)}`);
  assert.match(r.threw ?? '', /operator/,
    `the refusal must name the caller's own value so it can fix its spelling — got ${JSON.stringify(r.threw)}`);
});

test('#52 no alternation is imposed that the upstream does not have', async () => {
  // Measured against the live API: z.ai accepts an assistant turn first,
  // consecutive turns of one role and a trailing assistant turn. Validation
  // stricter than that turns a working conversation into an error for no
  // gain, and a caller replaying a real transcript hits it immediately.
  for (const [what, messages] of [
    ['an assistant turn first', [{ role: 'assistant', content: 'A' }]],
    ['two user turns in a row', [{ role: 'user', content: 'A' }, { role: 'user', content: 'B' }]],
    ['two assistant turns in a row', [{ role: 'assistant', content: 'A' }, { role: 'assistant', content: 'B' }]],
    ['a trailing assistant turn', [{ role: 'user', content: 'A' }, { role: 'assistant', content: 'B' }]],
  ]) {
    const r = await askSent({ prompt: 'hi', messages });
    assert.equal(r.threw, undefined, `${what} was refused — ${JSON.stringify(r.threw)}`);
    assert.deepEqual(
      r.sent[0].messages,
      [...messages, { role: 'user', content: 'hi' }],
      `${what} must pass through as it was handed over, with the new question appended`,
    );
  }
});

// ------------------------------------------------------------- the budget
// The same fixture the acceptance gate uses: lines a marker can be counted
// in, so "less room" is a count and not a length someone has to recompute.
const RAW = mkdtempSync(join(tmpdir(), 'glm-thread-test-'));
const ROOT = realpathSync.native(RAW);
const MARKER = 'FILE-CONTEXT-MARKER';
writeFileSync(
  join(ROOT, 'ctx.ts'),
  Array.from({ length: 60 }, (_, i) => `export const marker${i + 1} = "${MARKER}";`).join('\n'),
);

const markersIn = (text) => (text.match(new RegExp(MARKER, 'g')) ?? []).length;

// GLM_MCP_ROOTS and the char cap are read per call, so the cases pin them in
// process and restore what they displaced. The fixture tree outlives the
// cases — it is cleaned once, after them — because the budget cases read it
// in sequence and a teardown that ran per test would delete it out from
// under the ones still to come.
after(() => rmSync(ROOT, { recursive: true, force: true }));

const pin = (t, chars) => {
  const saved = {};
  for (const name of ['GLM_MCP_ROOTS', 'GLM_MCP_MAX_FILE_CHARS']) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.GLM_MCP_ROOTS = ROOT;
  process.env.GLM_MCP_MAX_FILE_CHARS = String(chars);
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
};

test('#52 the thread competes with the files for the same budget, and the cut says so', (t) => {
  pin(t, 1500);
  const alone = buildFileContext(['ctx.ts'], ROOT, 'glm-4.6');
  const crowded = buildFileContext(['ctx.ts'], ROOT, 'glm-4.6', 1200);
  assert.ok(
    markersIn(crowded.text) < markersIn(alone.text),
    `a 1,200-character history left ${markersIn(crowded.text)} markers to the no-history call's ` +
      `${markersIn(alone.text)} — a budget that counts only the files is not a budget (#19)`,
  );
  const note = (crowded.notes ?? []).find((n) => /truncat/i.test(n)) ?? '';
  assert.match(
    note, /thread history spent 1200 of it/,
    `the history crowded out file context and the note must say so — ${JSON.stringify(crowded.notes)}`,
  );
  // The no-thread call's note is word-for-word the one it has always been.
  const zero = buildFileContext(['ctx.ts'], ROOT, 'glm-4.6', 0);
  assert.deepEqual(zero.notes, alone.notes,
    `an explicit zero spend is the no-thread call — its notes must not differ: ${JSON.stringify(zero.notes)}`);
});

test('#52 a thread longer than the whole budget leaves the files nothing, loudly', (t) => {
  pin(t, 1500);
  const r = buildFileContext(['ctx.ts'], ROOT, 'glm-4.6', 5000);
  assert.equal(r.text, '',
    'the history spent the whole cap, so no file content may be assembled into negative room');
  assert.ok(
    r.notes.some((n) => /truncated at 0 total chars/.test(n) && /thread history spent 5000/.test(n)),
    `the nothing-left outcome is reported, never silent — ${JSON.stringify(r.notes)}`,
  );
});

test('#52 no spend a caller can name buys file context the cap never allowed', (t) => {
  pin(t, 1500);
  const alone = buildFileContext(['ctx.ts'], ROOT, 'glm-4.6');
  const negative = buildFileContext(['ctx.ts'], ROOT, 'glm-4.6', -500);
  assert.equal(negative.text, alone.text,
    'a negative historyChars must not raise the cap above the operator\'s setting');
});

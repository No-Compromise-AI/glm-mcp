import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const fail = (msg) => { throw new Error(msg); };
const INDEX = new URL('../dist/index.js', import.meta.url).pathname;

const PROGRESS_MS = 300;      // fast enough to test, slow enough to count
const CALL_MS = 2_000;        // ~6 intervals of upstream work

let upstream;
let child;
let holdMs = CALL_MS;
let statusCode = 200;

try {
  upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      setTimeout(() => {
        if (res.destroyed || res.writableEnded) return;
        res.statusCode = statusCode;
        res.setHeader('content-type', 'application/json');
        res.end(statusCode === 200
          ? JSON.stringify({ model: 'glm-4.6', content: [{ type: 'text', text: 'the answer' }],
              usage: { input_tokens: 7, output_tokens: 11 } })
          : JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'stub refusal' } }));
      }, holdMs);
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  // THE WIRE, not the SDK's convenience layer. An earlier draft of this gate
  // used the client's `onprogress` callback and three of its six rules could
  // not fail: the client SDK silently drops progress whose token it is not
  // tracking, and progress for a request that has already resolved — which is
  // exactly what rules 2, 3 and 4 exist to catch. Reading the frames the server
  // actually writes is the only place those rules are falsifiable, and it is
  // the real protocol boundary; `onprogress` is a filtered view of it.
  child = spawn(process.execPath, [INDEX], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ZAI_API_KEY: 'dummy-key-for-the-local-server',
      ZAI_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      GLM_MCP_PROGRESS_MS: String(PROGRESS_MS),
    },
  });

  const frames = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { frames.push({ at: Date.now(), msg: JSON.parse(line) }); } catch { /* not a frame */ }
    }
  });
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  const awaitId = async (id, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = frames.find((f) => f.msg?.id === id && ('result' in f.msg || 'error' in f.msg));
      if (hit) return hit;
      if (Date.now() > deadline) fail(`no response to request ${id} within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'progress-gate', version: '1.0.0' } } });
  await awaitId(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  let nextId = 2;
  // One call, watching the wire. `progressToken` is supplied — or deliberately
  // not — exactly as a real client would, and every frame is stamped on arrival,
  // so "during" is a comparison of two numbers rather than a hope about ordering.
  const watched = async (args, { withProgress = true } = {}) => {
    const id = nextId++;
    const token = `tok-${id}`;
    const params = { name: 'glm_ask', arguments: args };
    if (withProgress) params._meta = { progressToken: token };
    const started = Date.now();
    send({ jsonrpc: '2.0', id, method: 'tools/call', params });
    const done = await awaitId(id, 60_000);
    const seen = () => frames.filter((f) =>
      f.msg?.method === 'notifications/progress' &&
      (!withProgress || f.msg?.params?.progressToken === token));
    return { started, finished: done.at, res: done.msg.result ?? { isError: true, content: [{ type: 'text', text: JSON.stringify(done.msg.error) }] }, seen, token };
  };

  const ARGS = { prompt: 'hi', model: 'glm-4.6', reasoning: 'none' };

  // ---------- rule 1: a client that asks for progress hears something first
  const run = await watched(ARGS);
  const runSeen = run.seen();
  if (runSeen.length === 0) {
    fail(`#43: the call took ${run.finished - run.started}ms and the client received no progress notification at all. MCP defines them for exactly this, and the caller's UI is a black box until the answer lands — long enough that people kill the call, and on a kill they get nothing, because nothing was ever delivered.`);
  }
  const before = runSeen.filter((f) => f.at < run.finished);
  if (before.length === 0) {
    fail(`#43: ${runSeen.length} notification(s) arrived, none of them before the result. Progress delivered with the answer is not progress — the whole point is that something reaches the caller while the model is still working.`);
  }

  // -------------- rule 5: a heartbeat, not one beat and not a flood
  const elapsed = run.finished - run.started;
  const intervals = Math.floor(elapsed / PROGRESS_MS);
  if (intervals >= 3 && before.length < 2) {
    fail(`#43: the call spanned about ${intervals} intervals of ${PROGRESS_MS}ms and produced ${before.length} notification(s). One notification at the start tells a caller the request was accepted, not that it is still alive — the second one is what distinguishes "working" from "hung".`);
  }
  if (before.length > intervals * 4 + 10) {
    fail(`#43: ${before.length} notifications in ${elapsed}ms at an interval of ${PROGRESS_MS}ms. This is a heartbeat; a caller's transport and log should not have to absorb a stream.`);
  }

  // -------------------- rule 6: the answer is exactly what it was
  {
    const text = run.res.content?.map((c) => c.text ?? '').join('\n') ?? '';
    if (run.res.isError) fail(`#43: the call failed — ${text.slice(0, 200)}`);
    if (!text.includes('the answer')) fail(`#43: the model's text did not survive — ${JSON.stringify(text.slice(0, 120))}`);
    if (!/^\[.*\]$/m.test(text)) {
      fail(`#43: the usage footer is gone from the result. Progress is additive: what a caller already reads after a call must not change because the call now also reports on itself.`);
    }
  }

  // ------ rule 3: nothing arrives after the result
  await new Promise((r) => setTimeout(r, PROGRESS_MS * 4));
  const after = run.seen().filter((f) => f.at > run.finished + 50);
  if (after.length > 0) {
    fail(`#43: ${after.length} notification(s) arrived after the result had been returned. A heartbeat that outlives its own call is a leak — invisible on one call, and on a busy server it is every finished call still beating.`);
  }

  // ------ rule 2: a client that did not ask for progress is not sent any
  {
    const quiet = await watched(ARGS, { withProgress: false });
    const quietSeen = frames.filter((f) => f.msg?.method === 'notifications/progress' && f.at >= quiet.started);
    if (quietSeen.length > 0) {
      fail(`#43: ${quietSeen.length} notification(s) were sent to a client that supplied no progress token. Unsolicited progress is a protocol violation rather than a courtesy — the token is how a client says it wants them.`);
    }
    if (quiet.res.isError) fail('#43: the no-progress call failed');
  }

  // ------ rule 4: a call that FAILS stops beating too
  {
    statusCode = 400;
    const failed = await watched(ARGS);
    if (!failed.res.isError) fail('#43: the stub refused the request and the tool reported success — this case is not testing what it thinks it is');
    await new Promise((r) => setTimeout(r, PROGRESS_MS * 4));
    const stragglers = failed.seen().filter((f) => f.at > failed.finished + 50);
    if (stragglers.length > 0) {
      fail(`#43: ${stragglers.length} notification(s) kept arriving after the call FAILED. The error path is where an orphaned heartbeat hides, because the happy path is the one that gets tested — and a server that beats forever after a failure is worse than one that never beat at all.`);
    }
    statusCode = 200;
  }
} finally {
  if (child) child.kill();
  if (upstream) upstream.close();
}

console.log('PROGRESS OK');

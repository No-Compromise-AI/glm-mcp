// What glm_models claims about a model must agree with what glm_ask does (#54).
//
// The request path defaults reasoning to "low" — a 2,048-token thinking block —
// so glm-4.6 and glm-4.7 reason until the caller explicitly selects "none".
// Their roles said "runs with reasoning off", which reads beside glm-5.3's "it
// always reasons" as a statement of behaviour, and steers a latency-sensitive
// caller to pick the model and omit the knob: the thinking the listing said
// was off is then generated before the first character of the answer. The
// listing and the request path must not drift apart in either direction, so
// this suite drives the real server over stdio, captures the request the
// default actually produces, and reads the role the caller reads beside the id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const INDEX = new URL('../dist/index.js', import.meta.url).pathname;

// The models whose roles offer the reasoning-off route. glm-5.3's role is the
// mirror — "it always reasons" — and the request path agrees with it, so it
// needs no conditional.
const OPTIONAL_REASONING = ['glm-4.6', 'glm-4.7'];

// The one line of the listing an id appears on, bounded so glm-4.6 does not
// match glm-4.6v's line.
const lineFor = (text, id) =>
  text.split('\n').find((l) => new RegExp(`(^|[^a-z0-9.\\-])${id.replace(/[.\-]/g, '\\$&')}([^a-z0-9.\\-]|$)`, 'i').test(l));

test('#54 a role may offer reasoning off only as a choice, because the silent caller still reasons', async () => {
  // The stand-in z.ai: the chat endpoint records the request the default
  // produces, the models endpoint returns the ids under test.
  const bodies = [];
  const upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      bodies.push(raw ? JSON.parse(raw) : null);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        model: 'glm-4.6',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  const stubModels = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      data: [...OPTIONAL_REASONING.map((id) => ({ id })), { id: 'glm-4.6v' }, { id: 'glm-5.3' }],
    }));
  });
  await Promise.all([
    new Promise((r) => upstream.listen(0, '127.0.0.1', r)),
    new Promise((r) => stubModels.listen(0, '127.0.0.1', r)),
  ]);

  const client = new Client({ name: 'glm-routing-test', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [INDEX],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ZAI_API_KEY: 'dummy-key-for-the-local-server',
        ZAI_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
        ZAI_MODELS_URL: `http://127.0.0.1:${stubModels.address().port}/models`,
      },
    }));

    const listing = await client.callTool({ name: 'glm_models', arguments: {} });
    const modelsText = listing.content?.map((c) => c.text ?? '').join('\n') ?? '';
    assert.ok(!listing.isError, `glm_models failed against the stub endpoint: ${modelsText}`);

    for (const model of OPTIONAL_REASONING) {
      const line = lineFor(modelsText, model);
      assert.ok(line, `glm_models did not list ${model} — ${JSON.stringify(modelsText)}`);
      const role = line.slice(line.toLowerCase().indexOf(model) + model.length);

      // The premise the role must not contradict, taken from the request the
      // silent caller produces: the server sends a thinking block, "low"'s
      // 2,048 (the README documents the default). If this ever fails, listing
      // and request path have drifted the OTHER way and the roles must be
      // reworded to match — the test exists to force that reconciliation.
      bodies.length = 0;
      const res = await client.callTool({ name: 'glm_ask', arguments: { prompt: 'hi', model } });
      assert.ok(!res.isError, `glm_ask failed against the stub upstream: ${JSON.stringify(res.content)}`);
      const sent = bodies[0];
      assert.ok(sent?.thinking,
        `${model} with reasoning omitted sent no thinking block — then "runs with reasoning off" ` +
          `would be its default, and this test's premise (and wording rule) is stale`);
      assert.equal(sent.thinking.budget_tokens, 2048,
        `${model} with reasoning omitted must send the "low" budget of 2,048 — got ${JSON.stringify(sent.thinking)}`);

      // The role may sell the model as the reasoning-off route, but only as a
      // capability under the caller's own selection: the factual form "runs
      // with reasoning off" is false of the request captured three lines up.
      assert.match(role, /can run with reasoning off/i,
        `${model}'s role offers the reasoning-off route without saying it is the caller's ` +
          `choice — ${JSON.stringify(role)} — and the default request reasons`);
      assert.match(role, /\bwhen\b/i,
        `${model}'s role never says when reasoning is off — ${JSON.stringify(role)} — ` +
          `so the caller cannot know it must select "none" itself`);
      assert.doesNotMatch(role, /\bruns with reasoning off\b/i,
        `${model}'s role states reasoning off as behaviour — ${JSON.stringify(role)} — ` +
          `but the request above reasons with 2,048 tokens of thinking`);
    }
  } finally {
    await client.close().catch(() => {});
    upstream.close();
    stubModels.close();
  }
});

test('#54 the cap the max_tokens description says is refused is the cap the request path refuses', async () => {
  // The description quotes a refusal threshold ("A cap below N ... is refused
  // rather than silently raised"), and a threshold in prose is a claim about
  // the request path. It drifted once already: the description quoted
  // MIN_BUDGET_TOKENS + ANSWER_ROOM while ask() refuses below
  // MIN_BUDGET_TOKENS + MIN_ANSWER_TOKENS — ANSWER_ROOM is only what a
  // generous cap PREFERS to leave — so every cap in the band between the two
  // (3,000, 5,000, 5,119) was "refused" on paper and sent in fact. The test
  // takes the threshold from the description the caller actually receives and
  // holds the request path to it on both sides, so neither side can drift
  // again without this failing: the cap just under it must never reach the
  // API, and the cap at it must be sent.
  const bodies = [];
  const upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      bodies.push(raw ? JSON.parse(raw) : null);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        model: 'glm-5.3',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  const stubModels = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'glm-5.3' }] }));
  });
  await Promise.all([
    new Promise((r) => upstream.listen(0, '127.0.0.1', r)),
    new Promise((r) => stubModels.listen(0, '127.0.0.1', r)),
  ]);

  const client = new Client({ name: 'glm-cap-claim-test', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [INDEX],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ZAI_API_KEY: 'dummy-key-for-the-local-server',
        ZAI_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
        ZAI_MODELS_URL: `http://127.0.0.1:${stubModels.address().port}/models`,
      },
    }));

    const tools = (await client.listTools()).tools;
    const askTool = tools.find((t) => t.name === 'glm_ask');
    const description = askTool?.inputSchema?.properties?.max_tokens?.description ?? '';
    const quoted = /A cap below ([\d,]+)/.exec(description);
    assert.ok(quoted,
      `the max_tokens description no longer quotes a refusal threshold — ${JSON.stringify(description)}`);
    const threshold = Number(quoted[1].replaceAll(',', ''));

    // Just under the quoted threshold: the description promises a refusal
    // before anything is sent, on a model that always reasons.
    bodies.length = 0;
    const below = await client.callTool({
      name: 'glm_ask',
      arguments: { prompt: 'hi', model: 'glm-5.3', reasoning: 'low', max_tokens: threshold - 1 },
    });
    assert.ok(below.isError,
      `the description says a cap below ${threshold} is refused, but ${threshold - 1} was accepted — ` +
        `${JSON.stringify(below.content)}`);
    assert.equal(bodies.length, 0,
      `the description says a cap below ${threshold} is refused rather than sent, but a request ` +
        `reached the API: ${JSON.stringify(bodies[0])}`);

    // At the quoted threshold: the least cap the description still permits
    // must actually go through, thinking block and all — a threshold quoted a
    // band too high turns real requests into paperwork refusals.
    bodies.length = 0;
    const at = await client.callTool({
      name: 'glm_ask',
      arguments: { prompt: 'hi', model: 'glm-5.3', reasoning: 'low', max_tokens: threshold },
    });
    assert.ok(!at.isError, `a cap of ${threshold} must be sent, not refused — ${JSON.stringify(at.content)}`);
    assert.ok(bodies[0]?.thinking,
      `a cap of ${threshold} reached the API without a thinking block — ${JSON.stringify(bodies[0])}`);
  } finally {
    await client.close().catch(() => {});
    upstream.close();
    stubModels.close();
  }
});

// verify-thread.mjs — acceptance gate for pushing back on an answer (#52).
//
// Every glm_ask call is independent. The natural second-opinion flow is
// disagreement — "you flagged session.ts:88, but the caller holds the lock" —
// and today that means re-sending the whole file context and hoping the
// consultant re-derives its own prior reasoning. GLM-5.3 ranked this first by a
// clear margin when asked what would most change how a Claude instance uses the
// tool: "Today I budget one big careful question; with threads I'd iterate."
//
// The issue offers a session id or a caller-owned `messages` array and prefers
// the second — less state to hold, and it composes with a server that may be
// restarted underneath the caller. This gate is written for that choice.
//
// MEASURED FIRST against the live API, so nothing here is invented:
//
//   3-turn thread              works — the model answered from the history
//   assistant speaks first     accepted
//   two users in a row         accepted
//   two assistants in a row    accepted
//   trailing assistant turn    accepted
//   empty messages array       400, code 1214 "Input cannot be empty"
//   role: "operator"           422, schema error
//
// z.ai imposes NO alternation rule, and rule 6 forbids inventing one: a tool
// that refuses threads its own upstream accepts is less useful than the API
// beneath it, and that is a real temptation when writing validation.
//
// Everything is driven through the SERVER over stdio rather than through the
// functions beneath it. The caller-facing contract is `glm_ask`'s arguments and
// the request that reaches the wire; how the pieces are plumbed between them is
// the implementation's business, and a gate that reached inside would be
// specifying a design instead of a property.
//
//   1. prior turns arrive in order with their roles, and `prompt` is the final
//      user turn — the caller owns the history, the server owns the question;
//   2. file context rides on the FIRST turn. This is why #52 pairs with
//      caching: measured on this account, a stable prefix with a varying tail
//      already reads from cache (32,429 input tokens down to 45), so a thread
//      stays cheap only while the context stays at the front;
//   3. no `messages` behaves exactly as it does today;
//   4. a role the schema forbids is refused HERE, naming the caller's own
//      value, rather than learned from a 422 after the round trip (#36);
//   5. the thread competes with the files for the same budget — #19's rule,
//      and the same interaction #53's line numbers had;
//   6. no alternation rule is invented on top of an upstream that has none.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fail = (msg) => { throw new Error(msg); };
const INDEX = new URL('../dist/index.js', import.meta.url).pathname;

const contentOf = (m) =>
  typeof m?.content === 'string'
    ? m.content
    : Array.isArray(m?.content) ? m.content.map((b) => b?.text ?? '').join('') : '';

const ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-thread-')));
const MARKER = 'FILE-CONTEXT-MARKER';

let upstream;
let client;
const sent = [];

try {
  writeFileSync(join(ROOT, 'ctx.ts'),
    Array.from({ length: 60 }, (_, i) => `export const marker${i + 1} = "${MARKER}";`).join('\n'));

  upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      sent.push(raw ? JSON.parse(raw) : null);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'm', content: [{ type: 'text', text: 'ok' }], usage: {} }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  const connect = async (env = {}) => {
    if (client) await client.close().catch(() => {});
    client = new Client({ name: 'glm-mcp-thread-gate', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [INDEX],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ZAI_API_KEY: 'dummy-key-for-the-local-server',
        ZAI_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
        GLM_MCP_ROOTS: ROOT,
        ...env,
      },
    }));
  };

  const call = async (args) => {
    sent.length = 0;
    const res = await client.callTool({ name: 'glm_ask', arguments: args });
    const text = res.content?.map((c) => c.text ?? '').join('\n') ?? '';
    return { isError: !!res.isError, text, body: sent[0], count: sent.length };
  };

  await connect();

  // ---- the parameter has to exist before any rule below can mean anything
  {
    const tool = (await client.listTools()).tools.find((t) => t.name === 'glm_ask')
      ?? fail('no glm_ask tool advertised');
    if (!tool.inputSchema?.properties?.messages) {
      fail('#52: glm_ask advertises no `messages` parameter, so a caller has no way to push back on an answer without re-sending everything. The issue asks for the caller to own the history — less state than a session id, and it survives the server restarting underneath them.');
    }
  }

  // ------------------ rule 1: the history arrives, in order, with its roles
  {
    const r = await call({
      prompt: 'THE-NEW-QUESTION',
      model: 'glm-4.6',
      reasoning: 'none',
      messages: [
        { role: 'user', content: 'FIRST-USER-TURN' },
        { role: 'assistant', content: 'FIRST-ASSISTANT-TURN' },
        { role: 'user', content: 'SECOND-USER-TURN' },
      ],
    });
    if (r.isError) fail(`#52: glm_ask rejected a thread — ${r.text.slice(0, 300)}`);
    const msgs = r.body?.messages ?? [];
    const texts = msgs.map(contentOf);

    for (const [i, want] of [[0, 'FIRST-USER-TURN'], [1, 'FIRST-ASSISTANT-TURN'], [2, 'SECOND-USER-TURN']]) {
      if (!texts[i]?.includes(want)) {
        fail(`#52: turn ${i} does not carry ${want} — the request sent ${JSON.stringify(texts.map((t) => t.slice(0, 40)))}. A follow-up that loses the history it was handed is the stateless oracle this issue is about, wearing a new parameter.`);
      }
    }
    if (msgs[1]?.role !== 'assistant') {
      fail(`#52: the assistant turn arrived with role ${JSON.stringify(msgs[1]?.role)}. Roles are what make a thread a thread — flattened into one voice, the model cannot tell its own prior answer from the caller's words.`);
    }
    const last = msgs[msgs.length - 1];
    if (last?.role !== 'user' || !contentOf(last).includes('THE-NEW-QUESTION')) {
      fail(`#52: the new prompt is not the final user turn — the last message is ${JSON.stringify({ role: last?.role, text: contentOf(last).slice(0, 60) })}. \`messages\` is the history the caller owns; \`prompt\` is the question being asked now.`);
    }
    if (texts.slice(0, -1).some((t) => t.includes('THE-NEW-QUESTION'))) {
      fail('#52: the new prompt also appears in an earlier turn — sent twice, the model is answering a question it has already been shown.');
    }
  }

  // ------- rule 2: file context rides on the FIRST turn, not on the newest
  {
    const r = await call({
      prompt: 'LATEST-QUESTION',
      model: 'glm-4.6',
      reasoning: 'none',
      files: ['ctx.ts'],
      cwd: ROOT,
      messages: [
        { role: 'user', content: 'OLD-QUESTION' },
        { role: 'assistant', content: 'OLD-ANSWER' },
      ],
    });
    if (r.isError) fail(`#52: a thread carrying files failed — ${r.text.slice(0, 300)}`);
    const texts = (r.body?.messages ?? []).map(contentOf);
    if (!texts.length) fail('#52: no request captured for the file-context thread case');
    if (!texts[0].includes(MARKER)) {
      fail(`#52: the file context is not on the FIRST turn — turn 0 is ${JSON.stringify(texts[0].slice(0, 90))}. The prefix has to stay at the front across a thread: measured on this account, a stable prefix with a varying tail already reads from cache, 32,429 input tokens down to 45. Move the context to the newest turn and every follow-up re-prefills, which is the cost this issue exists to remove.`);
    }
    if (texts.length > 1 && texts[texts.length - 1].includes(MARKER)) {
      fail('#52: the file context is repeated on the newest turn as well as the first. Sent twice it is paid for twice, and the prefix stops matching the previous turn, so the cache misses on every follow-up.');
    }
  }

  // ----------------- rule 3: no `messages` behaves exactly as it does today
  {
    const r = await call({ prompt: 'PLAIN', model: 'glm-4.6', reasoning: 'none', files: ['ctx.ts'], cwd: ROOT });
    if (r.isError) fail(`#52: the no-thread path failed — ${r.text.slice(0, 300)}. Threads are additive; a caller that never passes \`messages\` must not notice this change.`);
    const msgs = r.body?.messages ?? [];
    if (msgs.length !== 1 || msgs[0].role !== 'user') {
      fail(`#52: without \`messages\` the request should be a single user turn, and it sent ${msgs.length} (${JSON.stringify(msgs.map((m) => m.role))}). Every existing caller is on this path.`);
    }
    const only = contentOf(msgs[0]);
    if (!only.includes('PLAIN') || !only.includes(MARKER)) {
      fail('#52: the single-turn request lost either the prompt or the file context');
    }
  }

  // -- rule 4: a role the schema forbids is refused here, in the caller's words
  {
    const r = await call({
      prompt: 'hi', model: 'glm-4.6', reasoning: 'none',
      messages: [{ role: 'operator', content: 'x' }],
    });
    if (r.count !== 0) {
      fail('#52: a message with role "operator" was sent to z.ai rather than refused here. Measured: z.ai answers that with a 422 schema error — a round trip spent learning something this server already knows, and #36 refuses an over-ceiling max_tokens locally for exactly this reason.');
    }
    if (!r.isError) fail('#52: a bad role produced no error at all');
    if (!/operator/.test(r.text)) {
      fail(`#52: the refusal never names the role the caller sent — ${JSON.stringify(r.text.slice(0, 200))}. A caller can fix its own spelling; it cannot fix a message that will not say which value was wrong (#13).`);
    }
  }

  // ---------- rule 5: the thread competes with the files for the same budget
  // #19's rule, and the interaction #53's numbering had: what the server
  // assembles has to fit the budget, and whatever it drops it reports.
  {
    await connect({ GLM_MCP_MAX_FILE_CHARS: '1500' });
    const fileChars = async (history) => {
      const r = await call({
        prompt: 'q', model: 'glm-4.6', reasoning: 'none', files: ['ctx.ts'], cwd: ROOT,
        ...(history ? { messages: history } : {}),
      });
      if (r.isError) fail(`#52: budgeting with a thread failed — ${r.text.slice(0, 300)}`);
      const all = (r.body?.messages ?? []).map(contentOf).join('');
      return { markers: (all.match(new RegExp(MARKER, 'g')) ?? []).length, text: r.text };
    };
    const alone = await fileChars(null);
    const crowded = await fileChars([{ role: 'user', content: 'H'.repeat(1200) }]);
    if (!(crowded.markers < alone.markers)) {
      fail(`#52: a 1,200-character history left ${crowded.markers} lines of file context, the same as with no history (${alone.markers}). The thread is sent too, so it spends the same window — a budget that counts only the files is not a budget, which is what #19 was about and what #53's numbering repeated.`);
    }
    if (!/truncat/i.test(crowded.text)) {
      fail(`#52: the history crowded out file context and the reply said nothing about it — ${JSON.stringify(crowded.text.slice(-220))}. Silent truncation is the failure mode this project has spent the most effort eliminating.`);
    }
    await connect();
  }

  // ------ rule 6: do not invent an alternation rule the upstream does not have
  for (const [what, messages] of [
    ['an assistant turn first', [{ role: 'assistant', content: 'A' }]],
    ['two user turns in a row', [{ role: 'user', content: 'A' }, { role: 'user', content: 'B' }]],
    ['two assistant turns in a row', [{ role: 'assistant', content: 'A' }, { role: 'assistant', content: 'B' }]],
  ]) {
    const r = await call({ prompt: 'hi', model: 'glm-4.6', reasoning: 'none', messages });
    if (r.isError || r.count !== 1) {
      fail(`#52: ${what} was refused — ${JSON.stringify(r.text.slice(0, 200))}. Measured against the live API, z.ai accepts it. Validation stricter than the upstream turns a working conversation into an error for no gain, and a caller replaying a real transcript hits it immediately.`);
    }
  }
} finally {
  if (client) await client.close().catch(() => {});
  if (upstream) upstream.close();
  rmSync(ROOT, { recursive: true, force: true });
}

console.log('THREAD OK');

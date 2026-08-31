// verify-schema.mjs — acceptance gate for the last item of #56: a verdict
// instead of paragraphs.
//
// When a caller wants `{ finding, severity, lines }` it is currently parsing
// prose. The Anthropic-compatible endpoint supports tool use, which gives
// schema-enforced shapes and makes the consultant composable instead of merely
// readable.
//
// THE PROPERTY, at the tool boundary:
//
//   A caller that asks for a shape gets that shape or a clear failure — never
//   prose it has to parse, and never a shape it merely asked for politely.
//
// The second half of that is the whole reason to use tool use rather than the
// cheap version. "Reply as JSON like {...}" in the prompt is unenforced: the
// model can preface it, wrap it in a fence, apologise first, or drift on the
// twentieth call after nineteen good ones. A caller cannot tell a formatting
// drift from a real answer without parsing, which is the parsing this was
// supposed to remove. Rule 5 forbids exactly that implementation.
//
// RULES
//   1. With a schema, the request carries ONE tool whose input_schema is the
//      caller's schema, and tool_choice FORCES it. An offered-but-optional tool
//      is a suggestion, and a suggestion is what prose already was.
//   2. The answer is the model's structured value, emitted as JSON — not the
//      prose around it, and not the raw tool_use envelope the caller did not
//      ask for.
//   3. If no structured value comes back, the caller is TOLD. Handing back
//      whatever prose arrived would be a shape-shaped promise broken silently,
//      which is worse than the prose it replaced.
//   4. CONTROL: with no schema the request carries NO tools and the answer is
//      prose exactly as before. Every existing caller is on that path.
//   5. FORBID THE WRONG FIX: the schema is not asked for in the prompt. If the
//      request's text contains the schema, this is the unenforced version
//      wearing the enforced one's name.
//   6. An unusable schema is refused BEFORE the round trip, naming the problem
//      — a 400 from the vendor arrives later and explains less.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fail = (msg) => { throw new Error(msg); };
const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
if (!existsSync(ENTRY)) fail('rule 0: dist/index.js does not exist — run `npm run build` first');

let checks = 0;
const check = (ok, msg) => { checks++; if (!ok) fail(msg); };

const SCHEMA = {
  type: 'object',
  properties: {
    finding: { type: 'string' },
    severity: { type: 'string', enum: ['P1', 'P2'] },
    lines: { type: 'array', items: { type: 'number' } },
  },
  required: ['finding', 'severity'],
};

const seen = [];
// `reply` decides what the stub sends back, so rule 3 can drive the case where
// the model answers with prose instead of the tool it was told to use.
let reply = 'tool';
const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    try { seen.push(JSON.parse(body)); } catch { seen.push({ unparsed: body }); }
    const content = reply === 'tool'
      ? [{
          type: 'tool_use', id: 'tu_1', name: (seen.at(-1)?.tools?.[0]?.name) ?? 'emit',
          input: { finding: 'the token is logged', severity: 'P1', lines: [42] },
        }]
      : [{ type: 'text', text: 'I would rather explain this in prose, at length.' }];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'm', type: 'message', role: 'assistant', model: 'glm-5.3',
      content, stop_reason: reply === 'tool' ? 'tool_use' : 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${upstream.address().port}`;
const roots = mkdtempSync(join(tmpdir(), 'glm-schema-gate-'));

function run(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [ENTRY, ...args], {
      cwd: roots,
      env: { ...process.env, ZAI_API_KEY: 'k', ZAI_BASE_URL: origin, GLM_MCP_ROOTS: roots },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
const sent = () => seen[0] ?? {};

// Rules 1, 2 and 5 — one forced tool, the value back, and nothing in the prompt.
reply = 'tool'; seen.length = 0;
const r1 = await run(['ask', '--schema', JSON.stringify(SCHEMA), 'where does this leak?']);
check(r1.code === 0, `rule 1: exited ${r1.code}. stderr:\n${r1.err.slice(-700)}`);
{
  const tools = sent().tools ?? [];
  check(tools.length === 1,
    `rule 1: exactly one tool must be offered; ${tools.length} were. Sent:\n${JSON.stringify(sent()).slice(0, 400)}`);
  check(JSON.stringify(tools[0]?.input_schema) === JSON.stringify(SCHEMA),
    `rule 1: the tool's input_schema must be the caller's schema, unaltered. Sent:\n${JSON.stringify(tools[0]?.input_schema)}`);
  check(sent().tool_choice?.type === 'tool' && sent().tool_choice?.name === tools[0]?.name,
    `rule 1: tool_choice must FORCE that tool. An offered-but-optional tool is a suggestion, and a ` +
    `suggestion is what prose already was. Sent: ${JSON.stringify(sent().tool_choice)}`);

  let parsed;
  try { parsed = JSON.parse(r1.out); } catch { parsed = undefined; }
  check(parsed !== undefined,
    `rule 2: stdout must be the structured value as JSON, parseable without help. It was:\n${r1.out.slice(0, 400)}`);
  check(parsed?.finding === 'the token is logged' && parsed?.severity === 'P1',
    `rule 2: the value must be the model's, not the envelope around it. Got: ${JSON.stringify(parsed)}`);
  check(parsed?.type !== 'tool_use' && parsed?.input === undefined,
    `rule 2: the raw tool_use envelope was handed back; the caller asked for its input, not its ` +
    `packaging. Got: ${JSON.stringify(parsed).slice(0, 300)}`);

  const promptText = JSON.stringify(sent().messages ?? []);
  check(!promptText.includes('input_schema') && !promptText.includes('"severity"'),
    `rule 5: the schema was put in the PROMPT. That is the unenforced version wearing the enforced ` +
    `one's name — the model can preface it, fence it, or drift on the twentieth call, and the caller ` +
    `is parsing prose again. Prompt was:\n${promptText.slice(0, 400)}`);
}

// Rule 3 — a promise of a shape, broken, must be said out loud.
{
  reply = 'prose'; seen.length = 0;
  const r = await run(['ask', '--schema', JSON.stringify(SCHEMA), 'q']);
  check(r.code !== 0,
    `rule 3: when no structured value comes back the call must fail; it exited ${r.code}. Handing ` +
    `back whatever prose arrived is a shape-shaped promise broken silently, which is worse than the ` +
    `prose it replaced.`);
  check(!/rather explain this in prose/.test(r.out),
    `rule 3: the prose was printed to stdout as if it were the answer. stdout:\n${r.out.slice(0, 300)}`);
  check(/schema|structured|tool/i.test(r.err),
    `rule 3: stderr must say the shape was not produced. It said:\n${r.err.slice(-400)}`);
}

// Rule 4 — CONTROL: nothing changes without a schema.
{
  reply = 'prose'; seen.length = 0;
  const r = await run(['ask', 'just a question']);
  check(r.code === 0, `rule 4: exited ${r.code}. stderr:\n${r.err.slice(-400)}`);
  check(sent().tools === undefined && sent().tool_choice === undefined,
    `rule 4: with no schema the request must carry no tools at all. Sent: ` +
    `${JSON.stringify({ tools: sent().tools, tool_choice: sent().tool_choice })}`);
  check(/rather explain this in prose/.test(r.out),
    `rule 4: prose must still come back as prose. stdout:\n${r.out.slice(0, 300)}`);
}

// Rule 6 — an unusable schema is refused here, not by the vendor later.
for (const [bad, why] of [
  ['not json at all', 'unparseable'],
  ['[1,2,3]', 'not an object'],
  ['{"type":"string"}', 'not an object schema'],
]) {
  reply = 'tool'; seen.length = 0;
  const r = await run(['ask', '--schema', bad, 'q']);
  check(r.code !== 0, `rule 6: an ${why} schema must be refused; it exited ${r.code}`);
  check(seen.length === 0,
    `rule 6: an ${why} schema reached the vendor. A 400 arrives later and explains less than a ` +
    `refusal here does.`);
}

upstream.close();
console.log(`SCHEMA OK (${checks} checks)`);

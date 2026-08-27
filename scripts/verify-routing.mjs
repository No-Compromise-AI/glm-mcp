// verify-routing.mjs — acceptance gate for what a caller is told before it
// chooses (#54, and the two caller-facing halves of #45).
//
// The thinking budgets differ by twelve times — 2,048 at "low" against 24,576
// at "max" — and thinking tokens are generated before the first useful
// character of an answer. That knob is the largest latency lever in the
// package and it is already exposed; what has never existed is anything that
// tells a caller WHEN to turn it. The same holds for the model: the table
// knows a flash tier and knows which models can run with reasoning off, and
// says neither to anyone.
//
// This gate is written as RULES about the caller-facing surface, not as a list
// of sentences that must appear. The distinction is the whole point: a gate
// that enumerates instances closes one spelling and reveals the next. The
// rules are:
//
//   1. every reasoning level the tool ACCEPTS is named in its guidance — so a
//      level added later fails here until it is routed;
//   2. every model id the guidance NAMES is one the table knows — so guidance
//      can never recommend a model that does not exist;
//   3. a budget quoted beside a level EQUALS that level's real budget — so the
//      prose cannot drift from BUDGET;
//   4. glm_models hints every id the table knows, and invents nothing for an
//      id it does not — the unknown model stays z.ai's to describe, exactly as
//      it stays z.ai's to size (#36);
//   5. if the table knows a vision model, the surface says the request path is
//      text-only — a caller that picks glm-4.6v for an image gets a text-only
//      request today and no warning (#45);
//   6. SECURITY.md documents the whole file-context flow, not the phrase
//      "prompt injection" (#45).
//
// A structural change this gate cannot read is a failure, not a pass.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const fail = (msg) => { throw new Error(msg); };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ---------------------------------------------------------------- the tables
// The ids and budgets the implementation actually uses, read from the built
// output rather than copied here. A copy is a second source of truth and would
// drift in exactly the way this gate exists to prevent.
function tableOf(js, name) {
  const at = js.indexOf(`const ${name} = new Map(`);
  if (at < 0) return null;
  const open = js.indexOf('[', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < js.length; i++) {
    if (js[i] === '[') depth++;
    else if (js[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  return js.slice(open, end + 1);
}

const glmJs = read('dist/glm.js');
const limitsSrc = tableOf(glmJs, 'OUTPUT_LIMITS')
  ?? fail('could not find the OUTPUT_LIMITS table in dist/glm.js — this gate can no longer read the model table, which is a failure, not a pass');

const KNOWN = [...limitsSrc.matchAll(/\[\s*["']([^"']+)["']\s*,\s*\{\s*def:\s*([\d_]+)\s*,\s*max:\s*([\d_]+)/g)]
  .map((m) => ({ id: m[1], def: Number(m[2].replaceAll('_', '')), max: Number(m[3].replaceAll('_', '')) }));
if (KNOWN.length < 5) {
  fail(`parsed only ${KNOWN.length} models out of OUTPUT_LIMITS — the table's shape changed and this gate is no longer reading it`);
}

// A vision model by its id, which is how z.ai names them: a `v` attached to
// the version. Derived, so a vision model added tomorrow is covered by rule 5
// without anyone remembering to add it here.
const isVision = (id) => /\d+(?:\.\d+)?v(?:-|$)/.test(id);
const VISION = KNOWN.filter((m) => isVision(m.id)).map((m) => m.id);
if (VISION.length === 0) {
  fail('no vision model found in OUTPUT_LIMITS — rule 5 has nothing to check, so either the table changed or this gate is misreading it');
}

const budgetSrc = glmJs.slice(glmJs.indexOf('const BUDGET ='), glmJs.indexOf('const BUDGET =') + 400);
const BUDGET = Object.fromEntries(
  [...budgetSrc.matchAll(/(\w+):\s*([\d_]+)/g)].map((m) => [m[1], Number(m[2].replaceAll('_', ''))]),
);
for (const level of ['low', 'high', 'max']) {
  if (!BUDGET[level]) fail(`could not read BUDGET.${level} from dist/glm.js — this gate cannot check rule 3 without it`);
}

// ------------------------------------------------------- the caller's view
// The tool descriptions as an MCP client actually receives them, not as the
// source file spells them: the schema is the contract, and reading the source
// would let a comment answer for the tool.
const stubModels = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    data: [...KNOWN.map((m) => ({ id: m.id })), { id: 'glm-99-unreleased' }],
  }));
});
await new Promise((r) => stubModels.listen(0, '127.0.0.1', r));
const modelsOrigin = `http://127.0.0.1:${stubModels.address().port}/models`;

const client = new Client({ name: 'glm-mcp-routing-gate', version: '1.0.0' });
let tools;
let modelsText;
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../dist/index.js', import.meta.url).pathname],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ZAI_API_KEY: 'dummy-key-for-the-local-server',
      ZAI_MODELS_URL: modelsOrigin,
    },
  }));
  tools = (await client.listTools()).tools;
  const res = await client.callTool({ name: 'glm_models', arguments: {} });
  modelsText = res.content?.map((c) => c.text ?? '').join('\n') ?? '';
  if (res.isError) fail(`glm_models failed against the stub endpoint: ${modelsText}`);
} finally {
  await client.close().catch(() => {});
  stubModels.close();
}

const askTool = tools.find((t) => t.name === 'glm_ask') ?? fail('no glm_ask tool in the listing');
const reasoning = askTool.inputSchema?.properties?.reasoning
  ?? fail('glm_ask exposes no `reasoning` parameter — this gate can no longer read the levels it must check');
const LEVELS = reasoning.enum ?? fail('the `reasoning` parameter is no longer an enum, so its levels cannot be enumerated');
if (!LEVELS.length) fail('the `reasoning` enum is empty');

// The guidance is everything the caller reads on the tool: the tool's own
// description and every parameter description under it. Where the routing
// advice is written is the author's choice; that it reaches the caller is not.
const guidance = [
  askTool.description ?? '',
  ...Object.values(askTool.inputSchema?.properties ?? {}).map((p) => p?.description ?? ''),
].join('\n');

// ------------------------------------- rule 1: every level is routed, by name
// Naming a level is the minimum; the level must appear beside a condition, so
// a bare list of the enum does not pass. The condition is tested as "a level
// is named in a sentence that also says something about when or what for" —
// the sentence must carry more than the level names themselves.
for (const level of LEVELS) {
  const named = new RegExp(`["'\`]?\\b${level}\\b["'\`]?`, 'i').test(guidance);
  if (!named) {
    fail(`#54: the tool accepts reasoning "${level}" and the guidance never mentions it. Every level the schema offers has to tell a caller when to pick it — otherwise the twelve-fold budget difference is a knob with no label.`);
  }
}
const sentences = guidance.split(/(?<=[.;:•\n])/);
const routed = LEVELS.filter((level) =>
  sentences.some((s) =>
    new RegExp(`\\b${level}\\b`, 'i').test(s) &&
    /\b(when|for|use|pick|choose|prefer|mechanical|extract|summar|review|subtle|design|cross-check|debug|latency|fast|cheap|slow|deep)\w*/i.test(s)),
);
if (routed.length < LEVELS.length) {
  const bare = LEVELS.filter((l) => !routed.includes(l));
  fail(`#54: reasoning ${bare.map((l) => `"${l}"`).join(', ')} ${bare.length === 1 ? 'is' : 'are'} mentioned but never routed — the guidance names the level without saying what it is for. A caller cannot act on a list of levels; it can act on "mechanical work → low, hunting a subtle bug → max".`);
}

// -------------------------- rule 2: every model named is one the table knows
const named = [...new Set([...guidance.matchAll(/\bglm-[a-z0-9.\-]+/gi)].map((m) => m[0].toLowerCase().replace(/[.\-]+$/, '')))];
const knownIds = new Set(KNOWN.map((m) => m.id));
for (const id of named) {
  if (!knownIds.has(id)) {
    fail(`#54: the guidance names the model "${id}", which is not in the server's own OUTPUT_LIMITS table. Routing a caller to a model this package cannot size is advice it cannot follow.`);
  }
}
if (named.length < 2) {
  fail(`#54: the guidance names ${named.length === 1 ? `only ${named[0]}` : 'no model at all'}. Model choice is half the routing decision — a flash tier and a model that can run with reasoning off are both in the table, and neither is offered to anyone.`);
}

// ------------------ rule 3: a budget quoted beside a level is that level's own
// Scoped to sentences that mention a level, so the rule guards the routing
// prose it is about and does not police every number on the tool.
for (const level of LEVELS) {
  if (!(level in BUDGET)) continue;
  for (const s of sentences) {
    if (!new RegExp(`\\b${level}\\b`, 'i').test(s)) continue;
    const others = LEVELS.filter((l) => l !== level && new RegExp(`\\b${l}\\b`, 'i').test(s));
    if (others.length) continue; // a sentence about several levels: not attributable
    for (const raw of s.match(/\b\d[\d,_]{2,}\b/g) ?? []) {
      const n = Number(raw.replaceAll(',', '').replaceAll('_', ''));
      const real = new Set([BUDGET[level], ...KNOWN.flatMap((m) => [m.def, m.max])]);
      if (!real.has(n)) {
        fail(`#54: the guidance quotes ${raw} beside reasoning "${level}", whose real thinking budget is ${BUDGET[level]}. A number in the description that no constant backs is drift waiting to happen — quote the real one or quote none.`);
      }
    }
  }
}

// ------------------- rule 4: glm_models hints what it knows, invents nothing
const lineFor = (id) =>
  modelsText.split('\n').find((l) => new RegExp(`(^|[^a-z0-9.\\-])${id.replace(/[.\-]/g, '\\$&')}([^a-z0-9.\\-]|$)`, 'i').test(l));

for (const { id } of KNOWN) {
  const line = lineFor(id);
  if (!line) fail(`#54: glm_models did not list ${id}, which the stub endpoint returned — the tool must still list every id the account offers`);
  const hint = line.replace(new RegExp(id.replace(/[.\-]/g, '\\$&'), 'i'), '').replace(/[^a-z]/gi, '');
  if (hint.length < 8) {
    fail(`#54: glm_models lists ${id} as a bare id. A caller reading "glm-4.5-airx" cannot tell what it is FOR, so the routing guidance on glm_ask stays aspirational — the table that would make it executable already exists.`);
  }
}

const unknownLine = lineFor('glm-99-unreleased');
if (!unknownLine) {
  fail('#54: glm_models dropped an id the account returned because the local table does not know it. An unknown model is z.ai\'s to describe, exactly as it is z.ai\'s to size (#36) — listing it without a hint is the honest answer, hiding it is not.');
}
const invented = unknownLine.replace(/glm-99-unreleased/i, '').replace(/[^a-z]/gi, '');
if (invented.length >= 8) {
  fail(`#54: glm_models described an id the table does not know: ${JSON.stringify(unknownLine)}. A hint for a model this package has never heard of is invention, and a caller cannot tell it from a real one.`);
}

// --------------------------- rule 5: the vision family is disclosed text-only
// ask() sends text. Selecting a vision model silently forgoes the modality it
// was selected for, and the place a caller decides is the model listing.
for (const id of VISION) {
  const line = lineFor(id);
  if (!/text|image|vision|modal/i.test(line ?? '')) {
    fail(`#45: glm_models offers ${id} with no word about modality. It is a vision model, ask() sends text only, and a caller that picks it for an image gets a text-only request and no warning — this listing is where that choice is made.`);
  }
}
const readme = read('README.md');
if (!/text[- ]only|no image|does not (?:send|support) image/i.test(readme)) {
  fail('#45: the README never says the request path is text-only. OUTPUT_LIMITS caps the vision models correctly, which reads as support for them.');
}

// ------------------------- rule 6: SECURITY.md documents the flow, not a phrase
const security = read('SECURITY.md');
const flow = [
  ['names prompt injection', /prompt injection|injected instruction/i],
  ['says file contents reach the model', /file (?:contents?|context)[^.]{0,80}(?:sent|reach|include|pass|flow|forward)|(?:sent|include|pass|forward)[^.]{0,80}file (?:contents?|context)/i],
  ['says the answer returns into the caller', /(?:answer|response|reply|output|result)[^.]{0,120}(?:calling agent|caller|agent's context|back into)/i],
];
const missing = flow.filter(([, re]) => !re.test(security)).map(([what]) => what);
if (missing.length) {
  fail(`#45: SECURITY.md does not document the file-context flow — it never ${missing.join(', nor ')}. The threat is not the phrase "prompt injection"; it is that hostile repository content is read by this server, answered by a model, and returned into the context of the agent that asked. Naming only part of that chain describes a different risk.`);
}

console.log('ROUTING OK');

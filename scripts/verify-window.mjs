// verify-window.mjs — acceptance gate for sizing the file context against the
// window of the model the request will actually use (#59).
//
// #36 made OUTPUT sizing per model, read from z.ai's published table, and
// refuses a max_tokens over a model's ceiling before anything is sent. INPUT
// sizing never got the same treatment: MAX_FILE_CHARS is derived once per
// process from one global assumption of 1,048,576 tokens and handed to every
// model alike. That was defensible while every request went to the default
// model. #54 ended that — it now actively routes callers to smaller models —
// and z.ai's own documentation says how much smaller:
//
//   glm-5.3         1M     glm-4.7   200K
//   glm-5.3-flash   1M     glm-4.6   200K
//   glm-4.6v      128K     glm-4.5   128K
//
// So a caller who follows the routing guidance to glm-4.5 with a large `files`
// list builds a prompt against a million-token assumption and sends it to a
// model with an eighth of one. The local cap that exists to prevent exactly
// this does not fire, and the failure arrives from z.ai instead.
//
// The rules are about the RELATIONSHIP between the model and the budget, not
// about any particular number — the numbers are z.ai's and will move:
//
//   1. a smaller declared window buys a smaller budget, in the ratio the
//      windows imply, so the budget cannot be a constant wearing a function's
//      clothes;
//   2. a model the table does not know keeps the documented assumption —
//      an unknown model is z.ai's to size, exactly as #36 has it;
//   3. GLM_MCP_MAX_FILE_CHARS still overrides, for every model;
//   4. GLM_MCP_CONTEXT_TOKENS still overrides the window, for every model;
//   5. the TOOL uses it, not merely the function underneath — index.ts has had
//      its own private default before, and every check below would have stayed
//      green while real callers were sized wrong;
//   6. every model the routing guidance names has a declared window, because
//      routing a caller to a model whose window nobody recorded is what made
//      this reachable;
//   7. a truncation says which window bound it, so a caller routed to a
//      smaller model can tell that from a file that was simply too big.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (msg) => { throw new Error(msg); };
const GLM = pathToFileURL(new URL('../dist/glm.js', import.meta.url).pathname).href;
const SENTINEL = '<<<RESULT>>>';

function child(body, env = {}, timeoutMs = 60_000) {
  const src = `
import * as glm from ${JSON.stringify(GLM)};
const out = {};
try {
${body}
} catch (e) {
  out.threw = String(e && e.message ? e.message : e);
}
process.stdout.write(${JSON.stringify(SENTINEL)} + JSON.stringify(out), () => process.exit(0));
`;
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (/^(GLM_MCP_|ZAI_)/.test(k)) delete childEnv[k];
  childEnv.ZAI_API_KEY = 'dummy-key-for-the-local-server';
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = String(v);
  }
  let out = '';
  try {
    out = execFileSync(process.execPath, ['--input-type=module', '-e', src],
      { encoding: 'utf8', env: childEnv, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (e.killed) fail(`a case did not return within ${timeoutMs}ms`);
    out = e.stdout ?? '';
    if (!out.includes(SENTINEL)) fail(`child failed\n${e.stderr || e.message}`);
  }
  const at = out.indexOf(SENTINEL);
  if (at < 0) fail(`unparsable child output: ${out.slice(0, 400)}`);
  return JSON.parse(out.slice(at + SENTINEL.length));
}

// ---------------------------------------------------------------- the table
// Read out of the built output, never copied: the whole defect is a number
// that lived in one place and applied to everything.
const glmJs = readFileSync(new URL('../dist/glm.js', import.meta.url), 'utf8');

function tableOf(js, name) {
  const at = js.indexOf(`const ${name} = new Map(`);
  if (at < 0) return null;
  const open = js.indexOf('[', at);
  let depth = 0;
  for (let i = open; i < js.length; i++) {
    if (js[i] === '[') depth++;
    else if (js[i] === ']') { depth--; if (depth === 0) return js.slice(open, i + 1); }
  }
  return null;
}

const limitsSrc = tableOf(glmJs, 'OUTPUT_LIMITS')
  ?? fail('could not find OUTPUT_LIMITS in dist/glm.js — this gate can no longer read the model table, which is a failure, not a pass');

const KNOWN = [...limitsSrc.matchAll(/\[\s*["']([^"']+)["']\s*,\s*(\{[^}]*\})/g)].map((m) => {
  const row = m[2];
  const num = (k) => {
    const hit = new RegExp(`\\b${k}:\\s*([\\d_]+)`).exec(row);
    return hit ? Number(hit[1].replaceAll('_', '')) : undefined;
  };
  return { id: m[1], def: num('def'), context: num('context') };
});
if (KNOWN.length < 5) fail(`parsed only ${KNOWN.length} models out of OUTPUT_LIMITS — the table's shape changed`);

const declared = KNOWN.filter((m) => m.context !== undefined);
if (declared.length < 2) {
  fail(`#59: only ${declared.length} model(s) in OUTPUT_LIMITS declare a context window. The budget is derived once from one global assumption of 1,048,576 tokens and handed to every model, while z.ai publishes 200K for glm-4.6 and glm-4.7 and 128K for glm-4.5 — so a caller routed to a smaller model builds a prompt against a window five to eight times what the model has. Record the window beside the output limits it already sizes against.`);
}

// Two models whose windows genuinely differ, so rule 1 is comparing something.
const sorted = [...declared].sort((a, b) => a.context - b.context);
const small = sorted[0];
const large = sorted[sorted.length - 1];
if (small.context === large.context) {
  fail('#59: every declared window is the same size, so this gate cannot tell a per-model budget from a constant. Declare the windows z.ai publishes — they differ by up to eight times.');
}

const fixture = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-window-')));
const fixtureRoot = fixture;
try {
  // Larger than the smallest budget and smaller than the largest, so the same
  // file is truncated for one model and whole for the other. That is the
  // observable a constant cannot produce.
  writeFileSync(join(fixture, 'big.txt'), 'x'.repeat(2_000_000));

  const budget = (model, env = {}) => {
    const r = child(`
process.env.GLM_MCP_ROOTS = ${JSON.stringify(fixture)};
const c = glm.buildFileContext(['big.txt'], ${JSON.stringify(fixture)}, ${JSON.stringify(model)});
out.len = c.text.length;
out.notes = c.notes;`, env);
    if (r.threw) fail(`#59: buildFileContext(${model}) threw — ${r.threw}. It has to accept the model whose window the budget is for; sizing without knowing the model is the defect.`);
    return r;
  };

  // ---- rule 1: a smaller window buys a smaller budget, in the right ratio
  const big = budget(large.id);
  const wee = budget(small.id);
  if (!(wee.len < big.len)) {
    fail(`#59: ${small.id} has a ${small.context}-token window and ${large.id} has ${large.context}, and the same file assembled to ${wee.len} chars for both. The budget is still one number for every model — which is the whole of this issue.`);
  }
  const windowRatio = large.context / small.context;
  const budgetRatio = big.len / wee.len;
  if (budgetRatio < windowRatio * 0.5) {
    fail(`#59: ${large.id}'s window is ${windowRatio.toFixed(1)}x ${small.id}'s, but its budget is only ${budgetRatio.toFixed(1)}x. The budget must track the window it is derived from, not merely differ.`);
  }

  // ---- rule 7: the truncation says which window bound it
  if (!(wee.notes ?? []).some((n) => /truncat/i.test(n))) {
    fail(`#59: ${small.id} truncated nothing on a 2,000,000-char file under a ${small.context}-token window — ${JSON.stringify(wee.notes)}`);
  }
  const note = (wee.notes ?? []).find((n) => /truncat/i.test(n)) ?? '';
  if (!new RegExp(`${small.id.replace(/[.\-]/g, '\\$&')}|window|context`, 'i').test(note)) {
    fail(`#59: a truncation note says nothing about the window that caused it — ${JSON.stringify(note)}. A caller routed to a smaller model by the guidance needs to tell "this model's window is smaller" from "this file is too big", because the fix differs.`);
  }

  // ---- rule 8: the output reserve is the REQUESTED model's, not the default's
  // The same defect twice over: the budget reserves room for the reply, and
  // the reserve was outputLimits(DEFAULT_MODEL).def — glm-5.3's 65,536 — for
  // every model alike. A model with the same window but a smaller default
  // output has more room for input, and must get it. Observable precisely
  // because two declared models share a window and differ in their default.
  {
    const byWindow = new Map();
    for (const m of declared) {
      if (m.def === undefined) continue;
      const peer = byWindow.get(m.context);
      if (peer && peer.def !== m.def) {
        const a = budget(peer.id);
        const b = budget(m.id);
        const wider = peer.def < m.def ? peer : m;
        const widerLen = peer.def < m.def ? a.len : b.len;
        const narrowerLen = peer.def < m.def ? b.len : a.len;
        if (!(widerLen > narrowerLen)) {
          fail(`#59: ${peer.id} and ${m.id} share a ${m.context}-token window but reserve different amounts for the reply (${peer.def} against ${m.def}), and their budgets came out ${a.len} and ${b.len}. The reserve has to be the REQUESTED model's own default — ${wider.id} keeps less back for output, so more of the window is left for input.`);
        }
        break;
      }
      byWindow.set(m.context, m);
    }
  }

  // ---- rule 2: a model the table does not know keeps the documented assumption
  const unknown = budget('glm-99-unreleased');
  const dflt = budget(undefined);
  if (unknown.len !== dflt.len) {
    fail(`#59: an unknown model was sized at ${unknown.len} chars where the documented assumption gives ${dflt.len}. z.ai ships models faster than this table can track, and an unknown one is z.ai's to size — exactly as #36 has it for output.`);
  }

  // ---- rule 3: the explicit cap still wins, for every model
  for (const m of [small.id, large.id, 'glm-99-unreleased']) {
    const pinned = budget(m, { GLM_MCP_MAX_FILE_CHARS: 1000 });
    if (pinned.len > 1000) {
      fail(`#59: GLM_MCP_MAX_FILE_CHARS=1000 did not bind for ${m} — ${pinned.len} chars. The per-model window sizes the DEFAULT; an operator's explicit cap still overrides it (#35, #24).`);
    }
  }

  // ---- rule 4: the window override still applies, for every model
  for (const m of [small.id, large.id]) {
    const forced = budget(m, { GLM_MCP_CONTEXT_TOKENS: 50_000 });
    const natural = budget(m);
    if (!(forced.len < natural.len)) {
      fail(`#59: GLM_MCP_CONTEXT_TOKENS=50000 did not shrink ${m}'s budget (${forced.len} against ${natural.len}). The operator's stated window has to win over the table, or a caller on a model whose published figure is wrong has no way to correct it.`);
    }
  }

  // ---- rule 5: the TOOL uses it, not just the function underneath
  // index.ts has carried its own private default before now, and every check
  // above would have stayed green while real callers were sized against the
  // wrong window. So drive the server and read what reaches the wire.
  {
    const sent = [];
    const upstream = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        sent.push(raw ? JSON.parse(raw) : null);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ model: 'm', content: [{ type: 'text', text: 'ok' }], usage: {} }));
      });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const client = new Client({ name: 'glm-mcp-window-gate', version: '1.0.0' });
    try {
      await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [new URL('../dist/index.js', import.meta.url).pathname],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          ZAI_API_KEY: 'dummy-key-for-the-local-server',
          ZAI_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
          GLM_MCP_ROOTS: fixture,
        },
      }));
      const lengths = {};
      for (const model of [small.id, large.id]) {
        sent.length = 0;
        const res = await client.callTool({
          name: 'glm_ask',
          arguments: { prompt: 'hi', model, files: ['big.txt'], cwd: fixture },
        });
        if (res.isError) fail(`#59: glm_ask failed for ${model} — ${res.content?.[0]?.text?.slice(0, 200)}`);
        const body = sent[0];
        if (!body) fail(`#59: no request captured for ${model}`);
        lengths[model] = String(body.messages?.[0]?.content ?? '').length;
      }
      if (!(lengths[small.id] < lengths[large.id])) {
        fail(`#59: through the TOOL, ${small.id} (${small.context}-token window) sent ${lengths[small.id]} chars and ${large.id} (${large.context}) sent ${lengths[large.id]}. The function beneath may size per model, but glm_ask is what a caller reaches, and it is still sizing them the same.`);
      }
    } finally {
      await client.close().catch(() => {});
      upstream.close();
    }
  }


// ---- rule 6: every model the guidance routes to has a declared window
// #54 is what made this reachable: before it, every request went to the
// default model and one assumption was harmless. Recommending a model whose
// window nobody recorded is the shape of the bug, not an instance of it.
const indexJs = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8');
const described = indexJs.slice(0, indexJs.indexOf('inputSchema'));
const namedInGuidance = [...new Set([...described.matchAll(/\bglm-[a-z0-9.\-]+/gi)]
  .map((m) => m[0].toLowerCase().replace(/[.\-]+$/, '')))];
const knownIds = new Map(KNOWN.map((m) => [m.id, m]));
for (const id of namedInGuidance) {
  const row = knownIds.get(id);
  if (!row) continue;   // verify:routing owns "is this a model we know"
  if (row.context === undefined) {
    fail(`#59: the routing guidance sends callers to ${id} and no window is recorded for it, so its file context is sized against the ${'1,048,576'}-token assumption whatever it actually has. Routing to a model whose window nobody wrote down is exactly how this became reachable — record it, or stop recommending the model.`);
  }
}

// ---- rule 9: the published numbers, pinned independently of the code
// Every rule above reads the windows OUT OF the implementation and checks
// relationships between them, which cannot notice a wrong number: with
// glm-4.7 mistyped as 2,000,000 instead of 200,000 this gate passed and so did
// the whole test suite. Relationships need a second source of truth to be
// anchored to, so these are z.ai's published figures written down — the same
// thing verify-capacity.mjs does with PUBLISHED for the output limits, and the
// one place duplication is right: these are facts about the world, confirmed
// against z.ai's model documentation, not a copy of a spelling in our code.
const PUBLISHED_WINDOWS = [
  ['glm-5.3', 1_048_576],
  ['glm-5.3-flash', 1_048_576],
  ['glm-4.7', 200_000],
  ['glm-4.6', 200_000],
  ['glm-4.5', 128_000],
  ['glm-4.6v', 128_000],
];
for (const [model, tokens] of PUBLISHED_WINDOWS) {
  const r = child(`out.window = glm.contextWindowTokens(${JSON.stringify(model)});`);
  if (r.threw) fail(`#59: contextWindowTokens(${model}) threw — ${r.threw}`);
  if (r.window !== tokens) {
    fail(`#59: ${model}'s context window resolves to ${r.window}, and z.ai publishes ${tokens}. The budget is derived from this number, so a wrong one sizes every prompt for that model wrongly — and the relationship rules above cannot see it, because they read the same figure they are checking.`);
  }
}

// ---- rule 10: a note claims a window only where a window is known
// #26's rule, in a new place: the note may not state as fact something the
// code does not know. Three sources produce a budget and only one of them is
// the model's own window — a model the table does not know keeps the
// documented ASSUMPTION, and GLM_MCP_CONTEXT_TOKENS is the OPERATOR's figure
// for every model alike. Reporting either as "<model>'s N-token context
// window" invents a published number for a model that has none, and for
// glm-99-unreleased invents one for a model that does not exist.
{
  const attributes = (note) => /'s\s[\d,_]+-token context window|\bof\s+\S+'s\s+window/i.test(note ?? '');

  const undeclaredId = KNOWN.find((m) => m.context === undefined)?.id;
  if (!undeclaredId) fail('#59: every model declares a window, so rule 10 has no undeclared case to check — either the table changed or this gate is misreading it');

  // Big enough to truncate under the widest budget, so the note actually fires.
  const huge = join(fixtureRoot, 'huge.txt');
  writeFileSync(huge, 'x'.repeat(3_500_000));
  const noteFor = (model, env = {}) => {
    const r = child(`
process.env.GLM_MCP_ROOTS = ${JSON.stringify(fixtureRoot)};
const c = glm.buildFileContext(['huge.txt'], ${JSON.stringify(fixtureRoot)}, ${JSON.stringify(model)});
out.notes = c.notes;`, env);
    return (r.notes ?? []).find((n) => /truncat/i.test(n)) ?? '';
  };

  const undeclared = noteFor(undeclaredId);
  if (!undeclared) fail(`#59: ${undeclaredId} did not truncate a 3,500,000-char file, so rule 10 cannot check its note`);
  if (attributes(undeclared)) {
    fail(`#59: the note calls the fallback assumption ${undeclaredId}'s own context window — ${JSON.stringify(undeclared)}. No window is published for it; the figure is this package's documented assumption, and stating it as the model's invents a fact. Say which it is.`);
  }

  const declaredId = declared[0].id;
  const overridden = noteFor(declaredId, { GLM_MCP_CONTEXT_TOKENS: 90_000 });
  if (!overridden) fail(`#59: ${declaredId} did not truncate under GLM_MCP_CONTEXT_TOKENS=90000`);
  if (attributes(overridden) && !/GLM_MCP_CONTEXT_TOKENS/.test(overridden)) {
    fail(`#59: with GLM_MCP_CONTEXT_TOKENS set, the note reports the operator's number as the model's own window — ${JSON.stringify(overridden)}. ${declaredId} publishes ${declared[0].context}; 90,000 is the operator's override, and attributing it to the model tells the caller something untrue about the model.`);
  }
}

} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log('WINDOW OK');

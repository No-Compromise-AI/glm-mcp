// verify-thinking.mjs — acceptance gate for the request stating its own
// thinking intent (#60).
//
// `reasoning: "none"` OMITTED the thinking parameter, and z.ai documents the
// default as `enabled`. So the package's largest advertised latency lever
// selected the opposite of what the caller asked for, silently — no error, and
// nothing in the footer to tell a reasoned answer from one that was supposed
// to skip reasoning. Measured against the live API before this gate was
// written, same prompt and cap:
//
//   glm-4.6        thinking omitted            -> thinking + text, 444 chars, 124 output tokens
//   glm-4.6        thinking {type:"disabled"}  -> text only,         0 chars,   2 output tokens
//   glm-5.3-flash  thinking omitted            -> thinking + text,  76 chars,  22 output tokens
//   glm-5.3-flash  thinking {type:"disabled"}  -> thinking + text,  28 chars,  10 output tokens
//
// Sixty-two times the output on glm-4.6, from a parameter the tool believed it
// was already setting. glm-5.3-flash reasons either way — its documentation
// says `thinking.type` supports no value but `enabled` — which is why it is in
// THINKING_REQUIRED and why sending `disabled` to a model that ignores it is
// safe rather than an error.
//
// The rule is stated as a property of EVERY request, not as a case about
// "none": a request must never leave the thinking decision to the far end's
// default. Whatever the caller asked, the body says so out loud. A gate that
// only checked the `none` path would pass again the next time a branch is
// added that forgets to decide.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const fail = (msg) => { throw new Error(msg); };
const GLM = pathToFileURL(new URL('../dist/glm.js', import.meta.url).pathname).href;
const SENTINEL = '<<<RESULT>>>';

function child(body, env = {}, timeoutMs = 60_000) {
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
${body}
} catch (e) {
  out.threw = String(e && e.message ? e.message : e);
}
out.seen = seen;
process.stdout.write(${JSON.stringify(SENTINEL)} + JSON.stringify(out));
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
  let out = '';
  try {
    out = execFileSync(process.execPath, ['--input-type=module', '-e', src],
      { encoding: 'utf8', env: childEnv, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
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

// --------------------------------------------------------------- the tables
// Read from the built output, never copied here: a copy is a second source of
// truth, and this gate exists because a default was assumed rather than read.
const glmJs = readFileSync(new URL('../dist/glm.js', import.meta.url), 'utf8');

const thinking = /const THINKING_REQUIRED = new Set\(\[([^\]]*)\]\)/.exec(glmJs)
  ?? fail('could not find THINKING_REQUIRED in dist/glm.js — this gate cannot tell which models may be asked to stop reasoning');
const ALWAYS_REASONS = [...thinking[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
if (ALWAYS_REASONS.length === 0) fail('THINKING_REQUIRED parsed empty — either the table changed or this gate is misreading it');

// The levels come from the zod enum in the BUILT SERVER, which is the contract
// a caller is actually offered — not from the TypeScript union, which does not
// survive into dist at all, and not from BUDGET, which lists only the levels
// that HAVE a budget and so silently omits the one this gate is about.
const indexJs = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8');
const enumSrc = /\.enum\(\[([^\]]*)\]\)/.exec(indexJs)
  ?? fail('could not find the reasoning enum in dist/index.js — this gate cannot enumerate the levels it must check');
const LEVELS = [...enumSrc[1].matchAll(/["'](\w+)["']/g)].map((m) => m[1]);
for (const need of ['none', 'low']) {
  if (!LEVELS.includes(need)) fail(`the reasoning levels parsed as ${JSON.stringify(LEVELS)}, which does not include "${need}" — this gate is no longer reading them`);
}

// A model the table does NOT force to reason, so "none" must be honourable on
// it. Derived rather than named, so the case survives the table changing.
const OPTIONAL = ['glm-4.6', 'glm-4.7', 'glm-4.5'].find((m) => !ALWAYS_REASONS.includes(m))
  ?? fail('every candidate model is in THINKING_REQUIRED — this gate has no model left on which "none" can be tested');

const sent = (model, reasoning) => {
  const r = child(`
out.res = await glm.ask({ prompt: 'hi', model: ${JSON.stringify(model)}, reasoning: ${JSON.stringify(reasoning)} });`);
  if (r.threw) fail(`ask(${model}, ${reasoning}) threw: ${r.threw}`);
  if (!r.seen?.length) fail(`ask(${model}, ${reasoning}) sent no request at all`);
  return r.seen[0];
};

// ------- rule 1: every request states its thinking intent, whatever was asked
// The defect was an ABSENT parameter, so absence is what the rule forbids —
// for every level the type offers, on a model of each kind. A branch added
// later that forgets to decide fails here rather than silently inheriting
// z.ai's default.
for (const model of [OPTIONAL, ALWAYS_REASONS[0]]) {
  for (const level of LEVELS) {
    const body = sent(model, level);
    if (body.thinking === undefined || body.thinking === null) {
      fail(`#60: ask(${model}, reasoning "${level}") sent no thinking parameter at all, leaving the decision to z.ai — whose documented default is "enabled". The request has to say what it wants; omitting it selects reasoning while the caller believes they turned it off, and nothing anywhere reports the difference.`);
    }
    if (typeof body.thinking.type !== 'string') {
      fail(`#60: ask(${model}, reasoning "${level}") sent ${JSON.stringify(body.thinking)}, which states no type`);
    }
  }
}

// ------------------- rule 2: "none" is disabled where it can be honoured
{
  const body = sent(OPTIONAL, 'none');
  if (body.thinking.type !== 'disabled') {
    fail(`#60: ${OPTIONAL} is not in THINKING_REQUIRED, so it can genuinely stop reasoning, and reasoning "none" sent ${JSON.stringify(body.thinking)}. Measured on glm-4.6, this is the difference between 124 output tokens and 2 — the largest single lever in the package.`);
  }
  if (body.thinking.budget_tokens !== undefined) {
    fail(`#60: a disabled thinking block carried budget_tokens ${body.thinking.budget_tokens}. Disabled and a budget are contradictory, and the pair is exactly what an API rejects at the far end.`);
  }
}

// --- rule 3: a model that cannot stop reasoning is still asked to reason
// #54 put these models in THINKING_REQUIRED because "none" cannot be honoured
// on them. Sending `disabled` there would be a request the model ignores, and
// the caller would be told nothing; raising it to a real budget is the choice
// already recorded, and rule 3 keeps it.
for (const model of ALWAYS_REASONS) {
  const body = sent(model, 'none');
  if (body.thinking.type !== 'enabled') {
    fail(`#60: ${model} is in THINKING_REQUIRED — it cannot run with reasoning off — and reasoning "none" sent ${JSON.stringify(body.thinking)}. "none" is raised to a real budget for these models, because a request they will ignore is worse than one that says what will actually happen.`);
  }
  if (!(body.thinking.budget_tokens > 0)) {
    fail(`#60: ${model} was sent an enabled thinking block with no usable budget: ${JSON.stringify(body.thinking)}`);
  }
}

// ------------ rule 4: the docs say what "none" now DOES, in one clause
// An earlier draft of this rule only asked whether the README contained the
// word "disabled" anywhere — and it already did, from #54's note about
// glm-5.3-flash. The rule passed while testing nothing, which is the failure
// mode a gate exists to prevent, so it now has to be a clause that ties the
// LEVEL to the MECHANISM: "none" is not the absence of a setting, it is a
// setting that is sent, and the difference is the whole of #60.
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const clauses = readme.split(/(?<=[.;:\n])/);
const ties = clauses.some((c) =>
  /\bnone\b/i.test(c) && /\bdisabled\b/i.test(c) && /\bsen[dt]|explicit|request/i.test(c));
if (!ties) {
  fail('#60: the README never says, in one clause, that reasoning "none" SENDS an explicit disabled setting. Omitting the parameter was the defect — z.ai documents the default as "enabled", so the absent setting selected reasoning while the caller believed they had turned it off. A reader has to be able to tell "none" from "unspecified", because for two versions they were the same thing and the answer came back reasoned either way.');
}

console.log('THINKING OK');

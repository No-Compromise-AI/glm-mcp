// verify-budget.mjs — acceptance gate for what one glm_ask call costs and
// which configuration it reads (#46, #42, and the `as never` half of #45).
//
// Three properties of the request path, none of which held:
//
//   #46  A call is bounded. `timeout` is PER ATTEMPT and `maxRetries` is 2, so
//        the documented ten-minute limit is really a thirty-minute one. An MCP
//        client abandons a tool call long before that, and the far end goes on
//        holding — and billing for — a request nobody is waiting for.
//
//   #42  A call reads the configuration as it is now. getClient() pins baseURL
//        and key into a module singleton on the first successful call, while
//        the comment above baseUrl() promises the opposite. A key rotated on
//        disk is never picked up: the server has to be restarted.
//
//   #45  What the request sends is type-checked. `messages.create(body as
//        never)` switches the compiler off for the entire body, so SDK drift
//        surfaces at runtime, against a live endpoint, instead of at build.
//
// The properties are stated as RULES, and two of them exist specifically to
// forbid a plausible WRONG fix:
//
//   * dividing the budget across attempts would bound the total and destroy
//     the common case, so rule 2 requires that one attempt may spend nearly
//     all of it;
//   * rebuilding the client on every call would pick up rotations and throw
//     connection reuse away, so rule 4 requires an unchanged environment to
//     reuse the object.
//
// The #45 rule is a MUTATION test rather than a search for the string `as
// never`: a copy of src is compiled with a deliberately wrong request body and
// the compiler must reject it. That tests the property — the type checker is
// live on this path — rather than one spelling of its absence.
//
// The stub upstream runs INSIDE the child, as it does in verify-capacity.mjs.
// It cannot run out here: execFileSync blocks this process's event loop, so a
// server in the parent would accept the child's connection and never answer
// it, and every timing case would "pass" by measuring a timeout against a stub
// that was never reachable.
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync,
  realpathSync, openSync, closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (msg) => { throw new Error(msg); };
const GLM = pathToFileURL(new URL('../dist/glm.js', import.meta.url).pathname).href;
const REPO = new URL('..', import.meta.url).pathname;
const SENTINEL = '<<<RESULT>>>';
let errSeq = 0;
const ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-budget-')));

/**
 * Run `body` in a child with `upstream({status, delayMs})` available: a local
 * HTTP stub answering the Messages API. Each stub records what reached it, so
 * a case can assert on the requests that actually arrived rather than on what
 * the code claims to have sent.
 */
function child(body, env = {}, timeoutMs = 90_000, { lazy = false } = {}) {
  // `lazy` imports the module inside the try instead of at the top. glm.ts
  // evaluates `baseUrl()` at module scope (`export const BASE_URL = ...`), so a
  // resolver that REFUSES a bad value throws during import — which a static
  // import turns into a dead child rather than an observable refusal, and the
  // rule below has to be able to tell those apart.
  const src = `
import { createServer } from 'node:http';
${lazy ? '' : `import * as glm from ${JSON.stringify(GLM)};`}

const stubs = [];
async function upstream({ status = 200, delayMs = 0 } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ at: Date.now(), authorization: req.headers.authorization ?? null });
      setTimeout(() => {
        if (res.destroyed || res.writableEnded) return;
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(status === 200
          ? JSON.stringify({ model: 'glm-5.3', content: [{ type: 'text', text: 'ok' }], usage: {} })
          : JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'stub' } }));
      }, delayMs);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const stub = { seen, origin: 'http://127.0.0.1:' + server.address().port, server };
  stubs.push(stub);
  return stub;
}

const out = {};
try {
${lazy ? `const glm = await import(${JSON.stringify(GLM)});` : ''}
${body}
} catch (e) {
  out.threw = String(e && e.message ? e.message : e);
}
out.stubs = stubs.map((s) => ({ origin: s.origin, seen: s.seen }));
process.stdout.write(${JSON.stringify(SENTINEL)} + JSON.stringify(out));
for (const s of stubs) s.server.close();
process.exit(0);
`;
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (/^(GLM_MCP_|ZAI_)/.test(k)) delete childEnv[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = String(v);
  }
  // stderr goes to a file, not a pipe: execFileSync only hands back e.stderr
  // when the child FAILS, and rule 7 is about what a SUCCEEDING call says to
  // the operator. Reading it from a pipe would have made that rule unfalsifiable.
  const errFile = join(ROOT, `stderr-${(errSeq += 1)}.log`);
  const errFd = openSync(errFile, 'w+');
  let out = '';
  let stderr = '';
  try {
    try {
      out = execFileSync(process.execPath, ['--input-type=module', '-e', src],
        { encoding: 'utf8', env: childEnv, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
          stdio: ['ignore', 'pipe', errFd] });
    } catch (e) {
      if (e.killed) fail(`a case did not return within ${timeoutMs}ms — the call is not bounded at all`);
      out = e.stdout ?? '';
      stderr = readFileSync(errFile, 'utf8');
      if (!out.includes(SENTINEL)) fail(`child failed\n${stderr || e.message}`);
    }
    stderr = readFileSync(errFile, 'utf8');
  } finally {
    closeSync(errFd);
  }
  const found = out.indexOf(SENTINEL);
  if (found < 0) fail(`unparsable child output: ${out.slice(0, 400)}`);
  const parsed = JSON.parse(out.slice(found + SENTINEL.length));
  parsed.stderr = stderr;
  return parsed;
}

try {
  // ================================================================= #46
  // The budget is a TOTAL. The knob names one number, and that number is what
  // a whole call can cost, however many times it is retried underneath.
  const BUDGET_MS = 4_000;

  // ------ rule 1: a retried call still ends inside the budget
  // The stub is slow AND retryable, which is the shape that produced thirty
  // minutes: every attempt runs most of the per-attempt limit and then earns
  // another one. Under a total budget the call ends at the deadline; under a
  // per-attempt one it ends at roughly three times it.
  {
    const r = child(`
const up = await upstream({ status: 529, delayMs: ${Math.round(BUDGET_MS * 0.6)} });
process.env.ZAI_BASE_URL = up.origin;
const t0 = Date.now();
try { await glm.ask({ prompt: 'hi', model: 'glm-5.3', reasoning: 'low' }); out.resolved = true; }
catch (e) { out.threw = String(e && e.message ? e.message : e); }
out.elapsed = Date.now() - t0;`,
      { ZAI_API_KEY: 'k', GLM_MCP_TIMEOUT_MS: BUDGET_MS });

    const seen = r.stubs?.[0]?.seen ?? [];
    if (r.resolved) fail('#46: the stub refused every attempt, so the call had to fail — this case is not measuring what it thinks it is');
    if (seen.length < 2) {
      fail(`#46: only ${seen.length} attempt(s) reached the stub, so this case never exercised a retry. The budget must bound retries, not remove them — a call that never retries is a different regression.`);
    }
    const ceiling = Math.round(BUDGET_MS * 1.6);
    if (!(r.elapsed <= ceiling)) {
      fail(`#46: GLM_MCP_TIMEOUT_MS was ${BUDGET_MS}ms and one glm_ask took ${r.elapsed}ms — ${(r.elapsed / BUDGET_MS).toFixed(1)}x the number the operator set, across ${seen.length} attempts. The timeout is per ATTEMPT with two retries behind it, so the documented ten minutes is really thirty. The knob has to bound the call, not one try at it.`);
    }
  }

  // ------ rule 2: the budget is not divided
  // The wrong fix for rule 1 is to give each attempt budget/(retries+1). That
  // bounds the total by breaking every legitimately long call, which is most
  // of them now that the output default is 65,536. One attempt may spend
  // nearly the whole budget and must still succeed.
  {
    const r = child(`
const up = await upstream({ status: 200, delayMs: ${Math.round(BUDGET_MS * 0.7)} });
process.env.ZAI_BASE_URL = up.origin;
const res = await glm.ask({ prompt: 'hi', model: 'glm-5.3', reasoning: 'low' });
out.text = res.text;`,
      { ZAI_API_KEY: 'k', GLM_MCP_TIMEOUT_MS: BUDGET_MS });

    if (r.threw) {
      fail(`#46: a single attempt taking 70% of the budget was refused — ${JSON.stringify(r.threw)}. The budget belongs to the whole call, so the first attempt is entitled to all of it. Dividing it between attempts bounds the total by breaking the common case.`);
    }
    if (r.text !== 'ok') fail(`#46: expected the stub's answer, got ${JSON.stringify(r.text)}`);
  }

  // ------ rule 3: the knob's documented meaning matches its behaviour
  // #46's cheapest option was to document the arithmetic. Doing the work does
  // not excuse leaving the README describing the old meaning.
  const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
  if (!readme.includes('GLM_MCP_TIMEOUT_MS')) fail('#46: GLM_MCP_TIMEOUT_MS is not documented in the README at all');
  const at = readme.indexOf('GLM_MCP_TIMEOUT_MS');
  const knob = readme.slice(Math.max(0, at - 400), at + 900);
  if (!/\b(whole|total|entire|complete|across (?:all )?(?:retries|attempts)|including retries)\b/i.test(knob)) {
    fail('#46: the README does not say GLM_MCP_TIMEOUT_MS bounds the WHOLE call. A caller reading it as a per-attempt value budgets for a third of the real worst case, which is precisely the misreading this issue is about.');
  }

  // ================================================================= #42
  // A call reads the configuration as it is now.
  const HOME = join(ROOT, 'home');
  mkdirSync(join(HOME, '.config', 'zai'), { recursive: true });
  const keyFile = join(HOME, '.config', 'zai', 'api-key');
  const KEYF = JSON.stringify(keyFile);
  writeFileSync(keyFile, 'KEY-ONE');

  // ------ rule 4: an unchanged environment reuses the client
  // The wrong fix for rules 5 and 6 is to construct a client per call, which
  // discards connection reuse for a file read nothing asked for.
  {
    const r = child(`out.same = glm.getClient() === glm.getClient();`,
      { HOME, USERPROFILE: HOME, ZAI_BASE_URL: 'http://127.0.0.1:1/' });
    if (r.same !== true) {
      fail('#42: two getClient() calls under an unchanged environment returned different clients. Freshness does not require rebuilding on every call — it requires rebuilding when the resolved configuration actually changed.');
    }
  }

  // ------ rule 4b: a base URL the operator SET is never silently replaced
  // Normalising the endpoint is for COMPARING it against the spelling the
  // cached client was built with — never for deciding what to send. The
  // difference matters because ZAI_BASE_URL is how an operator scopes egress
  // (#22): a value that normalises to nothing must not fall back to the
  // default, or `ZAI_BASE_URL="${HOST}/"` with HOST unset quietly ships the
  // bearer token to api.z.ai instead of failing. Before this rule existed, "/"
  // did exactly that; the unnormalised code sent an invalid URL the SDK
  // rejected, so the fix for #42 made the scoping weaker than it found it.
  {
    const unset = child(`out.url = glm.baseUrl();`, { HOME, USERPROFILE: HOME, ZAI_BASE_URL: undefined });
    if (!unset.url) fail(`#42: baseUrl() returned nothing with ZAI_BASE_URL unset — ${JSON.stringify(unset.threw ?? unset)}`);
    const DEFAULT = unset.url;

    // Every one of these is SET, and none of them names an endpoint. The rule
    // is about the class, not these spellings: whatever an operator wrote,
    // resolving it to the default is the one answer that must not happen.
    for (const value of ['/', '//', '///', ' ', '  /  ', '\t']) {
      const r = child(`out.url = glm.baseUrl();`,
        { HOME, USERPROFILE: HOME, ZAI_BASE_URL: value }, 90_000, { lazy: true });
      if (r.threw) continue;                 // refusing is the other right answer
      if (r.url === DEFAULT) {
        fail(`#42: ZAI_BASE_URL=${JSON.stringify(value)} resolved to the default endpoint ${DEFAULT}. That variable is how an operator scopes egress, so a value they SET must never be silently replaced by the vendor's own host — "\${HOST}/" with HOST unset would ship the bearer token to z.ai rather than fail. Normalise for the comparison that decides whether to rebuild the client; send what the operator wrote, or refuse.`);
      }
    }
  }

  // ------ rule 5: a changed endpoint is where the next request goes
  {
    const r = child(`
const a = await upstream({ status: 200 });
const b = await upstream({ status: 200 });
process.env.ZAI_BASE_URL = a.origin;
await glm.ask({ prompt: 'one', model: 'glm-5.3', reasoning: 'low' });
process.env.ZAI_BASE_URL = b.origin;
await glm.ask({ prompt: 'two', model: 'glm-5.3', reasoning: 'low' });
out.done = true;`,
      { HOME, USERPROFILE: HOME, ZAI_API_KEY: 'k' });

    if (r.threw) fail(`#42: the two-endpoint case threw — ${r.threw}`);
    const [a, b] = r.stubs ?? [];
    if (!b) fail('#42: the case did not create both stubs');
    if (b.seen.length !== 1) {
      fail(`#42: ZAI_BASE_URL changed between calls and the second request went to the old endpoint anyway — the new one saw ${b.seen.length} requests, the old saw ${a.seen.length}. getClient() pins baseURL at construction while the comment above baseUrl() promises the request re-reads it.`);
    }
  }

  // ------ rule 6: a rotated key is the one the next request carries
  // The operational cost of the singleton: a key written to disk after the
  // first successful call is never used, so rotation means a restart.
  {
    const r = child(`
const { writeFileSync } = await import('node:fs');
const up = await upstream({ status: 200 });
process.env.ZAI_BASE_URL = up.origin;
await glm.ask({ prompt: 'one', model: 'glm-5.3', reasoning: 'low' });
writeFileSync(${KEYF}, 'KEY-TWO');
await glm.ask({ prompt: 'two', model: 'glm-5.3', reasoning: 'low' });
out.done = true;`,
      { HOME, USERPROFILE: HOME, ZAI_API_KEY: undefined });

    if (r.threw) fail(`#42: the key-rotation case threw — ${r.threw}`);
    const bearers = (r.stubs?.[0]?.seen ?? []).map((s) => (s.authorization ?? '').replace(/^Bearer\s+/i, ''));
    if (bearers.length !== 2) fail(`#42: expected two requests at the stub, saw ${bearers.length}`);
    if (bearers[0] !== 'KEY-ONE') fail(`#42: the first request carried ${JSON.stringify(bearers[0])}, expected the key on disk`);
    if (bearers[1] !== 'KEY-TWO') {
      fail(`#42: the key file was rotated between calls and the second request still carried the old key (${JSON.stringify(bearers[1])}). A long-running server has to be restarted to pick up a rotation, and nothing says so.`);
    }
  }

  // ------ rule 7: a config that stops resolving does not break a working call
  // The cost of re-reading per call is that a read which used to happen once
  // can now fail mid-life. A credential that resolved is proof one exists, so
  // a later failure must not take down calls that would have worked — and the
  // operator still has to hear why, on stderr, the channel #26 chose for
  // exactly this.
  {
    writeFileSync(keyFile, 'KEY-ONE');
    const r = child(`
const { unlinkSync } = await import('node:fs');
const up = await upstream({ status: 200 });
process.env.ZAI_BASE_URL = up.origin;
await glm.ask({ prompt: 'one', model: 'glm-5.3', reasoning: 'low' });
unlinkSync(${KEYF});
const res = await glm.ask({ prompt: 'two', model: 'glm-5.3', reasoning: 'low' });
out.second = res.text;`,
      { HOME, USERPROFILE: HOME, ZAI_API_KEY: undefined });

    if (r.threw) {
      fail(`#42: the key file went away between calls and the second call failed — ${JSON.stringify(r.threw)}. Re-reading configuration must not make a working server fragile: a credential that already resolved is proof one exists, so the last good client serves the call.`);
    }
    if (r.second !== 'ok') fail(`#42: the second call did not reach the stub — got ${JSON.stringify(r.second)}`);
    if (!/key|credential|resolv/i.test(r.stderr ?? '')) {
      fail(`#42: the credential stopped resolving and nothing reached stderr. Serving the call from the last good client is right; doing it silently leaves the operator to find out at the next restart. stderr was ${JSON.stringify((r.stderr ?? '').slice(0, 300))}`);
    }
  }

  // ================================================================= #45
  // The compiler is live on the request body. Asserted by mutation: a body the
  // SDK's own types would reject must not compile. `as never` makes both
  // mutations below compile clean, which is the defect.
  {
    // The probe lives INSIDE the repository, and deliberately holds no
    // node_modules of its own: TypeScript and Node both resolve by walking up,
    // so the real one is found without a link. An earlier version of this gate
    // symlinked node_modules into a temp directory and then removed that
    // directory recursively — which followed the link and deleted the
    // repository's actual install. A gate may not be able to damage the tree it
    // is checking, so the link is gone rather than made safer.
    const probe = join(REPO, `.type-probe-${process.pid}`);
    rmSync(probe, { recursive: true, force: true });
    mkdirSync(probe, { recursive: true });
    cpSync(join(REPO, 'src'), join(probe, 'src'), { recursive: true });
    const tsconfig = JSON.parse(readFileSync(join(REPO, 'tsconfig.json'), 'utf8'));
    tsconfig.compilerOptions.noEmit = true;
    delete tsconfig.compilerOptions.outDir;
    writeFileSync(join(probe, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
    // module: Node16 decides ESM-or-CommonJS from the nearest package.json, so
    // without this the copy is compiled as CommonJS and every file fails on
    // import.meta before a mutation is even applied.
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    writeFileSync(join(probe, 'package.json'),
      JSON.stringify({ name: 'glm-mcp-type-probe', private: true, type: pkg.type }, null, 2));

    const glmTs = join(probe, 'src', 'glm.ts');
    const pristine = readFileSync(glmTs, 'utf8');
    const tsc = join(REPO, 'node_modules', '.bin', 'tsc');

    try {
    const compiles = () => {
      try {
        execFileSync(tsc, ['-p', join(probe, 'tsconfig.json')],
          { cwd: probe, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
        return { ok: true, out: '' };
      } catch (e) {
        return { ok: false, out: (e.stdout ?? '') + (e.stderr ?? '') };
      }
    };

    // The control. A gate whose mutations "fail" because the copy never built
    // in the first place is checking nothing at all.
    const control = compiles();
    if (!control.ok) {
      fail(`#45: the unmutated copy of src does not compile, so the mutations below would prove nothing:\n${control.out.slice(0, 1200)}`);
    }

    // Each mutation is a wrongness the SDK's parameter types define: a required
    // field given the wrong type, and a field whose value is outside its union.
    // The anchors are chosen to survive a reasonable refactor of the body; if
    // one stops matching, that is a failure — this gate must not silently stop
    // checking because the code moved.
    for (const [what, find, replace] of [
      ['max_tokens given a string', /max_tokens:\s*maxTokens\b/, 'max_tokens: "not a number"'],
      ['a message role outside the union', /role:\s*"user"/, 'role: "operator"'],
    ]) {
      if (!find.test(pristine)) {
        fail(`#45: this gate could not find ${what} to mutate (${find}) in src/glm.ts. It can no longer tell whether the request body is type-checked, which is a failure, not a pass — re-anchor the mutation on the body as it now stands.`);
      }
      writeFileSync(glmTs, pristine.replace(find, replace));
      const mutated = compiles();
      writeFileSync(glmTs, pristine);
      if (mutated.ok) {
        fail(`#45: src/glm.ts compiles with ${what}. The request body reaches messages.create through a cast that switches the compiler off for all of it, so SDK drift is discovered at runtime against a live endpoint instead of at build time.`);
      }
    }
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log('BUDGET OK');

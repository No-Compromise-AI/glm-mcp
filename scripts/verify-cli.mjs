// verify-cli.mjs — acceptance gate for #55: the whole path is reachable from a
// shell, and reaching it that way changes nothing about what it does.
//
// `bin` maps `glm-mcp` to `dist/index.js`, which is the stdio MCP server and
// nothing else, so there has been no way to ask GLM a question from a script.
// Everything needed was already exported — `buildFileContext` and `ask()` do the
// work — and what was missing was an argv path beside the server.
//
// THE PROPERTY, at the tool boundary:
//
//   A question asked from the shell goes through the same code as a question
//   asked over MCP — same confinement, same budgets, same model resolution —
//   and asking nothing still starts the server.
//
// The second clause is why the CONFINEMENT rule is the one that matters. This
// server's whole security posture is that a caller cannot read outside the
// operator's roots; a CLI that reached the filesystem by its own route would be
// a way around that boundary, added by the same commit that advertised it. It
// is not a separate check here — `buildFileContext` enforces the roots itself,
// so the rule is really "the CLI goes through buildFileContext", stated as the
// behaviour that proves it.
//
// RULES
//   1. `ask "question"` prints the answer on stdout and exits 0.
//   2. `-f <glob>` sends the file: the content reaches the request body.
//   3. CONFINEMENT HOLDS. A file outside the roots is refused and its content
//      does NOT reach the request. A CLI that read it directly would pass rule 2
//      and hand the operator's secrets to the vendor.
//   4. It is the SAME implementation, not a second one: the default model and
//      the `reasoning: none` wire shape both match what the MCP path sends.
//      `none` is the sharp one — #60 made it send an explicit disabled block
//      rather than omitting the parameter, and a hand-rolled CLI would omit it
//      and silently select the opposite of what the caller asked.
//   5. Failure goes to stderr with a non-zero exit, because a script cannot
//      tell otherwise.
//   6. FORBID THE WRONG FIX: with no subcommand it still starts the MCP server,
//      and stdout stays clean — stdout is the protocol, and one stray line on it
//      breaks every client.
//   7. `key` prints the SOURCE the key came from, not the key. The point of the
//      subcommand is that `claude-glm` stops reimplementing the search; printing
//      a secret by default would make an accidental invocation a leak.
//   8. `key --print` prints the key, and nothing else on stdout.
//
// Offline: a stub upstream on loopback, no z.ai. The gate uses async spawn
// rather than execFileSync, because a sync child blocks the event loop and the
// stub in this process would never answer it.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fail = (msg) => { throw new Error(msg); };
const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
if (!existsSync(ENTRY)) fail('rule 0: dist/index.js does not exist — run `npm run build` first');

let checks = 0;
const check = (ok, msg) => { checks++; if (!ok) fail(msg); };

// The stub upstream. It records every request body so the rules can assert on
// what was actually sent rather than on what the CLI printed about it.
const seen = [];
const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    try { seen.push(JSON.parse(body)); } catch { seen.push({ unparsed: body }); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'glm-4.6',
      content: [{ type: 'text', text: 'THE ANSWER FROM UPSTREAM' }],
      stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 4 },
    }));
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${upstream.address().port}`;

const dir = mkdtempSync(join(tmpdir(), 'glm-cli-gate-'));
const roots = join(dir, 'allowed'); mkdirSync(roots);
writeFileSync(join(roots, 'inside.ts'), 'export const SECRET_INSIDE = "content the caller asked for";\n');
const outside = join(dir, 'outside'); mkdirSync(outside);
writeFileSync(join(outside, 'secrets.ts'), 'export const NOT_FOR_THE_VENDOR = "a key the operator never offered";\n');

/** Run the real entry point with argv, and wait — async, so the stub can answer. */
function run(args, { env = {}, cwd = roots, killAfterMs = 0 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [ENTRY, ...args], {
      cwd,
      env: {
        ...process.env,
        ZAI_API_KEY: 'test-key-value-not-real',
        ZAI_BASE_URL: origin,
        GLM_MCP_ROOTS: roots,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    if (killAfterMs) setTimeout(() => p.kill('SIGTERM'), killAfterMs);
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

// Rule 1 — a question, an answer.
seen.length = 0;
const r1 = await run(['ask', 'where can this invariant break?']);
check(r1.code === 0, `rule 1: 'ask' must exit 0; got ${r1.code}. stderr:\n${r1.err.slice(-800)}`);
check(/THE ANSWER FROM UPSTREAM/.test(r1.out),
  `rule 1: the answer must reach stdout, so a script can capture it. stdout was:\n${r1.out.slice(0, 500)}`);

// Rule 4 — the same implementation, proven on the wire.
check(seen.length === 1, `rule 4: expected exactly one upstream request, saw ${seen.length}`);
{
  const body = seen[0] ?? {};
  check(typeof body.model === 'string' && body.model.length > 0,
    `rule 4: the request must name a model; body was ${JSON.stringify(body).slice(0, 300)}`);
  seen.length = 0;
  await run(['ask', '--reasoning', 'none', 'q']);
  const none = seen[0] ?? {};
  check(none.thinking && none.thinking.type === 'disabled',
    `rule 4: '--reasoning none' must send an explicit disabled thinking block, as the MCP path does ` +
    `since #60 — omitting the parameter selects the vendor's default, which is the OPPOSITE of what ` +
    `the caller asked. Sent: ${JSON.stringify(none.thinking)}`);
}

// Rule 2 — files reach the request.
seen.length = 0;
const r2 = await run(['ask', '-f', 'inside.ts', 'what does this do?']);
check(r2.code === 0, `rule 2: exited ${r2.code}. stderr:\n${r2.err.slice(-600)}`);
check(JSON.stringify(seen[0] ?? {}).includes('SECRET_INSIDE'),
  `rule 2: the file's content must reach the request body. Sent:\n${JSON.stringify(seen[0] ?? {}).slice(0, 600)}`);

// Rule 3 — and confinement still decides which files those are.
seen.length = 0;
const r3 = await run(['ask', '-f', join(outside, 'secrets.ts'), 'what does this do?']);
check(!JSON.stringify(seen[0] ?? {}).includes('NOT_FOR_THE_VENDOR'),
  `rule 3: a file OUTSIDE the operator's roots reached the vendor. The CLI must read through ` +
  `buildFileContext, which enforces the roots — reading the filesystem by its own route makes this ` +
  `subcommand a way around the boundary the server advertises. Sent:\n${JSON.stringify(seen[0] ?? {}).slice(0, 600)}`);
check(/root|confin|outside|allowed/i.test(r3.out + r3.err),
  `rule 3: it must SAY the path was refused, not drop it silently. Output was:\n${(r3.out + r3.err).slice(0, 600)}`);

// Rule 5 — failure is legible to a script.
{
  const bad = await run(['ask'], {});
  check(bad.code !== 0, `rule 5: 'ask' with no question must exit non-zero; got ${bad.code}`);
  check(bad.err.trim().length > 0,
    'rule 5: the reason must be on stderr. A script that cannot tell success from failure is worse ' +
    'than no CLI.');
}

// Rule 6 — FORBID THE WRONG FIX: no subcommand still means the server.
{
  const srv = await run([], { killAfterMs: 1500 });
  check(/glm-mcp ready/.test(srv.err),
    `rule 6: with no subcommand it must still start the MCP server. stderr was:\n${srv.err.slice(0, 400)}`);
  check(srv.out === '',
    `rule 6: stdout must stay clean — it is the MCP protocol, and one stray line breaks every ` +
    `client. It printed:\n${srv.out.slice(0, 400)}`);
}

// Rules 7 and 8 — the key, and not by accident.
{
  const k = await run(['key'], { env: { ZAI_API_KEY: 'sk-the-actual-secret' } });
  check(k.code === 0, `rule 7: 'key' must exit 0; got ${k.code}. stderr:\n${k.err.slice(-400)}`);
  check(!k.out.includes('sk-the-actual-secret'),
    `rule 7: bare 'key' must print the SOURCE, not the secret — the subcommand exists so claude-glm ` +
    `stops reimplementing the search, and printing a key by default makes an accidental invocation a ` +
    `leak. It printed:\n${k.out.slice(0, 300)}`);
  check(/ZAI_API_KEY/.test(k.out),
    `rule 7: it must name where the key came from, or it answers nothing useful. It printed:\n${k.out.slice(0, 300)}`);

  const kp = await run(['key', '--print'], { env: { ZAI_API_KEY: 'sk-the-actual-secret' } });
  check(kp.out.trim() === 'sk-the-actual-secret',
    `rule 8: 'key --print' must print the key and nothing else, so KEY=$(glm-mcp key --print) works. ` +
    `It printed:\n${JSON.stringify(kp.out)}`);
}

upstream.close();
console.log(`CLI OK (${checks} checks)`);

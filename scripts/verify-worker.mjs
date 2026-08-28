// verify-worker.mjs — acceptance gate for delegation that needs no host CLI (#90).
//
// THE PROPERTY: a delegated task completes on a machine with no host CLI
// installed, and the record it leaves is indistinguishable from today's.
//
// Both halves are load-bearing. The first is the requirement — #89 documented
// that delegation needs Claude Code, and #90 exists to make that untrue. The
// second is what keeps glm-why, glm-answer, glm-drain, glm-stats and glm-notes
// working without being ported: they all read a stream-json record, and a worker
// that completes tasks while emitting a different shape has moved the cost
// rather than removed it.
//
// WHY A STUB UPSTREAM, AND WHY IT IS NOT A SHORTCUT. CI has no z.ai key, so a
// gate that talks to the real endpoint would be skipped there — and a rule that
// does not run in CI is decoration. The stub speaks the Anthropic streaming wire
// format, so the worker under test is the REAL vendored binary running its REAL
// agent loop and executing its REAL Write tool; only the model's tokens are
// synthetic. Measured: two agent-loop turns, no network, no key, ~50ms.
//
// TWO THINGS THIS GATE LEARNED THE HARD WAY, both now encoded as rules:
//
//   (a) A stub can return {subtype:"success", is_error:false} while NOTHING ran.
//       Observed directly while building this: the first stub answered Claude
//       Code's TITLE-GENERATION request — an auxiliary call that is not the
//       agent loop at all — and the run reported success with the file never
//       written. So rule 1 asserts the FILE, never the result, and the stub
//       dispatches on what a request IS rather than on a counter.
//
//   (b) The delegation path invokes a host CLI at FOUR sites, not one. Rules
//       that only cover the worker would pass while review and resume still die
//       on a missing executable. Rule 4 is stated over the tree for that reason.
//
// Rules, stated as what an operator on a bare machine observes:
//   1. a delegated task that REQUIRES TOOL USE completes with no host CLI on
//      PATH, and the evidence is the file on disk, not the exit status;
//   2. the result record carries every field glm-task projects into the ledger —
//      derived from glm-task's own res.get(...) calls, so a consumer that starts
//      reading a fifth field fails this gate instead of silently getting null;
//   3. the session id RESUMES and carries prior state, because glm-answer's
//      whole purpose is continuing a worker that stopped to ask something;
//   4. no call site on the delegate -> review -> answer path requires a host
//      CLI. This forbids the narrow fix that converts only the worker;
//   5. glm-mcp's published package does not carry the ~199MB platform binary.
//      This forbids the opposite wrong fix — making a small stdio server heavy
//      for a feature most of its consumers never invoke.
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, symlinkSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const WORKER = join(REPO, 'bin', 'glm-worker');
const fail = (msg) => { throw new Error(msg); };

const SENTINEL = 'ZZQ-WORKER-GATE-SENTINEL';
const WORK = mkdtempSync(join(tmpdir(), 'glm-worker-gate-'));
const SHIMBIN = join(WORK, 'shim-bin');
const TARGET = join(WORK, 'written-by-a-real-tool.txt');

let upstream;
const requests = [];

try {
  // ---------------------------------------------------------------- the PATH
  // A PATH containing exactly what a worker legitimately needs and NOTHING
  // that could stand in for it. Built by symlink rather than by filtering the
  // real PATH, so "claude happens not to be in this list" cannot silently
  // become "claude was inherited from the environment".
  mkdirSync(SHIMBIN, { recursive: true });
  for (const tool of ['node', 'sh', 'bash', 'env', 'git', 'uname', 'python3']) {
    let resolved;
    try { resolved = execFileSync('command', ['-v', tool], { shell: true, encoding: 'utf8' }).trim(); }
    catch { continue; }
    if (resolved) { try { symlinkSync(resolved, join(SHIMBIN, tool)); } catch { /* already there */ } }
  }
  // The self-check that keeps rule 1 falsifiable. If `claude` were reachable on
  // this PATH the whole gate would pass by accident, testing nothing.
  {
    let found = '';
    try {
      found = execFileSync('sh', ['-c', 'command -v claude || true'],
        { env: { PATH: SHIMBIN }, encoding: 'utf8' }).trim();
    } catch { /* absent, which is the point */ }
    if (found) {
      fail(`#90: the gate's own sanitized PATH still resolves \`claude\` at ${found}. Every rule below would then pass on a machine where Claude Code is installed and fail on the bare machine this issue is about — the exact inversion of what the gate is for. Fix the shim directory, not the rules.`);
    }
  }

  // ------------------------------------------------------------- the upstream
  // Dispatches on WHAT THE REQUEST IS. Claude Code makes auxiliary calls that
  // are not the agent loop; answering one of those with the tool call makes the
  // gate pass for the wrong reason. This was observed, not theorised — see (a).
  const sse = (res, ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
  upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null; try { body = JSON.parse(raw); } catch { /* not JSON */ }
      if (req.method !== 'POST' || !body) { res.statusCode = 200; return res.end('{}'); }

      const convo = JSON.stringify(body.messages || []);
      const hasWrite = (body.tools || []).some((t) => t && t.name === 'Write');
      const isAgentLoop = hasWrite && convo.includes(SENTINEL);
      const alreadyWrote = convo.includes('toolu_gate_write');
      requests.push({ isAgentLoop, convo });

      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      sse(res, 'message_start', { type: 'message_start', message: { id: 'm', type: 'message',
        role: 'assistant', model: 'glm-4.6', content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 } } });

      if (isAgentLoop && !alreadyWrote) {
        sse(res, 'content_block_start', { type: 'content_block_start', index: 0,
          content_block: { type: 'tool_use', id: 'toolu_gate_write', name: 'Write', input: {} } });
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0,
          delta: { type: 'input_json_delta',
            partial_json: JSON.stringify({ file_path: TARGET, content: 'written-by-a-real-tool' }) } });
        sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        sse(res, 'message_delta', { type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } });
      } else {
        sse(res, 'content_block_start', { type: 'content_block_start', index: 0,
          content_block: { type: 'text', text: '' } });
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: 'finished' } });
        sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        sse(res, 'message_delta', { type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
      }
      sse(res, 'message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${upstream.address().port}`;

  // Runs the worker exactly as glm-task:158 and glm-answer:42 run their worker
  // today — same flags, same stream-json contract — on the sanitized PATH.
  const runWorker = (args, { timeoutMs = 120_000 } = {}) => new Promise((resolve) => {
    if (!existsSync(WORKER)) {
      resolve({ missing: true, code: 127, out: '', err: `no such file: ${WORKER}` });
      return;
    }
    const child = spawn(WORKER, args, {
      cwd: WORK,
      env: {
        PATH: SHIMBIN,
        HOME: WORK,
        ANTHROPIC_BASE_URL: BASE,
        ANTHROPIC_AUTH_TOKEN: 'stub-key-for-the-local-upstream',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ missing: true, code: 127, out, err: String(e.message) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ missing: false, code, out, err }); });
  });

  const resultLineOf = (out) => {
    for (const line of out.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      let o; try { o = JSON.parse(t); } catch { continue; }
      if (o && o.type === 'result') return o;
    }
    return null;
  };

  const WORKER_ARGS = (prompt) => ['-p', prompt,
    '--permission-mode', 'acceptEdits', '--allowedTools', 'Write', 'Read',
    '--output-format', 'stream-json', '--verbose'];

  // ------- rule 1: it completes with no host CLI, and a TOOL actually ran
  const first = await runWorker(WORKER_ARGS(`${SENTINEL}: write the file`));
  if (first.missing) {
    fail(`#90: there is no worker at bin/glm-worker. Delegation currently runs \`claude-glm\`, which is \`exec claude\` — so on a machine with Codex or Antigravity but no Claude Code, glm-task dies with "claude: not found" before the model is ever reached. That is the whole issue.\n  ${first.err}`);
  }
  if (!existsSync(TARGET)) {
    const served = requests.filter((r) => r.isAgentLoop).length;
    fail(`#90: the worker exited ${first.code} and the file its tool was told to write does not exist. The upstream served ${served} agent-loop request(s) of ${requests.length} total.\n\nThe file is the assertion on purpose. A stub can return {subtype:"success", is_error:false} while nothing at all executed — that happened while building this gate, when the stub answered Claude Code's title-generation call instead of the agent loop. Exit status and result subtype both said success; no tool had run. Only the artifact on disk distinguishes "the loop ran and used its tools" from "something replied".\n  stderr: ${first.err.slice(-600)}`);
  }
  if (readFileSync(TARGET, 'utf8').trim() !== 'written-by-a-real-tool') {
    fail(`#90: a file exists at the target path but does not carry what the tool call specified — got ${JSON.stringify(readFileSync(TARGET, 'utf8').slice(0, 80))}. Something other than the delegated tool call created it.`);
  }

  // ------- rule 2: the record carries every field glm-task projects
  // DERIVED, not enumerated. glm-task turns the worker's result into a ledger
  // row through res.get("..."); that set of names IS the contract, so it is read
  // out of glm-task rather than restated here. Restating it would let the two
  // drift apart silently, which is the failure this rule exists to prevent.
  const result = resultLineOf(first.out);
  if (!result) {
    fail(`#90: the worker wrote no {"type":"result"} line to stdout. glm-task:191 and the ledger write at glm-task:339 both parse the stream for exactly that line; without it every run records null turns, null duration and no session, and glm-stats reports on nothing.\n  stdout tail: ${JSON.stringify(first.out.slice(-400))}`);
  }
  {
    const taskSrc = readFileSync(join(REPO, 'bin', 'glm-task'), 'utf8');
    const required = new Set();
    for (const m of taskSrc.matchAll(/\bres\.get\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g)) required.add(m[1]);
    if (required.size === 0) {
      fail(`#90: this rule derives the required fields from glm-task's own res.get("...") calls and found none. Either the projection moved or the pattern no longer matches it — either way the rule is now vacuous and would pass whatever the worker emits. Fix the derivation before trusting a green run.`);
    }
    const missing = [...required].filter((k) => !(k in result));
    if (missing.length > 0) {
      fail(`#90: the result record is missing ${JSON.stringify(missing)}. glm-task reads ${JSON.stringify([...required])} off the worker's result — that set was read out of glm-task itself, not written here, so this list is what the ledger actually consumes today.\n\nA missing field does not crash anything: it lands in the ledger as null, and glm-stats, glm-why and glm-drain then report confidently on nothing. That is why the shape is a gate rule and not a review note.\n  got: ${JSON.stringify(Object.keys(result))}`);
    }
  }

  // ------- rule 3: the session id resumes, and carries prior state
  // A recorded id that cannot be resumed satisfies rule 2 and still breaks
  // glm-answer, whose entire purpose is continuing a worker that stopped to ask
  // the human something.
  {
    const sid = result.session_id;
    if (!sid || typeof sid !== 'string') {
      fail(`#90: the result carries no usable session_id (${JSON.stringify(sid)}). glm-answer resumes by that id and glm-notes prints it to the operator as the way back in; without it a worker that stops to ask a question can never be answered, only re-run from the start.`);
    }
    const before = requests.length;
    const resumed = await runWorker(['--resume', sid, ...WORKER_ARGS(`${SENTINEL}: continue`)]);
    if (resumed.missing || resumed.code !== 0) {
      fail(`#90: resuming session ${sid} failed (exit ${resumed.code}). glm-answer:42 does exactly this.\n  stderr: ${resumed.err.slice(-600)}`);
    }
    const fresh = requests.slice(before);
    if (fresh.length === 0) {
      fail(`#90: the resume made no upstream request at all, so whatever it did, it did not continue a conversation.`);
    }
    if (!fresh.some((r) => r.convo.includes('written-by-a-real-tool') || r.convo.includes('toolu_gate_write'))) {
      fail(`#90: the resumed run reached the model without any of the prior turn in its messages. The id was accepted and a fresh conversation started instead of the old one continuing — which looks like success at every layer glm-answer can see, and silently discards the context the human's answer was meant to land in.`);
    }
  }

  // ------- rule 4: nothing on the delegation path requires a host CLI
  // Stated over the tree rather than over the four known lines, so a fifth site
  // added later is caught too. claude-glm itself is exempt: it is the
  // INTERACTIVE launcher, where wanting Claude Code's TUI makes having claude
  // installed a fair assumption. Everything the delegate -> review -> answer
  // cycle touches is not exempt.
  {
    const EXEMPT = new Set(['claude-glm']);
    const offenders = [];
    for (const name of readdirSync(join(REPO, 'bin'))) {
      if (EXEMPT.has(name)) continue;
      const src = readFileSync(join(REPO, 'bin', name), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (line.trim().startsWith('#')) return;
        if (/(^|[^-\w])claude-glm\b/.test(line) && !/\.claude-glm\b/.test(line)) {
          offenders.push(`bin/${name}:${i + 1}: ${line.trim().slice(0, 100)}`);
        }
      });
    }
    if (offenders.length > 0) {
      fail(`#90: ${offenders.length} call site(s) on the delegation path still invoke claude-glm, which is \`exec claude\`:\n  ${offenders.join('\n  ')}\n\nConverting only the worker is the narrow fix this rule exists to forbid. On a machine without Claude Code the delegate step would then succeed and the review or resume step would die on a missing executable — a failure that arrives late, after the model has already been paid for, and looks like a review failure rather than a missing dependency.\n\n(Paths under ~/.claude-glm are the LEDGER and are deliberately not matched: the ledger location does not move, per #90's non-goal.)`);
    }
  }

  // ------- rule 5: glm-mcp's own package does not carry the platform binary
  // The opposite wrong fix. glm-mcp is a small stdio server; the vendored
  // Claude Code binary is ~199MB and is needed only by delegation, which is not
  // even published to npm (#89). Asserted against the manifest that ships.
  {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    const HEAVY = '@anthropic-ai/claude-agent-sdk';
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = pkg[field] || {};
      const hit = Object.keys(deps).find((d) => d === HEAVY || d.startsWith(HEAVY + '-'));
      if (hit) {
        fail(`#90: package.json lists ${hit} under ${field}, so every consumer of the glm-mcp MCP server now downloads a ~199MB platform binary for a feature they may never invoke — and bin/ is not even published to npm (#89), so most of them cannot invoke it.\n\nThe worker belongs in its own package. optionalDependencies is not the escape hatch it looks like: \`npm install --no-optional\` would then disable delegation silently, which is a worse failure than a clear missing dependency.`);
      }
    }
  }
} finally {
  if (upstream) upstream.close();
  rmSync(WORK, { recursive: true, force: true });
}

console.log('WORKER OK');

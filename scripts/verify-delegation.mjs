// verify-delegation.mjs — acceptance gate for the honesty of a delegation's
// OUTCOME: what glm-task's exit status says, and what its ledger row records,
// about whether the delegated agent actually ran and finished (#91).
//
// Why this gate exists, stated plainly: on 2026-08-28 a delegation whose worker
// could not start at all — `glm-worker` exited 1 having printed nothing —
// produced exit 0 and a ledger row reading
//   session_id=None num_turns=None duration_ms=None agent_error=None
// Nothing in the exit status, the ledger, or the terminal distinguished that
// from a delegation that succeeded. glm-drain ships on a zero exit, so an
// unattended run could merge a branch no agent had ever touched.
//
// THE PROPERTY, stated at the tool boundary — what a caller runs, what a caller
// observes — never in the implementation's vocabulary:
//
//   A delegation whose agent did not complete must not report success, by any
//   route the worker can present that failure, and its ledger row must say so
//   without the reader opening the log.
//
// "Did not complete" has three observable shapes at the worker boundary, and a
// caller of glm-task can see nothing of the worker except these two channels —
// its exit status and its stream-json on stdout:
//
//   (a) the worker exits non-zero and emits no result   — it could not start,
//       or it died;
//   (b) the worker emits a result marked is_error       — the agent ran and
//       reported failure;
//   (c) the worker exits ZERO and emits no result       — killed, truncated, or
//       stopped between events.
//
// Each is a separate rule because each defeats a different plausible wrong fix.
// Propagating the pipeline's exit status alone passes (a) and misses (b) and
// (c). Reading is_error alone passes (b) and misses (a) and (c).
//
// WHY A SHIM WORKER IS LEGITIMATE HERE, and where the line is. The last session
// learned that "a failure the GATE causes is not the failure the CODE will
// meet": a stub that made the SDK throw exercised the worker's own hand-built
// catch record instead of the SDK's error result, so reverting the fix left the
// gate green. That trap is about substituting a failure INSIDE the unit under
// test. Here the unit under test is glm-task, the worker is a separate process,
// and glm-task can observe nothing about it but (exit status, stdout). A shim
// that reproduces those two channels drives exactly the code path production
// drives.
//
// That argument is only worth as much as the claim that the shapes are real, so
// rule 1 does not assume it. It runs the REAL bin/glm-worker — the shipped file,
// copied byte for byte — in the environment that produces shape (a) in
// production (its worker package not installed, which #90 chose deliberately
// over a silent optional dependency) and asserts the shape rules 2-9 imitate.
// If that worker ever STARTS, rule 1 fails: a gate that can no longer produce
// the failure it stands in for has stopped vouching for anything, and a shape
// this gate cannot reach is a failure, not a pass.
//
// RULES
//   1. The real glm-worker, unable to start, exits non-zero and emits no result
//      event. (The bridge: without it, rules 2-9 imitate a shape nobody checked.)
//   2. Shape (a) — worker exits non-zero, no result — makes glm-task exit 6.
//   3. That run's ledger row says the agent did not complete, in a field, so a
//      reader can tell it from a success without opening the log.
//   4. CONTROL. A worker that SUCCEEDS still gives exit 0 and a complete row:
//      worker_ok true, agent_error false, the real num_turns and session id.
//      Forbids the wrong fix of reporting every run as failed.
//   5. Shape (b) — worker exits ZERO with is_error true — also exits 6.
//      Forbids the wrong fix of reading only the exit status.
//   6. Shape (c) — worker exits ZERO with no result at all — also exits 6.
//      Forbids the wrong fix of reading only is_error.
//   7. ORDERING: rate limiting outranks it. A worker that fails BECAUSE z.ai
//      refused on capacity still exits 5, never 6. Throttling says nothing about
//      the change, so the item must be retried, not marked broken — and a fix
//      that returns early on a failed worker would invert exactly this.
//   8. ORDERING: a passing verify does not rescue a failed worker. With -v true
//      the run still exits 6, and the row records verify=pass beside a failed
//      agent. A weak verify command passing over work that was never attempted
//      is the precise hazard that already forced this rule for BLOCKED runs.
//   9. glm-drain never ships a delegation that came back 6, and parks it with a
//      reason. This is the severity: the drain merges on a zero exit, unattended.
//
// Offline, deterministic and free: no API calls, no network, no worktrees. The
// scratch tree lives in a temp directory and never contains, links to, or
// deletes a node_modules — a recursive delete following such a link has
// destroyed a real install here twice.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const fail = (msg) => { throw new Error(msg); };
const BIN = fileURLToPath(new URL('../bin', import.meta.url));
for (const f of ['glm-task', 'glm-worker', 'glm-drain', '_glm-hosts.sh', '_glm-capacity.sh']) {
  if (!existsSync(join(BIN, f))) fail(`rule 0: bin/${f} does not exist — this gate cannot be testing the right thing`);
}

let checks = 0;
const check = (ok, msg) => { checks++; if (!ok) fail(msg); };

/** A stream-json result event, as the worker emits one. */
const resultLine = (o) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false,
  session_id: 'sess-gate', num_turns: 3, duration_ms: 1234, result: 'done', ...o,
});

/**
 * Run the REAL bin/glm-task against a shim worker that presents `stdout` and
 * exits `code`. Everything glm-task reaches for — its two sourced helpers — is
 * the real file too; only the worker is substituted, because the worker is the
 * boundary whose failure is under test.
 */
function delegate({ code = 0, stdout = resultLine({}), verify = null, task = 'do the thing',
                    writes = null, commit = false, reviewer = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'glm-delegation-gate-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  for (const f of ['glm-task', '_glm-hosts.sh', '_glm-capacity.sh']) {
    copyFileSync(join(BIN, f), join(bin, f));
    chmodSync(join(bin, f), 0o755);
  }
  // The shim. Two channels, nothing else: what it prints, and how it exits.
  const worker = join(bin, 'glm-worker');
  // `writes` makes the shim do real work in the repo; `commit` makes it commit
  // that work. The pair is the whole of #93: an agent that edits and forgets to
  // commit leaves a branch with nothing on it, and glm-ship pushes commits.
  const work = writes
    ? `printf '%s' ${JSON.stringify(String(writes))} > "$GATE_REPO/feature.txt"\n` +
      (commit
        ? `git -C "$GATE_REPO" -c user.email=a@example.invalid -c user.name=agent add -A >/dev/null\n` +
          `git -C "$GATE_REPO" -c user.email=a@example.invalid -c user.name=agent commit -qm "the agent's own commit" >/dev/null\n`
        : '')
    : '';
  writeFileSync(worker, `#!/usr/bin/env bash\n${work}${stdout ? `cat <<'GATEEOF'\n${stdout}\nGATEEOF` : ':'}\nexit ${code}\n`);
  chmodSync(worker, 0o755);

  // A reviewer that records the fact it was asked. Rule 13 turns on this file
  // never appearing: spending a reviewer call on a diff already known to be
  // empty is how "there was nothing to review" got recorded as "the reviewer
  // broke" for two rounds running.
  const reviewCalls = join(dir, 'review-calls.txt');
  if (reviewer) {
    const rv = join(bin, 'glm-review');
    writeFileSync(rv, `#!/usr/bin/env bash\necho "asked $*" >> ${JSON.stringify(reviewCalls)}\necho "VERDICT: PASS"\nexit 0\n`);
    chmodSync(rv, 0o755);
  }

  const repo = join(dir, 'repo'); mkdirSync(repo);
  const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.email=gate@example.invalid', '-c', 'user.name=gate', ...a],
    { encoding: 'utf8' });
  git('init', '-q', '.');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  const baseHead = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

  const ledger = join(dir, 'ledger.jsonl');
  const args = ['-C', repo, '-r', reviewer ? 'codex' : 'none'];
  if (verify !== null) args.push('-v', verify);
  const r = spawnSync('bash', [join(bin, 'glm-task'), ...args, task], {
    encoding: 'utf8', timeout: 120_000,
    env: {
      ...process.env,
      HOME: dir,                              // never touch the real ~/.claude-glm
      GATE_REPO: repo,
      GLM_TASK_LEDGER: ledger,
      GLM_TASK_LOG: join(dir, 'run.jsonl'),
      GLM_NOTES: join(dir, 'notes.jsonl'),
      GLM_NOTIFY_LEVELS: 'none',              // no desktop notifications from a gate
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) fail(`glm-task could not be run: ${r.error.message}`);

  let row = null;
  if (existsSync(ledger)) {
    const lines = readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length) row = JSON.parse(lines[lines.length - 1]);
  }
  const head = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const added = Number(spawnSync('git', ['-C', repo, 'rev-list', '--count', `${baseHead}..HEAD`], { encoding: 'utf8' }).stdout.trim() || '0');
  const dirty = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim();
  const reviewed = existsSync(reviewCalls);
  return { status: r.status, out: `${r.stdout}${r.stderr}`, row, dir, head, added, dirty, reviewed };
}

// ---------------------------------------------------------------------------
// Rule 1 — the bridge. The REAL worker, in the environment that produces shape
// (a) in production, and the shape rules 2-9 imitate is whatever it does here.
{
  const dir = mkdtempSync(join(tmpdir(), 'glm-realworker-gate-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  copyFileSync(join(BIN, 'glm-worker'), join(bin, 'glm-worker'));
  chmodSync(join(bin, 'glm-worker'), 0o755);
  // The shim is ESM with no .mjs extension, exactly as it ships; Node only
  // reads it that way when a package.json above it says so. Without this the
  // process dies PARSING the file, which satisfies "exits non-zero, emits no
  // result" while proving nothing whatever about the worker — the second way
  // this one rule found to pass on a failure the gate itself had caused.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  // No packages/worker beside it — the shipped shim resolves its implementation
  // relative to its own realpath, so this is exactly "the worker package is not
  // installed", the failure #90 chose over a silently-disabled optional dep.
  // Executed directly, honouring its own shebang: running it through `bash`
  // makes bash choke on JavaScript and exit 2, which is the FIRST way this rule
  // found to pass while testing nothing.
  const r = spawnSync(join(bin, 'glm-worker'), ['-p', 'hello', '--output-format', 'stream-json', '--verbose'],
    { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  // The load-bearing check, and the reason the other two can be believed: the
  // worker must fail through its OWN diagnostic. That string can only be
  // printed by the shipped catch handler, so it proves the real code ran and
  // reached its real error path — where an exit code alone proves only that
  // something, somewhere, went wrong.
  check(/glm-worker: could not start/.test(r.stderr ?? ''),
    'rule 1: the real glm-worker did not fail through its own error path. Whatever went wrong ' +
    `here was caused by this gate, not by the worker, so the shape rules 2-9 imitate is unverified:\n${(r.stderr ?? '').slice(0, 400)}`);
  check(r.status !== 0 && r.status !== null,
    `rule 1: the real glm-worker STARTED with no worker package installed (exit ${r.status}). ` +
    'This gate imitates a failure shape it can no longer produce, so it has stopped vouching for it. ' +
    'Re-derive the shape rules 2-9 stand in for before trusting them.');
  check(!/"type"\s*:\s*"result"/.test(r.stdout ?? ''),
    'rule 1: the real glm-worker emitted a result event while failing to start — ' +
    'shape (a) is not "no result", and rules 2, 3, 8 imitate the wrong thing.');
}

// Rule 2 — shape (a): worker exits non-zero, emits nothing.
const a = delegate({ code: 1, stdout: '', writes: 'work', commit: true });
check(a.status === 6,
  `rule 2: a worker that exited non-zero having emitted no result must make glm-task exit 6 ` +
  `(the delegated agent did not complete); got ${a.status}. ` +
  'Exit 0 here is what let an unattended drain ship a branch no agent had touched.');

// Rule 3 — that run's row says so, in a field.
check(a.row !== null, 'rule 3: no ledger row was written for a failed delegation at all');
check(a.row.worker_ok === false,
  `rule 3: the ledger row must record that the agent did not complete; worker_ok=${JSON.stringify(a.row.worker_ok)}. ` +
  'A row whose every agent field is null is indistinguishable from one nobody wrote.');
check(/without emitting a result|no result/i.test(String(a.row.worker_reason ?? '')),
  `rule 3: the reason must identify THIS shape — a worker that died without emitting a result. ` +
  `It says ${JSON.stringify(a.row.worker_reason)}, which would also be said of a run that committed nothing, ` +
  'so the rule would pass for a reason other than its own.');
check(typeof a.row.worker_reason === 'string' && a.row.worker_reason.trim().length > 0,
  'rule 3: the row must say WHY the agent did not complete (worker_reason), not only that it did not — ' +
  'the reason is the whole value of the row to whoever reads it next.');

// Rule 4 — CONTROL. Success is still success, and still fully recorded.
// The shim COMMITS. Before #93 this control committed nothing, which #93 makes
// a failing delegation in its own right — so leaving it alone would have set
// the two halves of this gate against each other. A control that no longer
// describes a successful run is not a control.
const ok = delegate({ code: 0, stdout: resultLine({}), writes: 'the change', commit: true });
check(ok.status === 0, `rule 4: a delegation whose agent completed must still exit 0; got ${ok.status}`);
check(ok.row?.worker_ok === true,
  `rule 4: a successful run must record worker_ok=true; got ${JSON.stringify(ok.row?.worker_ok)}. ` +
  'Reporting every run as failed satisfies rules 2, 5 and 6 and is not a fix.');
check(ok.row?.num_turns === 3 && ok.row?.session_id === 'sess-gate' && ok.row?.agent_error === false,
  `rule 4: a successful run must still record what the agent did — got num_turns=${JSON.stringify(ok.row?.num_turns)}, ` +
  `session_id=${JSON.stringify(ok.row?.session_id)}, agent_error=${JSON.stringify(ok.row?.agent_error)}`);

// Rule 5 — shape (b): exit ZERO, result marked is_error.
const b = delegate({ code: 0, writes: 'work', commit: true,
  stdout: resultLine({ subtype: 'error_during_execution', is_error: true, result: 'the model refused' }) });
check(b.status === 6,
  `rule 5: a worker that exited 0 while reporting is_error must exit 6; got ${b.status}. ` +
  'Propagating only the worker\'s exit status passes rule 2 and misses this entirely.');
check(b.row?.worker_ok === false, 'rule 5: an errored agent result must record worker_ok=false');

// Rule 5b — an UNCLASSIFIABLE result is not a successful one. A result event
// that is neither explicitly successful nor explicitly an error tells us the
// run's outcome is unknown, and "unknown" must not resolve to "shipped".
// Raised by codex against the first implementation. Its stated reason — that
// this contradicts a documented fail-closed contract — was wrong; no such
// contract is written anywhere, and across 76 result events from real runs
// `subtype` was ALWAYS present ("success" x75, "error_during_execution" x1),
// so nothing observed can reach this branch. The rule is kept anyway, for its
// own reason rather than the reviewer's: the entire point of this gate is that
// a delegation must not report success unless it is known to have succeeded,
// and a fail-open in the one classifier whose job is to fail closed is worth
// forbidding even when no producer is known to exercise it. If a future SDK
// does start omitting the field, this fails loudly on the first run instead of
// certifying every one of them.
const unk = delegate({ code: 0, writes: 'work', commit: true,
  stdout: JSON.stringify({ type: 'result', subtype: null, is_error: false, session_id: 's', num_turns: 1, duration_ms: 1 }) });
check(unk.status === 6,
  `rule 5b: a result event that is neither explicitly successful nor explicitly an error must not ` +
  `read as success; got exit ${unk.status}. Unknown is not the same as fine.`);

// Rule 6 — shape (c): exit ZERO, no result event at all.
const c = delegate({ code: 0, writes: 'work', commit: true,
  stdout: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }) });
check(c.status === 6,
  `rule 6: a worker that exited 0 and never emitted a result must exit 6; got ${c.status}. ` +
  'Reading only is_error treats a truncated or killed run as a success.');
check(c.row?.worker_ok === false, 'rule 6: a run with no result event must record worker_ok=false');

// Rule 7 — ORDERING: throttling outranks it. The item must be retried, not broken.
const rl = delegate({
  code: 1, writes: 'work', commit: true,
  stdout: resultLine({ subtype: 'error_during_execution', is_error: true, result: 'HTTP 429: rate limit exceeded, try again in 30 seconds' }),
});
check(rl.status === 5,
  `rule 7: a worker that failed BECAUSE z.ai refused on capacity must still exit 5, not 6; got ${rl.status}. ` +
  'Throttling is not information about the change: a caller that reads it as failure marks an item broken ' +
  'that was never attempted. A fix that returns early on a failed worker inverts exactly this.');

// Rule 8 — ORDERING: a passing verify does not rescue a failed worker.
const wv = delegate({ code: 1, stdout: '', writes: 'work', commit: true, verify: 'true' });
check(wv.status === 6,
  `rule 8: a failed delegation must exit 6 even when the verify command passes; got ${wv.status}. ` +
  'A weak verify passing over work that was never attempted is why BLOCKED already outranks verify.');
check(wv.row?.verify === 'pass' && wv.row?.worker_ok === false,
  `rule 8: the row must carry both facts — verify=${JSON.stringify(wv.row?.verify)} beside ` +
  `worker_ok=${JSON.stringify(wv.row?.worker_ok)}. Suppressing the verify result hides which of the two failed.`);

// ---------------------------------------------------------------------------
// Rule 9 — the drain never ships it. This is the severity of #91: glm-drain
// merges on a zero exit with nobody watching.
{
  const dir = mkdtempSync(join(tmpdir(), 'glm-drain-6-gate-'));
  const state = join(dir, 'state'); mkdirSync(state, { recursive: true });
  const shipLog = join(dir, 'ship.log');

  const taskStub = join(dir, 'glm-task');
  writeFileSync(taskStub, `#!/usr/bin/env bash
echo "glm-task: run dir=/tmp/glm-wt-stub session=sess-6 branch=glm/item-1" >&2
exit 6
`);
  chmodSync(taskStub, 0o755);

  const shipStub = join(dir, 'glm-ship');
  writeFileSync(shipStub, `#!/usr/bin/env bash\necho "SHIPPED $*" >> ${JSON.stringify(shipLog)}\nexit 0\n`);
  chmodSync(shipStub, 0o755);

  const r = spawnSync('bash', [join(BIN, 'glm-drain'), '-j', '1', '-I', '1'], {
    encoding: 'utf8', timeout: 120_000,
    env: {
      ...process.env,
      GLM_TASK_CMD: taskStub, GLM_SHIP_CMD: shipStub,
      GLM_DRAIN_STATE_DIR: state, GLM_DRAIN_BACKOFF_BASE: '1', GLM_DRAIN_OFFLINE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  check(!existsSync(shipLog),
    'rule 9: glm-drain SHIPPED an item whose delegation came back 6 (the agent did not complete). ' +
    'Unattended, this merges a branch no agent ever touched.');

  const parked = join(state, 'parked.jsonl');
  check(existsSync(parked) && readFileSync(parked, 'utf8').trim().length > 0,
    `rule 9: an item whose delegation did not complete must be PARKED for a human. Drain said:\n${out.slice(-1500)}`);
  // Asserted on the PARKED RECORD, not on the terminal: the reason `throttle`
  // prints for an undefined exit is suppressed at -j 1, so a terminal check
  // here can never fire. The parked file is also the artifact a human actually
  // reads in the morning, which is the thing that has to be true.
  // The whole record, not one field: park() puts the category in `reason` and
  // the explanation in `question`, and which slot carries the sentence is not
  // the property — that a human reading this file learns what happened is.
  const record = readFileSync(parked, 'utf8').trim().split('\n').pop();
  check(/did not complete/i.test(record),
    `rule 9: the parked record must say the delegated AGENT did not complete; it reads ${record}. ` +
    'Exit 6 is a defined outcome — a drain that files it as an unexplained crash tells the human ' +
    'the wrong thing about what happened, and its exit-code contract has stopped covering the toolchain it drives.');
}

// ---------------------------------------------------------------------------
// #93 — a delegation that COMMITTED NOTHING is a delegation that produced
// nothing, and must not report success either. Same property as #91, one step
// further along: there the agent never ran, here it ran and left no trace a
// branch can carry. glm-ship pushes COMMITS, so uncommitted work is not merged
// — it is silently discarded with the worktree, while every signal says the
// item succeeded.

// Rule 10 — the agent worked and forgot to commit. Verify passes, because -v
// runs against the working tree and is happy with uncommitted files: verify
// cannot be what catches this.
const unc = delegate({ code: 0, stdout: resultLine({}), writes: 'work', commit: false, verify: 'test -f feature.txt' });
check(unc.status !== 0,
  `rule 10: a delegation that committed NOTHING must not report success; it exited ${unc.status}. ` +
  'glm-drain ships on a zero exit, and glm-ship pushes commits — so this opens an empty PR, ' +
  'gets green CI because nothing changed, and auto-merges it while the work is thrown away with the worktree.');
check(unc.row?.verify === 'pass',
  `rule 10: the run must still record that verify passed (got ${JSON.stringify(unc.row?.verify)}) — ` +
  'suppressing it hides that a green verify is exactly what made this look fine.');

// Rule 11 — it says WHY, and names what was left behind, so the human can
// recover the work rather than re-running the task.
// Asserted on worker_reason ALONE, never on the run's output. The first draft
// allowed either, and the filename check could not fail: glm-task echoes its own
// verify command, so `-v "test -f feature.txt"` put "feature.txt" on stderr no
// matter what the reason said. The reason is also the durable artifact — the
// output scrolls past, the ledger row is what gets read afterwards.
const uncReason = String(unc.row?.worker_reason ?? '');
check(/uncommitted/i.test(uncReason),
  'rule 11: the recorded reason must say the agent left work UNCOMMITTED. "Nothing was committed" ' +
  `and "the agent did nothing" are different facts with different fixes. Reason: ${JSON.stringify(uncReason)}`);
check(/feature\.txt/.test(uncReason),
  'rule 11: the reason must NAME the files left uncommitted — they are about to be destroyed with ' +
  `the worktree, and naming them is the difference between recoverable and lost. Reason: ${JSON.stringify(uncReason)}`);

// Rule 12 — an agent that produced nothing at all is ALSO not a success, and
// must not be reported in the same words as one that forgot to commit.
const none = delegate({ code: 0, stdout: resultLine({}) });
check(none.status !== 0,
  `rule 12: a delegation that produced no change at all must not report success; it exited ${none.status}. ` +
  'There is nothing to ship, so a zero exit sends the drain to ship an empty branch.');
check(!/uncommitted/i.test(String(none.row?.worker_reason ?? '')),
  `rule 12: "the agent produced nothing" must not be reported as "left work uncommitted" — ` +
  `it says ${JSON.stringify(none.row?.worker_reason)}. A wrong reason sends the human looking for files that do not exist.`);

// Rule 13 — the reviewer is not spent on a diff already known to be empty.
const unrev = delegate({ code: 0, stdout: resultLine({}), writes: 'work', commit: false, reviewer: true });
check(unrev.reviewed === false,
  'rule 13: glm-review was invoked with nothing committed to review. That spends a reviewer call to ' +
  'obtain an empty-diff error, and then records "the reviewer broke" as the run\'s review state — ' +
  'which is what made this defect read as a reviewer problem for two rounds.');

// Rule 14 — FORBID THE WRONG FIX. glm-task must refuse, never tidy up.
// Committing on the agent's behalf fabricates authorship and a message, and
// commits whatever else happened to be in the tree.
check(unc.added === 0,
  'rule 14: glm-task COMMITTED the agent\'s uncommitted work itself. That invents an author and a ' +
  'commit message, and sweeps in whatever else was in the tree. The fix for "nothing was committed" ' +
  'is to refuse and say so, not to commit it.');
check(/feature\.txt/.test(unc.dirty),
  `rule 14: the uncommitted work must be left exactly where the agent left it; the tree now reads ` +
  `${JSON.stringify(unc.dirty)}. A gate that loses the work while reporting the problem is not an improvement.`);

// Rule 15 — CONTROL for 10-14: an agent that commits is unaffected by any of
// it, and its reviewer still runs. Forbids "refuse everything".
const good = delegate({ code: 0, stdout: resultLine({}), writes: 'work', commit: true, reviewer: true });
// This half deliberately overlaps rule 4 — a mutation that refuses everything
// trips rule 4 first, so treat the reviewer assertion below as the load-bearing
// one. Kept because it is the same claim stated where a reader of rules 10-15
// will look for it.
check(good.status === 0,
  `rule 15: an agent that committed its work must still exit 0; got ${good.status}`);
check(good.reviewed === true,
  'rule 15: the reviewer must still be invoked when there IS a committed change — ' +
  'skipping review for everything satisfies rule 13 and defeats the entire loop.');

console.log(`DELEGATION OK (${checks} checks)`);

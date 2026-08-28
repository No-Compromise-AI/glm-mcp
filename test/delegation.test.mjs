// glm-task's delegation-outcome honesty beyond what scripts/verify-delegation.mjs
// drives (#91).
//
// The gate is the specification and already covers the three shapes of "the
// agent did not complete", the success control, the two orderings it names
// (rate limit, passing verify) and the drain's never-ship. What it does not
// exercise, and these tests do:
//
//   * BLOCKED still outranks an incomplete worker — exit 4, because a question
//     waiting is more specific than "did not finish". Both directions matter:
//     a worker that died after asking must not be reported as merely
//     incomplete, and a worker that finished its session but asked must not be
//     recast as incomplete (worker_ok stays true).
//   * worker_reason says WHICH of the three shapes happened, so the ledger row
//     carries the why, not only the that.
//   * the drain retries an exit 6 exactly once and parks it as `incomplete`,
//     a category distinct from `failed`, with glm-task's own reason carried
//     into the parked record. The gate asserts a park happened; a drain that
//     never retried, or parked under "failed", would pass it.
//
// Also what a ledger row IDENTIFIES (#77), beyond what scripts/verify-ledger.mjs
// drives. The gate covers the three forms of issue reference, the `-b` branch,
// and the in-place branch. What it does not exercise:
//
//   * a "#n" that names a PULL REQUEST is not an issue. GitHub numbers issues
//     and PRs from one shared sequence, so attributing "review PR #45" to
//     issue 45 attributes work to an issue nobody touched — the exact wrong
//     the field exists to avoid, one shape past the forms the gate enumerates.
//   * a run on a detached HEAD has no branch to name. The row must record
//     null, present, without crashing or inventing a SHA — an in-place run on
//     a CI checkout is exactly this shape.
//
// WIRING: run by `npm test` (package.json names this file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = fileURLToPath(new URL('../bin', import.meta.url));

/** A stream-json result event, as the worker emits one. */
const resultLine = (o) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false,
  session_id: 'sess-test', num_turns: 3, duration_ms: 1234, result: 'done', ...o,
});

/**
 * Run the REAL bin/glm-task against a shim worker presenting `stdout` and exit
 * `code`, as the gate does: glm-task can observe the worker only through those
 * two channels. `note`, when given, is appended to the notes file as the
 * worker runs — the third channel a blocked agent speaks through.
 */
function delegate({ code = 0, stdout = resultLine({}), note = '', task = 'do the thing', onBranch = null, detach = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'glm-delegation-test-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  for (const f of ['glm-task', '_glm-hosts.sh', '_glm-capacity.sh']) {
    copyFileSync(join(BIN, f), join(bin, f));
    chmodSync(join(bin, f), 0o755);
  }
  const notes = join(dir, 'notes.jsonl');
  const worker = join(bin, 'glm-worker');
  writeFileSync(worker, `#!/usr/bin/env bash\n${note ? `printf '%s\\n' '${note}' >> "$GLM_NOTES"\n` : ''}${stdout ? `cat <<'TESTEOF'\n${stdout}\nTESTEOF\n` : ':'}\nexit ${code}\n`);
  chmodSync(worker, 0o755);

  const repo = join(dir, 'repo'); mkdirSync(repo);
  const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.email=test@example.invalid', '-c', 'user.name=test', ...a],
    { encoding: 'utf8' });
  git('init', '-q', '.');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  if (onBranch) git('checkout', '-q', '-b', onBranch);
  if (detach) git('checkout', '-q', '--detach');

  const ledger = join(dir, 'ledger.jsonl');
  const r = spawnSync('bash', [join(bin, 'glm-task'), '-C', repo, '-r', 'none', task], {
    encoding: 'utf8', timeout: 120_000,
    env: {
      ...process.env,
      HOME: dir,
      GLM_TASK_LEDGER: ledger,
      GLM_TASK_LOG: join(dir, 'run.jsonl'),
      GLM_NOTES: notes,
      GLM_NOTIFY_LEVELS: 'none',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let row = null;
  if (existsSync(ledger)) {
    const lines = readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length) row = JSON.parse(lines[lines.length - 1]);
  }
  return { status: r.status, row };
}

// The blocked note, exactly as the escalation protocol tells the agent to
// write it — the shape glm-task's own grep is written against.
const BLOCKED_NOTE = '{"level":"blocked","msg":"Which database should this use?"}';

test('BLOCKED outranks an incomplete worker: a worker that died after asking exits 4, not 6', () => {
  const r = delegate({ code: 1, stdout: '', note: BLOCKED_NOTE });
  assert.equal(r.status, 4,
    `a question waiting is more specific than "did not complete" — exit 4, got ${r.status}`);
});

test('a blocked agent whose worker COMPLETED is not recast as incomplete: exit 4, worker_ok=true', () => {
  const r = delegate({ code: 0, stdout: resultLine({}), note: BLOCKED_NOTE });
  assert.equal(r.status, 4, `a blocked run exits 4 whatever verify said; got ${r.status}`);
  assert.equal(r.row?.worker_ok, true,
    'the worker finished its session; the row must not claim the agent did not complete');
});

test('worker_reason names which shape of incomplete happened', () => {
  const a = delegate({ code: 1, stdout: '' });
  assert.match(a.row?.worker_reason ?? '', /exited 1 without emitting a result/,
    'shape (a) — the row must name the exit and the missing result');

  const b = delegate({ code: 0, stdout: resultLine({ subtype: 'error_during_execution', is_error: true, result: 'the model refused' }) });
  assert.match(b.row?.worker_reason ?? '', /error_during_execution.*the model refused/,
    'shape (b) — the row must name the subtype the worker reported');

  const c = delegate({ code: 0, stdout: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }) });
  assert.match(c.row?.worker_reason ?? '', /exited 0 without emitting a result/,
    'shape (c) — a zero exit with no result must be named as the truncation it is');
});

// The two channels disagree: the result event says the session finished
// cleanly, the worker's own exit status says something failed anyway. The
// exit status is one of the only two routes the worker can present failure
// on, so a disagreement is not a completion — a zero exit here is what an
// unattended drain merges on.
test('a successful result does not rescue a failing exit status: exit 6, worker_ok=false', () => {
  const r = delegate({ code: 1, stdout: resultLine({}) });
  assert.equal(r.status, 6,
    `completion requires BOTH a clean result and exit 0; got exit ${r.status}`);
  assert.equal(r.row?.worker_ok, false,
    'the row must record the contradiction as not-complete, not certify the result it half-heard');
  assert.match(r.row?.worker_reason ?? '', /exited 1 .*successful result/,
    'the reason must name the exit code and the result it contradicts');
});

// The drain side. The stub speaks glm-task's dialect: the stderr line it
// prints for an agent that did not complete, the terminal run line, exit 6.
test('glm-drain retries an incomplete delegation exactly once, then parks it as incomplete — not failed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'glm-delegation-drain-'));
  const state = join(dir, 'state'); mkdirSync(state, { recursive: true });
  const attempts = join(dir, 'attempts');
  const shipLog = join(dir, 'ship.log');

  const taskStub = join(dir, 'glm-task');
  writeFileSync(taskStub, `#!/usr/bin/env bash
echo attempt >> ${JSON.stringify(attempts)}
echo "glm-task: the delegated agent did not complete — the worker exited 1 without emitting a result event - it could not start, died, or was killed mid-run" >&2
echo "glm-task: run dir=/tmp/glm-wt-t session=sess-6 branch=glm/item-1" >&2
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

  const n = existsSync(attempts) ? readFileSync(attempts, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  assert.equal(n, 2, `an incomplete delegation gets ONE retry, then a park; got ${n} attempts`);

  assert.ok(!existsSync(shipLog), 'an incomplete delegation must never be shipped');

  const parked = join(state, 'parked.jsonl');
  assert.ok(existsSync(parked) && readFileSync(parked, 'utf8').trim().length > 0,
    `it must be parked for a human. Drain said:\n${(`${r.stdout ?? ''}${r.stderr ?? ''}`).slice(-800)}`);
  const record = JSON.parse(readFileSync(parked, 'utf8').trim().split('\n').pop());
  assert.equal(record.reason, 'incomplete',
    `"failed" reads as "a change was made and was found wanting" — exit 6 means no change existed; got ${JSON.stringify(record.reason)}`);
  assert.match(record.question ?? '', /did not complete/,
    'the parked record must say the delegated agent did not complete');
  assert.match(record.question ?? '', /exited 1 without emitting a result/,
    'glm-task’s own reason must travel into the parked record, so the morning reader learns WHY');
  assert.match(`${r.stdout ?? ''}`, /incomplete=1/,
    'the summary must count it as incomplete, not fold it into failed or drop it');
});

// What the row IDENTIFIES (#77), past the forms scripts/verify-ledger.mjs
// enumerates. Both assert on fields the gate never reads, in the shapes the
// gate never invokes: a PR reference where its issue forms point, and a
// working directory with no branch at all.
test('a "#n" that names a pull request records no issue: PRs and issues share one number sequence', () => {
  const r = delegate({ task: 'Review PR #45, then merge it' });
  assert.equal(r.status, 0, `the run itself must complete normally; got exit ${r.status}`);
  assert.ok('issue' in (r.row ?? {}),
    'the issue field must be present even when nothing is named');
  assert.equal(r.row?.issue, null,
    `issue 45 does not exist — that number is a pull request. Wrong is worse than absent; got ${JSON.stringify(r.row?.issue)}`);

  // The guard must not over-reach: a real issue reference in the same task is
  // still recorded, and is not swallowed by a nearby PR mention.
  const mixed = delegate({ task: 'Review PR #45, then fix issue #50 it blocks' });
  assert.equal(mixed.row?.issue, 50,
    `a task naming both a PR and an issue records the issue; got ${JSON.stringify(mixed.row?.issue)}`);
});

test('an in-place run on a detached HEAD records branch as present-and-null, not a crash or a SHA', () => {
  const r = delegate({ detach: true });
  assert.equal(r.status, 0, `a detached HEAD is not an error; got exit ${r.status}`);
  assert.ok(r.row, `a row must still be written; the run exited ${r.status}`);
  assert.ok('branch' in r.row,
    'the branch field must be present — a reader cannot tell an omitted field from an old row written before the field existed');
  assert.equal(r.row.branch, null,
    `a detached HEAD names no branch, and the row must not invent one; got ${JSON.stringify(r.row.branch)}`);
});

// glm-task's delegation-outcome honesty beyond what scripts/verify-delegation.mjs
// drives (#91, #93).
//
// The gate is the specification and already covers the three shapes of "the
// agent did not complete", the success control, the two orderings it names
// (rate limit, passing verify), the nothing-committed rules and the drain's
// never-ship. What it does not exercise, and these tests do:
//
//   * BLOCKED still outranks an incomplete worker — exit 4, because a question
//     waiting is more specific than "did not finish". Both directions matter:
//     a worker that died after asking must not be reported as merely
//     incomplete, and a worker that finished its session and committed, but
//     asked, must not be recast as incomplete (worker_ok stays true).
//   * worker_reason says WHICH shape of incomplete happened, so the ledger row
//     carries the why, not only the that.
//   * the two facts of #93 read differently in the row: work left UNCOMMITTED
//     names the files (they are about to be destroyed with the worktree), and
//     "no change at all" does not pretend files exist. A blocked run that left
//     work uncommitted keeps exit 4 — the question outranks everything — while
//     the row still names what was left.
//   * round 2: the branch that certifies a run is the one named in the run
//     line — the branch glm-drain hands to glm-ship — so a -W agent that
//     commits on a side branch or a detached HEAD produced nothing, a git
//     that cannot answer certifies nothing (fail CLOSED, not open), and the
//     count is retaken after every fix round, because a fix worker can undo
//     the commits it was sent to rework.
//   * the ordering guards: throttling (exit 5) still outranks a delegation that
//     committed nothing, and glm-task's own node_modules symlink in a -W
//     worktree is never reported as the agent's uncommitted work.
//   * the drain retries an exit 6 exactly once and parks it as `incomplete`,
//     a category distinct from `failed`, with glm-task's own reason carried
//     into the parked record. The gate asserts a park happened; a drain that
//     never retried, or parked under "failed", would pass it.
//
// Run by `npm test` (node --test), alongside the gate in CI.
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
 *
 * `writes` makes the shim do real work in the repo; `commit` makes it commit
 * that work with its own identity. The pair is the whole of #93: an agent that
 * edits and forgets to commit leaves a branch with nothing on it, and glm-ship
 * pushes commits. `worker` replaces the work fragment with a whole script body
 * (for agents that misbehave in ways writes/commit cannot express — committing
 * on a side branch, breaking git, behaving differently across fix rounds).
 * `reviewer` installs a glm-review shim that records the fact it was asked —
 * plus a `codex` stub on PATH, so the reviewer resolves as installed on a
 * machine where no vendor CLI is (CI included); `review` replaces that shim's
 * body, as a function of the calls file, for stateful reviewers.
 */
function delegate({ code = 0, stdout = resultLine({}), note = '', task = 'do the thing',
                    writes = null, commit = false, verify = null, reviewer = false,
                    git = true, isolate = false, repoDir = null,
                    worker = null, review = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'glm-delegation-test-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  for (const f of ['glm-task', '_glm-hosts.sh', '_glm-capacity.sh']) {
    copyFileSync(join(BIN, f), join(bin, f));
    chmodSync(join(bin, f), 0o755);
  }
  const notes = join(dir, 'notes.jsonl');
  const workerFile = join(bin, 'glm-worker');
  const work = worker !== null
    ? worker
    : writes
      ? `printf '%s' ${JSON.stringify(String(writes))} > "$TEST_REPO/feature.txt"\n` +
        (commit
          ? `git -C "$TEST_REPO" -c user.email=a@example.invalid -c user.name=agent add -A >/dev/null\n` +
            `git -C "$TEST_REPO" -c user.email=a@example.invalid -c user.name=agent commit -qm "the agent's own commit" >/dev/null\n`
          : '')
      : '';
  writeFileSync(workerFile, `#!/usr/bin/env bash\n${work}${note ? `printf '%s\\n' '${note}' >> "$GLM_NOTES"\n` : ''}${stdout ? `cat <<'TESTEOF'\n${stdout}\nTESTEOF\n` : ':'}\nexit ${code}\n`);
  chmodSync(workerFile, 0o755);

  // A reviewer that records the fact it was asked, so a test can tell "spent
  // on nothing" from "never invoked" — the difference #93 is about.
  const reviewCalls = join(dir, 'review-calls.txt');
  const env = {};
  if (reviewer) {
    writeFileSync(join(bin, 'glm-review'),
      review ? review(reviewCalls)
             : `#!/usr/bin/env bash\necho "asked $*" >> ${JSON.stringify(reviewCalls)}\necho "VERDICT: PASS"\nexit 0\n`);
    chmodSync(join(bin, 'glm-review'), 0o755);
    // glm-task keeps a reviewer only if its CLI resolves, and CI machines have
    // none — so provide one. glm-task invokes "$HERE/glm-review" directly, so
    // the shim above is what actually runs whatever PATH says.
    writeFileSync(join(bin, 'codex'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(bin, 'codex'), 0o755);
    env.PATH = `${bin}:${process.env.PATH}`;
  }

  const repo = repoDir ?? join(dir, 'repo');
  if (!repoDir) mkdirSync(repo);
  if (isolate) mkdirSync(join(dir, 'wts'), { recursive: true });
  const g = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.email=test@example.invalid', '-c', 'user.name=test', ...a],
    { encoding: 'utf8' });
  let baseHead = '';
  if (git) {
    if (!repoDir) {
      g('init', '-q', '.');
      g('commit', '-q', '--allow-empty', '-m', 'base');
    }
    baseHead = g('rev-parse', 'HEAD').stdout.trim();
  }

  const ledger = join(dir, 'ledger.jsonl');
  const args = ['-C', repo, '-r', reviewer ? 'codex' : 'none'];
  if (verify !== null) args.push('-v', verify);
  if (isolate) args.push('-W');
  const r = spawnSync('bash', [join(bin, 'glm-task'), ...args, task], {
    encoding: 'utf8', timeout: 120_000,
    env: {
      ...process.env,
      ...env,
      HOME: dir,
      TEST_REPO: repo,
      GLM_TASK_LEDGER: ledger,
      GLM_TASK_LOG: join(dir, 'run.jsonl'),
      GLM_NOTES: notes,
      GLM_NOTIFY_LEVELS: 'none',
      ...(isolate ? { GLM_WORKTREE_ROOT: join(dir, 'wts') } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let row = null;
  if (existsSync(ledger)) {
    const lines = readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length) row = JSON.parse(lines[lines.length - 1]);
  }
  // What the branch and the tree look like AFTER glm-task — from row.dir, the
  // directory glm-task actually ran in (a -W run reports its worktree here).
  const where = row?.dir || repo;
  const gitAt = (...a) => spawnSync('git', ['-C', where, ...a], { encoding: 'utf8' });
  const added = baseHead
    ? Number(gitAt('rev-list', '--count', `${baseHead}..HEAD`).stdout.trim() || '0')
    : null;
  const dirty = gitAt('status', '--porcelain').stdout.trim();
  const reviewCallCount = existsSync(reviewCalls)
    ? readFileSync(reviewCalls, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  return { status: r.status, out: `${r.stdout}${r.stderr}`, row, added, dirty, dir, baseHead,
           reviewed: existsSync(reviewCalls), reviewCallCount };
}

// The branch a -W run names in its terminal run line — the branch glm-drain
// parses back out and hands to glm-ship. What THAT branch carries is what
// ships, whatever the agent left HEAD pointing at.
const shippedBranchOf = (r) => (r.out.match(/^glm-task: run dir=\S+ session=\S+ branch=(\S+)/m) || [])[1] || '';
const commitsOn = (repo, baseHead, ref) =>
  Number(spawnSync('git', ['-C', repo, 'rev-list', '--count', `${baseHead}..${ref}`],
    { encoding: 'utf8' }).stdout.trim() || '0');

// The blocked note, exactly as the escalation protocol tells the agent to
// write it — the shape glm-task's own grep is written against.
const BLOCKED_NOTE = '{"level":"blocked","msg":"Which database should this use?"}';

test('BLOCKED outranks an incomplete worker: a worker that died after asking exits 4, not 6', () => {
  const r = delegate({ code: 1, stdout: '', note: BLOCKED_NOTE });
  assert.equal(r.status, 4,
    `a question waiting is more specific than "did not complete" — exit 4, got ${r.status}`);
});

test('a blocked agent whose worker COMPLETED is not recast as incomplete: exit 4, worker_ok=true', () => {
  // The worker commits, because since #93 a delegation that committed nothing
  // is honestly recorded as one that produced nothing — the property under
  // test here is narrower: a worker that finished cleanly AND delivered must
  // not be recast as incomplete merely for asking a question.
  const r = delegate({ code: 0, stdout: resultLine({}), note: BLOCKED_NOTE, writes: 'work', commit: true });
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

// ---------------------------------------------------------------------------
// #93 — the agent ran, said it finished, and committed nothing. Verify passes
// (it runs against the working tree), so only the branch can tell the truth.

test('an agent that leaves its work uncommitted does not report success — whatever verify said', () => {
  const r = delegate({ writes: 'the work', commit: false, verify: 'test -f feature.txt' });
  assert.equal(r.status, 6,
    `glm-ship pushes commits, so a run that committed nothing ships an empty PR with green CI; got exit ${r.status}`);
  assert.equal(r.row?.verify, 'pass',
    'the row must still record that verify passed — that it COULD pass is what made this defect invisible');
  assert.match(r.row?.worker_reason ?? '', /uncommitted/i,
    'the reason must say the work was left UNCOMMITTED — a different fact, with a different fix, from no work at all');
  assert.match(r.row?.worker_reason ?? '', /feature\.txt/,
    'the reason must NAME the files left behind: they are about to be destroyed with the worktree, and naming them is the difference between recoverable and lost');
  assert.equal(r.row?.review, 'nothing_to_review',
    'the review state must say there was nothing to review, not that the reviewer failed');
  // glm-task must refuse, never tidy up: committing on the agent's behalf
  // invents an author and a message, and sweeps in whatever else was in the tree.
  assert.equal(r.added, 0,
    'glm-task committed the agent\'s work itself — the fix for "nothing was committed" is to refuse, not to commit');
  assert.match(r.dirty, /feature\.txt/,
    'the uncommitted work must be left exactly where the agent left it');
});

test('an agent that produced no change at all is reported in different words, not the same ones', () => {
  const r = delegate({});
  assert.equal(r.status, 6,
    `there is nothing to ship, so a zero exit sends the drain to ship an empty branch; got exit ${r.status}`);
  const reason = String(r.row?.worker_reason ?? '');
  assert.ok(!/uncommitted/i.test(reason),
    `"no change at all" must not be reported as "left work uncommitted" — it says ${JSON.stringify(reason)}, ` +
    'which sends the human looking for files that do not exist');
  assert.match(reason, /no change at all/,
    'the reason must say the delegation produced nothing at all');
});

test('the reviewer is not spent on a diff already known to be empty', () => {
  const r = delegate({ writes: 'the work', commit: false, reviewer: true });
  assert.equal(r.reviewed, false,
    'glm-review was invoked with nothing committed to review — spending a reviewer call to obtain an ' +
    'empty-diff error is how "there was nothing to review" got recorded as "the reviewer broke"');
  assert.equal(r.row?.review, 'nothing_to_review',
    'the row must say there was nothing to review, not that the reviewer errored');
});

test('CONTROL: an agent that commits is unaffected, and its reviewer still runs', () => {
  const r = delegate({ writes: 'the work', commit: true, reviewer: true });
  assert.equal(r.status, 0, `a delegation that committed its work still exits 0; got ${r.status}`);
  assert.equal(r.reviewed, true,
    'skipping review for everything satisfies the empty-diff rule and defeats the entire loop');
  assert.equal(r.row?.review, 'pass', 'the verdict is a real one, not nothing_to_review');
  assert.equal(r.row?.worker_ok, true);
});

// ---------------------------------------------------------------------------
// Round 2 of #93 — three reviewer findings against the first fix, each
// reproduced before being fixed. The property is unchanged; what these pin
// down is WHICH branch certifies the run. glm-drain ships the branch named in
// the run line, so that branch — not whatever the agent left HEAD pointing
// at — is what "produced something" means; a git that cannot answer is not a
// certificate; and a fix round can undo the commits it was asked to rework,
// so the count is taken again after every agent, never carried over stale.

test('a -W worker that commits on a SIDE BRANCH does not report success — the drain ships the named branch', () => {
  // The agent works and commits... on a branch of its own. HEAD carries the
  // work, the run line still names glm/<stamp>, and glm-ship pushes the
  // latter. Counting HEAD certified a change the ship never sees, and the
  // empty-PR failure #93 exists to prevent came straight back.
  const r = delegate({ isolate: true, reviewer: true, worker: `
printf 'the work' > feature.txt
git checkout -q -b agent-side-branch
git add -A
git -c user.email=a@example.invalid -c user.name=agent commit -qm "on the side branch"
` });
  const branch = shippedBranchOf(r);
  assert.ok(branch, 'the run line must name the branch the drain will ship');
  assert.equal(commitsOn(join(r.dir, 'repo'), r.baseHead, `refs/heads/${branch}`), 0,
    'precondition: the shipped branch carries nothing');
  assert.equal(r.status, 6,
    `the branch glm-ship pushes carries nothing whatever HEAD carries; got exit ${r.status}`);
  assert.equal(r.reviewed, false,
    'the reviewer was spent judging a diff the ship never pushes');
  const reason = String(r.row?.worker_reason ?? '');
  assert.match(reason, new RegExp(`committed nothing to ${branch}`),
    'the reason must name the branch that will be shipped');
  assert.doesNotMatch(reason, /uncommitted/i,
    `nothing was left uncommitted — the work is on another ref — so the reason must not say it was; it says ${JSON.stringify(reason)}`);
});

test('a -W worker that commits on a DETACHED HEAD is refused the same way', () => {
  const r = delegate({ isolate: true, worker: `
printf 'the work' > feature.txt
git checkout -q --detach
git add -A
git -c user.email=a@example.invalid -c user.name=agent commit -qm "nowhere at all"
` });
  const branch = shippedBranchOf(r);
  assert.ok(branch);
  assert.equal(commitsOn(join(r.dir, 'repo'), r.baseHead, `refs/heads/${branch}`), 0);
  assert.equal(r.status, 6, `a detached commit is on no branch at all; got exit ${r.status}`);
  assert.match(String(r.row?.worker_reason ?? ''), /committed nothing to/,
    'the reason must say the shipped branch got nothing');
});

test('a worker that breaks the worktree git does not get a change certified on git silence', () => {
  // rm .git: neither rev-list nor status can answer afterwards. The first fix
  // failed OPEN ("assume a change"), which turned "git is broken" into exit 0
  // and a success row on no evidence at all.
  const r = delegate({ isolate: true, worker: `
printf 'the work' > feature.txt
rm -f .git
` });
  assert.equal(r.status, 6,
    `"cannot tell" is not a certificate — a run that cannot show a commit must not report success; got exit ${r.status}`);
  assert.equal(r.row?.worker_ok, false);
  const reason = String(r.row?.worker_reason ?? '');
  assert.match(reason, /could not count/,
    'the reason must say git could not answer, not claim files or cleanliness it never saw');
  assert.doesNotMatch(reason, /uncommitted/i,
    'with git broken, naming uncommitted files would be a guess');
});

test('a fix round that undoes the commit and leaves work uncommitted is refused, not re-reviewed', () => {
  // Round 1 commits; the reviewer asks for changes; the fix worker resets
  // HEAD^ and reworks the file without committing. The count taken before the
  // first review is stale by then: the re-review was spent on a diff already
  // known to be empty, its empty-diff error was recorded as the run's review
  // state — "the reviewer keeps breaking" — and the rework sat uncommitted and
  // unnamed.
  const r = delegate({ reviewer: true, worker: `
case "$*" in
  *"REVIEW FINDINGS"*)
    git reset -q HEAD^
    printf 'the reworked work' > feature.txt
    ;;
  *)
    printf 'the work' > feature.txt
    git add -A
    git -c user.email=a@example.invalid -c user.name=agent commit -qm "the agent's own commit"
    ;;
esac
`, review: (calls) => `#!/usr/bin/env bash
echo asked >> ${JSON.stringify(calls)}
if [[ $(wc -l < ${JSON.stringify(calls)} | tr -d ' ') -eq 1 ]]; then
  echo "VERDICT: CHANGES_REQUIRED"
  echo "finding one: please rework the implementation"
  exit 1
fi
echo "glm-review: empty diff (as the real glm-review does on one)" >&2
exit 2
` });
  assert.equal(r.status, 6,
    `nothing is committed after the fix round, so there is nothing a branch can carry; got exit ${r.status}`);
  assert.equal(r.row?.review, 'nothing_to_review',
    'the review state must say there was nothing to review, not that the reviewer errored');
  assert.equal(r.reviewCallCount, 1,
    'the second reviewer call was spent on a diff already known to be empty');
  assert.match(String(r.row?.worker_reason ?? ''), /uncommitted.*feature\.txt|feature\.txt.*uncommitted/,
    'the rework left in the tree must be named — it is about to be destroyed with the worktree');
  assert.equal(r.added, 0, 'nothing is committed');
  assert.match(r.dirty, /feature\.txt/, 'the reworked file stays exactly where the agent left it');
});

test('CONTROL: a fix round that COMMITS its rework is re-measured, re-reviewed, and can still pass', () => {
  const r = delegate({ reviewer: true, worker: `
case "$*" in
  *"REVIEW FINDINGS"*)
    printf 'the reworked work' > feature.txt
    git add -A
    git -c user.email=a@example.invalid -c user.name=agent commit -qm "the agent's rework"
    ;;
  *)
    printf 'the work' > feature.txt
    git add -A
    git -c user.email=a@example.invalid -c user.name=agent commit -qm "the agent's own commit"
    ;;
esac
`, review: (calls) => `#!/usr/bin/env bash
echo asked >> ${JSON.stringify(calls)}
if [[ $(wc -l < ${JSON.stringify(calls)} | tr -d ' ') -eq 1 ]]; then
  echo "VERDICT: CHANGES_REQUIRED"
  echo "finding one: please rework the implementation"
  exit 1
fi
echo "VERDICT: PASS"
echo "the rework addresses the finding in full"
exit 0
` });
  assert.equal(r.status, 0, `a fix round that commits its rework must still succeed; got exit ${r.status}`);
  assert.equal(r.reviewCallCount, 2, 'the re-review must still run when the fix round committed');
  assert.equal(r.row?.review, 'pass');
  assert.equal(r.row?.fix_rounds, 1);
  assert.equal(r.row?.worker_ok, true);
});

test('BLOCKED still outranks a delegation that committed nothing — and the row still names the files', () => {
  const r = delegate({ writes: 'the work', commit: false, note: BLOCKED_NOTE });
  assert.equal(r.status, 4,
    `the question waiting is more specific than the missing commit; got exit ${r.status}`);
  assert.match(r.row?.worker_reason ?? '', /uncommitted.*feature\.txt|feature\.txt.*uncommitted/,
    'whoever answers the question needs to know work is sitting uncommitted in the worktree');
});

test('ORDERING GUARD: a throttled worker that committed nothing still exits 5', () => {
  const r = delegate({
    code: 1, writes: 'work', commit: false,
    stdout: resultLine({ subtype: 'error_during_execution', is_error: true, result: 'HTTP 429: rate limit exceeded, try again in 30 seconds' }),
  });
  assert.equal(r.status, 5,
    `throttling says nothing about the change, so the item must be requeued, not marked broken; got exit ${r.status}`);
});

test('glm-task’s own node_modules symlink in a -W worktree is not the agent’s uncommitted work', () => {
  // A repo that does NOT ignore node_modules, with one installed, so -W links
  // it into the worktree: untracked, and indistinguishable from the agent's
  // work unless glm-task remembers the link is its own.
  const dir = mkdtempSync(join(tmpdir(), 'glm-delegation-nm-'));
  const repo = join(dir, 'repo'); mkdirSync(repo);
  const g = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.email=test@example.invalid', '-c', 'user.name=test', ...a],
    { encoding: 'utf8' });
  g('init', '-q', '.');
  g('commit', '-q', '--allow-empty', '-m', 'base');
  mkdirSync(join(repo, 'node_modules'));
  writeFileSync(join(repo, 'node_modules', 'marker.txt'), 'installed deps\n');

  const r = delegate({ isolate: true, repoDir: repo });
  assert.equal(r.status, 6, 'an agent that did nothing still produced nothing');
  const reason = String(r.row?.worker_reason ?? '');
  assert.doesNotMatch(reason, /node_modules/,
    `the symlink glm-task itself linked is not the agent's work; the reason says ${JSON.stringify(reason)}`);
  assert.match(reason, /no change at all/, 'with our own symlink excluded, the honest verdict is no change at all');
  assert.match(r.dirty, /node_modules/,
    'the symlink itself stays in the tree — only the BLAME is corrected, never the state');
});

test('CONTROL: a directory with no git base cannot be checked, and must neither crash nor fail', () => {
  const r = delegate({ git: false });
  assert.equal(r.status, 0,
    `with no base commit there is nothing to count, and such a run must keep succeeding; got exit ${r.status}`);
  assert.equal(r.row?.worker_ok, true);
  assert.equal(r.row?.review, 'skipped');
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

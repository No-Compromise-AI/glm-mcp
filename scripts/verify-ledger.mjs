// verify-ledger.mjs — acceptance gate for what a delegation's ledger row
// IDENTIFIES: which branch the run worked on, and which issue it was working
// (#77).
//
// Why this exists. `~/.claude-glm/outcomes.jsonl` is the durable record of every
// delegation, and across the 46 rows on this machine it answers none of the
// questions a retro actually asks — which branches needed a fix round, whether
// the runs that errored in review shipped anything, what an issue cost across
// its rounds. The row records `dir`, which for an isolated run is a temp
// worktree (`/var/folders/.../glm-wt-20260827-182821-32056`) that is deleted
// afterwards and identifies nothing. `glm-task` knows the branch — it created
// it — and throws it away at ledger-write time.
//
// THE PROPERTY, at the tool boundary:
//
//   A ledger row says which branch the run produced and which issue it was
//   working, without anyone re-reading the task prose to guess.
//
// Scope, stated because #77 asks for more than this gate holds. The issue also
// says `fix_rounds` is "the only signal available for a run that failed
// verification", so a misread spec and a wrong gate cannot be told apart.
// Measured against the real ledger, that half is ALREADY satisfied: `verify`,
// `verify_rc`, `review` and `fix_rounds` are four separate fields, and
// verify=fail/fix_rounds=0 is plainly distinct from review=changes_required/
// fix_rounds=1 (both shapes occur in the existing rows). Nothing is built for
// it, and nothing here pretends to.
//
// RULES
//   1. A run given `-b <name>` records THAT branch — the one it created and
//      committed to, not the one the caller happened to be standing on. The
//      gate invokes it from a repo checked out elsewhere, so a fix that records
//      the caller's branch fails here rather than in six months' retro.
//   2. An in-place run (no -W/-b) records the branch the working directory is
//      on. Attribution is not a property of isolation; a run that shares a
//      checkout still needs to say what it touched.
//   3. CONTROL: `base` still records the SHA the run started from, and `dir` is
//      still recorded. The branch is an ADDITION to the row's identifiers, and
//      a fix that swaps one identifier for another has moved the problem.
//   4. A task naming a GitHub issue records the number, in its own field, for
//      each way a task is actually written here: "#123", "issue 123", and the
//      `gh issue view 123` line the /glm skill tells callers to embed.
//   5. FORBID THE WRONG FIX: a number that is not an issue reference is not
//      recorded as one. "raise the timeout to 300 seconds" must record no
//      issue. A greedy digit scan makes the field worse than absent — absent is
//      honestly unknown, wrong is a retro that quietly attributes work to an
//      issue nobody touched.
//   6. FORBID THE WRONG FIX: when no issue is named, the field is null rather
//      than a guess or a crash.
//
// Offline and free: a shim worker, no API calls, no network. The scratch tree
// is a temp directory that never contains or links a node_modules — a deletion
// through such a link has destroyed a real install here before.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fail = (msg) => { throw new Error(msg); };
const BIN = fileURLToPath(new URL('../bin', import.meta.url));
for (const f of ['glm-task', '_glm-hosts.sh', '_glm-capacity.sh']) {
  if (!existsSync(join(BIN, f))) fail(`rule 0: bin/${f} does not exist — this gate cannot be testing the right thing`);
}

let checks = 0;
const check = (ok, msg) => { checks++; if (!ok) fail(msg); };

/**
 * Run the real glm-task against a shim worker that commits, so the run reaches
 * the ledger write as a normal successful delegation would.
 */
function run({ task = 'do the thing', branchArg = null, onBranch = 'main' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'glm-ledger-gate-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  for (const f of ['glm-task', '_glm-hosts.sh', '_glm-capacity.sh']) {
    copyFileSync(join(BIN, f), join(bin, f));
    chmodSync(join(bin, f), 0o755);
  }
  const worker = join(bin, 'glm-worker');
  writeFileSync(worker, `#!/usr/bin/env bash
printf 'work' > "$GATE_REPO/feature.txt"
git -C "$GATE_REPO" -c user.email=a@example.invalid -c user.name=agent add -A >/dev/null
git -C "$GATE_REPO" -c user.email=a@example.invalid -c user.name=agent commit -qm "agent commit" >/dev/null
echo '{"type":"result","subtype":"success","is_error":false,"session_id":"s","num_turns":2,"duration_ms":5,"result":"ok"}'
exit 0
`);
  chmodSync(worker, 0o755);

  const repo = join(dir, 'repo'); mkdirSync(repo);
  const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.email=gate@example.invalid', '-c', 'user.name=gate', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', onBranch, '.');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  const startBranch = spawnSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).stdout.trim();

  const ledger = join(dir, 'ledger.jsonl');
  const args = ['-C', repo, '-r', 'none'];
  if (branchArg) args.push('-b', branchArg);
  const r = spawnSync('bash', [join(bin, 'glm-task'), ...args, task], {
    encoding: 'utf8', timeout: 120_000,
    env: {
      ...process.env,
      HOME: dir, GATE_REPO: repo,
      GLM_TASK_LEDGER: ledger,
      GLM_TASK_LOG: join(dir, 'run.jsonl'),
      GLM_NOTES: join(dir, 'notes.jsonl'),
      GLM_NOTIFY_LEVELS: 'none',
      // Keep any isolated worktree inside the scratch tree.
      GLM_WORKTREE_ROOT: dir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) fail(`glm-task could not be run: ${r.error.message}`);
  let row = null;
  if (existsSync(ledger)) {
    const lines = readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length) row = JSON.parse(lines[lines.length - 1]);
  }
  if (!row) fail(`no ledger row was written at all. glm-task said:\n${(r.stdout ?? '') + (r.stderr ?? '')}`);
  return { row, startBranch, out: `${r.stdout}${r.stderr}`, status: r.status };
}

// Rule 1 — the branch it CREATED, not the branch the caller was standing on.
const iso = run({ branchArg: 'glm/feature-x', onBranch: 'trunk' });
check(iso.startBranch === 'trunk', `rule 1 setup: the caller's repo should be on 'trunk', it is on '${iso.startBranch}'`);
check(iso.row.branch === 'glm/feature-x',
  `rule 1: a run given -b must record that branch; row says ${JSON.stringify(iso.row.branch)}. ` +
  `The caller was on '${iso.startBranch}', so recording the caller's branch is a different value and ` +
  'would attribute the work to a branch that never carried it.');

// Rule 2 — an in-place run is attributable too.
const inplace = run({ onBranch: 'work-here' });
check(inplace.row.branch === 'work-here',
  `rule 2: an in-place run must record the branch its working directory is on; row says ` +
  `${JSON.stringify(inplace.row.branch)}. Attribution is not a property of isolation.`);

// Rule 3 — CONTROL: the identifiers already in the row are still there.
check(typeof iso.row.base === 'string' && /^[0-9a-f]{7,40}$/.test(iso.row.base),
  `rule 3: base must still record the starting SHA; got ${JSON.stringify(iso.row.base)}`);
check(typeof iso.row.dir === 'string' && iso.row.dir.length > 0,
  `rule 3: dir must still be recorded; got ${JSON.stringify(iso.row.dir)}. The branch is an addition ` +
  'to the row\'s identifiers, not a replacement for one.');

// Rule 4 — the issue number, in each form a task is actually written here.
for (const [task, want, how] of [
  ['Fix github issue #123 in this repository', 123, 'a "#123" reference'],
  ['Work issue 456: the reviewer never sees the spec', 456, 'an "issue 456" reference'],
  ['Run: gh issue view 789 --comments. Implement it.', 789, 'the `gh issue view 789` line the /glm skill embeds'],
]) {
  const r = run({ task });
  check(Number(r.row.issue) === want,
    `rule 4: ${how} must be recorded as the issue; row says ${JSON.stringify(r.row.issue)} for task ${JSON.stringify(task)}`);
}

// Rule 5 — FORBID THE WRONG FIX: not every number is an issue.
const noisy = run({ task: 'Raise the request timeout to 300 seconds and retry up to 5 times' });
check(noisy.row.issue === null || noisy.row.issue === undefined,
  `rule 5: a task naming no issue must record none; it recorded ${JSON.stringify(noisy.row.issue)}. ` +
  'A greedy digit scan is worse than an absent field: absent is honestly unknown, wrong quietly ' +
  'attributes work to an issue nobody touched.');

// Rule 5b — a number naming a PULL REQUEST is not an issue number. GitHub
// numbers issues and pull requests from one shared sequence, so "#45" in
// "review PR #45" is a real number for a real thing that is not the issue this
// run was working. Raised by codex against the first implementation, and both
// of its cases reproduced exactly.
//
// The rule is stated over the PROPERTY rather than the two spellings it was
// found by, because the first implementation answered the spellings: it kept
// the bare "#n" pattern and added a guard that suppressed a match when "PR"
// preceded it. That guard both over- and under-fired — it swallowed the
// unambiguous "Review PR (issue 50)", and leaked on "Review PRs #45 and #46" —
// and its tail is unbounded ("backport of #45", "closes #45"). A heuristic that
// needs a second heuristic to correct it is the wrong shape.
for (const task of [
  'Review PRs #45 and #46',
  'Review PR #45 and #46',
  'Backport of #45 to the release branch',
]) {
  const r = run({ task });
  check(r.row.issue === null || r.row.issue === undefined,
    `rule 5b: a task naming only pull requests must record no issue; ${JSON.stringify(task)} ` +
    `recorded ${JSON.stringify(r.row.issue)}. GitHub shares one number sequence between issues and ` +
    'PRs, so this is not an unlikely mistake — it is a confidently wrong retro.');
}

// Rule 4b — and the converse, which is where a PR-suppressing guard goes wrong:
// an UNAMBIGUOUS issue reference still counts when a pull request is mentioned
// beside it. Suppressing these was the first implementation's other half.
for (const [task, want] of [
  ['Review PR (issue 50)', 50],
  ['Fix issue 93 and open a PR', 93],
  ['see the PR for issue #50', 50],
]) {
  const r = run({ task });
  check(Number(r.row.issue) === want,
    `rule 4b: ${JSON.stringify(task)} names issue ${want} unambiguously and must record it; ` +
    `got ${JSON.stringify(r.row.issue)}. Refusing every number near the word "PR" loses real issues.`);
}

// Rule 6 — and it does so without crashing or guessing.
check(noisy.status === 0,
  `rule 6: a task with no issue reference must still complete normally; glm-task exited ${noisy.status}`);
check('issue' in noisy.row,
  'rule 6: the issue field must be PRESENT and null when nothing was named, not omitted — ' +
  'a reader cannot tell an omitted field from an old row written before the field existed.');

console.log(`LEDGER OK (${checks} checks)`);

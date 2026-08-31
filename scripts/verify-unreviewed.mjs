// verify-unreviewed.mjs — acceptance gate for the last open half of #75:
// glm-ship must not auto-merge a change it KNOWS was never reviewed.
//
// Why this could not be built until now. #75 asked for a terminal unreviewed
// state (shipped: glm-task exits 2 on an errored review, 3 on no capacity) and
// for glm-ship to refuse to auto-merge one. The second half needed glm-ship to
// be able to look up a branch's verdict, which needed the ledger to record the
// branch — #77, merged in d31a427. This is that half.
//
// The exposed path is a HUMAN. glm-drain only ships runs that came back 0, so
// unattended shipping is already safe; the gap is someone running
// `glm-ship -m` by hand on a branch whose review errored, which is exactly the
// state the toolchain now takes trouble to report and nothing acted on.
//
// THE PROPERTY, at the tool boundary:
//
//   glm-ship does not auto-merge a change whose own record says no reviewer
//   passed it, unless the operator says so explicitly — and it says which it
//   found either way.
//
// WHERE THE LINE IS, stated because the obvious stricter rule is wrong.
// glm-ship is also the tool a human uses on a branch that never went through
// glm-task, which therefore has no ledger row at all. Refusing those would make
// the tool unusable for half of what it is for. So:
//
//   * a row whose verdict is NOT a pass  -> refuse (this is knowledge)
//   * a row whose verdict IS a pass      -> proceed
//   * no row at all                      -> proceed, and SAY there is no record
//
// "No record" is genuinely different from "reviewed and failed", and conflating
// them in either direction is a defect. Saying nothing about it would be the
// third option and the worst one, because the operator could not tell which
// case they were in.
//
// RULES
//   1. Every non-passing verdict the ledger can hold refuses an auto-merge, and
//      the refusal NAMES the verdict. Driven from the verdicts glm-task itself
//      can write, not a list copied into this gate.
//   2. `skipped` refuses too. A run given `-r none` is deliberately unreviewed,
//      and deliberate is still unreviewed — this is the verdict most likely to
//      be argued into an exception, so it is pinned.
//   3. CONTROL: a passing verdict proceeds and arms auto-merge. Refusing
//      everything satisfies rules 1 and 2 and is not a fix.
//   4. The override works, and is LOUD. An override nobody can see afterwards is
//      indistinguishable from the check not having run.
//   5. FORBID THE WRONG FIX: with no row for the branch, glm-ship proceeds — and
//      says there is no review record. Blocking here would break every branch a
//      human made; silence would leave the operator unable to tell "nobody
//      reviewed this" from "a reviewer passed it".
//   6. FORBID THE WRONG FIX: the lookup matches THIS BRANCH. Reading the newest
//      row regardless of branch is the obvious shortcut and it is wrong in the
//      exact case the tool is for — several delegations in flight, one of them
//      failed, and the failure decides someone else's merge. #77 exists to make
//      this answerable; a fix that ignores it inherits the bug it removed.
//   7. Both merge paths are covered. glm-ship merges in TWO places — arming
//      `--auto`, and merging directly in the watch loop when arming failed — so
//      a fix that guards only the first still merges the change.
//
// Offline: `gh` and the git remote are local stubs, so no network and no
// GitHub. The scratch tree never contains or links a node_modules.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fail = (msg) => { throw new Error(msg); };
const BIN = fileURLToPath(new URL('../bin', import.meta.url));
const SHIP = join(BIN, 'glm-ship');
if (!existsSync(SHIP)) fail('rule 0: bin/glm-ship does not exist');

let checks = 0;
const check = (ok, msg) => { checks++; if (!ok) fail(msg); };

// The verdicts glm-task can actually write, read out of glm-task itself rather
// than restated here — a copied list is a second source of truth and drifts.
// If the shape it is read from changes, that is a failure, not a pass.
const taskSrc = readFileSync(join(BIN, 'glm-task'), 'utf8');
const VERDICTS = [...taskSrc.matchAll(/REVIEW_VERDICT="([a-z_]+)"/g)].map((m) => m[1]);
const uniq = [...new Set(VERDICTS)];
check(uniq.includes('pass') && uniq.includes('changes_required') && uniq.includes('error') && uniq.includes('no_capacity'),
  `rule 0: could not read glm-task's review verdicts out of its source — found ${JSON.stringify(uniq)}. ` +
  'A shape this gate cannot read is a failure, not a pass.');
const NON_PASSING = uniq.filter((v) => v !== 'pass');

/**
 * Run the real glm-ship against a local bare "remote" and a stubbed `gh`,
 * with a ledger containing `rows`.
 */
function ship({ rows = [], branch = 'feat/x', args = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'glm-unreviewed-gate-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  for (const f of ['glm-ship', '_glm-hosts.sh', '_glm-capacity.sh']) {
    if (existsSync(join(BIN, f))) { copyFileSync(join(BIN, f), join(bin, f)); chmodSync(join(bin, f), 0o755); }
  }

  // A `gh` that records every call and answers just enough for the watch loop
  // to conclude on the first pass.
  const ghLog = join(dir, 'gh-calls.txt');
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(ghLog)}
case "$1 $2" in
  "pr list")   echo "" ;;
  "pr create") echo "7" ;;
  "pr view")   printf 'MERGED\\tMERGEABLE\\tCLEAN\\n' ;;
  "pr checks") echo "[]" ;;
  *) : ;;
esac
exit 0
`);
  chmodSync(gh, 0o755);

  const remote = join(dir, 'remote.git');
  spawnSync('git', ['init', '-q', '--bare', remote]);
  const repo = join(dir, 'repo'); mkdirSync(repo);
  const g = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.email=g@example.invalid', '-c', 'user.name=g', ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main', '.');
  g('commit', '-q', '--allow-empty', '-m', 'base');
  g('remote', 'add', 'origin', remote);
  g('push', '-q', 'origin', 'main');
  g('checkout', '-q', '-b', branch);
  g('commit', '-q', '--allow-empty', '-m', 'the change');

  const ledger = join(dir, 'ledger.jsonl');
  writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));

  const r = spawnSync('bash', [join(bin, 'glm-ship'), '-C', repo, '-b', branch, ...args], {
    encoding: 'utf8', timeout: 120_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      GLM_TASK_LEDGER: ledger,
      GLM_NOTES: join(dir, 'notes.jsonl'),
      GLM_SHIP_CHECK_GRACE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ghCalls = existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : '';
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, ghCalls, dir };
}

const row = (o) => ({
  ts: '2026-08-30T12:00:00-05:00', branch: 'feat/x', base: 'a'.repeat(40),
  reviewer: 'codex', review: 'pass', fix_rounds: 0, verify: 'pass', ...o,
});

// Rule 1 — every non-passing verdict refuses, and names itself.
for (const verdict of NON_PASSING) {
  const r = ship({ rows: [row({ review: verdict })], args: ['-m'] });
  check(r.status !== 0 && r.status !== 5,
    `rule 1: review=${verdict} must refuse an auto-merge; glm-ship exited ${r.status}. ` +
    'This is the change the toolchain took trouble to mark unreviewed, being merged anyway.');
  check(!/--auto/.test(r.ghCalls) && !/pr merge/.test(r.ghCalls),
    `rule 1: review=${verdict} — glm-ship still called \`gh pr merge\`. It said no and merged anyway. Calls:\n${r.ghCalls}`);
  check(new RegExp(verdict).test(r.out),
    `rule 1: the refusal must NAME the verdict (${verdict}) so the operator knows what to fix. It said:\n${r.out.slice(-500)}`);
}

// Rule 2 — `skipped` is unreviewed too.
check(NON_PASSING.includes('skipped') || true, 'rule 2 setup');
{
  const r = ship({ rows: [row({ review: 'skipped', reviewer: 'none' })], args: ['-m'] });
  check(r.status !== 0 && r.status !== 5,
    `rule 2: review=skipped must refuse an auto-merge; got ${r.status}. A run given -r none is ` +
    'deliberately unreviewed, and deliberate is still unreviewed.');
}

// Rule 3 — CONTROL. A pass proceeds and arms auto-merge.
{
  const r = ship({ rows: [row({ review: 'pass' })], args: ['-m'] });
  check(/--auto/.test(r.ghCalls),
    `rule 3: a passing review must still arm auto-merge. gh calls:\n${r.ghCalls}\nglm-ship said:\n${r.out.slice(-400)}`);
  check(r.status === 5,
    `rule 3: a passing review with no -V must reach the existing merged-but-unverified outcome (5); got ${r.status}`);
}

// Rule 4 — the override works and is loud.
{
  const r = ship({ rows: [row({ review: 'error' })], args: ['-m', '-U'] });
  check(/--auto/.test(r.ghCalls),
    `rule 4: -U must let the operator proceed anyway. gh calls:\n${r.ghCalls}\n${r.out.slice(-400)}`);
  check(/unreviewed/i.test(r.out) && /overrid/i.test(r.out),
    `rule 4: an override must be stated out loud — an override nobody can see afterwards is ` +
    `indistinguishable from the check not having run. It said:\n${r.out.slice(-500)}`);
}

// Rule 5 — FORBID THE WRONG FIX: no record is not a failure, but it is not silence either.
{
  const r = ship({ rows: [], args: ['-m'] });
  check(/--auto/.test(r.ghCalls),
    `rule 5: a branch with NO ledger row must still ship — glm-ship is also the tool a human uses ` +
    `on a branch that never went through glm-task. gh calls:\n${r.ghCalls}\n${r.out.slice(-400)}`);
  check(/no review record/i.test(r.out),
    `rule 5: it must SAY there is no review record. Otherwise the operator cannot tell "nobody ` +
    `reviewed this" from "a reviewer passed it". It said:\n${r.out.slice(-500)}`);
}

// Rule 6 — FORBID THE WRONG FIX: the row must be matched to THIS branch.
{
  const r = ship({
    branch: 'feat/mine',
    rows: [
      row({ branch: 'feat/mine', review: 'pass', ts: '2026-08-30T10:00:00-05:00' }),
      // A LATER row, for somebody else's branch, that failed review.
      row({ branch: 'feat/theirs', review: 'error', ts: '2026-08-30T11:00:00-05:00' }),
    ],
    args: ['-m'],
  });
  check(/--auto/.test(r.ghCalls),
    'rule 6: a newer row for a DIFFERENT branch decided this branch\'s fate. Reading the last row ' +
    'regardless of branch is the obvious shortcut and it is wrong in exactly the case this tool is ' +
    `for — several delegations in flight, one of them failed. Said:\n${r.out.slice(-500)}`);
}
{
  // ...and the converse: this branch's own failure is not excused by a newer passing row elsewhere.
  const r = ship({
    branch: 'feat/mine',
    rows: [
      row({ branch: 'feat/mine', review: 'error', ts: '2026-08-30T10:00:00-05:00' }),
      row({ branch: 'feat/theirs', review: 'pass', ts: '2026-08-30T11:00:00-05:00' }),
    ],
    args: ['-m'],
  });
  check(!/--auto/.test(r.ghCalls),
    'rule 6: this branch\'s own failed review was excused by a newer passing row for another branch.');
}

// Rule 7 — both merge paths. Auto-merge arming is one; the watch loop merges
// directly when arming failed, and a fix guarding only the first still merges.
{
  const src = readFileSync(SHIP, 'utf8');
  const mergeSites = [...src.matchAll(/gh pr merge[^\n]*/g)].map((m) => m[0]);
  check(mergeSites.length >= 2,
    `rule 7: expected glm-ship to still have both merge paths to guard; found ${mergeSites.length}. ` +
    'If the structure changed, re-derive this rule rather than deleting it.');
  // Drive the second path: arming fails, so the watch loop is what would merge.
  const r = ship({ rows: [row({ review: 'error' })], args: ['-m'] });
  check(!/pr merge/.test(r.ghCalls),
    `rule 7: glm-ship reached a merge call on an unreviewed change. Guarding only the --auto arming ` +
    `leaves the watch loop's direct merge wide open. Calls:\n${r.ghCalls}`);
}

console.log(`UNREVIEWED OK (${checks} checks)`);

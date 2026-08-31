// verify-branch.mjs — acceptance gate for #78: the two things that make the
// documented workflow fight the tool.
//
// The workflow this repo actually follows is: write the acceptance gate, commit
// it on a branch named for the work, then delegate against that branch. Doing
// exactly that fails:
//
//     fatal: a branch named 'routing' already exists
//     glm-task: could not create worktree /var/folders/.../glm-wt-... on routing
//
// because `git worktree add -b` requires the branch NOT to exist. The
// workaround used last time was renaming the local branch to `routing-gate` and
// letting glm-task create `routing`, which puts the gate commit and the
// implementation on differently-named branches for no reason a reader could
// guess.
//
// And separately: a stored review cites paths inside the worktree it was
// produced in, which is deleted when the run ends —
//
//     src/glm.ts:225 — baseUrl() (/private/var/folders/.../glm-wt-.../src/glm.ts:194)
//
// so `review_text`, the durable artifact, links to nothing. The line numbers
// are already right; only the prefix is wrong.
//
// THE CONSTRAINT THIS MUST NOT BREAK. verify-drain rule 10 requires every
// attempt at an item to get its OWN branch, and the drain depends on that
// semantics. Making glm-task tolerant of an existing branch does not weaken it
// — the drain still generates a distinct name per attempt — but it does remove
// the accident that used to enforce it. So rule 3 below puts back a real
// guarantee in place of the accidental one: reuse is allowed only when nothing
// else has that branch checked out, which is the property that actually keeps
// two runs from committing over each other.
//
// RULES
//   1. `-b <existing branch>` no longer aborts. The run proceeds ON that branch,
//      starting from ITS tip — not from HEAD — because the whole point is to
//      continue work whose gate commit is already on it.
//   2. It says it is reusing. A tool that silently does something other than
//      what its flag last meant is worse than one that fails.
//   3. Reuse is refused when the branch is checked out in another worktree, in
//      the tool's own words rather than a raw git error. This is what keeps two
//      runs off one branch now that the abort is gone.
//   4. CONTROL: `-b <new branch>` still creates it. Tolerating the existing case
//      by never creating one would satisfy rules 1-3.
//   5. FORBID THE WRONG FIX: reuse must not discard what is on the branch.
//      Resetting it to HEAD would make `worktree add -b` succeed and would throw
//      away the commit the operator was trying to build on.
//   6. A stored review cites paths that still exist: the run's worktree prefix
//      is gone from `review_text`, leaving repo-relative paths.
//   7. FORBID THE WRONG FIX: only the prefix goes. Line numbers, findings and
//      any path that is NOT inside this run's worktree survive untouched — a
//      rewrite that mangles the finding has destroyed the thing it was fixing.
//
// Offline: a shim worker and a shim reviewer, no API calls.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fail = (msg) => { throw new Error(msg); };
const BIN = fileURLToPath(new URL('../bin', import.meta.url));
let checks = 0;
const check = (ok, msg) => { checks++; if (!ok) fail(msg); };

/**
 * Run the real glm-task with `-b branchArg`. `preExisting` creates that branch
 * first, carrying a marker commit; `checkedOut` additionally parks it in
 * another worktree. `findings` is what the shim reviewer emits.
 */
function task({ branchArg, preExisting = false, checkedOut = false, findings = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'glm-branch-gate-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  for (const f of ['glm-task', '_glm-hosts.sh', '_glm-capacity.sh']) {
    copyFileSync(join(BIN, f), join(bin, f)); chmodSync(join(bin, f), 0o755);
  }
  const repo = join(dir, 'repo'); mkdirSync(repo);
  const g = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.email=g@example.invalid', '-c', 'user.name=g', ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main', '.');
  writeFileSync(join(repo, 'base.txt'), 'base');
  g('add', '-A'); g('commit', '-q', '-m', 'base');
  const mainHead = g('rev-parse', 'HEAD').stdout.trim();

  // The operator's branch, with the gate commit they want to build on.
  let preTip = '';
  if (preExisting) {
    g('checkout', '-q', '-b', branchArg);
    writeFileSync(join(repo, 'the-gate.txt'), 'the acceptance gate, committed first');
    g('add', '-A'); g('commit', '-q', '-m', 'the gate commit');
    preTip = g('rev-parse', 'HEAD').stdout.trim();
    g('checkout', '-q', 'main');
  }
  let parked = '';
  if (checkedOut) {
    parked = join(dir, 'parked');
    g('worktree', 'add', '-q', parked, branchArg);
  }

  // A worker that commits, so the run reaches the review and the ledger.
  writeFileSync(join(bin, 'glm-worker'), `#!/usr/bin/env bash
printf 'work' > "$PWD/feature.txt"
git -C "$PWD" -c user.email=a@example.invalid -c user.name=agent add -A >/dev/null 2>&1
git -C "$PWD" -c user.email=a@example.invalid -c user.name=agent commit -qm "the agent commit" >/dev/null 2>&1
echo '{"type":"result","subtype":"success","is_error":false,"session_id":"s","num_turns":2,"duration_ms":5,"result":"ok"}'
exit 0
`);
  chmodSync(join(bin, 'glm-worker'), 0o755);

  // A reviewer whose findings cite absolute paths inside the run's worktree,
  // exactly as the real ones do.
  const reviewer = findings === null ? null : join(bin, 'glm-review');
  if (reviewer) {
    writeFileSync(reviewer, `#!/usr/bin/env bash
d=""; prev=""
for a in "$@"; do [ "$prev" = "-C" ] && d="$a"; prev="$a"; done
printf '%s\\n' ${JSON.stringify(findings)} | sed "s#@WT@#$d#g"
exit 1
`);
    chmodSync(reviewer, 0o755);
    writeFileSync(join(bin, 'codex'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(bin, 'codex'), 0o755);
  }

  const ledger = join(dir, 'ledger.jsonl');
  const r = spawnSync('bash', [join(bin, 'glm-task'), '-C', repo, '-b', branchArg,
    '-r', reviewer ? 'codex' : 'none', '-x', '0', 'do the thing'], {
    encoding: 'utf8', timeout: 120_000,
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir,
      GLM_TASK_LEDGER: ledger, GLM_TASK_LOG: join(dir, 'run.jsonl'),
      GLM_NOTES: join(dir, 'notes.jsonl'), GLM_NOTIFY_LEVELS: 'none',
      GLM_WORKTREE_ROOT: join(dir, 'wts'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  mkdirSync(join(dir, 'wts'), { recursive: true });

  let row = null;
  if (existsSync(ledger)) {
    const lines = readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length) row = JSON.parse(lines[lines.length - 1]);
  }
  const tipNow = preExisting || !r.status
    ? spawnSync('git', ['-C', repo, 'rev-parse', branchArg], { encoding: 'utf8' }).stdout.trim() : '';
  const onBranch = spawnSync('git', ['-C', repo, 'log', '--oneline', branchArg], { encoding: 'utf8' }).stdout;
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, row, mainHead, preTip, tipNow, onBranch, dir };
}

// Rule 1 — an existing branch is continued, from its own tip.
{
  mkdirSync(join(tmpdir(), 'x'), { recursive: true });
  const r = task({ branchArg: 'the-work', preExisting: true });
  check(r.status === 0,
    `rule 1: glm-task -b on an EXISTING branch must not abort; it exited ${r.status}. This is the ` +
    `documented workflow — commit the gate on a branch named for the work, then delegate to it. ` +
    `It said:\n${r.out.slice(-700)}`);
  check(/the gate commit/.test(r.onBranch),
    `rule 1: the run must continue from the branch's OWN tip, keeping the commit already on it. ` +
    `The branch now reads:\n${r.onBranch}`);
  check(/the agent commit/.test(r.onBranch),
    `rule 1: the agent's work must land on that same branch. It reads:\n${r.onBranch}`);
}

// Rule 2 — and it says so.
{
  const r = task({ branchArg: 'the-work', preExisting: true });
  check(/reus|existing/i.test(r.out),
    `rule 2: reusing an existing branch must be stated. A tool that silently does something other ` +
    `than what its flag last meant is worse than one that fails. It said:\n${r.out.slice(-700)}`);
}

// Rule 3 — but not when someone else has it checked out.
{
  const r = task({ branchArg: 'the-work', preExisting: true, checkedOut: true });
  check(r.status !== 0,
    'rule 3: a branch already checked out in another worktree must NOT be reused — that is two runs ' +
    'committing over each other, the exact thing worktrees exist to prevent. It succeeded instead.');
  check(/checked out|another worktree|in use/i.test(r.out),
    `rule 3: the refusal must be in the tool's own words, not a raw git error. It said:\n${r.out.slice(-700)}`);
}

// Rule 4 — CONTROL: a new branch is still created.
{
  const r = task({ branchArg: 'brand-new' });
  check(r.status === 0, `rule 4: -b with a NEW branch must still work; exited ${r.status}\n${r.out.slice(-500)}`);
  check(/the agent commit/.test(r.onBranch),
    `rule 4: the agent's work must land on the new branch. It reads:\n${r.onBranch}`);
}

// Rule 5 — FORBID THE WRONG FIX: reuse must not discard the branch.
{
  const r = task({ branchArg: 'the-work', preExisting: true });
  check(r.tipNow !== r.mainHead,
    'rule 5: the branch was reset to HEAD. That makes `worktree add -b` succeed and throws away the ' +
    'commit the operator was trying to build on — which is the entire reason they named the branch.');
}

// Rules 6 and 7 — the stored review cites paths that still exist.
{
  const FINDINGS = [
    'VERDICT: CHANGES_REQUIRED',
    '- [P1] src/glm.ts:225 — baseUrl() (@WT@/src/glm.ts:194) is wrong',
    '- [P2] see @WT@/test/api.test.mjs:12 and also /usr/lib/node_modules/elsewhere.js:3',
  ].join('\n');
  const r = task({ branchArg: 'reviewed-work', findings: FINDINGS });
  const text = String(r.row?.review_text ?? '');
  check(text.length > 0, `rules 6-7: no review_text was stored at all. Row: ${JSON.stringify(r.row)}`);
  check(!/glm-wt-/.test(text),
    `rule 6: review_text still cites the run's worktree, which is deleted when the run ends — so ` +
    `every path in the durable record points at nothing. It stored:\n${text.slice(0, 600)}`);
  check(/src\/glm\.ts:194/.test(text) && /test\/api\.test\.mjs:12/.test(text),
    `rule 7: the paths must survive as repo-relative WITH their line numbers — the numbers were ` +
    `already correct, only the prefix was wrong. It stored:\n${text.slice(0, 600)}`);
  check(/\/usr\/lib\/node_modules\/elsewhere\.js:3/.test(text),
    `rule 7: a path OUTSIDE this run's worktree must be left alone. Rewriting anything that looks ` +
    `like a path mangles findings instead of fixing them. It stored:\n${text.slice(0, 600)}`);
  check(/baseUrl\(\)/.test(text) && /VERDICT: CHANGES_REQUIRED/.test(text),
    `rule 7: the finding's own text must be untouched. It stored:\n${text.slice(0, 600)}`);
}

console.log(`BRANCH OK (${checks} checks)`);

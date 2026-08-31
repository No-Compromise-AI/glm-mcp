// verify-evidence.mjs — acceptance gate for #82: the review record reaches the
// pull request.
//
// Every delegated change here is reviewed by a different vendor's model against
// the spec it was meant to implement, often with a fix round after. None of
// that reached the PR: glm-ship built the body from commit subjects, and the
// review lived in ~/.claude-glm/outcomes.jsonl on one machine and died there.
// The rigour was an assertion in a commit message rather than a record.
//
// Two things made it concrete rather than theoretical, and both are rules here:
// `agy` was out of capacity twice, so those changes had ONE reviewer and
// nothing said so — a record that silently omits an absent reviewer is worse
// than no record, because it reads as full coverage. And `review=error`
// occurred twice because glm-review diffs committed state, so a verdict can
// describe a commit that is not the one that merged.
//
// THE PROPERTY, at the tool boundary:
//
//   The comment on the PR says who reviewed this change, with which model, at
//   which SHAs, who did not, and why — and never says anything a reviewer did
//   not actually say.
//
// The last clause is the one that decides whether any of it is worth having.
// The record's only value is that it is true, so every rule below is either
// "this fact must appear" or "this fact must not be invented".
//
// RULES
//   1. A plain PR COMMENT, not a review thread. main's ruleset has
//      required_review_thread_resolution, and glm-drain auto-merges unattended,
//      so a tool posting findings as threads would deadlock the drain on its
//      own comments — and one that then resolved them itself would be recording
//      theatre. `gh pr comment`, never `gh pr review`.
//   2. Every reviewer that DELIVERED is named with its model. "reviewed by
//      codex" is not a record; "codex / gpt-5.6-sol" is.
//   3. Every reviewer that did NOT deliver is named, with why. This is the fact
//      most worth recording and the easiest to omit, because omitting it makes
//      the record look better.
//   4. The exact base..head SHAs that were reviewed appear. A record that
//      cannot be checked against a diff is decoration.
//   5. If HEAD MOVED after the review, the comment says so. This is the
//      load-bearing rule, not a detail: a verdict that describes a commit which
//      is not the one merging is the failure mode already observed twice.
//   6. The comment states plainly that it is self-reported, not third-party
//      attestation. Anything stronger would be a claim the tool cannot support.
//   7. FORBID THE WRONG FIX: with no review record for the branch, glm-ship
//      posts NO review record. Not an empty template, not "reviewed by: none"
//      dressed as coverage. Inventing a record is worse than having none.
//   8. FORBID THE WRONG FIX: the comment is posted ONCE per ship, not per poll
//      of the check-watch loop.
//   9. glm-ship recognises "blocked by unresolved conversations" as its own
//      state and says so. Today it watches checks only, so a mergeable PR
//      waiting on a human's click sits until the deadline and reports a
//      timeout — a misleading failure for a change that is fine.
//
// Offline: `gh` and the git remote are local stubs. No network, no GitHub.
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

/**
 * Run the real glm-ship. `record` becomes the ledger row's review_record.
 * `headMoved` makes the branch advance past the SHA the record claims.
 * `blockedOnConversations` makes the stub gh report that state.
 */
function ship({ record = null, headMoved = false, blockedOnConversations = false, branch = 'feat/x' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'glm-evidence-gate-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  for (const f of ['glm-ship', '_glm-hosts.sh', '_glm-capacity.sh']) {
    if (existsSync(join(BIN, f))) { copyFileSync(join(BIN, f), join(bin, f)); chmodSync(join(bin, f), 0o755); }
  }

  const ghLog = join(dir, 'gh-calls.txt');
  const commentBody = join(dir, 'comment-body.txt');
  // The stub records each call, and captures a comment body whether it arrives
  // as --body or --body-file, so the gate does not force one spelling.
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
echo "ARGS: $*" >> ${JSON.stringify(ghLog)}
if [ "$1 $2" = "pr comment" ]; then
  prev=""
  for a in "$@"; do
    [ "$prev" = "--body" ] && printf '%s\\n' "$a" >> ${JSON.stringify(commentBody)}
    [ "$prev" = "--body-file" ] && cat "$a" >> ${JSON.stringify(commentBody)}
    prev="$a"
  done
  exit 0
fi
# glm-ship always asks gh to do the filtering with --jq, so a stub that echoes
# raw JSON answers a question the tool never asked: a count query would come
# back "[]", which is not 0, and the watch loop would spin past every branch
# that depends on it. The stub answers the SHAPE each call expects, not a
# generic blob. (No backticks in here: this file is a JS template literal.)
ALL="$*"
case "$1 $2" in
  "pr list")   echo "" ;;
  "pr create") echo "7" ;;
  "pr view")
    case "$ALL" in
      *reviewThreads*) echo "\${GATE_UNRESOLVED:-0}" ;;
      *) printf '%s\\tMERGEABLE\\t%s\\n' "\${GATE_PRSTATE:-MERGED}" "\${GATE_MERGESTATE:-CLEAN}" ;;
    esac ;;
  "pr checks")
    case "$ALL" in
      *join*) printf '' ;;   # the failed-checks query: none failed
      *) echo 0 ;;           # every count query: no checks at all
    esac ;;
  *) : ;;
esac
exit 0
`);
  chmodSync(join(bin, 'gh'), 0o755);

  const remote = join(dir, 'remote.git');
  spawnSync('git', ['init', '-q', '--bare', remote]);
  const repo = join(dir, 'repo'); mkdirSync(repo);
  const g = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.email=g@example.invalid', '-c', 'user.name=g', ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main', '.');
  g('commit', '-q', '--allow-empty', '-m', 'base');
  const base = g('rev-parse', 'HEAD').stdout.trim();
  g('remote', 'add', 'origin', remote);
  g('push', '-q', 'origin', 'main');
  g('checkout', '-q', '-b', branch);
  g('commit', '-q', '--allow-empty', '-m', 'the reviewed change');
  const reviewedHead = g('rev-parse', 'HEAD').stdout.trim();
  if (headMoved) g('commit', '-q', '--allow-empty', '-m', 'a commit made AFTER the review');

  const ledger = join(dir, 'ledger.jsonl');
  const rows = record === null ? [] : [{
    ts: '2026-08-30T12:00:00-05:00', branch, base, reviewer: 'codex', review: 'pass',
    fix_rounds: 1, verify_cmd: 'npm test', verify: 'pass', verify_rc: 0,
    review_text: '- [P1] a finding the reviewer actually wrote',
    review_record: { base, head: reviewedHead, ...record },
  }];
  writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));

  const r = spawnSync('bash', [join(bin, 'glm-ship'), '-C', repo, '-b', branch, '-m'], {
    encoding: 'utf8', timeout: 120_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      GLM_TASK_LEDGER: ledger,
      GLM_NOTES: join(dir, 'notes.jsonl'),
      GLM_SHIP_CHECK_GRACE: '0',
      GATE_PRSTATE: blockedOnConversations ? 'OPEN' : 'MERGED',
      GATE_MERGESTATE: blockedOnConversations ? 'BLOCKED' : 'CLEAN',
      GATE_UNRESOLVED: blockedOnConversations ? '2' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: r.status,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    ghCalls: existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : '',
    comment: existsSync(commentBody) ? readFileSync(commentBody, 'utf8') : '',
    base, reviewedHead,
  };
}

const FULL = {
  reviewers: [
    { name: 'codex', model: 'gpt-5.6-sol', verdict: 'pass' },
    { name: 'claude', model: 'claude-opus-4-6-thinking', verdict: 'changes_required' },
  ],
  absent: [{ name: 'agy', reason: 'out of capacity' }],
};

// Rules 1-6 all read one posted comment.
const r1 = ship({ record: FULL });

check(/pr comment/.test(r1.ghCalls),
  `rule 1: no PR comment was posted at all. gh calls:\n${r1.ghCalls}\nglm-ship said:\n${r1.out.slice(-600)}`);
check(!/pr review/.test(r1.ghCalls),
  'rule 1: the record was posted as a REVIEW, not a comment. main requires review threads to be ' +
  'resolved before merge, and glm-drain auto-merges unattended — a tool that posts threads ' +
  'deadlocks the drain on its own comments.');

for (const [name, model] of [['codex', 'gpt-5.6-sol'], ['claude', 'claude-opus-4-6-thinking']]) {
  check(r1.comment.includes(name) && r1.comment.includes(model),
    `rule 2: the comment must name reviewer "${name}" AND its model "${model}". ` +
    `"reviewed by ${name}" is not a record. Comment was:\n${r1.comment.slice(0, 1200)}`);
}

check(/agy/.test(r1.comment) && /capacity/i.test(r1.comment),
  'rule 3: the comment must name the reviewer that did NOT deliver, and why. This is the fact ' +
  `most worth recording and the easiest to omit, because omitting it makes the record look ` +
  `better. Comment was:\n${r1.comment.slice(0, 1200)}`);

check(r1.comment.includes(r1.base.slice(0, 7)) && r1.comment.includes(r1.reviewedHead.slice(0, 7)),
  `rule 4: the comment must carry the exact base..head SHAs reviewed (${r1.base.slice(0, 7)}..` +
  `${r1.reviewedHead.slice(0, 7)}). A record that cannot be checked against a diff is decoration. ` +
  `Comment was:\n${r1.comment.slice(0, 1200)}`);

check(/self-report|not.*attestation|not.*third.party/i.test(r1.comment),
  'rule 6: the comment must say plainly that it is self-reported, not third-party attestation. ' +
  `Anything stronger is a claim this tool cannot support. Comment was:\n${r1.comment.slice(0, 1200)}`);

// Rule 5 — the load-bearing one.
{
  const moved = ship({ record: FULL, headMoved: true });
  check(/moved|since the review|after the review|no longer/i.test(moved.comment),
    'rule 5: HEAD moved after the review and the comment did not say so. A verdict describing a ' +
    'commit that is not the one merging is the exact failure already observed twice — and a record ' +
    `that hides it is worse than none. Comment was:\n${moved.comment.slice(0, 1200)}`);
  check(!/moved|since the review|after the review/i.test(r1.comment),
    'rule 5: the comment claims HEAD moved when it did not. Crying wolf on every PR trains the ' +
    'reader to ignore the one that matters.');
}

// Rule 7 — FORBID THE WRONG FIX: never invent a record.
{
  const none = ship({ record: null });
  const posted = /pr comment/.test(none.ghCalls);
  check(!posted || !/codex|claude|agy|reviewer/i.test(none.comment),
    'rule 7: with NO review record for this branch, glm-ship posted something naming reviewers. ' +
    `Inventing a record is worse than having none — the whole value of this comment is that it is ` +
    `true. It posted:\n${none.comment.slice(0, 800)}`);
}

// Rule 8 — posted once, not once per poll.
check((r1.ghCalls.match(/pr comment/g) ?? []).length === 1,
  `rule 8: the review record was posted ${(r1.ghCalls.match(/pr comment/g) ?? []).length} times. ` +
  'The check-watch loop polls; a comment inside it becomes a wall of duplicates on a slow PR.');

// Rule 9 — blocked on conversations is its own state, not a timeout.
{
  const blocked = ship({ record: FULL, blockedOnConversations: true });
  check(/conversation/i.test(blocked.out),
    'rule 9: a PR blocked on unresolved conversations must be reported as that, not left to time ' +
    'out. "timed out" is a misleading failure for a change that is fine and waiting on a human ' +
    `click. glm-ship said:\n${blocked.out.slice(-800)}`);
  check(!/checks still running/i.test(blocked.out),
    'rule 9: it reported a check timeout for a PR whose checks were green and whose only blocker ' +
    'was an unresolved conversation.');
}

console.log(`EVIDENCE OK (${checks} checks)`);

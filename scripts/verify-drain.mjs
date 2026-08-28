// verify-drain.mjs — acceptance gate for glm-drain, the unattended backlog drain.
//
// This is the only tool here that runs with nobody watching, which changes what
// correctness means. A mistake in glm_ask wastes a call; a mistake here spends a
// night merging the wrong things, or spends a night doing nothing while an
// answerable question sits unread. The two requirements it exists to satisfy
// were given explicitly:
//
//   * a BLOCKED item is parked with its question and the drain moves on, so only
//     what genuinely needs a human is waiting in the morning;
//   * concurrency scales WITHIN the provider's rate limits, with no attempt to
//     circumvent them.
//
// The second is constrained by measurement, not preference: z.ai returns no
// rate-limit headers (checked against a live 200) and publishes no concurrency
// number. The driver therefore cannot know the limit. It can only stay
// conservative by default, react to pressure, and never probe upward — and rules
// 4, 5 and 8 below are what hold it to that.
//
// Driven against a STUB glm-task, so every case is deterministic, free, and
// finishes in seconds: no API calls, no worktrees, no waiting on CI. The stub
// records each invocation with timestamps, which is what makes concurrency and
// backoff observable from outside rather than asserted about the source.
//
//   1. A blocked item (exit 4) is parked AND the drain continues to the next
//      item. Parking that halts the drain is the failure this replaces.
//   2. A parked entry carries what is needed to resume it: the session id and
//      the worktree. Without both, "parked" means "lost".
//   3. A rate-limited item (exit 5) is REQUEUED, not failed, and its attempt is
//      not consumed. Throttling is not information about the change.
//   4. After a rate-limit signal the next attempt is DELAYED. Retrying
//      immediately is the definition of not cooperating with a limit.
//   5. After a rate-limit signal concurrency does not INCREASE. Backing off and
//      then immediately widening again is the same thing more slowly.
//   6. An item that came back UNREVIEWED (exit 2) is never shipped. Auto-merge
//      makes this the difference between a drain and an accident.
//   7. K consecutive failures halts the drain. A broken main must not become the
//      base for the rest of the night.
//   8. Concurrency never exceeds -j, and a -j above the ceiling is REFUSED
//      rather than silently clamped — the operator learns their number was not
//      honoured, instead of believing it was.
//
//   9.  A ship that returns glm-ship's REAL merged-but-unverified code (5) is
//       not counted as a failure. glm-ship exits 5 when given no -V; a driver
//       that reads that as failure merges every item and then halts the line
//       believing it failed.
//   10. Every attempt at an item gets its OWN branch. glm-task creates its
//       worktree with `git worktree add -b`, which cannot reuse a branch name,
//       so a retry on the same branch fails before the agent ever runs.
//   11. When the provider names a wait, THAT wait is honoured, not the shorter
//       configured base.
//   12. Once the line has halted, nothing further is shipped — including an
//       in-flight item that succeeds after the halt.
//   13. -n caps how many ITEMS are started, never how many attempts an item
//       gets. A retry the spec requires must not be eaten by the item cap.
//
// Rules 9-13 came from review, after this gate passed an implementation that
// would have failed on its first real run. They are all CONTRACT rules — the
// stub returns whatever it is told, so nothing here could see where the driver
// disagreed with the real glm-task and glm-ship until the stub was taught to
// speak their actual dialect. That is the lesson: a stub makes a gate fast and
// free, and blind to exactly the mismatches it is standing in for.
//
//   14. An item that SUCCEEDS is actually shipped, with -m and -R. Nothing in
//       rules 1-13 required the ship command to be called at all: an
//       implementation that marked successful items done and merged nothing
//       passed every one of them. A gate for a tool whose whole purpose is to
//       merge work must assert that it merges work.
//   15. Shipping is SERIALISED — never two at once, even at -j 4 — so CI for
//       the next item runs against a main that already contains the last.
//
// Rules 5, 6, 7 and 8 exist to forbid the wrong fixes: "scale" must not come to
// mean unbounded, "drain" must not come to mean merge-whatever-finished, and a
// stuck night must not merge its way through a broken main.
//
// A structural change this gate cannot read is a failure, not a pass.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fail = (msg) => { throw new Error(msg); };
const DRAIN = fileURLToPath(new URL('../bin/glm-drain', import.meta.url));
if (!existsSync(DRAIN)) fail('rule 0: bin/glm-drain does not exist');

let checks = 0;
const check = (ok, msg) => { checks++; if (!ok) fail(msg); };

/**
 * Run the drain over `items` with a stub glm-task whose exit code per item comes
 * from `codes` — a map of item id to either a code, or an array of codes
 * consumed one per attempt (so a requeue can succeed the second time).
 */
function drain({ items, codes, jobs = 2, extraArgs = [], shipCode = 0, asked = 0, slow = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'glm-drain-gate-'));
  const state = join(dir, 'state'); mkdirSync(state, { recursive: true });
  const log = join(dir, 'calls.tsv');
  const shipLog = join(dir, 'ship.tsv');
  writeFileSync(log, ''); writeFileSync(shipLog, '');

  // The stub. Records start and end with millisecond stamps — max overlap over
  // those intervals is the concurrency the driver actually used, which is the
  // only honest way to check it.
  const stub = join(dir, 'glm-task');
  writeFileSync(stub, `#!/usr/bin/env bash
item=""; BRANCH_ARG=""; prev=""
for a in "$@"; do
  case "$a" in ITEM=*) item="\${a#ITEM=}" ;; esac
  [ "$prev" = "-b" ] && BRANCH_ARG="$a"
  prev="$a"
done
echo "BRANCH\t$item\t$BRANCH_ARG" >> ${JSON.stringify(log)}
[ -z "$item" ] && item="$(echo "$*" | grep -oE 'issue[ -]?[0-9]+' | head -1)"
start=$(perl -MTime::HiRes=time -e 'printf "%.0f", time*1000')
# grep -c prints 0 and exits 1 on no match; a trailing || echo 0 appended a
# second zero and corrupted the attempt counter. Take grep own count.
n=$(grep -c "^START	$item	" ${JSON.stringify(log)} 2>/dev/null)
[ -z "$n" ] && n=0
echo "START	$item	$start	$n" >> ${JSON.stringify(log)}
code=$(${JSON.stringify(join(dir, 'code.sh'))} "$item" "$n")
sleep "$(${JSON.stringify(join(dir, 'slow.sh'))} "$item")"
end=$(perl -MTime::HiRes=time -e 'printf "%.0f", time*1000')
echo "END	$item	$end	$code" >> ${JSON.stringify(log)}
# What a real glm-task emits: the isolated worktree on the way in, and one
# machine-readable run line on the way out carrying the session id. A caller
# parks from these two, so the stub must produce them or the gate would demand
# something no correct implementation could supply.
if [ "$code" = "4" ]; then
  echo '{"level":"blocked","msg":"Which database should this use?"}' >&2
fi
if [ "$code" = "5" ]; then
  echo "glm-task: z.ai refused on capacity — this run was NOT attempted, retry later.\${ASKED_SUFFIX}" >&2
fi
echo "glm-task: isolated worktree=/tmp/glm-wt-stub-$item branch=$BRANCH_ARG" >&2
echo "glm-task: run dir=/tmp/glm-wt-stub-$item session=sess-$item-$n branch=$BRANCH_ARG" >&2
exit "$code"
`);
  chmodSync(stub, 0o755);

  // Per-item exit codes, attempt-aware.
  const codeSh = join(dir, 'code.sh');
  writeFileSync(codeSh, `#!/usr/bin/env bash
case "$1" in
${Object.entries(codes).map(([id, v]) => {
  const list = Array.isArray(v) ? v : [v];
  return `  ${id}) codes=(${list.join(' ')}) ;;`;
}).join('\n')}
  *) codes=(0) ;;
esac
i="$2"; [ "$i" -ge "\${#codes[@]}" ] && i=$(( \${#codes[@]} - 1 ))
echo "\${codes[$i]}"
`);
  chmodSync(codeSh, 0o755);

  // Per-item duration. Without this every attempt took the same 0.4s, so an
  // earlier item could never finish AFTER a later one — and the launch-order
  // race this exists to catch was unreproducible.
  const slowSh = join(dir, 'slow.sh');
  writeFileSync(slowSh, `#!/usr/bin/env bash
case "$1" in
${Object.entries(slow).map(([id, secs]) => `  ${id}) echo ${secs} ;;`).join('\n')}
  *) echo 0.4 ;;
esac
`);
  chmodSync(slowSh, 0o755);

  const shipStub = join(dir, 'glm-ship');
  writeFileSync(shipStub, `#!/usr/bin/env bash
echo "SHIP	start	$(perl -MTime::HiRes=time -e 'printf "%.0f", time*1000')	$*" >> ${JSON.stringify(shipLog)}
sleep 0.3
echo "SHIP	end	$(perl -MTime::HiRes=time -e 'printf "%.0f", time*1000')	$*" >> ${JSON.stringify(shipLog)}
exit ${shipCode}
`);
  chmodSync(shipStub, 0o755);

  let stdout = '', status = 0;
  try {
    stdout = execFileSync('bash', [DRAIN, '-j', String(jobs), '-I', items.join(','), ...extraArgs], {
      encoding: 'utf8', timeout: 90_000,
      env: {
        ...process.env,
        GLM_TASK_CMD: stub,
        GLM_SHIP_CMD: shipStub,
        GLM_DRAIN_STATE_DIR: state,
        GLM_DRAIN_BACKOFF_BASE: '1',   // seconds; production default is 60
        GLM_DRAIN_OFFLINE: '1',        // no gh, no network: items are ids only
        ASKED_SUFFIX: asked ? ` It asked for ${asked}s.` : '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    status = e.status ?? -1;
    stdout = (e.stdout ?? '') + (e.stderr ?? '');
  }

  const rows = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
  const branches = rows.filter((r) => r[0] === 'BRANCH');
  const starts = rows.filter((r) => r[0] === 'START');
  const ends = rows.filter((r) => r[0] === 'END');
  const parkedPath = join(state, 'parked.jsonl');
  const parked = existsSync(parkedPath)
    ? readFileSync(parkedPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } })
    : [];
  const shipRows = readFileSync(shipLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
  const shipped = shipRows.map((r) => r.join(' '));
  const shipSpans = shipRows.filter((r) => r[1] === 'start').map((st) => {
    const en = shipRows.find((e) => e[1] === 'end' && e[3] === st[3] && Number(e[2]) >= Number(st[2]));
    return { args: st[3] ?? '', from: Number(st[2]), to: en ? Number(en[2]) : Number(st[2]) + 300 };
  });

  // Max overlap across [start,end] intervals — the concurrency actually used.
  const spans = starts.map((s) => {
    const e = ends.find((x) => x[1] === s[1] && Number(x[2]) >= Number(s[2]));
    return { item: s[1], from: Number(s[2]), to: e ? Number(e[2]) : Number(s[2]) + 400 };
  });
  let peak = 0;
  for (const a of spans) {
    const n = spans.filter((b) => b.from < a.to && a.from < b.to).length;
    if (n > peak) peak = n;
  }
  return { stdout, status, starts, ends, spans, peak, parked, shipped, branches, shipSpans };
}

// ------------------------------------------------------------- rules 1 and 2
{
  const r = drain({ items: ['101', '102', '103'], codes: { 101: 4, 102: 0, 103: 0 } });
  const attempted = new Set(r.starts.map((s) => s[1]));
  check(attempted.has('102') && attempted.has('103'),
    `rule 1: item 101 blocked and the drain did not reach ${['102', '103'].filter((i) => !attempted.has(i)).join(' and ')}. A blocked item must park and the run continue — a parking that halts the drain is what this replaces (attempted: ${[...attempted].join(', ') || 'nothing'})`);
  const p = r.parked.find((x) => String(x.item ?? x.issue ?? '') === '101');
  check(p !== undefined,
    `rule 1: item 101 blocked and was not parked. Parked queue held: ${JSON.stringify(r.parked).slice(0, 200)}`);
  check(Boolean(p?.session_id) && Boolean(p?.worktree),
    `rule 2: the parked entry for 101 is missing ${!p?.session_id ? 'session_id' : 'worktree'} — without both, "parked" means "lost": glm-answer resumes a session id inside a worktree, and neither is recoverable later. Entry: ${JSON.stringify(p)}`);
}

// ------------------------------------------------------------- rules 3, 4, 5
{
  // 201 is throttled once, then succeeds. 202 and 203 are ordinary work.
  const r = drain({ items: ['201', '202', '203'], codes: { 201: [5, 0], 202: 0, 203: 0 }, jobs: 2 });
  const tries201 = r.starts.filter((s) => s[1] === '201').length;
  check(tries201 >= 2,
    `rule 3: item 201 was rate-limited and never retried (${tries201} attempt). Throttling says nothing about the change — the item must be requeued, not failed`);
  check(!r.parked.some((x) => String(x.item ?? x.issue ?? '') === '201' && /fail/i.test(JSON.stringify(x))),
    'rule 3: a rate-limited item was parked as failed. It was never attempted; recording it as failure burns work that did not happen');

  const first = r.starts.filter((s) => s[1] === '201').map((s) => Number(s[2]));
  const firstEnd = r.ends.find((e) => e[1] === '201');
  if (first.length >= 2 && firstEnd) {
    const gap = first[1] - Number(firstEnd[2]);
    check(gap >= 800,
      `rule 4: the retry after a rate limit came ${gap}ms after the refusal, with GLM_DRAIN_BACKOFF_BASE=1s. Retrying immediately is the definition of not cooperating with a rate limit`);
  }

  // After the refusal, nothing may run wider than before it.
  const refusedAt = Number(firstEnd?.[2] ?? 0);
  const after = r.spans.filter((s) => s.from > refusedAt);
  let peakAfter = 0;
  for (const a of after) {
    const n = after.filter((b) => b.from < a.to && a.from < b.to).length;
    if (n > peakAfter) peakAfter = n;
  }
  check(peakAfter <= 1,
    `rule 5: after a rate-limit signal the drain ran ${peakAfter} items at once. Concurrency must fall and stay fallen until the queue drains — backing off and immediately widening again is the same thing more slowly`);
}

// ------------------------------------------------------------------- rule 6
{
  const r = drain({ items: ['301', '302'], codes: { 301: 2, 302: 0 } });
  check(!r.shipped.some((l) => l.includes('301')),
    `rule 6: item 301 came back UNREVIEWED (exit 2) and was shipped anyway. With auto-merge on, this is the difference between a drain and an accident. Ship log: ${JSON.stringify(r.shipped).slice(0, 200)}`);
  check(r.parked.some((x) => String(x.item ?? x.issue ?? '') === '301'),
    'rule 6: an unreviewed item was neither shipped nor parked — it vanished, and nobody is told a change went unexamined');
}

// ------------------------------------------------------------------- rule 7
{
  const items = ['401', '402', '403', '404', '405'];
  const r = drain({ items, codes: { 401: 1, 402: 1, 403: 1, 404: 1, 405: 1 }, jobs: 1 });
  const attempted = new Set(r.starts.map((s) => s[1])).size;
  check(attempted < items.length,
    `rule 7: every one of ${items.length} items failed and the drain attempted all ${attempted} of them. Consecutive failures must stop the line — an unattended run that keeps going through a broken main spends the night making it worse`);
}

// ------------------------------------------------------------------- rule 8
{
  const r = drain({ items: ['501', '502', '503', '504'], codes: {}, jobs: 2 });
  check(r.peak <= 2,
    `rule 8: -j 2 was given and ${r.peak} items ran at once. The operator's number is a ceiling, not a suggestion`);

  const over = drain({ items: ['601'], codes: {}, jobs: 9 });
  check(over.status !== 0 && /refus|ceiling|maximum|too (high|many)/i.test(over.stdout),
    `rule 8: -j 9 was accepted. Above the ceiling it must be REFUSED, not silently clamped — an operator who believes they are running 9 wide and is actually running 4 has been told something untrue. Exit ${over.status}, output: ${JSON.stringify(over.stdout.slice(0, 200))}`);
}

// ------------------------------------------------------------------- rule 9
{
  // glm-ship's real behaviour with no -V: it merges, then exits 5 saying the
  // change is unverified. Two of those must not stop the line.
  const r = drain({ items: ['701', '702', '703'], codes: {}, shipCode: 5, jobs: 1 });
  const attempted = new Set(r.starts.map((s) => s[1])).size;
  check(attempted === 3,
    `rule 9: with glm-ship returning 5 (merged, unverified — what it really does when given no -V), the drain reached only ${attempted} of 3 items. Every item merged and the line halted believing they failed. Either pass -V, or treat 5 as merged-but-unverified; it is not failure`);
}

// ------------------------------------------------------------------ rule 10
{
  const r = drain({ items: ['801'], codes: { 801: [1, 0] }, jobs: 1 });
  const used = r.branches.filter((b) => b[1] === '801').map((b) => b[2]);
  check(used.length < 2 || new Set(used).size === used.length,
    `rule 10: item 801 was retried on the same branch (${used.join(', ')}). glm-task creates its worktree with 'git worktree add -b', which cannot reuse a branch name — the retry fails before the agent runs, and a required retry becomes an unrecoverable park`);
}

// ------------------------------------------------------------------ rule 11
{
  const r = drain({ items: ['901'], codes: { 901: [5, 0] }, jobs: 1, asked: 4 });
  const tries = r.starts.filter((s) => s[1] === '901').map((s) => Number(s[2]));
  const firstEnd = r.ends.find((e) => e[1] === '901');
  if (tries.length >= 2 && firstEnd) {
    const gap = tries[1] - Number(firstEnd[2]);
    check(gap >= 3500,
      `rule 11: z.ai asked for 4s and the retry came after ${gap}ms, with the configured base at 1s. When the provider names a wait, that number is the one to honour — using the shorter local default is not cooperating with it`);
  } else {
    check(false, 'rule 11: the rate-limited item was never retried, so the requested wait could not be checked');
  }
}

// ------------------------------------------------------------------ rule 12
{
  // 1002 and 1003 fail and halt the line; 1001 is slow and succeeds after.
  // The failures that establish HALT are SLOW; the later item that must not
  // ship is FAST. Without the launch-order barrier the fast one is applied
  // first and merges before the line has stopped.
  const r = drain({ items: ['1001', '1002', '1003', '1004'], codes: { 1002: 1, 1003: 1 },
                    jobs: 2, slow: { 1002: 3, 1003: 3, 1004: 0.1 } });
  // A 30x margin, not 16x. The first run of this case failed on a loaded
  // machine — two other agents were mid-delegation — and passed five times in
  // a row once they finished. A race check whose verdict depends on system
  // load is a flake, and a flaky gate gets ignored, which is worse than not
  // having it.
  const halted = /halt/i.test(r.stdout);
  if (halted) {
    check(!r.shipped.some((l) => l.includes('1004')),
      `rule 12: the line halted and item 1004 was shipped anyway. "Park everything remaining" has to include work already in flight, or the stop-the-line boundary leaks the very merges it exists to prevent. Ship log: ${JSON.stringify(r.shipped).slice(0, 200)}`);
  } else {
    check(false, `rule 12: two consecutive failures did not halt the line (rule 7 covers this too). Output: ${JSON.stringify(r.stdout.slice(0, 200))}`);
  }
}

// ------------------------------------------------------------------ rule 13
{
  const r = drain({ items: ['1101', '1102'], codes: { 1101: [1, 0] }, jobs: 1, extraArgs: ['-n', '1'] });
  const tries = r.starts.filter((s) => s[1] === '1101').length;
  check(tries >= 2,
    `rule 13: with -n 1, item 1101 failed and was never retried (${tries} attempt). -n caps how many ITEMS are started, not how many attempts one item gets — the retry is part of working the item, not a second item`);
}

// ------------------------------------------------------------ rules 14 & 15
{
  const r = drain({ items: ['1201', '1202', '1203', '1204'], codes: {}, jobs: 2 });
  check(r.shipSpans.length === 4,
    `rule 14: four items succeeded and ${r.shipSpans.length} were shipped. Nothing in rules 1-13 required the ship command to be called at all — an implementation that marked items done and merged nothing satisfied every one of them. A drain that does not merge is not a drain`);
  const missingFlags = r.shipSpans.filter((s) => !/-m\b/.test(s.args) || !/-R\b/.test(s.args));
  check(missingFlags.length === 0,
    `rule 14: ${missingFlags.length} ship invocation(s) lacked -m or -R. -m is the auto-merge this tool exists for; -R refuses to merge a PR with no checks at all, which is the last thing standing between an unattended run and merging something CI never saw. First: ${JSON.stringify(missingFlags[0]?.args ?? '')}`);

  let overlap = 0;
  for (const a of r.shipSpans) {
    const n = r.shipSpans.filter((b) => b.from < a.to && a.from < b.to).length;
    if (n > overlap) overlap = n;
  }
  check(overlap <= 1,
    `rule 15: ${overlap} ship commands overlapped. Merges must serialise so CI for the next item runs against a main containing the last — parallel merges are how item 7 gets tested against a main that does not yet have item 3 in it`);
}

console.log(`verify-drain: ${checks} checks passed`);

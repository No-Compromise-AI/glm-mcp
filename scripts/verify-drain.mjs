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
function drain({ items, codes, jobs = 2, extraArgs = [], shipCode = 0 }) {
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
item=""; for a in "$@"; do case "$a" in ITEM=*) item="\${a#ITEM=}" ;; esac; done
[ -z "$item" ] && item="$(echo "$*" | grep -oE 'issue[ -]?[0-9]+' | head -1)"
start=$(perl -MTime::HiRes=time -e 'printf "%.0f", time*1000')
n=$(grep -c "^START	$item	" ${JSON.stringify(log)} 2>/dev/null || echo 0)
echo "START	$item	$start	$n" >> ${JSON.stringify(log)}
code=$(${JSON.stringify(join(dir, 'code.sh'))} "$item" "$n")
sleep 0.4
end=$(perl -MTime::HiRes=time -e 'printf "%.0f", time*1000')
echo "END	$item	$end	$code" >> ${JSON.stringify(log)}
if [ "$code" = "4" ]; then
  echo '{"level":"blocked","msg":"Which database should this use?"}' >&2
fi
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

  const shipStub = join(dir, 'glm-ship');
  writeFileSync(shipStub, `#!/usr/bin/env bash
echo "SHIP	$*" >> ${JSON.stringify(shipLog)}
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
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    status = e.status ?? -1;
    stdout = (e.stdout ?? '') + (e.stderr ?? '');
  }

  const rows = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
  const starts = rows.filter((r) => r[0] === 'START');
  const ends = rows.filter((r) => r[0] === 'END');
  const parkedPath = join(state, 'parked.jsonl');
  const parked = existsSync(parkedPath)
    ? readFileSync(parkedPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } })
    : [];
  const shipped = readFileSync(shipLog, 'utf8').trim().split('\n').filter(Boolean);

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
  return { stdout, status, starts, ends, spans, peak, parked, shipped };
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

console.log(`verify-drain: ${checks} checks passed`);

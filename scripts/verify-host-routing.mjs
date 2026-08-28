// verify-host-routing.mjs — acceptance gate for which reviewers a delegation
// gets, given the agent that is driving it (#65).
//
// The delegate → review loop is only worth running because the reviewer is a
// DIFFERENT vendor's model than the one that wrote the code. Until now the
// reviewer default was the literal string "codex", chosen when Claude was the
// only host that existed. Run that same default from inside Codex and Codex
// reviews work it is itself supervising — the independence the loop is built on
// is gone, silently, with every surface still reporting a clean review.
//
// So the reviewer set has to be a function of the host. This gate is written as
// RULES about that function rather than as a table of expected answers, because
// a table of answers is a second copy of the thing under test and drifts from
// it. The pool is read from the implementation; the hosts are derived from the
// pool. Add a fourth agent tomorrow and these rules cover it without being
// edited.
//
//   1. `auto` NEVER contains the host. This is the whole point; every other
//      rule exists to stop it being satisfied trivially.
//   2. `auto` is EXACTLY the pool minus the host — so rule 1 cannot be met by
//      dropping reviewers, which would quietly narrow review coverage.
//   3. `all` is EXACTLY the pool, host included, for every host. This forbids
//      the wrong fix: making the host-exclusion global would leave no way to
//      ask for a full panel, and "all" that silently isn't all is a lie the
//      caller cannot see.
//   4. An explicit list passes through untouched whatever the host is. The
//      operator overrides the policy; the policy never overrides the operator.
//   5. With no host known, `auto` still yields a NON-EMPTY set and says on
//      stderr that it is guessing. An unknown host must degrade to reviewed-by-
//      something, never to silently-unreviewed.
//   6. Only `none` ever resolves to the empty set. Any other spelling that
//      yields nothing is code shipping unreviewed while the caller believes a
//      reviewer ran — the exact failure this gate exists to prevent.
//
// A structural change this gate cannot read is a failure, not a pass.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openSync, readFileSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fail = (msg) => { throw new Error(msg); };
const SHIM = fileURLToPath(new URL('../bin/_glm-hosts.sh', import.meta.url));

// Ask the implementation, rather than restating it. `execFileSync` only hands
// back e.stderr when the child FAILS, so a succeeding call's stderr is captured
// through a real fd and read back — the idiom the other gates in this repo use.
function resolve(spec, host) {
  const errPath = join(tmpdir(), `glm-host-routing-${process.pid}-${Math.abs(spec.length * 31 + (host || '').length)}.err`);
  const fd = openSync(errPath, 'w');
  let stdout;
  try {
    stdout = execFileSync('bash', ['-c', `set -uo pipefail; source "$1"; glm_resolve_reviewers "$2"`, '_', SHIM, spec], {
      env: { ...process.env, GLM_HOST: host ?? '', CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', fd],
    });
  } finally {
    closeSync(fd);
  }
  const stderr = readFileSync(errPath, 'utf8');
  unlinkSync(errPath);
  return { list: stdout.trim().split(/\s+/).filter(Boolean), stderr };
}

const eq = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
const show = (a) => a.length ? a.join(',') : '(empty)';

// ------------------------------------------------------------------ the pool
// Read from the implementation. `all` is its own declaration of the full set,
// and every host is drawn from it — a reviewer you can sit inside is a host.
const POOL = resolve('all', 'claude').list;
if (POOL.length < 2) fail(`the reviewer pool is ${show(POOL)}; a pool under two cannot exclude a host and still review anything`);
const HOSTS = POOL;

let checks = 0;
const check = (ok, msg) => { checks++; if (!ok) fail(msg); };

for (const host of HOSTS) {
  const auto = resolve('auto', host).list;

  // 1 — the core property.
  check(!auto.includes(host),
    `rule 1: from host "${host}", auto resolved to ${show(auto)}, which includes the host itself — the reviewer would be reviewing its own session's work`);

  // 2 — met by exclusion, not by attrition.
  const expected = POOL.filter((r) => r !== host);
  check(eq(auto, expected),
    `rule 2: from host "${host}", auto resolved to ${show(auto)} but the pool minus the host is ${show(expected)} — rule 1 must be satisfied by excluding the host, not by dropping reviewers`);

  // 3 — `all` still means all.
  const all = resolve('all', host).list;
  check(eq(all, POOL),
    `rule 3: from host "${host}", all resolved to ${show(all)} rather than the full pool ${show(POOL)} — host exclusion must not leak into an explicit request for every reviewer`);

  // 4 — the operator overrides the policy.
  const explicit = POOL.slice(0, 2);
  const got = resolve(explicit.join(','), host).list;
  check(eq(got, explicit),
    `rule 4: from host "${host}", an explicit "${explicit.join(',')}" resolved to ${show(got)} — an explicit list must pass through untouched`);

  // 6 — only `none` is empty.
  check(resolve('none', host).list.length === 0,
    `rule 6: from host "${host}", none resolved to ${show(resolve('none', host).list)} rather than the empty set`);
  check(auto.length > 0 && all.length > 0,
    `rule 6: from host "${host}", a non-none spelling resolved to the empty set — that ships unreviewed code while reporting a reviewer ran`);
}

// 5 — an unknown host degrades loudly, never to silence.
const unknown = resolve('auto', '');
check(unknown.list.length > 0,
  `rule 5: with no host known, auto resolved to ${show(unknown.list)} — an unknown host must still be reviewed by something`);
check(/host/i.test(unknown.stderr),
  `rule 5: with no host known, auto resolved to ${show(unknown.list)} without saying so on stderr; it must state that it is guessing (stderr was ${JSON.stringify(unknown.stderr.trim())})`);

console.log(`verify-host-routing: ${checks} checks passed over pool ${show(POOL)} and hosts ${show(HOSTS)}`);

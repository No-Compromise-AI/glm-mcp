// verify-assumption.mjs — acceptance gate for #76 (with #79 folded in): the
// level below `scope`, and the reviewer quorum that does not depend on my
// judgement being right.
//
// THE FINDING #76 RESTS ON. Both security regressions of that session came from
// ambiguous sentences in a spec I wrote, and neither was caught by the gate,
// because I wrote the gate and the spec in the same words on the same
// afternoon — correlated oracles, not independent ones. In 33 runs there were
// five escalations, all `scope`, all five correct. Five-for-five is not a
// calibrated detector; it is a detector set to fire only on certainty.
//
// The mechanism, in the implementer's own words: "By the time I'm writing code,
// 'normalise before comparing' has already collapsed into one specific reading.
// The fork left no artifact in my context. You can't escalate a coin flip you
// don't remember flipping."
//
// WHAT THIS DOES NOT DO, and why. A previous session considered and REJECTED a
// mandatory ambiguity log: it asks an implementer to report forks it never
// experienced as forks, and invites compliance without insight. So nothing here
// requires a note per run, and no rule counts them. What is required is that
// the channel exists, costs nothing to use, and cannot interrupt anyone — and
// that the part which does NOT depend on the implementer noticing anything
// (the reviewer quorum) is available.
//
// A level already half-existed: `decision`, which glm-notes renders as
// "ASSUMPTION". It was unreachable in practice because the standing prompt says
// "Default to silence" and lists routine choices as explicitly not notable,
// which is exactly what a resolved ambiguity feels like from the inside. The
// fix is therefore mostly about the instruction, not a new mechanism.
//
// RULES
//   1. `assumption` is an accepted level and reaches the ledger.
//   2. It NEVER interrupts: not surfaced live like blocked/scope/discovery, not
//      in the default notify levels, and it does not change the run's exit
//      status. A channel that costs attention will not be used under completion
//      pressure, which is what the five-in-thirty-three number measures.
//   3. `decision`, the spelling the prompt used before, still works. Old logs
//      and any agent still carrying the old instruction must not silently
//      produce notes that go nowhere.
//   4. The standing instruction asks for it SPECIFICALLY — a sentence resolved
//      more than one way, and the reading chosen — and exempts this level from
//      "default to silence". Leaving the level in place under an instruction
//      that discourages it is what produced five-for-five.
//   5. `--security` requires a QUORUM: one reviewer delivering a pass is not a
//      pass. This is the half that does not depend on anyone noticing an
//      ambiguity, which is why it was the part accepted.
//   6. Under `--security`, two reviewers agreeing IS a pass.
//   7. FORBID THE WRONG FIX: without `--security`, one reviewer still passes.
//      Making every review need two would satisfy rule 5 and break the loop.
//   8. FORBID THE WRONG FIX: under `--security`, two reviewers where one wants
//      changes is not a pass. A quorum counts agreement, not turnout.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fail = (msg) => { throw new Error(msg); };
const BIN = fileURLToPath(new URL('../bin', import.meta.url));
let checks = 0;
const check = (ok, msg) => { checks++; if (!ok) fail(msg); };

/** Run glm-task with a worker that writes `note` to the notes channel. */
function task({ level = null, msg = 'the spec could be read two ways; I took the narrower one' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'glm-assumption-gate-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  for (const f of ['glm-task', '_glm-hosts.sh', '_glm-capacity.sh']) {
    copyFileSync(join(BIN, f), join(bin, f)); chmodSync(join(bin, f), 0o755);
  }
  const note = level === null ? '' :
    `printf '%s\\n' '{"level":"${level}","msg":"${msg}"}' >> "$GLM_NOTES"\n`;
  writeFileSync(join(bin, 'glm-worker'), `#!/usr/bin/env bash
${note}printf 'work' > "$GATE_REPO/feature.txt"
git -C "$GATE_REPO" -c user.email=a@e.invalid -c user.name=a add -A >/dev/null
git -C "$GATE_REPO" -c user.email=a@e.invalid -c user.name=a commit -qm "agent" >/dev/null
echo '{"type":"result","subtype":"success","is_error":false,"session_id":"s","num_turns":2,"duration_ms":5,"result":"ok"}'
exit 0
`);
  chmodSync(join(bin, 'glm-worker'), 0o755);

  const repo = join(dir, 'repo'); mkdirSync(repo);
  const g = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.email=g@e.invalid', '-c', 'user.name=g', ...a], { encoding: 'utf8' });
  g('init', '-q', '.'); g('commit', '-q', '--allow-empty', '-m', 'base');

  const ledger = join(dir, 'ledger.jsonl');
  const r = spawnSync('bash', [join(bin, 'glm-task'), '-C', repo, '-r', 'none', 'do it'], {
    encoding: 'utf8', timeout: 120_000,
    env: {
      ...process.env, HOME: dir, GATE_REPO: repo,
      GLM_TASK_LEDGER: ledger, GLM_TASK_LOG: join(dir, 'run.jsonl'),
      GLM_NOTES: join(dir, 'notes.jsonl'), GLM_NOTIFY_LEVELS: 'none',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let row = null;
  if (existsSync(ledger)) {
    const lines = readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length) row = JSON.parse(lines[lines.length - 1]);
  }
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, row };
}

// Rule 1 — it reaches the ledger.
const a = task({ level: 'assumption' });
check(a.row?.notes?.some?.((n) => n.level === 'assumption'),
  `rule 1: an 'assumption' note must reach the ledger. Row notes: ${JSON.stringify(a.row?.notes)}`);

// Rule 2 — and costs nothing.
check(a.status === 0,
  `rule 2: an assumption note must not change the run's outcome; glm-task exited ${a.status}. ` +
  'A level that can fail a run is a level nobody will use.');
check(!/>>> GLM \[assumption\]/.test(a.out),
  `rule 2: it must not be surfaced live like blocked/scope/discovery — that is attention, and a ` +
  `channel that costs attention goes unused under completion pressure. It printed:\n${a.out.slice(-500)}`);
{
  const src = readFileSync(join(BIN, 'glm-task'), 'utf8');
  const m = src.match(/NOTIFY_LEVELS="\$\{GLM_NOTIFY_LEVELS:-([^}]*)\}"/);
  check(m && !/assumption|decision/.test(m[1]),
    `rule 2: the default notify levels must not include it; they are ${JSON.stringify(m && m[1])}. ` +
    'Only blocked earns an interruption — it halts the agent.');
}

// Rule 3 — the older spelling still lands.
const d = task({ level: 'decision' });
check(d.row?.notes?.some?.((n) => n.level === 'decision'),
  `rule 3: 'decision', the spelling the prompt used before, must still reach the ledger. ` +
  `An agent still carrying the old instruction must not produce notes that go nowhere. ` +
  `Row notes: ${JSON.stringify(d.row?.notes)}`);

// Rule 4 — the instruction actually asks for it.
{
  const src = readFileSync(join(BIN, 'glm-task'), 'utf8');
  const esc = src.slice(src.indexOf('ESCALATION='), src.indexOf('ESCALATION=') + 4000);
  check(/assumption/.test(esc),
    'rule 4: the standing instruction must name the level. A level the prompt never mentions is a ' +
    'level nobody uses.');
  check(/more than one way|two ways|ambiguit|resolved/i.test(esc),
    'rule 4: it must ask for the specific thing — a sentence that could be read more than one way, ' +
    'and the reading chosen. "Log your assumptions" is the instruction that produced five in ' +
    'thirty-three.');
  check(/(?:exempt|even though|despite|does not apply|not.{0,20}silence)/i.test(esc),
    'rule 4: it must exempt this level from "Default to silence" explicitly. The surrounding prompt ' +
    'tells the agent that routine choices are not notable, which is exactly what a resolved ' +
    'ambiguity feels like from the inside — so the exemption is the whole mechanism.');
}

// ---------------------------------------------------------------------------
// Rules 5-8 — the reviewer quorum.
function review({ security = false, verdicts = ['PASS'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'glm-quorum-gate-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  for (const f of ['glm-review', '_glm-hosts.sh', '_glm-capacity.sh']) {
    copyFileSync(join(BIN, f), join(bin, f)); chmodSync(join(bin, f), 0o755);
  }
  const names = ['codex', 'claude', 'agy'];
  const body = 'A review with enough substance to clear the rubber-stamp floor. '.repeat(6);
  names.forEach((n, i) => {
    const v = verdicts[i];
    // A reviewer with no verdict assigned is simply absent (out of capacity).
    writeFileSync(join(bin, n), v
      ? `#!/usr/bin/env bash\ncat <<'E'\n${body}\nVERDICT: ${v}\nE\nexit 0\n`
      : '#!/usr/bin/env bash\necho "429 rate limit exceeded"\nexit 0\n');
    chmodSync(join(bin, n), 0o755);
  });
  const repo = join(dir, 'repo'); mkdirSync(repo);
  const g = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.email=g@e.invalid', '-c', 'user.name=g', ...a], { encoding: 'utf8' });
  g('init', '-q', '.'); g('commit', '-q', '--allow-empty', '-m', 'base');
  const base = g('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(join(repo, 'f.txt'), 'change'); g('add', '-A'); g('commit', '-q', '-m', 'the change');
  const spec = join(dir, 'spec.txt'); writeFileSync(spec, 'the spec');

  const asked = names.filter((_, i) => verdicts[i] !== undefined || i < verdicts.length);
  const r = spawnSync('bash', [join(bin, 'glm-review'), '-C', repo, '-b', base, '-s', spec,
    '-r', names.slice(0, Math.max(verdicts.length, 1)).join(','), ...(security ? ['-S'] : [])], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir, GLM_HOST: 'glm' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, asked };
}

// Rule 5 — one delivering reviewer is not a quorum.
{
  const r = review({ security: true, verdicts: ['PASS', undefined, undefined] });
  check(r.status !== 0,
    `rule 5: under --security, ONE reviewer passing is not a pass; glm-review exited ${r.status}. ` +
    'This is the half that does not depend on anyone noticing an ambiguity, which is why it was ' +
    `the part accepted. It said:\n${r.out.slice(-600)}`);
  check(/quorum|second reviewer|only one/i.test(r.out),
    `rule 5: it must say WHY it is not a pass. It said:\n${r.out.slice(-600)}`);
}

// Rule 6 — two agreeing reviewers are.
{
  const r = review({ security: true, verdicts: ['PASS', 'PASS'] });
  check(r.status === 0,
    `rule 6: under --security, two reviewers agreeing must pass; exited ${r.status}.\n${r.out.slice(-600)}`);
}

// Rule 7 — FORBID THE WRONG FIX: the default is unchanged.
{
  const r = review({ security: false, verdicts: ['PASS'] });
  check(r.status === 0,
    `rule 7: WITHOUT --security a single reviewer must still pass; exited ${r.status}. Making every ` +
    `review need two satisfies rule 5 and breaks the loop for every ordinary change.\n${r.out.slice(-600)}`);
}

// Rule 8 — FORBID THE WRONG FIX: a quorum counts agreement, not turnout.
{
  const r = review({ security: true, verdicts: ['PASS', 'CHANGES_REQUIRED'] });
  check(r.status === 1,
    `rule 8: two reviewers where one wants changes is not a pass; exited ${r.status}. A quorum that ` +
    'counted turnout rather than agreement would call this reviewed and approved.');
}

console.log(`ASSUMPTION OK (${checks} checks)`);

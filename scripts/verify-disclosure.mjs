// verify-disclosure.mjs — acceptance gate for what the caller is told (#26,
// and the half of #28 that is not the throw).
//
// The caller of glm_ask is the untrusted party. It should learn what it needs
// to fix its own request and nothing about the machine the server runs on.
// Three things crossed that line:
//
//   * resolveApiKey read the key file outside a try/catch, so an EACCES
//     carried the file's absolute path — and with it the account's home
//     directory and username — out through the tool result;
//   * `skipped (not found)` and `skipped (unreadable)` distinguished a path
//     that does not exist from one that does but cannot be read, which is an
//     existence-and-permission oracle for anything inside the roots;
//   * an uncompilable pattern quoted V8's own message at the caller.
//
// What must NOT change: a refusal still names the spelling the CALLER used.
// That is the caller's own argument coming back to it, not disclosure, and
// removing it would reintroduce the silent narrowing #13's notes exist to
// prevent. This gate asserts both halves so a fix cannot overshoot into one.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (msg) => { throw new Error(msg); };
const GLM = pathToFileURL(new URL('../dist/glm.js', import.meta.url).pathname).href;

function child(body, env = {}, timeoutMs = 20_000) {
  const src = `
import * as glm from ${JSON.stringify(GLM)};
const out = {};
try {
${body}
} catch (e) {
  out.threw = String(e && e.message ? e.message : e);
}
process.stdout.write(JSON.stringify(out));
`;
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (/^(GLM_MCP_|ZAI_)/.test(k)) delete childEnv[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = String(v);
  }
  let out;
  try {
    out = execFileSync(process.execPath, ['--input-type=module', '-e', src],
      { encoding: 'utf8', env: childEnv, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (e.killed) fail(`a case did not return within ${timeoutMs}ms`);
    fail(`child failed\n${e.stderr || e.message}`);
  }
  try { return JSON.parse(out); } catch { return fail(`unparsable child output: ${out}`); }
}

const ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-disc-')));
const HOME = join(ROOT, 'home');
const WORK = join(ROOT, 'work');
const secrets = [HOME, homedir(), userInfo().username].filter((s) => s && s.length > 2);
const leaks = (text) => secrets.find((s) => text.includes(s));

try {
  mkdirSync(join(HOME, '.config', 'zai'), { recursive: true });
  mkdirSync(WORK, { recursive: true });
  const keyFile = join(HOME, '.config', 'zai', 'api-key');
  writeFileSync(keyFile, 'SECRET-KEY-VALUE');
  chmodSync(keyFile, 0o000);   // present, and unreadable

  writeFileSync(join(WORK, 'readable.txt'), 'READABLE-BODY');
  const locked = join(WORK, 'locked.txt');
  writeFileSync(locked, 'LOCKED-BODY');
  chmodSync(locked, 0o000);

  // ------------------------------------------- 1. the key file's own path
  // Running as root defeats the fixture: chmod 000 does not stop uid 0, the
  // read succeeds and there is no EACCES to test. Say so rather than pass.
  const probe = child(`out.key = glm.resolveApiKey();`, { HOME, USERPROFILE: HOME });
  if (probe.key === 'SECRET-KEY-VALUE') {
    fail('the fixture did not deny the read (running as root?) — this gate cannot verify #26 here');
  }
  if (!probe.threw) fail(`resolveApiKey neither returned a key nor failed — ${JSON.stringify(probe)}`);
  const where = leaks(probe.threw);
  if (where) {
    fail(`#26: the error a caller sees names ${JSON.stringify(where)} — the account's own home or username. Say the key file could not be read; keep the path on stderr.\n  ${probe.threw}`);
  }
  // Useless-but-safe is not the goal either: it still has to be actionable.
  if (!/key/i.test(probe.threw)) {
    fail(`#26: the message must still say what went wrong — got ${JSON.stringify(probe.threw)}`);
  }

  // --------------------------------------- 2. existence is not distinguishable
  // A caller inside the roots must not be able to tell "no such file" from
  // "exists, cannot read": both are reasons it gets nothing, and the
  // difference is the server's business.
  const notes = (paths) => child(`
process.env.GLM_MCP_ROOTS = ${JSON.stringify(WORK)};
out.notes = glm.buildFileContext(${JSON.stringify(paths)}, ${JSON.stringify(WORK)}).notes;
out.text = glm.buildFileContext(${JSON.stringify(paths)}, ${JSON.stringify(WORK)}).text;`);

  const absent = notes(['no-such-file.txt']);
  const unreadable = notes(['locked.txt']);
  if (unreadable.text.includes('LOCKED-BODY')) {
    fail('the fixture did not deny the read (running as root?) — this gate cannot verify the oracle here');
  }
  const shape = (ns, name) => ns.map((n) => n.split(name).join('<PATH>'));
  const a = shape(absent.notes, 'no-such-file.txt');
  const u = shape(unreadable.notes, 'locked.txt');
  if (JSON.stringify(a) !== JSON.stringify(u)) {
    fail(`#26: a missing file and an unreadable one are told apart by their notes — an existence and permission oracle:\n  missing:    ${JSON.stringify(absent.notes)}\n  unreadable: ${JSON.stringify(unreadable.notes)}`);
  }
  // The note must still name the caller's own spelling: that is its argument
  // coming back, and dropping it is how a caller stops knowing what was
  // skipped.
  if (!absent.notes.some((n) => n.includes('no-such-file.txt'))) {
    fail(`#26 overshoot: the note must still name the path the caller asked for — ${JSON.stringify(absent.notes)}`);
  }

  // The same probe through a GLOB. A pattern can be spelled to match exactly
  // one name — `secret[.]txt` — so if a matched-but-unreadable file reports
  // differently from a pattern that matched nothing, the oracle survives the
  // literal fix. The requirement is not one shared phrasing across literals
  // and patterns (a caller knows which it used); it is that WITHIN each kind,
  // absent and unreadable are the same answer.
  const gAbsent = notes(['absent[.]txt']);
  const gLocked = notes(['locked[.]txt']);
  const gA = shape(gAbsent.notes, 'absent[.]txt');
  const gL = shape(gLocked.notes, 'locked[.]txt');
  if (JSON.stringify(gA) !== JSON.stringify(gL)) {
    fail(`#26: a glob spelled to match one name tells a missing file from an unreadable one:\n  missing:    ${JSON.stringify(gAbsent.notes)}\n  unreadable: ${JSON.stringify(gLocked.notes)}`);
  }
  if (gLocked.text.includes('LOCKED-BODY')) fail('the glob read a file it should not have');

  // The general property, rather than another instance of it. Which branch
  // handles an entry — literal or pattern — is itself decided by whether the
  // file EXISTS (namesSomething), so any difference in what the two branches
  // report leaks the thing the branch was chosen by. Two rounds of fixes each
  // closed one spelling and left the next: a name made of metacharacters, then
  // a pattern and its literal twin in one call, where de-duplication changed
  // which note survived and in what order.
  //
  // So: for the SAME argument list, the notes a caller sees must be identical
  // whether the named file is absent or present-and-unreadable. Nothing else
  // is a stable place to stop.
  const oracleProbe = (present, paths) => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-oracle-')));
    try {
      if (present) {
        writeFileSync(join(dir, 'probe[.]txt'), 'S');
        writeFileSync(join(dir, 'probe.txt'), 'S');
        chmodSync(join(dir, 'probe[.]txt'), 0o000);
        chmodSync(join(dir, 'probe.txt'), 0o000);
      }
      writeFileSync(join(dir, 'decoy.txt'), 'DECOY');
      const r = child(`
process.env.GLM_MCP_ROOTS = ${JSON.stringify(dir)};
const c = glm.buildFileContext(${JSON.stringify(paths)}, ${JSON.stringify(dir)});
out.notes = c.notes; out.text = c.text;`);
      return r;
    } finally {
      for (const f of ['probe[.]txt', 'probe.txt']) {
        try { chmodSync(join(dir, f), 0o600); } catch { /* absent */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };

  for (const paths of [
    ['probe.txt'],
    ['probe[.]txt'],
    ['probe[.]txt', 'probe.txt'],
    ['probe.txt', 'probe[.]txt'],
    ['decoy.txt', 'probe[.]txt'],
    ['probe*.txt'],
  ]) {
    const yes = oracleProbe(true, paths);
    const no = oracleProbe(false, paths);
    if (yes.text.includes('S')) fail(`the fixture leaked an unreadable body for ${JSON.stringify(paths)}`);
    if (JSON.stringify(yes.notes) !== JSON.stringify(no.notes)) {
      fail(`#26: ${JSON.stringify(paths)} tells a caller whether the file exists:\n  present, unreadable: ${JSON.stringify(yes.notes)}\n  absent:              ${JSON.stringify(no.notes)}`);
    }
  }

  // A good file beside a skipped one is still read.
  const mixed = notes(['locked.txt', 'readable.txt']);
  if (!mixed.text.includes('READABLE-BODY')) {
    fail(`a skipped file must not take its neighbour down — ${JSON.stringify(mixed)}`);
  }

  // ------------------- 2b. a key that exists but cannot be reached
  // existsSync() is false when an ANCESTOR directory is unsearchable, so the
  // guarded read is never attempted: the operator gets no diagnostic, and the
  // caller is told no key is configured when one is — it simply cannot be
  // reached. Absent and unreachable are different problems with different
  // fixes, and telling them apart is the operator's business, not the
  // caller's, so the distinction belongs on stderr and the caller gets the
  // same guarded message either way.
  chmodSync(join(HOME, '.config'), 0o000);
  let blocked;
  try {
    blocked = child(`out.key = glm.resolveApiKey();`, { HOME, USERPROFILE: HOME });
  } finally {
    chmodSync(join(HOME, '.config'), 0o700);
  }
  if (blocked.key) fail('the fixture did not deny the traversal (running as root?) — this case cannot be verified here');
  if (!blocked.threw) fail(`resolveApiKey must fail when the key cannot be reached — ${JSON.stringify(blocked)}`);
  if (/no .*key found/i.test(blocked.threw)) {
    fail(`#26: a key file that exists but cannot be reached is reported as absent. The caller is sent to create a key it already has:\n  ${blocked.threw.split('\n')[0]}`);
  }
  if (leaks(blocked.threw)) {
    fail(`#26: the unreachable-key message leaks a path — ${blocked.threw.split('\n')[0]}`);
  }

  // ------------------------------- 3. our words, not the regex engine's (#28)
  const bad = notes(['[z-a].txt', 'readable.txt']);
  const note = bad.notes.find((n) => n.includes('[z-a].txt'));
  if (!note) fail(`an uncompilable pattern must still be reported by name — ${JSON.stringify(bad.notes)}`);
  for (const engine of ['Invalid regular expression', 'Range out of order', 'SyntaxError']) {
    if (note.includes(engine)) {
      fail(`#28: the note quotes the regex engine at the caller (${JSON.stringify(engine)}) — say the pattern is malformed in our own words:\n  ${note}`);
    }
  }
  if (!/malformed|invalid|cannot|could not/i.test(note)) {
    fail(`#28: the note must still say the pattern is unusable — ${JSON.stringify(note)}`);
  }
  if (!bad.text.includes('READABLE-BODY')) {
    fail(`a good file beside an uncompilable pattern must still be read — ${JSON.stringify(bad.text)}`);
  }

  // ------------------------------------ 4. the confinement notes are untouched
  // #13's contract: a refused path names the caller's spelling so it can tell
  // which of its arguments was dropped. Genericising these would undo it.
  const outside = child(`
process.env.GLM_MCP_ROOTS = ${JSON.stringify(WORK)};
out.notes = glm.buildFileContext(['../home/.config/zai/api-key'], ${JSON.stringify(WORK)}).notes;`);
  if (!outside.notes.some((n) => /refused/i.test(n) && n.includes('../home/.config/zai/api-key'))) {
    fail(`#26 overshoot: a refusal must still name the caller's own spelling — ${JSON.stringify(outside.notes)}`);
  }
} finally {
  try { chmodSync(join(HOME, '.config', 'zai', 'api-key'), 0o600); } catch { /* best effort */ }
  try { chmodSync(join(WORK, 'locked.txt'), 0o600); } catch { /* best effort */ }
  rmSync(ROOT, { recursive: true, force: true });
}

console.log('DISCLOSURE OK');

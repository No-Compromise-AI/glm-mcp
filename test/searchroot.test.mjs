// The #67 note: telling "nothing matched" from "we looked somewhere else".
// A server started in the wrong directory answers a project-relative pattern
// with `skipped (no matches): src/**/*.ts`, which reads as "the model had
// nothing to say about those files" when the fact is the search ran wherever
// the HOST launched the server. The remedy sentence that follows the no-match
// says so — when, and only when, the caller supplied no `cwd` of its own.
//
// Everything here runs in a child of its own, as the environment-shaped cases
// across this suite do: the undefined `cwd` argument resolves to the process's
// own working directory, and the default roots are read from it at module
// load, so the child has to be BORN in the directory standing in for the
// launch directory for either to mean what the note turns on.
//
// Properties beyond the gate's rules, most caught in review:
//   - the note's remedies are companions, not alternatives — `cwd` moves the
//     search and `GLM_MCP_ROOTS` widens what it may resolve inside; roots
//     alone leave the search where it ran, and a cwd outside the roots is
//     refused outright;
//   - the sentence belongs to a call that DELIVERED NOTHING, whatever notes
//     its individual arguments owe. A duplicate beside its own delivered
//     match, a pattern no-match beside content that arrived — those keep the
//     plain no-match and lose the sentence, because "this argument matched
//     nothing" is not "this call found nothing", and only the second says the
//     search ran somewhere the caller never meant. A missing literal and a
//     range past the end of a found file never carry it either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const GLM = pathToFileURL(new URL('../dist/glm.js', import.meta.url).pathname).href;
const HINT = /no cwd was supplied, so the search ran in the directory this server was started in/;

// buildFileContext in a child whose own working directory is `dir`, with the
// `cwd` ARGUMENT absent — the undefined-ness is the fact the note turns on, so
// it cannot be faked from a parent that has its own working directory. The
// string-cwd variant is the same child with the argument present, which is
// the only difference between rule 1 and rule 2 of the gate.
function ctx(paths, dir, cwd) {
  const src = `
import { buildFileContext } from ${JSON.stringify(GLM)};
const c = buildFileContext(${JSON.stringify(paths)}, ${JSON.stringify(cwd)});
process.stdout.write(JSON.stringify({ text: c.text, notes: c.notes }));`;
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (/^(GLM_MCP_|ZAI_)/.test(k)) delete childEnv[k];
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', src],
    { encoding: 'utf8', env: childEnv, cwd: dir, timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

// A directory standing in for "wherever the host launched the server", with a
// file the launch directory itself does contain — the caller's pattern is
// project-relative and matches nothing HERE.
async function launchDir() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-searchroot-')));
  writeFileSync(join(dir, 'present.md'), 'found where the search ran\n');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Whether chmod 000 actually denies a read here — completeness.test.mjs's
// deniesRead, same stance: probing the denial beats reading the uid, which
// says nothing about the filesystem's answer.
const deniesRead = (path) => {
  chmodSync(path, 0o000);
  try {
    readFileSync(path, 'utf8');
    return false;
  } catch {
    return true;
  }
};

test('a pattern matching nothing with no cwd is told where the search ran', async (t) => {
  const { dir, cleanup } = await launchDir();
  t.after(cleanup);
  const { notes } = ctx(['src/**/*.ts'], dir);
  assert.deepEqual(notes, [
    'skipped (no matches): src/**/*.ts',
    'no cwd was supplied, so the search ran in the directory this server was started in — ' +
    'pass cwd to search the directory you mean; where that directory lies outside the ' +
    'allowed roots, GLM_MCP_ROOTS must be widened to include it as well: cwd alone is ' +
    'refused there, and GLM_MCP_ROOTS alone does not move the search',
  ]);
});

test('the note names its remedies as companions, never as alternatives', async (t) => {
  const { dir, cleanup } = await launchDir();
  t.after(cleanup);
  const hint = ctx(['src/**/*.ts'], dir).notes.find((n) => HINT.test(n));
  assert.ok(hint, 'the hint is present');
  // Roots do not move a relative pattern's anchor — the launch directory is
  // where it still resolves — and a cwd outside the roots refuses the call
  // outright, so a note offering GLM_MCP_ROOTS "or"-style sends the caller
  // down a path that cannot fix what it was told to fix.
  assert.match(hint, /\bcwd\b/);
  assert.match(hint, /GLM_MCP_ROOTS/);
  assert.doesNotMatch(hint, /pass cwd[^]*\bor\b[^]*GLM_MCP_ROOTS/,
    'the two knobs are not interchangeable remedies');
  assert.match(hint, /allowed roots[^]*GLM_MCP_ROOTS|GLM_MCP_ROOTS[^]*allowed roots/,
    'GLM_MCP_ROOTS is framed against the allowed roots it widens');
  // And it names nothing of this machine — the gate's rule 3, at unit level.
  assert.ok(!hint.includes(dir) && !hint.includes(tmpdir()),
    'no path from this machine rides along');
});

test('a cwd the caller supplied — even the startup directory itself — gets the plain no-match', async (t) => {
  const { dir, cleanup } = await launchDir();
  t.after(cleanup);
  const supplied = ctx(['nothing-here/**/*.ts'], dir, dir);
  assert.deepEqual(supplied.notes, ['skipped (no matches): nothing-here/**/*.ts']);
});

test('a range past the end of a found file carries no hint', async (t) => {
  const { dir, cleanup } = await launchDir();
  t.after(cleanup);
  // present.md was found and read; the range selected none of its lines. No
  // cwd or roots knob fixes a range, and saying the search ran somewhere the
  // caller never meant spends the signal on the wrong fix.
  const ranged = ctx(['present.md:999999-1000000'], dir);
  assert.deepEqual(ranged.notes, ['skipped (no matches): present.md:999999-1000000']);
});

test('a range past the end of a bracket-named file that was found carries no hint', async (t) => {
  const { dir, cleanup } = await launchDir();
  t.after(cleanup);
  // The review's second repro. The spelling is glob-shaped by its brackets,
  // but the ask is ranged and the FILE was found and read — only the range
  // selected no lines. Counting glob-shaped arguments is what let the
  // brackets take this spelling down the pattern branch; the call's outcome
  // is what settles it, and this call found its file.
  writeFileSync(join(dir, 'report[final].md'), 'found where the search ran\n');
  const ranged = ctx(['report[final].md:999999-1000000'], dir);
  assert.deepEqual(ranged.notes, ['skipped (no matches): report[final].md:999999-1000000']);
});

test('a duplicate argument carries no hint', async (t) => {
  const { dir, cleanup } = await launchDir();
  t.after(cleanup);
  // The file was found and delivered under the first argument; the second is
  // the merged no-match #26 already settled on. The search ran exactly where
  // the caller's own file says it did.
  const dup = ctx(['present.md', 'present.md'], dir);
  assert.ok(dup.text.includes('found where the search ran'));
  assert.deepEqual(dup.notes, ['skipped (no matches): present.md']);
});

test('a duplicate PATTERN beside its own delivered match carries no hint', async (t) => {
  const { dir, cleanup } = await launchDir();
  t.after(cleanup);
  // The review's first repro, and the gate's rule 5: *.md matched present.md
  // and it was read and returned, yet the duplicate still owes — and gets —
  // its no-match note. The hint would send the caller hunting elsewhere for a
  // file already in its reply.
  const dup = ctx(['*.md', '*.md'], dir);
  assert.ok(dup.text.includes('found where the search ran'));
  assert.deepEqual(dup.notes, ['skipped (no matches): *.md']);
});

test('a missing literal carries no hint — only a pattern can mean the wrong directory', async (t) => {
  const { dir, cleanup } = await launchDir();
  t.after(cleanup);
  // The spec's line, and the only oracle-free one: a literal's no-match is
  // as plausibly a typo as a mis-launch, and telling those apart would take a
  // disk fact — exactly what #26 keeps out of the notes.
  const missing = ctx(['nope.md'], dir);
  assert.deepEqual(missing.notes, ['skipped (no matches): nope.md']);
});

test('a pattern no-match among files that arrived names itself and carries no hint', async (t) => {
  const { dir, cleanup } = await launchDir();
  t.after(cleanup);
  // The call found present.md; src/**/*.ts still matched nothing and is still
  // named, exactly as #13 and #40 settled. But the sentence belongs to a call
  // that delivered NOTHING — beside returned content it would point at the
  // wrong fix, the duplicate case wearing a mixed argument list.
  const mixed = ctx(['present.md', 'src/**/*.ts'], dir);
  assert.ok(mixed.text.includes('found where the search ran'));
  assert.ok(mixed.notes.some((n) => n === 'skipped (no matches): src/**/*.ts'));
  assert.ok(!mixed.notes.some((n) => HINT.test(n)),
    'content was delivered, so the no-cwd hint points at the wrong fix');
});

test('an unreadable metacharacter twin hints exactly like an absent one', async (t) => {
  const { dir, cleanup } = await launchDir();
  t.after(cleanup);
  // `repo[final].md`, not the review's `repo?rt.md`: `?` is not a legal
  // filename on Windows, and the repo's metacharacter fixtures spell brackets
  // for exactly that reason (disclosure.test.mjs's locked[.]txt). The
  // eligibility line is the argument's own SYNTAX plus the call's outcome,
  // both already visible to the caller, so the hint's presence cannot vary
  // with what exists on disk — the property that keeps #26 closed where the
  // merged wording left it.
  writeFileSync(join(dir, 'repo[final].md'), 'unreadable\n');
  // chmod 000 denies a read to every account but root — and root is exactly
  // the account a CI box tends to run as, where the unreadable half of this
  // probe would silently test nothing. Deny and try the read: when the read
  // lands anyway, skip loudly rather than pass falsely, and RETURN — t.skip
  // marks the test skipped but does not stop this callback (865ec47).
  if (!deniesRead(join(dir, 'repo[final].md'))) {
    t.skip('chmod 000 did not deny the read (running as root?) — the twin oracle cannot be exercised here');
    return;
  }
  const unreadable = ctx(['repo[final].md'], dir);
  const absentDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-searchroot-')));
  t.after(() => rmSync(absentDir, { recursive: true, force: true }));
  const absent = ctx(['repo[final].md'], absentDir);
  assert.deepEqual(unreadable.notes, absent.notes);
  assert.ok(unreadable.notes.some((n) => HINT.test(n)));
});

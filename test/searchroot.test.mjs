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
// Two properties beyond the gate's four rules, both caught in review:
//   - the note's remedies are companions, not alternatives — `cwd` moves the
//     search and `GLM_MCP_ROOTS` widens what it may resolve inside; roots
//     alone leave the search where it ran, and a cwd outside the roots is
//     refused outright;
//   - only a PATTERN's no-match carries the sentence. A missing literal, a
//     duplicate, a range past the end of a found file — those are the plain
//     no-match they always were, and "the wrong directory was searched" is
//     the wrong fix pointed at by the one signal this note exists to add.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
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

test('a missing literal carries no hint — only a pattern can mean the wrong directory', async (t) => {
  const { dir, cleanup } = await launchDir();
  t.after(cleanup);
  // The spec's line, and the only oracle-free one: a literal's no-match is
  // as plausibly a typo as a mis-launch, and telling those apart would take a
  // disk fact — exactly what #26 keeps out of the notes.
  const missing = ctx(['nope.md'], dir);
  assert.deepEqual(missing.notes, ['skipped (no matches): nope.md']);
});

test('a pattern no-match among files that arrived still explains itself', async (t) => {
  const { dir, cleanup } = await launchDir();
  t.after(cleanup);
  const mixed = ctx(['present.md', 'src/**/*.ts'], dir);
  assert.ok(mixed.text.includes('found where the search ran'));
  assert.ok(mixed.notes.some((n) => n === 'skipped (no matches): src/**/*.ts'));
  assert.ok(mixed.notes.some((n) => HINT.test(n)));
});

test('an unreadable metacharacter twin hints exactly like an absent one', async (t) => {
  if (process.getuid?.() === 0) t.skip('running as root: chmod 000 denies nothing');
  const { dir, cleanup } = await launchDir();
  t.after(cleanup);
  writeFileSync(join(dir, 'repo?rt.md'), 'unreadable\n');
  chmodSync(join(dir, 'repo?rt.md'), 0o000);
  const unreadable = ctx(['repo?rt.md'], dir);
  const absentDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-searchroot-')));
  t.after(() => rmSync(absentDir, { recursive: true, force: true }));
  const absent = ctx(['repo?rt.md'], absentDir);
  // The eligibility line is the argument's own SYNTAX, so the hint's presence
  // cannot vary with what exists on disk — the property that keeps #26 closed
  // where the merged wording left it.
  assert.deepEqual(unreadable.notes, absent.notes);
  assert.ok(unreadable.notes.some((n) => HINT.test(n)));
});

// The last three silent losses (#39, #40, #41) — the refuse-loudly posture
// this project already has everywhere else, extended to its remaining hiding
// places:
//
//   #39  a binary file decoded as UTF-8 spends the char budget on U+FFFD
//        characters the model cannot read, with no note saying so;
//   #40  when the char cap cuts the read loop, the files after the cut are
//        dropped unnamed, so the caller cannot tell what reached the model
//        or retry with a curated list;
//   #41  an answer that stopped at max_tokens is returned looking exactly
//        like one that finished.
//
// #39 and #40 turn on buildFileContext, whose roots and char cap are read at
// module load, so every case runs in a child of its own — the same split the
// rest of this suite uses. #41 is captured twice: once against ask() through
// a local upstream, and once through the MCP tool itself, because the footer
// that must say it is index.ts's to write, and a test that only exercised
// the function beneath it would pass a server that never tells anyone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const GLM = pathToFileURL(new URL('../dist/glm.js', import.meta.url).pathname).href;
const INDEX = new URL('../dist/index.js', import.meta.url).pathname;
const REPLACEMENT = String.fromCharCode(0xfffd);
const NUL = String.fromCharCode(0);

// buildFileContext with the environment pinned at child startup — the roots
// and the char cap are read once at module load, so a case that depends on
// either has to be born inside its own process.
function ctx(paths, cwd, env = {}) {
  const src = `
import { buildFileContext } from ${JSON.stringify(GLM)};
const c = buildFileContext(${JSON.stringify(paths)}, ${JSON.stringify(cwd)});
process.stdout.write(JSON.stringify({ text: c.text, notes: c.notes }));`;
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (/^(GLM_MCP_|ZAI_)/.test(k)) delete childEnv[k];
  childEnv.GLM_MCP_ROOTS = cwd;
  for (const [k, v] of Object.entries(env)) childEnv[k] = String(v);
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', src],
    { encoding: 'utf8', env: childEnv, timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

// chmod 000 denies a read to every account but root — and root is exactly the
// account a CI box tends to run as, where the unreadable-file fixture would
// silently test nothing. Deny a probe and try the read: when the read lands
// anyway, the caller skips loudly rather than passes falsely.
const deniesRead = (path) => {
  chmodSync(path, 0o000);
  try {
    readFileSync(path, 'utf8');
    return false;
  } catch {
    return true;
  }
};

// ------------------------------------------------------ #39: binary files

test('#39 a binary file is skipped and named, not decoded into the prompt', () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-binary-')));
  try {
    writeFileSync(join(dir, 'blob.bin'), randomBytes(4000));
    writeFileSync(join(dir, 'source.ts'), 'export const SOURCE = 1;');
    const r = ctx(['blob.bin', 'source.ts'], dir);
    assert.ok(!r.text.includes(REPLACEMENT),
      `undecodable bytes reached the prompt as replacement characters — a binary file spends the budget on text the model cannot read: ${JSON.stringify(r.text.slice(0, 60))}`);
    assert.ok(!r.text.includes(NUL), 'a NUL byte reached the prompt');
    assert.ok(r.notes.some((n) => n.includes('blob.bin')),
      `a skipped binary file must be named in notes, in the existing vocabulary — ${JSON.stringify(r.notes)}`);
    assert.ok(r.text.includes('SOURCE'),
      `the source beside a binary file must still be read — ${JSON.stringify(r.text)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#39 a single NUL buried in text bytes is binary too', () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-binary-nul-')));
  try {
    writeFileSync(join(dir, 'embedded-nul.dat'),
      Buffer.concat([Buffer.from('text'), Buffer.alloc(1), Buffer.from('more')]));
    const r = ctx(['embedded-nul.dat'], dir);
    assert.ok(!r.text.includes(NUL) && !r.text.includes(REPLACEMENT),
      `a file containing a NUL byte reached the prompt — ${JSON.stringify(r.text)}`);
    assert.ok(r.notes.some((n) => n.includes('embedded-nul.dat')),
      `the skipped file must be named — ${JSON.stringify(r.notes)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#39 accented Latin, CJK and emoji are ordinary source, not binary', () => {
  // The other half of the requirement: a detector that over-triggers is
  // worse than the bug. Non-ASCII UTF-8 is exactly what this tool is for in
  // most of the world.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-binary-text-')));
  try {
    const body = '// naive cafe é 日本語 \u{1F600}\nexport const T = 1;\n';
    writeFileSync(join(dir, 'accents.ts'), body);
    const r = ctx(['accents.ts'], dir);
    for (const needle of ['cafe', '日本語', '\u{1F600}']) {
      assert.ok(r.text.includes(needle),
        `valid UTF-8 text was treated as binary — notes=${JSON.stringify(r.notes)}`);
    }
    assert.deepEqual(r.notes, [], 'a file that was read in full says nothing in notes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#39 a skipped binary file spends none of the char budget', () => {
  // 4,000 bytes of blob beside 800 chars of text under a 1,000-char cap: if
  // the blob's bytes counted, the text would be cut; skipped, it arrives whole.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-binary-budget-')));
  try {
    writeFileSync(join(dir, 'blob.bin'), randomBytes(4000));
    writeFileSync(join(dir, 'text.txt'), 'z'.repeat(799) + '!');
    const r = ctx(['blob.bin', 'text.txt'], dir, { GLM_MCP_MAX_FILE_CHARS: '1000' });
    assert.ok(r.text.includes('!'),
      `the text beside a skipped binary was truncated — the skipped bytes must not count against the cap: ${JSON.stringify(r.notes)}`);
    assert.ok(!r.notes.some((n) => /truncat/i.test(n)),
      `the cap tripped on a file that never entered the prompt — ${JSON.stringify(r.notes)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------ #40: what the cap left behind

test('#40 every file past the cap is named as not read, and what reached is not called dropped', () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-cap-drops-')));
  try {
    const NAMED = ['a1.txt', 'a2.txt', 'a3.txt', 'zz-last.txt'];
    for (const n of NAMED) writeFileSync(join(dir, n), 'y'.repeat(400));
    const r = ctx(NAMED, dir, { GLM_MCP_MAX_FILE_CHARS: '700' });
    assert.ok(r.notes.some((n) => /truncat/i.test(n)),
      `the cap must still report where it cut — ${JSON.stringify(r.notes)}`);
    const said = r.notes.join(' ');
    for (const n of NAMED) {
      const reached = r.text.includes(`--- ${n} ---`);
      if (!reached) {
        // Naming alone is not enough: `skipped (no matches)` names the file
        // while claiming it does not exist, which sends the caller the one
        // message that forecloses the retry. The note must say the file was
        // there to read and the cap is why it was not read.
        const dropNote = r.notes.find((x) => x.includes(n) && /not read|cap|truncat/i.test(x));
        assert.ok(dropNote,
          `${n} never reached the model and no note honestly names it — ${JSON.stringify(r.notes)}`);
        assert.ok(!/no matches/i.test(dropNote),
          `${n} was dropped by the cap but is reported as not existing: ${JSON.stringify(dropNote)}`);
      }
    }
    // The other direction: a1 arrived whole, and reporting it as dropped
    // would be the mirror-image lie.
    assert.ok(r.text.includes('--- a1.txt ---'), 'the fixture must deliver a1.txt whole');
    assert.ok(!said.includes('a1.txt'),
      `a file that reached the model must not be reported as dropped — ${JSON.stringify(r.notes)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#40 a repeated argument past the cut is named for its own position, the first is not', () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-cap-reached-')));
  try {
    writeFileSync(join(dir, 'small.txt'), 's'.repeat(50));
    writeFileSync(join(dir, 'big.txt'), 'b'.repeat(300));
    writeFileSync(join(dir, 'after.txt'), 'a'.repeat(50));
    // big.txt trips the cap; after.txt falls past it and must be named as
    // not read. The second small.txt argument is deduplicated into the
    // first's delivered content — the FILE reached the model, but nothing
    // was read on the second POSITION's behalf, and arrival is tracked per
    // argument (#40): the first occurrence delivered and is not reported as
    // a drop, the second is named for its own turn, because crediting it
    // with the first's read was the spelling-keyed credit — the same keying
    // that made a symlink twin's silence answer whether the link existed.
    const r = ctx(['small.txt', 'big.txt', 'after.txt', 'small.txt'], dir, { GLM_MCP_MAX_FILE_CHARS: '200' });
    assert.ok(r.notes.some((n) => /truncat/i.test(n) && n.includes('big.txt')),
      `big.txt must be where the cut is reported — ${JSON.stringify(r.notes)}`);
    assert.ok(r.notes.some((n) => n.includes('after.txt') && /not read|cap/i.test(n)
      && !/no matches/i.test(n)),
      `after.txt fell past the cap and must be named as not read — ${JSON.stringify(r.notes)}`);
    const small = r.notes.filter((n) => n.includes('small.txt'));
    assert.equal(small.length, 1,
      `the repeated argument must be answered exactly once, for the occurrence that got nothing — ${JSON.stringify(r.notes)}`);
    assert.match(small[0], /char cap reached, not read/,
      `the second small.txt was never read because the cap cut before its turn — ${JSON.stringify(small[0])}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#40 a pattern cut by the cap is named as its argument, its unread matches are not', () => {
  // The tests above cover the literal route: four named files, each past the
  // cap, each named by its own argument's note. But a glob is how most
  // callers name many files at once, and it takes a different path through
  // the same code. The cap's notes answer ARGUMENTS, not files: the caller
  // knows what it supplied and needs to know which of THAT did not fully
  // arrive so it can curate and retry — a filename it never sent would be
  // something it learns, and a file that matched a pattern and was never read
  // can only be NAMED if it exists, so enumerating the unread matches
  // answers "does this file exist?", #26's oracle in the cap's wording. One
  // pattern, three matches, a cap that delivers the first and truncates the
  // second: the pattern is named, the matches are not, and the one argument
  // still costs one note (#26).
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-cap-glob-')));
  try {
    const MD = ['a-one.md', 'b-two.md', 'c-three.md'];
    for (const n of MD) writeFileSync(join(dir, n), 'm'.repeat(600));
    const r = ctx(['*.md'], dir, { GLM_MCP_MAX_FILE_CHARS: '1000' });
    assert.ok(r.text.includes('--- a-one.md ---'), 'the fixture must deliver a-one.md whole');
    assert.ok(r.text.includes('(truncated)'), 'the fixture must truncate b-two.md — it proves nothing');
    // The pattern is the caller's own argument, so naming it tells the caller
    // nothing it did not supply; and `no matches` beside content that came
    // from this very pattern would be the one message that forecloses the
    // retry — it claims the pattern matched nothing.
    const argNote = r.notes.find((x) => x.includes('*.md'));
    assert.ok(argNote && /truncat|not read|cap/i.test(argNote) && !/no matches/i.test(argNote),
      `'*.md' did not fully arrive and no note names the argument — ${JSON.stringify(r.notes)}`);
    // Neither the match the cap truncated nor the match it never attempted
    // may be named: both names exist only because the files do.
    for (const n of ['b-two.md', 'c-three.md']) {
      assert.ok(!r.notes.some((x) => x.includes(n)),
        `${n} is a match of the pattern, not an argument — naming it tells the caller which files exist: ${JSON.stringify(r.notes)}`);
    }
    assert.equal(r.notes.length, 1,
      `one argument must cost one note — a note per dropped match would reopen #26: ${JSON.stringify(r.notes)}`);
    // The mirror-image lie: a-one arrived whole, and reporting it as dropped
    // would be the same falsehood in the other direction.
    assert.ok(!r.notes.some((n) => n.includes('a-one.md')),
      `a match that reached the model must not be reported as dropped — ${JSON.stringify(r.notes)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#40 a pattern\'s unread matches under the cap do not tell absent from unreadable', (t) => {
  // The trade this round exists to undo: naming a pattern's unread matches
  // under the cap answers "does this file exist?" — a name can only be
  // produced for a file that is there. The third match of *.md is
  // present-but-unreadable in one run and absent in the other; the notes
  // must not say which, while the cap still cuts and the pattern is still
  // named as the argument that did not fully arrive.
  const check = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-cap-glob-0-')));
  writeFileSync(join(check, 'canary'), 'X');
  const denied = deniesRead(join(check, 'canary'));
  rmSync(check, { recursive: true, force: true });
  if (!denied) {
    t.skip('chmod 000 did not deny the read (running as root?) — the pattern cap oracle cannot be exercised here');
    return;
  }
  const probe = (present) => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-cap-glob-oracle-')));
    try {
      for (const n of ['a-one.md', 'b-two.md']) writeFileSync(join(dir, n), 'm'.repeat(600));
      if (present) {
        const f = join(dir, 'c-secret.md');
        writeFileSync(f, 'S'.repeat(600));
        chmodSync(f, 0o000);
      }
      return ctx(['*.md'], dir, { GLM_MCP_MAX_FILE_CHARS: '1000' });
    } finally {
      try { chmodSync(join(dir, 'c-secret.md'), 0o600); } catch { /* absent */ }
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const present = probe(true);
  const absent = probe(false);
  assert.ok(present.notes.some((n) => /truncat/i.test(n)),
    `the fixture must actually cut the reads — ${JSON.stringify(present.notes)}`);
  assert.ok(!present.text.includes('S'), 'the unreadable body leaked');
  assert.ok(present.notes.some((n) => n.includes('*.md')),
    `the pattern must still be named as the argument that did not fully arrive — ${JSON.stringify(present.notes)}`);
  assert.deepEqual(present.notes, absent.notes,
    `the cap plus a pattern tells a caller whether an unreadable file exists — ${JSON.stringify({
      present: present.notes, absent: absent.notes })}`);
});

test('#40 naming the drops does not tell absent from unreadable after the cut', (t) => {
  // The constraint #26 fixed, re-asserted for the new wording: the cap-drop
  // note is chosen by the argument's POSITION relative to the cut, never by
  // whether a file entry exists for it, so the same argument list must answer
  // identically whether the named file is absent or present and unreadable.
  const check = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-cap-oracle-0-')));
  writeFileSync(join(check, 'canary'), 'X');
  const denied = deniesRead(join(check, 'canary'));
  rmSync(check, { recursive: true, force: true });
  if (!denied) {
    t.skip('chmod 000 did not deny the read (running as root?) — the post-cap oracle cannot be exercised here');
    return;
  }
  const probe = (present) => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-cap-oracle-')));
    try {
      writeFileSync(join(dir, 'big.txt'), 'B'.repeat(200));
      if (present) {
        const f = join(dir, 'probe[.]txt');
        writeFileSync(f, 'S');
        chmodSync(f, 0o000);
      }
      return ctx(['big.txt', 'probe[.]txt'], dir, { GLM_MCP_MAX_FILE_CHARS: '80' });
    } finally {
      try { chmodSync(join(dir, 'probe[.]txt'), 0o600); } catch { /* absent */ }
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const present = probe(true);
  const absent = probe(false);
  assert.ok(present.notes.some((n) => /truncat/i.test(n)),
    `the fixture must actually cut the reads — ${JSON.stringify(present.notes)}`);
  assert.ok(!present.text.includes('S'), 'the unreadable body leaked');
  assert.deepEqual(present.notes, absent.notes,
    `the post-cut drop note tells a caller whether the file exists — ${JSON.stringify({
      present: present.notes, absent: absent.notes })}`);
});

test('#40 a pattern after the cut is named even when an earlier argument delivered one of its matches', () => {
  // The shape a review of this round caught: a literal alone trips the cap
  // and the pattern's first match is that same literal, de-duplicated. The
  // contribution scan counted the delivered match as the pattern's own and
  // silenced the argument — second.md and third.md then fell past the cap
  // without a word, the literal case fixed while this shape stayed open.
  // The answer past the cut is POSITION, the caller's own argument order:
  // whether the pattern's other matches were all claimed by earlier
  // arguments is a fact about what exists on disk, so a silence computed
  // from it could only be decided per world (see the test below).
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-cap-glob-lit-')));
  try {
    writeFileSync(join(dir, 'first.md'), 'f'.repeat(900));
    writeFileSync(join(dir, 'second.md'), 's'.repeat(100));
    writeFileSync(join(dir, 'third.md'), 't'.repeat(100));
    const r = ctx(['first.md', '*.md'], dir, { GLM_MCP_MAX_FILE_CHARS: '500' });
    assert.ok(r.text.includes('--- first.md (truncated) ---'),
      `the fixture must trip the cap inside the literal — ${JSON.stringify(r.notes)}`);
    assert.ok(r.notes.some((n) => /truncat/i.test(n) && n.includes('first.md')),
      `the cut is inside first.md, so the truncation note names it — ${JSON.stringify(r.notes)}`);
    const argNote = r.notes.find((x) => x.includes('*.md'));
    assert.ok(argNote && /not read|cap/i.test(argNote) && !/no matches/i.test(argNote),
      `'*.md' sits past the cut and its turn never came; no note names the argument, so the caller cannot tell it from a pattern that matched nothing — ${JSON.stringify(r.notes)}`);
    // The matches the cap never reached are not the caller's arguments, and
    // their names exist only because the files do — #26's oracle.
    for (const n of ['second.md', 'third.md']) {
      assert.ok(!r.notes.some((x) => x.includes(n)),
        `${n} is a match of the pattern, not an argument — naming it tells the caller which files exist: ${JSON.stringify(r.notes)}`);
    }
    assert.equal(r.notes.length, 2,
      `one note per argument, the literal's truncation and the pattern's cap drop — ${JSON.stringify(r.notes)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#40 a pattern after the cut does not tell absent from unreadable', (t) => {
  // The constraint #26 fixed, for the argument position this round added to
  // the cap's answer. A pattern past the cut must be answered identically
  // whether a would-be match is absent or present-but-unreadable — and so
  // must its literal branch twin, because whether 'a[.]md' is handled as a
  // literal or as a pattern is itself decided by whether the file exists.
  // The old contribution scan failed both halves: the twin was named only
  // when the file existed, and any per-match silence would have named the
  // pattern only when an extra match did.
  const check = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-cap-glob-oracle2-')));
  writeFileSync(join(check, 'canary'), 'X');
  const denied = deniesRead(join(check, 'canary'));
  rmSync(check, { recursive: true, force: true });
  if (!denied) {
    t.skip('chmod 000 did not deny the read (running as root?) — the post-cut pattern oracle cannot be exercised here');
    return;
  }
  const probe = (shape, present) => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-cap-glob-oracle3-')));
    try {
      if (shape === 'pattern') {
        writeFileSync(join(dir, 'first.md'), 'f'.repeat(900));
        writeFileSync(join(dir, 'second.md'), 's'.repeat(100));
        if (present) {
          const f = join(dir, 'zz-secret.md');
          writeFileSync(f, 'S'.repeat(100));
          chmodSync(f, 0o000);
        }
        return ctx(['first.md', '*.md'], dir, { GLM_MCP_MAX_FILE_CHARS: '500' });
      }
      writeFileSync(join(dir, 'a.md'), 'A'.repeat(10));
      writeFileSync(join(dir, 'big.txt'), 'B'.repeat(200));
      if (present) {
        const f = join(dir, 'a[.]md');
        writeFileSync(f, 'S'.repeat(10));
        chmodSync(f, 0o000);
      }
      return ctx(['a.md', 'big.txt', 'a[.]md'], dir, { GLM_MCP_MAX_FILE_CHARS: '100' });
    } finally {
      for (const n of ['zz-secret.md', 'a[.]md']) {
        try { chmodSync(join(dir, n), 0o600); } catch { /* absent */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
  for (const shape of ['pattern', 'twin']) {
    const present = probe(shape, true);
    const absent = probe(shape, false);
    assert.ok(present.notes.some((n) => /truncat/i.test(n)),
      `the fixture must actually cut the reads — ${JSON.stringify(present.notes)}`);
    assert.ok(!present.text.includes('S'), 'the unreadable body leaked');
    assert.deepEqual(present.notes, absent.notes,
      `the cap plus a post-cut pattern (${shape}) tells a caller whether an unreadable file exists — ${JSON.stringify({
        present: present.notes, absent: absent.notes })}`);
  }
});

test('#40 a pattern whose every match an earlier argument already read is named, not credited with them', () => {
  // The cap is not the only way a later overlapping pattern delivers
  // nothing: an earlier argument can simply have READ the file, and the
  // contribution scan counted that match as the pattern's own. The caller
  // was told the cut began at a literal and never learned that its pattern
  // delivered nothing at all — the same silence, with no cap to explain it.
  // What arrived on the pattern's behalf is nothing, so it is named as its
  // own argument, in the merged #26 wording: why an overlap yields nothing
  // (already read, absent, unreadable) is not the caller's to learn.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-overlap-')));
  try {
    writeFileSync(join(dir, 'readable.txt'), 'READABLE-BODY');
    const r = ctx(['readable.txt', 'readabl?.txt'], dir);
    assert.ok(r.text.includes('READABLE-BODY'),
      `the overlap must still be delivered once — ${JSON.stringify(r.text)}`);
    assert.ok(r.notes.some((n) => n.includes('readabl?.txt')),
      `'readabl?.txt' delivered nothing of its own and no note names it — ${JSON.stringify(r.notes)}`);
    // The note names the pattern, never the match it did not read: that
    // filename exists only because the file does (#26) — and the literal's
    // file arrived, so it is not the pattern's note to carry.
    assert.ok(!r.notes.some((n) => n.includes('readable.txt')),
      `a file the literal already delivered is named as the pattern's — ${JSON.stringify(r.notes)}`);
    assert.equal(r.notes.length, 1,
      `one argument, one note — ${JSON.stringify(r.notes)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#40 a pattern before the cut does not tell absent from unreadable', (t) => {
  // The other half of the overlap: BEFORE the cut, the branch twin 'a[.]md'
  // is a literal when a file by that name exists and a pattern matching a.md
  // when it does not, and its overlap with the already-read a.md was
  // credited as the pattern's own. The unreadable twin said `no matches`
  // and the absent one said nothing — the note count was the oracle.
  // Crediting only what was read on the pattern's own behalf makes both
  // worlds answer the same.
  const check = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-precut-0-')));
  writeFileSync(join(check, 'canary'), 'X');
  const denied = deniesRead(join(check, 'canary'));
  rmSync(check, { recursive: true, force: true });
  if (!denied) {
    t.skip('chmod 000 did not deny the read (running as root?) — the pre-cut twin oracle cannot be exercised here');
    return;
  }
  const probe = (present) => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-precut-')));
    try {
      writeFileSync(join(dir, 'a.md'), 'A'.repeat(10));
      writeFileSync(join(dir, 'big.txt'), 'B'.repeat(200));
      if (present) {
        const f = join(dir, 'a[.]md');
        writeFileSync(f, 'S'.repeat(10));
        chmodSync(f, 0o000);
      }
      return ctx(['a.md', 'a[.]md', 'big.txt'], dir, { GLM_MCP_MAX_FILE_CHARS: '100' });
    } finally {
      try { chmodSync(join(dir, 'a[.]md'), 0o600); } catch { /* absent */ }
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const present = probe(true);
  const absent = probe(false);
  assert.ok(present.notes.some((n) => /truncat/i.test(n)),
    `the fixture must actually cut the reads — ${JSON.stringify(present.notes)}`);
  assert.ok(!present.text.includes('S'), 'the unreadable body leaked');
  assert.ok(absent.notes.some((n) => n.includes('a[.]md')),
    `the overlapping argument is named when its file exists and silent when it does not — ${JSON.stringify(absent.notes)}`);
  assert.deepEqual(present.notes, absent.notes,
    `a pattern before the cut tells a caller whether an unreadable file exists — ${JSON.stringify({
      present: present.notes, absent: absent.notes })}`);
});

// symlinkSync can be denied by platform policy (Windows without the
// privilege); the linked-twin probes below cannot run there. Probe once and
// skip loudly rather than pass falsely, the same stance as deniesRead.
const canSymlink = (() => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-link-0-')));
  try {
    symlinkSync('nowhere', join(dir, 'canary'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

test('#40/#26 a deduplicated branch twin past the cap does not tell absent from linked', (t) => {
  // The shape a review of this round caught. 'a[.]md' is a pattern matching
  // the already-read a.md when it is absent, and a literal when it exists —
  // and when it is a SYMLINK to a.md, the literal de-duplicates against
  // a.md's resolved identity, so the argument was answered through the FILE
  // and stayed silent. Absent, the same argument was named by position.
  // Which of those answered was decided by whether the link exists: an
  // oracle in the note count, with the text identical in both worlds.
  // Crediting the argument through its own SPELLING closes it — the same
  // test the pattern route already answers.
  if (!canSymlink) {
    t.skip('symlinkSync was denied — the linked-twin oracle cannot be exercised here');
    return;
  }
  const probe = (linked) => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-twin-cut-')));
    try {
      writeFileSync(join(dir, 'a.md'), 'A'.repeat(10));
      writeFileSync(join(dir, 'big.txt'), 'B'.repeat(200));
      if (linked) symlinkSync('a.md', join(dir, 'a[.]md'));
      return ctx(['a.md', 'big.txt', 'a[.]md'], dir, { GLM_MCP_MAX_FILE_CHARS: '100' });
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* absent */ }
    }
  };
  const absent = probe(false);
  const linked = probe(true);
  assert.ok(absent.notes.some((n) => /truncat/i.test(n)),
    `the fixture must actually cut the reads — ${JSON.stringify(absent.notes)}`);
  assert.equal(absent.text, linked.text,
    `the two worlds delivered different text — ${JSON.stringify({ absent: absent.text, linked: linked.text })}`);
  assert.deepEqual(absent.notes, linked.notes,
    `the note count tells a caller whether a symlink 'a[.]md' exists — ${JSON.stringify({
      absent: absent.notes, linked: linked.notes })}`);
  for (const r of [absent, linked]) {
    assert.ok(r.notes.some((n) => n.includes('a[.]md')),
      `the twin argument delivered nothing of its own and must be named — ${JSON.stringify(r.notes)}`);
  }
});

test('#40/#26 a deduplicated branch twin before any cap does not tell absent from linked', (t) => {
  // The same oracle without the cap: 'a[.]md' linked to an already-read a.md
  // de-duplicates into it and was silent through the file-keyed credit,
  // while the absent twin — a pattern whose only match that same literal
  // already claimed — was named for delivering nothing of its own.
  if (!canSymlink) {
    t.skip('symlinkSync was denied — the linked-twin oracle cannot be exercised here');
    return;
  }
  const probe = (linked) => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-twin-')));
    try {
      writeFileSync(join(dir, 'a.md'), 'A'.repeat(10));
      if (linked) symlinkSync('a.md', join(dir, 'a[.]md'));
      return ctx(['a.md', 'a[.]md'], dir);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* absent */ }
    }
  };
  const absent = probe(false);
  const linked = probe(true);
  assert.equal(absent.text, linked.text,
    `the two worlds delivered different text — ${JSON.stringify({ absent: absent.text, linked: linked.text })}`);
  assert.deepEqual(absent.notes, linked.notes,
    `a linked twin beside its own target tells a caller the link exists — ${JSON.stringify({
      absent: absent.notes, linked: linked.notes })}`);
  for (const r of [absent, linked]) {
    assert.ok(r.notes.some((n) => n.includes('a[.]md')),
      `the twin argument delivered nothing of its own and must be named — ${JSON.stringify(r.notes)}`);
  }
});

test('#40/#26 a repeated branch twin past the cap does not tell absent from linked', (t) => {
  // The repeated spelling is where the two routes had to agree and did not:
  // absent, the second 'a[.]md' is a pattern and the position rule named it;
  // linked, it is a literal de-duplicated into the first's read and the
  // file-keyed credit kept it silent. One spelling, two answers, chosen by
  // whether the link exists. Both occurrences are now answered on position
  // alone: the second delivered nothing of its own in either world, so it is
  // named in either world, cap or no cap.
  if (!canSymlink) {
    t.skip('symlinkSync was denied — the linked-twin oracle cannot be exercised here');
    return;
  }
  const probe = (linked) => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-twin-rep-')));
    try {
      writeFileSync(join(dir, 'a.md'), 'A'.repeat(10));
      writeFileSync(join(dir, 'big.txt'), 'B'.repeat(200));
      if (linked) symlinkSync('a.md', join(dir, 'a[.]md'));
      return ctx(['a[.]md', 'big.txt', 'a[.]md'], dir, { GLM_MCP_MAX_FILE_CHARS: '100' });
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* absent */ }
    }
  };
  const absent = probe(false);
  const linked = probe(true);
  assert.ok(absent.notes.some((n) => /truncat/i.test(n)),
    `the fixture must actually cut the reads — ${JSON.stringify(absent.notes)}`);
  assert.deepEqual(absent.notes, linked.notes,
    `a repeated twin past the cap answers once per world — ${JSON.stringify({
      absent: absent.notes, linked: linked.notes })}`);
});

test('#40 a repeated pattern is answered once per occurrence, on position', () => {
  // Re-pinned by the position rule. The round before keyed a repeated
  // spelling's credit by the SPELLING, so the second occurrence rode its
  // twin's delivered matches silently — which left both routes agreeing,
  // but agreeing on an answer computed from what was READ rather than from
  // the argument list: the note count then varied with which files existed
  // and were readable, #26's question. Arrival is now a fact about a
  // POSITION: the second occurrence had nothing read on its own behalf, so
  // it is named, in the merged wording, beside the content its twin
  // delivered — why an argument yields nothing (already read through an
  // earlier spelling, absent, unreadable) is not the caller's to learn.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-repeat-')));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'one.ts'), 'ONE');
    writeFileSync(join(dir, 'src', 'two.ts'), 'TWO');
    const r = ctx(['src/*.ts', 'src/*.ts'], dir);
    assert.ok(r.text.includes('ONE') && r.text.includes('TWO'),
      `the pattern's files must still be delivered once — ${JSON.stringify(r.text)}`);
    assert.deepEqual(r.notes, ['skipped (no matches): src/*.ts'],
      `the second occurrence had nothing read on its own behalf and must be named for its own position — ${JSON.stringify(r.notes)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------- #41: a severed answer says so

// The stand-in for z.ai, answering with a chosen stop_reason: the shape ask()
// expects, and the one field this issue is about. The body is per-reason on
// purpose — the finished answer's body must not itself contain words the
// warning regex looks for, or the not-flagged direction could never pass.
const upstreamWith = (stopReason, body) => {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        model: 'glm-5.3',
        stop_reason: stopReason,
        content: [{ type: 'text', text: body }],
        usage: { input_tokens: 10, output_tokens: 99 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, origin: `http://127.0.0.1:${server.address().port}` });
  }));
};

// ask() in a child that owns the local upstream, the same harness shape the
// api and capacity suites use — the client's endpoint is pinned at startup.
function askAgainst(stopReason) {
  const src = `
import { createServer } from 'node:http';
import * as glm from ${JSON.stringify(GLM)};
const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      model: 'glm-5.3',
      stop_reason: ${JSON.stringify(stopReason)},
      content: [{ type: 'text', text: 'cut off mid-sent' }],
      usage: { input_tokens: 10, output_tokens: 99 },
    }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const out = {};
process.env.ZAI_BASE_URL = 'http://127.0.0.1:' + server.address().port;
process.env.ZAI_API_KEY = 'dummy-key-for-the-local-server';
try { out.result = await glm.ask({ prompt: 'hi', model: 'glm-5.3', reasoning: 'low' }); }
catch (e) { out.threw = String(e && e.message ? e.message : e); }
server.close();
process.stdout.write(JSON.stringify(out));`;
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (/^(GLM_MCP_|ZAI_)/.test(k)) delete childEnv[k];
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', src],
    { encoding: 'utf8', env: childEnv, timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

test('#41 ask() carries the stop reason through the result', () => {
  const cut = askAgainst('max_tokens');
  assert.ok(!cut.threw, `ask must succeed against the local upstream — ${cut.threw}`);
  assert.equal(cut.result.stopReason, 'max_tokens',
    `an answer severed by the output cap must say so in AskResult — got ${JSON.stringify(cut.result)}`);
  const done = askAgainst('end_turn');
  assert.equal(done.result.stopReason, 'end_turn',
    `a finished answer reports its own reason — got ${JSON.stringify(done.result)}`);
});

test('#41 the tool result flags an answer that stopped at max_tokens, and only that', async () => {
  // Through the MCP tool against the built server: the footer is index.ts's
  // to write, so the gate has to read what the caller reads, not the object
  // ask() returned. Both directions asserted — an unfinished answer must be
  // flagged, and a normally finished one must not be.
  for (const [reason, mustWarn] of [['max_tokens', true], ['end_turn', false]]) {
    const { server, origin } = await upstreamWith(
      reason, mustWarn ? 'cut off mid-sent' : 'an ordinary finished answer');
    const client = new Client({ name: 'glm-completeness-test', version: '1.0.0' });
    try {
      await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [INDEX],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          ZAI_API_KEY: 'dummy-key-for-the-local-server',
          ZAI_BASE_URL: origin,
        },
      }));
      const res = await client.callTool({
        name: 'glm_ask',
        arguments: { prompt: 'hi', model: 'glm-5.3', reasoning: 'low' },
      });
      const text = res.content?.[0]?.text ?? '';
      if (mustWarn) {
        assert.match(text, /stopped at max_tokens/,
          `the model stopped at max_tokens and the result reads as a finished answer — ${JSON.stringify(text.slice(-160))}`);
      } else {
        assert.ok(!/max_tokens|cut off|truncated|stopped at/i.test(text),
          `a normally finished answer is flagged as truncated — ${JSON.stringify(text.slice(-160))}`);
      }
    } finally {
      await client.close().catch(() => {});
      server.close();
    }
  }
});

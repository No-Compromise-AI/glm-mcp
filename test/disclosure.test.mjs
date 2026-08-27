// What the caller is told (#26, #28): the caller of glm_ask is the untrusted
// party, and the errors and notes that reach it may describe its own request —
// and nothing about the machine the server runs on. No home directory out of a
// failed key-file read, no existence-and-permission oracle in the skip notes,
// no regex-engine internals in a malformed-pattern refusal. What each note MAY
// keep naming is the caller's own spelling: that is its argument coming back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFileContext, resolveApiKey } from '../dist/glm.js';

// chmod 000 denies a read to every account but root — and root is exactly the
// account a CI box tends to run as, where these fixtures would silently test
// nothing. Deny a probe file and try the read: when the read lands anyway, the
// caller skips loudly rather than passes falsely. Every caller returns
// immediately after t.skip(), because node:test does not stop the callback.
const deniesRead = (path) => {
  chmodSync(path, 0o000);
  try {
    readFileSync(path, 'utf8');
    return false;
  } catch {
    return true;
  }
};

// Run `fn` under a throwaway environment and put the process back whatever
// happens. HOME is what os.homedir() reads on POSIX and USERPROFILE on Windows,
// so both are set; the credential and roots variables are pinned by deletion so
// a value left over from an earlier test cannot leak in.
const isolated = (env, fn) => {
  const names = ['HOME', 'USERPROFILE', 'ZAI_API_KEY', 'GLM_MCP_ALLOW_ZCODE_KEY', 'GLM_MCP_ROOTS'];
  const saved = {};
  for (const name of names) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
};

// Collect what a run sent to stderr. stdout is the MCP protocol, so the detail
// a caller must not see has exactly one place left to go — and these tests
// check that it went there, not merely that it left the tool result.
const toStderr = (fn) => {
  const said = [];
  const original = console.error;
  console.error = (...args) => { said.push(args.join(' ')); };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return said;
};

test('a key file that cannot be read is reported without its path', (t) => {
  // realpath, because a root spelled through macOS's /var is compared against
  // paths resolved through /private/var, and the mismatch refuses everything.
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-disclosure-key-')));
  const keyFile = join(home, '.config', 'zai', 'api-key');
  mkdirSync(join(home, '.config', 'zai'), { recursive: true });
  writeFileSync(keyFile, 'SECRET-KEY-VALUE');
  const cleanup = () => {
    try { chmodSync(keyFile, 0o600); } catch { /* best effort */ }
    rmSync(home, { recursive: true, force: true });
  };
  if (!deniesRead(keyFile)) {
    cleanup();
    t.skip('chmod 000 did not deny the read (running as root?) — the key-file case cannot be exercised here');
    return;
  }
  let said;
  try {
    isolated({ HOME: home, USERPROFILE: home }, () => {
      said = toStderr(() => {
        assert.throws(resolveApiKey, (e) => {
          assert.ok(e instanceof Error);
          assert.ok(!e.message.includes(home),
            `the caller is shown the server's home directory: ${e.message}`);
          assert.ok(!/EACCES|EPERM|permission denied/i.test(e.message),
            `the caller is shown the OS's wording for the failure: ${e.message}`);
          assert.match(e.message, /key file/i, 'the message must still say what went wrong');
          assert.match(e.message, /ZAI_API_KEY/, 'the message must still say what to do about it');
          return true;
        });
      });
    });
    assert.ok(said.some((line) => line.includes(keyFile)),
      'the file\'s path belongs on stderr, where the operator reads it');
    assert.ok(said.some((line) => /EACCES|EPERM|permission denied/i.test(line)),
      'the underlying error belongs on stderr too');
  } finally {
    cleanup();
  }
});

test('an unreachable ZCode config is reported as such, not as no key at all', (t) => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-disclosure-zcode-')));
  const zcode = join(home, '.zcode', 'v2', 'config.json');
  mkdirSync(join(home, '.zcode', 'v2'), { recursive: true });
  writeFileSync(zcode, JSON.stringify({
    provider: { 'builtin:zai-coding-plan': { options: { apiKey: 'sk-zcode' } } },
  }));
  const cleanup = () => {
    try { chmodSync(zcode, 0o600); } catch { /* best effort */ }
    rmSync(home, { recursive: true, force: true });
  };
  if (!deniesRead(zcode)) {
    cleanup();
    t.skip('chmod 000 did not deny the read (running as root?) — the ZCode case cannot be exercised here');
    return;
  }
  let said;
  try {
    isolated({ HOME: home, USERPROFILE: home, GLM_MCP_ALLOW_ZCODE_KEY: '1' }, () => {
      said = toStderr(() => {
        assert.throws(resolveApiKey, (e) => {
          // The operator opted in (#21), so this config holds a key they chose
          // to use: a permission failure means it cannot be reached, not that
          // no key is configured. Filing it under "no key found" would send
          // the caller to create a credential it already has — and the config's
          // path must never ride the message out to it.
          assert.ok(e instanceof Error);
          assert.ok(!/no .*key found/i.test(e.message),
            `an opted-in key the server cannot reach is reported as absent: ${e.message}`);
          assert.ok(!e.message.includes(home),
            `the caller is shown the server's home directory: ${e.message}`);
          assert.match(e.message, /ZCode/, 'the message must still say what could not be used');
          return true;
        });
      });
    });
    assert.ok(said.some((line) => line.includes(zcode)),
      'why the opted-in key was not used belongs on stderr, or the operator never learns');
    assert.ok(said.some((line) => /EACCES|EPERM|permission denied/i.test(line)),
      'the underlying error belongs on stderr too');
  } finally {
    cleanup();
  }
});

test('a key that exists but cannot be reached is not reported as absent', (t) => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-disclosure-reach-')));
  const config = join(home, '.config');
  const keyFile = join(config, 'zai', 'api-key');
  mkdirSync(join(config, 'zai'), { recursive: true });
  writeFileSync(keyFile, 'SECRET-KEY-VALUE');
  const cleanup = () => {
    try { chmodSync(config, 0o700); } catch { /* best effort */ }
    rmSync(home, { recursive: true, force: true });
  };
  // chmod 000 on the ANCESTOR denies the traversal to everything inside it —
  // and existsSync() answers false for the key file just as if it were not
  // there, which is how a configured key came to be reported as absent.
  chmodSync(config, 0o000);
  let denied = true;
  try {
    readFileSync(keyFile, 'utf8');
    denied = false;
  } catch { /* the fixture denies the traversal as intended */ }
  if (!denied) {
    cleanup();
    t.skip('chmod 000 on the directory did not deny the traversal (running as root?) — the unreachable-key case cannot be exercised here');
    return;
  }
  let said;
  try {
    isolated({ HOME: home, USERPROFILE: home }, () => {
      said = toStderr(() => {
        assert.throws(resolveApiKey, (e) => {
          assert.ok(e instanceof Error);
          // The key IS configured; it simply cannot be reached. Told "no key
          // found", the caller goes to create a credential it already has.
          assert.ok(!/no .*key found/i.test(e.message),
            `a configured key the server cannot reach is reported as absent: ${e.message}`);
          assert.ok(!e.message.includes(home),
            `the caller is shown the server's home directory: ${e.message}`);
          assert.ok(!/EACCES|EPERM|permission denied/i.test(e.message),
            `the caller is shown the OS's wording for the failure: ${e.message}`);
          assert.match(e.message, /key/i, 'the message must still say what went wrong');
          return true;
        });
      });
    });
    assert.ok(said.some((line) => line.includes(keyFile)),
      'the path belongs on stderr, or the operator never learns which file could not be reached');
    assert.ok(said.some((line) => /EACCES|EPERM|permission denied/i.test(line)),
      'the underlying error belongs on stderr too');
  } finally {
    cleanup();
  }
});

test('a missing file and an unreadable one are the same fact to the caller', (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-disclosure-notes-')));
  const locked = join(dir, 'locked.txt');
  writeFileSync(join(dir, 'readable.txt'), 'READABLE-BODY');
  writeFileSync(locked, 'LOCKED-BODY');
  const cleanup = () => {
    try { chmodSync(locked, 0o600); } catch { /* best effort */ }
    rmSync(dir, { recursive: true, force: true });
  };
  if (!deniesRead(locked)) {
    cleanup();
    t.skip('chmod 000 did not deny the read (running as root?) — the existence oracle cannot be exercised here');
    return;
  }
  try {
    isolated({ GLM_MCP_ROOTS: dir }, () => {
      const absent = buildFileContext(['no-such-file.txt'], dir);
      const unreadable = buildFileContext(['locked.txt'], dir);
      assert.ok(!unreadable.text.includes('LOCKED-BODY'), 'the unreadable file must not be read');
      // Each caller sent its own spelling, so that is abstracted out; what
      // remains must be indistinguishable. `not found` beside `unreadable` was
      // an oracle for anything inside the roots: probe a spelling, learn
      // whether it exists and whether the server's account can read it.
      const shape = (notes, name) => notes.map((n) => n.split(name).join('<CALLER-PATH>'));
      assert.deepEqual(shape(unreadable.notes, 'locked.txt'), shape(absent.notes, 'no-such-file.txt'),
        `the notes told a missing file and an unreadable one apart — ${JSON.stringify({
          missing: absent.notes, unreadable: unreadable.notes })}`);
      // The merged note still names what the caller itself sent, so a caller
      // with ten files still learns which of them was skipped.
      assert.ok(absent.notes.some((n) => n.includes('no-such-file.txt')),
        `the note must still name the spelling the caller sent — ${JSON.stringify(absent.notes)}`);
      // And a skipped entry never takes its neighbour down.
      const mixed = buildFileContext(['locked.txt', 'readable.txt'], dir);
      assert.ok(mixed.text.includes('READABLE-BODY'),
        `a good file beside a skipped one must still be read — ${JSON.stringify(mixed)}`);
    });
  } finally {
    cleanup();
  }
});

test('a skip note for a glob match names the pattern, not the match the machine found', (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-disclosure-glob-')));
  // The exact name is knowable only by expanding the pattern: the caller sent
  // "sudoer?" and never "sudoers".
  const secret = join(dir, 'sudoers');
  writeFileSync(join(dir, 'readable.txt'), 'READABLE-BODY');
  writeFileSync(secret, 'ROOT-ONLY-BODY');
  const cleanup = () => {
    try { chmodSync(secret, 0o600); } catch { /* best effort */ }
    rmSync(dir, { recursive: true, force: true });
  };
  if (!deniesRead(secret)) {
    cleanup();
    t.skip('chmod 000 did not deny the read (running as root?) — the glob-match case cannot be exercised here');
    return;
  }
  try {
    isolated({ GLM_MCP_ROOTS: dir }, () => {
      const viaPattern = buildFileContext(['sudoer?', 'readable.txt'], dir);
      assert.ok(!viaPattern.text.includes('ROOT-ONLY-BODY'),
        'the unreadable match must not be read');
      assert.ok(viaPattern.text.includes('READABLE-BODY'),
        `a good file beside a skipped match must still be read — ${JSON.stringify(viaPattern)}`);
      // The note names the spelling the caller sent, so a caller with ten
      // patterns still learns which of them got nothing.
      assert.ok(viaPattern.notes.some((n) => n.includes('sudoer?')),
        `the note must name the spelling the caller sent — ${JSON.stringify(viaPattern.notes)}`);
      // And it does not name the filename the machine discovered by expanding
      // that spelling. With missing and unreadable already indistinguishable
      // for literals, the expanded name was the one remaining way to confirm
      // both that this file exists and that the server's account cannot read
      // it — the oracle #26 closes, routed through a wildcard.
      assert.ok(!JSON.stringify(viaPattern.notes).includes('sudoers'),
        `the note names the machine-expanded filename — ${JSON.stringify(viaPattern.notes)}`);
      // The pattern route has its own wording — the one a matchless pattern
      // gets, so the wildcard cannot be used to tell absent from unreadable;
      // the test after this one pins that within-route contract. The routes
      // MAY read differently from each other: a caller knows whether it sent
      // a literal or a pattern, so what neither may reveal is which of the
      // two REASONS applied, only what was asked for.
      assert.ok(viaPattern.notes.some((n) => /^skipped \(no matches\): sudoer\?$/.test(n)),
        `an unreadable match must answer exactly as a matchless pattern does — ${JSON.stringify(viaPattern.notes)}`);
    });
  } finally {
    cleanup();
  }
});

test('a glob spelled to match one name tells a missing file from an unreadable one no longer', (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-disclosure-glob-oracle-')));
  const locked = join(dir, 'locked.txt');
  writeFileSync(locked, 'LOCKED-BODY');
  const cleanup = () => {
    try { chmodSync(locked, 0o600); } catch { /* best effort */ }
    rmSync(dir, { recursive: true, force: true });
  };
  if (!deniesRead(locked)) {
    cleanup();
    t.skip('chmod 000 did not deny the read (running as root?) — the glob oracle cannot be exercised here');
    return;
  }
  try {
    isolated({ GLM_MCP_ROOTS: dir }, () => {
      // `[.]` spells the dot out without becoming a wildcard over it, so
      // `locked[.]txt` matches exactly one name: the literal existence probe,
      // one indirection away. If a matched-but-unreadable file answers a
      // pattern differently from a pattern that matched nothing, that oracle
      // survives the fix that closed it for literals.
      const absent = buildFileContext(['absent[.]txt'], dir);
      const unreadable = buildFileContext(['locked[.]txt'], dir);
      assert.ok(!unreadable.text.includes('LOCKED-BODY'), 'the unreadable match must not be read');
      const shape = (notes, name) => notes.map((n) => n.split(name).join('<CALLER-PATTERN>'));
      assert.deepEqual(shape(unreadable.notes, 'locked[.]txt'), shape(absent.notes, 'absent[.]txt'),
        `within patterns, a missing file and an unreadable one are told apart — ${JSON.stringify({
          missing: absent.notes, unreadable: unreadable.notes })}`);
      // The merged note still names what the caller itself sent.
      assert.ok(absent.notes.some((n) => n.includes('absent[.]txt')),
        `the note must still name the spelling the caller sent — ${JSON.stringify(absent.notes)}`);
    });
  } finally {
    cleanup();
  }
});

test('a pattern with one unreadable match answers as one that matched only the readable', (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-disclosure-partial-')));
  writeFileSync(join(dir, 'public.txt'), 'PUBLIC-BODY');
  const locked = join(dir, 'locked.txt');
  writeFileSync(locked, 'LOCKED-BODY');
  const cleanup = () => {
    try { chmodSync(locked, 0o600); } catch { /* best effort */ }
    rmSync(dir, { recursive: true, force: true });
  };
  if (!deniesRead(locked)) {
    cleanup();
    t.skip('chmod 000 did not deny the read (running as root?) — the partial-match case cannot be exercised here');
    return;
  }
  try {
    isolated({ GLM_MCP_ROOTS: dir }, () => {
      // Two spellings a caller can write without knowing anything about the
      // directory: one names a second member that does not exist, the other
      // one that exists and cannot be read. Both match the same readable
      // file, so both deliver the same text — and the notes must not be where
      // they differ, or the difference IS the oracle: "no matches" beside
      // content this very pattern produced says both that the walk found
      // something more and that the read of it was refused.
      const twin = buildFileContext(['{public,absent}[.]txt'], dir);
      const probed = buildFileContext(['{public,locked}[.]txt'], dir);
      assert.ok(twin.text.includes('PUBLIC-BODY') && probed.text.includes('PUBLIC-BODY'),
        `both spellings match the readable member — ${JSON.stringify({ twin, probed })}`);
      assert.ok(!probed.text.includes('LOCKED-BODY'), 'the unreadable member must not be read');
      assert.deepEqual(probed.notes, twin.notes,
        `a pattern that contributed content is told apart from its all-readable twin — ${JSON.stringify({
          twin: twin.notes, probed: probed.notes })}`);
      assert.ok(!twin.notes.some((n) => /no matches/i.test(n)),
        `a pattern whose match was read must not also be filed as matching nothing — ${JSON.stringify(twin.notes)}`);
    });
  } finally {
    cleanup();
  }
});

test('a deduplicated or repeated pattern still gets its own note, once', (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-disclosure-dedup-')));
  const locked = join(dir, 'locked.txt');
  writeFileSync(locked, 'LOCKED-BODY');
  const cleanup = () => {
    try { chmodSync(locked, 0o600); } catch { /* best effort */ }
    rmSync(dir, { recursive: true, force: true });
  };
  if (!deniesRead(locked)) {
    cleanup();
    t.skip('chmod 000 did not deny the read (running as root?) — the dedup case cannot be exercised here');
    return;
  }
  try {
    isolated({ GLM_MCP_ROOTS: dir }, () => {
      // Each probe is compared against its absent twin: same argument list
      // shape, second member missing instead of unreadable. Abstracting the
      // spellings away — each argument to a shared placeholder, by position,
      // so both sides land on the same names — the two must be
      // indistinguishable: the count and position of the notes is as much an
      // answer as their wording.
      const shape = (notes, ...names) => {
        let out = notes;
        names.forEach((n, i) => {
          out = out.map((x) => x.split(n).join(`<${i + 1}>`));
        });
        return out;
      };
      // A later pattern whose only match an earlier entry already claimed:
      // dropping its note at de-duplication leaves the unreadable case one
      // note short of the absent one.
      const dedupUnreadable = buildFileContext(['locked[.]txt', 'locke?.txt'], dir);
      const dedupAbsent = buildFileContext(['absent[.]txt', 'absen?.txt'], dir);
      assert.deepEqual(
        shape(dedupUnreadable.notes, 'locked[.]txt', 'locke?.txt'),
        shape(dedupAbsent.notes, 'absent[.]txt', 'absen?.txt'),
        `a pattern whose match was de-duplicated away is silent, and its absent twin is not — ${JSON.stringify({
          unreadable: dedupUnreadable.notes, absent: dedupAbsent.notes })}`);
      // The same through a literal: the pattern's note must survive the read
      // note of the file that claimed the match, in the same position either
      // way.
      const litUnreadable = buildFileContext(['locked.txt', 'locked[.]txt'], dir);
      const litAbsent = buildFileContext(['absent.txt', 'absent[.]txt'], dir);
      assert.deepEqual(
        shape(litUnreadable.notes, 'locked.txt', 'locked[.]txt'),
        shape(litAbsent.notes, 'absent.txt', 'absent[.]txt'),
        `a pattern after a literal that claimed its match answers differently from its absent twin — ${JSON.stringify({
          unreadable: litUnreadable.notes, absent: litAbsent.notes })}`);
      // And a pattern repeated in the argument list: it says its note exactly
      // once whether the match was unreadable or nothing matched at all.
      const repeatUnreadable = buildFileContext(['locked[.]txt', 'locked[.]txt'], dir);
      const repeatAbsent = buildFileContext(['absent[.]txt', 'absent[.]txt'], dir);
      assert.deepEqual(
        shape(repeatUnreadable.notes, 'locked[.]txt'),
        shape(repeatAbsent.notes, 'absent[.]txt'),
        `a repeated pattern's note count tells unreadable from absent — ${JSON.stringify({
          unreadable: repeatUnreadable.notes, absent: repeatAbsent.notes })}`);
    });
  } finally {
    cleanup();
  }
});

test('an uncompilable pattern is refused in this project\'s words, not V8\'s', () => {  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-disclosure-pattern-')));
  writeFileSync(join(dir, 'ok.txt'), 'OK-BODY');
  try {
    isolated({ GLM_MCP_ROOTS: dir }, () => {
      let ctx;
      const said = toStderr(() => {
        ctx = buildFileContext(['[z-a].txt', 'ok.txt'], dir);
      });
      const note = ctx.notes.find((n) => n.includes('[z-a].txt'));
      assert.ok(note, `the pattern must be reported by name — ${JSON.stringify(ctx.notes)}`);
      for (const engine of ['Invalid regular expression', 'Range out of order', 'SyntaxError']) {
        assert.ok(!note.includes(engine),
          `the note quotes the regex engine (${JSON.stringify(engine)}) at the caller: ${note}`);
      }
      assert.match(note, /malformed/, 'the note must still say the pattern is unusable');
      assert.ok(ctx.text.includes('OK-BODY'),
        `a good file beside an uncompilable pattern must still be read — ${JSON.stringify(ctx.text)}`);
      assert.ok(said.some((line) => line.includes('[z-a].txt') && /Range out of order|Invalid regular expression/.test(line)),
        'the engine\'s own words are the operator\'s diagnostics — stderr, if they are kept at all');
      // The over-correction this file must not make: a refusal names the
      // spelling the CALLER used. That is its own argument coming back, not
      // disclosure, and it is how a caller with ten files learns which one was
      // dropped — the thing #13's notes exist to say (#26's gate asserts it).
      const outside = buildFileContext(['../escape.txt'], dir);
      assert.ok(outside.notes.some((n) => /refused/.test(n) && n.includes('../escape.txt')),
        `a refusal must still name the caller's own spelling — ${JSON.stringify(outside.notes)}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

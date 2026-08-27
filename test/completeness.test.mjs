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
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
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

test('#40 a file that reached the model before the cut is not among the drops, even named again', () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-cap-reached-')));
  try {
    writeFileSync(join(dir, 'small.txt'), 's'.repeat(50));
    writeFileSync(join(dir, 'big.txt'), 'b'.repeat(300));
    writeFileSync(join(dir, 'after.txt'), 'a'.repeat(50));
    // big.txt trips the cap; after.txt falls past it and must be named as
    // not read, while the second small.txt argument is deduplicated into the
    // first's delivered content — it reached the model and must not be
    // reported as a drop.
    const r = ctx(['small.txt', 'big.txt', 'after.txt', 'small.txt'], dir, { GLM_MCP_MAX_FILE_CHARS: '200' });
    assert.ok(r.notes.some((n) => /truncat/i.test(n) && n.includes('big.txt')),
      `big.txt must be where the cut is reported — ${JSON.stringify(r.notes)}`);
    assert.ok(r.notes.some((n) => n.includes('after.txt') && /not read|cap/i.test(n)
      && !/no matches/i.test(n)),
      `after.txt fell past the cap and must be named as not read — ${JSON.stringify(r.notes)}`);
    assert.ok(!r.notes.some((n) => n.includes('small.txt')),
      `a file whose content reached the model must not be named as dropped — ${JSON.stringify(r.notes)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

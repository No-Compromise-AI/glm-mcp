// verify-completeness.mjs — acceptance gate for the last three places a
// glm_ask result could differ from what the caller asked for without saying so
// (#39, #40, #41).
//
// This project's whole posture is that a partial answer must announce itself.
// Confinement refuses loudly, limits name the variable they tripped, the
// disclosure work made every skipped argument produce a note. Three gaps were
// left, found by an outside review of 0.2.0:
//
//   #39  a binary file is decoded as UTF-8 and its mojibake enters the prompt,
//        spending the context budget on bytes the model cannot read, silently.
//   #40  when the char cap cuts the read loop, the note names where it cut and
//        nothing about the files that never made it.
//   #41  an answer that ended because it hit max_tokens is returned looking
//        exactly like one that finished.
//
// #41 is asserted through the MCP tool, not just through ask(): the footer is
// index.ts's to write, and a gate that only exercises the function beneath it
// would pass a server that never tells anyone.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (msg) => { throw new Error(msg); };
const GLM = pathToFileURL(new URL('../dist/glm.js', import.meta.url).pathname).href;
const REPLACEMENT = String.fromCharCode(0xfffd);
const NUL = String.fromCharCode(0);

function ctx(paths, cwd, env = {}) {
  const src = `
import { buildFileContext } from ${JSON.stringify(GLM)};
const c = buildFileContext(${JSON.stringify(paths)}, ${JSON.stringify(cwd)});
process.stdout.write(JSON.stringify({ text: c.text, notes: c.notes }));
`;
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (/^(GLM_MCP_|ZAI_)/.test(k)) delete childEnv[k];
  childEnv.GLM_MCP_ROOTS = cwd;
  for (const [k, v] of Object.entries(env)) childEnv[k] = String(v);
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', src],
    { encoding: 'utf8', env: childEnv, timeout: 20_000, maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

const ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-complete-')));
try {
  // ------------------------------------------------------- #39 binary files
  writeFileSync(join(ROOT, 'blob.bin'), randomBytes(4000));
  writeFileSync(join(ROOT, 'embedded-nul.dat'),
    Buffer.concat([Buffer.from('text'), Buffer.alloc(1), Buffer.from('more')]));
  writeFileSync(join(ROOT, 'source.ts'), 'export const SOURCE = 1;');
  // Text that is NOT binary and must not be mistaken for it: non-ASCII UTF-8
  // is ordinary source in most of the world.
  writeFileSync(join(ROOT, 'accents.ts'), '// naive cafe é 日本語 \u{1F600}\nexport const T = 1;\n');

  let r = ctx(['blob.bin', 'source.ts'], ROOT);
  if (r.text.includes(REPLACEMENT)) {
    const n = r.text.split(REPLACEMENT).length - 1;
    fail(`#39: ${n} replacement characters reached the prompt. A binary file must be skipped, not decoded — it spends the context budget on bytes the model cannot read.`);
  }
  if (!r.notes.some((n) => n.includes('blob.bin'))) {
    fail(`#39: a skipped binary file must be named in notes — ${JSON.stringify(r.notes)}`);
  }
  if (!r.text.includes('SOURCE')) fail(`#39: the source beside a binary file must still be read — ${JSON.stringify(r.text.slice(0, 80))}`);

  r = ctx(['embedded-nul.dat'], ROOT);
  if (r.text.includes(NUL) || r.text.includes(REPLACEMENT)) {
    fail(`#39: a file containing a NUL byte reached the prompt — ${JSON.stringify(r.text.slice(0, 60))}`);
  }

  // The other half of the requirement: do not over-trigger. Accented text,
  // CJK and emoji are valid UTF-8 and are exactly what this tool is for.
  r = ctx(['accents.ts'], ROOT);
  for (const needle of ['cafe', '日本語', '\u{1F600}']) {
    if (!r.text.includes(needle)) {
      fail(`#39 overshoot: valid UTF-8 text was treated as binary — notes=${JSON.stringify(r.notes)}`);
    }
  }

  // ------------------------------------------- #40 what the cap left behind
  const NAMED = ['a1.txt', 'a2.txt', 'a3.txt', 'zz-last.txt'];
  for (const n of NAMED) writeFileSync(join(ROOT, n), 'y'.repeat(400));
  r = ctx(NAMED, ROOT, { GLM_MCP_MAX_FILE_CHARS: 700 });
  if (!r.notes.some((n) => /truncat/i.test(n))) fail(`#40: the cap must still report truncating — ${JSON.stringify(r.notes)}`);
  // Every file the caller named that did not reach the model must be
  // recoverable from the notes. Otherwise the caller cannot retry with a
  // curated list, which is the only useful thing it can do next.
  // ARGUMENT granularity, deliberately, and this is the correction of an
  // earlier version of this gate. Requiring each dropped FILE to be named
  // reopened #26: a file that matched a pattern and was never read can only be
  // named if it exists, so the note became an existence oracle again. What the
  // caller actually needs is to know WHICH OF ITS ARGUMENTS did not fully
  // arrive, so it can curate and retry — and an argument is something it
  // supplied, not something it learns.
  const said = r.notes.join(' ');
  for (const arg of NAMED) {
    const reached = r.text.includes(`--- ${arg} ---`);
    if (!reached && !said.includes(arg)) {
      fail(`#40: the caller named ${arg}, it never reached the model, and no note says so. It is told where the cut began and nothing about what fell past it.\n  notes=${JSON.stringify(r.notes)}`);
    }
  }

  // The same cut, reached through ONE argument instead of four. A pattern's
  // later matches were dropped without a word once any earlier match had been
  // spoken for — the literal case fixed while the glob case stayed open, which
  // is precisely the shape #26 took four rounds to stop repeating.
  const MD = ['a-one.md', 'b-two.md', 'c-three.md'];
  for (const n of MD) writeFileSync(join(ROOT, n), 'm'.repeat(600));
  r = ctx(['*.md'], ROOT, { GLM_MCP_MAX_FILE_CHARS: 1000 });
  const arrived = MD.filter((n) => r.text.includes(`--- ${n} ---`));
  if (arrived.length === MD.length) fail('#40: the cap fixture no longer truncates — it proves nothing');
  if (!r.notes.join(' ').includes('*.md')) {
    fail(`#40: '*.md' did not fully arrive and no note names the pattern, so the caller cannot tell which argument to curate.\n  notes=${JSON.stringify(r.notes)}`);
  }
  // And it must NOT enumerate the matches it did not read: those names exist
  // only because the files do, which is #26's oracle wearing the cap's hat.
  const unread = MD.filter((n) => !arrived.includes(n));
  for (const n of unread) {
    if (r.notes.join(' ').includes(n)) {
      fail(`#40/#26: the note names ${n}, a file that was never read. Naming a pattern's unread matches tells the caller which files exist.\n  notes=${JSON.stringify(r.notes)}`);
    }
  }

  // ------------------------------- #41 an answer that was cut off says so
  // The body text differs per case on purpose. Reusing "cut off mid-sent" for
  // the end_turn probe made the check match the MODEL'S OWN WORDS rather than
  // the footer, so no correct implementation could pass it.
  for (const [reason, mustWarn, answer] of [
    ['max_tokens', true, 'cut off mid-sent'],
    ['end_turn', false, 'an ordinary finished answer'],
  ]) {
    const upstream = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          model: 'glm-5.3',
          stop_reason: reason,
          content: [{ type: 'text', text: answer }],
          usage: { input_tokens: 10, output_tokens: 99 },
        }));
      });
    });
    await new Promise((rr) => upstream.listen(0, '127.0.0.1', rr));
    const origin = `http://127.0.0.1:${upstream.address().port}`;
    const client = new Client({ name: 'glm-mcp-completeness-gate', version: '1.0.0' });
    try {
      await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [new URL('../dist/index.js', import.meta.url).pathname],
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
      // Only the footer is ours to write; the body is whatever the model said.
      // Searching the whole result would let the model's own wording answer for
      // us — which is exactly how the first version of this check went wrong.
      const footer = (text.match(/^\[.*\]$/m) ?? [''])[0];
      if (!footer) fail(`#41: no footer line found in the tool result — ${JSON.stringify(text.slice(-160))}`);
      const warns = /max_tokens|truncated|stopped at|cut off/i.test(footer);
      if (mustWarn && !warns) {
        fail(`#41: the model stopped at max_tokens and the footer says nothing, so the result reads as a finished answer. A caller cannot tell a complete second opinion from a severed one.\n  footer: ${JSON.stringify(footer)}`);
      }
      if (!mustWarn && warns) {
        fail(`#41: a normally finished answer is flagged as truncated — footer: ${JSON.stringify(footer)}`);
      }
    } finally {
      await client.close().catch(() => {});
      upstream.close();
    }
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log('COMPLETENESS OK');

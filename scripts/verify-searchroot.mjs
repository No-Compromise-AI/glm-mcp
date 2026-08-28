// verify-searchroot.mjs — acceptance gate for a caller being able to tell
// "nothing matched" from "the server looked somewhere else" (#67, under #26).
//
// File confinement defaults to the server process's own working directory at
// startup, which is deliberate and correct: a boundary the caller can set is not
// a boundary. But where the server STARTS is the host's choice, not the
// project's — measured with a probe MCP server:
//
//   Claude Code   the project directory
//   Codex         the session directory
//   Antigravity   wherever `agy` itself was invoked, and --add-dir does not change it
//
// So launching from the wrong place and asking for `files: ["src/**/*.ts"]`
// searches a directory the caller never meant. The call SUCCEEDS. The reply
// carries `Notes: skipped (no matches): src/**/*.ts`, which reads as "the model
// had nothing to say about those files" rather than "this server was looking
// somewhere else entirely" — and the two need completely different fixes.
//
// THE CONSTRAINT THAT MAKES THIS HARD, and the reason the issue left it as a
// question rather than a decision: the obvious remedy is to name the root that
// was searched, and #26 forbids exactly that. `verify-disclosure` fails any
// caller-visible message containing this machine's home directory or username —
// and under Antigravity the root IS typically the home directory. So the note
// has to convey which of the two situations the caller is in while naming no
// path at all.
//
// It can, because the distinguishing fact belongs to the CALLER, not the
// machine: did they supply a `cwd`, or did the server fall back to where the
// host happened to launch it? That is something the caller already knows, so
// saying it discloses nothing new — and it is the only thing they need in order
// to know which knob to reach for.
//
// STATED AT THE TOOL, not at buildFileContext. The first draft of this gate
// called buildFileContext directly and could not work: the distinction it tests
// is whether the CALLER supplied `cwd`, and that function receives a resolved
// cwd either way — only the handler knows whether the argument was there. A
// gate written one level too low cannot express the property, and rule 2 below
// now forbids the implementation that a path comparison would produce.
//
// Rules, stated as what a caller receives:
//   1. nothing matched AND no cwd was supplied -> the note says the search ran
//      where the server started, and names the remedies;
//   2. nothing matched AND the caller's own cwd was used -> no such hint. The
//      search happened where they asked, so the extra sentence would be a lie
//      pointing at the wrong fix;
//   3. no note ever carries this machine's home directory, username, or the
//      configured roots (#26). This is the rule the obvious implementation
//      breaks;
//   4. everything #13 and #40 established still holds: the note names the
//      caller's own pattern, and a genuine no-match still reads as no-match.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, homedir, userInfo } from 'node:os';
import { join } from 'node:path';

const fail = (msg) => { throw new Error(msg); };
const INDEX = new URL('../dist/index.js', import.meta.url).pathname;

// `LAUNCH` stands in for the directory a host happened to start the server in —
// the home directory, under Antigravity. `PROJECT` is where the caller means.
const LAUNCH = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-launch-')));
const PROJECT = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-project-')));

let upstream;
let client;

try {
  mkdirSync(join(PROJECT, 'src'), { recursive: true });
  writeFileSync(join(PROJECT, 'src', 'a.ts'), 'export const a = 1;\n');
  mkdirSync(join(LAUNCH, 'other'), { recursive: true });
  writeFileSync(join(LAUNCH, 'other', 'b.ts'), 'export const b = 2;\n');

  upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'm', content: [{ type: 'text', text: 'ok' }], usage: {} }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  // The server is STARTED in LAUNCH, exactly as a host that was invoked
  // elsewhere would start it, and its roots are that same directory.
  client = new Client({ name: 'glm-mcp-searchroot-gate', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [INDEX],
    cwd: LAUNCH,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ZAI_API_KEY: 'dummy-key-for-the-local-server',
      ZAI_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      GLM_MCP_ROOTS: LAUNCH,
    },
  }));

  const notesOf = async (args) => {
    const res = await client.callTool({ name: 'glm_ask', arguments: { prompt: 'hi', model: 'glm-4.6', reasoning: 'none', ...args } });
    const text = res.content?.map((c) => c.text ?? '').join('\n') ?? '';
    const m = text.match(/^Notes: (.*)$/m);
    return { note: m ? m[1] : '', text, isError: !!res.isError };
  };

  // ---- rule 1: no cwd supplied, nothing matched — say where the search ran
  const bare = await notesOf({ files: ['src/**/*.ts'] });
  if (!/no matches/i.test(bare.note)) {
    fail(`#67: expected a no-match note for a pattern that matches nothing where the server was started — got ${JSON.stringify(bare.note || bare.text.slice(-200))}`);
  }
  {
    const explains = /start(ed|up)|launch|where the server|server'?s own|working directory/i.test(bare.note);
    const remedy = /\bcwd\b/i.test(bare.note) && /GLM_MCP_ROOTS/.test(bare.note);
    if (!explains || !remedy) {
      fail(`#67: the note is ${JSON.stringify(bare.note)}. A caller cannot tell that from "the model had nothing to say about those files", and the two need different fixes. With no cwd supplied the search ran wherever the HOST started this server — under Antigravity, wherever \`agy\` was invoked, which --add-dir does not change — so the note has to say the search ran from the server's own startup directory and name the two knobs that move it: cwd and GLM_MCP_ROOTS.`);
    }
  }

  // ---- rule 3: and it says that while naming nothing on this machine
  {
    const secrets = [LAUNCH, homedir(), userInfo().username].filter((s) => s && s.length > 2);
    const leaked = secrets.find((s) => bare.note.includes(s));
    if (leaked) {
      fail(`#67 / #26: the note names ${JSON.stringify(leaked)} — a path on this machine, or the account's own name. That is the disclosure #26 exists to prevent and verify:disclosure fails the build for it. The caller does not need to know WHERE the server looked, only that the place was the server's startup directory rather than anything it chose — which is a fact about its own request.`);
    }
  }

  // ---- rule 2: when the caller SUPPLIED a cwd, no such hint
  // The cwd supplied here is the startup directory itself, which is the point:
  // an implementation that decides by comparing paths cannot tell this case from
  // rule 1 and will wrongly blame the launch directory. Only "was the argument
  // present" distinguishes them, and that is knowable solely at the tool.
  {
    const chosen = await notesOf({ files: ['nothing-here/**/*.ts'], cwd: LAUNCH });
    if (!/no matches/i.test(chosen.note)) {
      fail(`#67: expected a no-match note — got ${JSON.stringify(chosen.note || chosen.text.slice(-200))}`);
    }
    if (/start(ed|up)|launch|where the server/i.test(chosen.note)) {
      fail(`#67: the caller supplied a cwd and the note still blames the server's startup directory — ${JSON.stringify(chosen.note)}. Nothing matched where they asked, which is an ordinary no-match; sending them to cwd and GLM_MCP_ROOTS points at the wrong fix and spends the one signal this change exists to add. Decide by whether the ARGUMENT was supplied, not by comparing it to the startup directory — the two are the same path here, and only the tool knows which happened.`);
    }
  }

  // ---- rule 4: what #13 and #40 established is untouched
  {
    if (!bare.note.includes('src/**/*.ts')) {
      fail(`#67: the note no longer names the caller's own pattern — ${JSON.stringify(bare.note)}. #13 and #40: a caller curates and retries by argument, and the argument is the one thing it already knows.`);
    }
    const found = await notesOf({ files: ['other/**/*.ts'] });
    if (/no matches/i.test(found.note)) {
      fail(`#67: a pattern that DOES match reported no matches — ${JSON.stringify(found.note)}`);
    }
  }
} finally {
  if (client) await client.close().catch(() => {});
  if (upstream) upstream.close();
  rmSync(LAUNCH, { recursive: true, force: true });
  rmSync(PROJECT, { recursive: true, force: true });
}

console.log('SEARCHROOT OK');

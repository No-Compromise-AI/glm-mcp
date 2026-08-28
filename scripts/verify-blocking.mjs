// verify-blocking.mjs — acceptance gate for saying what the limits actually
// bound (#44).
//
// The walk and the reads are readdirSync / statSync / readFileSync. The
// wall-clock budget from #16 is checked BETWEEN operations, and every 64th
// entry within a scan — but no check can fire while a single call is blocked
// inside a syscall. A hung FUSE/NFS/SMB mount freezes the whole server past
// every deadline check, and `GLM_MCP_GLOB_TIMEOUT_MS` bounds work done, not
// time blocked.
//
// The structural answer is a worker thread. That is deliberately NOT what this
// gate asks for: moving buildFileContext off-thread is a large change to the
// path that #52's threads, #53's line numbers and #59's per-model budgets all
// run through, and the issue itself offers documenting the hazard as the
// honest alternative. So this gate is about the documentation being TRUE —
// which is a stronger requirement than it sounds, because a claim about
// behaviour can be checked against the behaviour.
//
// Measured on this machine through the real MCP surface, 4,000 files:
//
//   a trivial call alone                69ms
//   a heavy file-reading call          399ms
//   the same trivial call beside it    394ms   <- delayed 325ms
//
// The trivial call finishes within a few milliseconds of the heavy one it was
// stuck behind. That is the serialisation, and it is what a caller running two
// requests against one server actually experiences.
//
// The rules:
//   1. the README says the glob timeout bounds WORK, not time blocked inside a
//      syscall — the one hazard that cannot be measured from here, since it
//      needs a wedged mount, so it is asserted as documentation and labelled
//      as such;
//   2. the README says a file-reading call delays other calls on the same
//      server;
//   3. and rule 2's claim is TRUE: measured, a trivial call issued beside a
//      file-reading one finishes with it rather than at its own latency.
//
// Rules 2 and 3 together are a biconditional, which is the point. Make the
// reads asynchronous later and rule 3 stops holding, so the README must stop
// claiming it — the gate forces the documentation to follow the code. Soften
// the documentation without fixing the code and rule 2 catches that instead.
// Neither half can drift alone.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fail = (msg) => { throw new Error(msg); };
const INDEX = new URL('../dist/index.js', import.meta.url).pathname;
const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

// ---- rule 1: the hazard that cannot be measured from here
// A wedged mount is the case this is about and there is no portable way to
// stage one, so this half is documentation asserted as documentation rather
// than dressed up as a measurement.
{
  const claims = /bounds? (the )?work|work (it )?does,? not|not (the )?time (spent )?blocked|cannot (fire|interrupt)|inside a (single )?syscall|blocked in a syscall/i.test(README);
  if (!claims) {
    fail('#44: the README does not say that GLM_MCP_GLOB_TIMEOUT_MS bounds the WORK a walk does rather than the time it can spend blocked inside a syscall. An operator reading it as a wall-clock guarantee will believe a hung mount is bounded, and it is not — the deadline is checked between operations, so a single blocked readdirSync outlasts every check.');
  }
}

// ---- rule 2: the README says a file-reading call delays other calls
const claimsSerialisation =
  /(serialis|serializ)|blocks? (the )?event loop|one call at a time|delays? other|other calls? wait|concurrent calls?/i.test(README);
if (!claimsSerialisation) {
  fail('#44: the README says nothing about a file-reading call delaying other calls on the same server. Measured here: a trivial call that takes 69ms alone takes 394ms when issued beside a call that reads a tree — it finishes with the heavy call rather than on its own schedule. Someone running one server for several agents needs to know that.');
}

// ---- rule 3: and that claim is true
const ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), 'glm-blocking-')));
let upstream;
let client;
try {
  // Enough bytes that reading them is clearly longer than an empty call, built
  // as fewer-but-larger files so the fixture itself is quick to lay down.
  mkdirSync(join(ROOT, 'src'), { recursive: true });
  const line = 'export const filler = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";\n';
  const body = line.repeat(3_000);
  for (let i = 0; i < 400; i++) writeFileSync(join(ROOT, 'src', `f${i}.ts`), body);

  // The upstream answers instantly, so every millisecond measured below is the
  // server's own doing rather than the model's.
  upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'm', content: [{ type: 'text', text: 'ok' }], usage: {} }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  client = new Client({ name: 'glm-mcp-blocking-gate', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [INDEX],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ZAI_API_KEY: 'dummy-key-for-the-local-server',
      ZAI_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      GLM_MCP_ROOTS: ROOT,
      GLM_MCP_MAX_FILE_CHARS: '80000000',
    },
  }));

  const trivial = () => client.callTool({ name: 'glm_ask', arguments: { prompt: 'hi', model: 'glm-4.6', reasoning: 'none' } });
  const heavy = () => client.callTool({ name: 'glm_ask', arguments: { prompt: 'heavy', model: 'glm-5.3', reasoning: 'none', files: ['src/**/*.ts'], cwd: ROOT } });

  await trivial();                       // warm the process, so the first read is not the JIT's
  let t = Date.now();
  await trivial();
  const solo = Date.now() - t;

  // Time each call INDIVIDUALLY while both are in flight. An earlier draft
  // compared the pair's total against the heavy call's, and could not
  // discriminate: with an instant upstream a trivial call costs 3ms against a
  // heavy one's 700ms, so "ran concurrently" and "ran back to back" differ by
  // less than the clock's noise. What separates them is the TRIVIAL call's own
  // latency — 3ms if it was served while the read was in progress, the length
  // of the read if it was not.
  t = Date.now();
  const hp = heavy().then(() => Date.now() - t);
  const lp = trivial().then(() => Date.now() - t);
  const [heavyMs, trivialMs] = await Promise.all([hp, lp]);

  // A generous threshold: held up means many times its own cost, not a few
  // milliseconds more. On a machine where the read is somehow instant this
  // reports "not serialised", which is the honest answer there.
  const serialised = trivialMs > Math.max(solo * 4, solo + 50);

  if (!serialised) {
    fail(`#44: the README claims a file-reading call delays other calls, and here it did not. Measured: a trivial call alone ${solo}ms; issued beside a ${heavyMs}ms file-reading call it took ${trivialMs}ms, which is its own latency rather than the read's. If the reads became asynchronous, that is good news and the README has to stop saying otherwise — a document that overstates a limitation sends people to work around a problem they no longer have.`);
  }
  if (trivialMs > heavyMs * 1.5 + 200) {
    fail(`#44: the trivial call took ${trivialMs}ms against the heavy call's ${heavyMs}ms — far longer than the work it was waiting behind. This gate is measuring something other than the serialisation it thinks it is.`);
  }

  // ---- rule 4: a number the README states must be the number a run produces
  // Two review rounds found the same class of defect here — a figure quoted
  // under conditions that do not produce it. First "400 files (79 MB)" when the
  // cap admitted 375; then "cut at the 376th file, never read the last 24" for
  // a cap described as the bytes on disk, when 376/24 is the answer for a
  // DIFFERENT cap and the bytes-on-disk cap gives 372/28. Patching the second
  // number invites a third, so the rule is the class: whatever cutoff the
  // README claims, a run at the cap it names must produce it.
  //
  // Everything is derived from the fixture above rather than written down, so
  // changing the fixture moves the expectation with it instead of stranding it.
  {
    // Whitespace-normalised: the claim wraps across a line break in the
    // README, and a regex that cannot see past a newline would report the
    // sentence missing rather than checking it.
    const flat = README.replace(/\s+/g, ' ');
    const claim = /cut this walk at the (\d+)(?:st|nd|rd|th) file and never read the last (\d+)/i.exec(flat);
    if (!claim) {
      fail('#44: the README no longer states, in a form this gate can read, what a cap sized to the bytes on disk cuts. That exact claim is what two review rounds got wrong, so it may not quietly become unreadable — restate it in the same shape, or remove it and remove this rule with it.');
    }
    const claimedCutAt = Number(claim[1]);
    const claimedUnread = Number(claim[2]);

    const FILES = 400;
    const onDisk = FILES * body.length;

    // Measured at exactly the cap the README names, through the same
    // buildFileContext the server uses.
    const probe = execFileSync(process.execPath, ['--input-type=module', '-e', `
import { buildFileContext } from ${JSON.stringify(pathToFileURL(new URL('../dist/glm.js', import.meta.url).pathname).href)};
process.env.GLM_MCP_ROOTS = ${JSON.stringify(ROOT)};
const c = buildFileContext(['src/**/*.ts'], ${JSON.stringify(ROOT)}, 'glm-5.3');
const headers = c.text.match(/^--- .*? ---$/gm) ?? [];
const truncated = c.text.match(/^--- .*? \(truncated\) ---$/gm) ?? [];
process.stdout.write(JSON.stringify({ headers: headers.length, truncated: truncated.length }));
`], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
      env: { ...process.env, GLM_MCP_ROOTS: ROOT, GLM_MCP_MAX_FILE_CHARS: String(onDisk) } });
    const { headers, truncated } = JSON.parse(probe);
    const complete = headers - truncated;
    const cutAt = complete + 1;
    const unread = FILES - complete - truncated;

    // `unread` is unambiguous and strict. The cutoff INDEX is not: "cut at the
    // Nth file" can honestly mean the last one read or the first one missed,
    // and a gate that insists on one reading sets an off-by-one trap rather
    // than checking a fact. Either neighbour is accepted; the count is not.
    const cutoffPlausible = claimedCutAt === complete || claimedCutAt === complete + 1;
    if (!cutoffPlausible || unread !== claimedUnread) {
      fail(`#44: the README says a cap sized to the bytes on disk (${onDisk}) cuts at file ${claimedCutAt} and leaves ${claimedUnread} unread. Measured at exactly that cap: ${complete} files delivered, ${unread} never read — so the cutoff is file ${complete} or ${cutAt} depending on how you count it, and the unread count is ${unread}. A figure quoted under conditions that do not produce it is the defect two review rounds already found here — first as "400 files" under a cap admitting 375, then as 376/24, which is another cap's answer.`);
    }
  }

} finally {
  if (client) await client.close().catch(() => {});
  if (upstream) upstream.close();
  rmSync(ROOT, { recursive: true, force: true });
}

console.log('BLOCKING OK');

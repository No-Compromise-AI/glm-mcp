// verify-vision.mjs — acceptance gate for the second item of #56: an image can
// actually reach a vision model.
//
// `OUTPUT_LIMITS` has tracked `vision: true` since #45, and every one of those
// rows says the same thing in its role text — "this server sends text only, so
// its image modality goes unused". Selecting a vision model therefore bought
// nothing: it silently forwent the model's only distinguishing feature.
// "Review this screenshot against the code" is ordinary consultant work.
//
// THE PROPERTY, at the tool boundary:
//
//   An image reaches a model that can see it, under the same confinement as any
//   other file — and a model that cannot see it is TOLD, never answered blind.
//
// The second half is the one worth gating hardest. A caller who attaches a
// screenshot and gets prose back has no way to know the image was dropped; the
// answer reads like an answer. That is the same silent-failure shape as
// answering with no file context, and it gets the same refusal.
//
// RULES
//   1. An image reaches a vision model as an IMAGE content block, with the
//      media type sniffed from the bytes.
//   2. FORBID THE WRONG FIX: it is not smuggled into the prompt as text. A
//      base64 blob in a text block is not an image to the model — it is a very
//      expensive string that looks like progress.
//   3. CONFINEMENT HOLDS: an image outside the operator's roots is refused and
//      its bytes do not reach the request. Images are files, and adding a
//      second way to read files that skipped the boundary would undo it.
//   4. A NON-VISION model plus an image is REFUSED, naming the model. Dropping
//      it and answering anyway is the silent failure this feature exists to
//      remove — it would leave the caller exactly where they were, but now
//      believing the picture had been looked at.
//   5. The existing byte limit applies. An oversized image is refused by
//      GLM_MCP_MAX_FILE_BYTES, the limit already in place for files, rather
//      than by a second number invented for images.
//   6. A file that is not an image is refused, named, and not sent. Guessing a
//      media type produces a 400 from the vendor after the round trip, and a
//      confusing one.
//   7. CONTROL: with no image, the request is shaped exactly as before — a
//      plain string content, not a one-element block array. Every existing
//      caller is on that path and must not be able to tell this exists.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fail = (msg) => { throw new Error(msg); };
const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
if (!existsSync(ENTRY)) fail('rule 0: dist/index.js does not exist — run `npm run build` first');

let checks = 0;
const check = (ok, msg) => { checks++; if (!ok) fail(msg); };

const seen = [];
const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    try { seen.push(JSON.parse(body)); } catch { seen.push({ unparsed: body }); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'm', type: 'message', role: 'assistant', model: 'glm-4.6v',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${upstream.address().port}`;

const roots = mkdtempSync(join(tmpdir(), 'glm-vision-gate-'));
// A real 1x1 PNG: the magic bytes matter, because the media type is sniffed.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
writeFileSync(join(roots, 'shot.png'), PNG);
writeFileSync(join(roots, 'notes.txt'), 'this is plainly not an image\n');
writeFileSync(join(roots, 'huge.png'), Buffer.concat([PNG, Buffer.alloc(2_000_000, 7)]));
const outside = mkdtempSync(join(tmpdir(), 'glm-vision-outside-'));
writeFileSync(join(outside, 'private.png'), Buffer.concat([PNG, Buffer.from('OPERATOR_PRIVATE_PIXELS')]));

function run(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [ENTRY, ...args], {
      cwd: roots,
      env: { ...process.env, ZAI_API_KEY: 'k', ZAI_BASE_URL: origin, GLM_MCP_ROOTS: roots, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
const sent = () => seen[0] ?? {};
const lastContent = () => {
  const msgs = sent().messages ?? [];
  return msgs.length ? msgs[msgs.length - 1].content : undefined;
};

// Rules 1 and 2 — it arrives as an image, not as a very expensive string.
seen.length = 0;
const r1 = await run(['ask', '--model', 'glm-4.6v', '--image', 'shot.png', 'what is in this?']);
check(r1.code === 0, `rule 1: exited ${r1.code}. stderr:\n${r1.err.slice(-700)}`);
{
  const content = lastContent();
  check(Array.isArray(content),
    `rule 1: with an image the final turn's content must be a block ARRAY; it was ` +
    `${typeof content}. Sent:\n${JSON.stringify(sent()).slice(0, 400)}`);
  const blocks = Array.isArray(content) ? content : [];
  const img = blocks.find((b) => b?.type === 'image');
  check(img !== undefined,
    `rule 1: no image block reached the request. Blocks were: ${JSON.stringify(blocks.map((b) => b?.type))}`);
  check(img?.source?.media_type === 'image/png',
    `rule 1: the media type must be sniffed from the bytes; got ${JSON.stringify(img?.source?.media_type)}`);
  check(typeof img?.source?.data === 'string' && img.source.data.length > 0,
    'rule 1: the image block carries no data');
  const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('');
  check(!/iVBORw0KGgo/.test(text),
    'rule 2: the image was ALSO smuggled into the prompt as base64 text. A blob in a text block is ' +
    'not an image to the model — it is a very expensive string that looks like progress.');
  check(/what is in this\?/.test(text), `rule 2: the question must still be sent. Text was: ${JSON.stringify(text).slice(0, 200)}`);
}

// Rule 3 — images are files, and the boundary still holds.
{
  seen.length = 0;
  const r = await run(['ask', '--model', 'glm-4.6v', '--image', join(outside, 'private.png'), 'q']);
  check(!JSON.stringify(sent()).includes(Buffer.from('OPERATOR_PRIVATE_PIXELS').toString('base64').slice(0, 12)),
    `rule 3: an image OUTSIDE the operator's roots reached the vendor. Adding a second way to read ` +
    `files that skips confinement undoes the boundary this server is built on.`);
  check(/root|confin|outside|allowed/i.test(r.out + r.err),
    `rule 3: it must say the image was refused. Output:\n${(r.out + r.err).slice(0, 500)}`);
}

// Rule 4 — a model that cannot see it must say so.
{
  seen.length = 0;
  const r = await run(['ask', '--model', 'glm-5.2', '--image', 'shot.png', 'q']);
  check(r.code !== 0,
    `rule 4: sending an image to a NON-VISION model must be refused; it exited ${r.code}. Dropping ` +
    `the image and answering anyway leaves the caller believing the picture was looked at, which is ` +
    `worse than where they started.`);
  check(seen.length === 0, `rule 4: nothing should have been asked at all; ${seen.length} request(s) sent`);
  check(/glm-5\.2/.test(r.err),
    `rule 4: the refusal must name the model, so the caller knows what to change. stderr:\n${r.err.slice(-400)}`);
}

// Rule 5 — the limit that already exists.
{
  seen.length = 0;
  const r = await run(['ask', '--model', 'glm-4.6v', '--image', 'huge.png', 'q'],
    { env: { GLM_MCP_MAX_FILE_BYTES: '1000' } });
  check(seen.length === 0 || !JSON.stringify(sent()).includes('BwcHBwcH'),
    'rule 5: an oversized image was sent. GLM_MCP_MAX_FILE_BYTES is the limit already in place for ' +
    'files, and images are files — a second number invented for them is one more thing to drift.');
  check(/GLM_MCP_MAX_FILE_BYTES|too large/i.test(r.err),
    `rule 5: the refusal must name the limit that stopped it. stderr:\n${r.err.slice(-400)}`);
}

// Rule 6 — a non-image is refused rather than guessed at.
{
  seen.length = 0;
  const r = await run(['ask', '--model', 'glm-4.6v', '--image', 'notes.txt', 'q']);
  check(r.code !== 0 || seen.length === 0,
    'rule 6: a file that is not an image was sent anyway. Guessing a media type earns a 400 from the ' +
    'vendor after the round trip, and a confusing one.');
  check(/notes\.txt/.test(r.err),
    `rule 6: the refusal must name the file. stderr:\n${r.err.slice(-400)}`);
}

// Rule 7 — CONTROL: nothing changes for callers who send no image.
{
  seen.length = 0;
  const r = await run(['ask', 'just a question']);
  check(r.code === 0, `rule 7: exited ${r.code}`);
  check(typeof lastContent() === 'string',
    `rule 7: with no image the final turn's content must stay a plain STRING, exactly as before — ` +
    `every existing caller is on that path and must not be able to tell this feature exists. It was ` +
    `${JSON.stringify(lastContent()).slice(0, 200)}`);
}

upstream.close();
console.log(`VISION OK (${checks} checks)`);

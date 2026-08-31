// verify-filter.mjs — acceptance gate for the first item of #56: a content
// filter over glob expansion.
//
// THE CURATION PARADOX it answers, in the issue's words: a caller must choose
// the files *before* knowing which ones matter — but retrieval is part of the
// expertise being consulted for. Ask "where does this invariant break" and the
// caller is pre-guessing the file set; guess wrong and the consultant answers
// from the wrong shelf.
//
// This is the cheap rung: `-f 'src/**/*.ts' --include refreshToken` expands the
// glob as before and then sends only the files whose CONTENT mentions the term.
// It is also the latency lever the issue points at — every file it drops is
// prefill that is never paid for.
//
// THE PROPERTY, at the tool boundary:
//
//   `include` decides which of the expanded files are sent, by what is IN them,
//   before the budget is spent — and says what it dropped.
//
// The last clause matters as much as the first. A filter that silently sends
// less than the caller asked for is the same class of defect as a truncation
// nobody is told about: the answer looks complete and was formed from a subset
// nobody chose.
//
// RULES
//   1. A matching file is sent; a non-matching one is not.
//   2. It matches CONTENT, not the path. A file whose NAME contains the term
//      and whose body does not is dropped — otherwise the feature quietly
//      becomes a second, worse glob.
//   3. What was dropped is SAID, with the term, so a thin answer can be
//      explained without re-running anything.
//   4. The filter runs BEFORE the budget. A large non-matching file must not
//      crowd out a small matching one — spending the cap on files that were
//      going to be discarded is the latency win thrown away, and at a tight cap
//      it silently loses the file the caller actually wanted.
//   5. Nothing matched is a REFUSAL, not an empty answer. Answering a question
//      with none of the material it was about is a silent failure wearing a
//      success — the same refusal buildFileContext already makes when it reads
//      nothing.
//   6. CONTROL: without `include`, every file arrives exactly as before.
//   7. FORBID THE WRONG FIX: the term is a literal substring, not a regex. This
//      repo has a ReDoS gate for the patterns it already accepts; adding a
//      caller-supplied regex over file contents would open the same hole in a
//      new place. A regex-shaped term matches only files containing it
//      literally.
//
// Driven through the CLI (#55), which is the entry point a shell caller uses
// and the same code the MCP tool calls — the end-to-end testability that issue
// claimed, collected here.
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
      id: 'm', type: 'message', role: 'assistant', model: 'glm-5.3',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${upstream.address().port}`;

const roots = mkdtempSync(join(tmpdir(), 'glm-filter-gate-'));
writeFileSync(join(roots, 'auth.ts'), 'export function rotate() { return refreshToken(); }\n');
writeFileSync(join(roots, 'unrelated.ts'), 'export const COLOURS = ["red", "green"];\n');
// Rule 2's case: the NAME says refreshToken, the body says nothing of the kind.
writeFileSync(join(roots, 'refreshToken-notes.ts'), 'export const UNRELATED_BODY = 1;\n');
// Rule 4's case: large, and not a match.
writeFileSync(join(roots, 'bulky.ts'), `export const PAD = "${'x'.repeat(200_000)}";\n`);

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
const sent = () => JSON.stringify(seen[0] ?? {});

// Rules 1 and 2 — content decides, not the name.
seen.length = 0;
const r1 = await run(['ask', '-f', '*.ts', '--include', 'refreshToken', 'q']);
check(r1.code === 0, `rule 1: exited ${r1.code}. stderr:\n${r1.err.slice(-700)}`);
check(sent().includes('rotate'),
  `rule 1: the MATCHING file must be sent. Request was:\n${sent().slice(0, 500)}`);
check(!sent().includes('COLOURS'),
  `rule 1: a non-matching file must NOT be sent — dropping it is the whole feature, and the ` +
  `prefill it saves is the latency win. Request was:\n${sent().slice(0, 500)}`);
check(!sent().includes('UNRELATED_BODY'),
  `rule 2: the term must match CONTENT, not the path. refreshToken-notes.ts has the term in its ` +
  `NAME and not in its body; sending it makes this a second, worse glob. Request was:\n${sent().slice(0, 500)}`);

// Rule 3 — and it says what it dropped.
check(/include|filter/i.test(r1.err) && /refreshToken/.test(r1.err),
  `rule 3: it must SAY that files were dropped and name the term, so a thin answer can be ` +
  `explained without re-running anything. stderr was:\n${r1.err.slice(-700)}`);

// Rule 4 — the filter runs before the budget.
{
  seen.length = 0;
  // A cap with room for the small matching file but not the bulky one. If the
  // filter ran after the budget, the padding would have eaten the room first.
  const r = await run(['ask', '-f', '*.ts', '--include', 'refreshToken', 'q'],
    { env: { GLM_MCP_MAX_FILE_CHARS: '4000' } });
  check(r.code === 0, `rule 4: exited ${r.code}. stderr:\n${r.err.slice(-500)}`);
  check(sent().includes('rotate'),
    `rule 4: the matching file must survive a cap that the DISCARDED files would have exhausted. ` +
    `Filtering after the budget spends the cap on files that were going to be thrown away, and at a ` +
    `tight cap loses the one the caller wanted. Request was:\n${sent().slice(0, 400)}`);
  check(!sent().includes('xxxxxxxxxx'),
    'rule 4: the bulky non-matching file reached the request.');
}

// Rule 5 — nothing matched is a refusal.
{
  seen.length = 0;
  const r = await run(['ask', '-f', '*.ts', '--include', 'nothing-contains-this-string', 'q']);
  check(r.code !== 0,
    `rule 5: when the filter matches nothing, the call must be REFUSED, not answered with no ` +
    `context; it exited ${r.code}. Answering a question with none of the material it was about is ` +
    `a silent failure wearing a success.`);
  check(seen.length === 0,
    `rule 5: nothing should have been asked of the model at all; ${seen.length} request(s) were sent.`);
  check(/nothing-contains-this-string/.test(r.err),
    `rule 5: the refusal must name the term that matched nothing. stderr was:\n${r.err.slice(-500)}`);
}

// Rule 6 — CONTROL: without the filter, nothing changes.
{
  seen.length = 0;
  const r = await run(['ask', '-f', 'auth.ts', 'unrelated.ts', 'q']);
  check(r.code === 0, `rule 6: exited ${r.code}`);
  check(sent().includes('rotate') && sent().includes('COLOURS'),
    `rule 6: with no --include every named file must still arrive. Request was:\n${sent().slice(0, 400)}`);
}

// Rule 7 — FORBID THE WRONG FIX: a literal substring, never a regex.
{
  writeFileSync(join(roots, 'literal.ts'), 'export const X = "re.*Token was written literally";\n');
  seen.length = 0;
  const r = await run(['ask', '-f', '*.ts', '--include', 're.*Token', 'q']);
  check(r.code === 0,
    `rule 7: a regex-shaped term must be treated as a literal and match the file containing it; ` +
    `exited ${r.code}. stderr:\n${r.err.slice(-500)}`);
  check(sent().includes('written literally'),
    `rule 7: "re.*Token" must match the file whose text contains it literally. Request:\n${sent().slice(0, 400)}`);
  check(!sent().includes('rotate'),
    'rule 7: the term was evaluated as a REGEX — it matched refreshToken. A caller-supplied regex ' +
    'over file contents opens the same ReDoS hole this repo already keeps a gate for, in a new ' +
    'place. Substring, deliberately.');
}

upstream.close();
console.log(`FILTER OK (${checks} checks)`);

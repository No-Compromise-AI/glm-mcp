// verify-docs.mjs — acceptance gate for the README describing the server that
// actually exists (#71, and the hole that let 0.5.0 ship undocumented).
//
// 0.5.0 shipped `glm_review` — a new public tool, the headline of the release —
// and the README did not contain the string `glm_review` even once. Eighteen
// gates passed on that commit. Every one of them checked behaviour; not one
// checked that the behaviour was written down, so the omission was invisible
// right up until someone went looking for the docs.
//
// The README is not commentary on this package, it is its interface. A caller
// cannot discover a tool by reading `src/index.ts`; npm renders the README and
// that is the whole of what they get. An undocumented tool ships as a tool
// nobody can find.
//
// Written as rules about the LIVE server rather than a list of tool names: the
// tools are read from a running instance over MCP, and the environment
// variables from the source that reads them. Add a third tool tomorrow and this
// gate covers it without being edited — which is the only version of this check
// worth having, since a hand-maintained list is the same omission in a new place.
//
//   1. Every tool the server ADVERTISES has its own README heading. Not a
//      passing mention — a heading, because that is what makes it findable and
//      what the existing two tools already have.
//   2. Every PARAMETER of every advertised tool is named inside that tool's own
//      section. A tool documented as a title with no arguments tells a caller
//      it exists and nothing about how to call it.
//   3. Each tool's section carries real content — table or prose, both count.
//      This forbids the wrong fix: a bare heading satisfies rule 1, and
//      satisfies rule 2 vacuously for a tool that takes no arguments, while
//      documenting nothing. It is the same principle glm_review enforces on its
//      own reviewers — a heading with nothing under it is a rubber stamp.
//   4. Every GLM_* environment variable the SOURCE reads appears in the README.
//      A knob nobody can discover is a knob that does not exist, and this is
//      exactly how GLM_REVIEW_MIN_SUBSTANCE — the floor the whole review tool
//      rests on — went unmentioned.
//
// A structural change this gate cannot read is a failure, not a pass.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync, readdirSync } from 'node:fs';

const fail = (msg) => { throw new Error(msg); };
const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

// ------------------------------------------------------- the live tool surface
// Read from a running server. The point of this gate is that nothing here is
// restated: a list of tool names maintained beside the server is the same class
// of omission it exists to catch.
const client = new Client({ name: 'verify-docs', version: '1' }, { capabilities: {} });
let tools;
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../dist/index.js', import.meta.url).pathname],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ZAI_API_KEY: 'dummy-key-no-request-is-made',
    },
  }));
  tools = (await client.listTools()).tools;
} finally {
  await client.close().catch(() => {});
}
if (!tools?.length) fail('the server advertised no tools — this gate can no longer read what it must check');

// A tool's section: from its heading to the next heading at the same level or
// higher. Anything looser would let one tool's prose satisfy another's rules.
function sectionFor(name) {
  const lines = README.split('\n');
  const start = lines.findIndex((l) => /^#{2,4}\s/.test(l) && l.includes(name));
  if (start < 0) return null;
  const level = lines[start].match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return { heading: lines[start], body: lines.slice(start + 1, end).join('\n') };
}

let checks = 0;
const check = (ok, msg) => { checks++; if (!ok) fail(msg); };

for (const tool of tools) {
  // 1 — a heading, not a passing mention.
  const section = sectionFor(tool.name);
  check(section !== null,
    `rule 1: the server advertises "${tool.name}" and the README has no heading for it. The README is this package's interface — npm renders it and that is the whole of what a caller gets, so an undocumented tool ships as a tool nobody can find`);

  // 2 — every parameter named, inside that tool's own section.
  const params = Object.keys(tool.inputSchema?.properties ?? {});
  const missing = params.filter((p) => !new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(section.body));
  check(missing.length === 0,
    `rule 2: "${tool.name}" accepts ${missing.join(', ')} and its README section never names ${missing.length > 1 ? 'them' : 'it'} — a caller is told the tool exists and not how to call it`);

  // 3 — the section says something. Counted over the WHOLE section, tables
  // included: glm_ask is documented by a parameter table and glm_models by
  // prose, and both are documentation. An earlier draft of this rule measured
  // prose with tables stripped and failed glm_ask, which was the gate being
  // wrong about the README rather than the README being wrong.
  const content = section.body.replace(/\s+/g, '').length;
  check(content >= 150,
    `rule 3: "${tool.name}"'s README section holds ${content} non-whitespace characters. A bare heading satisfies rules 1 and 2 — rule 2 vacuously, for a tool that takes no arguments — while documenting nothing`);
}

// ------------------------------------------------------------------- rule 4
// The knobs the code actually reads, from the code that reads them.
const srcDir = new URL('../src/', import.meta.url);
const read = new Set();
for (const f of readdirSync(srcDir)) {
  if (!f.endsWith('.ts')) continue;
  const text = readFileSync(new URL(f, srcDir), 'utf8');
  for (const m of text.matchAll(/process\.env\.(GLM_[A-Z0-9_]+)/g)) read.add(m[1]);
  for (const m of text.matchAll(/envLimit\(\s*["'](GLM_[A-Z0-9_]+)["']/g)) read.add(m[1]);
}
if (read.size === 0) fail('rule 4: found no GLM_* variables in src/ — this gate can no longer read what it must check');

const undocumented = [...read].filter((v) => !README.includes(v)).sort();
check(undocumented.length === 0,
  `rule 4: the source reads ${undocumented.join(', ')} and the README never mentions ${undocumented.length > 1 ? 'them' : 'it'}. A knob nobody can discover is a knob that does not exist`);

console.log(`verify-docs: ${checks} checks passed over ${tools.length} tools (${tools.map((t) => t.name).join(', ')}) and ${read.size} environment variables`);

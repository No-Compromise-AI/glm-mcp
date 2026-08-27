// verify-supplychain.mjs — acceptance gate for #23: what a fresh install
// actually runs.
//
// CI tests an exact dependency graph and then ships something else. The
// lockfile is not published, the runtime deps float on carets, and the
// documented install is `npx -y ...` with no version — so the graph a user
// executes on Tuesday is whatever the registry resolved that morning, with no
// signal here if it changed. This server holds a z.ai key and reads the
// filesystem; the dependency graph is part of its attack surface.
//
// The half this gate does NOT cover: @modelcontextprotocol/sdk pulls a full
// HTTP stack into a stdio-only server. That is an upstream shape, not ours to
// fix, and #23 says so.
import { readFileSync, existsSync } from 'node:fs';

const fail = (msg) => { throw new Error(msg); };
const at = (p) => new URL(`../${p}`, import.meta.url).pathname;
const read = (p) => readFileSync(at(p), 'utf8');
const pkg = JSON.parse(read('package.json'));

// ------------------------------------------------- 1. runtime deps are exact
// A caret is a promise to run code nobody here has reviewed. Exact versions
// mean the graph CI tested is the graph that runs.
for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(range)) {
    fail(`#23: dependency ${name} is "${range}" — a range, so a fresh install can resolve to something this repository never tested. Pin it exactly.`);
  }
}

// devDependencies may float: they never reach a user's machine.

// ------------------------------------- 2. consumers get the reviewed graph
// package-lock.json is not consumed transitively, and is not published either.
// npm-shrinkwrap.json is the one lockfile npm honours for a dependency.
if (!existsSync(at('npm-shrinkwrap.json'))) {
  fail('#23: no npm-shrinkwrap.json — package-lock.json binds this repository only and is not published, so a consumer resolves the graph afresh');
}
if (!(pkg.files ?? []).includes('npm-shrinkwrap.json')) {
  // npm publishes it regardless, but an explicit `files` entry is what stops
  // a later edit to that list from silently dropping it.
  fail(`#23: npm-shrinkwrap.json is not named in "files" (${JSON.stringify(pkg.files)}) — a later edit there would drop it without a word`);
}

const shrink = JSON.parse(read('npm-shrinkwrap.json'));
if (shrink.version !== pkg.version) {
  fail(`#23: npm-shrinkwrap.json says ${shrink.version}, package.json says ${pkg.version} — a stale shrinkwrap ships the wrong graph`);
}
if (shrink.lockfileVersion < 2) {
  fail(`#23: lockfileVersion ${shrink.lockfileVersion} predates integrity metadata`);
}

// Every third-party package in the shipped graph carries an integrity hash, so
// a substituted tarball fails to install rather than executing.
const packages = shrink.packages ?? {};
const missing = [];
for (const [path, entry] of Object.entries(packages)) {
  if (path === '') continue;                       // the root package itself
  if (entry.link) continue;                        // workspace links resolve locally
  if (entry.dev) continue;                         // dev graph never reaches a user
  if (!entry.integrity && entry.resolved) missing.push(path);
}
if (missing.length > 0) {
  fail(`#23: ${missing.length} runtime package(s) in the shrinkwrap have no integrity hash: ${missing.slice(0, 5).join(', ')}`);
}

// The runtime deps must actually appear in the shipped graph, or the
// shrinkwrap is describing a different tree than the one being published.
for (const name of Object.keys(pkg.dependencies ?? {})) {
  if (!Object.keys(packages).some((p) => p === `node_modules/${name}`)) {
    fail(`#23: ${name} is a runtime dependency but is absent from npm-shrinkwrap.json`);
  }
}

// --------------------------------------- 3. the documented install is pinned
// The README is where the install actually comes from. `npx -y <pkg>` resolves
// `latest` at run time and `-y` suppresses the prompt that would otherwise be
// the last chance to notice.
const readme = read('README.md');
for (const m of readme.matchAll(/npx[^\n`]*@nocompromiseai\/glm-mcp(@[^\s`]+)?/g)) {
  if (!m[1]) {
    fail(`#23: the README documents an unpinned install — ${JSON.stringify(m[0].trim())}. Name a version, so a reader copies a known graph rather than whatever resolves today.`);
  }
}
if (!/@nocompromiseai\/glm-mcp@\d+\.\d+\.\d+/.test(readme)) {
  fail('#23: the README shows no pinned install at all');
}

// A pinned example that names a version this package has never published
// would be worse than none.
const shown = [...readme.matchAll(/@nocompromiseai\/glm-mcp@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
for (const v of new Set(shown)) {
  if (v !== pkg.version) {
    fail(`#23: the README pins ${v} but this package is ${pkg.version} — the documented install drifts from the release it ships with`);
  }
}

// ------------------------------------- 4. the version lives in one place
// A literal version in the server drifts from the manifest on every release,
// and a server misreporting itself is the kind of thing nobody notices until
// they are debugging something else.
const indexSrc = read('src/index.ts');
const literal = /version:\s*["']\d+\.\d+\.\d+["']/.exec(indexSrc);
if (literal) {
  fail(`#45: src/index.ts hardcodes ${literal[0]} — read it from package.json so a bump cannot leave it behind`);
}

console.log('SUPPLY OK');

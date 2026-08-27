// verify-release.mjs — acceptance gate for the release pipeline's security
// properties (#21, #27).
//
// publish.yml's header states its own threat model: "the credentialed job never
// runs repository code", because anything executing in the job that holds
// `id-token: write` can mint an OIDC token and publish under this package. The
// header is prose; this file is the executable form of it, so a future edit
// that quietly breaks one of those properties fails here rather than at the one
// moment nobody is watching — a release.
//
// Checked, per property, against the committed workflows:
//   #21  nothing unpinned executes in the credentialed job
//   #27  the tarball's digest is recorded where it is built and re-checked
//        before it is staged, and the release gate is no weaker than CI
//   plus  the properties the file already claims: no checkout in the publish
//        job, every action SHA-pinned
//
// A structural change that this parser cannot read is a failure, not a pass:
// silently skipping a check would be worse than not having it.
import { readFileSync } from 'node:fs';

const fail = (msg) => { throw new Error(msg); };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/**
 * The workflow's jobs, as raw text blocks. Jobs are the two-space keys under
 * `jobs:`; a block runs until the next key at that indent. Enough structure for
 * the questions below, and it refuses to guess when the shape is unfamiliar.
 */
function jobsOf(yaml, file) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) fail(`${file}: no top-level 'jobs:' key — this gate can no longer read the file, which is a failure, not a pass`);
  const jobs = new Map();
  let name = null;
  let body = [];
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      if (name) jobs.set(name, body.join('\n'));
      name = header[1];
      body = [];
      continue;
    }
    if (/^\S/.test(line) && line.trim() !== '') break; // back to top level
    if (name) body.push(line);
  }
  if (name) jobs.set(name, body.join('\n'));
  if (jobs.size === 0) fail(`${file}: parsed no jobs`);
  return jobs;
}

const publishYml = read('.github/workflows/publish.yml');
const ciYml = read('.github/workflows/ci.yml');
const publishJobs = jobsOf(publishYml, 'publish.yml');
const ciJobs = jobsOf(ciYml, 'ci.yml');

const need = (jobs, name, file) =>
  jobs.get(name) ?? fail(`${file}: expected a '${name}' job; found ${[...jobs.keys()].join(', ')}`);

// ------------------------------------------------ the credentialed job
const credentialed = [...publishJobs.entries()].filter(([, body]) => /id-token:\s*write/.test(body));
if (credentialed.length !== 1) {
  fail(`expected exactly one job holding id-token: write, found ${credentialed.length} (${credentialed.map(([n]) => n).join(', ')})`);
}
const [credName, credBody] = credentialed[0];

// #21. Anything resolved at run time here is third-party code executing beside
// a token that can publish. Every install must name an exact version.
for (const m of credBody.matchAll(/^\s*-?\s*(?:name:.*\n\s*)?run:\s*(.+)$/gm)) {
  const cmd = m[1].trim();
  if (/@latest\b|@next\b|@\^|@~/.test(cmd)) {
    fail(`#21: '${credName}' resolves a version at run time: ${JSON.stringify(cmd)} — pin it, this job holds id-token: write`);
  }
  const install = /npm\s+(?:install|i)\s+-g\s+(\S+)/.exec(cmd);
  if (install && !/^[a-z@/-]+@\d+\.\d+\.\d+$/.test(install[1])) {
    fail(`#21: '${credName}' installs ${JSON.stringify(install[1])} without an exact version`);
  }
}

// The property the file's own header claims.
if (/uses:\s*actions\/checkout/.test(credBody)) {
  fail(`'${credName}' checks out the repository while holding id-token: write — its header promises it never runs repository code`);
}

// ------------------------------------------------------ #27: the digest
const build = need(publishJobs, 'build', 'publish.yml');

if (!/outputs:/.test(build) || !/digest:/.test(build)) {
  fail(`#27: the 'build' job must publish the tarball's digest as a job output, so the value travels through the workflow rather than beside the artifact it protects`);
}
if (!/sha256sum|shasum\s+-a\s+256/.test(build)) {
  fail(`#27: the 'build' job must compute a SHA-256 of what it packed`);
}
if (!/GITHUB_OUTPUT/.test(build)) {
  fail(`#27: the 'build' job must write the digest to $GITHUB_OUTPUT`);
}

if (!/needs\.build\.outputs\.digest/.test(credBody)) {
  fail(`#27: '${credName}' must read the digest from needs.build.outputs.digest — an artifact it did not build is not trustworthy on its own`);
}
if (!/sha256sum|shasum\s+-a\s+256/.test(credBody)) {
  fail(`#27: '${credName}' must recompute the SHA-256 of the artifact it downloaded`);
}

// Order matters more than presence: a check after the upload proves nothing.
const stageAt = credBody.search(/npm\s+stage\s+publish/);
const checkAt = credBody.search(/needs\.build\.outputs\.digest/);
if (stageAt < 0) fail(`#27: could not find the staging step in '${credName}'`);
if (checkAt > stageAt) {
  fail(`#27: the digest is checked after the tarball is staged — the check has to come first or it guards nothing`);
}

// ---------------------------------------------- every action SHA-pinned
for (const [file, yaml] of [['publish.yml', publishYml], ['ci.yml', ciYml]]) {
  for (const m of yaml.matchAll(/uses:\s*(\S+)/g)) {
    const ref = m[1];
    if (!/@[0-9a-f]{40}$/.test(ref)) {
      fail(`${file}: ${ref} is not pinned to a commit SHA`);
    }
  }
}

// ------------------------------- #27: the release gate is no weaker than CI
// A tag must not be able to ship something a pull request would have caught.
const verifySteps = (body) => [...body.matchAll(/run:\s*npm run (verify:[a-z]+)/g)].map((m) => m[1]).sort();
// Every gate that EXISTS must run in CI. Comparing the release gate to CI
// only catches the release falling behind CI; when both fall behind the
// package.json scripts — as they did, by four gates — the comparison passes
// while nothing is checked. The set of gates is the authority, not either
// workflow.
const declared = Object.keys(
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts,
).filter((k) => k.startsWith('verify:'));
const ciVerify = verifySteps([...ciJobs.values()].join('\n'));
const unwired = declared.filter((g) => !ciVerify.includes(g));
if (unwired.length > 0) {
  fail(`ci.yml does not run ${unwired.join(', ')} — a gate that is not wired in protects nothing, and adding one without wiring it is exactly how four of them went unnoticed`);
}
const relVerify = verifySteps(need(publishJobs, 'test', 'publish.yml'));
if (ciVerify.length === 0) fail('ci.yml runs no verify steps — this gate cannot be comparing the right thing');
const missing = ciVerify.filter((s) => !relVerify.includes(s));
if (missing.length > 0) {
  fail(`#27: the release gate is weaker than CI; it never runs ${missing.join(', ')}`);
}

console.log('RELEASE OK');

// install-worker.mjs — make a fresh checkout able to delegate (#90).
//
// The worker that glm-task, glm-review and glm-answer drive lives in
// packages/worker, because its dependency on @anthropic-ai/claude-agent-sdk
// drags a ~199MB platform binary that glm-mcp's published package must not
// carry (verify-worker.mjs rule 5). A separate package means a separate
// install, and an install step that exists only in a README is a step nobody
// ran: CI's plain `npm ci` must bring the worker up too, or the verify:worker
// step wired into that same CI fails on a checkout that did nothing wrong.
//
// Wired as the root package's postinstall. postinstall also runs on the
// machines of consumers installing the published server, where packages/ does
// not exist (npm's `files` list excludes it) — the existsSync guard makes this
// a no-op there, which is also why this file must ship in the tarball: a
// postinstall pointing at a file the tarball omits would fail every consumer
// install for the sake of a feature they cannot reach.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKER = join(ROOT, 'packages', 'worker');

if (!existsSync(WORKER)) process.exit(0); // a published install, not a checkout

// npm ci, not npm install: the committed lockfile is the graph every machine
// runs, which is the same reason the root package ships a shrinkwrap.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const ran = spawnSync(npm, ['ci', '--prefix', WORKER, '--no-audit', '--no-fund'], { stdio: 'inherit' });
if (ran.error) {
  console.error(`install-worker: could not run npm: ${ran.error.message}`);
  console.error('install-worker: delegation needs packages/worker installed — see npm run verify:worker');
  process.exit(1);
}
process.exit(ran.status ?? 1);

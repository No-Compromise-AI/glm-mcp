// verify-confinement.mjs — acceptance gate for the glm_ask trust boundary
// (#13, #14): decisions 1-4 of glm-mcp-design/TRUST-BOUNDARY.md.
//
// The boundary is operator-set. Roots come from GLM_MCP_ROOTS (colon-separated
// absolute paths) or default to the server process's own cwd at startup. The
// caller may narrow within a root; it may never choose or escape one. Every
// file's realpath must land inside a root, which is what closes the symlink
// escape. The server never reads its own credentials, whatever the roots say.
//
// Contract this gate holds the implementation to:
//   buildFileContext(paths, cwd) -> { text, notes, refusedCall }
//   * a refused path is a note and the rest of the call proceeds (decision 2);
//   * a cwd outside every root sets refusedCall, reads nothing, and says so —
//     it must NOT quietly narrow to a root (that is the silent-failure shape);
//   * every refusal note contains the word "refused" and the spelling the
//     caller used, so the caller can tell which of its arguments was dropped.
//
// Each case runs in a child process: roots are read against a startup-captured
// cwd, so env and cwd have to be set before the module loads to be tested
// honestly. Fixtures are real files, real symlinks and a real fake $HOME.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (msg) => { throw new Error(msg); };
const GLM = pathToFileURL(new URL('../dist/glm.js', import.meta.url).pathname).href;

// The child prints exactly what buildFileContext returned, plus how long the
// call itself took — the walk-containment cases are about time, and process
// startup must not be counted against them.
const CHILD = `
import { buildFileContext } from ${JSON.stringify(GLM)};
const job = JSON.parse(process.argv[1]);
const started = process.hrtime.bigint();
const r = buildFileContext(job.paths, job.cwd);
process.stdout.write(JSON.stringify({
  text: String(r.text ?? ''),
  notes: (r.notes ?? []).map(String),
  refusedCall: r.refusedCall === true,
  ms: Number(process.hrtime.bigint() - started) / 1e6,
}));
`;

/**
 * One buildFileContext call in a freshly-started child. `roots`, `home` and
 * `allowAny` set the operator's side of the boundary; `paths` and `cwd` are the
 * caller's side. `procCwd` is the process cwd the server would have started in,
 * which is the default root when GLM_MCP_ROOTS is unset.
 */
function ctx({ paths, cwd, roots, home, allowAny, procCwd }) {
  const env = { ...process.env };
  for (const k of ['GLM_MCP_ROOTS', 'GLM_MCP_ALLOW_ANY_PATH', 'GLM_MCP_GLOB_IGNORE']) delete env[k];
  if (roots !== undefined) env.GLM_MCP_ROOTS = roots;
  // os.homedir() reads HOME on POSIX and USERPROFILE on Windows; setting only
  // one would denylist the real profile while the fixtures sat under the fake.
  if (home !== undefined) { env.HOME = home; env.USERPROFILE = home; }
  if (allowAny) env.GLM_MCP_ALLOW_ANY_PATH = '1';
  let out;
  try {
    out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', CHILD, JSON.stringify({ paths, cwd })],
      { cwd: procCwd ?? cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    fail(`buildFileContext(${JSON.stringify(paths)}) threw in the child — refusals are notes, never throws (decision 2)\n${e.stderr || e.message}`);
  }
  try {
    return JSON.parse(out);
  } catch {
    return fail(`child produced no parsable result for ${JSON.stringify(paths)}: ${out}`);
  }
}

const shows = (r, needle) => r.text.includes(needle);
const noted = (r, ...needles) =>
  r.notes.some((n) => /refused/i.test(n) && needles.some((s) => n.includes(s)));
const show = (r) => `text=${JSON.stringify(r.text.slice(0, 200))} notes=${JSON.stringify(r.notes)} refusedCall=${r.refusedCall}`;

// Refused content must be absent, said so in notes, and must not have taken the
// call down with it.
function refuses(r, secret, spellings, what) {
  if (shows(r, secret)) fail(`${what}: content leaked — ${show(r)}`);
  if (!noted(r, ...spellings)) fail(`${what}: refusal must be reported in notes naming ${spellings.join(' or ')} — ${show(r)}`);
}

// ---------------------------------------------------------------- fixtures
// mkdtemp lands under a symlinked prefix on macOS (/var -> /private/var), so
// RAW is the spelling an operator would paste into GLM_MCP_ROOTS and ROOT is
// what it resolves to. Roots that are not resolved before comparison refuse
// everything; using both spellings here is what catches that.
const RAW = mkdtempSync(join(tmpdir(), 'glm-confine-'));
const ROOT = realpathSync.native(RAW);
const at = (...p) => join(ROOT, ...p);
const put = (rel, body) => {
  mkdirSync(join(ROOT, rel, '..'), { recursive: true });
  writeFileSync(at(rel), body);
};
const dir = (rel) => mkdirSync(at(rel), { recursive: true });

try {
  dir('rootA/src/nested');
  dir('rootB');
  dir('rootC');
  dir('rootA-evil');
  dir('outside/secretdir');
  dir('home/.config/zai');
  dir('home/.zcode/v2');

  put('rootA/a.txt', 'AAA-IN-ROOT-A');
  put('rootA/inner.md', 'INNER-MARKDOWN');
  put('rootA/src/one.ts', 'ONE-TS');
  put('rootA/src/nested/two.ts', 'TWO-TS');
  put('rootA/sub/docs/fine.txt', 'HONEST-DOCS');
  dir('rootA/teams/team1');
  dir('rootA/teams/team2');
  // A real file whose name is nothing but metacharacters. #3 settled that a
  // path existing on disk is read literally; containment must not re-read it
  // as a pattern whose synthetic '..' branch escapes.
  put('rootA/{..,safe}', 'LITERAL-BRACE-BODY');
  put('rootB/b.txt', 'BBB-IN-ROOT-B');
  put('rootC/c.txt', 'CCC-IN-ROOT-C');
  put('rootA-evil/e.txt', 'EVIL-SIBLING-PREFIX');
  put('outside/secret.env', 'TOPSECRET=hunter2');
  put('outside/secret.md', 'PRIVATE_KEY_MATERIAL=leaked');
  put('outside/secretdir/leak.txt', 'DEEP_SECRET=exfiltrated');

  // A fake $HOME so the credential rule can be tested against real files
  // instead of the operator's actual key.
  put('home/.config/zai/api-key', 'SECRET-ZAI-KEY-VALUE');
  put('home/.config/zai/other-file', 'ORDINARY-NEIGHBOUR-A');
  put('home/.zcode/v2/config.json', '{"apiKey":"SECRET-ZCODE-KEY"}');
  put('home/.zcode/v2/other.json', '{"ordinary":"NEIGHBOUR-B"}');

  symlinkSync(at('outside/secret.md'), at('rootA/notes.md'));       // #14: file link, wildcard-matched
  symlinkSync(at('outside/secretdir'), at('rootA/docs'));           // #14: dir link, named literally
  symlinkSync(at('rootA/a.txt'), at('rootA/alias.txt'));            // in-root link: must keep working
  symlinkSync(at('home/.config/zai/api-key'), at('home/link-to-key'));
  symlinkSync(at('rootA'), at('linkroot'));                         // a root spelled through a link
  // Two distinct links in the tree to one directory outside it: the caller
  // has two problems to fix, not one.
  symlinkSync(at('outside/secretdir'), at('rootA/teams/team1/docs'));
  symlinkSync(at('outside/secretdir'), at('rootA/teams/team2/docs'));

  const A = at('rootA');
  const B = at('rootB');
  const HOME = at('home');

  // ------------------------------------------------- 1. normal use unchanged
  // Confinement must be invisible to a caller that was already behaving.
  let r = ctx({ paths: ['a.txt'], cwd: A, roots: RAW + '/rootA' });
  if (!shows(r, 'AAA-IN-ROOT-A')) fail(`in-root relative read must still work — ${show(r)}`);
  if (r.refusedCall) fail(`an in-root cwd must not refuse the call — ${show(r)}`);

  r = ctx({ paths: ['src/**/*.ts'], cwd: A, roots: A });
  if (!shows(r, 'ONE-TS') || !shows(r, 'TWO-TS')) fail(`in-root glob must still expand — ${show(r)}`);

  // The caller may narrow within the boundary: a cwd below a root is fine.
  r = ctx({ paths: ['one.ts'], cwd: at('rootA/src'), roots: A });
  if (!shows(r, 'ONE-TS')) fail(`a cwd narrowed below a root must be allowed — ${show(r)}`);

  r = ctx({ paths: ['{..,safe}'], cwd: A, roots: A });
  if (!shows(r, 'LITERAL-BRACE-BODY')) {
    fail(`a real file whose name contains braces must still be read literally — ${show(r)}`);
  }

  // An in-root symlink is still read, and still de-duplicates against its
  // target: containment must not disturb the #3 identity dedupe.
  r = ctx({ paths: ['a.txt', 'alias.txt'], cwd: A, roots: A });
  const hits = r.text.split('AAA-IN-ROOT-A').length - 1;
  if (hits !== 1) fail(`an in-root symlink alias must read once, not ${hits} times — ${show(r)}`);

  // ------------------------------------------------------- 2. ../ escape (#13)
  r = ctx({ paths: ['../outside/secret.env'], cwd: A, roots: A });
  refuses(r, 'TOPSECRET=hunter2', ['../outside/secret.env'], '../ escape');

  // Decision 2: one bad entry must not fail a request that also names good files.
  r = ctx({ paths: ['a.txt', '../outside/secret.env', 'inner.md'], cwd: A, roots: A });
  refuses(r, 'TOPSECRET=hunter2', ['../outside/secret.env'], '../ escape beside good files');
  if (!shows(r, 'AAA-IN-ROOT-A') || !shows(r, 'INNER-MARKDOWN')) {
    fail(`a refused entry must not drop the good entries beside it — ${show(r)}`);
  }
  if (r.refusedCall) fail(`a refused path is not a refused call — ${show(r)}`);

  // -------------------------------------------- 3. absolute outside roots (#13)
  r = ctx({ paths: [at('outside/secret.env')], cwd: A, roots: A });
  refuses(r, 'TOPSECRET=hunter2', [at('outside/secret.env'), 'secret.env'], 'absolute path outside roots');

  // A sibling that merely shares the root's textual prefix is outside it.
  r = ctx({ paths: [at('rootA-evil/e.txt')], cwd: A, roots: A });
  refuses(r, 'EVIL-SIBLING-PREFIX', [at('rootA-evil/e.txt'), 'rootA-evil'], 'prefix sibling of a root');

  // ----------------------------------------------- 4. symlink escape (#14)
  // The link is inside the root; only its realpath reveals the escape.
  r = ctx({ paths: ['**/*.md'], cwd: A, roots: A });
  refuses(r, 'PRIVATE_KEY_MATERIAL', ['notes.md', '**/*.md'], 'file symlink escaping via a wildcard');
  if (!shows(r, 'INNER-MARKDOWN')) fail(`the honest match beside an escaping link must survive — ${show(r)}`);

  r = ctx({ paths: ['docs/**/*.txt'], cwd: A, roots: A });
  refuses(r, 'DEEP_SECRET', ['docs', 'leak.txt'], 'directory symlink named as a literal segment');

  // Pruned in the middle of a walk rather than at its anchor. Dropping it
  // without a word returns partial context that reads as complete — the
  // silent narrowing decision 1 rules out — and it is worse here than
  // elsewhere, because the thing being hidden is a hostile symlink.
  r = ctx({ paths: ['**/docs/*.txt'], cwd: A, roots: A });
  refuses(r, 'DEEP_SECRET', ['docs', '**/docs/*.txt'], 'a directory symlink pruned mid-walk');
  if (!shows(r, 'HONEST-DOCS')) fail(`the honest match beside a pruned link must survive — ${show(r)}`);

  // Two escaping links, two refusals. Collapsing them by where they point
  // hides one of the caller's two problems; only repeated routes to the same
  // path may collapse.
  r = ctx({ paths: ['teams/**/docs/*.txt'], cwd: A, roots: A });
  if (shows(r, 'DEEP_SECRET')) fail(`two escaping links leaked — ${show(r)}`);
  for (const team of ['teams/team1/docs', 'teams/team2/docs']) {
    if (!noted(r, team)) fail(`each escaping link must be reported, ${team} was not — ${show(r)}`);
  }
  // Refused is not the same as absent. A pattern that refused something must
  // not also be filed under "no matches", which reads as a pattern that was
  // simply wrong.
  if (r.notes.some((n) => /no matches/i.test(n))) {
    fail(`a pattern whose matches were refused must not also be reported as matching nothing — ${show(r)}`);
  }

  // An absolute pattern's refusal has to name an absolute path. Matches carry
  // the pattern's root through; refusals must not drop it.
  r = ctx({ paths: [`${A}/teams/**/docs/*.txt`], cwd: A, roots: A });
  if (shows(r, 'DEEP_SECRET')) fail(`an absolute escaping pattern leaked — ${show(r)}`);
  for (const n of r.notes.filter((x) => /refused/i.test(x))) {
    if (!n.includes(`${A}/teams/team`)) {
      fail(`a refusal from an absolute pattern must name an absolute path, got ${JSON.stringify(n)}`);
    }
  }

  // ------------------------------- 5. a cwd outside the roots refuses the call
  r = ctx({ paths: ['a.txt'], cwd: at('outside'), roots: A, procCwd: A });
  if (!r.refusedCall) fail(`a cwd outside every root must refuse the call, not proceed — ${show(r)}`);
  if (r.text !== '') fail(`a refused call must read nothing — ${show(r)}`);
  if (shows(r, 'AAA-IN-ROOT-A')) fail(`a cwd outside the roots must not be narrowed to a root — ${show(r)}`);
  if (!noted(r, at('outside'), 'cwd')) fail(`a refused call must say why in notes — ${show(r)}`);

  // -------------------------------------------- 6. credential paths (decision 3)
  // Rooted at '/', so nothing here can be refused for being out of root: any
  // refusal below is the credential rule and only the credential rule.
  const anywhere = { cwd: HOME, roots: '/', home: HOME };
  r = ctx({ ...anywhere, paths: ['.config/zai/api-key'] });
  refuses(r, 'SECRET-ZAI-KEY-VALUE', ['.config/zai/api-key'], '~/.config/zai/api-key inside a root');

  r = ctx({ ...anywhere, paths: ['.zcode/v2/config.json'] });
  refuses(r, 'SECRET-ZCODE-KEY', ['.zcode/v2/config.json'], '~/.zcode/v2/config.json inside a root');

  // /proc/self/environ holds ZAI_API_KEY on Linux and does not exist on macOS.
  // Refusal cannot depend on existence, so the note must name it as refused
  // rather than merely missing, on both platforms.
  r = ctx({ ...anywhere, paths: ['/proc/self/environ'] });
  if (!noted(r, '/proc/self/environ')) {
    fail(`/proc/self/environ must be refused as a credential path, not reported as missing — ${show(r)}`);
  }

  // The rule names three files, not two directories.
  r = ctx({ ...anywhere, paths: ['.config/zai/other-file', '.zcode/v2/other.json'] });
  if (!shows(r, 'ORDINARY-NEIGHBOUR-A') || !shows(r, 'NEIGHBOUR-B')) {
    fail(`only the three credential files are refused, not their neighbours — ${show(r)}`);
  }

  // Compared by resolved real path, not by spelling.
  r = ctx({ ...anywhere, paths: ['link-to-key'] });
  refuses(r, 'SECRET-ZAI-KEY-VALUE', ['link-to-key'], 'a symlink to the api key');
  r = ctx({ ...anywhere, paths: ['.config/zai/../zai/api-key'] });
  refuses(r, 'SECRET-ZAI-KEY-VALUE', ['api-key'], 'a re-spelled path to the api key');

  // ------------------------------------------------ 7. GLM_MCP_ROOTS honoured
  r = ctx({ paths: ['a.txt', join(B, 'b.txt'), at('rootC/c.txt')], cwd: A, roots: `${A}:${B}` });
  if (!shows(r, 'AAA-IN-ROOT-A')) fail(`the first of several roots must be readable — ${show(r)}`);
  if (!shows(r, 'BBB-IN-ROOT-B')) fail(`the second of several roots must be readable — ${show(r)}`);
  refuses(r, 'CCC-IN-ROOT-C', [at('rootC/c.txt'), 'rootC'], 'a directory that is not among the roots');

  // A root is resolved before it is compared, so a root reached through a
  // symlink still contains the files under it.
  r = ctx({ paths: ['a.txt'], cwd: A, roots: at('linkroot') });
  if (!shows(r, 'AAA-IN-ROOT-A')) fail(`a root spelled through a symlink must resolve — ${show(r)}`);

  // Trailing separators are spelling, not meaning.
  r = ctx({ paths: ['a.txt'], cwd: A, roots: `${A}/` });
  if (!shows(r, 'AAA-IN-ROOT-A')) fail(`a trailing slash on a root must not change it — ${show(r)}`);

  // ------------------------ 8. the default root is the server cwd at startup
  // Emphatically NOT the cwd the caller passes. If the argument were its own
  // boundary, the untrusted party would be choosing the boundary — and since
  // "most users will need no configuration at all", #13 would stay open in the
  // configuration almost everyone actually runs.
  r = ctx({ paths: ['a.txt'], cwd: A, procCwd: A });
  if (!shows(r, 'AAA-IN-ROOT-A')) fail(`with GLM_MCP_ROOTS unset the server cwd must be readable — ${show(r)}`);
  r = ctx({ paths: ['../outside/secret.env'], cwd: A, procCwd: A });
  refuses(r, 'TOPSECRET=hunter2', ['../outside/secret.env'], 'escape from the default root');

  // The caller names a cwd the server was never started in.
  r = ctx({ paths: ['secret.env'], cwd: at('outside'), procCwd: A });
  if (!r.refusedCall) fail(`with GLM_MCP_ROOTS unset a caller must not be able to nominate its own cwd as the boundary — ${show(r)}`);
  if (shows(r, 'TOPSECRET=hunter2')) fail(`a caller-chosen cwd read a file outside the server's own directory — ${show(r)}`);

  // The whole-volume version of the same move: the shortest path from #13's
  // repro to a full bypass is a caller that simply asks for cwd "/".
  r = ctx({ paths: ['etc/hosts'], cwd: '/', procCwd: A });
  if (!r.refusedCall) fail(`a caller passing cwd "/" must be refused, not handed the volume as its root — ${show(r)}`);
  if (r.text !== '') fail(`a caller passing cwd "/" read something — ${show(r)}`);

  // Narrowing below the startup cwd stays allowed: the caller may narrow.
  r = ctx({ paths: ['one.ts'], cwd: at('rootA/src'), procCwd: A });
  if (!shows(r, 'ONE-TS')) fail(`narrowing below the default root must still work — ${show(r)}`);

  // ---------------------------------------------- 9. the escape hatch (decision 4)
  const loose = { cwd: A, roots: A, allowAny: true };
  r = ctx({ ...loose, paths: ['../outside/secret.env'] });
  if (!shows(r, 'TOPSECRET=hunter2')) fail(`GLM_MCP_ALLOW_ANY_PATH=1 must restore ../ reads — ${show(r)}`);
  r = ctx({ ...loose, paths: [at('outside/secret.env')] });
  if (!shows(r, 'TOPSECRET=hunter2')) fail(`GLM_MCP_ALLOW_ANY_PATH=1 must restore absolute reads — ${show(r)}`);
  r = ctx({ ...loose, paths: ['**/*.md'] });
  if (!shows(r, 'PRIVATE_KEY_MATERIAL')) fail(`GLM_MCP_ALLOW_ANY_PATH=1 must restore symlink following — ${show(r)}`);
  r = ctx({ paths: ['secret.env'], cwd: at('outside'), roots: A, allowAny: true, procCwd: A });
  if (r.refusedCall) fail(`GLM_MCP_ALLOW_ANY_PATH=1 must stop refusing an outside cwd — ${show(r)}`);
  if (!shows(r, 'TOPSECRET=hunter2')) fail(`GLM_MCP_ALLOW_ANY_PATH=1 must read from an outside cwd — ${show(r)}`);

  // Decision 3 says "regardless of roots". The escape hatch widens the roots;
  // it does not re-open the server's own credentials.
  r = ctx({ paths: ['.config/zai/api-key'], cwd: HOME, roots: A, home: HOME, allowAny: true });
  refuses(r, 'SECRET-ZAI-KEY-VALUE', ['.config/zai/api-key'], 'the api key under GLM_MCP_ALLOW_ANY_PATH');

  // ------------------------------- 10. containment stops the walk, not just the read
  // Why PR B depends on this one: an absolute pattern must never start walking
  // from '/' in the first place. Timed inside the child, around the call only.
  const WALK_BUDGET_MS = 5_000;
  r = ctx({ paths: ['/**/*.md'], cwd: A, roots: A });
  if (shows(r, 'PRIVATE_KEY_MATERIAL')) fail(`a pattern rooted at / must not read outside the roots — ${show(r)}`);
  if (r.ms > WALK_BUDGET_MS) fail(`a pattern rooted at / walked the volume for ${Math.round(r.ms)}ms — containment must stop it before the walk`);
  if (!noted(r, '/**/*.md')) fail(`a pattern rooted outside the roots must be reported as refused — ${show(r)}`);

  r = ctx({ paths: ['../outside/**/*.txt'], cwd: A, roots: A });
  refuses(r, 'DEEP_SECRET', ['../outside/**/*.txt'], 'a relative pattern climbing out of the root');
  if (r.ms > WALK_BUDGET_MS) fail(`an escaping pattern walked for ${Math.round(r.ms)}ms — refuse it before walking`);
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log('CONFINEMENT OK');

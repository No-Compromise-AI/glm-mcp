# glm-mcp

[![npm](https://img.shields.io/npm/v/@nocompromiseai/glm-mcp)](https://www.npmjs.com/package/@nocompromiseai/glm-mcp)
[![ci](https://github.com/No-Compromise-AI/glm-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/No-Compromise-AI/glm-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@nocompromiseai/glm-mcp)](LICENSE)

An MCP server that exposes Z.ai's GLM models — GLM-5.3 and siblings — as tools inside any
MCP client. Verified in **Claude Code / Claude Desktop**, **Codex** and **Antigravity**.

The original reason was Claude Desktop, which pins its own model provider: when it spawns its
embedded Claude Code it forces `ANTHROPIC_BASE_URL` to Anthropic's endpoint and strips
`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from the child environment. So GLM cannot *drive*
a desktop session. This server takes the other route — GLM becomes a tool the agent calls
mid-conversation — and that route happens to work everywhere, because MCP is a standard and
nothing in here is Claude-specific.

Useful for:

- **A real second opinion.** An independent frontier model, not the same model asked twice.
- **Very large context.** GLM-5.3 has a million-token window, so you can hand it far more
  source material than fits in a normal session.
- **Cheap bulk work.** Route grunt work to `glm-4.7` and keep the expensive model for reasoning.

## Install

Register it once, user-scoped, and it is available in **every** project on the machine — no
per-project setup.

**Claude Code / Claude Desktop**

```bash
claude mcp add --scope user glm -- npx -y @nocompromiseai/glm-mcp@0.4.0
```

**Codex**

```bash
codex mcp add glm -- npx -y @nocompromiseai/glm-mcp@0.4.0
```

**Antigravity**

```bash
agy mcp add glm -- npx -y @nocompromiseai/glm-mcp@0.4.0
```

One caveat that decides whether file context works at all, per host. This server confines
file reads to the directory it was **started in** (see [Path confinement](#path-confinement)),
so where the host launches it matters:

| host | launches the server in | so |
| --- | --- | --- |
| Claude Code | the project directory | works as-is |
| Codex | the session directory | works as-is |
| Antigravity | wherever `agy` itself was invoked — and `--add-dir` does **not** change this | either launch `agy` from the project, or set `GLM_MCP_ROOTS` and pass `cwd` |

For Antigravity, set the roots at registration:

```bash
agy mcp add -e GLM_MCP_ROOTS=/abs/path/one:/abs/path/two glm -- npx -y @nocompromiseai/glm-mcp@0.4.0
```

Note that `GLM_MCP_ROOTS` bounds where a caller may point `cwd`; it does not exempt the launch
directory, which must also be inside a root. When it is not, the call is refused with a message
naming the offending `cwd` — loudly, rather than quietly matching no files.

The version is pinned on purpose: a bare `npx` resolves `latest` at run time, while the package
itself ships the exact dependency graph it was tested with — pinning is what makes the two the
same graph. Bump the pin when you upgrade.

Or from a local checkout:

```bash
npm install && npm run build
claude mcp add --scope user glm -- node /absolute/path/to/glm-mcp/dist/index.js
```

Restart the host for it to be picked up. Verify with `claude mcp list`, `codex mcp list` or
`agy mcp list`.

Requires Node 20 or newer, and a z.ai API key with credit or a Coding Plan.

## Credentials

The server never hardcodes a key. It resolves one from, in order:

1. `ZAI_API_KEY`
2. `~/.config/zai/api-key`
3. the `api.z.ai` key ZCode stores in `~/.zcode/v2/config.json` — **only** when
   `GLM_MCP_ALLOW_ZCODE_KEY=1` is set

Step 3 is opt-in on purpose. It reads a credential belonging to a different application,
and that should be a decision you make rather than behaviour you discover. Everything runs
on the machine doing the installing: your key, your z.ai account, your billing.

Note that the ZCode **Start Plan** token is not usable here — that endpoint is captcha-locked to
the ZCode app and rejects outside clients with `3007`. You need an `api.z.ai` key with a Coding
Plan or credit on it.

## Usage

Once registered, ask Claude to use it. In practice you say something like *"use glm_ask to
review src/auth for race conditions"* — but the underlying call looks like this:

```json
{
  "prompt": "Does the refresh logic have a race condition? Point at the lines.",
  "files": ["src/auth/**/*.ts"],
  "reasoning": "high"
}
```

The reply carries a footer with the model, token usage and how much it reasoned:

```
The refresh path in session.ts:88 reads `expiresAt` before taking the lock ...

[glm-5.3 · in 4210 / out 380 tok · reasoned 2170 chars]
```

Two things it is genuinely good at:

- **A second opinion that disagrees.** Ask Claude and GLM the same question and compare. Two
  models disagreeing is real signal; the same model asked twice mostly is not.
- **More source than fits.** With a 1M-token window you can hand it `src/**/*.ts` wholesale
  instead of curating a handful of files.

## Tools

### `glm_ask`

| arg | type | default | notes |
| --- | --- | --- | --- |
| `prompt` | string | — | required |
| `files` | string[] | — | files to include as context: literal paths and/or globs (`src/**/*.ts`, `*.md`, `{lib,src}/*.ts`) |
| `cwd` | string | server cwd | what relative `files` resolve against |
| `model` | string | `glm-5.3` | any id from `glm_models` |
| `reasoning` | `none`\|`low`\|`high`\|`max` | `low` | higher is slower |
| `system` | string | — | optional system prompt |
| `max_tokens` | number | the model's own default (65,536 for GLM-5.3) | hard ceiling on output; see Reasoning |

### `glm_models`

Lists the model ids available on the configured account, each with a one-line role.
The request path is text-only — no image is ever attached — so picking a model that
accepts images (`glm-4.6v` and siblings, and `glm-5.3-flash`, which is natively
multimodal though its name says nothing of it) forgoes the modality it was selected
for; each such id's role says so. An id this server's model table does not know is
listed bare: it stays z.ai's to describe, exactly as it stays z.ai's to size.

## Reasoning

**GLM-5.3 and glm-5.3-flash always reason.** A request without a thinking block is
rejected with z.ai error `1210` on GLM-5.3, so `reasoning: "none"` is silently raised
to `"low"` for it. glm-5.3-flash cannot disable thinking either — z.ai's docs allow
`thinking.type` no value but `enabled`, and sent `disabled` it still returns a thinking
block without erroring — so its `"none"` is raised to `"low"` too, before anything is
sent. `glm-4.6` and `glm-4.7` genuinely run with reasoning off.

`"none"` is a setting the request states, not the absence of one. z.ai documents an
omitted `thinking` parameter as defaulting to `enabled`, so for two versions of this
package `"none"` and unspecified were the same thing and the answer came back reasoned
either way — silently, with nothing in the footer to tell a reasoned answer from one
that was meant to skip reasoning. The request now says `disabled` out loud.

| `reasoning` | thinking budget |
| --- | --- |
| `none` | sent as an explicit `disabled` block — the request states it, never omits `thinking` |
| `low` | 2,048 tokens |
| `high` | 8,192 tokens |
| `max` | 24,576 tokens |

`max_tokens` is a **ceiling, not a target**: the request never asks for more than you set.
Where the budget above would not fit beneath it, the thinking budget is reduced to leave room
for the answer — so a small `max_tokens` buys less reasoning rather than a bigger bill.

Set it below what any reasoning needs at all — the API's minimum thinking budget plus room for
an answer — and the call is refused rather than quietly enlarged. The refusal names the smallest
cap that would work. Raise `max_tokens`, or lower `reasoning` on a model that permits it.

## Path confinement

`glm_ask` reads only inside roots the **operator** sets. A caller may narrow
within them; it can neither choose nor escape them.

- Roots come from `GLM_MCP_ROOTS`, colon-separated absolute paths.
- Unset, the root is **the directory the server was started in**. Claude starts
  one server per project, so each server is confined to its own project and most
  setups need no configuration at all.
- `cwd` must resolve inside a root. If it does not the call is refused outright,
  not quietly narrowed to a root — a silently empty answer is worse than an
  error that says why.
- Every file's **real** path must land inside a root, so a symlink inside the
  tree pointing outside resolves outside and is refused. This is checked before
  a glob walks, so a pattern rooted outside never traverses.
- Refused paths appear in `Notes` exactly like missing files, naming the
  spelling you used. One refused entry never fails a call that also names good
  files.

Whatever the roots say, the server never reads its own credentials —
`~/.config/zai/api-key`, `~/.zcode/v2/config.json` and `/proc/self/environ` —
compared by resolved real path rather than by spelling.

`GLM_MCP_ALLOW_ANY_PATH=1` turns confinement off, deliberately and explicitly,
the same way `GLM_MCP_ALLOW_ZCODE_KEY` works. It widens the roots; it does not
re-open those three files.

### Upgrading to 0.2.0

**Using it in each of your projects needs no configuration.** Your client starts
one server per project, rooted at that project, so `env: {}` already gives you
what you want: in `~/work/app` it reads `app`, in `~/work/api` it reads `api`.

**If you read files across more than one project in a single call, set
`GLM_MCP_ROOTS` before upgrading.** That worked silently before 0.2.0 and is
refused after it:

```json
"env": { "GLM_MCP_ROOTS": "/Users/you/project-a:/Users/you/project-b" }
```

Absolute paths are confined too, but that breaks far less than it sounds: a
survey of this author's own tooling found no caller that passes them.

Two other behaviours change in 0.2.0, both in your favour and neither needing
configuration:

- **`max_tokens` is now a ceiling rather than a floor.** It used to be raised to
  make room for reasoning, so a small cap silently became a large one. It is now
  honoured exactly, with the thinking budget scaled to fit beneath it. A cap too
  small to hold any reasoning *and* an answer is refused with a message naming
  the smallest that works, instead of quietly becoming an expensive request.
- **The defaults are much larger.** Output goes from 8,192 to the model's own
  default — 65,536 for GLM-5.3 — and the file-context budget from 800,000
  characters to roughly 2.9 million, derived from the context window rather than
  guessed. If you had raised `GLM_MCP_MAX_FILE_CHARS` to work around the old
  ceiling, you can drop the override.

`glm_models` gains `ZAI_MODELS_URL`. It matters only if you set `ZAI_BASE_URL`
to control where your key is sent — see [Errors and endpoints](#errors-and-endpoints).

## File context

`files` accepts literal paths and glob patterns, mixed freely. Matches are sorted and
de-duplicated by file identity across the whole list, so overlapping patterns never send the
same file twice.

**Supported syntax:** `*`, `**`, `?`, `[a-z]`, `[!a-z]`, `{a,b}`, and `\` escapes.

- `.` and `..` resolve against `cwd`, so `./src/**` and `../neighbour/src/**` work.
- A path that exists on disk is read literally even if its name contains metacharacters — a
  real `report[final].md` is read, not pattern-matched.
- Hidden (dot) entries match only when the pattern spells the dot out.
- A pattern matching nothing is reported in `Notes`, exactly like a missing file.
- Symlinked directories are followed only when the pattern names one explicitly
  (`linked/*.ts`). Wildcards never follow them, and a link to a directory is never
  listed as a file.
- On Windows, use forward slashes: `C:/src/**/*.ts` and `//server/share/src/*.ts` are
  honoured as absolute. `\` is the escape character on every platform.

### What globs skip

Glob expansion skips `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `.turbo`,
`vendor` and `target`, so `**/*.ts` matches your source rather than 1,700 dependency type
definitions crowding out the budget.

This applies to expansion only — a literal `node_modules/foo/x.d.ts` goes through untouched.
Naming a directory in the pattern also overrides the skip, because the caller asked for it:
`node_modules/foo/**/*.d.ts` matches as expected.

Set `GLM_MCP_GLOB_IGNORE` to a comma-separated list to **replace** the default set
(`GLM_MCP_GLOB_IGNORE=dist,.venv`); an empty value disables skipping entirely.

### Limits

Every limit stops the operation that hit it and says so in `Notes`, naming the
variable that set it — nothing is ever silently truncated or silently dropped.

| Limit | Variable | Default |
| --- | --- | --- |
| Total context characters, headers and separators included | `GLM_MCP_MAX_FILE_CHARS` | derived per model — ~2.9M for GLM-5.3 |
| Context window the budget is derived from | `GLM_MCP_CONTEXT_TOKENS` | the model's declared window; 1,048,576 when undeclared |
| Per-file size, checked before the file is read | `GLM_MCP_MAX_FILE_BYTES` | 5 MB |
| Glob walk depth | `GLM_MCP_MAX_DEPTH` | 24 |
| Directory entries examined per call | `GLM_MCP_MAX_ENTRIES` | 200,000 |
| Wall-clock budget for glob expansion | `GLM_MCP_GLOB_TIMEOUT_MS` | 10,000 |
| Total `{a,b}` brace expansions | `GLM_MCP_MAX_BRACE_EXPANSIONS` | 1,024 |
| Request timeout, the whole call — all retries included | `GLM_MCP_TIMEOUT_MS` | 600,000 |

The character budget is **derived, per model**, not chosen: the context window
of the model the request will use, less that model's default output and a
prompt reserve, at 3 characters per token. The windows come from the same
z.ai-published table that sizes output — 1,048,576 for GLM-5.3 and
glm-5.3-flash, 200,000 for glm-4.7 and glm-4.6, 128,000 for glm-4.5 and
glm-4.6v — so a caller routed to a cheaper model by the routing guidance is
sized against that model's window, not the flagship's million tokens. Two
models sharing a window still get different budgets when their output defaults
differ: glm-4.5 and glm-4.6v both have 128K, but glm-4.6v holds back a quarter
as much for the reply, so more of the window is left for your files. A model
the table does not know keeps the documented assumption of 1,048,576 — z.ai is
the authority on its own models, exactly as with output ceilings. A truncation
note names which bound cut it, and names the window by its source — the model's
own published window, the window you set with `GLM_MCP_CONTEXT_TOKENS`, or the
documented assumption for a model whose window nobody has recorded — because
only the first of those is a fact about the model. Your explicit
`GLM_MCP_MAX_FILE_CHARS` cap is named as itself.

That ratio targets **English and code deliberately** — this is what the project
is built for. Denser scripts pack more tokens per character (Chinese runs nearer
one token per character), so a CJK-heavy caller should lower
`GLM_MCP_MAX_FILE_CHARS`; overshooting surfaces as a context-length error from
z.ai rather than a silent truncation. `GLM_MCP_CONTEXT_TOKENS` overrides the
window for **every model at once** — a published figure that proves wrong is
corrected with one variable, not a code change — and `GLM_MCP_MAX_FILE_CHARS`
overrides the character budget outright, also for every model.

Output ceilings come from z.ai's published table and are **per model** — 131,072
for the GLM-5 and 4.6/4.7 families, 98,304 for GLM-4.5, 32,768 for the vision
models. Asking for more than a model allows is refused locally, naming the
ceiling, rather than discovered as an API error. A model this table does not
know is not capped here: z.ai's own limits govern it.

`GLM_MCP_TIMEOUT_MS` bounds the **whole call, including retries** — not one
attempt. Retryable failures (408/409/429/5xx, connection errors) are retried
twice with the SDK's own backoff, and the one number you set covers every
attempt together: at the default, a call ends after ten minutes however many
attempts it has made, not thirty. The first attempt is entitled to nearly the
whole budget — the output default is 65,536 tokens and long single calls are
the normal case, so the budget is never divided to reserve room for retries
that may never happen. One residual: the SDK's backoff sleep between attempts
is not abort-aware, so a deadline that fires during a backoff wait overshoots
by up to that sleep — bounded by whatever `retry-after` the server sent.

- Only regular files are read. A FIFO, device or socket is refused rather than
  blocking the server on a read that may never return.
- Truncation cuts on code points, so it never splits an emoji in half.
- Missing, unreadable and refused files are skipped and reported, never fatal:
  one bad entry does not fail a call that also names good files.

## Errors and endpoints

z.ai's coded errors are translated into something actionable: `1113` (no balance), `1210`
(reasoning required), `3007` (wrong credential type — see Credentials above). The code has to
be the error's own code: a request id or token count that happens to contain those digits is
passed through untranslated rather than explained as something it is not.

Requests go to `https://api.z.ai/api/anthropic` unless `ZAI_BASE_URL` says otherwise. Your key
is sent to whatever host it names, so only point it at endpoints you trust. A `ZAI_BASE_URL`
that is set but that no URL can be made of — which is what `ZAI_BASE_URL="${HOST}/"` with
`HOST` unset leaves — makes the server refuse to start with an error naming the variable,
rather than quietly falling back to the default: the variable is how egress is scoped, so a
value you set is sent as written or refused, never swapped for a host you did not name.

`glm_models` reads a different endpoint on a different path prefix, so it does not follow
`ZAI_BASE_URL` — pointing the two at one host would only be a guess about your gateway's
layout. It defaults to `https://api.z.ai/api/paas/v4/models` and is set explicitly with
`ZAI_MODELS_URL`. **If you set `ZAI_BASE_URL` to scope where your key is sent, set
`ZAI_MODELS_URL` too**, or `glm_models` will keep sending the key to z.ai. Both requests
observe `GLM_MCP_TIMEOUT_MS` as a whole-call budget.

## Testing

```bash
npm test                    # unit tests: globs, key resolution, confinement, limits
npm run verify:ignore       # acceptance gate: glob ignore semantics
npm run verify:globs        # acceptance gate: glob path handling
npm run verify:confinement  # acceptance gate: the path trust boundary
npm run verify:limits       # acceptance gate: every resource limit actually fires
npm run smoke               # drives the server over stdio as a real MCP client (needs a key)
```

Everything but `smoke` is hermetic and runs in CI on Node 20, 22 and 24. `smoke` makes live
API calls, so it is run by hand.

Each acceptance gate was written before the change it gates and failed against the code it was
written for, so it asserts the behaviour rather than describing it. They build real fixture
trees — real files, real symlinks, a real FIFO, a real fake `$HOME` — and run against child
processes where a setting has to be in place before the module loads.

## Releases

`npm-shrinkwrap.json` carries the version too, so a release bump regenerates it
(`npm shrinkwrap`) alongside `package.json`. `verify:supplychain` fails if the two
drift, in CI and again at release, so it cannot ship half-done.

Published from CI with [provenance](https://docs.npmjs.com/generating-provenance-statements)
via npm trusted publishing — there is no long-lived npm token. Every release is staged and
requires a maintainer to approve it with 2FA before it becomes installable, and its provenance
ties the published tarball to this repository and the workflow that built it.

## Author

Built by **Jerold Billings**, Founder — [No Compromise AI, LLC](https://www.nocompromise.ai).

Bugs and questions: open an issue. Security problems: please use

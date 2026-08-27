# glm-mcp

[![npm](https://img.shields.io/npm/v/@nocompromiseai/glm-mcp)](https://www.npmjs.com/package/@nocompromiseai/glm-mcp)
[![ci](https://github.com/No-Compromise-AI/glm-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/No-Compromise-AI/glm-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@nocompromiseai/glm-mcp)](LICENSE)

An MCP server that exposes Z.ai's GLM models — GLM-5.3 and siblings — as tools inside
Claude Code and Claude Desktop.

Claude Desktop pins its own model provider: when it spawns its embedded Claude Code it forces
`ANTHROPIC_BASE_URL` to Anthropic's endpoint and strips `ANTHROPIC_API_KEY` /
`ANTHROPIC_AUTH_TOKEN` from the child environment. So GLM cannot *drive* a desktop session.
This server takes the other route — GLM becomes a tool Claude can call mid-conversation.

Useful for:

- **A real second opinion.** An independent frontier model, not the same model asked twice.
- **Very large context.** GLM-5.3 has a 1,000,000-token window, so you can hand it far more
  source material than fits in a normal session.
- **Cheap bulk work.** Route grunt work to `glm-4.7` and keep the expensive model for reasoning.

## Install

Register it once, user-scoped, and it is available in **every** project on the machine — no
per-project setup:

```bash
claude mcp add --scope user glm -- npx -y @nocompromiseai/glm-mcp
```

Or from a local checkout:

```bash
npm install && npm run build
claude mcp add --scope user glm -- node /absolute/path/to/glm-mcp/dist/index.js
```

Restart Claude Code / Claude Desktop for it to be picked up. Verify with `claude mcp list`.

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
| `max_tokens` | number | 8192 | hard ceiling on output; see Reasoning |

### `glm_models`

Lists the model ids available on the configured account.

## Reasoning

**GLM-5.3 always reasons.** A request without a thinking block is rejected with z.ai error
`1210`, so `reasoning: "none"` is silently raised to `"low"` for that model. Its siblings
(`glm-5.2`, `glm-5-turbo`, `glm-4.6`, `glm-4.7`) have no such constraint.

| `reasoning` | thinking budget |
| --- | --- |
| `low` | 2,048 tokens |
| `high` | 8,192 tokens |
| `max` | 24,576 tokens |

`max_tokens` is a **ceiling, not a target**: the request never asks for more than you set.
Where the budget above would not fit beneath it, the thinking budget is reduced to leave room
for the answer — so a small `max_tokens` buys less reasoning rather than a bigger bill.

Set it below what any reasoning needs, on a model that always reasons, and the call is refused
rather than quietly enlarged. Raise `max_tokens` or lower `reasoning`.

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

**If you read files across more than one project, set `GLM_MCP_ROOTS` in your MCP
registration before upgrading.** Each server is rooted at the project it was
started in, so asking from one project about a file in another worked silently
before 0.2.0 and is refused after it. The registration ships `env: {}`, so this
has to be added deliberately:

```json
"env": { "GLM_MCP_ROOTS": "/Users/you/project-a:/Users/you/project-b" }
```

Absolute paths are confined too, but that breaks far less than it sounds: a
survey of this author's own tooling found no caller that passes them.

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
| Total context characters, headers and separators included | `GLM_MCP_MAX_FILE_CHARS` | 800,000 |
| Per-file size, checked before the file is read | `GLM_MCP_MAX_FILE_BYTES` | 5 MB |
| Glob walk depth | `GLM_MCP_MAX_DEPTH` | 24 |
| Directory entries examined per call | `GLM_MCP_MAX_ENTRIES` | 200,000 |
| Wall-clock budget for glob expansion | `GLM_MCP_GLOB_TIMEOUT_MS` | 10,000 |
| Total `{a,b}` brace expansions | `GLM_MCP_MAX_BRACE_EXPANSIONS` | 1,024 |
| Request timeout | `GLM_MCP_TIMEOUT_MS` | 600,000 |

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
is sent to whatever host it names, so only point it at endpoints you trust.

`glm_models` reads a different endpoint on a different path prefix, so it does not follow
`ZAI_BASE_URL` — pointing the two at one host would only be a guess about your gateway's
layout. It defaults to `https://api.z.ai/api/paas/v4/models` and is set explicitly with
`ZAI_MODELS_URL`. **If you set `ZAI_BASE_URL` to scope where your key is sent, set
`ZAI_MODELS_URL` too**, or `glm_models` will keep sending the key to z.ai. Both requests
observe `GLM_MCP_TIMEOUT_MS`.

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

Published from CI with [provenance](https://docs.npmjs.com/generating-provenance-statements)
via npm trusted publishing — there is no long-lived npm token. Every release is staged and
requires a maintainer to approve it with 2FA before it becomes installable, and its provenance
ties the published tarball to this repository and the workflow that built it.

## Author

Built by **Jerold Billings**, Founder — [No Compromise AI, LLC](https://www.nocompromise.ai).

Bugs and questions: open an issue. Security problems: please use

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
| `max_tokens` | number | 8192 | output cap |

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

`max_tokens` is raised automatically to leave room for the answer on top of the budget.

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

- Context is capped at 800,000 characters (`GLM_MCP_MAX_FILE_CHARS`) across the expanded set,
  and truncates with a note rather than failing.
- Missing or unreadable files are skipped and reported, never fatal.
- Requests time out after 10 minutes (`GLM_MCP_TIMEOUT_MS`).

## Errors and endpoints

z.ai's coded errors are translated into something actionable: `1113` (no balance), `1210`
(reasoning required), `3007` (wrong credential type — see Credentials above).

Requests go to `https://api.z.ai/api/anthropic` unless `ZAI_BASE_URL` says otherwise. Your key
is sent to whatever host it names, so only point it at endpoints you trust.

## Testing

```bash
npm test               # unit tests for glob expansion and key resolution
npm run verify:ignore  # acceptance gate: glob ignore semantics
npm run verify:globs   # acceptance gate: glob path handling
npm run smoke          # drives the server over stdio as a real MCP client (needs a key)
```

The first three are hermetic and run in CI on Node 20, 22 and 24. `smoke` makes live API calls,
so it is run by hand.

## Releases

Published from CI with [provenance](https://docs.npmjs.com/generating-provenance-statements)
via npm trusted publishing — there is no long-lived npm token. Every release is staged and
requires a maintainer to approve it with 2FA before it becomes installable, and its provenance
ties the published tarball to this repository and the workflow that built it.

## Author

Built by **Jerold Billings**, Founder — [No Compromise AI, LLC](https://www.nocompromise.ai).

Bugs and questions: open an issue. Security problems: please use

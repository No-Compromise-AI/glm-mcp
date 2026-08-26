# glm-mcp

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

## Credentials

The server never hardcodes a key. It resolves one from, in order:

1. `ZAI_API_KEY`
2. `~/.config/zai/api-key`
3. the `api.z.ai` key ZCode already stores in `~/.zcode/v2/config.json`

Note that the ZCode **Start Plan** token is not usable here — that endpoint is captcha-locked to
the ZCode app and rejects outside clients with `3007`. You need an `api.z.ai` key with a Coding
Plan or credit on it.

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

## Behaviour worth knowing

- **GLM-5.3 always reasons.** A request without a thinking block is rejected with z.ai error
  `1210`, so `reasoning: "none"` is silently raised to `"low"` for that model. Its siblings
  (`glm-5.2`, `glm-5-turbo`, `glm-4.6`, `glm-4.7`) have no such constraint.
- Thinking budgets: `low` 2048, `high` 8192, `max` 24576 tokens. `max_tokens` is automatically
  raised to leave headroom for the answer on top of the budget.
- File context accepts literal paths and glob patterns. Each glob expands to the files it
  matches — sorted, de-duplicated, directories traversed but never listed, hidden (dot)
  entries skipped unless the pattern spells the dot out. Supported syntax: `*`, `**`, `?`,
  `[a-z]`/`[!a-z]`, `{a,b}` and `\` escapes. A pattern that matches nothing is reported in
  `Notes`, exactly like a missing file. Globs do not descend through symlinked directories
  (literal paths still follow symlinks).
- **Glob expansion skips dependency and output directories** — `node_modules`, `.git`,
  `dist`, `build`, `coverage`, `.next`, `.turbo`, `vendor`, `target` — so `**/*.ts` matches
  your source instead of 1,700 dependency type definitions crowding out the context budget.
  This applies to glob expansion only; a literal path such as `node_modules/foo/x.d.ts` goes
  through untouched. Naming a directory in the pattern itself also overrides the skip:
  `node_modules/foo/**/*.d.ts` matches as expected, because the caller asked for it by name.
  Set `GLM_MCP_GLOB_IGNORE` to a comma-separated list to **replace** the default set entirely
  (e.g. `GLM_MCP_GLOB_IGNORE=dist,.venv`); an empty value disables the skipping.
- File context is capped at 800,000 characters (`GLM_MCP_MAX_FILE_CHARS`) across the whole
  expanded set and truncates with a note rather than failing. Missing or unreadable files are
  skipped and reported, not fatal.
- Request timeout defaults to 10 minutes (`GLM_MCP_TIMEOUT_MS`).
- z.ai's coded errors are translated into actionable messages — `1113` (no balance),
  `1210` (reasoning required), `3007` (wrong credential type).

## Testing

```bash
npm test               # unit tests for glob expansion (builds first)
npm run smoke          # drives the server over stdio as a real MCP client (needs a z.ai key)
npm run verify:ignore  # acceptance gate for the glob ignore semantics
```

`smoke` covers the tool list, model list, reasoning, file context, glob expansion, the
`none`-to-`low` correction, and missing-file handling. `verify:ignore` checks the ignore
semantics against this repository and a throwaway fixture tree holding every default-ignored
directory: wildcards skip all of them (nested ones included), an explicit segment — escaped or
not — still enters the directory it names, a literal later in the pattern cannot unlock a
wildcard earlier in it, and `GLM_MCP_GLOB_IGNORE` replaces the defaults, trims its entries,
and disables skipping entirely when empty.

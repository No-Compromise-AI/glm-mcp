# @nocompromiseai/glm-worker

The headless delegation worker for the glm-mcp shell family. `glm-task`, `glm-review` and
`glm-answer` invoke it in place of a host Claude Code CLI: it drives
[@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk),
which vendors its own CLI binary, so delegated work completes on a machine with no `claude`
installed (glm-mcp [#90](https://github.com/No-Compromise-AI/glm-mcp/issues/90)).

It is its own package, not a dependency of `@nocompromiseai/glm-mcp`, on purpose: the vendored
binary is ~199MB and the MCP server is a small stdio package whose consumers mostly never
delegate. A checkout of the repository installs this package through the root `postinstall`
(`npm ci` is all it takes); by hand it is `npm ci --prefix packages/worker`.

## Usage

```
glm-worker [-p <prompt>] [--resume <session_id>] [--permission-mode <m>]
           [--allowedTools <t>...] [--add-dir <dir>] [--model <m>]
           [--output-format <fmt>] [--verbose]
```

The command line is the one the delegation path already spoke when it drove a host CLI, so the
call sites read as they always did. With `--output-format stream-json` stdout is one JSON
message per line ending in the `{"type":"result",...}` object `glm-task` records in its ledger;
without it stdout is the final result text alone, which is what `glm-review` greps a
`VERDICT:` line out of. Diagnostics go to stderr, never stdout.

The endpoint is z.ai's Anthropic-compatible API, resolved the way `bin/claude-glm` resolves
it: `ZAI_API_KEY`, then `~/.config/zai/api-key`, then the key zcode stores. `ANTHROPIC_BASE_URL`
and `ANTHROPIC_AUTH_TOKEN` win over both when already exported, so a script can point the
worker at a proxy or a stub. Sessions are stored under `CLAUDE_CONFIG_DIR`
(default `~/.claude-glm`) — the id in a result line resumes with `--resume`, which is how
`glm-answer` continues a run that stopped to ask something.

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
claude mcp add --scope user glm -- npx -y @nocompromiseai/glm-mcp@0.6.0
```

**Codex**

```bash
codex mcp add glm -- npx -y @nocompromiseai/glm-mcp@0.6.0
```

**Antigravity**

```bash
agy mcp add glm -- npx -y @nocompromiseai/glm-mcp@0.6.0
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
agy mcp add -e GLM_MCP_ROOTS=/abs/path/one:/abs/path/two glm -- npx -y @nocompromiseai/glm-mcp@0.6.0
```

Note that `GLM_MCP_ROOTS` bounds where a caller may point `cwd`; it does not exempt the launch
directory, which must also be inside a root. When it is not, the call is refused with a message
naming the offending `cwd` — loudly, rather than quietly matching no files.

Sharing one server between several agents has a cost the roots do not show: file reads are
synchronous, so a call that reads a tree delays every other call on that server until it
finishes — measured, a trivial call waited over 200× its own latency beside a 79 MB read. See
[Limits](#limits) for that, and for what `GLM_MCP_GLOB_TIMEOUT_MS` does and does not bound.

The version is pinned on purpose: a bare `npx` resolves `latest` at run time, while the package
itself ships the exact dependency graph it was tested with — pinning is what makes the two the
same graph. Bump the pin when you upgrade.

One exception, and it matters if you are working **on** this package rather than with it.
`npx` prefers a local package whose name and version satisfy the request, so inside a checkout
of this repository whose `package.json` version equals the pin, `npx` runs **your working tree**,
not the published tarball. That is often what you want while developing — but an unbuilt
checkout has no `dist/` to run and the server dies at startup with
`sh: glm-mcp: command not found`. Either build it (`npm install` runs the build), or register the
absolute path instead, which makes the substitution explicit:

```bash
claude mcp add --scope user glm -- node /absolute/path/to/glm-mcp/dist/index.js
```

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

The key and the endpoint are resolved on every call, not once at startup, so rotating the
key on disk takes effect on the next request and needs no restart. Nothing is rebuilt when
nothing changed — an unchanged key and endpoint keep the same connection — and if a
re-read fails while a working credential is already in use, the call is served from it
rather than failing, with the reason on stderr. A credential that resolved once is
evidence one exists, and a transient unreadable config should not take down a running
server.

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
| `messages` | `{role, content}[]` | — | the conversation so far, as prior turns this call continues — see below |
| `files` | string[] | — | files to include as context, each numbered `cat -n` style: literal paths (optionally with an inclusive line range, `src/auth/session.ts:40-120`) and/or globs (`src/**/*.ts`, `*.md`, `{lib,src}/*.ts`) |
| `cwd` | string | server cwd | what relative `files` resolve against |
| `model` | string | `glm-5.3` | any id from `glm_models` |
| `reasoning` | `none`\|`low`\|`high`\|`max` | `low` | higher is slower |
| `system` | string | — | optional system prompt |
| `max_tokens` | number | the model's own default (65,536 for GLM-5.3) | hard ceiling on output; see Reasoning |

**A long call reports that it is alive.** GLM-5.3 at `reasoning: "max"` over a
near-full context window can run for many minutes, and silence for that long
is indistinguishable from a hang — so if your client passes an MCP progress
token, the server sends a progress notification every `GLM_MCP_PROGRESS_MS`
(five seconds by default) while the call is in flight. No token, no
notifications. The answer itself is unchanged by any of this.

#### Pushing back on an answer

Every call used to be independent, and the natural second-opinion flow is disagreement —
*"you flagged session.ts:88, but the caller holds the lock."* Re-sending the whole file context
and hoping the consultant re-derives its own prior reasoning is what `messages` removes: pass
the conversation so far, and `prompt` as the push-back.

```json
{
  "prompt": "You flagged session.ts:88 — but the caller holds the lock across that whole block. Re-read it.",
  "files": ["src/auth/**/*.ts"],
  "reasoning": "high",
  "messages": [
    { "role": "user", "content": "Does the refresh logic have a race condition? Point at the lines." },
    { "role": "assistant", "content": "The refresh path in session.ts:88 reads expiresAt before taking the lock ..." }
  ]
}
```

The caller owns the history — there is no server-side session, so nothing is lost when the
server restarts underneath you. Append each turn as the conversation grows and re-send the
array; `prompt` stays required and is always sent as the **final user turn**, so never repeat
it inside `messages`.

- **File context rides the first turn.** With `files` and `messages` together, the context is
  attached to the thread's *first* turn and never repeated on the newest. A thread is exactly
  the shape prefix caching rewards, and the prefix stays cacheable only while the context
  stays at the front — measured on this account, a stable prefix with a varying tail read
  32,429 input tokens down to 45. Move the context to the latest turn and every follow-up
  re-prefills it, which is the cost threads exist to remove.
- **The thread spends the same budget as the files.** Prior turns count against the same
  character budget (`GLM_MCP_MAX_FILE_CHARS`, or the per-model derivation), so a long thread
  leaves less room for file context. The history itself is never cut — it is your own record
  of what was said — the files give way, and the truncation note says so:
  `truncated at 300 total chars (...; the thread history spent 1200 of it)`.
- **Roles are checked here, not by z.ai.** Each turn's `role` must be `user` or `assistant`;
  anything else is refused before anything is sent, naming the value you sent, rather than
  discovered as a 422 after the round trip. Within that, no ordering is imposed — z.ai
  accepts an assistant turn first, consecutive turns of one role and a trailing assistant
  turn — so replay a real transcript as it happened.

### `glm_review`

Review a change and get a verdict back. This is the review half of the delegate → review
loop, which used to live only in a bash script — putting it here is what lets Claude, Codex
and Antigravity all review to the same standard instead of each hand-rolling a prompt.

| arg | type | default | notes |
| --- | --- | --- | --- |
| `diff` | string | — | the unified diff to review, as your tooling produced it |
| `files` | string[] | — | optional files as extra context, resolved exactly as `glm_ask` resolves them |
| `spec` | string | — | what the change was *meant* to do; reaches the reviewer verbatim |
| `cwd` | string | server cwd | what relative `files` resolve against |
| `model` | string | `glm-5.3` | any id from `glm_models` |
| `reasoning` | `none`\|`low`\|`high`\|`max` | `high` | higher than `glm_ask`'s default, on purpose |
| `max_tokens` | number | the model's own default | hard ceiling on output |

At least one of `diff` or `files` is required. Called with neither, the call is refused
rather than answered — reviewing nothing and reporting a pass is the failure this tool
exists to prevent.

**The reply always ends with `VERDICT: PASS` or `VERDICT: CHANGES_REQUIRED`**, on its own
final line, spelled exactly that way. That is the vocabulary `bin/glm-review` greps for, so
a shell pipeline can consume the result; the two parsers are checked against each other by
`npm run verify:review` so they cannot drift apart.

**A bare verdict comes back as an error, never as a clean review.** A reply carrying less
than `GLM_REVIEW_MIN_SUBSTANCE` characters of analysis beside its verdict is refused. This
is the part most worth knowing about: a reviewer that returns "looks good" is worse than no
reviewer, because it converts an unexamined change into one with a clean bill of health.
The floor measures the model's *reply*, never the request — a floor computed from the
prompt or the diff is satisfied by exactly the long requests that most need checking. A
reply the output cap severed is refused too, whatever verdict it had already written.

Pass `spec` where you can. Review against intent is what catches silent scope-narrowing —
an agent quietly implementing less than was asked while every test still passes — and no
amount of reading the diff finds that on its own.

Reviews get the same heartbeat `glm_ask` gets: a progress notification every
`GLM_MCP_PROGRESS_MS` while the reviewer works, sent only to a client that
passed a progress token. A review is the same minutes-long model call, and its
caller stares at the same black box without one.

**This server never runs `git`.** The diff comes from the caller. The trust boundary here is
built around reading files (see [Path confinement](#path-confinement)), and executing a
subprocess in a caller-influenced directory is a different and much larger surface.

Use a different model than the one that wrote the code where you can. A model re-reading its
own work reliably under-reports.

### `glm_models`

Lists the model ids available on the configured account, each with a one-line role.
The request path is text-only — no image is ever attached — so picking a model that
accepts images (`glm-4.6v` and siblings, and `glm-5.3-flash`, which is natively
multimodal though its name says nothing of it) forgoes the modality it was selected
for; each such id's role says so. An id this server's model table does not know is
listed bare: it stays z.ai's to describe, exactly as it stays z.ai's to size.

## Asking from a shell

The same package is a one-shot CLI. It is the same code the MCP tools call — same
confinement, same budget, same per-model ceilings — reached by argv instead of a client:

```bash
glm-mcp ask -f 'src/**/*.ts' --reasoning high "where can this invariant break?"
glm-mcp models          # ids, with what each one is for
glm-mcp key             # which of the three sources the key resolves from
glm-mcp key --print     # the key itself, for a script that needs it
```

**stdout is the answer and nothing else** — notes, refusals and the cost line go to stderr —
so `ANSWER=$(glm-mcp ask ...)` is exactly the answer. With no subcommand the same binary is
the stdio MCP server it has always been, and unrecognised arguments still start the server,
because MCP clients pass flags of their own.

Files are read through the same confinement as the server: a path outside `GLM_MCP_ROOTS` is
refused here exactly as it is over MCP. This is not a second implementation — it is
`buildFileContext`, which enforces the roots itself.

`glm-mcp key` exists so `bin/claude-glm` stops resolving the key a second time in bash. Those
two copies had already drifted: this server requires `GLM_MCP_ALLOW_ZCODE_KEY=1` before it will
use the key ZCode stores, and the shell copy read that file unconditionally, which made the
wrapper quietly more permissive than the server it wraps. Bare `key` prints the *source*
rather than the secret, so an accidental invocation is not a leak.

This does **not** replace `claude-glm`. That turns GLM into an agent with tool use and
editing; this is a single question and a single answer. Different jobs.

## Writing a spec the loop can hold you to

Two of the worst defects this toolchain has shipped came from a single ambiguous
sentence in a spec, resolved silently and plausibly by the implementer. Neither was
caught by its acceptance gate, because the same person wrote the gate and the spec in
the same words on the same afternoon — **correlated oracles, not independent ones.**

- *"normalise baseURL before comparing (trailing slash, empty string treated as unset)"*
  bundles three decisions into one clause: what counts as equivalent, whether normalising
  is in place or scoped to the comparison, and what "unset" implies downstream. The
  normalisation landed on the value that gets **sent**, and a bearer token went to the
  vendor's default endpoint.
- *"whether a URL can be MADE of it"* — "it" has two referents. Read as the joined URL,
  `http://` passes, because `http://` + `v1/messages` parses, and the token goes to a host
  called `v1`.

Both are mechanically detectable before dispatch: **a pronoun whose referent is ambiguous,
and a compound instruction bundling several decisions into one clause.** Read your spec
back looking for those two shapes specifically. It is cheaper than finding them in review,
and far cheaper than finding them in production.

Three habits that follow:

- **Name the observable, not the mechanism.** "the caller receives X when it sends Y",
  never "the function normalises Z" — the second specifies a design and cannot be checked
  from outside.
- **Say which value a rule applies to** when a value is transformed on its way somewhere.
  "the value used for comparison" and "the value sent" are different things and the defect
  above lives in the gap.
- **Ask for the assumption.** `glm-task`'s notes channel has an `assumption` level below
  `scope`: it never interrupts anyone and lands in the ledger, and the standing instruction
  asks the agent to log any sentence it read one particular way, with the reading it chose.
  It is exempt from the channel's usual "default to silence" rule, because a resolved
  ambiguity does not feel like a fork from the inside — it feels like reading.

For a change where being wrong is expensive, pass `-S` to `glm-review`: a PASS from a
single reviewer is one model's opinion, and `-S` refuses to call that reviewed.

### Dogfooding is a step, not a good intention

Across one 33-run session the `glm_ask` consultant was used substantively **three times**,
and those three calls produced three real defects — the routing guidance that sends callers
to models the file-context budget was not sized for, `reasoning: "none"` selecting the
opposite of what it says, and a README example citing a line number the model could not
have counted. Eighteen acceptance gates were green across the same work.

Gates cannot substitute for this, and that is the point: **every gate checks a property
somebody already thought of.** All three findings are of the form *the tool documents or
implies something it cannot do*, which is invisible to a test written from the same
understanding that produced the defect.

So after a caller-facing change lands, put the new surface in front of the model and ask it
to **use** it, not to review the diff. "Route these six requests using only this guidance"
is a usage question; "is this diff correct" is not, and only the first found #59. File what
comes back, and verify it before acting — one of the model's own retro claims about this
toolchain was simply wrong.

## The shell tools in `bin/`

This repository holds two things that share a name and almost nothing else, and conflating
them is the fastest way to be confused by it:

| | what it is | what GLM is |
| --- | --- | --- |
| the MCP server — `glm_ask`, `glm_review`, `glm_models` | a server another agent calls mid-task | **a tool** the agent consults, keeping the wheel |
| `bin/` — eleven commands, below | shell around GLM agent sessions | **the agent**, doing the work in the repository |

**These commands are not in the npm package.** `npm install @nocompromiseai/glm-mcp` — or the
`npx` registration above — gives you the MCP server and nothing else: `files` ships `dist/`,
the README and the lockfile, deliberately, because an npm consumer has no CLI for these to
drive and no reason to carry them. To get them, clone the repository and put its `bin/` on
your PATH:

```bash
git clone https://github.com/No-Compromise-AI/glm-mcp.git
cd glm-mcp && npm ci          # the postinstall also installs the delegation worker
export PATH="$PWD/bin:$PATH"  # or symlink the commands into ~/.local/bin
```

The MCP server and these commands are independent: you can register the server from npm and
never clone, and the server does not need `bin/` to work. What you cannot do is reach the
delegation loop from an npm install alone, which is the thing that was previously undocumented
(#89).

`bin/claude-glm` points the Claude Code CLI at z.ai, so GLM drives an interactive session.
Delegation does not go through it: `bin/glm-task` hands the task to `bin/glm-worker`, which
runs the Claude Agent SDK — a binary the worker package vendors, so the delegate → review →
answer path needs no host CLI installed (#90) — verifies the result independently, has a
*different vendor's* model review it against the spec, and records the outcome. The record
says what a run identifies, not only what happened: the branch it worked on — the one
`-W`/`-b` created, or the branch an in-place run stands on — and the issue, when the task
names one as `#123`, `issue 123`, or the `gh issue view 123` line. `dir` alone names a temp
worktree that is deleted afterwards (#77). Reviewer
selection follows the agent you are sitting in — `GLM_HOST` — so the host driving a delegation
is never its own
reviewer: from Claude that is codex + agy, from Codex claude + agy, from Antigravity codex +
claude. `-r all` asks all three.

### The commands

| | |
| --- | --- |
| `claude-glm` | points the Claude Code CLI at z.ai, so GLM drives an interactive session. The delegation path does not use it — it needs no host CLI |
| `glm-worker` | the headless agent the delegation path runs: the Claude Agent SDK against z.ai, vendored in `packages/worker` so delegating needs no Claude Code installed. `npm ci` at the repo root installs it (that is the `postinstall`); by hand: `npm ci --prefix packages/worker` |
| `glm-task` | delegate one task: run the agent, verify independently, have a different vendor's model review it against the spec, one fix round, record the outcome |
| `glm-drain` | work a list of GitHub issues unattended — `glm-task` per item, `glm-ship` for what passes, parking for what needs you |
| `glm-review` | review a change against the spec it was meant to implement, with a chosen reviewer or `auto` |
| `glm-ship` | take a branch to merged-and-verified: PR, auto-merge, watch checks |
| `glm-answer` | resume a run that stopped to ask something, with your decision |
| `glm-notes` | what delegated runs have raised for you, with the resume command for each |
| `glm-stats` | hit rate, turns and duration across recorded runs |
| `glm-why` | a run's visible reasoning and tool trace |
| `glm-gc` | remove finished delegation worktrees. Only ever touches `glm-wt-*`, and never anything with uncommitted work |

### Draining a backlog unattended

```bash
glm-drain -i 65,67,71 -v "npm test"
```

Each issue's title and body become the spec. What passes review is shipped; what does not is
**parked** with its session id and worktree so `glm-answer` can resume it. The drain never
attempts to answer a blocked item itself — a wrong guess made at 3am becomes a merged commit.

Two things it will not do, both deliberate. It **refuses** `-j` above 4 rather than silently
clamping, because an operator who believes they are running nine wide and is actually running
four has been told something untrue. And on any rate-limit signal it drops to one worker for
the rest of the run and never widens again — backing off and immediately re-widening is the
same evasion done more slowly. z.ai publishes no concurrency limit and returns no rate-limit
headers, so staying conservative and reacting to pressure is the whole of what can honestly be
promised.

Because merges are automatic: an unreviewed item is never shipped, shipping is serialised so
each item's CI runs against a main containing the last, and consecutive failures stop the line
rather than letting a broken main become the base for the rest of the night.

### Knobs

| | | |
| --- | --- | --- |
| which agent is driving, so it is never its own reviewer | `GLM_HOST` | detected for Claude; set it in Codex and Antigravity |
| default reviewer spec | `GLM_REVIEWER` | `auto` |
| the reviewer pool `auto` and `all` draw from | `GLM_REVIEWER_POOL` | `codex claude agy` |
| where `auto` lands when the host is unknown | `GLM_AUTO_FALLBACK` | `codex` |
| model `agy` reviews with | `GLM_AGY_MODEL` | `claude-opus-4-6-thinking` |
| reviewer deadline, and liveness tick | `GLM_REVIEW_TIMEOUT` / `GLM_REVIEW_HEARTBEAT` | 900s / 60s |
| largest diff sent to a reviewer | `GLM_REVIEW_MAX_DIFF` | |
| tool allowlist for the delegated agent | `GLM_TASK_TOOLS` | |
| outcome ledger, and log path | `GLM_TASK_LEDGER` / `GLM_TASK_LOG` | `~/.claude-glm/outcomes.jsonl` |
| where `glm-review` writes its machine-readable record — who reviewed, with which model, who did not and why. `glm-task` sets this itself and folds the result into the ledger row as `review_record`; set it yourself to capture the same record when calling `glm-review` directly | `GLM_REVIEW_RECORD` | unset — no record is written |
| where `-W` worktrees are made | `GLM_WORKTREE_ROOT` | `$TMPDIR` |
| where a run writes what it wants you to know | `GLM_NOTES` | a per-run file in `$TMPDIR` |
| note levels that raise a desktop notification | `GLM_NOTIFY_LEVELS` | `blocked` |
| grace before concluding a PR has no CI | `GLM_SHIP_CHECK_GRACE` | 1500s — measured; GitHub can take 2.5–20 min to create a run |
| drain: parked queue, first backoff step, halt threshold | `GLM_DRAIN_STATE_DIR` / `GLM_DRAIN_BACKOFF_BASE` / `GLM_DRAIN_MAX_FAILS` | `~/.claude-glm` / 60s / 2 |
| drain: skip GitHub, treat items as opaque ids | `GLM_DRAIN_OFFLINE` | |
| drain: override the commands it drives | `GLM_TASK_CMD` / `GLM_SHIP_CMD` | the siblings in `bin/` |

**These are not in the published npm package.** This package's promise is the server; the
shell family is the other half of the same idea, and it lives here because ~1,700 lines of
working shell deserve a history. Use them from a checkout. One of them is heavy: `glm-worker`
runs a ~199MB vendored binary, which is why it sits in `packages/worker` as its own package
rather than a dependency of this one — `npm ci` at the repo root installs it via `postinstall`,
so a fresh checkout can delegate with nothing further.

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

When `glm_ask` is called with a thread (`messages`), the assembled context is attached to the
thread's **first** turn rather than the newest, so the prefix stays cacheable across
follow-ups — see [Pushing back on an answer](#pushing-back-on-an-answer).

Every file arrives **with line numbers, `cat -n` style** — each line prefixed with its own
number, so an answer like `session.ts:88 reads expiresAt before taking the lock` cites a line
the model can actually see rather than one it had to count blind. The example answer above is
a description of what comes back, not an aspiration.

A literal path may name a **line range**: `src/auth/session.ts:40-120` sends lines 40 through
120, both ends inclusive, and nothing outside them. The excerpt keeps the **file's** numbering
— those lines arrive numbered 40 to 120, never renumbered from 1 — so a citation against an
excerpt points exactly where it would against the whole file. A range is how you send one
region of a large file without the rest, which also cuts prefill and helps latency. A path
that exists on disk is still read literally even when its name ends in something a range
could be parsed out of: a real `weird:10-20.txt` is a filename, the same rule literal paths
already have against glob characters. A range that names nothing readable is reported in
`Notes` in your own spelling, exactly like a missing file.

**Supported syntax:** `*`, `**`, `?`, `[a-z]`, `[!a-z]`, `{a,b}`, and `\` escapes.

- `.` and `..` resolve against `cwd`, so `./src/**` and `../neighbour/src/**` work.
- A path that exists on disk is read literally even if its name contains metacharacters — a
  real `report[final].md` is read, not pattern-matched.
- Hidden (dot) entries match only when the pattern spells the dot out.
- A pattern matching nothing is reported in `Notes`, exactly like a missing file — and when the
  call supplied no `cwd` and nothing else it asked for arrived either, that report also says the
  search ran in the directory the server was started in and names `cwd` and `GLM_MCP_ROOTS` as
  the knobs, so a mis-launched server (see the per-host table above) is diagnosable from the
  reply instead of reading as an ordinary no-match. The knobs are companions, not alternatives:
  `cwd` moves the search, and `GLM_MCP_ROOTS` widens the roots the new `cwd` must resolve
  inside — a `cwd` outside the roots is refused until it is widened. The extra sentence belongs
  to a call that delivered nothing: a duplicate beside its own delivered match, or a no-match
  beside files that did arrive, reads as the plain no-match it always was, as do a missing file
  and an empty line range — sending a caller who already has its files to look elsewhere would
  point at the wrong fix. The note names no path — which directory the server started in is the
  machine's business, not the caller's.
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
| Heartbeat interval for progress notifications on a long call | `GLM_MCP_PROGRESS_MS` | 5,000 |
| Least analysis a `glm_review` verdict may stand on, in characters of the reply beside the verdict line | `GLM_REVIEW_MIN_SUBSTANCE` | 200 |

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

A thread's prior turns (`messages` to `glm_ask`) spend this same budget before the first
file is read, so a long thread leaves less room for file context — and the truncation note
says how much the history spent when it is what crowded the files.

That ratio targets **English and code deliberately** — this is what the project
is built for. Denser scripts pack more tokens per character (Chinese runs nearer
one token per character), so a CJK-heavy caller should lower
`GLM_MCP_MAX_FILE_CHARS`; overshooting surfaces as a context-length error from
z.ai rather than a silent truncation. `GLM_MCP_CONTEXT_TOKENS` overrides the
window for **every model at once** — a published figure that proves wrong is
corrected with one variable, not a code change — and `GLM_MCP_MAX_FILE_CHARS`
overrides the character budget outright, also for every model.

`GLM_MCP_GLOB_TIMEOUT_MS` bounds the **work** a walk does, not the time it can spend blocked
inside a syscall. The deadline is checked between operations — on the way into each directory,
and every 64th entry within a scan — so a big walk tests it thousands of times, but never
*during* an operation: a `readdirSync` that has not returned cannot be interrupted by it. A hung
FUSE, NFS or SMB mount is exactly that case, and it is the one an operator reading the timeout
as a wall-clock guarantee would be wrong about: the walk freezes mid-call with most of its
budget unspent, and nothing fires until the syscall comes back — if it comes back. The timeout
bounds what a walk does, never what it waits on.

**File reads are synchronous, so a call that reads a tree delays every other call on the same
server until it finishes.** The walk, the reads and the assembly around them are `readdirSync` /
`statSync` / `readFileSync`, and they block the event loop; the round trip to z.ai is
asynchronous. It is specifically the filesystem half that does not interleave: two calls with
no files, issued together against an upstream deliberately held at 300 ms per call, finished in
306 ms rather than 600. With files it is the other way round — measured through the real MCP
surface against an upstream that answers instantly, so every millisecond is the server's own
doing, a call reading 400 files (79 MB) took 680 ms while a trivial call issued beside it, one
that reads nothing and answers in 3 ms alone, took 637 ms and finished with the read rather
than on its own schedule. That is over 200× its own latency, all of it spent waiting on another
caller's context, and it is the number to weigh before running one shared server for several
agents: their calls serialise behind each other's file context, and the limits above are all
that bound how long one read holds the rest. Two things about that 400-file run are worth
knowing when you size your own cap. It needed `GLM_MCP_MAX_FILE_CHARS` raised to 100,000,000
for the run — the default derived budget would have cut the same walk far sooner — and even
100,000,000 is less generous than it looks, because the cap measures the text delivered, not
the bytes read: line numbers and headers swell 79 MB of files to 85.2M characters of prompt,
so a cap sized to the bytes on disk would cut this walk at the 372nd file and never read the
last 28. Size the cap to the prompt you are willing to pay for, not to the tree.

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

A call that long is otherwise a black box, so `glm_ask` and `glm_review` send
**MCP progress notifications** while the model works — one every
`GLM_MCP_PROGRESS_MS` (five seconds by default), each carrying the time
elapsed, and only to a client that asked by passing a progress token with the
request. Unsolicited progress is a protocol violation rather than a courtesy;
a client that sends no token gets none. The heartbeat is time-based, not
token-based: what it tells you is that the call is still alive, which is what
you cannot otherwise tell — tokens-so-far would need the request switched to
streaming. It stops when the call ends, however it ends, and it changes
nothing about the answer: same text, same usage footer, same notes.

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

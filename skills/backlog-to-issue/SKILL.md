---
name: backlog-to-issue
description: Turn a PostMQ backlog item into a GitHub issue that a GLM agent can actually execute — triaged, grounded in real files, with a behavioural done-when and a verify command. Use when the user says "triage this backlog item", "turn backlog item X into an issue", "get the backlog ready for GLM", "write this up as an issue", "prep these for draining", or types `/backlog-to-issue`. The output is the input to `glm-drain -i <issue>`.
---

# /backlog-to-issue — make a backlog item delegable

A PostMQ backlog item is written mid-session, for a human, by someone who had the whole
context in their head. A GLM agent has none of that. It gets the issue text and a repository,
and everything the item left implicit becomes something it has to guess.

This skill closes that gap. **In: a backlog item. Out: a GitHub issue `glm-drain -i <n>` can
work, and a backlog item that points at it.**

It is a triage step, not a formatting step. Some items should not become issues at all.

---

## 1. Read the item, and its neighbours

`mcp__postmq__get_backlog_item` for the item. Then, before writing anything:

- `mcp__postmq__query_decisions` for anything touching the same area — an item often
  restates a problem a decision already settled, or contradicts one.
- `mcp__postmq__query_applicable_rules` with the paths you expect to touch.
- Existing GitHub issues. A duplicate issue is worse than no issue: two agents will work it.

## 2. Triage — decide what this item IS

Not every item is ready. Pick one, and say which:

| verdict | when | what to do |
| --- | --- | --- |
| **Ready** | one behaviour changes, and you can name what "working" looks like | write the issue |
| **Too big** | more than one behaviour, or "and" in the title | split into several issues, each independently shippable and verifiable |
| **Underspecified** | you cannot write a done-when without guessing | ASK the user. Do not invent the missing half |
| **Already done** | the code already does it | resolve the backlog item with closing notes; write no issue |
| **Not a code change** | a decision, a question, a policy | it belongs in the decision log, not an issue |

**Underspecified is the common one and the expensive one.** An agent handed an ambiguous spec
does not stop — it picks an interpretation and builds it, and you find out after review. If
you cannot state the done-when, the item is not ready and asking costs a minute.

## 3. Ground it in the actual code

This is what separates an issue an agent can execute from one it has to interpret. Before
writing, find and note:

- the files and functions that will change — by path, with line numbers where useful;
- what already exists that should be **reused** rather than reimplemented;
- how the current behaviour is wrong, reproduced. A reproduction in the issue is worth more
  than a paragraph of description.

An issue that names `src/confine.ts:42` and says "reuse `envLimit` from `src/limits.ts`" gets
a focused change. One that says "fix the path handling" gets a rewrite.

## 4. Write the issue

```markdown
## Why
<the problem, and the evidence it is real — a reproduction, a log line, a failing case.
 Not "it would be nice if". If it came from a review or a dogfooding session, say so.>

## What done looks like
<BEHAVIOURAL. What is true afterwards that is not true now, observable from outside.>

## Verify
```bash
<one command. It must FAIL before the change and PASS after.>
```

## Where
<files, functions, line numbers. What to reuse and where it lives.>

## Constraints
- <what must NOT change — protected files, public contracts, the acceptance gate>
- <invariants that must survive>

## Not in scope
<the adjacent things a reasonable agent would otherwise wander into>
```

### The rules that make this work, and what they cost when broken

These are not style preferences. Each one is here because it failed:

- **The done-when must be behavioural.** `npm run build` passed on the first delegated issue
  while the change shipped a real gap. "Builds" and "tests pass" are not done-whens; they are
  things that were already true.
- **The verify command must fail before the fix.** A verify that passes on unchanged code
  proves nothing, and the agent will correctly report success having done nothing. Run it
  before you write the issue and confirm it fails.
- **Name what not to touch.** Especially the acceptance gate: an agent asked to make a gate
  pass will sometimes edit the gate. Say it is protected, and say that if the gate seems wrong
  it should raise a `scope` note and stop rather than work around it.
- **Non-goals are load-bearing.** The recorded failure mode of delegation is silent
  scope-narrowing in one direction and quiet scope-creep in the other. Naming the boundary
  costs a line.
- **Do not pad.** An issue that lists ten "nice to haves" gets an agent optimising the wrong
  thing. One behaviour per issue.

## 5. If it changes behaviour, the gate comes first

For anything behavioural, write the acceptance gate **before** the issue is drained, commit it
**failing**, and reference it from the issue. The convention in this repository is that the
gate defines done — an issue whose gate does not yet exist is an issue whose done-when is still
a sentence rather than a check.

Write gates as **rules about behaviour**, not a list of expected outputs, and include at least
one rule that forbids the *wrong* fix. Then confirm the gate can actually fail by breaking the
property on purpose — and make sure the break is real. A mutation that does not actually
violate the property proves nothing about the gate.

## 6. Link it both ways, or it will be done twice

- The issue body ends with: `PostMQ backlog item: <ULID>`.
- `mcp__postmq__amend_backlog_item` — put the issue URL in the item.
- `mcp__postmq__triage_backlog_item` to `in_progress` once the issue exists.

Without both links, the next session reads the backlog, sees an open item, and files a second
issue for work already in flight.

## 7. Hand off

Report the issue number and say plainly whether it is ready to drain:

```bash
glm-drain -i <n> -v "<the verify command>"
```

For several items, produce them all first and drain as a batch — `glm-drain` handles the
queue, the concurrency and the rate limits. Your job ends when each issue could be handed to
someone with no context and they would build the right thing.

---

## What good looks like

Read the issue back and ask: **if I knew nothing about this project, could I do this and know
when I was finished?** If the answer needs anything you happen to remember, it is not done.

And the honest test of the batch: if every issue you just wrote were built exactly as written,
would the backlog actually be drained — or would you have a pile of PRs that each did
something adjacent to what was needed?

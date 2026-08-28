#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  ask,
  buildFileContext,
  DEFAULT_MODEL,
  explainError,
  listModels,
  modelRole,
  outputLimits,
  MIN_BUDGET_TOKENS,
  MIN_ANSWER_TOKENS,
  type AskResult,
  type Reasoning,
} from "./glm.js";
import { buildReviewPrompt, minSubstance, substanceOf, verdictOf } from "./review.js";

// Read rather than repeated: a literal here drifts from package.json on every
// release, and the only symptom is a server quietly misreporting itself. From
// dist/index.js this resolves to the package root, published and local alike.
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const server = new McpServer({ name: "glm", version });

/**
 * The cost line every tool that reaches GLM appends, in the brackets callers
 * already read: what answered, what it cost, and whether the answer actually
 * finished. glm_ask and glm_review share it so the two cannot drift into
 * footers a caller has to parse twice.
 */
const usageFooter = (result: AskResult): string =>
  [
    result.model,
    `in ${result.usage.input} / out ${result.usage.output} tok`,
    result.usage.cacheRead ? `cached ${result.usage.cacheRead}` : null,
    result.thinkingChars ? `reasoned ${result.thinkingChars} chars` : null,
    // #41: an answer the output cap severed mid-reply is not a finished
    // one, and this footer is where the caller already reads what the
    // answer cost — so the marker sits beside it. A normally finished
    // answer says nothing: flagging it would cry wolf on every reply.
    result.stopReason === "max_tokens" ? "stopped at max_tokens" : null,
  ]
    .filter(Boolean)
    .join(" · ");

server.registerTool(
  "glm_ask",
  {
    title: "Ask GLM",
    description:
      "Send a prompt to a Z.ai GLM model (default GLM-5.3) and return its answer. " +
      "GLM-5.3 is an independent frontier model with a million-token context window, " +
      "so this is useful for a genuine second opinion from a different model, for " +
      "cross-checking reasoning, and for analysing far more source material at once than " +
      "fits in a normal context. Optionally pass file paths to include as context. " +
      // #54: model and reasoning are the two latency levers, and the knob was
      // already exposed with nothing telling a caller when to turn it. Thinking
      // tokens are generated before the first character of the answer, so the
      // routing belongs where the caller actually reads it.
      "Model and reasoning are the latency levers: thinking tokens are generated " +
      "before the first character of the answer, and the thinking budget spans " +
      "2,048 at 'low' against 24,576 at 'max' — a twelve-fold spread. Route " +
      "mechanical work (extract, summarise, reformat, classify) to glm-5.3-flash or " +
      "glm-4.6 at 'low'; glm-4.6 alone can go further, to 'none' — glm-5.3-flash " +
      "cannot run with reasoning off, so its 'none' is raised to 'low'. Keep " +
      "GLM-5.3 at 'high' or 'max' for design review, cross-checking reasoning, and " +
      "hunting a subtle bug. glm-4.6 and glm-4.7 accept reasoning 'none'; GLM-5.3 " +
      "and glm-5.3-flash cannot, so 'low' is their shallowest setting.",
    inputSchema: {
      prompt: z.string().describe("The question or instruction to send to GLM."),
      files: z
        .array(z.string())
        .optional()
        .describe(
          "Optional files to include as context: literal paths and/or glob patterns " +
            '(e.g. "src/**/*.ts"). Each glob expands to its matching files, sorted and ' +
            "de-duplicated across the whole list; a pattern that matches nothing is reported " +
            "in the response notes. A path that exists on disk is used literally even when it " +
            "contains glob characters. Glob expansion skips node_modules, .git and build " +
            "output by default; naming a directory in the pattern (node_modules/foo/**/*.d.ts) " +
            "or setting GLM_MCP_GLOB_IGNORE overrides that. Relative paths — ./ and ../ " +
            "prefixes included — resolve against 'cwd'. Every file arrives with cat -n style " +
            "line numbers, so answers can cite path:line and mean it; a literal path may " +
            'carry an inclusive line range ("src/auth/session.ts:40-120") to send just that ' +
            "region, numbered with the file's own line numbers rather than renumbered from 1.",
        ),
      cwd: z
        .string()
        .optional()
        .describe("Directory that relative file paths resolve against. Defaults to the server's cwd."),
      model: z
        .string()
        .optional()
        .describe(
          `GLM model id. Defaults to ${DEFAULT_MODEL} (the frontier flagship); ` +
            "glm-5.3-flash and glm-4.6 are the fast routes, and glm_models lists every id " +
            "the account offers with a one-line role.",
        ),
      reasoning: z
        .enum(["none", "low", "high", "max"])
        .optional()
        .describe(
          // #54: each level beside what it is for — a bare list of levels is a
          // knob with no label. The budgets are BUDGET's own numbers.
          "Reasoning depth — the largest latency lever in this tool: thinking tokens are " +
            "generated before the first character of the answer, and the budget runs " +
            "2,048 at 'low', 8,192 at 'high', 24,576 at 'max'. Use 'none' or 'low' for " +
            "mechanical work — extract, summarise, reformat; use 'high' or 'max' to " +
            "review a design, cross-check reasoning, or hunt a subtle bug. GLM-5.3 and " +
            "glm-5.3-flash always reason: GLM-5.3 rejects 'none' outright, while " +
            "glm-5.3-flash accepts it and silently reasons anyway, so 'none' is " +
            "raised to 'low' for both.",
        ),
      system: z.string().optional().describe("Optional system prompt."),
      max_tokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Max output tokens — a hard cap. The request never exceeds it; the thinking " +
            "budget scales down to fit beneath it, always leaving room for the answer, " +
            `but never below the API minimum of ${MIN_BUDGET_TOKENS}. A cap below ` +
            // The threshold ask() enforces is the budget minimum plus
            // MIN_ANSWER_TOKENS — the least room that still constitutes an
            // answer — not plus ANSWER_ROOM, which is only what a generous cap
            // PREFERS to leave. Quoting the preference here refused, on paper,
            // caps the request path deliberately sends: #20 settled that a cap
            // of 5,000 with 3,976 for the reply is an answer by any reading.
            `${MIN_BUDGET_TOKENS + MIN_ANSWER_TOKENS} — the API's budget minimum plus ` +
            "the least room that still constitutes an answer — cannot hold both and " +
            "is refused rather than silently raised; on GLM-5.3 and glm-5.3-flash, " +
            "which always reason, the only fix is a higher cap. " +
            "A cap over the model's published ceiling is likewise refused before " +
            // DEFAULT_MODEL is an OUTPUT_LIMITS key, so its ceiling is defined.
            `anything is sent (${outputLimits(DEFAULT_MODEL).max!.toLocaleString("en-US")} for GLM-5.3). ` +
            "Omit it and the model's own default applies " +
            `(${outputLimits(DEFAULT_MODEL).def.toLocaleString("en-US")} for GLM-5.3).`,
        ),
    },
  },
  async ({ prompt, files, cwd, model, reasoning, system, max_tokens }) => {
    try {
      let finalPrompt = prompt;
      const notes: string[] = [];
      // Resolved once, used twice: the file context and the request itself are
      // sized for the SAME model (#59) — the budget follows the model the
      // caller chose (or the default when it chose none), never a private
      // default of this file's own, which is how index.ts has been wrong
      // before while every check beneath it stayed green.
      const chosenModel = model ?? DEFAULT_MODEL;

      if (files?.length) {
        const ctx = buildFileContext(files, cwd ?? process.cwd(), chosenModel);
        notes.push(...ctx.notes);
        // A refused call read nothing. Sending the prompt anyway would answer
        // the question with none of the material it asked about — a silent
        // failure wearing a success — so the refusal is the whole result and
        // GLM is never asked.
        if (ctx.refusedCall) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Refused: no file context was read.\n\n${ctx.notes.join("; ")}`,
              },
            ],
          };
        }
        if (ctx.text) finalPrompt = `${ctx.text}\n\n---\n\n${prompt}`;
      }

      const result = await ask({
        prompt: finalPrompt,
        model: chosenModel,
        reasoning: (reasoning ?? "low") as Reasoning,
        system,
        // #36: omitted, ask() applies the model's own published default — not a
        // constant of ours.
        maxTokens: max_tokens,
      });

      const footer = usageFooter(result);

      const body = [
        result.text || "(empty response)",
        "",
        `[${footer}]`,
        ...(notes.length ? ["", `Notes: ${notes.join("; ")}`] : []),
      ].join("\n");

      return { content: [{ type: "text" as const, text: body }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `GLM request failed.\n\n${explainError(e)}` }],
      };
    }
  },
);

server.registerTool(
  "glm_review",
  {
    title: "Review with GLM",
    // #65: the description's first job is to promise the output shape — a
    // review tool whose result is a surprise can only be read by a human
    // skimming prose, and everything downstream of this tool (bin/glm-review
    // included) greps for the verdict line instead.
    description:
      "Review a change with a Z.ai GLM model (default GLM-5.3) and return a " +
      "VERDICT: the reply is the reviewer's analysis and always ends with a " +
      "final line that is exactly VERDICT: PASS or VERDICT: CHANGES_REQUIRED — " +
      "the same vocabulary bin/glm-review reads, so a shell pipeline can consume " +
      "the result. Pass the change as a unified diff and the requirement it was " +
      "meant to implement as spec: review against intent is what catches silent " +
      "scope-narrowing, and the reviewer is warned off both recorded pathologies " +
      "— findings that are padded or fabricated, and work that is stubbed, mocked " +
      "or hardcoded rather than implemented. A reply that is a bare verdict with " +
      "no analysis behind it comes back as an error, never as a clean review. " +
      "This server never runs git and inspects no repository state on its own: " +
      "the diff comes from the caller, and files resolve exactly as glm_ask " +
      "resolves them. Reviews default to reasoning 'high' — the depth the glm_ask " +
      "routing guidance reserves for review and bug-hunting — and a different " +
      "model than the one that wrote the code is worth choosing where you can, " +
      "because a model re-reading its own work reliably under-reports.",
    inputSchema: {
      diff: z
        .string()
        .optional()
        .describe(
          "The unified diff to review, as your tooling produced it. The server " +
            "never runs git — the caller supplies the change under review, and this " +
            "argument is how. Either diff or files must be present; with neither, " +
            "the call is refused rather than answered with a verdict about nothing.",
        ),
      files: z
        .array(z.string())
        .optional()
        .describe(
          // The same resolution glm_ask performs, stated as such: the promise
          // is a function call against buildFileContext, not a paraphrase,
          // and a caller who has learned glm_ask's behaviour has learned all
          // of this too.
          "Optional files as review context, resolved exactly as glm_ask resolves " +
            "them (same confinement to the operator's roots, same per-model " +
            "character budget, same notes): literal paths and/or glob patterns " +
            '(e.g. "src/**/*.ts"). Each glob expands to its matching files, sorted ' +
            "and de-duplicated across the whole list; a pattern that matches " +
            "nothing is reported in the response notes. A path that exists on disk " +
            "is used literally even when it contains glob characters. Glob " +
            "expansion skips node_modules, .git and build output by default; naming " +
            "a directory in the pattern (node_modules/foo/**/*.d.ts) or setting " +
            "GLM_MCP_GLOB_IGNORE overrides that. Relative paths — ./ and ../ " +
            "prefixes included — resolve against 'cwd'.",
        ),
      spec: z
        .string()
        .optional()
        .describe(
          "What the change was meant to do — the requirement, ticket or plan it " +
            "was written against. Reaches the reviewer verbatim. Review against " +
            "intent is the only check on silent scope-narrowing, this loop's " +
            "recorded failure mode; with no spec the reviewer can only infer " +
            "intent from the diff itself.",
        ),
      cwd: z
        .string()
        .optional()
        .describe("Directory that relative file paths resolve against. Defaults to the server's cwd."),
      model: z
        .string()
        .optional()
        .describe(
          `GLM model id. Defaults to ${DEFAULT_MODEL} (the frontier flagship); ` +
            "glm-5.3-flash and glm-4.6 are the fast routes, and glm_models lists every id " +
            "the account offers with a one-line role.",
        ),
      reasoning: z
        .enum(["none", "low", "high", "max"])
        .optional()
        .describe(
          "Reasoning depth — same levels as glm_ask, but the default here is " +
            "'high' rather than 'low': a review is the work the routing guidance " +
            "reserves 'high' for, and a reviewer skimming on the 2,048-token " +
            "'low' budget is the rubber stamp with extra steps. Use 'max' " +
            "(24,576 tokens) for a large or subtle change, and 'low' only for a " +
            "re-check you expect to be mechanical. GLM-5.3 and glm-5.3-flash " +
            "always reason, so 'low' is their shallowest setting.",
        ),
      max_tokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Max output tokens — a hard cap. The request never exceeds it; the thinking " +
            "budget scales down to fit beneath it, always leaving room for the answer, " +
            `but never below the API minimum of ${MIN_BUDGET_TOKENS}. A cap below ` +
            `${MIN_BUDGET_TOKENS + MIN_ANSWER_TOKENS} — the API's budget minimum plus ` +
            "the least room that still constitutes an answer — cannot hold both and " +
            "is refused rather than silently raised; on GLM-5.3 and glm-5.3-flash, " +
            "which always reason, the only fix is a higher cap. " +
            "A cap over the model's published ceiling is likewise refused before " +
            `anything is sent (${outputLimits(DEFAULT_MODEL).max!.toLocaleString("en-US")} for GLM-5.3). ` +
            "Omit it and the model's own default applies " +
            `(${outputLimits(DEFAULT_MODEL).def.toLocaleString("en-US")} for GLM-5.3). ` +
            "A review severed by too small a cap loses its verdict line and is " +
            "returned as an error, so size it for the analysis plus the verdict.",
        ),
    },
  },
  async ({ diff, files, spec, cwd, model, reasoning, max_tokens }) => {
    try {
      // The refusal comes before anything else, and before GLM is ever asked
      // (#65): with neither a diff nor files there is no material in front of
      // the reviewer, and a verdict about nothing is not an empty review but
      // a fabricated one — the 14-byte rubber stamp this tool exists to make
      // impossible. Reviewing nothing and reporting a pass is the failure
      // mode of the whole delegate → review loop.
      if (!diff?.trim() && !files?.length) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                "Refused: nothing to review. Pass the change as a diff, or name the " +
                "code it touches in files — a review with no material in front of it " +
                "would return a verdict with nothing behind it, which is worse than " +
                "no review at all.",
            },
          ],
        };
      }

      // Resolved once, used twice, exactly as glm_ask does it (#59): the file
      // context is sized for the model the request will actually use.
      const chosenModel = model ?? DEFAULT_MODEL;
      const notes: string[] = [];
      let fileContext = "";
      if (files?.length) {
        // The same buildFileContext glm_ask calls — not a reimplementation —
        // so confinement, de-duplication, binary skips and the cap and its
        // notes are all of it inherited, once, here.
        const ctx = buildFileContext(files, cwd ?? process.cwd(), chosenModel);
        notes.push(...ctx.notes);
        // A refused call read nothing; sending the review anyway would have
        // the model opine about code it was never shown — a silent failure
        // wearing a success, the same refusal glm_ask makes for the same
        // reason.
        if (ctx.refusedCall) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Refused: no file context was read.\n\n${ctx.notes.join("; ")}`,
              },
            ],
          };
        }
        fileContext = ctx.text;
      }

      // The same refusal, one step later: files that named nothing readable
      // leave the reviewer exactly where no diff and no files leave it —
      // staring at a spec with nothing to check it against. GLM is never
      // asked.
      if (!diff?.trim() && !fileContext.trim()) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                "Refused: nothing to review — no diff was supplied and the files " +
                `resolved to no readable content (${notes.join("; ") || "nothing matched"}). ` +
                "Ask again with the change itself, or with files that name code " +
                "that exists.",
            },
          ],
        };
      }

      const result = await ask({
        prompt: buildReviewPrompt({ diff, spec, fileContext }),
        model: chosenModel,
        // glm_ask defaults to 'low' because a question is usually mechanical;
        // a review is the work the #54 routing guidance reserves 'high' for,
        // and a reviewer skimming on 2,048 thinking tokens is how a rubber
        // stamp acquires a footer. The caller can still spend less by
        // saying so.
        reasoning: (reasoning ?? "high") as Reasoning,
        maxTokens: max_tokens,
      });

      // #41 again, and ahead of everything below: a reply the output cap
      // severed is not a finished review, whatever it happens to contain. The
      // check has to come BEFORE the verdict is accepted — a truncated reply
      // that already carried its verdict line would otherwise be relayed as a
      // clean review, and a downstream grep would read an interrupted review
      // as approval. That is the failure this whole tool exists to prevent,
      // arriving through the one door the substance floor does not watch.
      if (result.stopReason === "max_tokens") {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                "The review was cut off by the output cap (stopped at max_tokens), so it " +
                "is not a finished review — whatever verdict it may already have written. " +
                "Raise max_tokens and ask again. " +
                `The model's partial reply was: ${JSON.stringify(result.text)}`,
            },
          ],
        };
      }

      // A reply with no verdict is a shape error, not a review: every
      // consumer of this tool — bin/glm-review's grep included — reads the
      // verdict line first and the analysis second, so relaying a
      // verdict-less reply as a clean result would make the output shape a
      // surprise, which is the one thing the description promises it never
      // is.
      if (verdictOf(result.text) === undefined) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                "The review came back without a verdict: no line reading VERDICT: PASS " +
                "or VERDICT: CHANGES_REQUIRED as the final line, so nothing downstream " +
                "can consume it. (A reply severed by the output cap is refused above this, " +
                "so this one ended of its own accord without a verdict.) " +
                ` The model's reply was: ${JSON.stringify(result.text)}`,
            },
          ],
        };
      }

      // The substance floor (#65), carried across from bin/glm-review
      // because it is the part of that script most worth keeping: a verdict
      // with nothing behind it is a rubber stamp whatever it says, and
      // relaying it converts an unexamined change into one with a clean bill
      // of health. substanceOf measures the REPLY — never the prompt, the
      // diff or the request — because a floor computed from anything the
      // caller sent is satisfied by exactly the long prompts that most need
      // checking, and passes every rubber stamp ever written while looking
      // fixed.
      const substance = substanceOf(result.text);
      const floor = minSubstance();
      if (substance < floor) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                `Refused: the verdict came back with no analysis behind it — ` +
                `${substance} characters of review beside the verdict line, under ` +
                `the GLM_REVIEW_MIN_SUBSTANCE floor of ${floor}. A bare verdict is ` +
                "a rubber stamp, not a review, and relaying it would convert an " +
                "unexamined change into one with a clean bill of health. The " +
                `model's entire reply was: ${JSON.stringify(result.text)} Ask again ` +
                'with more reasoning depth (reasoning "max"), or with more material ' +
                "to examine.",
            },
          ],
        };
      }

      // The verdict stays the last line of the relayed analysis — in
      // bin/glm-review's vocabulary, where the shell tools already grep for
      // it — and the footer follows it rather than replacing it.
      const body = [
        result.text,
        "",
        `[${usageFooter(result)}]`,
        ...(notes.length ? ["", `Notes: ${notes.join("; ")}`] : []),
      ].join("\n");

      return { content: [{ type: "text" as const, text: body }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `GLM request failed.\n\n${explainError(e)}` }],
      };
    }
  },
);

server.registerTool(
  "glm_models",
  {
    title: "List GLM models",
    description:
      "List the GLM model ids available on the configured Z.ai account, each with a " +
      "one-line role; an id this server's model table does not know is listed bare.",
    inputSchema: {},
  },
  async () => {
    try {
      const ids = await listModels();
      // #54: a bare id cannot be routed on — a caller reading glm-4.5-airx has
      // no way to tell what it is for — so each carries the one-line role the
      // model table holds. An id the table does not know keeps no hint:
      // describing a model this package has never heard of would be invention
      // a caller cannot tell from a real one, so it stays z.ai's to describe,
      // exactly as it stays z.ai's to size (#36).
      const lines = ids.map((id) => {
        const role = modelRole(id);
        return role ? `${id} — ${role}` : id;
      });
      return {
        content: [
          { type: "text" as const, text: `Available models (${ids.length}):\n${lines.join("\n")}` },
        ],
      };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Could not list models.\n\n${explainError(e)}` }],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout is reserved for the MCP protocol; anything human-facing goes to stderr.
console.error("glm-mcp ready");

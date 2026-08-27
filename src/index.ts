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
  ANSWER_ROOM,
  MIN_BUDGET_TOKENS,
  type Reasoning,
} from "./glm.js";

// Read rather than repeated: a literal here drifts from package.json on every
// release, and the only symptom is a server quietly misreporting itself. From
// dist/index.js this resolves to the package root, published and local alike.
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const server = new McpServer({ name: "glm", version });

server.registerTool(
  "glm_ask",
  {
    title: "Ask GLM",
    description:
      "Send a prompt to a Z.ai GLM model (default GLM-5.3) and return its answer. " +
      "GLM-5.3 is an independent frontier model with a 1,000,000-token context window, " +
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
            "prefixes included — resolve against 'cwd'.",
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
            `${MIN_BUDGET_TOKENS + ANSWER_ROOM} — the API's budget minimum plus the room ` +
            "the answer needs — cannot hold both and is refused rather than silently " +
            "raised; on GLM-5.3 and glm-5.3-flash, which always reason, the only " +
            "fix is a higher cap. " +
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

      if (files?.length) {
        const ctx = buildFileContext(files, cwd ?? process.cwd());
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
        model: model ?? DEFAULT_MODEL,
        reasoning: (reasoning ?? "low") as Reasoning,
        system,
        // #36: omitted, ask() applies the model's own published default — not a
        // constant of ours.
        maxTokens: max_tokens,
      });

      const footer = [
        `[${result.model}`,
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

      const body = [
        result.text || "(empty response)",
        "",
        `${footer}]`,
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

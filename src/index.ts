#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ask,
  buildFileContext,
  DEFAULT_MODEL,
  explainError,
  listModels,
  MIN_BUDGET_TOKENS,
  type Reasoning,
} from "./glm.js";

const server = new McpServer({ name: "glm", version: "0.2.0" });

server.registerTool(
  "glm_ask",
  {
    title: "Ask GLM",
    description:
      "Send a prompt to a Z.ai GLM model (default GLM-5.3) and return its answer. " +
      "GLM-5.3 is an independent frontier model with a 1,000,000-token context window, " +
      "so this is useful for a genuine second opinion from a different model, for " +
      "cross-checking reasoning, and for analysing far more source material at once than " +
      "fits in a normal context. Optionally pass file paths to include as context.",
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
        .describe(`GLM model id. Defaults to ${DEFAULT_MODEL}. Use glm_models to list options.`),
      reasoning: z
        .enum(["none", "low", "high", "max"])
        .optional()
        .describe(
          "Reasoning depth. Higher is slower. GLM-5.3 always reasons, so 'none' is raised to 'low' for it.",
        ),
      system: z.string().optional().describe("Optional system prompt."),
      max_tokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Max output tokens — a hard cap. The request never exceeds it; the thinking " +
            "budget scales down to fit beneath it, leaving room for the answer, but never " +
            `below the API minimum of ${MIN_BUDGET_TOKENS}. A cap of ${MIN_BUDGET_TOKENS} or ` +
            "less cannot reason and is refused rather than silently raised — on GLM-5.3, " +
            "which always reasons, the only fix is a higher cap. Default 8192.",
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
        maxTokens: max_tokens ?? 8192,
      });

      const footer = [
        `[${result.model}`,
        `in ${result.usage.input} / out ${result.usage.output} tok`,
        result.usage.cacheRead ? `cached ${result.usage.cacheRead}` : null,
        result.thinkingChars ? `reasoned ${result.thinkingChars} chars` : null,
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
    description: "List the GLM model ids available on the configured Z.ai account.",
    inputSchema: {},
  },
  async () => {
    try {
      const ids = await listModels();
      return {
        content: [
          { type: "text" as const, text: `Available models (${ids.length}):\n${ids.join("\n")}` },
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

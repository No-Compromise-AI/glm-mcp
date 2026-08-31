/**
 * The argv path beside the stdio server (#55).
 *
 * `bin` mapped `glm-mcp` to the MCP server and nothing else, so the confinement,
 * the budget, the per-model ceilings and the note vocabulary were reachable only
 * from an MCP client. This makes them reachable from a shell — and does it by
 * calling the SAME functions the tool handlers call, because the alternative is
 * two implementations of one policy, which is the defect #55 also reports about
 * key resolution.
 *
 * Two consequences worth stating, since both are load-bearing:
 *
 * - **Confinement is not re-implemented here.** `buildFileContext` enforces the
 *   operator's roots itself, so reading through it is what keeps this
 *   subcommand from becoming a way around the boundary the server advertises.
 *   Nothing in this file touches the filesystem for file context.
 * - **stdout carries the answer and nothing else.** Notes, refusals and
 *   diagnostics go to stderr, so `ANSWER=$(glm-mcp ask ...)` is exactly the
 *   answer. This is the same split the server keeps for the MCP protocol.
 */
import {
  ask,
  buildFileContext,
  DEFAULT_MODEL,
  explainError,
  listModels,
  modelRole,
  resolveApiKeyWithSource,
  type Reasoning,
} from "./glm.js";

// The Reasoning union from glm.ts, not a guess: "medium" is not one of them,
// and accepting it here would hand ask() a value its own type forbids.
const REASONINGS = new Set(["none", "low", "high", "max"]);

const USAGE = `glm-mcp — ask GLM from a shell, or run the MCP server.

  glm-mcp                                 run the stdio MCP server (default)
  glm-mcp ask [options] "<question>"      ask one question and print the answer
  glm-mcp models                          list the models, with what each is for
  glm-mcp key [--print]                   report where the API key resolves from

ask options:
  -f, --file <glob>       file or glob to send as context (repeatable)
  -m, --model <id>        model id (default: ${DEFAULT_MODEL})
  -r, --reasoning <level> none | low | high | max (default: low)
      --cwd <dir>         directory globs resolve against
      --include <text>    send only files whose CONTENT contains this literal text
      --max-tokens <n>    output cap (default: the model's own published one)
      --system <text>     system prompt

Files are read under the same confinement as the MCP server: GLM_MCP_ROOTS, or
the server's own directory when unset. stdout is the answer; everything else
goes to stderr.`;

/** One `--flag value` parse, shared so a typo in one option reads like a typo in all of them. */
function takeValue(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("-")) {
    throw new Error(`${flag} needs a value`);
  }
  return v;
}

async function cmdAsk(argv: string[]): Promise<number> {
  const files: string[] = [];
  let model = DEFAULT_MODEL;
  let reasoning: Reasoning = "low";
  let cwd: string | undefined;
  let maxTokens: number | undefined;
  let system: string | undefined;
  let include: string | undefined;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-f": case "--file": files.push(takeValue(argv, i, a)); i++; break;
      case "-m": case "--model": model = takeValue(argv, i, a); i++; break;
      case "-r": case "--reasoning": {
        const v = takeValue(argv, i, a); i++;
        if (!REASONINGS.has(v)) {
          throw new Error(`--reasoning must be one of none, low, high, max (got ${JSON.stringify(v)})`);
        }
        reasoning = v as Reasoning;
        break;
      }
      case "--cwd": cwd = takeValue(argv, i, a); i++; break;
      case "--include": include = takeValue(argv, i, a); i++; break;
      case "--system": system = takeValue(argv, i, a); i++; break;
      case "--max-tokens": {
        const v = takeValue(argv, i, a); i++;
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) throw new Error(`--max-tokens wants a positive integer, got ${JSON.stringify(v)}`);
        maxTokens = n;
        break;
      }
      default:
        if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
        rest.push(a);
    }
  }

  const prompt = rest.join(" ").trim();
  if (!prompt) throw new Error("ask needs a question");

  let finalPrompt = prompt;
  if (files.length > 0) {
    const ctx = buildFileContext(files, cwd, model, 0, { include });
    // Notes are the operator's channel — which globs matched, what was skipped,
    // which path the roots refused. They belong beside the answer, not in it.
    for (const n of ctx.notes) console.error(`glm-mcp: ${n}`);
    if (ctx.refusedCall) {
      // The same refusal glm_ask makes, for the same reason: answering with
      // none of the material the question was about is a silent failure
      // wearing a success.
      throw new Error(`no file context was read, so nothing was asked.\n${ctx.notes.join("; ")}`);
    }
    // The same composition the tool handler uses, so a question asked here and
    // the same question asked over MCP reach the model identically.
    if (ctx.text) finalPrompt = `${ctx.text}\n\n---\n\n${prompt}`;
  }

  const result = await ask({
    prompt: finalPrompt,
    model,
    reasoning,
    system,
    ...(maxTokens === undefined ? {} : { maxTokens }),
  });

  process.stdout.write(result.text.endsWith("\n") ? result.text : `${result.text}\n`);
  // The cost line the MCP tools append to their answer. On stderr here, because
  // stdout is the answer a script captures.
  console.error(
    `glm-mcp: ${result.model}, ${result.usage.input} in / ${result.usage.output} out` +
      (result.stopReason === "max_tokens" ? " — TRUNCATED at the output cap" : ""),
  );
  return 0;
}

async function cmdModels(): Promise<number> {
  for (const id of await listModels()) {
    const role = modelRole(id);
    // An id this server's table does not know stays z.ai's to describe: listed
    // bare rather than given a role invented here.
    process.stdout.write(role ? `${id}\t${role}\n` : `${id}\n`);
  }
  return 0;
}

function cmdKey(argv: string[]): number {
  const print = argv.includes("--print");
  for (const a of argv) {
    if (a !== "--print") throw new Error(`unknown option ${a}`);
  }
  const { key, source } = resolveApiKeyWithSource();
  if (print) {
    // Nothing but the key, so KEY=$(glm-mcp key --print) is the key.
    process.stdout.write(`${key}\n`);
  } else {
    // The source, never the secret. This subcommand exists so claude-glm stops
    // reimplementing the search; printing a key by default would turn every
    // accidental invocation into a leak, and the common question is "which of
    // the three answered" rather than "what is it".
    process.stdout.write(`${source}\n`);
  }
  return 0;
}

/** Subcommands argv may select. Anything else is the server's argv, untouched. */
export const SUBCOMMANDS = new Set(["ask", "models", "key", "help", "--help", "-h"]);

export async function runCli(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "ask": return await cmdAsk(rest);
      case "models": return await cmdModels();
      case "key": return cmdKey(rest);
      default:
        process.stdout.write(`${USAGE}\n`);
        return 0;
    }
  } catch (e) {
    // explainError carries the endpoint- and credential-aware messages the MCP
    // path already gives; a shell caller deserves the same diagnosis rather
    // than a stack trace.
    console.error(`glm-mcp: ${explainError(e)}`);
    return 1;
  }
}

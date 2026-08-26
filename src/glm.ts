import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_MODEL = "glm-5.3";
export const BASE_URL = process.env.ZAI_BASE_URL ?? "https://api.z.ai/api/anthropic";

/** Models that reject any request lacking a thinking block (z.ai error 1210). */
const THINKING_REQUIRED = new Set(["glm-5.3"]);

export type Reasoning = "none" | "low" | "high" | "max";

const BUDGET: Record<Exclude<Reasoning, "none">, number> = {
  low: 2048,
  high: 8192,
  max: 24576,
};

/**
 * Resolve the z.ai key without ever hardcoding it:
 *   ZAI_API_KEY  ->  ~/.config/zai/api-key  ->  the key ZCode already stores.
 */
export function resolveApiKey(): string {
  const fromEnv = process.env.ZAI_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  const keyFile = join(homedir(), ".config", "zai", "api-key");
  if (existsSync(keyFile)) {
    const k = readFileSync(keyFile, "utf8").trim();
    if (k) return k;
  }

  const zcode = join(homedir(), ".zcode", "v2", "config.json");
  if (existsSync(zcode)) {
    try {
      const cfg = JSON.parse(readFileSync(zcode, "utf8"));
      const k = cfg?.provider?.["builtin:zai-coding-plan"]?.options?.apiKey;
      if (typeof k === "string" && k.trim()) return k.trim();
    } catch {
      /* fall through to the error below */
    }
  }

  throw new Error(
    "No z.ai API key found. Set ZAI_API_KEY, or write the key to ~/.config/zai/api-key.",
  );
}

let client: Anthropic | undefined;
export function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      baseURL: BASE_URL,
      authToken: resolveApiKey(),
      apiKey: null,
      timeout: Number(process.env.GLM_MCP_TIMEOUT_MS ?? 600_000),
      maxRetries: 2,
    });
  }
  return client;
}

const MAX_FILE_CHARS = Number(process.env.GLM_MCP_MAX_FILE_CHARS ?? 800_000);

/** Read files into a single prompt block, guarding against blowing the context window. */
export function buildFileContext(paths: string[], cwd: string): { text: string; notes: string[] } {
  const notes: string[] = [];
  const chunks: string[] = [];
  let total = 0;

  for (const p of paths) {
    const abs = resolve(cwd, p);
    if (!existsSync(abs)) {
      notes.push(`skipped (not found): ${p}`);
      continue;
    }
    let body: string;
    try {
      body = readFileSync(abs, "utf8");
    } catch (e) {
      notes.push(`skipped (unreadable): ${p}`);
      continue;
    }
    if (total + body.length > MAX_FILE_CHARS) {
      const room = Math.max(0, MAX_FILE_CHARS - total);
      if (room > 0) {
        chunks.push(`--- ${p} (truncated) ---\n${body.slice(0, room)}`);
        total += room;
      }
      notes.push(`truncated at ${MAX_FILE_CHARS} total chars starting with: ${p}`);
      break;
    }
    chunks.push(`--- ${p} ---\n${body}`);
    total += body.length;
  }

  return { text: chunks.join("\n\n"), notes };
}

export interface AskArgs {
  prompt: string;
  model: string;
  reasoning: Reasoning;
  system?: string;
  maxTokens: number;
}

export interface AskResult {
  text: string;
  thinkingChars: number;
  model: string;
  usage: { input: number; output: number; cacheRead: number };
}

export async function ask(args: AskArgs): Promise<AskResult> {
  const { prompt, model, system } = args;

  // glm-5.3 always reasons; a request without a thinking block is rejected outright.
  let reasoning = args.reasoning;
  if (reasoning === "none" && THINKING_REQUIRED.has(model)) reasoning = "low";

  const body: Record<string, unknown> = {
    model,
    max_tokens: args.maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (system) body.system = system;

  if (reasoning !== "none") {
    const budget = BUDGET[reasoning];
    // The API requires headroom for the answer on top of the thinking budget.
    body.max_tokens = Math.max(args.maxTokens, budget + 4096);
    body.thinking = { type: "enabled", budget_tokens: budget };
  }

  const res = (await getClient().messages.create(body as never)) as {
    model?: string;
    content?: Array<{ type: string; text?: string; thinking?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  };

  let text = "";
  let thinkingChars = 0;
  for (const block of res.content ?? []) {
    if (block.type === "text") text += block.text ?? "";
    else if (block.type === "thinking") thinkingChars += (block.thinking ?? "").length;
  }

  return {
    text: text.trim(),
    thinkingChars,
    model: res.model ?? model,
    usage: {
      input: res.usage?.input_tokens ?? 0,
      output: res.usage?.output_tokens ?? 0,
      cacheRead: res.usage?.cache_read_input_tokens ?? 0,
    },
  };
}

export async function listModels(): Promise<string[]> {
  const key = resolveApiKey();
  const r = await fetch("https://api.z.ai/api/paas/v4/models", {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!r.ok) throw new Error(`model list failed: HTTP ${r.status}`);
  const d = (await r.json()) as { data?: Array<{ id: string }> };
  return (d.data ?? []).map((m) => m.id);
}

/** Turn z.ai's coded errors into something actionable instead of a raw stack. */
export function explainError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("1113")) {
    return `z.ai reports no balance or resource package on this key.\n\n${msg}`;
  }
  if (msg.includes("1210")) {
    return `This model always reasons and cannot run with reasoning disabled. Use reasoning "low", "high", or "max".\n\n${msg}`;
  }
  if (msg.includes("3007")) {
    return `That credential is the ZCode Start Plan token, which is captcha-locked to the ZCode app. Use an api.z.ai API key instead.\n\n${msg}`;
  }
  return msg;
}

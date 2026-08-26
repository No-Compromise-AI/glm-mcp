import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandGlob, isGlobPattern, patternAnchor } from "./glob.js";
import { confineRoots, deniedCredentials, insideRoots, realpathish } from "./confine.js";

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
 *   ZAI_API_KEY  ->  ~/.config/zai/api-key  ->  (opt-in) the key ZCode already stores.
 *
 * The ZCode fallback reads another application's config file, so it is off unless
 * GLM_MCP_ALLOW_ZCODE_KEY=1 is set. Reading a credential a user configured for a
 * different tool should be their explicit choice, not a convenience they discover.
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
  if (process.env.GLM_MCP_ALLOW_ZCODE_KEY === "1" && existsSync(zcode)) {
    try {
      const cfg = JSON.parse(readFileSync(zcode, "utf8"));
      const k = cfg?.provider?.["builtin:zai-coding-plan"]?.options?.apiKey;
      if (typeof k === "string" && k.trim()) return k.trim();
    } catch {
      /* fall through to the error below */
    }
  }

  throw new Error(
    "No z.ai API key found. Set ZAI_API_KEY, or write the key to ~/.config/zai/api-key. " +
      "To reuse the key ZCode stores, set GLM_MCP_ALLOW_ZCODE_KEY=1.",
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

export interface FileContext {
  text: string;
  notes: string[];
  /**
   * True when the whole call was refused because `cwd` resolved outside every
   * root: nothing was read and `text` is empty. A refused path inside an
   * otherwise-good call is a note, not a refused call — this flag is only for
   * the caller choosing ground it was never allowed to stand on.
   */
  refusedCall: boolean;
}

/**
 * Read files into a single prompt block, guarding against blowing the context
 * window. Paths are confined to the operator's roots (see confine.ts): every
 * file's realpath must land inside one, which is what closes the ../ and
 * symlink escapes, and the server's own credentials are refused regardless of
 * roots. A refused path is a note like any other — one bad entry must not
 * fail a request that also names ten good files — so this never throws for a
 * refusal. `cwd` outside every root is the one refusal that cannot proceed:
 * narrowing it to a root would return an empty-but-successful read, the exact
 * silent-failure shape this project has spent the most effort removing.
 */
export function buildFileContext(paths: string[], cwd: string): FileContext {
  const notes: string[] = [];
  const chunks: string[] = [];
  let total = 0;

  const roots = confineRoots(cwd);
  if (roots && !insideRoots(realpathish(cwd), roots)) {
    return {
      text: "",
      notes: [
        `refused: cwd ${cwd} resolves outside the allowed roots; the call was not executed`,
      ],
      refusedCall: true,
    };
  }
  // Decision 3 is unconditional — GLM_MCP_ALLOW_ANY_PATH widens the roots, it
  // does not re-open the server's own credentials.
  const denied = deniedCredentials();

  // Glob entries expand to the files they match, sorted and de-duplicated against
  // everything already listed; literal paths go through exactly as given. Every
  // entry — literal or expansion — is checked against what came before it, so a
  // file named twice, directly and through a glob, appears once regardless of
  // argument order. A path that exists on disk is used literally even when its
  // name contains glob metacharacters: report[final].md exists as itself before
  // it exists as a pattern.
  // De-duplication tracks files, not spellings: realpathSync.native resolves
  // each path to its canonical on-disk identity, so case variants on
  // case-insensitive filesystems and symlink aliases on any platform collapse
  // to one entry. A path that resolves to nothing (never created, or a
  // dangling symlink) falls back to the lexical spelling.
  const keyOf = (p: string): string => {
    try {
      return realpathSync.native(resolve(cwd, p));
    } catch {
      return resolve(cwd, p);
    }
  };
  // lstat rather than existsSync: it does not follow the link, so a dangling
  // symlink still names something and keeps its literal reading instead of
  // being reinterpreted as the pattern its metacharacters spell out.
  const namesSomething = (p: string): boolean => {
    try {
      lstatSync(resolve(cwd, p));
      return true;
    } catch {
      return false;
    }
  };
  // `resolved` is the on-disk identity the dedupe and the boundary share, so
  // containment costs one comparison on a value already computed. `via` keeps
  // the caller's own spelling for the entry — an argument it sent — so refusal
  // notes name which of its arguments was dropped, never a resolved path that
  // would widen what notes already disclose.
  const files: Array<{ p: string; via: string; resolved: string }> = [];
  const included = new Set<string>();
  for (const p of paths) {
    // The credential rule runs before any existence check (decision 3), so
    // /proc/self/environ is reported as refused, not missing, where it does
    // not exist. Containment probes where a literal resolves to or a pattern's
    // walk would be anchored — refusing a pattern before it walks is what
    // keeps an absolute pattern from traversing the volume first.
    const resolved = keyOf(p);
    if (denied.has(resolved)) {
      notes.push(`refused (credential path): ${p}`);
      continue;
    }
    if (roots && !insideRoots(realpathish(patternAnchor(p, cwd)), roots)) {
      notes.push(`refused: ${p} resolves outside the allowed roots`);
      continue;
    }
    if (!isGlobPattern(p) || namesSomething(p)) {
      if (!included.has(resolved)) {
        included.add(resolved);
        files.push({ p, via: p, resolved });
      }
      continue;
    }
    const matches = expandGlob(p, cwd, roots ?? undefined);
    if (matches.length === 0) {
      notes.push(`skipped (no matches): ${p}`);
      continue;
    }
    for (const m of matches) {
      const key = keyOf(m);
      if (included.has(key)) continue;
      included.add(key);
      files.push({ p: m, via: p, resolved: key });
    }
  }

  for (const { p, via, resolved } of files) {
    // Re-checked at read time because a glob match may be a symlink whose
    // target leaves the roots only once resolved; the anchor could not see it.
    if (denied.has(resolved)) {
      notes.push(`refused (credential path): ${p}${via === p ? "" : ` (matched by ${via})`}`);
      continue;
    }
    if (roots && !insideRoots(resolved, roots)) {
      notes.push(`refused: ${p}${via === p ? "" : ` (matched by ${via})`} resolves outside the allowed roots`);
      continue;
    }
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

  return { text: chunks.join("\n\n"), notes, refusedCall: false };
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

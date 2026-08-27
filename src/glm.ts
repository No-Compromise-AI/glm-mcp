import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandGlob, isGlobPattern, patternAnchors } from "./glob.js";
import { confineRoots, deniedCredentials, insideRoots, realpathish } from "./confine.js";
import {
  envLimit,
  walkBudget,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILE_CHARS,
  DEFAULT_TIMEOUT_MS,
} from "./limits.js";

export const DEFAULT_MODEL = "glm-5.3";

const DEFAULT_BASE_URL = "https://api.z.ai/api/anthropic";
// A different host AND a different path prefix from the Anthropic-compatible
// base, so it is configured by its own variable rather than derived (#22):
// any derivation would be guessing at the operator's gateway layout.
const DEFAULT_MODELS_URL = "https://api.z.ai/api/paas/v4/models";

/**
 * The endpoints, resolved when a call is made rather than when the module
 * loads. BASE_URL and MODELS_URL below are the values as of startup, exported
 * for anything that wants to display them; the requests themselves re-read
 * the environment so a caller that pins a variable after import — a test, an
 * operator's launcher — still sends the key where they said (#22).
 */
export function baseUrl(): string {
  return process.env.ZAI_BASE_URL ?? DEFAULT_BASE_URL;
}

export function modelsUrl(): string {
  return process.env.ZAI_MODELS_URL ?? DEFAULT_MODELS_URL;
}

export const BASE_URL = baseUrl();
export const MODELS_URL = modelsUrl();

/** Models that reject any request lacking a thinking block (z.ai error 1210). */
const THINKING_REQUIRED = new Set(["glm-5.3"]);

export type Reasoning = "none" | "low" | "high" | "max";

const BUDGET: Record<Exclude<Reasoning, "none">, number> = {
  low: 2048,
  high: 8192,
  max: 24576,
};

/**
 * Tokens of the output cap reserved for the answer itself. The API requires
 * max_tokens > thinking.budget_tokens, so a request that reasons needs at least
 * this much room beneath the cap or there is nothing left to answer with (#20).
 */
const ANSWER_ROOM = 4096;

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
      baseURL: baseUrl(),
      authToken: resolveApiKey(),
      apiKey: null,
      // envLimit (#24): Number("abc") is NaN, and NaN as a timeout is not a
      // wrong limit but an absent one — every comparison against it is false.
      timeout: envLimit("GLM_MCP_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
      maxRetries: 2,
    });
  }
  return client;
}

// Resolved once per process, so the cap is pinned by the environment the server
// started with — like the client's, this is a knob of the process, not of a call.
const MAX_FILE_CHARS = envLimit("GLM_MCP_MAX_FILE_CHARS", DEFAULT_MAX_FILE_CHARS);

/**
 * The first `maxUnits` UTF-16 units of `s`, cut where it cannot split a
 * surrogate pair (#19). Truncating mid-pair produces a lone surrogate — invalid
 * wherever the prompt travels next — so a window ending on the high half of a
 * pair yields one unit less rather than half a character.
 */
function takeUnits(s: string, maxUnits: number): string {
  if (maxUnits <= 0) return "";
  if (s.length <= maxUnits) return s;
  const cut = s.charCodeAt(maxUnits - 1) >= 0xd800 && s.charCodeAt(maxUnits - 1) <= 0xdbff
    ? maxUnits - 1
    : maxUnits;
  return s.slice(0, cut);
}

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

  const roots = confineRoots();
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

  // The walk-wide limits of decision 5 (#16, #17), shared by every pattern of
  // this call: depth, entries and the wall clock are budgets of the call, not
  // of each pattern, and every limit note lands here. A note also means part of
  // this entry's expansion was stopped, which is why `limitedPatterns`
  // suppresses the "no matches" note below — a pattern cut short by a limit is
  // not a pattern that matched nothing, and reading it as one is the silent
  // truncation decision 5 exists to end. The suppression is per pattern: the
  // sink records WHICH patterns have been limited — expansion sets
  // budget.pattern before any walk can trip — so a limit stops the pattern
  // that hit it and leaves the rest of the call alone instead of swallowing
  // their notes too. Every pattern it limited, never only the latest one: the
  // sink de-duplicates a repeated note, so its callback does not fire a second
  // time for a pattern it has already recorded, and a single slot would go
  // stale the moment a later pattern tripped a limit of its own.
  const limitedPatterns = new Set<string>();
  const budget = walkBudget((msg) => {
    limitedPatterns.add(budget.pattern);
    notes.push(msg);
  });
  const maxFileBytes = envLimit("GLM_MCP_MAX_FILE_BYTES", DEFAULT_MAX_FILE_BYTES);

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
    // not exist. A path that exists on disk is then read literally — judged
    // by the file's own resolved identity, never by where a pattern reading
    // of its metacharacters would anchor, because report[final].md and
    // {..,safe} exist as themselves before they exist as patterns (#3). Only
    // a genuine pattern is judged by its brace branches' anchors — refusing
    // a pattern before it walks is what keeps an absolute pattern from
    // traversing the volume first, and each expansion is probed on its own
    // because the anchor of a brace pattern as written is the anchor of none
    // of its branches.
    const resolved = keyOf(p);
    if (denied.has(resolved)) {
      notes.push(`refused (credential path): ${p}`);
      continue;
    }
    if (!isGlobPattern(p) || namesSomething(p)) {
      if (included.has(resolved)) continue;
      if (roots && !insideRoots(resolved, roots)) {
        notes.push(`refused: ${p} resolves outside the allowed roots`);
        included.add(resolved);
        continue;
      }
      included.add(resolved);
      files.push({ p, via: p, resolved });
      continue;
    }
    // Limits are notes, never throws — and that goes for hostile input this
    // code has no specific rule for yet, not only for the rules it has. The
    // brace cap (#17) is enforced inside patternAnchors and expandGlob on every
    // route braces are expanded, so what this guard catches is the patterns
    // nobody predicted; a caller still gets its other files either way.
    try {
      if (roots && patternAnchors(p, cwd, budget).some((a) => !insideRoots(realpathish(a), roots))) {
        notes.push(`refused: ${p} resolves outside the allowed roots`);
        continue;
      }
      // A directory the walk prunes for leaving the roots is a refusal like any
      // other: expandGlob reports each reported path once, with the spelling a
      // match would carry, so the note names both it and the pattern that
      // reached it.
      let refusedMatch = false;
      const matches = expandGlob(p, cwd, roots ?? undefined, (refused) => {
        refusedMatch = true;
        notes.push(
          `refused: ${refused} (matched by ${p}) resolves outside the allowed roots`,
        );
      }, budget);
      if (matches.length === 0) {
        // Refused is not the same as absent: a pattern whose matches were all
        // stopped at the boundary — or cut short by a limit — must not also be
        // filed under "no matches", which reads as a pattern that was simply
        // wrong and contradicts the note beside it. Only a pattern that matched
        // nothing, refused nothing and was limited by nothing says "no matches"
        // — and it is THIS pattern's refusal that is asked about, never
        // whether the call has seen one at all.
        if (!refusedMatch && !limitedPatterns.has(p)) notes.push(`skipped (no matches): ${p}`);
        continue;
      }
      for (const m of matches) {
        const key = keyOf(m);
        if (included.has(key)) continue;
        included.add(key);
        files.push({ p: m, via: p, resolved: key });
      }
    } catch (e) {
      notes.push(`refused: ${p} (expansion failed: ${e instanceof Error ? e.message : String(e)})`);
      continue;
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
    // stat BEFORE reading (#15): the size is known before a byte of the file is
    // materialised, which is the difference between bounding a read and paying
    // for it first. stat follows symlinks, so the kind and size are the
    // target's own — a link cannot pose as a small regular file.
    let st;
    try {
      st = statSync(abs);
    } catch {
      notes.push(`skipped (not found): ${p}`);
      continue;
    }
    // Regular files only (#15): a FIFO blocks the read forever, a device like
    // /dev/zero is infinitely long, and neither has a size worth capping. The
    // refusal is a note like any other — a FIFO among ten good files must not
    // take them down with it.
    const matchedBy = via === p ? "" : ` (matched by ${via})`;
    if (!st.isFile()) {
      notes.push(`refused (not a regular file): ${p}${matchedBy}`);
      continue;
    }
    if (st.size > maxFileBytes) {
      notes.push(
        `refused (too large): ${p}${matchedBy} is ${st.size} bytes, over the ` +
          `GLM_MCP_MAX_FILE_BYTES limit of ${maxFileBytes}`,
      );
      continue;
    }
    let body: string;
    try {
      body = readFileSync(abs, "utf8");
    } catch {
      notes.push(`skipped (unreadable): ${p}`);
      continue;
    }
    // #19: the header and the separator count toward the cap with the body, so
    // 300 empty files cannot produce a five-figure prompt under an
    // 800,000-char "cap" with no note. `total` is the assembled length so far,
    // separators included, which is what makes text.length ≤ MAX honest.
    const header = `--- ${p} ---\n`;
    const sep = chunks.length > 0 ? "\n\n" : "";
    const overhead = (sep ? 2 : 0) + header.length;
    if (total + overhead + body.length > MAX_FILE_CHARS) {
      // The marker makes the truncated header longer than the plain one, so the
      // room left is measured against the header that will actually be pushed —
      // a budget that quietly grows to fit its own bookkeeping is not a budget.
      const theader = `--- ${p} (truncated) ---\n`;
      const room = MAX_FILE_CHARS - total - (sep ? 2 : 0) - theader.length;
      if (room > 0) {
        const taken = takeUnits(body, room);
        chunks.push(`${sep}${theader}${taken}`);
        total += (sep ? 2 : 0) + theader.length + taken.length;
      }
      notes.push(`truncated at ${MAX_FILE_CHARS} total chars starting with: ${p}`);
      break;
    }
    chunks.push(`${sep}${header}${body}`);
    total += overhead + body.length;
  }

  // The separators were budgeted per chunk above, so joining is the identity:
  // `total` and text.length agree by construction.
  return { text: chunks.join(""), notes, refusedCall: false };
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
    // #20: max_tokens is documented as an output cap, so it is one. The
    // thinking budget scales DOWN to fit beneath it — never up, and never the
    // cap raised to fit the budget, which is how a requested cap of 1 used to
    // leave as a billable 28,672. What cannot fit is refused below, before a
    // request exists to send.
    const budget = Math.min(BUDGET[reasoning], args.maxTokens - ANSWER_ROOM);
    if (budget <= 0) {
      throw new Error(
        `max_tokens ${args.maxTokens} leaves no room to reason: the thinking budget ` +
          `must fit beneath the cap with at least ${ANSWER_ROOM} tokens for the answer, ` +
          `so max_tokens must be at least ${ANSWER_ROOM + 1}` +
          (THINKING_REQUIRED.has(model)
            ? `. ${model} always reasons and cannot run with reasoning off — raise ` +
              `max_tokens, or switch to a model that permits it (e.g. glm-4.6).`
            : ` or reasoning must be "none".`),
      );
    }
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
  // modelsUrl() (#22): the endpoint the operator configured, not a hardcoded
  // api.z.ai — an operator who scoped egress did not scope it just for the chat
  // client to ship the bearer around it. The timeout is the client's own knob,
  // through the same validated parsing, so a bare fetch cannot hang the server.
  const r = await fetch(modelsUrl(), {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(envLimit("GLM_MCP_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)),
  });
  if (!r.ok) throw new Error(`model list failed: HTTP ${r.status}`);
  const d = (await r.json()) as { data?: Array<{ id: string }> };
  return (d.data ?? []).map((m) => m.id);
}

/**
 * The error's z.ai code, from wherever the error actually carries it (#25).
 * Digits alone are not evidence: `msg.includes("1113")` read a request id or a
 * token count as "no balance" and sent someone to top up a fine account. The
 * parsed body wins when the error has one — the SDK attaches it, and z.ai
 * nests the code inside its error object — and a message only counts where it
 * labels the digits as a code (`"code":"1113"`, `Error code: 1113`), which is
 * where the SDK puts them when it stringifies a body with no message field.
 */
function zaiCode(e: unknown): string | undefined {
  const body = (e as { error?: { code?: unknown; error?: { code?: unknown } } } | null)?.error;
  const fromBody = body?.error?.code ?? body?.code;
  if (typeof fromBody === "number" || typeof fromBody === "string") return String(fromBody);
  const msg = e instanceof Error ? e.message : String(e);
  const labelled = /\bcode\b["']?\s*[:=]?\s*["']?(\d+)(?!\d)/i.exec(msg);
  return labelled?.[1];
}

/** Turn z.ai's coded errors into something actionable instead of a raw stack. */
export function explainError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const code = zaiCode(e);
  if (code === "1113") {
    return `z.ai reports no balance or resource package on this key.\n\n${msg}`;
  }
  if (code === "1210") {
    return `This model always reasons and cannot run with reasoning disabled. Use reasoning "low", "high", or "max".\n\n${msg}`;
  }
  if (code === "3007") {
    return `That credential is the ZCode Start Plan token, which is captcha-locked to the ZCode app. Use an api.z.ai API key instead.\n\n${msg}`;
  }
  return msg;
}

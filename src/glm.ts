import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandGlob, isGlobPattern, patternAnchors } from "./glob.js";
import { confineRoots, deniedCredentials, insideRoots, realpathish } from "./confine.js";
import {
  envLimit,
  walkBudget,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_TIMEOUT_MS,
} from "./limits.js";

export const DEFAULT_MODEL = "glm-5.3";

/**
 * z.ai's published output limits, per model: the default max_tokens and the
 * ceiling, exactly as their parameter documentation lists them (#36). One
 * number for every model was the original mistake — the vision models stop at
 * 32,768 and the 4.5 family at 98,304, so a global default either starved the
 * text models or broke the rest.
 */
const OUTPUT_LIMITS = new Map<string, { def: number; max: number }>([
  // The 5.x generation and the 4.6/4.7 text models: 65,536 of a 131,072 ceiling.
  ["glm-5.3", { def: 65_536, max: 131_072 }],
  ["glm-5.3-flash", { def: 65_536, max: 131_072 }],
  ["glm-5.2", { def: 65_536, max: 131_072 }],
  ["glm-5.1", { def: 65_536, max: 131_072 }],
  ["glm-5", { def: 65_536, max: 131_072 }],
  ["glm-5-turbo", { def: 65_536, max: 131_072 }],
  ["glm-5v-turbo", { def: 65_536, max: 131_072 }],
  ["glm-4.7", { def: 65_536, max: 131_072 }],
  ["glm-4.6", { def: 65_536, max: 131_072 }],
  // The 4.5 text family: the same default against a lower ceiling.
  ["glm-4.5", { def: 65_536, max: 98_304 }],
  ["glm-4.5-air", { def: 65_536, max: 98_304 }],
  ["glm-4.5-x", { def: 65_536, max: 98_304 }],
  ["glm-4.5-airx", { def: 65_536, max: 98_304 }],
  ["glm-4.5-flash", { def: 65_536, max: 98_304 }],
  // The 4.6 vision family: a quarter of the ceiling above.
  ["glm-4.6v", { def: 16_384, max: 32_768 }],
  ["glm-4.6v-flash", { def: 16_384, max: 32_768 }],
  ["glm-4.6v-flashx", { def: 16_384, max: 32_768 }],
  // The 4.5 vision model and the 128k 4-32b, where the default IS the ceiling.
  ["glm-4.5v", { def: 16_384, max: 16_384 }],
  ["glm-4-32b-0414-128k", { def: 16_384, max: 16_384 }],
]);

/**
 * The output size handed to a model the table does not know: z.ai's most
 * common default. A model released tomorrow is z.ai's to size — it gets a
 * usable default and no ceiling, never a refusal against a table that cannot
 * know it exists.
 */
export const DEFAULT_MAX_TOKENS = 65_536;

export interface OutputLimits {
  /** The model's published default max_tokens. */
  def: number;
  /**
   * The model's published max_tokens ceiling, or undefined for a model the
   * table does not know — such a model is not capped locally; z.ai is the
   * authority on its own ceiling.
   */
  max?: number;
}

/**
 * The output limits for a model id, from z.ai's published table (#36). An
 * unknown id is not an error and not a refusal: it resolves to a reasonable
 * default with no ceiling, and the request is sent for z.ai to judge.
 */
export function outputLimits(model: string): OutputLimits {
  return OUTPUT_LIMITS.get(model) ?? { def: DEFAULT_MAX_TOKENS };
}

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
 * Tokens of the output cap set aside for the answer. The API requires
 * max_tokens > thinking.budget_tokens, so a reasoning request keeps this much
 * room beneath the cap (#20) — and the room is not what a small cap spends
 * first: a cap that cannot hold both {@link MIN_BUDGET_TOKENS} of thinking and
 * this much answer is refused before anything is sent, because one token of
 * answer is not an answer, and a reasoning model that cannot finish a sentence
 * has produced nothing the caller can use.
 */
export const ANSWER_ROOM = 4096;

/**
 * The least thinking budget the Messages API accepts. Scaling down to fit a
 * small cap stops here: below this the request is not smaller but invalid, and
 * the API answers it with a 400 — so the cap it was scaled to honour is
 * honoured nowhere (#20).
 */
export const MIN_BUDGET_TOKENS = 1024;

/**
 * The least room that still constitutes an answer, and the only number that
 * decides whether a capped request can be made at all. Distinct from
 * ANSWER_ROOM, which is what a generous cap PREFERS to leave: requiring the
 * preference turned away caps that work perfectly well — 5,000 leaves 3,976
 * tokens for the reply — and the decision for #20 was to refuse a cap too
 * small to allow any reasoning, not one that simply reasons less than default.
 */
export const MIN_ANSWER_TOKENS = 1024;

/**
 * Whether a failed credential read means the credential is not configured
 * there (#26). ENOENT — nothing at the path — and ENOTDIR — a component of it
 * is a file, so nothing can ever be — are the only errnos that say absent.
 * Any other failure, EACCES on the file itself or on an ancestor directory
 * that stops the traversal, means a key may well be configured where the
 * server cannot reach it: a different problem with a different fix, and one
 * the operator has to hear about rather than have filed under "no key found".
 */
const isAbsent = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * Resolve the z.ai key without ever hardcoding it:
 *   ZAI_API_KEY  ->  ~/.config/zai/api-key  ->  (opt-in) the key ZCode already stores.
 *
 * The ZCode fallback reads another application's config file, so it is off unless
 * GLM_MCP_ALLOW_ZCODE_KEY=1 is set. Reading a credential a user configured for a
 * different tool should be their explicit choice, not a convenience they discover.
 *
 * The reads are attempted, not guarded with existsSync() first: existsSync
 * answers false when an ANCESTOR directory is unsearchable as surely as when
 * the file is missing, so a configured key the server cannot reach was
 * reported as absent and the caller was sent to create a credential it
 * already has while the operator got nothing (#26). The errno makes the
 * distinction instead — see {@link isAbsent}. A source that fails for any
 * reason but absence fails in words that name no path: the message crosses
 * the trust boundary to the caller, and this machine's directory layout is
 * not the caller's business — the path and the underlying error go to stderr
 * for the operator.
 */
export function resolveApiKey(): string {
  const fromEnv = process.env.ZAI_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  const keyFile = join(homedir(), ".config", "zai", "api-key");
  try {
    const k = readFileSync(keyFile, "utf8").trim();
    if (k) return k;
  } catch (e) {
    if (!isAbsent(e)) {
      // #26: the thrown message is what the caller reads, and V8's errno errors
      // carry the file's absolute path — the account's home directory and
      // username with it. The caller hears only that the key could not be
      // read, which covers a file that denies the read and a directory that
      // denies the way to it alike; the path and the underlying error go to
      // stderr, the operator's channel — stdout is the MCP protocol and stays
      // clean either way.
      const why = e instanceof Error ? e.message : String(e);
      console.error(`glm-mcp: could not read the key file ${keyFile}: ${why}`);
      throw new Error(
        "The configured z.ai key file could not be read. Check that this " +
          "server's account is allowed to read it, or set ZAI_API_KEY instead.",
      );
    }
  }

  const zcode = join(homedir(), ".zcode", "v2", "config.json");
  if (process.env.GLM_MCP_ALLOW_ZCODE_KEY === "1") {
    let raw: string | undefined;
    try {
      raw = readFileSync(zcode, "utf8");
    } catch (e) {
      if (!isAbsent(e)) {
        // The opted-in fallback gets the same split as the key file (#21,
        // #26): a config the server cannot reach holds a key the operator
        // chose to use, so it is reported as unreadable rather than filed
        // under "no key found" — and never with its path in the caller's
        // message, only on stderr.
        const why = e instanceof Error ? e.message : String(e);
        console.error(`glm-mcp: could not read the ZCode config ${zcode}: ${why}`);
        throw new Error(
          "The ZCode config could not be read, so the key it holds could not " +
            "be used. Check that this server's account is allowed to read it, " +
            "or set ZAI_API_KEY instead.",
        );
      }
    }
    if (raw !== undefined) {
      try {
        const cfg = JSON.parse(raw);
        const k = cfg?.provider?.["builtin:zai-coding-plan"]?.options?.apiKey;
        if (typeof k === "string" && k.trim()) return k.trim();
      } catch (e) {
        // A config that will not parse holds no usable key, so the plain
        // guidance below still applies — but the operator who opted in (#21)
        // loses the reason unless it lands on stderr, the same split as above.
        const why = e instanceof Error ? e.message : String(e);
        console.error(`glm-mcp: could not parse the ZCode config ${zcode}: ${why}`);
      }
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

// ------------------------------------------- the input budget, derived (#35) —
// The old flat 800,000 was a round guess from the first commit, derived from
// nothing. The tool's own description sells GLM-5.3's million-token window and
// then handed it roughly a quarter of one. The budget below is what remains of
// that window after the reply and the prompt are provided for.

/**
 * The context window the input budget is sized against, in tokens. z.ai does
 * NOT publish a context length; this figure is from model listings, so it is
 * an assumption and must read as one — overridable with GLM_MCP_CONTEXT_TOKENS
 * when it proves wrong, which is also how a caller on a model with a smaller
 * window sizes the budget down.
 */
export const CONTEXT_WINDOW_TOKENS = 1_048_576;

/**
 * Tokens of the window held back for the reply: the default model's own
 * default max_tokens (see {@link outputLimits}) — the answer shares the window
 * with the input, so the input budget is what remains after it.
 */
const OUTPUT_RESERVE_TOKENS = outputLimits(DEFAULT_MODEL).def;

/**
 * Tokens held back for everything the caller sends that is not file context —
 * the system prompt, the question itself, the per-file headers. A few thousand
 * is plenty: these are bounded by the tool, not by the files.
 */
export const PROMPT_RESERVE_TOKENS = 8_192;

/**
 * The token↔character exchange rate of the budget. 3.0 targets English and
 * code deliberately — this repository's stated audience. Other scripts are
 * denser: Chinese runs nearer 1 char/token, so a CJK-heavy caller may need to
 * lower GLM_MCP_MAX_FILE_CHARS. The English default is not lowered to
 * accommodate that case: overshooting surfaces as a loud context-length error
 * from z.ai, while undersizing silently starves every English caller of the
 * window the tool sells.
 */
export const CHARS_PER_TOKEN = 3.0;

/**
 * The input budget in characters for a given window: the window minus the
 * output and prompt reserves, converted at {@link CHARS_PER_TOKEN}. A function
 * of the window rather than a constant so the derivation is the contract —
 * moving the window moves the budget with it.
 */
export function deriveMaxFileChars(contextTokens: number): number {
  const inputBudget = Math.max(0, contextTokens - OUTPUT_RESERVE_TOKENS - PROMPT_RESERVE_TOKENS);
  return Math.floor(inputBudget * CHARS_PER_TOKEN);
}

// Resolved once per process, so the cap is pinned by the environment the server
// started with — like the client's, this is a knob of the process, not of a call.
// GLM_MCP_MAX_FILE_CHARS still overrides the derived value outright (#35), and
// an unparsable value still falls back to it (#24).
const DEFAULT_MAX_FILE_CHARS = deriveMaxFileChars(
  envLimit("GLM_MCP_CONTEXT_TOKENS", CONTEXT_WINDOW_TOKENS),
);
export const MAX_FILE_CHARS = envLimit("GLM_MCP_MAX_FILE_CHARS", DEFAULT_MAX_FILE_CHARS);

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

/**
 * The note for an entry that yielded nothing readable, whatever the reason
 * (#26): a literal that does not exist, a literal the read was refused for,
 * a pattern that matched nothing, a pattern not one match of which could be
 * read. Which of those applied is the server's business — `namesSomething`
 * picks an entry's branch by whether the file EXISTS, so any difference in
 * what the branches say is an existence-and-permission oracle for anything
 * inside the roots, and fixing one wording at a time twice left the next
 * spelling open: a name made of metacharacters, then a pattern and its
 * literal twin in one call. `no matches` is the wording because it is what a
 * genuinely empty pattern has always said, and those patterns still say
 * exactly that. The refusal notes in buildFileContext are the deliberate
 * opposite — they name the expanded match, pinned by the confinement gate,
 * because a boundary the caller cannot see is what those notes have to
 * explain.
 */
const skipNote = (p: string): string => `skipped (no matches): ${p}`;

/**
 * How many leading bytes are inspected for a NUL before a file is believed to
 * be text. 8,000 is git's own sniffing length and the conventional one: no
 * human-written text encoding contains a NUL, while nearly every binary
 * format is dense with them.
 */
const BINARY_SNIFF_BYTES = 8_000;

const REPLACEMENT_CHAR = "\u{FFFD}";

/**
 * Whether a file's bytes are binary rather than text (#39). A NUL in the
 * first {@link BINARY_SNIFF_BYTES} bytes is the cheap, conventional verdict.
 * The backstop catches the binary formats that happen to hold no zero byte:
 * undecodable UTF-8 decodes to U+FFFD, so a body that is one replacement
 * character in ten or more is bytes the model cannot read. The ratio is
 * deliberately high — a text file carrying a few literal replacement
 * characters (itself mojibake, but its author's) is still read, and accented
 * Latin, CJK and emoji are valid UTF-8 and ordinary source; a detector that
 * rejects them would be worse than the bug it exists to fix.
 */
function isBinary(raw: Buffer): boolean {
  if (raw.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return true;
  const body = raw.toString("utf8");
  let replacements = 0;
  for (
    let i = body.indexOf(REPLACEMENT_CHAR);
    i !== -1;
    i = body.indexOf(REPLACEMENT_CHAR, i + 1)
  ) {
    replacements++;
    if (replacements * 10 >= body.length) return true;
  }
  return false;
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
  // Every note is filed under the argument that produced it, and the notes
  // leave in the order the arguments arrived (#26). Which branch handles an
  // entry — literal or pattern — is decided by whether the file exists, so
  // the order notes surface in is as much an answer as their wording: a
  // pattern's answer used to be written after the reads and a literal's
  // during them, which put the same two notes in different orders for the
  // same argument list. The sort is stable, so notes sharing an argument
  // keep the order they were pushed in — a limit note ahead of the refusal
  // it explains, both behind anything earlier.
  const notes: Array<{ arg: number; msg: string }> = [];
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
  // The patterns whose walk a confinement refusal cut short, the other half of
  // "stopped" — a "no matches" note would misdescribe those exactly as it
  // misdescribes a limited one, wherever about them it is filed.
  const refusedPatterns = new Set<string>();
  // The argument being worked. The budget's note sink and the mid-walk refusal
  // callback fire from inside glob.ts's own loops, synchronously within the
  // iteration they belong to, so this is how they learn which argument to file
  // their note under.
  let argAt = -1;
  const budget = walkBudget((msg) => {
    limitedPatterns.add(budget.pattern);
    notes.push({ arg: argAt, msg });
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
  // would widen what notes already disclose. `arg` is the position of that
  // argument, so the notes the reads push are filed under it too.
  const files: Array<{ p: string; via: string; resolved: string; arg: number }> = [];
  const included = new Set<string>();
  // Every pattern of this call and the resolved matches it found — the
  // de-duplicated ones too, because the note these exist to write asks the
  // pattern a question (did it contribute anything?) that a match claimed by
  // an earlier entry still answers. A Map, so a spelling repeated in the
  // argument list pools one found-set instead of walking twice — but the note
  // is owed to every argument that sent the spelling, not to the spelling,
  // because the literal route answers each repetition separately and the count
  // of answers is itself an answer: merge them and a caller learns whether a
  // repeated spelling named a file by counting what came back.
  const patternMatches = new Map<string, { found: Set<string> }>();
  // The files this result already speaks for, by resolved identity: one
  // delivered its content, was truncated, or was refused in a note naming
  // it. A file that yielded nothing readable is deliberately not here — that
  // absence is what tells the answer at the end which arguments contributed
  // nothing at all, and it is why a refusal marks its file: refused is not
  // absent, and filing a refused entry under "no matches" would claim it was.
  const spokenFor = new Set<string>();
  // One answer owed to each argument, written when the reads have settled
  // (#26). The literal route used to say its note at once and the pattern
  // route only after the reads; the answer is owed to the ARGUMENT either
  // way, so it is asked once, here, for both. It also survives
  // de-duplication, because de-duplication decides what is read, not what
  // the caller is told: an argument folded into an earlier entry's file
  // still got nothing it could not equally have got from the file not
  // existing, and that is the answer it receives. First appearance is the
  // arguments' own order, so the answers already read in it.
  const pendings: Array<
    | { arg: number; via: string; kind: "literal"; key: string }
    | { arg: number; via: string; kind: "pattern"; found: Set<string> }
  > = [];
  for (const [arg, p] of paths.entries()) {
    argAt = arg;
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
      notes.push({ arg, msg: `refused (credential path): ${p}` });
      continue;
    }
    if (!isGlobPattern(p) || namesSomething(p)) {
      if (!included.has(resolved)) {
        if (roots && !insideRoots(resolved, roots)) {
          notes.push({ arg, msg: `refused: ${p} resolves outside the allowed roots` });
          // The refusal speaks for the file, so an entry naming the same
          // identity later is neither re-refused nor filed under "no
          // matches": refused is not absent, and this note already says it.
          included.add(resolved);
          spokenFor.add(resolved);
          continue;
        }
        included.add(resolved);
        files.push({ p, via: p, resolved, arg });
      }
      // Registered whether this argument created the file entry or was
      // de-duplicated into an earlier one — see pendings.
      pendings.push({ arg, via: p, kind: "literal", key: resolved });
      continue;
    }
    // Limits are notes, never throws — and that goes for hostile input this
    // code has no specific rule for yet, not only for the rules it has. The
    // brace cap (#17) is enforced inside patternAnchors and expandGlob on every
    // route braces are expanded, so what this guard catches is the patterns
    // nobody predicted; a caller still gets its other files either way.
    try {
      if (roots && patternAnchors(p, cwd, budget).some((a) => !insideRoots(realpathish(a), roots))) {
        notes.push({ arg, msg: `refused: ${p} resolves outside the allowed roots` });
        continue;
      }
      // A directory the walk prunes for leaving the roots is a refusal like any
      // other: expandGlob reports each reported path once, with the spelling a
      // match would carry, so the note names both it and the pattern that
      // reached it.
      const matches = expandGlob(p, cwd, roots ?? undefined, (refused) => {
        refusedPatterns.add(p);
        notes.push({
          arg,
          msg: `refused: ${refused} (matched by ${p}) resolves outside the allowed roots`,
        });
      }, budget);
      // Every match is recorded against the pattern, de-duplicated or not;
      // a pattern that matched nothing is recorded the same way, with no
      // matches. The answer this feeds is written after the reads, because
      // whether an argument contributed anything is known only then. A pending
      // per argument that sent the spelling — see patternMatches above.
      let rec = patternMatches.get(p);
      if (!rec) patternMatches.set(p, (rec = { found: new Set<string>() }));
      pendings.push({ arg, via: p, kind: "pattern", found: rec.found });
      for (const m of matches) {
        const key = keyOf(m);
        rec.found.add(key);
        if (included.has(key)) continue;
        included.add(key);
        files.push({ p: m, via: p, resolved: key, arg });
      }
    } catch (e) {
      // #28: whatever the engine said — V8's wording describes its regex
      // compiler, not this project — stays on stderr for the operator, and the
      // caller is told in plain words that the pattern is unusable, next to the
      // spelling it sent. The note is a refusal like any other: the caller's
      // other files are still read.
      const why = e instanceof Error ? e.message : String(e);
      console.error(`glm-mcp: expanding ${p} failed: ${why}`);
      notes.push({ arg, msg: `refused: ${p} (expansion failed: malformed pattern)` });
      continue;
    }
  }

  // #40: the argument whose read the char cap cut, or -1 when it never cut.
  // Files are read in argument order, so everything from here on was never
  // attempted — and the pendings loop below needs to know it, because the
  // answer it owes those arguments is not the one it owes an argument that
  // was read and yielded nothing.
  let capCutAt = -1;

  for (const { p, via, resolved, arg } of files) {
    // Re-checked at read time because a glob match may be a symlink whose
    // target leaves the roots only once resolved; the anchor could not see it.
    if (denied.has(resolved)) {
      notes.push({
        arg,
        msg: `refused (credential path): ${p}${via === p ? "" : ` (matched by ${via})`}`,
      });
      spokenFor.add(resolved);
      continue;
    }
    if (roots && !insideRoots(resolved, roots)) {
      notes.push({
        arg,
        msg: `refused: ${p}${via === p ? "" : ` (matched by ${via})`} resolves outside the allowed roots`,
      });
      spokenFor.add(resolved);
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
      continue; // nothing was read; the argument's answer below says so
    }
    // Regular files only (#15): a FIFO blocks the read forever, a device like
    // /dev/zero is infinitely long, and neither has a size worth capping. The
    // refusal is a note like any other — a FIFO among ten good files must not
    // take them down with it.
    const matchedBy = via === p ? "" : ` (matched by ${via})`;
    if (!st.isFile()) {
      notes.push({ arg, msg: `refused (not a regular file): ${p}${matchedBy}` });
      spokenFor.add(resolved);
      continue;
    }
    if (st.size > maxFileBytes) {
      notes.push({
        arg,
        msg: `refused (too large): ${p}${matchedBy} is ${st.size} bytes, over the ` +
          `GLM_MCP_MAX_FILE_BYTES limit of ${maxFileBytes}`,
      });
      spokenFor.add(resolved);
      continue;
    }
    let raw: Buffer;
    try {
      raw = readFileSync(abs);
    } catch {
      continue; // nothing was read; the argument's answer below says so
    }
    // #39: the bytes are judged before they become text. Decoding a binary
    // file as UTF-8 turns every undecodable byte into U+FFFD and flows it
    // into the prompt — silently spending the char budget on characters the
    // model cannot read, which since #35 is a budget with room for whole
    // images and fonts to crowd out the source the caller asked about. The
    // file is skipped and named instead, and because nothing of it enters
    // the prompt, none of its bytes count against the budget.
    if (isBinary(raw)) {
      notes.push({ arg, msg: `skipped (binary file): ${p}${matchedBy}` });
      // The note speaks for the file, so the argument's answer below does not
      // add `no matches` beside it — skipped is not absent.
      spokenFor.add(resolved);
      continue;
    }
    const body = raw.toString("utf8");
    // Content will be delivered — in full or truncated — so the result
    // speaks for this file either way.
    spokenFor.add(resolved);
    // #19: the header and the separator count toward the cap with the body, so
    // 300 empty files cannot produce a five-figure prompt under a
    // multimillion-char "cap" with no note. `total` is the assembled length so
    // far, separators included, which is what makes text.length ≤ MAX honest.
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
      // #40, at argument granularity: the note says where the cut began by
      // naming the ARGUMENT that was being read — `via`, the caller's own
      // spelling — never the file. For a literal the two are the same string,
      // and naming it tells the caller nothing it did not supply. For a
      // pattern's match the filename is something the caller would be
      // LEARNING — it sent the pattern — and naming which match the cap
      // reached, or which matches it never reached, can only happen for files
      // that exist, which is #26's existence oracle wearing the cap's hat.
      // What the caller needs in order to curate and retry is which of ITS
      // arguments did not fully arrive, and an argument is something it
      // already knows. The truncated match's partial body still stands in the
      // text under its own (truncated) header, so the model loses nothing;
      // the note keeps to the caller's side of the boundary. This one note is
      // also the pattern's answer: the pendings loop below stays silent about
      // a pattern it cut inside of, so the argument is said exactly once.
      notes.push({
        arg,
        msg: `truncated at ${MAX_FILE_CHARS} total chars starting with: ${via}`,
      });
      // The cap cut the loop here, so the entries after this one were never
      // attempted. `capCutAt` records whose read was underway (#40): every
      // argument from here on is answered below as never read rather than as
      // having matched nothing, so the caller can tell what reached the model
      // and retry with a curated list — the only useful thing it can do next.
      capCutAt = arg;
      break;
    }
    chunks.push(`${sep}${header}${body}`);
    total += overhead + body.length;
  }

  // The reads have settled, so every argument can be answered now, in the
  // arguments' own order (#26). The question is the same for a literal and a
  // pattern alike: did anything this argument names appear in the result?
  // Nothing spoken for — not delivered, not truncated, not refused in a note
  // naming it — and the argument is told `no matches`, the one wording,
  // because the caller must not be able to tell the reasons apart: the
  // branch its entry took was chosen by whether the file exists, so a
  // difference between the reasons is a difference about the machine. A
  // pattern some of whose matches WERE read says nothing — `no matches`
  // beside content that came from this very pattern would not be the truth,
  // and the note would still disclose that another of its matches existed
  // and could not be read. This question is asked of the arguments the reads
  // reached, and of the pattern the cap cut inside of: a pattern PAST the
  // cut is never asked it, because how much of such a pattern arrived is a
  // fact about which files exist — a silence earned by "every match was
  // claimed by an earlier argument" holds only in the world where no
  // further match is sitting there unread — so the position branch in the
  // loop below answers those on the caller's own argument order instead.
  // That includes the pattern the cap cut inside of:
  // the truncation note above has already named the argument, and to say
  // more here — which matches survived the cut, which never reached the
  // model — could only be decided by whether those files exist, which is
  // #26's oracle again. And a pattern whose walk was stopped — by a
  // limit, or by a boundary refusal — is excused entirely: refused is not
  // the same as absent, that note already speaks for it, and "no matches"
  // beside it would claim it was simply wrong.
  // The answer an unfulfilled argument receives (#40). Before the cap cuts
  // the reads it is `no matches`, the merged wording #26 settled on, because
  // whether the file was absent or unreadable must not be tellable. From the
  // cut on it changes: those arguments were never read, and saying `no
  // matches` about a file that is sitting there unread forecloses the retry
  // the note exists to enable. The line is drawn at the argument POSITION the
  // cap cut at, never at whether a file entry exists for the argument —
  // position is the caller's own choice and existence is the machine's
  // answer, so a wording that depended on it would reopen the oracle #26
  // closed: absent, unreadable and simply-never-reached must all produce this
  // same note.
  const answerNote = (pending: (typeof pendings)[number]): string =>
    capCutAt >= 0 && pending.arg >= capCutAt
      ? `skipped (char cap reached, not read): ${pending.via}`
      : skipNote(pending.via);

  for (const pending of pendings) {
    if (pending.kind === "literal") {
      if (!spokenFor.has(pending.key)) {
        notes.push({ arg: pending.arg, msg: answerNote(pending) });
      }
      continue;
    }
    if (limitedPatterns.has(pending.via) || refusedPatterns.has(pending.via)) continue;
    // #40, and the shape a review of the first cut of this fix caught: a
    // pattern positioned strictly PAST the cut is answered on position
    // alone, never on what its walk found. The found set is the machine's
    // answer — it grows only when files exist — so both a silence and a
    // note computed from it vary with what is on disk. The silence was the
    // bug: a pattern whose de-duplicated first match was delivered for an
    // earlier argument said nothing while its other matches fell past the
    // cap unread, and the caller could not tell which argument to curate.
    // A note computed from the found set is the same coin returned: with
    // ['a.md', 'big.txt', '*.md'], naming the pattern only when a match
    // beyond a.md exists tells the caller exactly that — #26's oracle
    // wearing the cap's hat. The branch twin is the leak at its narrowest:
    // 'a[.]md' is a literal when a file by that name exists and a pattern
    // matching a.md when it does not, so which route answers was already
    // chosen by existence. The argument's TURN, unlike its match list, is
    // the caller's own fact: the cap arrived before the argument was read,
    // and that is all the note claims — how much of the pattern overlapped
    // earlier arguments is computable from arguments the caller itself
    // supplied. The pattern the cap cut INSIDE of is deliberately not here
    // (arg === capCutAt): the file it was reading is spoken for, so the
    // scan below stays silent and the truncation note above remains that
    // argument's one note (#26).
    if (capCutAt >= 0 && pending.arg > capCutAt) {
      notes.push({ arg: pending.arg, msg: answerNote(pending) });
      continue;
    }
    let contributed = false;
    for (const key of pending.found) {
      if (spokenFor.has(key)) {
        contributed = true;
        break;
      }
    }
    if (!contributed) notes.push({ arg: pending.arg, msg: answerNote(pending) });
  }

  // The separators were budgeted per chunk above, so joining is the identity:
  // `total` and text.length agree by construction. Notes leave in argument
  // order — see the top of this function.
  notes.sort((a, b) => a.arg - b.arg);
  return { text: chunks.join(""), notes: notes.map((n) => n.msg), refusedCall: false };
}

export interface AskArgs {
  prompt: string;
  model: string;
  reasoning: Reasoning;
  system?: string;
  /**
   * The caller's output cap. Omitted, the model's own published default
   * applies (see {@link outputLimits}) — not a constant of ours.
   */
  maxTokens?: number;
}

export interface AskResult {
  text: string;
  thinkingChars: number;
  model: string;
  usage: { input: number; output: number; cacheRead: number };
  /**
   * Why the answer ended, exactly as the API reported it (#41). "end_turn" is
   * a finished answer; "max_tokens" is one the output cap severed mid-reply,
   * which a caller must be able to tell from a complete second opinion — the
   * footer in index.ts says it where the caller already reads the result.
   */
  stopReason: string | undefined;
}

export async function ask(args: AskArgs): Promise<AskResult> {
  const { prompt, model, system } = args;

  // glm-5.3 always reasons; a request without a thinking block is rejected outright.
  let reasoning = args.reasoning;
  if (reasoning === "none" && THINKING_REQUIRED.has(model)) reasoning = "low";

  // #36: the model's own default when the caller is silent, and its own
  // ceiling when the caller is not — a cap over it is refused here, naming the
  // number, rather than learned from a 400 after the round trip. A model the
  // table does not know gets no ceiling at all: z.ai ships models faster than
  // any table can track, and blocking tomorrow's model to protect a stale
  // guess is the mistake this fixes, in a new place.
  const limits = outputLimits(model);
  const maxTokens = args.maxTokens ?? limits.def;
  if (limits.max !== undefined && maxTokens > limits.max) {
    throw new Error(
      `max_tokens ${maxTokens} is over ${model}'s published ceiling of ${limits.max} — ` +
        `the request is refused here rather than rejected by z.ai. Ask for ` +
        `${limits.max} or fewer output tokens.`,
    );
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (system) body.system = system;

  if (reasoning !== "none") {
    // #20: max_tokens is documented as an output cap, so it is one. The
    // thinking budget scales DOWN to fit beneath it — never up, and never the
    // cap raised to fit the budget, which is how a requested cap of 1 used to
    // leave as a billable 28,672. Scaling honours the cap only while both of
    // the request's own needs can hold beneath it: the budget may not go under
    // the API's floor of MIN_BUDGET_TOKENS, and ANSWER_ROOM must stay above
    // the budget for the answer. The budget flooring at the minimum is not a
    // way out — it buys the answer's room and leaves a reply that cannot
    // happen — so a cap under the two added is refused here, before a request
    // exists to send, naming the least cap that would work.
    if (maxTokens < MIN_BUDGET_TOKENS + MIN_ANSWER_TOKENS) {
      throw new Error(
        `max_tokens ${maxTokens} cannot hold both a thinking budget and an ` +
          `answer: the budget cannot be scaled below the API minimum of ` +
          `${MIN_BUDGET_TOKENS}, and ${MIN_ANSWER_TOKENS} of the cap must remain ` +
          `above it for the answer, so max_tokens must be at least ` +
          `${MIN_BUDGET_TOKENS + MIN_ANSWER_TOKENS}` +
          (THINKING_REQUIRED.has(model)
            ? `. ${model} always reasons and cannot run with reasoning off — raise ` +
              `max_tokens, or switch to a model that permits it (e.g. glm-4.6).`
            : ` or reasoning must be "none".`),
      );
    }
    // Prefer to leave ANSWER_ROOM, but never at the price of an invalid budget:
    // where the cap cannot afford both, the budget sits at the API's floor and
    // the answer takes the rest, which is still more than MIN_ANSWER_TOKENS
    // because the refusal above has already excluded the caps where it is not.
    const budget = Math.max(
      MIN_BUDGET_TOKENS,
      Math.min(BUDGET[reasoning], maxTokens - ANSWER_ROOM),
    );
    body.thinking = { type: "enabled", budget_tokens: budget };
  }

  const res = (await getClient().messages.create(body as never)) as {
    model?: string;
    stop_reason?: string;
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
    stopReason: res.stop_reason,
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
  // A code is a whole token, so the digits must run the whole length of the
  // code's value: they may not touch, on either side, a character a code value
  // can carry — a letter in any script, a digit, `_`, `-` or `.`. `1113abc`,
  // `1113-retry`, `1113.0` and `1113é` are all different codes from `1113`,
  // exactly as `11130` is, and none of them may be read as the bare code. The
  // one value character that also closes a sentence is `.`, so it counts as
  // part of the code only where it continues the number — a digit follows it
  // (`1113.0`). Followed by anything else, or by nothing, it is punctuation
  // ending a sentence, and the digits before it are still the whole code; on
  // the leading side a `.` before the digits always continues a number.
  // Where the code is a quoted value, the quotes are the boundary: everything
  // between them is the code, so "1113." and "1113.retry" are their own codes
  // and not 1113. Read that form first, because the prose rule below cannot
  // see the closing quote and would stop at the period.
  const quoted = /\bcode\b["']?\s*[:=]\s*(["'])(.*?)\1/iu.exec(msg);
  if (quoted) return /^\d+$/.test(quoted[2]) ? quoted[2] : undefined;

  // Unquoted, a code is still a whole token: the digits may not touch a
  // character a code value can carry — a letter in any script, a digit, `_`,
  // `-` or `.`. `1113abc`, `1113-retry`, `1113.0` and `1113é` are all
  // different codes from `1113`, exactly as `11130` is. The one value
  // character that also closes a sentence is `.`, so unquoted it counts as
  // part of the code only where it continues the number — a digit follows it.
  // Followed by anything else, or by nothing, it is punctuation ending a
  // sentence and the digits before it are the whole code; on the leading side
  // a `.` before the digits always continues a number.
  const labelled =
    /\bcode\b["']?\s*[:=]?\s*(?<![\p{L}\p{N}_.-])(\d+)(?![\p{L}\p{N}_-]|\.\p{N})/iu.exec(msg);
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

// The resource limits of decision 5 (#15, #16, #17, #19): every unbounded
// operation in glm_ask gets a bound. Hitting one stops that operation and
// records why in notes — the limit's note names its environment variable so a
// caller who trips one learns which knob to turn. Silent truncation is the
// failure mode this project has spent the most effort eliminating.

/**
 * The value an environment limit supplies, or undefined when it supplies none:
 * unset, or not a positive integer. The same predicate {@link envLimit} honours,
 * separate because a limit's reader can also need to know WHICH bound is in
 * force — a note naming the knob that cut it (#59) asks about the source, and
 * the source is not recoverable from the number a limit resolves to.
 */
export function envOverride(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** An environment limit: the documented default unless the value parses as a positive integer. */
export function envLimit(name: string, def: number): number {
  return envOverride(name) ?? def;
}

export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
// The default char cap lives in glm.ts as of #35: it is derived from the
// context window there, next to the output table it reserves against.
export const DEFAULT_TIMEOUT_MS = 600_000;
// The default heartbeat cadence (#43): five seconds says "still alive" often
// enough to keep a caller from killing a call that is working, and rarely
// enough that a ten-minute reasoning run produces a notification stream a
// transport has to absorb rather than a trickle.
export const DEFAULT_PROGRESS_MS = 5_000;
export const DEFAULT_MAX_DEPTH = 24;
export const DEFAULT_MAX_ENTRIES = 200_000;
export const DEFAULT_GLOB_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BRACE_EXPANSIONS = 1_024;

/**
 * The budgets one buildFileContext call shares across every pattern it expands.
 * Depth, entries and timeout fire inside the glob walk (see glob.ts); the note
 * sink is how those notes reach buildFileContext's own notes, the same channel
 * the confinement refusals use. `said` keeps a limit's note to one per pattern:
 * a walk that prunes a hundred directories at the depth cut-off is one note,
 * not a hundred.
 */
export interface WalkBudget {
  maxDepth: number;
  maxEntries: number;
  maxBraceExpansions: number;
  timeoutMs: number;
  deadline: number;
  entriesSeen: number;
  /** The pattern being walked, for the notes; set per expansion. */
  pattern: string;
  said: Set<string>;
  note: (msg: string) => void;
}

export function walkBudget(note?: (msg: string) => void): WalkBudget {
  const timeoutMs = envLimit("GLM_MCP_GLOB_TIMEOUT_MS", DEFAULT_GLOB_TIMEOUT_MS);
  return {
    maxDepth: envLimit("GLM_MCP_MAX_DEPTH", DEFAULT_MAX_DEPTH),
    maxEntries: envLimit("GLM_MCP_MAX_ENTRIES", DEFAULT_MAX_ENTRIES),
    maxBraceExpansions: envLimit(
      "GLM_MCP_MAX_BRACE_EXPANSIONS",
      DEFAULT_MAX_BRACE_EXPANSIONS,
    ),
    timeoutMs,
    deadline: Date.now() + timeoutMs,
    entriesSeen: 0,
    pattern: "",
    said: new Set<string>(),
    note: note ?? (() => {}),
  };
}

/** Record a walk-limit note unless the same message was already recorded. */
export function budgetNote(b: WalkBudget, msg: string): void {
  if (b.said.has(msg)) return;
  b.said.add(msg);
  b.note(msg);
}

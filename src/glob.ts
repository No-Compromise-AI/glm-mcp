import { readdirSync, statSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { insideRoots, realpathish } from "./confine.js";
import { budgetNote, envLimit, walkBudget, DEFAULT_MAX_BRACE_EXPANSIONS, type WalkBudget } from "./limits.js";

/**
 * Glob expansion for the `files` argument of glm_ask.
 *
 * Node's own fs.globSync would do this job, but it only exists from Node 22 and
 * this package still supports Node 20, so the forms worth matching — `*`, `**`,
 * `?`, `[a-z]`, `{a,b}` and `\` escapes — are expanded here instead.
 */

/** Characters that mark an entry as a pattern rather than a literal path. */
const GLOB_META = /[*?[\]{}]/;

export function isGlobPattern(path: string): boolean {
  return GLOB_META.test(path);
}

/** Directories glob expansion refuses to enter: dependencies, VCS state, build output. */
const DEFAULT_GLOB_IGNORE = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "vendor",
  "target",
];

/**
 * The ignore set for one expansion. GLM_MCP_GLOB_IGNORE (comma-separated) replaces
 * the default set outright; an empty value ignores nothing.
 */
function globIgnoreSet(): Set<string> {
  const raw = process.env.GLM_MCP_GLOB_IGNORE;
  const names = raw === undefined ? DEFAULT_GLOB_IGNORE : raw.split(",");
  return new Set(names.map((n) => n.trim()).filter((n) => n.length > 0));
}

/** Index of the `]` closing the class at `i`, or the end of `s` if it never closes. */
function closeClass(s: string, i: number): number {
  let j = i + 1;
  if (s[j] === "!" || s[j] === "^") j++;
  if (s[j] === "]") j++; // a leading ']' is a member, not the end
  while (j < s.length && s[j] !== "]") {
    if (s[j] === "\\") j++;
    j++;
  }
  return j;
}

/** One `{a,b}` group: where it opens and closes, and its comma-separated parts. */
interface BraceGroup {
  start: number;
  end: number;
  parts: string[];
}

/** The first top-level brace group in `pattern`, or null when there is none. */
function firstBraceGroup(pattern: string): BraceGroup | null {
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[") {
      i = closeClass(pattern, i);
      continue;
    }
    if (c !== "{") continue;

    const parts: string[] = [];
    let depth = 1;
    let start = i + 1;
    for (let j = i + 1; j < pattern.length; j++) {
      const d = pattern[j];
      if (d === "\\") {
        j++;
        continue;
      }
      if (d === "[") {
        j = closeClass(pattern, j);
        continue;
      }
      if (d === "{") depth++;
      else if (d === "}") {
        if (--depth === 0) {
          parts.push(pattern.slice(start, j));
          return { start: i, end: j, parts };
        }
      } else if (d === "," && depth === 1) {
        parts.push(pattern.slice(start, j));
        start = j + 1;
      }
    }
    return null; // unbalanced '{' — leave the whole pattern alone
  }
  return null;
}

/** Split `{a,b}` alternations into one pattern per combination. */
function expandBraces(pattern: string): string[] {
  const group = firstBraceGroup(pattern);
  if (group === null) return [pattern];
  const out: string[] = [];
  for (const part of group.parts) {
    out.push(
      ...expandBraces(pattern.slice(0, group.start) + part + pattern.slice(group.end + 1)),
    );
  }
  return out;
}

/**
 * How many patterns brace expansion of `pattern` would produce, counting only
 * up to `limit + 1` before giving up (#17). Combinatorial, so a million
 * combinations cost a thousand stack pushes rather than a million strings —
 * the count is what lets a caller refuse *before* expanding, and an explicit
 * stack is what keeps a hostile nesting depth from becoming a RangeError here.
 */
export function braceExpansionCount(pattern: string, limit: number): number {
  let total = 0;
  const stack: string[] = [pattern];
  while (stack.length > 0 && total <= limit) {
    const p = stack.pop() as string;
    const group = firstBraceGroup(p);
    if (group === null) {
      total++;
      continue;
    }
    for (const part of group.parts) {
      stack.push(p.slice(0, group.start) + part + p.slice(group.end + 1));
    }
  }
  return total;
}

/**
 * Expand braces under the GLM_MCP_MAX_BRACE_EXPANSIONS cap (#17): the patterns
 * when they fit, null when they do not — a count that refuses before expanding
 * is the only thing that stops both the memory blow-up and the spread-push
 * RangeError at ~18 nested groups. Called from every route that expands caller
 * braces, never only one of them.
 */
function expandBracesCapped(pattern: string, budget: WalkBudget): string[] | null {
  if (braceExpansionCount(pattern, budget.maxBraceExpansions) > budget.maxBraceExpansions) {
    budgetNote(
      budget,
      `refused (too many brace expansions): ${pattern} would expand past the ` +
        `GLM_MCP_MAX_BRACE_EXPANSIONS limit of ${budget.maxBraceExpansions}`,
    );
    return null;
  }
  return expandBraces(pattern);
}


/** Token kinds one compiled segment is built from. */
const LITERAL = 0;
const STAR = 1;
const ANY = 2;
const CLASS = 3;

/**
 * One path segment compiled into a matcher over directory entry names. This
 * used to be a RegExp — every `*` a `[^/]*` group — and a name that nearly
 * matched made V8 try every distribution of its characters across those groups,
 * exponentially many of them, for seconds at a time and synchronously on the
 * thread serving every other MCP call (#18). A `test` here runs the two-cursor
 * glob match instead, whose cost is bounded by the pattern's length whatever
 * the subject looks like.
 */
interface SegmentMatcher {
  test(name: string): boolean;
}

/**
 * The segment an uncompilable character class leaves behind: `[z-a]` cannot
 * become a matcher, so the segment matches no name at all. The pattern still
 * gets its note — see compileSegment's `onUncompilable` — so an invalid branch
 * cannot hide beside a good one; what the note replaces is the thrown error
 * that used to take the whole call down (the half of #28 that lives here).
 */
const MATCHES_NOTHING: SegmentMatcher = { test: () => false };

/**
 * Translate one path segment into a matcher over directory entry names.
 *
 * The tokens are walked with two cursors, the pattern's and the name's, and the
 * only backtracking there is runs through the most recent `*`: on a mismatch
 * that star is retried swallowing one more character than last time, and
 * everything after it replays forward. A star's retry position only ever moves
 * forward, so a `test` costs at most (tokens × characters) — never the
 * exponential sweep a `*`-per-group RegExp performs on a near-match.
 *
 * Character classes stay RegExps, built exactly as before: a class matches one
 * character and holds no quantifier, so it cannot backtrack, and keeping the
 * body text identical keeps its parsing — ranges, `[!]`/`[^]` negation,
 * escapes, the unclosed and empty forms staying literal — unchanged. One that
 * will not compile turns the whole segment into MATCHES_NOTHING, and
 * `onUncompilable` — when the caller passes one — reports it, because a
 * segment that quietly matches nothing is a pattern the caller never hears
 * about again: a `{[z-a].ts,ok.ts}` would read its good branch and drop the
 * bad one without a word, the silent narrowing this file exists to prevent.
 */
function compileSegment(seg: string, onUncompilable?: (e: Error) => void): SegmentMatcher {
  // Hidden entries only match when the pattern spells the dot out, as in minimatch.
  const allowsDot = seg.startsWith(".") || seg.startsWith("\\.");
  const kinds: number[] = [];
  /** What each token matches: a literal character, or the class's one-character RegExp. */
  const atoms: (string | RegExp)[] = [];
  const push = (kind: number, atom: string | RegExp): void => {
    kinds.push(kind);
    atoms.push(atom);
  };
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "\\") {
      const next = seg[++i];
      push(LITERAL, next === undefined ? "\\" : next); // a lone backslash matches itself
      continue;
    }
    if (c === "*") {
      while (seg[i + 1] === "*") i++; // '**' only means something as a whole segment
      push(STAR, "");
      continue;
    }
    if (c === "?") {
      push(ANY, "");
      continue;
    }
    if (c === "[") {
      const close = closeClass(seg, i);
      if (close >= seg.length) {
        push(LITERAL, "["); // unclosed — treat the bracket literally
        continue;
      }
      let inner = seg.slice(i + 1, close);
      let negated = "";
      if (inner.startsWith("!") || inner.startsWith("^")) {
        negated = "^";
        inner = inner.slice(1);
      }
      if (inner === "") {
        push(LITERAL, "["); // an empty class matches nothing usable — keep it literal
        continue;
      }
      try {
        push(CLASS, new RegExp(`[${negated}${inner.replace(/[\]\\^]/g, "\\$&")}]`));
      } catch (e) {
        // A reversed range, say — reported through the caller's sink, not thrown.
        onUncompilable?.(e instanceof Error ? e : new Error(String(e)));
        return MATCHES_NOTHING;
      }
      i = close;
      continue;
    }
    push(LITERAL, c);
  }
  return {
    test(name: string): boolean {
      // The old RegExp spelled this `(?!\.)` ahead of the body: a name the
      // pattern does not spell the leading dot of never matches at all.
      if (!allowsDot && name.startsWith(".")) return false;
      let p = 0; // the token being matched
      let s = 0; // the character of `name` it is matched against
      let star = -1; // the token a mismatch rewinds to: the most recent `*`
      let starAt = 0; // where that star's current run through the name began
      while (s < name.length) {
        const k = p < kinds.length ? kinds[p] : -1;
        if (k === STAR) {
          star = p++;
          starAt = s;
          continue;
        }
        let ok = false;
        if (k === ANY) ok = true;
        else if (k === LITERAL) ok = atoms[p] === name[s];
        else if (k === CLASS) ok = (atoms[p] as RegExp).test(name[s]);
        if (ok) {
          p++;
          s++;
          continue;
        }
        if (star < 0) return false; // no star to hand the mismatch to
        s = ++starAt; // the star takes one more character than it did last time…
        p = star + 1; // …and matching replays forward from just past it
      }
      // The name is spent; only stars may remain, each content to match nothing.
      while (p < kinds.length && kinds[p] === STAR) p++;
      return p === kinds.length;
    },
  };
}

/** Marker for the one segment that has meaning beyond a single name. */
type Segment = SegmentMatcher | "**";

/**
 * The one directory name a segment can match, or undefined when wildcards let
 * it match more. Escapes are resolved the way compileSegment resolves them, so
 * `node\_modules` names `node_modules` as plainly as an unescaped segment does;
 * a lone trailing backslash names nothing.
 */
function literalName(seg: string): string | undefined {
  let out = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "\\") {
      const next = seg[++i];
      if (next === undefined) return undefined;
      out += next;
      continue;
    }
    if (c === "*" || c === "?" || c === "[") return undefined;
    out += c;
  }
  return out;
}

/**
 * The wall-clock limit's note (#16). One spelling shared by every site that can
 * run out of time — walk's entry checks, its mid-scan samples, the brace-branch
 * loop — because budgetNote de-duplicates on the message text, and two sites
 * describing one overrun in two wordings would be two notes.
 */
const timeoutNote = (b: WalkBudget): string =>
  `refused: ${b.pattern} stopped at the GLM_MCP_GLOB_TIMEOUT_MS limit of ` +
  `${b.timeoutMs}ms; the walk was cut short`;

/**
 * Expand one glob pattern against `cwd` into the files it matches, sorted.
 * Directories are traversed, never listed; a pattern is only reported when it
 * has matched at least one file. Leading `.` and `..` segments resolve against
 * `cwd`, so `./src/**` and `../neighbour/src/**` start where they point. On
 * Windows a forward-slash drive (`C:/src/**`) or UNC (`//server/share/src/**`)
 * prefix is absolute, like a leading `/` anywhere; a backslash is an escape on
 * every platform, never a separator.
 * Ignored directories (see globIgnoreSet) are not entered — unless the pattern
 * spells their name out as a segment, which reads as the caller asking for
 * them deliberately. The same explicitness decides symlinked directories: a
 * segment that names one is followed, a wildcard that merely matches it is not.
 *
 * `roots`, when given, confines the expansion: a base directory whose realpath
 * leaves the roots is never walked, and no directory whose realpath leaves
 * them is descended into. Containment stops the walk rather than only the
 * read, so a pattern rooted at the top of the volume cannot traverse it before
 * its matches are refused one by one. Without `roots` the expansion is
 * unconfined, exactly as it was before confinement existed.
 *
 * `onRefused`, when given, is called with the spelling a match at the same
 * place would carry — the pattern's root and literal prefix included, so
 * absolute, drive and UNC forms keep their prefix — for each directory the
 * confinement prunes mid-walk. A pruned directory is a refusal like any other:
 * without this the caller would return partial context that reads as complete
 * — the silent narrowing decision 1 rules out — and what it would be hiding is
 * a hostile symlink. Several routes can reach one path (`**` more than once,
 * or one brace branch per route), so a path is reported once per expansion,
 * not once per route. The key is the reported path itself, never the
 * directory it resolves to: two symlinks to one outside directory are two
 * paths the caller has to fix, and keying on the resolved target would
 * collapse them into one report — the same silent narrowing again.
 *
 * `budget`, when given, is the walk-wide limits of decision 5 (#16, #17) the
 * caller shares across every pattern of its call: depth, entries examined and
 * wall clock stop the walk that hit them and say so through the budget's note
 * sink, one note per pattern per limit. Without one the expansion is bounded
 * by the same defaults, read from the environment here — bounded either way,
 * because a bound that only holds when the caller remembers to pass it is not
 * a bound. Direct callers have no note sink, so their limit notes go
 * unrecorded; the limits still hold.
 */
export function expandGlob(
  pattern: string,
  cwd: string,
  roots?: string[],
  onRefused?: (refused: string) => void,
  budget?: WalkBudget,
): string[] {
  const b = budget ?? walkBudget();
  b.pattern = pattern;
  const found = new Set<string>();
  const said = new Set<string>();
  const refuse = onRefused === undefined ? undefined : (p: string) => {
    if (said.has(p)) return;
    said.add(p);
    onRefused(p);
  };
  const expanded = expandBracesCapped(pattern, b);
  if (expanded === null) return [];
  // A fully literal branch names one path, so collect never reaches walk's
  // deadline check — a cap-sized run of such branches is a stat loop the wall
  // clock never sees, bypassing #16 as thoroughly as a wide single directory.
  // The clock is read before the first branch — an already-expired budget is
  // spent however few branches remain, and a stride of 64 would let 63 of
  // them through unsampled — and then every 64th, like the entry loops below,
  // rather than every one.
  let branch = 0;
  for (const p of expanded) {
    if (branch++ % 64 === 0 && Date.now() > b.deadline) {
      budgetNote(b, timeoutNote(b));
      break;
    }
    collect(p, cwd, found, roots ?? null, refuse, b);
  }
  return [...found].sort();
}

/**
 * The directory a pattern's expansion is anchored at: its leading literal
 * segments — `.` and `..` included — resolved against `cwd`, or against the
 * pattern's own root when it is absolute. A fully literal pattern anchors at
 * the file it names. buildFileContext checks this before expanding so a
 * pattern rooted outside the confinement roots is refused before any walking
 * happens; it says where a walk would start, not what it would match.
 */
export function patternAnchor(pattern: string, cwd: string): string {
  return anchorOf(pattern, cwd)?.base ?? resolve(cwd, pattern);
}

/**
 * The anchors of every walk `pattern` would start, one per brace expansion.
 * buildFileContext checks these before expanding so a branch that escapes the
 * roots is refused up front — with braces, the anchor of the pattern as written
 * is the anchor of none of its branches, and the branch that leaves the roots
 * would otherwise vanish inside `collect` without a word.
 *
 * The brace cap (#17) holds here as it does in expandGlob: this is the second
 * route by which caller braces get expanded, and a cap on one path but not the
 * other leaves the expansion blow-up wide open. A pattern over the cap has no
 * anchors to check — the caller that passed a budget has already been told why
 * in a note, and returns no anchor rather than a silently partial list.
 */
export function patternAnchors(pattern: string, cwd: string, budget?: WalkBudget): string[] {
  const b = budget ?? walkBudget();
  b.pattern = pattern;
  const expanded = expandBracesCapped(pattern, b);
  if (expanded === null) return [];
  return [...new Set(expanded.map((p) => patternAnchor(p, cwd)))];
}

/** Everything `collect` needs to know about where a pattern is anchored. */
interface Anchor {
  /** The walk's start directory, leading literal segments resolved. */
  base: string;
  /** Those segments as display text, kept for the paths that get emitted. */
  prefix: string[];
  /** The segments after the leading literal run — the ones matched by walk. */
  rest: string[];
  /** `C:/`, `//` or `/` for absolute patterns; "" for relative ones. */
  root: string;
}

/** Resolve a pattern's leading literal run into the anchor its walk starts from. */
function anchorOf(pattern: string, cwd: string): Anchor | null {
  // On Windows a drive prefix (`C:/repo`) or a UNC one (`//server/share`)
  // spells an absolute pattern as surely as a leading `/` does. Only the
  // forward-slash forms are honoured: a backslashed pattern is a native path,
  // and reading its separators would collide with the `\` escape syntax this
  // globber documents and tests. Off Windows `C:` stays an ordinary name.
  const windows = process.platform === "win32";
  const drive = windows ? /^([A-Za-z]:)\/(.*)$/.exec(pattern) : null;
  const unc = windows && pattern.startsWith("//");
  const absolute = pattern.startsWith("/") || drive !== null || unc;

  const segments = (drive ? drive[2] : pattern).split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;

  // Every emitted path grows this root — `C:/`, `//`, `/`, or nothing at all
  // for a relative pattern — and the walk is anchored at the same text.
  const root = drive ? `${drive[1]}/` : unc ? "//" : absolute ? "/" : "";

  // Leading literal segments — `.` and `..` included — resolve into the base
  // directory up front; `collect` would otherwise look for a directory entry
  // literally called `.` or `..` and match nothing. The prefix mirrors what
  // resolve() does, kept as display text for the paths that get emitted.
  let base = absolute ? root : cwd;
  const prefix: string[] = [];
  let first = 0;
  while (first < segments.length) {
    const name = literalName(segments[first]);
    if (name === undefined) break;
    first++;
    if (name === ".") continue;
    if (name === "..") {
      if (prefix.length > 0 && prefix[prefix.length - 1] !== "..") prefix.pop();
      else if (!absolute) prefix.push(".."); // above the root there is nowhere left to name
    } else {
      prefix.push(name);
    }
    base = resolve(base, name);
  }
  return { base, prefix, rest: segments.slice(first), root };
}

function collect(
  pattern: string,
  cwd: string,
  found: Set<string>,
  roots: string[] | null,
  onRefused: ((refused: string) => void) | undefined,
  b: WalkBudget,
): void {
  const anchor = anchorOf(pattern, cwd);
  if (anchor === null) return; // a bare root ("/", "C:/") names no segment to match
  const { base, prefix, rest, root } = anchor;
  const start = prefix.join("/");

  // Containment stops the walk, not only the read (#13/#14): a base whose
  // realpath leaves the roots is never entered, so an absolute pattern is
  // refused where it starts instead of traversing the volume to be refused
  // match by match. buildFileContext has already said why in notes by the time
  // it gets here; this is the same rule enforced where the walking happens.
  if (roots && !insideRoots(realpathish(base), roots)) return;

  const emit = (rel: string) => {
    found.add(root + rel);
  };

  // A class that will not compile becomes a note here — in the shape
  // buildFileContext's catch used to lend the throw — rather than a thrown
  // error, because a throw abandons the branches after it: `{[z-a].ts,ok.ts}`
  // lost ok.ts to it. Reported at the sink instead, the pattern as written is
  // named (b.pattern, braces included) and the good branches still run. The
  // note is this project's own wording (#28): V8's message names its regex
  // engine's internals, which is the operator's diagnostics, not the caller's
  // answer — it goes to stderr, stdout being the MCP protocol.
  const compiled: Segment[] = rest.map((s) =>
    s === "**"
      ? "**"
      : compileSegment(s, (e) => {
          console.error(`glm-mcp: pattern ${b.pattern} has a segment that will not compile: ${e.message}`);
          budgetNote(b, `refused: ${b.pattern} (expansion failed: malformed pattern)`);
        }),
  );
  // A segment that cannot compile matches nothing by construction, so walking
  // for its matches buys nothing — yet the walk reads real directories, and
  // every entry it examines is billed to the CALL's shared budget, not this
  // pattern's: a malformed argument would eat the entries an honest pattern
  // beside it needed. Nothing can be found and nothing can be spent, so every
  // compiled segment is checked up front, on every route through here — the
  // fully literal one that never reaches walk() included — rather than where a
  // walk would first meet the segment, which is one directory read too late.
  if (compiled.some((s) => s === MATCHES_NOTHING)) return;

  // A pattern that stays literal the whole way through names a single path:
  // one file, or nothing — directories are traversed, never listed.
  if (rest.length === 0) {
    try {
      if (statSync(base).isFile()) emit(start);
    } catch {
      return; // a path that cannot be stat'd matches nothing
    }
    return;
  }

  // An ignored directory is entered only where the pattern spells its name out
  // as a whole segment: `node_modules/foo/**` is an explicit request, while the
  // `*` in `*/body-parser/node_modules/...` must not ride a later literal past
  // an unrelated node_modules. `**` names nothing, so it never unlocks a skip.
  const names: (string | undefined)[] = rest.map((s) => (s === "**" ? undefined : literalName(s)));
  const ignored = globIgnoreSet();
  const skip = (name: string, i: number) => ignored.has(name) && names[i] !== name;
  // A directory the walk may enter. Under confinement a directory whose
  // realpath leaves the roots is not descended into however it was matched —
  // named literally by a segment, reached by a wildcard, or found by `**` —
  // because resolving first is what closes the symlink escape. Refusing one
  // is reported through `onRefused` with the same spelling a match would
  // carry — `emit`'s, root and literal prefix included — so a pruned directory
  // becomes the caller's note instead of context that quietly narrows. That
  // spelling is also the de-duplication key: distinct reported paths stay
  // distinct reports however many of them resolve to one directory.
  const enterable = (dir: string, rel: string): boolean => {
    if (!roots) return true;
    const real = realpathish(dir);
    if (insideRoots(real, roots)) return true;
    onRefused?.(root + rel);
    return false;
  };

  // The walk limits of decision 5 (#16): depth stops the descent, entries and
  // the wall clock stop the walk. Each fires as a note naming its environment
  // variable — once per pattern, however many directories the walk was about to
  // be refused — and each leaves the caller's other patterns alone, exactly as a
  // refused path does.
  const depthNote = `refused: ${b.pattern} stopped at the GLM_MCP_MAX_DEPTH limit of ` +
    `${b.maxDepth}; deeper directories were not walked`;
  const entriesNote = `refused: ${b.pattern} stopped after the GLM_MCP_MAX_ENTRIES limit of ` +
    `${b.maxEntries} directory entries was reached; the walk was cut short`;

  const walk = (dir: string, rel: string, i: number, depth: number): void => {
    const seg = compiled[i];
    // The pattern ran out: only directories reach this point, and only files count.
    if (seg === undefined) return;

    if (Date.now() > b.deadline) {
      budgetNote(b, timeoutNote(b));
      return;
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    b.entriesSeen += entries.length;
    if (b.entriesSeen > b.maxEntries) {
      budgetNote(b, entriesNote);
      return;
    }

    const child = (name: string) => (rel === "" ? name : `${rel}/${name}`);
    // What an entry is on disk. A symlink is resolved to its target so a link
    // to a directory stops posing as a file and a broken link matches nothing;
    // only symlinks need the stat, everything else is already known.
    const kind = (e: Dirent): "dir" | "file" | "other" => {
      if (e.isDirectory()) return "dir";
      if (e.isFile()) return "file";
      if (!e.isSymbolicLink()) return "other";
      try {
        const target = statSync(join(dir, e.name));
        return target.isDirectory() ? "dir" : target.isFile() ? "file" : "other";
      } catch {
        return "other";
      }
    };
    const last = i === compiled.length - 1;

    // The deadline is also sampled while the entries are being examined, not
    // only on the way in: a check at walk's entry bounds how many directories
    // are entered, so one wide directory — entered once, then scanned as long
    // as it is wide — never re-meets it (#16). The clock is read every 64th
    // entry rather than every entry: against a 200,000-entry budget that is
    // three thousand reads instead of two hundred thousand, and a scan that
    // crosses the line is still caught within 64 entries of crossing it.
    let sampled = 0;
    const outOfTime = (): boolean => ++sampled % 64 === 0 && Date.now() > b.deadline;

    if (seg === "**") {
      walk(dir, rel, i + 1, depth); // '**' may swallow zero segments
      for (const e of entries) {
        if (outOfTime()) {
          budgetNote(b, timeoutNote(b));
          return;
        }
        // '**' never spells a dot out, so hidden directories stay hidden.
        if (e.name.startsWith(".")) continue;
        // Real directories only: a '**'-matched symlink could point anywhere,
        // including back up this very walk, and never terminate it.
        if (e.isDirectory()) {
          if (depth + 1 > b.maxDepth) {
            budgetNote(b, depthNote);
            continue;
          }
          if (!skip(e.name, i) && enterable(join(dir, e.name), child(e.name))) {
            walk(join(dir, e.name), child(e.name), i, depth + 1);
          }
        } else if (last && kind(e) === "file") emit(child(e.name));
      }
      return;
    }

    for (const e of entries) {
      if (outOfTime()) {
        budgetNote(b, timeoutNote(b));
        return;
      }
      if (!seg.test(e.name)) continue;
      const k = kind(e);
      if (last) {
        if (k === "file") emit(child(e.name));
      } else if (k === "dir") {
        if (depth + 1 > b.maxDepth) {
          budgetNote(b, depthNote);
          continue;
        }
        // A symlinked directory is descended into only where the segment
        // spells its name out — an explicit request, as with the ignore
        // bypass — never where a wildcard happened to match it.
        if ((e.isDirectory() || names[i] === e.name) && !skip(e.name, i)
          && enterable(join(dir, e.name), child(e.name))) {
          walk(join(dir, e.name), child(e.name), i + 1, depth + 1);
        }
      }
    }
  };

  walk(base, start, 0, 0);
}

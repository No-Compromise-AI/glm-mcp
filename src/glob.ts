import { readdirSync, statSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { insideRoots, realpathish } from "./confine.js";

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

/** Escape a character so it matches literally inside a RegExp body. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

/** Split `{a,b}` alternations into one pattern per combination. */
function expandBraces(pattern: string): string[] {
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
    let closedAt = -1;
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
          closedAt = j;
          break;
        }
      } else if (d === "," && depth === 1) {
        parts.push(pattern.slice(start, j));
        start = j + 1;
      }
    }
    if (closedAt < 0) break; // unbalanced '{' — leave the whole pattern alone
    const out: string[] = [];
    for (const part of parts) {
      out.push(...expandBraces(pattern.slice(0, i) + part + pattern.slice(closedAt + 1)));
    }
    return out;
  }
  return [pattern];
}

/** Translate one path segment into a RegExp over directory entry names. */
function compileSegment(seg: string): RegExp {
  const allowsDot = seg.startsWith(".") || seg.startsWith("\\.");
  let body = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "\\") {
      const next = seg[++i];
      body += next === undefined ? "\\\\" : escapeRe(next);
      continue;
    }
    if (c === "*") {
      while (seg[i + 1] === "*") i++; // '**' only means something as a whole segment
      body += "[^/]*";
      continue;
    }
    if (c === "?") {
      body += "[^/]";
      continue;
    }
    if (c === "[") {
      const close = closeClass(seg, i);
      if (close >= seg.length) {
        body += "\\["; // unclosed — treat the bracket literally
        continue;
      }
      let inner = seg.slice(i + 1, close);
      let negated = "";
      if (inner.startsWith("!") || inner.startsWith("^")) {
        negated = "^";
        inner = inner.slice(1);
      }
      if (inner === "") {
        body += "\\["; // an empty class matches nothing usable — keep it literal
        continue;
      }
      body += `[${negated}${inner.replace(/[\]\\^]/g, "\\$&")}]`;
      i = close;
      continue;
    }
    body += escapeRe(c);
  }
  // Hidden entries only match when the pattern spells the dot out, as in minimatch.
  return new RegExp(`^(?:${allowsDot ? "" : "(?!\\.)"}${body})$`);
}

/** Marker for the one segment that has meaning beyond a single name. */
type Segment = RegExp | "**";

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
 */
export function expandGlob(
  pattern: string,
  cwd: string,
  roots?: string[],
  onRefused?: (refused: string) => void,
): string[] {
  const found = new Set<string>();
  const said = new Set<string>();
  const refuse = onRefused === undefined ? undefined : (p: string) => {
    if (said.has(p)) return;
    said.add(p);
    onRefused(p);
  };
  for (const p of expandBraces(pattern)) collect(p, cwd, found, roots ?? null, refuse);
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
 */
export function patternAnchors(pattern: string, cwd: string): string[] {
  return [...new Set(expandBraces(pattern).map((p) => patternAnchor(p, cwd)))];
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
  onRefused?: (refused: string) => void,
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

  const compiled: Segment[] = rest.map((s) => (s === "**" ? "**" : compileSegment(s)));
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

  const walk = (dir: string, rel: string, i: number): void => {
    const seg = compiled[i];
    // The pattern ran out: only directories reach this point, and only files count.
    if (seg === undefined) return;

    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
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

    if (seg === "**") {
      walk(dir, rel, i + 1); // '**' may swallow zero segments
      for (const e of entries) {
        // '**' never spells a dot out, so hidden directories stay hidden.
        if (e.name.startsWith(".")) continue;
        // Real directories only: a '**'-matched symlink could point anywhere,
        // including back up this very walk, and never terminate it.
        if (e.isDirectory()) {
          if (!skip(e.name, i) && enterable(join(dir, e.name), child(e.name))) {
            walk(join(dir, e.name), child(e.name), i);
          }
        } else if (last && kind(e) === "file") emit(child(e.name));
      }
      return;
    }

    for (const e of entries) {
      if (!seg.test(e.name)) continue;
      const k = kind(e);
      if (last) {
        if (k === "file") emit(child(e.name));
      } else if (k === "dir") {
        // A symlinked directory is descended into only where the segment
        // spells its name out — an explicit request, as with the ignore
        // bypass — never where a wildcard happened to match it.
        if ((e.isDirectory() || names[i] === e.name) && !skip(e.name, i)
          && enterable(join(dir, e.name), child(e.name))) {
          walk(join(dir, e.name), child(e.name), i + 1);
        }
      }
    }
  };

  walk(base, start, 0);
}

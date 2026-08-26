import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

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
 * Expand one glob pattern against `cwd` into the files it matches, sorted.
 * Directories are traversed, never listed; a pattern is only reported when it
 * has matched at least one file. Ignored directories (see globIgnoreSet) are
 * not entered — unless the pattern spells their name out as a segment, which
 * reads as the caller asking for them deliberately.
 */
export function expandGlob(pattern: string, cwd: string): string[] {
  const found = new Set<string>();
  for (const p of expandBraces(pattern)) collect(p, cwd, found);
  return [...found].sort();
}

function collect(pattern: string, cwd: string, found: Set<string>): void {
  const absolute = pattern.startsWith("/");
  const segments = pattern.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return;

  const compiled: Segment[] = segments.map((s) => (s === "**" ? "**" : compileSegment(s)));
  // Segments without metacharacters are plain directory names, so an ignored
  // directory the pattern itself names is still entered: `node_modules/foo/**`
  // is an explicit request, not an accident of a wildcard.
  const named = new Set(segments.filter((s) => !isGlobPattern(s)));
  const ignored = globIgnoreSet();
  const skip = (name: string) => ignored.has(name) && !named.has(name);
  const emit = (rel: string) => {
    found.add(absolute ? `/${rel}` : rel);
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
    const isFile = (e: Dirent) => e.isFile() || e.isSymbolicLink();
    const last = i === compiled.length - 1;

    if (seg === "**") {
      walk(dir, rel, i + 1); // '**' may swallow zero segments
      for (const e of entries) {
        // '**' never spells a dot out, so hidden directories stay hidden.
        if (e.name.startsWith(".")) continue;
        if (e.isDirectory()) {
          if (!skip(e.name)) walk(join(dir, e.name), child(e.name), i);
        } else if (last && isFile(e)) emit(child(e.name));
      }
      return;
    }

    for (const e of entries) {
      if (!seg.test(e.name)) continue;
      if (last) {
        if (isFile(e)) emit(child(e.name));
      } else if (e.isDirectory() && !skip(e.name)) {
        walk(join(dir, e.name), child(e.name), i + 1);
      }
    }
  };

  walk(absolute ? "/" : cwd, "", 0);
}

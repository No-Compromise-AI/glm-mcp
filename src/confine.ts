// The glm_ask trust boundary (#13, #14): decisions 1-4 of the design's
// TRUST-BOUNDARY. The boundary is operator-set, never caller-set — the caller
// may narrow within it, never choose or escape it.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

/**
 * A path's canonical on-disk identity where it has one, and its lexical
 * resolution where it does not. Containment and the credential denylist both
 * compare these values, so a symlink is judged by its target — which is what
 * closes the #14 escape, a link inside the tree pointing outside — and a file
 * that does not exist is judged by its spelling, so refusing it does not
 * depend on it existing first.
 */
export function realpathish(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/**
 * True when `resolved` is a root itself or lies underneath one. The separator
 * is only appended when the root does not already end in one, so a root of
 * `/` (or `C:\`) contains every absolute path instead of only those starting
 * `//`.
 */
export function insideRoots(resolved: string, roots: string[]): boolean {
  return roots.some((r) => resolved === r || resolved.startsWith(r.endsWith(sep) ? r : r + sep));
}

/**
 * The working directory the process was started in, read once at module load
 * and never again. Decision 1's default boundary is *the server process's own*
 * working directory at startup — reading it per call instead would hand the
 * choice to the caller's `cwd` argument, and a boundary the caller can set is
 * not a boundary. Resolved once here so a startup directory reached through a
 * symlink compares equal to the files under it.
 */
const STARTUP_CWD = realpathish(process.cwd());

/**
 * Split GLM_MCP_ROOTS into its roots. `:` separates, except where it carries a
 * drive prefix — `C:/repo`, `C:\repo` — which is the only way to spell a root
 * on Windows and must survive as one path. Such a colon is known by the single
 * letter before it starting a root and a separator (or nothing) after it; every
 * other colon splits, so `/srv/a:/srv/b` is still two roots and a root whose
 * POSIX name happens to end in a single letter (…/C) still ends where it did.
 * Only a root's own first letter counts: a colon later in a root is a separator
 * however it is spelled, because `/mnt/c:/mnt/d` is a real POSIX spelling and
 * indistinguishable from a drive on text alone.
 */
export function splitRoots(raw: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== ":") continue;
    const drive = i - start === 1 && /[A-Za-z]/.test(raw[start])
      && (raw[i + 1] === undefined || raw[i + 1] === "/" || raw[i + 1] === "\\");
    if (drive) continue;
    out.push(raw.slice(start, i));
    start = i + 1;
  }
  out.push(raw.slice(start));
  return out.map((r) => r.trim()).filter((r) => r.length > 0);
}

/**
 * The operator's roots for one call, or null when path confinement is off.
 *
 * GLM_MCP_ROOTS holds colon-separated absolute paths (see splitRoots). Each is
 * resolved before it is compared, so a root spelled through a symlink still
 * contains the files under it, a trailing separator is spelling rather than
 * meaning, and macOS's /var -> /private/var prefix does not silently refuse
 * everything. When the variable is unset the boundary is STARTUP_CWD — the
 * server's own working directory, not the directory the call names, because a
 * boundary the caller picks is not a boundary at all. GLM_MCP_ALLOW_ANY_PATH=1
 * (decision 4, mirroring the GLM_MCP_ALLOW_ZCODE_KEY precedent) turns the roots
 * rule off; the credential rule below survives it, because decision 3 is
 * "regardless of roots".
 */
export function confineRoots(): string[] | null {
  if (process.env.GLM_MCP_ALLOW_ANY_PATH === "1") return null;
  const listed = splitRoots(process.env.GLM_MCP_ROOTS ?? "");
  if (listed.length === 0) return [STARTUP_CWD];
  return listed.map(realpathish);
}

/**
 * The files the server never reads, whatever the roots say (decision 3): its
 * own two key stores and its own environment. Matched by resolved real path
 * rather than by spelling, so a re-spelled route or a symlink to the key from
 * inside a root still resolves to the denied file. Both sides use realpathish:
 * on Linux `/proc/self` resolves to the live pid, and where /proc does not
 * exist both sides keep the lexical spelling — the refusal holds either way.
 */
export function deniedCredentials(): Set<string> {
  const home = homedir();
  return new Set(
    [
      "/proc/self/environ",
      resolve(home, ".config/zai/api-key"),
      resolve(home, ".zcode/v2/config.json"),
    ].map(realpathish),
  );
}

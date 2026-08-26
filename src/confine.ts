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
 * The operator's roots for one call, or null when path confinement is off.
 *
 * GLM_MCP_ROOTS holds colon-separated absolute paths. Each is resolved before
 * it is compared, so a root spelled through a symlink still contains the files
 * under it, a trailing separator is spelling rather than meaning, and macOS's
 * /var -> /private/var prefix does not silently refuse everything. When the
 * variable is unset the boundary is the working directory the call resolves
 * against — for the server that is its own cwd, which index.ts passes whenever
 * the caller does not. GLM_MCP_ALLOW_ANY_PATH=1 (decision 4, mirroring the
 * GLM_MCP_ALLOW_ZCODE_KEY precedent) turns the roots rule off; the credential
 * rule below survives it, because decision 3 is "regardless of roots".
 */
export function confineRoots(cwd: string): string[] | null {
  if (process.env.GLM_MCP_ALLOW_ANY_PATH === "1") return null;
  const listed = process.env.GLM_MCP_ROOTS?.split(":")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  if (listed === undefined || listed.length === 0) return [realpathish(cwd)];
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

# Which agent is driving this run, and therefore which reviewers are
# independent of it. Sourced by glm-review and glm-task; not a command.
#
# The delegate → review loop is worth running only because the reviewer is a
# different vendor's model than the one that wrote the code. That held while
# Claude was the only host and "codex" could be a hardcoded default. It stops
# holding the moment the same loop is driven from inside Codex, or Antigravity:
# the reviewer would be reviewing its own session's work, and nothing anywhere
# would say so.
#
# Written for bash 3.2 — the bash macOS ships, and the one `#!/usr/bin/env bash`
# actually finds here. No associative arrays, and every array expansion carries
# its own default so `set -u` does not trip on an empty one.

# The reviewers that can be asked for a verdict. Every entry is also a host,
# because an agent you can sit inside is an agent you can ask for a review —
# which is exactly why the host has to be taken back out again.
#
# `glm` is deliberately absent: GLM writes the code under review, so it is the
# one model that can never be the independent reviewer of it. It stays
# available as an explicit `-r glm` for the times you want it anyway.
GLM_REVIEWER_POOL="${GLM_REVIEWER_POOL:-codex claude agy}"

# Where `auto` lands when the host is unknown. Today's behaviour, kept as the
# degraded path rather than the default one.
GLM_AUTO_FALLBACK="${GLM_AUTO_FALLBACK:-codex}"

# The agent driving this run, or empty when it cannot be known.
#
# Only Claude Code marks its own children reliably (CLAUDECODE / the entrypoint
# var). Codex and Antigravity set nothing a child can read — both binaries were
# checked — so they say so themselves via GLM_HOST, which is why the explicit
# variable is consulted first and detection is only the fallback.
glm_host() {
  if [ -n "${GLM_HOST:-}" ]; then printf '%s\n' "$GLM_HOST"; return 0; fi
  if [ -n "${CLAUDECODE:-}" ] || [ -n "${CLAUDE_CODE_ENTRYPOINT:-}" ]; then printf 'claude\n'; return 0; fi
  printf '\n'
}

# Expand a reviewer spec into the reviewers to actually run, space separated.
#
#   auto        every reviewer except the host   (the default)
#   all         every reviewer, host included
#   none        no review
#   a,b         exactly those, whatever the host is
glm_resolve_reviewers() {
  glm__spec="${1:-auto}"
  glm__host="$(glm_host)"
  case "$glm__spec" in
    none)
      return 0
      ;;
    all)
      printf '%s\n' "$GLM_REVIEWER_POOL"
      ;;
    auto)
      if [ -z "$glm__host" ]; then
        # Degrade loudly. Silently reviewing with the host would defeat the
        # whole loop, and silently reviewing with nobody would be worse.
        echo "glm: host unknown — falling back to '$GLM_AUTO_FALLBACK'. Set GLM_HOST=codex|claude|agy so the agent driving this run is never its own reviewer." >&2
        printf '%s\n' "$GLM_AUTO_FALLBACK"
        return 0
      fi
      glm__out=""
      for glm__r in $GLM_REVIEWER_POOL; do
        [ "$glm__r" = "$glm__host" ] && continue
        glm__out="${glm__out:+$glm__out }$glm__r"
      done
      if [ -z "$glm__out" ]; then
        # Only reachable if the pool is a single entry and the host is it.
        echo "glm: host '$glm__host' is the only reviewer in the pool; there is no independent reviewer to fall back to." >&2
        return 0
      fi
      printf '%s\n' "$glm__out"
      ;;
    *)
      # An explicit list. The operator overrides the policy; the policy never
      # overrides the operator, so the host is not filtered out of it.
      printf '%s\n' "$(printf '%s' "$glm__spec" | tr ',' ' ')"
      ;;
  esac
  return 0
}

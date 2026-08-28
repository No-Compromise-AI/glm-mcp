# Telling "the provider is throttling us" apart from "the work failed".
# Sourced by glm-review, glm-task and glm-drain; not a command.
#
# The distinction is the whole reason this file exists. A throttled run has
# produced no information about the change: retrying it later is free and
# correct, and recording it as a failure burns an attempt on work that was never
# actually attempted. A failed run is the opposite — retrying it unchanged just
# fails again. Conflating them means an overnight drain marks a night's backlog
# "failed" because the plan hit its window at 2am.
#
# It lived in glm-review, where it was only ever applied to REVIEWERS. The
# delegate's own output was never checked, so GLM being rate-limited read as GLM
# failing the task.
#
# Written for bash 3.2, as the rest of bin/ is.

# True when output shows the provider refusing on capacity rather than the work
# going wrong. Deliberately broad across vendors: z.ai, Anthropic, OpenAI and
# Google all phrase this differently, and a missed match is the expensive
# direction — it turns a wait into a burned attempt.
glm_is_exhausted() {
  printf '%s' "$1" | grep -qiE \
    'rate.?limit|quota (exceeded|reached)|usage limit|out of (credits|capacity|tokens)|too many requests|http 429|status 429|insufficient (balance|credits|quota)|plan limit|limit reached|try again (later|in [0-9])'
}

# The wait a provider asked for, in seconds, or empty when it named none.
#
# Honouring an explicit number is the difference between cooperating with a rate
# limit and guessing at it. z.ai sends no Retry-After header — checked against a
# live response — so the only place a number ever appears is prose in the error
# body, which is why this reads text rather than headers.
glm_retry_after() {
  printf '%s' "$1" | grep -oiE 'retry[- ]after[: ]+[0-9]+|try again in [0-9]+ ?(s|sec|second|m|min|minute|h|hour)' \
    | head -1 \
    | awk '{
        n = 0
        for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+$/) { n = $i; break }
        if (n == 0) { match($0, /[0-9]+/); if (RSTART) n = substr($0, RSTART, RLENGTH) }
        if ($0 ~ /m(in(ute)?s?)?([^a-z]|$)/) n = n * 60
        else if ($0 ~ /h(our)?s?([^a-z]|$)/) n = n * 3600
        print n
      }'
}

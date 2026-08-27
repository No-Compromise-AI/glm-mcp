// review.ts — the review half of the delegate → review loop, as a tool (#65).
//
// bin/glm-review has always owned this prompt, but only a shell can call it;
// Claude, Codex and Antigravity all reach this server, so the prompt lives
// here now or gets hand-rolled three times and drifts three ways. What is
// below is the part of bin/glm-review that must not drift: the verdict
// vocabulary the shell tools grep for, the warnings against the two recorded
// reviewer pathologies, and the substance floor that keeps a bare verdict
// from reading as approval. The server still never runs git — a diff is the
// caller's to supply, exactly as it is the caller's to name files, and for
// the same reason: the trust boundary in confine.ts is built around reading
// files, and shelling out is a different and much larger surface.
import { envLimit } from "./limits.js";

/** The verdicts a review may end with, spelled as bin/glm-review greps them (#65). */
export type Verdict = "PASS" | "CHANGES_REQUIRED";

/**
 * A verdict line: `VERDICT: PASS` or `VERDICT: CHANGES_REQUIRED`, alone on its
 * line, leading and trailing whitespace tolerated. bin/glm-review extracts
 * this exact shape from a reviewer's raw output with
 * `grep -oE '^VERDICT: (PASS|CHANGES_REQUIRED)$'`, so this server has to
 * require the reply to carry it and has to relay it in the same spelling — a
 * verdict the shell tools cannot parse is a review that silently vanishes at
 * the pipeline boundary, which is a caller problem the tool's description
 * promises away.
 */
// The canonical spelling, and deliberately the STRICT one: bin/glm-review
// parses a verdict with `grep -oE '^VERDICT: (PASS|CHANGES_REQUIRED)$'` —
// anchored, exactly one space, no surrounding whitespace. A looser regex here
// would accept `VERDICT:PASS` and hand the shell tools a reply they cannot
// read, which is precisely the drift this tool exists to remove. The two
// spellings must be one spelling.
const VERDICT_LINE = /^VERDICT: (PASS|CHANGES_REQUIRED)$/;

/**
 * The verdict a reply carries, or undefined when it carries none.
 *
 * It must be the FINAL non-blank line, not merely present somewhere. A verdict
 * accepted from the middle of a reply is a verdict that can be accepted from a
 * reply the output cap severed after it — an unfinished review read as a
 * finished one. Trailing blank lines are the model's manners, not its meaning,
 * so they are dropped before the final line is taken.
 */
export function verdictOf(reply: string): Verdict | undefined {
  const lines = reply.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const last = lines[lines.length - 1];
  if (last === undefined) return undefined;
  const m = VERDICT_LINE.exec(last);
  return m ? (m[1] as Verdict) : undefined;
}

/**
 * The analysis behind a reply: its characters with the verdict line(s) taken
 * out and the ends trimmed. This, and nothing the caller sent, is what
 * {@link minSubstance} floors — a floor computed from the prompt or the diff
 * passes every rubber stamp ever written while looking correct, because the
 * request is long in exactly the cases where the reply is bare.
 *
 * Whitespace inside the analysis counts, deliberately. The floor's target is
 * the recorded failure — a reviewer returning a bare 14-byte `VERDICT: PASS`
 * with zero analysis while a real bug was present — and that reply measures
 * 0 however you count. The honest end of the scale is tighter than it looks:
 * the three concrete lines the prompt asks for ("name the file, the symbol,
 * and what breaks") run roughly 230 characters as written and roughly 190
 * with the spaces squeezed out, so a floor that ignored whitespace would
 * start refusing the very review style the prompt demands. The line is drawn
 * between those worlds, not at the prose's density.
 */
export function substanceOf(reply: string): number {
  return reply
    .split("\n")
    .filter((line) => !VERDICT_LINE.test(line))
    .join("\n")
    .trim().length;
}

/**
 * The least analysis a verdict is allowed to stand on (#65):
 * GLM_REVIEW_MIN_SUBSTANCE, default 200 characters — the same knob and the
 * same default as bin/glm-review, so a deployment that tunes one measure has
 * tuned both, and through the same envLimit parsing (#24: a value that does
 * not parse as a positive integer is an absent limit, never a zero one).
 */
export const DEFAULT_MIN_SUBSTANCE = 200;

export function minSubstance(): number {
  return envLimit("GLM_REVIEW_MIN_SUBSTANCE", DEFAULT_MIN_SUBSTANCE);
}

/**
 * The standing instructions every review is sent under (#65). Priorities 1
 * and 2 name this toolchain's two recorded failures, not hypotheticals: an
 * agent that quietly narrows scope while every test still passes, and an
 * agent that ships a polished surface over work that was stubbed, mocked or
 * hardcoded rather than implemented. The instruction NOT to pad is
 * load-bearing in the other direction — a reviewer that manufactures
 * findings to look thorough costs more to disprove than a missed one costs
 * to catch, and the substance floor must not become a reason to invent
 * material to measure.
 */
const INSTRUCTIONS = `Review the change below against the specification it was meant to implement, then finish with a verdict.

Prioritise, in this order:
1. Requirements the specification states or implies that were NOT addressed, or were silently narrowed. Agents pass their own tests while quietly dropping scope — that is the failure mode most worth catching.
2. Fabricated or hollow implementation. Call out anything stubbed, mocked, hardcoded to return a fixed value, wrapped in a permanent TODO, or a test asserting a constant instead of behaviour. An agent that fakes the work and reports success — a polished surface over an implementation that was never written — is the most expensive failure there is; say so loudly if you see it.
3. Test quality. Tests must assert real behaviour against real inputs; a test that restates the implementation, asserts a constant, or exists to make a suite go green is not a test — flag it as such.
4. Correctness bugs. Verify every claim against the material in front of you; do not assume the tests cover it.
5. Practical problems a user of this change would hit.

Report only defects you can point at in the material below. Do not speculate, do not invent findings, and do not pad the list — a fabricated finding costs more to disprove than a missed one costs to catch later. Be concrete: name the file, the symbol, and what breaks. Do not restate what the change does, and do not praise it.

An empty findings list is a legitimate result — but only once the material has actually been examined. End your reply with a final line that is exactly one of:
VERDICT: PASS
VERDICT: CHANGES_REQUIRED`;

export interface ReviewMaterial {
  /**
   * The unified diff under review, as the caller supplied it. The server
   * never generates one (#65): no subprocess, no git, so what the reviewer
   * sees is exactly what the caller chose to show it.
   */
  diff?: string;
  /**
   * What the change was meant to do. Inserted verbatim — it is the caller's
   * own statement of intent, and every transformation of it is a chance for
   * the one sentence that catches silent scope-narrowing to soften on the
   * way through.
   */
  spec?: string;
  /** Assembled file context, built exactly as glm_ask builds its own. */
  fileContext?: string;
}

/**
 * The user prompt of a review: the standing instructions, then the material
 * in the order bin/glm-review presents it — the change, then the spec it was
 * meant to implement, then the surrounding files. A missing spec is named as
 * such rather than dropped, so the reviewer knows it is inferring intent
 * instead of checking it and can say so in its verdict.
 */
export function buildReviewPrompt(material: ReviewMaterial): string {
  const sections: string[] = [];
  if (material.diff?.trim()) {
    sections.push(`--- DIFF (as supplied by the caller) ---\n${material.diff}\n--- END DIFF ---`);
  }
  sections.push(
    `--- SPEC (what the change was meant to do) ---\n${
      material.spec?.length
        ? material.spec
        : "(no written spec supplied; infer the change's intent from the diff itself)"
    }\n--- END SPEC ---`,
  );
  if (material.fileContext?.trim()) {
    sections.push(`--- FILES (surrounding context) ---\n${material.fileContext}\n--- END FILES ---`);
  }
  return `${INSTRUCTIONS}\n\n${sections.join("\n\n")}`;
}

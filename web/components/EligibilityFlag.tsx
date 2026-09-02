import { checkEligibility } from "@core/core/eligibility.js";

/**
 * The posting itself rules the candidate out.
 *
 * Every other check on this page asks whether the FORM was filled correctly. None asked whether he
 * is eligible at all — so a complete, correct, visually-verified application sat here for a Pony.ai
 * role whose own text reads "Currently pursuing a Masters or PhD program", and the candidate found
 * it by reading the description himself.
 *
 * Quotes the posting rather than paraphrasing it, because the judgement is his: employers do
 * sometimes consider a strong undergraduate for a role written for graduates, and that is not a
 * call this code should make silently either way.
 */
export function EligibilityFlag({ description, degree }: { description?: string; degree?: string }) {
  const problems = checkEligibility(description ?? "", { degree });
  if (!problems.length) return null;

  return (
    <div className="card" style={{ marginBottom: 14, borderColor: "var(--bad)", background: "rgba(201,42,42,0.08)" }}>
      <h3 style={{ marginTop: 0, color: "var(--bad)" }}>⚠ This posting asks for a degree the résumé does not show</h3>
      <p style={{ marginTop: 0, marginBottom: 8, fontSize: 14 }}>
        The posting says: <em>&ldquo;{problems[0].quote}&rdquo;</em>
      </p>
      <p className="muted" style={{ marginTop: 0, marginBottom: 0, fontSize: 13 }}>
        The résumé shows {degree ?? "an undergraduate degree"}. Nothing is blocked — an employer may
        still consider a strong undergraduate — but this is worth deciding before it is sent, and
        Skip is right there if it is not worth an application.
      </p>
    </div>
  );
}

import { classifyRoleTerm } from "@core/core/roleTerm.js";

/**
 * A reminder when the posting is NOT the summer internship.
 *
 * The list is built from "Summer 2027" sections, but a title inside one can still be a co-op, a
 * new-grad programme, or an internship in the wrong term — and each is a different decision. A
 * co-op usually means a semester out of classes; a new-grad role cannot be taken while still
 * enrolled. Neither is a fault in the APPLICATION, so this never blocks: it says what it noticed and
 * leaves the call to the person about to make it.
 */
const WORDING: Record<string, { heading: string; note: string }> = {
  "co-op": {
    heading: "This looks like a CO-OP, not a summer internship",
    note: "A co-op is usually a full semester away from classes rather than a summer.",
  },
  "new-grad": {
    heading: "This looks like a NEW-GRAD or full-time role, not an internship",
    note: "A new-graduate posting normally cannot be taken while still enrolled.",
  },
  "off-cycle-internship": {
    heading: "This internship is NOT for the summer",
    note: "The term named in the title is a different one — check it is a term you want.",
  },
  unclear: {
    heading: "The term of this role is not stated",
    note: "Nothing in the title or the opening of the description says which term it is for.",
  },
};

export function RoleTermFlag({ title, description }: { title: string; description?: string }) {
  const verdict = classifyRoleTerm(title, description ?? "");
  if (!verdict.needsAThought) return null;
  const words = WORDING[verdict.term] ?? WORDING.unclear;

  return (
    <div
      className="card"
      style={{ marginBottom: 14, borderColor: "var(--warn, #b8860b)", background: "rgba(184,134,11,0.08)" }}
    >
      <h3 style={{ marginTop: 0, color: "var(--warn, #b8860b)" }}>⚠ {words.heading}</h3>
      <p className="muted" style={{ marginTop: 0, marginBottom: 0, fontSize: 13 }}>
        {words.note} Judged from the posting itself — {verdict.because}. Nothing is blocked: if this
        is a role you want, approve it as usual.
      </p>
    </div>
  );
}

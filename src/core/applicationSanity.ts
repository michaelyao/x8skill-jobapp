import type { DocumentUploads, FieldSpec, FilledAnswer, HistoryOutcome } from "../agent/types.js";
import { checkFacts, type FactProblem, type ResumeFacts } from "./factChecks.js";

/**
 * Is this application, AS A WHOLE, worth putting in front of a human — and worth submitting?
 *
 * Every other guard in this codebase is local. `read()` verifies one field, `fill()` verifies one
 * value, the required-field gate checks the fields the FORM marked required, `compareToApproved`
 * diffs value against value. Not one of them ever asks the question a person asks in a second of
 * looking at the review page: "there is no education on this, why would we send it?"
 *
 * That gap is not theoretical. Workable renders Education and Experience as sections with NO
 * fields in the DOM until "+ Add" is clicked, and labels them "(Optional)". Four applications
 * (ZNSIQU, QBCUGN, EKLOBE, NMVTAA) reached review with the candidate's entire education and work
 * history blank, and every local guard was satisfied — nothing reported false success, no fill was
 * wrong, no required field was skipped. There was simply nothing on the page to check. A
 * field-level guard cannot catch a question that was never rendered.
 *
 * So this checks the APPLICATION, not the form.
 *
 * DELIBERATELY CONSERVATIVE. This can block a real application, so every rule below fires only on
 * positive evidence of a real gap:
 *   - It never demands a section the employer did not ask for. Plenty of Greenhouse and Lever
 *     forms ask for name, email and a resume and nothing else; those are complete as submitted.
 *   - It judges by ANSWERS, not by field count, so a form that gets its education from a resume
 *     parse is fine.
 * A rule that fires on a complete application is worse than the bug it guards, because it stops
 * the pipeline on jobs that were ready.
 */

export interface SanityInput {
  answers: FilledAnswer[];
  observedFields: FieldSpec[];
  /** Did a resume actually get attached this run? */
  resumeAttached: boolean;
  /** Repeatable-history outcome, when the form has such sections. */
  history?: HistoryOutcome;
  /** Which documents went in, and which the form asked for and did not get. */
  documents?: DocumentUploads;
  /** Facts from the resume, so stated answers can be checked against them. */
  facts?: ResumeFacts;
}

export interface SanityProblem {
  /** Stable id, so a caller can whitelist one without parsing prose. */
  code:
    | "education-blank"
    | "experience-blank"
    | "no-resume"
    | "identity-blank"
    | "education-incomplete"
    | "experience-incomplete"
    | "document-missing"
    | "not-on-screen"
    | FactProblem["code"];
  message: string;
}

const EDUCATION = /\b(school|university|college|institution|degree|field of study|major|gpa|graduat|education)\b/i;
// Note "job title"/"current title" but NOT a bare "title": that is also the salutation field
// (Mr/Ms/Dr), and matching it would report every form with an unanswered salutation as having no
// work history — firing on complete applications, the one failure mode this guard must not have.
// Workable's experience section always renders Company alongside Title, so it is still caught.
const EXPERIENCE = /\b(employer|company|job title|work experience|position held|current title|experience)\b/i;
const IDENTITY = /\b(first name|last name|full name|email)\b/i;

/** Labels that merely MENTION a section but are not the section's own content. */
const NOT_CONTENT = /\b(cover letter|summary|headline|why|describe|tell us|how did you hear|referral|source)\b/i;

const isBlank = (value: string | undefined | null): boolean => !value || !String(value).trim();

/**
 * Fields matching `pattern` that the form actually showed, excluding prose fields that merely
 * mention the word ("Tell us about your education" is not an education record).
 */
function sectionFields(fields: FieldSpec[], pattern: RegExp): FieldSpec[] {
  return fields.filter((f) => pattern.test(f.label ?? "") && !NOT_CONTENT.test(f.label ?? ""));
}

/** The answers given for those fields, matched by label. */
function answersFor(answers: FilledAnswer[], fields: FieldSpec[]): FilledAnswer[] {
  const labels = new Set(fields.map((f) => (f.label ?? "").trim().toLowerCase()));
  return answers.filter((a) => labels.has((a.label ?? "").trim().toLowerCase()));
}

export function reviewApplication(input: SanityInput): SanityProblem[] {
  const problems: SanityProblem[] = [];
  const { answers, observedFields, resumeAttached, history, documents, facts } = input;

  /**
   * Are the values TRUE? Every other rule here asks whether fields are filled. A wrong answer is
   * worse than a blank one, because it looks complete and gets believed: live applications went
   * out saying the degree was "Associate's Degree", "Information Systems" and even
   * "Python (Programming Language)", and a GPA of 3.53 reported as the band "3.0-3.5". See
   * factChecks.ts — the checks are anchored on the resume, so they cannot invent a disagreement.
   */
  if (facts) {
    for (const p of checkFacts(answers.map((a) => ({ label: a.label ?? "", value: a.value ?? "" })), facts)) {
      problems.push(p);
    }
  }

  /**
   * A document the form ASKED FOR and did not get. read() excludes file inputs, so this is
   * invisible to every field-level check — a required transcript was simply never uploaded, and
   * nothing anywhere complained.
   */
  for (const m of documents?.missing ?? []) {
    problems.push({ code: "document-missing", message: `the form asks for a document it did not get: ${m}` });
  }

  /**
   * THE STRONGEST RULE, and the reason this file exists: when a form has repeatable history
   * sections, the application must carry the WHOLE history — every degree and every role in the
   * resume — not just the first one.
   *
   * Almost every ATS asks for full education and all work experience, so anything short of that is
   * a defect to investigate, never something to wave through. It is checked against the RESUME
   * rather than against the form, because the form is the thing that was getting it wrong: one
   * uncommitted entry out of seven roles left every on-screen field looking filled, and a
   * field-level check had nothing to complain about. A committed entry's inputs even leave the
   * DOM, so counting fields would have made the emptiest application look like the cleanest one.
   */
  if (history) {
    if (history.educationCommitted < history.educationExpected) {
      problems.push({
        code: "education-incomplete",
        message: `only ${history.educationCommitted} of ${history.educationExpected} education entr${history.educationExpected === 1 ? "y" : "ies"} from the resume went in`,
      });
    }
    if (history.experienceCommitted < history.experienceExpected) {
      problems.push({
        code: "experience-incomplete",
        message: `only ${history.experienceCommitted} of ${history.experienceExpected} work-experience entries from the resume went in`,
      });
    }
    for (const p of history.problems) {
      problems.push({ code: "experience-incomplete", message: p });
    }
  }

  // An application with no resume is not an application. This one is unconditional: every ATS in
  // scope takes one, and it is the document the whole thing is built around.
  if (!resumeAttached) {
    problems.push({ code: "no-resume", message: "no resume was attached" });
  }

  for (const [pattern, code, name] of [
    [EDUCATION, "education-blank", "education"],
    [EXPERIENCE, "experience-blank", "work experience"],
  ] as const) {
    const fields = sectionFields(observedFields, pattern);
    if (fields.length === 0) continue; // the employer never asked — not our business to insist
    const given = answersFor(answers, fields).filter((a) => !isBlank(a.value));
    if (given.length === 0) {
      problems.push({
        code,
        message: `the form asks for ${name} (${fields.length} field(s): ${fields
          .slice(0, 3)
          .map((f) => (f.label ?? "").trim())
          .join(", ")}${fields.length > 3 ? ", …" : ""}) and every one of them is blank`,
      });
    }
  }

  // Name and email blank means we are about to submit an anonymous application.
  const idFields = sectionFields(observedFields, IDENTITY);
  if (idFields.length > 0) {
    const given = answersFor(answers, idFields).filter((a) => !isBlank(a.value));
    if (given.length === 0) {
      problems.push({ code: "identity-blank", message: "name and email are blank" });
    }
  }

  return problems;
}

/** One line for a log or a queue note. */
export function describeProblems(problems: SanityProblem[]): string {
  return problems.map((p) => p.message).join("; ");
}

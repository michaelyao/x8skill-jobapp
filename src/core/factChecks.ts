/**
 * Check what the application SAYS against what the resume says.
 *
 * The rest of the guardrail asks whether fields are filled. These ask whether the filled values
 * are TRUE — which is a different and worse class of failure, because a wrong answer looks
 * complete. Observed on live applications:
 *
 *   Degree                             -> "Python (Programming Language)"     a skill
 *   Degree                             -> "Information Systems"               a field of study
 *   Degree                             -> "Associate's Degree"                the wrong LEVEL
 *   What is your Current Degree Program? -> "Yes"                             not an answer
 *   cumulative GPA                     -> "3.0-3.5"                           excludes the real 3.53
 *
 * A misstated degree level or GPA is a misrepresentation of the candidate on a real application.
 * An empty field costs a re-fill; these get submitted and believed.
 *
 * Pure functions: npm run test:facts.
 */

export type DegreeLevel = "highschool" | "associate" | "bachelor" | "master" | "doctorate";

/**
 * Classify a degree string into a level. Order matters: "Bachelor of Science" contains neither
 * "associate" nor "master", but "Associate of Science" contains "of science", so the level words
 * are matched explicitly rather than by suffix.
 */
export function degreeLevel(text: string): DegreeLevel | undefined {
  const t = ` ${text.toLowerCase().replace(/[.]/g, "")} `;
  if (/\b(ph ?d|phd|doctor|doctorate|dphil)\b/.test(t)) return "doctorate";
  if (/\b(master|masters|ms|msc|meng|mba|ma)\b/.test(t)) return "master";
  if (/\b(bachelor|bachelors|bs|bsc|ba|beng|undergraduate|undergrad)\b/.test(t)) return "bachelor";
  if (/\b(associate|associates|aa|as|aas)\b/.test(t)) return "associate";
  if (/\b(high school|highschool|secondary|diploma|ged)\b/.test(t)) return "highschool";
  return undefined;
}

/** A GPA band as offered by a dropdown: "3.0-3.5", "3.5 or higher", "Above 3.5", "3.0 to 3.5". */
export interface GpaBand {
  min?: number;
  max?: number;
}

export function parseGpaBand(text: string): GpaBand | undefined {
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();
  const range = t.match(/(\d(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d(?:\.\d+)?)/);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const orHigher = t.match(/(\d(?:\.\d+)?)\s*(?:\+|or (?:higher|above|more)|and above)/);
  if (orHigher) return { min: Number(orHigher[1]) };
  const above = t.match(/(?:above|over|greater than|at least|>=?)\s*(\d(?:\.\d+)?)/);
  if (above) return { min: Number(above[1]) };
  const below = t.match(/(?:below|under|less than|<=?)\s*(\d(?:\.\d+)?)/);
  if (below) return { max: Number(below[1]) };
  const exact = t.match(/^(\d(?:\.\d+)?)(?:\s*\/\s*\d(?:\.\d+)?)?$/);
  if (exact) return { min: Number(exact[1]), max: Number(exact[1]) };
  /**
   * A THRESHOLD written as a plain figure on a scale: "3.4 out of 4.0".
   *
   * SpaceX offers `4.0 / 3.7 / 3.4 / 3.0 / Below 3.0 out of 4.0` — a descending ladder where each
   * rung means "at least this". Not one of them parsed, so for a real 3.44 the only option this
   * function could read at all was "Below 3.0 out of 4.0", and the never-overstate rule dutifully
   * picked the one band it had: the answer went onto four questions in one application saying the
   * candidate is below a 3.0. Understating is meant to be a rounding decision a person would
   * defend, not a plainly false one.
   *
   * Read as a floor, which is what the ladder means and what keeps the choice honest: the highest
   * rung at or below the real GPA.
   */
  const outOf = t.match(/^(\d(?:\.\d+)?)\s*(?:out of|of|\/)\s*\d(?:\.\d+)?$/);
  if (outOf) return { min: Number(outOf[1]) };
  return undefined;
}

/**
 * Pick the best of the bands a form actually offers, when none of them contains the GPA.
 *
 * Verkada asks "What is your GPA?*" with `['3.6 - 4.0', '3.1 - 3.5', '3.0 or under']`. A 3.53 sits
 * in the GAP: above 3.1-3.5, below 3.6-4.0. So bandContains rejects all three, the agent picked
 * nothing, and a REQUIRED field went unanswered — which is how that application reached review with
 * no GPA on it at all.
 *
 * The rule is to never OVERSTATE. Of the bands that do not contain the value, prefer the closest one
 * BELOW it (3.1-3.5 for a 3.53) over the closest above (3.6-4.0), because understating a GPA is a
 * rounding decision a person would defend and overstating it is a false claim on a job application.
 * Returns undefined when nothing is defensible, so the caller leaves the field for a human rather
 * than inventing an answer.
 */
export function bestBand(options: string[], gpa: number): string | undefined {
  const parsed = options
    .map((label) => ({ label, band: parseGpaBand(label) }))
    .filter((o): o is { label: string; band: GpaBand } => Boolean(o.band));
  /**
   * Of the bands that DO contain the value, the tightest one — the highest floor.
   *
   * A ladder of thresholds has several containing bands at once: a 3.44 is "at least 3.4" and also
   * "at least 3.0". Taking the first match makes the answer depend on the order the form happens to
   * list them; taking the highest floor is the accurate bucket either way, and still never claims
   * more than the real figure.
   */
  const containing = parsed
    .filter((o) => bandContains(o.band, gpa))
    .sort((a, b) => (b.band.min ?? -Infinity) - (a.band.min ?? -Infinity));
  if (containing.length) return containing[0].label;

  // Nothing contains it. Take the nearest band that lies entirely BELOW the real value.
  const below = parsed
    .filter((o) => o.band.max !== undefined && o.band.max < gpa)
    .sort((a, b) => (b.band.max ?? 0) - (a.band.max ?? 0));
  return below[0]?.label;
}

/** Does the band the form was given actually contain the real GPA? */
export function bandContains(band: GpaBand, gpa: number): boolean {
  // A range is treated as inclusive at both ends. "3.0-3.5" does NOT contain 3.53, which is the
  // whole point: the answer understated a 3.53 and would be read as "below 3.5".
  if (band.min !== undefined && gpa < band.min - 1e-9) return false;
  if (band.max !== undefined && gpa > band.max + 1e-9) return false;
  return true;
}

export interface FactProblem {
  code: "degree-wrong" | "gpa-wrong" | "degree-not-a-degree";
  message: string;
}

export interface ResumeFacts {
  /** e.g. "Bachelor of Science" */
  degree?: string;
  /** e.g. "Information Systems" — a valid answer to "field of study", never to "degree level" */
  fieldOfStudy?: string;
  /** e.g. "3.53" */
  gpa?: string;
}

/** Questions asking which DEGREE (level) — not which subject. */
const DEGREE_QUESTION = /\b(degree|education level|level of education|highest (level of )?education|degree (level|type|program))\b/i;
/** …excluding the ones that ask for the subject, where "Information Systems" is the right answer. */
const SUBJECT_QUESTION = /\b(field of study|discipline|major|subject|concentration|area of study|specialisation|specialization)\b/i;

/**
 * Questions that MENTION a degree but do not ask for its level. Measured against the 50
 * applications already in the queue, where this check produced more false alarms than findings —
 * and a rule that fires on correct answers is worse than the bug it guards, because it blocks
 * applications that were ready.
 *
 * Every pattern here is a real question from a real form, with the answer it was given:
 *   "Do you have, or are you currently pursuing, a college degree?"        -> "Yes"    yes/no
 *   "Degree Type — Undergraduate/Bachelors" (a checkbox group)             -> "Yes"    group option
 *   "Please include your intended graduation year for the degree"          -> "2028"   a year
 *   "For your most recent degree, what is/was your GPA (normalized…)"      -> a GPA, not a level
 * A yes/no or a group option is answered by Yes/No BY DESIGN, so "that is not a degree" is wrong
 * about all of them.
 */
const NOT_A_LEVEL_QUESTION =
  /\b(do you (have|hold)|are you (currently )?(pursuing|enrolled|working)|will you|have you|did you)\b|\b(year|gpa|grade point|when|date)\b|—\s*(undergraduate|bachelor|master|phd|mba)/i;

/**
 * Answers that are a legitimate education LEVEL without naming a degree: US undergraduate class
 * standing. "Junior" is the right answer to "What is your current education level?" and flagging
 * it as "names no degree level" was simply wrong.
 */
const CLASS_STANDING = /^(freshman|sophomore|junior|senior|first|second|third|fourth)[\s-]*(year)?$/i;
const GPA_QUESTION = /\bgpa\b|grade point average|overall result/i;

/**
 * Answers that are not answers. "Yes" was given to "What is your Current Degree Program?" — the
 * agent treated a free-text degree question as a yes/no.
 */
const NON_ANSWER = /^(yes|no|n\/?a|none|true|false)$/i;

export function checkFacts(
  /** `options` is what the field OFFERED, when known — see the GPA rule below. */
  answers: Array<{ label: string; value: string; options?: string[] }>,
  facts: ResumeFacts,
): FactProblem[] {
  const problems: FactProblem[] = [];
  const expected = facts.degree ? degreeLevel(facts.degree) : undefined;

  for (const a of answers) {
    const { label, value } = a;
    const text = (value ?? "").trim();
    if (!text) continue;

    if (DEGREE_QUESTION.test(label) && !SUBJECT_QUESTION.test(label) && !NOT_A_LEVEL_QUESTION.test(label)) {
      if (CLASS_STANDING.test(text)) continue; // "Junior" is a real education level
      if (NON_ANSWER.test(text)) {
        problems.push({
          code: "degree-not-a-degree",
          message: `"${label.trim().slice(0, 60)}" was answered ${JSON.stringify(text)}, which is not a degree`,
        });
        continue;
      }
      const got = degreeLevel(text);
      if (!got) {
        // Names no degree level at all — this is how "Information Systems" and "Python
        // (Programming Language)" got submitted as degrees.
        problems.push({
          code: "degree-not-a-degree",
          message: `"${label.trim().slice(0, 60)}" was answered ${JSON.stringify(text.slice(0, 40))}, which names no degree level (the resume says ${JSON.stringify(facts.degree ?? "?")})`,
        });
      } else if (expected && got !== expected) {
        problems.push({
          code: "degree-wrong",
          message: `"${label.trim().slice(0, 60)}" says ${JSON.stringify(text.slice(0, 40))} (${got}) but the resume says ${JSON.stringify(facts.degree)} (${expected})`,
        });
      }
    }

    /**
     * A GPA stated inside FREE TEXT. The rules below only inspect an answer whose LABEL is a GPA
     * question, so a cover letter reading "Information Systems student at Carnegie Mellon (GPA
     * 3.53)" sails past every one of them — the value is wrong, it is on the application, and
     * nothing was looking at it. Found on ZNSIQU after the GPA changed to 3.44.
     *
     * Anchored on the word GPA so it cannot fire on an unrelated number: a version string, a
     * salary, a date. Prose is LLM-drafted, so it goes stale the moment a fact changes — this is
     * the only check that notices.
     */
    if (facts.gpa && text.length > 40) {
      const real = Number(facts.gpa);
      for (const m of text.matchAll(/\bgpa\b[^\d]{0,12}(\d\.\d{1,2})/gi)) {
        const stated = Number(m[1]);
        if (!Number.isNaN(real) && !Number.isNaN(stated) && Math.abs(stated - real) > 1e-9) {
          problems.push({
            code: "gpa-wrong",
            message: `"${label.trim().slice(0, 50)}" states a GPA of ${m[1]} in its text, but the real GPA is ${facts.gpa}`,
          });
          break; // one report per field is enough
        }
      }
    }

    if (GPA_QUESTION.test(label) && facts.gpa) {
      const real = Number(facts.gpa);
      const band = parseGpaBand(text);
      /**
       * A band that does not contain the GPA is wrong unless it was the best on offer.
       *
       * Two real forms, and the difference between them is the whole rule:
       *   Verkada        3.6-4.0 / 3.1-3.5 / 3.0-or-under   nothing fits a 3.53. Picking 3.1-3.5
       *                                                     understates, and is the honest choice.
       *   Aquatic Capital  …/ 3.5-4.0 / 3.0-3.5 …           3.5-4.0 DOES fit. Answering 3.0-3.5
       *                                                     there was the reported bug.
       * So an understatement is excused only when the field offered nothing better. With no
       * `options` recorded (older entries) the benefit of the doubt goes to the application — this
       * check exists to catch misstatements, not to fail on missing metadata.
       */
      const hadBetter = (a.options ?? []).some((o) => {
        const b2 = parseGpaBand(o);
        return b2 && bandContains(b2, real);
      });
      const understates = band?.max !== undefined && band.max < real;
      const excused = understates && !hadBetter && (a.options?.length ?? 0) > 0;
      if (!Number.isNaN(real) && band && !bandContains(band, real) && !excused) {
        problems.push({
          code: "gpa-wrong",
          message: `"${label.trim().slice(0, 60)}" says ${JSON.stringify(text.slice(0, 30))}, which does not contain the real GPA of ${facts.gpa}`,
        });
      }
    }
  }
  return problems;
}

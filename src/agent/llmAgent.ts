import { listChooserRow } from "../core/listChooser.js";
import { normalizeQuestion } from "../utils/normalize.js";
import { parseResumeHistory } from "../knowledge/resumeHistory.js";
import { bandContains, bestBand, contradictsResume, degreeLevel, parseGpaBand } from "../core/factChecks.js";
import type { Agent, AgentContext, FieldAnswer, FieldSpec, PageSnapshot } from "./types.js";
import { loadSkillPicks } from "../knowledge/skillPlan.js";

// Legal / demographic / compensation fields we must never free-guess. The agent
// may answer these only from curated Q&A or profile data; otherwise it defers to
// a human (needsHuman) and the turn loop routes them to learning mode.
const SENSITIVE =
  /work autho|authoriz|sponsor|visa|citizen|\brace\b|ethnic|hispanic|latino|\bgender\b|\bsex\b|disab|veteran|felony|criminal|conviction|salary|compensation expectation|expected pay|date of birth|social security|\bssn\b/i;

/**
 * Which part of the home address does this field want, if any?
 *
 * NAMES a part; it does not merely mention one. "Are you currently authorized to work in the
 * city/country where this position is located?" contains the word "city", and answering it with
 * "Sunnyvale" is what this function exists to stop — measured on Appian, where a required yes/no
 * question was answered with a city name on three passes in a row and the application stopped.
 *
 * The test is shape, not vocabulary: an address field is a LABEL — short, and not a question. A
 * sentence ending in "?" is asking something; a 70-character label is asking something. Every real
 * address label is a handful of words ("City", "City/Town", "Address Line 1", "Postal Code").
 *
 * Pure: npm run test:address.
 */
export function addressPartFor(
  label: string,
  address: { street: string; city: string; state: string; postal: string },
): string | undefined {
  const raw = label.replace(/[*✱﹡＊]/g, "").trim();
  if (raw.includes("?")) return undefined;
  // Long enough to be prose is long enough to be about something else.
  if (raw.length > 40) return undefined;
  const l = raw.toLowerCase();
  if (/address line ?2|apt|suite|unit\b/.test(l)) return "";
  if (/address line ?1|street address|^address\b/.test(l)) return address.street;
  if (/\bcity\b|town/.test(l)) return address.city;
  if (/\bstate\b|province|region$/.test(l)) return address.state;
  if (/postal code|zip/.test(l)) return address.postal;
  return undefined;
}

export function isSensitive(label: string): boolean {
  return SENSITIVE.test(label);
}

// Self-identification / EEO / disability questions: NEVER auto-answer these —
// always leave them blank for the human to complete, even if curated data exists.
const EEO_SELF_ID =
  /disabilit|impairment|substantially limits|major life activit|\bveteran\b|protected veteran|\brace\b|ethnic|racial|gender identity|how do you identify|sexual orientation|self.?identif|transgender|pronoun/i;

export function isSelfIdentification(label: string): boolean {
  return EEO_SELF_ID.test(label);
}

/** Index just past the last top-level `{...}` that closed, ignoring braces in strings. */
function lastCompleteObjectEnd(text: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) end = i + 1;
    }
  }
  return end;
}

/**
 * Pull the JSON array out of a model reply, tolerating ``` fences and a reply that
 * was cut off mid-array by the token limit. `repaired` means we closed a truncated
 * array and some field answers were lost (the caller logs it — never silent).
 */
export function stripToJson(text: string): { json: string; repaired: boolean } {
  let body = text.trim();
  // Strip an opening fence even when the CLOSING fence never arrived — requiring the
  // pair left a literal "```json" in the payload and lost the whole turn to a parse error.
  const open = body.match(/^```(?:json)?[ \t]*\r?\n?/i);
  if (open) {
    body = body.slice(open[0].length);
    const close = body.lastIndexOf("```");
    if (close >= 0) body = body.slice(0, close);
  } else {
    const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) body = fenced[1];
  }
  const start = body.indexOf("[");
  if (start < 0) return { json: body, repaired: false };
  const end = body.lastIndexOf("]");
  if (end > start) return { json: body.slice(start, end + 1), repaired: false };
  // Array never closed (hit max_tokens mid-answer): keep the objects that arrived
  // whole and close it, so we fill what we got instead of dropping every field.
  const arr = body.slice(start);
  const cut = lastCompleteObjectEnd(arr);
  return cut > 0 ? { json: `${arr.slice(0, cut)}]`, repaired: true } : { json: arr, repaired: false };
}

/** Compact profile summary handed to the LLM as grounding. */
function profileSummary(ctx: AgentContext): string {
  const p = ctx.profile;
  const bits = [
    p.firstName && `First name: ${p.firstName}`,
    p.lastName && `Last name: ${p.lastName}`,
    p.email && `Email: ${p.email}`,
    p.phone && `Phone: ${p.phone}`,
    p.linkedin && `LinkedIn: ${p.linkedin}`,
    p.github && `GitHub: ${p.github}`,
    p.gpa && `GPA: ${p.gpa}`,
    p.school && `School: ${p.school}`,
  ].filter(Boolean);
  return bits.join("\n");
}

/** Companies the candidate has worked for, from the resume's "### Company — ..." headings. */
/**
 * The facts the RESUME states, for checking a stored answer against.
 *
 * Derived from the resume text every time rather than cached: the resume is the authority, and a
 * cached copy is one more place a corrected fact can fail to reach — which is the whole problem this
 * guards against.
 */
function resumeFactsFor(ctx: AgentContext): { degree?: string; fieldOfStudy?: string; gpa?: string } {
  const text = ctx.resumeText || "";
  const edu = parseResumeHistory(text).education[0];
  return { degree: edu?.degree, fieldOfStudy: edu?.fieldOfStudy, gpa: ctx.profile?.gpa ?? edu?.gpa };
}

/**
 * An OPTIONAL cover letter or summary is left blank, deliberately.
 *
 * The candidate's instruction: no cover letter and no summary unless the form requires one. A
 * drafted essay nobody asked for is not a neutral addition — it is several paragraphs of
 * LLM-written prose going to an employer under his name, reviewed less carefully than the fields
 * that matter, and it is where the stale "GPA 3.53" survived longest.
 *
 * REQUIRED ones are still answered: the required-field gate will not pass without them, and an
 * application blocked on a mandatory essay is worse than one that contains it.
 */
const OPTIONAL_PROSE = /\b(cover letter|summary|personal statement|additional information|anything else)\b/i;

/**
 * WHICH OPTION a recorded answer names, in the FORM'S OWN WORDS.
 *
 * A closed list must never be given a value it does not offer — that writes nothing and reports
 * success. But refusing every answer whose wording differs is how "Country Phone Code*" reported
 * "no answer available" 130 times while "United States of America (+1)" sat in the store: the same
 * choice is printed differently from tenant to tenant.
 *
 * So an option the recorded answer UNIQUELY names is adopted, in the option's wording. Uniqueness is
 * the guard — two candidates and it refuses, because picking one would be a guess. Comparison is by
 * whole TOKENS, never raw substring, so "+1" cannot match "+12" and "Verification" cannot match
 * "Formal Verification".
 *
 * The two directions are not symmetrical, and neither is loose.
 *
 * An option may SPELL OUR ANSWER OUT — "United States of America" -> "United States of America
 * (+1)" — but only as a PREFIX. An arbitrary infix would let a recorded "Verification" adopt an
 * offered "Formal Verification", quietly upgrading the claim, which is the same mistake the skills
 * rule refuses to make in the other direction.
 *
 * The reverse — our answer CONTAINING the option — is allowed only when the option carries a digit
 * or a "+", i.e. it is a code and not a word. Otherwise a stored "none — no extension" would adopt
 * the "No" row of a yes/no list.
 */
export type OptionMatch =
  | { kind: "exact"; option: string }
  | { kind: "reworded"; option: string }
  | { kind: "ambiguous"; among: number }
  | { kind: "absent" };

export function optionForRecorded(options: string[], value: string): OptionMatch {
  const foldOpt = (t: string) => t.toLowerCase().replace(/[^a-z0-9+]+/g, " ").replace(/\s+/g, " ").trim();
  const toks = (t: string) => foldOpt(t).split(" ").filter(Boolean);
  /** The option begins with our answer, token for token. */
  const spellsOut = (option: string, answer: string) => {
    const a = toks(option);
    const b = toks(answer);
    return b.length > 0 && b.length <= a.length && b.every((w, i) => a[i] === w);
  };
  /** Our answer contains the option as a run of whole tokens. */
  const holdsRun = (answer: string, option: string) => {
    const a = toks(answer);
    const b = toks(option);
    if (!b.length || b.length > a.length) return false;
    return a.some((_, i) => b.every((w, j) => a[i + j] === w));
  };
  const lv = value.trim().toLowerCase();
  const lead = (o: string) => o.split(/[,(:—–-]/)[0].trim().toLowerCase();

  const exact = options.find((o) => o.toLowerCase() === lv || lead(o) === lv);
  if (exact) return { kind: "exact", option: exact };
  if (!foldOpt(value)) return { kind: "absent" };

  const isCode = (o: string) => /[0-9+]/.test(o);
  const near = options.filter(
    (o) => foldOpt(o) && (spellsOut(o, value) || (isCode(o) && holdsRun(value, o))),
  );
  if (near.length === 1) return { kind: "reworded", option: near[0] };
  if (near.length > 1) return { kind: "ambiguous", among: near.length };
  return { kind: "absent" };
}

/**
 * Is this the country DIALLING CODE beside a phone number?
 *
 * The worst field in the log — 130 runs reported no answer for it — and part of the reason is that
 * every tenant spells it differently: "Country Phone Code", "Country / Territory Phone Code",
 * "Phone Country Code". The answer store holds one wording, so a variant misses and a REQUIRED
 * field stays empty, which on Workday means Save and Continue does nothing and the run stops.
 * Michelin stopped exactly there after filling twelve fields correctly.
 *
 * Deliberately narrow: it must mention a phone AND a code. "Country / Territory" on its own is the
 * country field, which is a different question with a different answer.
 */
/** Does skill.txt actually name anything to add? Cached so the check costs one read per run. */
let skillPlanKnown: boolean | undefined;
async function hasSkillPlan(): Promise<boolean> {
  if (skillPlanKnown === undefined) {
    skillPlanKnown = (await loadSkillPicks().catch(() => [])).length > 0;
  }
  return skillPlanKnown;
}

/**
 * The recorded answer for a field, allowing for the PREFIX our own reader adds.
 *
 * read() qualifies labels with the block they came from — "Education — Field of Study", "Work
 * Experience 3 — Month" — because a bare "Month" is unanswerable. The store holds the bare
 * question. An exact-only lookup therefore missed, and the model answered instead: Field of Study
 * was filled "Management Information System", derived from the resume's "BS Information Systems",
 * while the store held "Computer and Information Science" all along. The candidate had to say so
 * three times.
 *
 * The tail after the last em-dash IS the question, because we are the ones who put the prefix
 * there. Exported so the labels this has failed on are a test rather than a promise.
 */
export function storedAnswerFor<T extends { normalizedQuestion: string }>(
  answers: readonly T[],
  label: string,
): T | undefined {
  const exact = answers.find((entry) => entry.normalizedQuestion === normalizeQuestion(label));
  if (exact) return exact;
  const tail = label.split(/\s+[—–]\s+/).pop() ?? label;
  const byTail = tail === label
    ? undefined
    : answers.find((entry) => entry.normalizedQuestion === normalizeQuestion(tail));
  if (byTail) return byTail;

  /**
   * A MAJOR IS A FIELD OF STUDY, and the store files it under one name.
   *
   * Michelin asks "What is your current major?". The record is "Field of Study" ->
   * "Computer and Information Science", nothing matched, so the model answered "Information
   * Systems Technology" — which the do-not-invent rule then refused, correctly, leaving the
   * question blank on a finished application. Refusing a guess is right; not finding the answer
   * we already have is not, and between them the field went unanswered twice.
   *
   * Only for the questions whose answer is a record anyway (mustComeFromRecords), and only in
   * ONE direction: a question asking for the major/discipline/programme may read the recorded
   * field of study. It never invents a value and never rewrites the record.
   */
  for (const [asks, recordedAs] of STORE_ALIASES) {
    if (!asks.test(label)) continue;
    const aliased = answers.find((entry) => entry.normalizedQuestion === normalizeQuestion(recordedAs));
    if (aliased) return aliased;
  }
  return undefined;
}

/** Questions the store files under a different name. Narrow on purpose — see storedAnswerFor. */
const STORE_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(current\s+)?major\b|field of study|program of study|course of study|\bdiscipline\b/i, "Field of Study"],
];

/**
 * Questions whose answer is a RECORD, not a judgement.
 *
 * "Do NOT invent degree or field of study." The model filled Field of Study with "Management
 * Information System", inferred from the resume's "BS Information Systems", when the recorded
 * answer is "Computer and Information Science" — a real taxonomy entry the candidate chose. An
 * invented degree or major on an application is a false statement about someone's education, and
 * it is indistinguishable on the page from a true one.
 *
 * So for these, a recorded or resume-derived answer is used and anything else is refused. Left
 * empty, the field is reported as unanswered, which is a question the candidate can settle in
 * seconds; filled with a guess, nobody ever finds out.
 */
const RECORDED_FACT_ONLY = /\b(degree|field of study|major|discipline|program of study|course of study)\b/i;

/**
 * WORK AUTHORISATION AS A SENTENCE, NOT A YES/NO.
 *
 * General Matter asks "Are you legally authorized to work in the United States?*" and offers five
 * sentences, none of them "Yes":
 *
 *   I am authorized to work in the United States for any employer
 *   I am authorized to work in the United States for my present employer only
 *   I require sponsorship to work in the United States
 *   I am not authorized to work in the United States
 *   My status to work in the United States in unknown
 *
 * The record says authorized: Yes and sponsorship: No (a US citizen). "Yes" matches nothing, so a
 * REQUIRED field stayed empty and the application was refused — twice.
 *
 * Both halves of the record are needed to choose: authorised AND needing no sponsorship is what
 * "for any employer" says. This derives the option from records; it never guesses. "not
 * authorized", "present employer only" and "unknown" are never chosen from an authorised record,
 * and anything ambiguous returns nothing so the field is reported rather than filled.
 */
export function workAuthorizationOption(
  options: readonly string[],
  records: { authorized?: boolean; needsSponsorship?: boolean },
): { option: string; why: string } | undefined {
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  const has = (t: string, re: RegExp) => re.test(norm(t));
  const pick = (cands: readonly string[], why: string) =>
    cands.length === 1 ? { option: cands[0], why } : undefined;

  if (records.needsSponsorship === true) {
    return pick(options.filter((o) => has(o, /require\w*\s+(a\s+)?(visa\s+)?sponsor/)), "the record says sponsorship is required");
  }
  if (records.authorized === false) {
    return pick(options.filter((o) => has(o, /\bnot authoriz/)), "the record says not authorised");
  }
  if (records.authorized !== true) return undefined;

  const disqualified = (o: string) =>
    has(o, /\bnot authoriz|unknown|present employer only|require\w*\s+(a\s+)?(visa\s+)?sponsor/);
  const anyEmployer = options.filter((o) => has(o, /authoriz/) && has(o, /any employer/) && !disqualified(o));
  if (anyEmployer.length === 1) {
    return { option: anyEmployer[0], why: "authorised, and the record needs no sponsorship" };
  }
  return pick(options.filter((o) => has(o, /authoriz/) && !disqualified(o)), "the only option that says authorised");
}

/**
 * The two records that decide a work-authorisation answer, or undefined when the question is not
 * one. One helper, because three separate branches in this file accept a recorded answer and the
 * fill needs these facts whichever of them ran.
 */
function workAuthorizationRecords(
  label: string,
  value: string,
  ctx: AgentContext,
): { authorized?: boolean; needsSponsorship?: boolean } | undefined {
  if (!/authoriz|authoris/i.test(label) || !/\bwork\b/i.test(label)) return undefined;
  const sponsor =
    storedAnswerFor(ctx.answers, "Do you require sponsorship for employment visa status?") ??
    storedAnswerFor(ctx.answers, "Will you now or in the future require visa sponsorship?");
  return {
    authorized: /^\s*y(es)?\b/i.test(value),
    needsSponsorship: sponsor ? /^\s*y(es)?\b/i.test(String(sponsor.answer)) : undefined,
  };
}

/**
 * The options a decision can actually be made against.
 *
 * A Workday taxonomy sometimes opens on a CHOOSER — "Partial List (First 500 Entries)" and "All" —
 * and read() reports those two rows as the field's options. They are not answers. Intel's
 * "Education — Field of Study*" was refused on exactly that basis: the recorded "Computer and
 * Information Science" "is not one of them", so nothing was answered, so the fill never ran, so
 * the code that clicks THROUGH the chooser never got a chance. The list is unknown here, not
 * wrong, and unknown is what this returns.
 */
function usableOptions(options?: string[]): string[] | undefined {
  if (!options?.length) return undefined;
  return listChooserRow(options) ? undefined : options;
}

export function mustComeFromRecords(label: string): boolean {
  /**
   * A GPA QUESTION IS NOT A DEGREE QUESTION, even when it mentions one.
   *
   * Michelin asks "What is your cumulative GPA for your 4 year DEGREE on a 4.0 scale?". That word
   * put the question under this rule, so the correctly computed band — "Between 3.00 and 3.49" for
   * a 3.44 — was refused as an invented degree and the field was left alone. It was not empty: it
   * held "Below 2.60" from an earlier draft, so the refusal PRESERVED the false answer the whole
   * fix was for, and the candidate found it on the live form again.
   *
   * A band is not a guess. bestBand derives it arithmetically from the recorded GPA, and checkFacts
   * refuses any band that does not contain that GPA — a stronger guarantee than "appears verbatim
   * in the records", which is all this rule can offer.
   */
  if (/\bgpa\b|grade point average|overall result/i.test(label)) return false;

  /**
   * THE RULE IS ABOUT QUESTIONS WHOSE ANSWER IS A DEGREE — not every question containing the word.
   *
   * Matching on the word alone refused three correct answers on one General Matter application,
   * two of them REQUIRED, and left the fields blank:
   *
   *   "Degree*"                                        -> "Bachelor's Degree"  (the record's own wording)
   *   "Do you have, or are you currently pursuing …"    -> "Yes"
   *   "What year do you intend to complete your …"      -> "2028"
   *
   * A yes/no and a year are not degree names, and no record could ever be quoted for them
   * verbatim, so the rule could only ever blank them. It applies when the field is ASKING FOR the
   * name of a degree or a field of study.
   */
  if (/^(do|does|did|are|is|was|were|have|has|had|will|would|can|could|should|may|must)\b/i.test(label.trim())) {
    return false;
  }
  if (/\b(what|which)\s+year\b|\bwhen\b|graduation (date|year)|expected (graduation|completion)|complete your/i.test(label)) {
    return false;
  }
  return RECORDED_FACT_ONLY.test(label);
}

/**
 * Which "areas of interest" to tick, when a form offers a list and says select all that apply.
 *
 * The candidate's rule: software-engineering related, and RESEARCH AND DEVELOPMENT counts. He is
 * applying for software internships, so the answer is not a judgement the model should be making
 * fresh on each tenant — one form's "Software Engineering / Data Science / R&D / Marketing /
 * Finance" is the same question as the next one's, worded differently.
 *
 * Hardware is deliberately NOT included, and that is the same standing guardrail that keeps
 * firmware and embedded roles out of the job list: those are not suitable, so ticking them here
 * would invite exactly the interview this system is supposed to avoid.
 */
const SOFTWARE_INTEREST =
  /software|computer scien|computer engineer|information technolog|\bIT\b|web|cloud|data (scien|engineer|analyt)|machine learning|artificial intelligence|\bAI\b|cyber ?security|research and development|\bR&D\b|application develop|programming/i;

const NOT_SOFTWARE_INTEREST =
  /hardware|firmware|embedded|mechanic|electric|civil|chemical|industrial design|manufactur|supply chain|marketing|sales|finance|accounting|human resource|legal|communications|graphic design/i;

export function softwareInterests(options: readonly string[]): string[] {
  return options.filter((o) => SOFTWARE_INTEREST.test(o) && !NOT_SOFTWARE_INTEREST.test(o));
}

/** Is this the "what are you interested in" question? */
export function isAreasOfInterest(label: string): boolean {
  return /\b(area|areas|field|fields|discipline|function|department|team)s?\b/i.test(label) &&
    /\binterest(ed|s)?\b/i.test(label);
}

/**
 * "How did you hear about us?" — the whole preference ladder, not just its top rung.
 *
 * The standing order is university > company's own site > job board > referral > social > other,
 * and the candidate has confirmed CAREER WEBSITES is fine. The rule only ever looked for a
 * campus-ish option and gave up when there was none, so a form offering "Career Websites |
 * Employee Referral | Job Board | Social Media" got nothing from the rule and the model answered
 * instead — which is how "LinkedIn" came to be typed at a tenant whose list does not contain it.
 *
 * Every rung matches on the FORM'S wording, and anything unmatched is left alone: an option we
 * cannot classify is not one to pick blind.
 */
const HEAR_ABOUT_LADDER: ReadonlyArray<{ why: string; test: RegExp; under?: RegExp }> = [
  /**
   * THE CANDIDATE'S ORDER: Handshake, then a campus event, then LinkedIn.
   *
   * Handshake is where he actually finds these roles, and it is normally on the list — but as a
   * CHILD of "Job Board", the same way LinkedIn is a child of "Social Media". `under` names the
   * tier-one row to open when the child is not already showing, which is what turns this from a
   * preference into something the fill can act on.
   */
  { why: "Handshake, where these roles are found", test: /handshake/i, under: /job board|job site|jobs? board/i },
  { why: "a campus event", test: /campus|university|college|career (fair|center)|school|student/i },
  { why: "LinkedIn", test: /linked\s?in/i, under: /social/i },
  // Below here the order is unchanged: it is what to do when none of the three above is offered.
  {
    why: "the company's own site",
    // Plurals and "page" included: "Our Careers Website" fell through this rung to SOCIAL MEDIA,
    // because "career ?(web)?site" cannot span the "s" in "Careers".
    test: /careers?\s*(web)?\s*(site|page)|compan(y|ies)\s*(web)?site|our\s*(web)?site|corporate\s*site/i,
  },
  { why: "a job board", test: /job board|indeed|glassdoor|simplify/i },
  { why: "a referral", test: /referral|employee refer|friend|colleague/i },
  { why: "social media", test: /social|twitter|facebook|instagram|tiktok|youtube/i },
  { why: "other", test: /other/i },
];

/**
 * What to do with the options this prompt is showing: pick one, or open a tier-one row to reach
 * the child we would rather have.
 *
 * Returned as a plan rather than an option because the decision needs the tree, and the tree is
 * only visible where the menu is open. "Expand" is always CONFIRMED by re-reading — a parent that
 * opens nothing must not look like a choice.
 */
export type HearAboutPlan =
  | { kind: "pick"; option: string; why: string }
  | { kind: "expand"; parent: string; want: RegExp; why: string };

export function hearAboutUsPlan(options: readonly string[]): HearAboutPlan | undefined {
  const visible = options.filter((o) => o && !/^select one$|^no items/i.test(o));
  for (const rung of HEAR_ABOUT_LADDER) {
    const hit = visible.find((o) => rung.test.test(o));
    if (hit) return { kind: "pick", option: hit, why: rung.why };
    if (!rung.under) continue;
    const parent = visible.find((o) => rung.under!.test(o));
    if (parent) return { kind: "expand", parent, want: rung.test, why: rung.why };
  }
  return undefined;
}

export function preferredHearAboutUs(
  options: readonly string[],
): { option: string; why: string } | undefined {
  for (const rung of HEAR_ABOUT_LADDER) {
    const hit = options.find((o) => rung.test.test(o));
    if (hit) return { option: hit, why: rung.why };
  }
  return undefined;
}

export function isPhoneCountryCode(label: string): boolean {
  const l = label.toLowerCase();
  if (!/\bcode\b/.test(l)) return false;
  if (!/phone|dial|mobile|telephone/.test(l)) return false;
  return /country|territory/.test(l);
}

export function skipAsOptionalProse(label: string, required: boolean): boolean {
  return !required && OPTIONAL_PROSE.test(label ?? "");
}

export function extractEmployers(resumeText: string): string[] {
  const employers: string[] = [];
  for (const m of resumeText.matchAll(/^#{2,4}\s+(.+?)\s+[—–-]\s+/gm)) {
    const name = m[1].trim();
    if (name && !/education|skills|work experience|award/i.test(name)) employers.push(name);
  }
  return [...new Set(employers)];
}

function curatedSummary(ctx: AgentContext): string {
  return ctx.answers
    .map((a) => `Q: ${a.question}\nA: ${Array.isArray(a.answer) ? a.answer.join(", ") : a.answer}`)
    .join("\n\n");
}

/**
 * Today, in the LOCAL timezone, as the form expects it. A self-identification page rejected an
 * application with "Enter today's date" because the model guessed — and after 5pm Pacific its
 * guess was the UTC date, one day ahead. Never derive this from toISOString().
 */
function localToday(): { iso: string; month: string; day: string; year: string; long: string } {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const year = String(now.getFullYear());
  return {
    iso: `${year}-${month}-${day}`,
    month,
    day,
    year,
    long: now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
  };
}

function buildPrompt(snapshot: PageSnapshot, ctx: AgentContext): { system: string; user: string } {
  const today = localToday();
  const system = [
    "You are filling a job application form on behalf of a candidate.",
    `TODAY IS ${today.long} (${today.iso}) — month ${today.month}, day ${today.day}, year ${today.year}.`,
    `- Any field asking for today's date, the date signed, or the date of completion takes exactly that date: ${today.month}/${today.day}/${today.year}. When it is split into Month / Day / Year sub-fields, answer each with "${today.month}", "${today.day}" and "${today.year}" respectively. Do not compute it yourself and never use a different timezone's date — the form validates it against its own clock.`,
    "For each field, produce the best answer grounded ONLY in the candidate's resume, profile, and curated Q&A provided.",
    "Rules:",
    "- Never invent facts (names, numbers, employers, dates) not supported by the provided data.",
    "- For select/radio fields, the value MUST be exactly one of the given options.",
    '- EXCEPTION — a field with "searchableTypeahead": true is a type-to-search box whose "optionsSample" is only the first few of thousands of choices (e.g. every university in the world). Answer with the candidate\'s REAL value (their actual school, city, employer) even when it does not appear in the sample, and do NOT set needsHuman merely because it is missing from the sample. The value is matched against the live filtered list when it is entered.',
    '- For a searchableTypeahead you MAY answer with two or three comma-separated alternatives, ordered most specific first: "Python, Computer Science". Each is tried against the live list and the first one the list actually offers is selected. Use this when you cannot tell how the list names things — the "optionsSample" shows its vocabulary and granularity, so if the sample reads "Accounting, Actuarial Science, Aerospace Engineering" a broader field belongs in your list as well as the specific skill. Never leave a skills or field-of-study box unanswered because you are unsure of the exact wording.',
    "- For checkboxes, value is 'Yes' or 'No'.",
    '- ANSWER LENGTH: if a question can be answered Yes or No, answer exactly "Yes" or "No" — nothing more. This holds even when the question is three lines long, even when the input is a big text box, and even when you could justify the answer. "Yes, I am fully willing and able to relocate… I have previous experience doing exactly this…" is padding: it reads as machine-written and a human reviewer has to delete it. Keep every factual answer as short as the question allows.',
    '- ROLE DESCRIPTION / responsibilities boxes inside a work-experience row take BULLETS, not a paragraph. One bullet per accomplishment, each starting "- ", newline between them, taken from the resume bullets for THAT employer and kept in the resume\'s own words. Merging them into flowing prose ("Developed X, eliminating the manual review process and saving each team member ~2 hours per week. Built Y…") is harder to read than the resume it came from and reads as machine-written. Never invent a bullet the resume does not have.',
    "- OPEN-ENDED free-text fields (e.g. 'Why do you want to work here?', 'Tell us about yourself', cover letter, 'What interests you'): DRAFT a concise, specific, first-person answer (~80-150 words) grounded in the candidate's real resume experience and the job description. Set draft=true, needsHuman=false, confidence around 0.7. Do not fabricate experience — only use what's in the resume.",
    "- SENSITIVE fields (work authorization, sponsorship, citizenship, demographics, disability, veteran, criminal history, salary, DOB, SSN): answer ONLY if the curated Q&A or profile clearly provides it; otherwise set needsHuman=true and leave value empty. Never guess these.",
    "- For factual fields (name, email, phone, school, dates): use the provided data. If it is genuinely absent, set needsHuman=true and leave value empty — do NOT guess.",
    '- If an OPTIONAL field asks for something the candidate simply does not have (a phone extension, a middle name, a second address, a portfolio they lack), the correct answer is EMPTY: set "blank": true with an empty value and needsHuman=false. Do not set needsHuman for these — nothing needs to be asked, there is genuinely nothing to enter.',
    "- WORK EXPERIENCE BLOCKS: the form usually has fewer blocks than the candidate has positions. Fill them in the order listed above — the FIRST block takes position 1 (most recent), the second block position 2, and so on. Never put an older position in the first block: a form with a single block must get the most recent role, not the oldest. Keep each block internally consistent — the title, employer, location and dates in one block must all belong to the SAME position.",
    "- For 'have you previously worked for X / are you a former employee of X / do you work for X' questions: answer Yes ONLY if X (or its parent/subsidiary) appears in the candidate's Employment history below; otherwise No. Do NOT rely on any generic curated answer for this.",
    // Michelin asks "Have you already done a Co-Op or Internship term with Michelin?" and left it
    // unanswered on three runs: the rule above covers "worked for", and an internship term with a
    // company is the same question about the same records. The employment history is the whole
    // answer — it lists seven employers and Michelin is not among them — so this is a fact we
    // hold, not a guess, and leaving it blank was the wrong kind of caution.
    "- The same applies to 'have you already done a co-op / internship / placement / apprenticeship with X', 'have you interned here before', 'are you a returning intern': answer Yes ONLY if X appears in the Employment history below; otherwise No.",
    "- Do NOT answer or reference any submit button.",
    'Respond with ONLY a JSON array: [{"key":"...","value":"...","confidence":0.0-1.0,"needsHuman":false,"draft":false,"blank":false,"reasoning":"short"}]. One object per field, using the exact keys given.',
  ].join("\n");

  const fieldsForLlm = snapshot.fields.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    required: f.required,
    // A type-to-filter combobox only reveals a slice of its choices before you type
    // (Greenhouse's School field: 100 entries starting at "Aalborg University"). Passing
    // that slice as `options` made the model obey the "must be exactly one of the given
    // options" rule and defer the field as needsHuman whenever the real answer wasn't in
    // the slice — which silently blocked the whole job. Send it as a labelled sample.
    ...(f.searchable ? { searchableTypeahead: true, optionsSample: f.options?.slice(0, 10) } : { options: f.options }),
    sensitive: f.sensitive ?? isSensitive(f.label),
  }));

  const user = [
    `Company: ${ctx.company}`,
    `Role: ${ctx.title}`,
    ctx.changeInstruction
      ? `\n*** USER CORRECTION (highest priority — the user reviewed a prior draft and asked for these changes; apply them exactly, overriding any conflicting default): ***\n${ctx.changeInstruction}`
      : "",
    ctx.jobDescription ? `\nJob description (context):\n${ctx.jobDescription.slice(0, 3000)}` : "",
    `\nCandidate profile:\n${profileSummary(ctx)}`,
    `\nEmployment history, MOST RECENT FIRST (the resume's order — position 1 is the current/latest role):\n${
      extractEmployers(ctx.resumeText)
        .map((name, i) => `  ${i + 1}. ${name}`)
        .join("\n") || "  (none parsed)"
    }`,
    `\nCandidate resume:\n${ctx.resumeText.slice(0, 6000)}`,
    ctx.answers.length ? `\nCurated Q&A (authoritative, especially for sensitive fields):\n${curatedSummary(ctx)}` : "",
    `\nFields to answer (JSON):\n${JSON.stringify(fieldsForLlm, null, 2)}`,
  ]
    .filter(Boolean)
    .join("\n");

  return { system, user };
}

async function callAirouter(system: string, user: string): Promise<string> {
  const endpoint = process.env.AIROUTER_API_ENDPOINT;
  const key = process.env.AIROUTER_API_KEY;
  const model = process.env.AIROUTER_MODEL_NAME || "sonnet";
  if (!endpoint || !key) throw new Error("AIROUTER not configured");
  const res = await fetch(`${endpoint.replace(/\/+$/, "")}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    // 2048 truncated mid-array on 20+ field pages (each drafted free-text answer runs
    // ~150 words), which used to lose every answer in the turn to a parse error.
    body: JSON.stringify({ model, max_tokens: 8192, system, messages: [{ role: "user", content: user }] }),
    // 120s aborted on 64-field pages (CTC), dropping us to the weaker fallback for no
    // reason — a big field list with drafted free-text legitimately takes longer.
    signal: AbortSignal.timeout(240000),
  });
  if (!res.ok) throw new Error(`AIROUTER HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { content?: Array<{ text?: string }> };
  const text = (json.content || []).map((c) => c.text || "").join("");
  if (!text) throw new Error("AIROUTER returned empty content");
  return text;
}

async function callGemini(system: string, user: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not configured");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: user }] }],
        // gemini-2.5-flash reasons by default and charges that against maxOutputTokens,
        // so on a 64-field page it burned the whole budget thinking and returned just
        // "```json" with no array at all. Reasoning off, and a budget big enough for a
        // long field list.
        generationConfig: { temperature: 0.2, maxOutputTokens: 16384, thinkingConfig: { thinkingBudget: 0 } },
      }),
      signal: AbortSignal.timeout(120000),
    },
  );
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) throw new Error("Gemini returned empty content");
  return text;
}

/** LLM-primary agent: AIROUTER first, Gemini as backup, with sensitive guardrails. */
export class LlmAgent implements Agent {
  async decide(snapshot: PageSnapshot, ctx: AgentContext): Promise<FieldAnswer[]> {
    if (snapshot.fields.length === 0) return [];
    const { system, user } = buildPrompt(snapshot, ctx);

    let raw: string;
    let provider: string;
    try {
      raw = await callAirouter(system, user);
      provider = "airouter";
    } catch (airouterError) {
      console.warn(`  [agent] AIROUTER failed (${(airouterError as Error).message}); falling back to Gemini.`);
      raw = await callGemini(system, user);
      provider = "gemini";
    }

    let parsed: Array<Partial<FieldAnswer>>;
    let { json, repaired } = stripToJson(raw);
    try {
      parsed = JSON.parse(json);
    } catch {
      // One bad reply must not cost the whole application. Fannie Mae PTPDDZ died exactly here:
      // the model returned an opening fence and nothing after it, so stripToJson correctly
      // produced "" and JSON.parse threw — with 17 required fields still pending and two retry
      // passes unused. The exception also unwound past the ledger write, so the job left no
      // record at all: not in the queue, not in applications.json, only a line in the log.
      //
      // So: ask once more, then degrade to "no answers this turn". The turn loop already knows
      // what to do with that — re-read, retry the stragglers, and if a required field is still
      // empty STOP and report blockedRequired. That is a diagnosable outcome with a ledger entry
      // behind it. An exception is not.
      console.warn(
        `  [agent] ${provider} reply was not JSON (${raw.trim().length} char(s): ${JSON.stringify(raw.slice(0, 120))}) — asking once more.`,
      );
      try {
        raw = provider === "airouter" ? await callAirouter(system, user) : await callGemini(system, user);
        ({ json, repaired } = stripToJson(raw));
        parsed = JSON.parse(json);
      } catch {
        console.warn(
          `  [agent] ${provider} still did not return JSON — leaving this turn's ${snapshot.fields.length} field(s) unanswered for the retry pass.`,
        );
        return [];
      }
    }
    if (repaired) {
      console.warn(
        `  [agent] ${provider} reply was cut off mid-array — recovered ${parsed.length} of ${snapshot.fields.length} field answer(s); the rest fall to the retry pass.`,
      );
    }

    const byKey = new Map(snapshot.fields.map((f) => [f.key, f]));
    const answers: FieldAnswer[] = [];
    for (const item of parsed) {
      const field = item.key != null ? byKey.get(String(item.key)) : undefined;
      if (!field) continue;
      let value = item.value == null ? "" : String(item.value);
      let needsHuman = Boolean(item.needsHuman);
      let confidence = typeof item.confidence === "number" ? item.confidence : 0;
      const draft = Boolean(item.draft);
      const blank = Boolean(item.blank);

      // Guardrail: sensitive/EEO fields (work-auth, sponsorship, gender, race,
      // veteran, disability, salary) are answered ONLY from the curated Q&A /
      // profile — never fabricated. If the model returned no grounded value,
      // defer to the human rather than guess.
      if ((field.sensitive ?? isSensitive(field.label)) && !value) {
        needsHuman = true;
        confidence = 0;
      }
      // Guardrail: a bare "Yes"/"No" in a FREE-TEXT field is almost always a yes/no
      // curated answer bleeding into a question that wants real content — e.g. the
      // curated "Do you have a preferred name? → No" landing in Lever's text field
      // "Preferred Name | What would you like us to call you?", which then submits the
      // literal word "No" as the candidate's name. Only accept it when the label
      // actually reads as a yes/no question (auxiliary-verb opener, or an "if yes/no"
      // follow-up); otherwise defer rather than write nonsense into the application.
      if ((field.type === "text" || field.type === "textarea") && /^(yes|no)\.?$/i.test(value.trim())) {
        // The auxiliary verb is not always at the front. Workday numbers its questions and
        // front-loads a condition — "5. If selected for an internship position, are you willing
        // and able to relocate…" — which an anchored test reads as free text, so a correct "Yes"
        // was thrown away and the required field blocked the whole run.
        const label = field.label.toLowerCase().replace(/^\s*(?:q\s*)?\d{1,2}\s*[.)\-:]\s*/i, "");
        // "Why do you want to work here?" contains "do you" and is emphatically not a yes/no
        // question. An opener that demands an explanation wins over any auxiliary verb later.
        const wantsProse = /^(why|how|what|which|when|where|who|describe|tell|explain|elaborate|list|share|walk)\b/.test(label);
        const yesNoQuestion =
          !wantsProse &&
          (/^(do|does|did|are|is|was|were|have|has|had|will|would|can|could|should|may|must|shall)\b/.test(label) ||
          /\b(are|is|was|were|do|does|did|have|has|had|will|would|can|could|should)\s+(you|your|there|the candidate)\b/.test(label) ||
          /\b(willing|able|authoriz|eligible|require sponsorship|consent|agree)\b/.test(label) ||
          /\(\s*yes\s*\/\s*no\s*\)/.test(label) ||
          /\bif (yes|no)\b/.test(label));
        if (!yesNoQuestion) {
          console.warn(`  [agent] ignoring bare "${value.trim()}" for free-text field "${field.label.slice(0, 60)}" — needs a real answer.`);
          needsHuman = true;
          value = "";
          confidence = 0;
        }
      }

      // Guardrail: select value must map to a real option. Accept an exact match,
      // or the answer as the option's leading token before a comma/paren/dash — so
      // curated "No" maps to "No, I don't have a disability" — without loose
      // substring matches (e.g. "No" ✗ "Now employed"). Otherwise defer.
      if (field.options && field.options.length && value) {
        const lv = value.trim().toLowerCase();
        const lead = (o: string) => o.split(/[,(:—–-]/)[0].trim().toLowerCase();
        const match =
          field.options.find((o) => o.toLowerCase() === lv) ||
          field.options.find((o) => lead(o) === lv) ||
          field.options.find((o) => lv.length >= 4 && o.toLowerCase().includes(lv));
        if (!match) {
          // A type-to-filter combobox (School / Discipline typeahead) exposed only an
          // async slice of its options, so "no match" here means "not in the sample",
          // not "not a real option". Keep the value: fillReactSelect types to filter
          // and can ONLY click an option that actually exists, so a bad value fails
          // loudly at fill time instead of being silently skipped as needsHuman.
          // "How did you hear about us?" is a closed list that every tenant words differently:
          // one offers LinkedIn, the next offers "Campus/University | Job Board/Website |
          // EMEAInternetJobSites | Social Media | Other". Answering with a channel the list does
          // not name left a required field empty. The channel matters far less than answering
          // truthfully-enough, so fall back through a preference order over the OFFERED options.
          const preference = [
            /campus|university|college|career (fair|center)|school/i,
            /company (web)?site|our website|careers page/i,
            /job board|job ?site|website|indeed|handshake|linkedin|glassdoor/i,
            /referral|employee/i,
            /social media|twitter|facebook|instagram/i,
            /other/i,
          ];
          const heardAbout = /how did you (hear|find|learn)|source|referral source/i.test(field.label);
          const fallback = heardAbout
            ? preference.map((rx) => field.options!.find((o) => rx.test(o))).find(Boolean)
            : undefined;
          if (fallback) {
            value = fallback;
          } else if (field.searchable) {
            confidence = Math.min(confidence, 0.5);
          } else {
            needsHuman = true;
            confidence = Math.min(confidence, 0.3);
          }
        } else {
          value = match;
        }
      }
      /**
       * An OPTIONAL cover letter or summary is left BLANK, on instruction. Several paragraphs of
       * LLM prose going to an employer under the candidate's name, for a field nobody required, is
       * not a neutral addition — and it is where the stale "GPA 3.53" survived longest. A REQUIRED
       * one is still answered; the gate will not pass without it.
       */
      if (skipAsOptionalProse(field.label ?? "", Boolean(field.required))) {
        console.log(`  [agent] leaving optional "${(field.label ?? "").slice(0, 44)}" blank — not required`);
        answers.push({ key: field.key, value: "", confidence: 1, needsHuman: false, draft: false, blank: true, source: "curated" });
        continue;
      }
      answers.push({ key: field.key, value, confidence, needsHuman, draft, blank, source: "llm", reasoning: item.reasoning });
    }
    console.log(`  [agent] ${provider} answered ${answers.length}/${snapshot.fields.length} fields.`);
    // An answer you corrected is used EXACTLY, not as a hint. The curated store is passed to
    // the model as context, and the model paraphrases: "100K annualized" came back as "100K"
    // after that exact wording had been recorded from a review. Whatever the model produced,
    // an exact question match in the store wins — that is what "remember what I edited" has to
    // mean, or the same correction has to be made again on the next form.
    // Walk the FIELDS, not the model's reply. A field the model skipped entirely produced no
    // answer to override, so "Country Phone Code*" was reported as unanswerable for eighteen
    // turns while the value sat recorded in the store. A recorded answer must not depend on the
    // model having mentioned the field.
    for (const field of snapshot.fields) {
      /**
       * OUR OWN LABELS CARRY A PREFIX THE STORE DOES NOT.
       *
       * read() qualifies a label with the block it came from — "Education — Field of Study",
       * "Work Experience 3 — Month", "tart Date — From* — Work Experience — Year" — because a bare
       * "Month" is unanswerable. The store holds the bare question, so an exact lookup misses and
       * the model answers instead. It filled Field of Study with "Management Information System",
       * derived from the resume's "BS Information Systems", while the store held the right answer
       * the whole time:
       *
       *     Field of Study             -> "Computer and Information Science"   (present)
       *     Education — Field of Study -> no entry                             (what we looked up)
       *
       * So after the exact match fails, try the TAIL after the last em-dash separator. That tail is
       * the question by construction — we are the ones who put the prefix there.
       */
      const stored = storedAnswerFor(ctx.answers, field.label);
      if (!stored) continue;
      if (normalizeQuestion(stored.question) !== normalizeQuestion(field.label)) {
        console.log(
          `  [agent] "${field.label.slice(0, 46)}" answered from your recorded "${stored.question.slice(0, 34)}"`,
        );
      }
      let answer = answers.find((a) => a.key === field.key);
      if (!answer) {
        answer = { key: field.key, value: "", confidence: 0, needsHuman: true, source: "curated" };
        answers.push(answer);
      }
      let value = Array.isArray(stored.answer) ? stored.answer.join(", ") : String(stored.answer ?? "");
      if (!value.trim()) continue;
      /**
       * THE MODEL REACHING THE SAME VALUE IS NOT A REASON TO SKIP.
       *
       * This used to `continue` whenever the values matched, which left the model's own
       * `needsHuman` flag standing — so a field the user HAS answered was reported by the turn loop
       * as "no answer available, left for you". "Country Phone Code*" is the worst field in the
       * log and this is the second reason for it: the value was right, and it was handed back for
       * a human anyway. A recorded answer CONFIRMS a matching one.
       */
      if (value.trim() === answer.value.trim()) {
        if (answer.needsHuman || answer.draft || answer.confidence < 1) {
          console.log(`  [agent] your recorded answer for "${field.label.slice(0, 52)}" confirms what was filled`);
        }
        answer.needsHuman = false;
        answer.draft = false;
        answer.confidence = 1;
        answer.source = "curated";
        continue;
      }
      // Some stored answers DESCRIBE having nothing to enter rather than being a value — the
      // seed for Phone Extension reads "(none — no extension; leave this field empty)". Typing
      // that into the form is worse than leaving it blank, which is what it actually means.
      const bare = value.trim().replace(/^\(+|\)+$/g, "").trim();
      const meansEmpty =
        /^(none|n\/?a|na|nothing|not applicable|no extension|no middle name)$/i.test(bare) ||
        /^nothing\b/i.test(bare) ||
        /leave (this|the) field empty|leave (it|this) blank/i.test(value);
      // "No" and "None of the above" are REAL answers — only a value that says there is nothing
      // to enter becomes an empty field.
      if (meansEmpty) {
        answer.value = "";
        answer.blank = true;
        answer.needsHuman = false;
        answer.source = "curated";
        continue;
      }
      // For a closed list the stored wording may not be one of the options; leave those alone
      // rather than writing a value the widget cannot take.
      const choosable = usableOptions(field.options);
      if (choosable?.length && !field.searchable) {
        const match = optionForRecorded(choosable, value);
        if (match.kind === "reworded") {
          console.log(
            `  [agent] your recorded ${JSON.stringify(value.slice(0, 40))} is offered as ` +
              `${JSON.stringify(match.option.slice(0, 40))} — using the form's wording`,
          );
          value = match.option;
        } else if (match.kind !== "exact") {
          /**
           * SAY WHY. This branch used to `continue` in silence, so the turn loop's
           * "no answer available" was the only trace — which read as "we have no answer" when the
           * truth was "the answer is not on the menu". 130 of those went undiagnosed.
           */
          /**
           * A work-authorisation question spells its answers out as sentences, so a recorded
           * "Yes" can never match. Derive it from the two records that decide it before
           * reporting the field as unanswerable.
           */
          if (/authoriz|authoris/i.test(field.label) && /\bwork\b/i.test(field.label)) {
            const sponsorRecord = storedAnswerFor(ctx.answers, "Do you require sponsorship for employment visa status?")
              ?? storedAnswerFor(ctx.answers, "Will you now or in the future require visa sponsorship?");
            const derived = workAuthorizationOption(choosable, {
              authorized: /^\s*y(es)?\b/i.test(value),
              needsSponsorship: sponsorRecord ? /^\s*y(es)?\b/i.test(String(sponsorRecord.answer)) : undefined,
            });
            if (derived) {
              console.log(
                `  [agent] "${field.label.slice(0, 42)}" is a sentence, not a yes/no — the records say ` +
                  `${JSON.stringify(derived.option.slice(0, 52))} (${derived.why})`,
              );
              value = derived.option;
              /**
       * A work-authorisation answer carries the records that decide it. The tenant may offer
       * sentences instead of Yes/No, and the options are usually unknown here — the fill is where
       * they appear, so that is where the choice is made, from these facts and nothing else.
       */
      answer.records = workAuthorizationRecords(field.label, value, ctx) ?? answer.records;
      answer.value = value;
              answer.source = "curated";
              answer.needsHuman = false;
              continue;
            }
          }
          const why = match.kind === "ambiguous" ? `matches ${match.among} of them` : "is not one of them";
          console.log(
            `  [agent] your recorded answer for "${field.label.slice(0, 42)}" ` +
              `(${JSON.stringify(value.slice(0, 40))}) ${why} — the form offers ${choosable.length}: ` +
              `${choosable.slice(0, 3).map((o) => o.slice(0, 22)).join(" | ")}${choosable.length > 3 ? " …" : ""}`,
          );
          continue;
        }
      }
      /**
       * THE RESUME OVERRULES THE STORE. The resume is the latest and most accurate source of facts;
       * `Q&A.txt` and the learned corrections are not, and they are handed out unchanged however
       * stale they are. "GPA: 3.53" outlived a resume corrected to 3.44 in all three files, and a
       * learned answer claimed Nathan requires visa sponsorship — both reached real applications.
       *
       * So a stored answer that contradicts a fact the resume STATES is refused here, and the normal
       * answering path — which derives from the resume — fills the field instead. Only facts the
       * resume contains are checked; everything else in the store (the address, EEO answers,
       * preferences, motivations) is knowledge the resume does not have and is untouched.
       */
      const conflict = contradictsResume(field.label, value, resumeFactsFor(ctx), field.options);
      if (conflict) {
        console.log(`  [agent] IGNORING your recorded answer for "${field.label.slice(0, 42)}" — ${conflict.slice(0, 92)}`);
        continue;
      }
      console.log(`  [agent] using your recorded answer for "${field.label.slice(0, 52)}": ${JSON.stringify(value.slice(0, 60))}`);
      answer.value = value;
      answer.source = "curated";
      answer.confidence = 1;
      answer.needsHuman = false;
      answer.draft = false;
      /**
       * CARRY THE RECORDS THAT DECIDE WORK AUTHORISATION.
       *
       * The tenant may spell this question as sentences ("I am authorized to work in the United
       * States for any employer") and the options are unknown here — read-time capture finds none
       * and the fill discovers five — so the choice has to be made in the fill, from these facts.
       *
       * I attached this to the WRONG branch first: there are three places in this file that accept
       * a recorded answer, and the one that logs "using your recorded answer" is this one. The
       * fill then found `records` undefined, changed nothing, and General Matter failed a FOURTH
       * time on the same field with the same trace.
       */
      answer.records = workAuthorizationRecords(field.label, value, ctx) ?? answer.records;
    }

    // An address is ONE thing. Motorola rejected an application with "94085 is not a valid postal
    // code for Pennsylvania": the street came from the real home address in Sunnyvale while the
    // state was inferred from the resume's Pittsburgh schooling. Whenever a page asks for address
    // parts, they are all taken from the SAME stored address so they cannot disagree.
    const home = ctx.answers.find((a) => /^home address$/i.test(a.question.trim()));
    const homeText = home ? (Array.isArray(home.answer) ? home.answer.join(", ") : String(home.answer ?? "")) : "";
    const parts = /^(.+?),\s*([^,]+),\s*([A-Za-z .]{2,20})\s+(\d{5})(?:-\d{4})?$/.exec(homeText.trim());
    if (parts) {
      const STATES: Record<string, string> = {
        ca: "California", pa: "Pennsylvania", ny: "New York", wa: "Washington", or: "Oregon",
        tx: "Texas", il: "Illinois", ma: "Massachusetts", nj: "New Jersey", az: "Arizona",
      };
      const [, street, city, stateRaw, postal] = parts;
      const state = STATES[stateRaw.trim().toLowerCase()] ?? stateRaw.trim();
      const pick = (label: string): string | undefined =>
        addressPartFor(label, { street: street.trim(), city: city.trim(), state, postal });
      for (const field of snapshot.fields) {
        const wanted = pick(field.label);
        if (wanted === undefined) continue;
        // A state dropdown may word it either way; leave a closed list alone unless it offers this.
        if (wanted && field.options?.length && !field.searchable) {
          const lv = wanted.toLowerCase();
          if (!field.options.some((o) => o.toLowerCase() === lv || o.toLowerCase().startsWith(lv))) continue;
        }
        let answer = answers.find((a) => a.key === field.key);
        if (!answer) {
          answer = { key: field.key, value: "", confidence: 0, needsHuman: true, source: "profile" };
          answers.push(answer);
        }
        if (answer.value.trim() === wanted) continue;
        if (wanted || field.required === false) {
          console.log(`  [agent] address field "${field.label.slice(0, 40)}" → ${JSON.stringify(wanted)} (from your home address)`);
          answer.value = wanted;
          answer.source = "profile";
          answer.confidence = 1;
          answer.needsHuman = false;
          answer.blank = wanted === "";
        }
      }
    }

    /**
     * DEGREE LEVEL and GPA are facts, so they are decided from the resume rather than left to the
     * model. Both were being got wrong on live applications in ways that look filled and get
     * believed:
     *   Degree*                            -> "Associate's Degree"          the wrong level
     *   Degree                             -> "Information Systems"         a field of study
     *   Degree                             -> "Python (Programming Language)"  a skill
     *   What is your cumulative GPA?*      -> "3.0-3.5"                     excludes a real 3.53
     *
     * applicationSanity/factChecks BLOCKS all of these, but blocking alone would just park every
     * such job on /blocked forever — the model would keep choosing the same wrong option. This
     * picks the right one instead, and the guardrail stays as the backstop.
     */
    const eduFacts = parseResumeHistory(ctx.resumeText || ctx.profile?.rawText || "").education[0];
    const wantLevel = eduFacts?.degree ? degreeLevel(eduFacts.degree) : undefined;
    const realGpa = Number(ctx.profile?.gpa ?? eduFacts?.gpa ?? "");

    for (const field of snapshot.fields) {
      const label = field.label ?? "";
      const answer = answers.find((a) => a.key === field.key);
      if (!answer) continue;

      // A degree-LEVEL question, not a subject one ("Field of study" wants Information Systems).
      const isDegreeLevel =
        /\b(degree|education level|level of education|highest (level of )?education)\b/i.test(label) &&
        !/\b(field of study|discipline|major|subject|concentration|area of study)\b/i.test(label);
      if (isDegreeLevel && wantLevel) {
        if (field.options?.length) {
          const match = field.options.find((o) => degreeLevel(o) === wantLevel);
          if (match && answer.value !== match) {
            console.log(`  [agent] degree → ${JSON.stringify(match)} (the resume says ${JSON.stringify(eduFacts?.degree)}, not ${JSON.stringify(answer.value)})`);
            answer.value = match;
            answer.source = "profile";
            answer.confidence = 1;
            answer.needsHuman = false;
          }
        } else if (degreeLevel(answer.value) !== wantLevel && eduFacts?.degree) {
          console.log(`  [agent] degree → ${JSON.stringify(eduFacts.degree)} (was ${JSON.stringify(answer.value)}, which is not a ${wantLevel} degree)`);
          answer.value = eduFacts.degree;
          answer.source = "profile";
          answer.confidence = 1;
          answer.needsHuman = false;
        }
      }

      // GPA: the exact figure in a text box, and the band that CONTAINS it in a dropdown.
      if (/\bgpa\b|grade point average|overall result/i.test(label) && !Number.isNaN(realGpa) && realGpa > 0) {
        if (field.options?.length) {
          // bestBand handles the case no band contains the value: Verkada offers
          // 3.6-4.0 / 3.1-3.5 / 3.0-or-under and a 3.53 falls in the gap between two of them. It
          // then takes the nearest band BELOW, never above — understating is a rounding decision,
          // overstating is a false claim. A required GPA went unanswered before this.
          const band = bestBand(field.options, realGpa);
          if (band && answer.value !== band) {
            console.log(`  [agent] GPA band → ${JSON.stringify(band)} (for the real ${realGpa}; was ${JSON.stringify(answer.value)})`);
            answer.value = band;
            answer.source = "profile";
            answer.confidence = 1;
            answer.needsHuman = false;
          }
        } else if (answer.value.trim() !== String(realGpa)) {
          const parsed = parseGpaBand(answer.value);
          // Only correct a value that is a NUMBER or a band and disagrees. Free-text answers like
          // "see transcript" are left alone.
          if (parsed && !bandContains(parsed, realGpa)) {
            console.log(`  [agent] GPA → ${realGpa} (was ${JSON.stringify(answer.value)})`);
            answer.value = String(realGpa);
            answer.source = "profile";
            answer.confidence = 1;
            answer.needsHuman = false;
          }
        }
      }
    }

    /**
     * The country dialling code. Nathan is in the US on one address used everywhere, so the answer
     * is always the same; only the SPELLING of the question and of the option varies. The form's
     * own wording wins, via the same option matcher the store override uses.
     */
    for (const field of snapshot.fields) {
      if (!isPhoneCountryCode(field.label)) continue;
      let answer = answers.find((a) => a.key === field.key);
      if (answer?.value?.trim() && !answer.needsHuman) continue;
      const wanted = "United States of America (+1)";
      let value = wanted;
      if (field.options?.length) {
        const match = optionForRecorded(field.options, wanted);
        if (match.kind === "exact" || match.kind === "reworded") {
          value = match.option;
        } else {
          // Try the bare code: some tenants list "+1" alone, others "United States".
          const fallback = ["+1", "United States", "USA", "US"]
            .map((v) => optionForRecorded(field.options!, v))
            .find((m) => m.kind === "exact" || m.kind === "reworded");
          if (!fallback || !("option" in fallback)) {
            console.log(
              `  [agent] "${field.label.slice(0, 40)}" offers ${field.options.length} options and none is the US: ` +
                `${field.options.slice(0, 4).map((o) => o.slice(0, 18)).join(" | ")}`,
            );
            continue;
          }
          value = fallback.option;
        }
      }
      if (!answer) {
        answer = { key: field.key, value: "", confidence: 0, needsHuman: true, source: "curated" };
        answers.push(answer);
      }
      console.log(`  [agent] dialling code → ${JSON.stringify(value)} for "${field.label.slice(0, 40)}"`);
      answer.value = value;
      answer.source = "curated";
      answer.confidence = 1;
      answer.needsHuman = false;
      answer.draft = false;
    }

    /**
     * A SKILLS PROMPT IS ANSWERED BY skill.txt, so it must not look unanswered.
     *
     * fillFromSkillPlan does the real work — type each heading, tick the exact entries listed
     * under it, because nothing else can know that "Python" means eight separate taxonomy rows.
     * But it lives inside fill(), and fill() is only reached when the turn loop HAS an answer. The
     * model has nothing to say about a taxonomy it cannot see, so the field came back "no answer
     * available, and the field is EMPTY" and the plan never ran at all — on the very page the plan
     * exists for.
     *
     * The value here is a marker: fillFromSkillPlan ignores it and reads the plan. What matters is
     * that the field is ANSWERED, so the filler is invited to do its job.
     */
    /**
     * A skills prompt needs NO answer from here. The driver declares it via fillsWithoutAnswer and
     * fills it from skill.txt; the turn loop invites it directly. An earlier version of this set a
     * placeholder answer so that fill() would be reached, and the filler typed the placeholder
     * into the taxonomy — searching for "skill.txt" and being offered "Skill Development". Saying
     * nothing here is what keeps that impossible.
     */

    /**
     * REFUSE AN INVENTED DEGREE OR FIELD OF STUDY. Runs after the store override, so a recorded or
     * resume-derived answer has already claimed the field and is left alone; what is left is the
     * model's own guess, and for these questions that is not good enough.
     */
    for (const field of snapshot.fields) {
      if (!mustComeFromRecords(field.label)) continue;
      const answer = answers.find((a) => a.key === field.key);
      if (!answer || !answer.value.trim()) continue;
      if (answer.source === "curated" || answer.source === "profile") continue;

      /**
       * A CLOSED LIST MAY NAME THE RECORD DIFFERENTLY, AND THAT IS NOT A GUESS.
       *
       * Michelin asks "What is your current major?" as ten options, among them
       * "Computer Science, Computer Engineering" and "Information Systems Technology". The stored
       * answer is "Computer and Information Science" — a Workday taxonomy entry, absent from this
       * list — so nothing matched and the model's "Information Systems Technology" was refused as
       * invented. It was the right option: the resume says Information Systems, and
       * optionForRecorded maps that phrase onto "Information Systems Technology" token for token.
       * The question went out BLANK on a finished application over a naming difference.
       *
       * So before refusing, ask the RESUME. It is a record — parsed from the file, never from the
       * model — and the mapping is optionForRecorded's, which only accepts an option that spells
       * the record out. An ambiguous or absent match still refuses, which is what keeps this from
       * becoming "pick something plausible".
       */
      const rf = resumeFactsFor(ctx);
      const asksDegree = /\bdegree\b/i.test(field.label) && !/field of study|major|discipline/i.test(field.label);
      const fromResume = (asksDegree ? rf.degree : rf.fieldOfStudy)?.trim();
      const forDegree = usableOptions(field.options);
      if (fromResume && forDegree?.length && asksDegree) {
        /**
         * A DEGREE LIST NAMES THE LEVEL, NOT THE AWARD. The resume says "Bachelor of Science";
         * the list offers "Bachelor's Degree". Token matching cannot join those, but degreeLevel
         * exists to say they are the same level — and that is the claim the form is asking for.
         * Only when exactly ONE option carries that level, so "Bachelor of Arts" beside
         * "Bachelor of Science" stays a question for a human rather than a coin toss.
         */
        const want = degreeLevel(fromResume);
        const sameLevel = want ? forDegree.filter((o) => degreeLevel(o) === want) : [];
        const exactish = sameLevel.filter((o) => optionForRecorded([o], fromResume).kind !== "absent");
        const pick = exactish.length === 1 ? exactish[0] : sameLevel.length === 1 ? sameLevel[0] : "";
        if (pick) {
          if (pick.trim().toLowerCase() !== answer.value.trim().toLowerCase()) {
            console.log(
              `  [agent] "${field.label.slice(0, 40)}": the resume's ${JSON.stringify(fromResume)} is the ` +
                `${want} level, and this list calls that ${JSON.stringify(pick)} — using that`,
            );
          }
          answer.value = pick;
          answer.source = "profile";
          continue;
        }
      }
      const forStudy = usableOptions(field.options);
      if (fromResume && forStudy?.length) {
        const mapped = optionForRecorded(forStudy, fromResume);
        if (mapped.kind === "exact" || mapped.kind === "reworded") {
          if (mapped.option.trim().toLowerCase() !== answer.value.trim().toLowerCase()) {
            console.log(
              `  [agent] "${field.label.slice(0, 40)}": the list does not use the recorded wording, but the ` +
                `resume's ${JSON.stringify(fromResume)} names ${JSON.stringify(mapped.option)} — using that`,
            );
          }
          answer.value = mapped.option;
          answer.source = "profile";
          continue;
        }
      }
      console.log(
        `  [agent] REFUSING an invented answer for "${field.label.slice(0, 40)}": ` +
          `${JSON.stringify(answer.value.slice(0, 40))} — a degree or field of study comes from your ` +
          `records, not from a guess. Left for you.`,
      );
      answer.value = "";
      answer.needsHuman = true;
      answer.draft = false;
      answer.source = "curated";
    }

    /**
     * "What areas are you interested in… select all that apply" — tick the software-engineering
     * ones, counting research and development, and leave hardware alone. Only when the form has
     * told us what it offers; guessing at option wording is what put a dialling code in a country
     * field.
     */
    for (const field of snapshot.fields) {
      if (!isAreasOfInterest(field.label) || !field.options?.length) continue;
      const wanted = softwareInterests(field.options);
      if (!wanted.length) {
        console.log(
          `  [agent] "${field.label.slice(0, 40)}" offers nothing software-related among ` +
            `${field.options.length}: ${field.options.slice(0, 4).map((o) => o.slice(0, 18)).join(" | ")}`,
        );
        continue;
      }
      let answer = answers.find((a) => a.key === field.key);
      if (!answer) {
        answer = { key: field.key, value: "", confidence: 0, needsHuman: true, source: "curated" };
        answers.push(answer);
      }
      answer.value = wanted.join(", ");
      answer.source = "curated";
      answer.confidence = 1;
      answer.needsHuman = false;
      answer.draft = false;
      console.log(`  [agent] areas of interest → ${wanted.join(", ")}`);
    }

    // "How did you hear about us?" — prefer the campus channel when the list offers one, per the
    // standing preference (university > company site > job board > referral > social > other).
    for (const field of snapshot.fields) {
      if (!/how did you (hear|find|learn)/i.test(field.label)) continue;
      /**
       * SAY WHEN THE LIST NEVER ARRIVED. Uline blocked two applications on this field — three
       * answering passes and the required-field gate, all reporting "no answer available" — and
       * the reason was not that we lack a preference. It is that `field.options` was empty, so the
       * rule below could not choose from a list it never received. Option capture on this widget
       * is known to be unreliable (44 options one round, 4 the next). Without this line the log
       * cannot tell "we have no preference" from "we were handed no options".
       */
      if (!field.options?.length) {
        console.log(`  [agent] "${field.label.slice(0, 40)}" arrived with NO options — cannot pick the campus channel`);
        continue;
      }
      const preferred = preferredHearAboutUs(field.options);
      const campus = preferred?.option;
      if (!campus) {
        console.log(
          `  [agent] "${field.label.slice(0, 40)}" offers no channel we recognise among ${field.options.length}: ` +
            `${field.options.slice(0, 4).map((o) => o.slice(0, 20)).join(" | ")}`,
        );
        continue;
      }
      /**
       * Walk the FIELDS, not the model's reply — the same lesson as the store override above. A
       * field the model skipped has no answer object, and this rule used to `continue` on that,
       * so the standing preference simply did not apply to the case that needed it most.
       */
      let answer = answers.find((a) => a.key === field.key);
      if (!answer) {
        answer = { key: field.key, value: "", confidence: 0, needsHuman: true, source: "curated" };
        answers.push(answer);
      }
      if (answer.value === campus && !answer.needsHuman) continue;
      console.log(
        `  [agent] "how did you hear" → ${JSON.stringify(campus)} (${preferred?.why}, preferred over ` +
          `${JSON.stringify(answer.value || "(nothing)")})`,
      );
      answer.value = campus;
      answer.source = "curated";
      answer.confidence = 1;
      answer.needsHuman = false;
    }

    return answers;
  }
}

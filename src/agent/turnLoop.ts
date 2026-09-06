import path from "node:path";
import { ocrLayout } from "../knowledge/visualCheck.js";
import { boxesAreExact, textIsLiteral, unansweredOnScreen } from "../knowledge/screenBlocks.js";
import type { Page } from "playwright";
import type { DocumentUploads, HistoryOutcome, Agent, AgentContext, AtsDriver, FieldSpec, FilledAnswer } from "./types.js";
import { ocrLayoutTiled } from "../knowledge/visualCheck.js";
import { captureFormShot, captureTallTiles } from "./formShot.js";
import { planTiles } from "../knowledge/tiles.js";
import { judgePageLanguage } from "../core/pageLanguage.js";
import { isExclusiveGroup } from "../core/fieldGroups.js";
import { contradictsResume } from "../core/factChecks.js";
import type { ResumeFacts } from "../core/factChecks.js";


/**
 * The visual checker is down, so this run stopped rather than produce an application nobody has
 * verified. Its own type so callers can tell it from a filling failure: nothing is wrong with the
 * form or the answers, and the job should be retried once the checker is back.
 */
export class OcrUnavailableError extends Error {
  readonly ocrUnavailable = true;
  constructor(reason: string) {
    super(`the visual checker is unavailable — refusing to fill unverified: ${reason}`);
    this.name = "OcrUnavailableError";
  }
}

export interface TurnLoopOptions {
  resumePath: string;
  /**
   * The resume facts, so a value the form ALREADY holds can be checked before it is believed.
   * Same source as the readiness gate's.
   */
  facts?: ResumeFacts;
  /**
   * How many jobs the resume lists. Passed in rather than read here: applyJob already parses the
   * resume, and the turn loop has no business loading files. 0/undefined means "add no rows".
   */
  experienceCount?: number;
  maxTurns?: number;
  interactive?: boolean; // pause for a human when a field needs manual input
  // Ask the user (in the terminal) for a field's value. Returns the value to
  // fill, or null to leave it for manual handling.
  onLearn?: (field: FieldSpec) => Promise<string | null>;
  /** Where per-page verification screenshots go. Absent → the check is skipped. */
  runDir?: string;
}

/**
 * How long one field may take before it is treated as a failure.
 *
 * Was 90s, which is far past anything a SUCCESS needs. Measured: the worst legitimate case in
 * the suite — a static alphabetical list of ~250 country codes, shown fourteen at a time, whose
 * target sits seventeen pages down and is reached by bisecting the scroll position — fills in
 * 4.2s (src/debug/longListCases.ts). Every real fill observed is single-digit seconds.
 *
 * What 90s actually bought was failure. Garda Capital (Greenhouse) spent 4.5 of its 6m31s on
 * three fields that were never going to accept a value, and General Matter spent 19.5 minutes
 * across thirteen of them. A field that has not taken a value in 30s is not going to at 90.
 *
 * BACK TO 90s, and the reduction to 30s is a mistake worth recording. A form DID prove it needs
 * more: on RTX's My Information page "Country Phone Code*" — the 250-entry list reached by
 * bisecting the scroll position — timed out at 30s and was reported as "would not take it", on a
 * page where it had succeeded at 90s. The 4.2s figure from longListCases is the same trap the
 * combobox early-out fell into: that case drives ONE field on a freshly opened page. Mid-form,
 * with a stray menu closing and the page still settling, the same field is far slower.
 *
 * So do not shorten this to buy back time on hopeless fields. The cost of a field that will never
 * accept a value belongs to whatever DETECTS that, not to a deadline short enough to also fail
 * the slow ones.
 */
const FIELD_TIMEOUT_MS = Number(process.env.FIELD_TIMEOUT_MS ?? 90_000);

/**
 * Resolve to false if the work outruns its deadline. The promise is abandoned rather than
 * cancelled — Playwright has no cancellation — but the loop moves on, which is the point.
 */
async function withDeadline(work: Promise<boolean>, ms: number, label: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      console.log(`    ⏱ gave up on "${label.slice(0, 60)}" after ${Math.round(ms / 1000)}s`);
      resolve(false);
    }, ms);
  });
  try {
    return await Promise.race([work.catch(() => false), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface TurnLoopResult {
  turns: number;
  filled: string[]; // "label: value" that were filled
  answers: FilledAnswer[]; // structured record of every filled field (for replay on submit)
  drafts: string[]; // labels of LLM-drafted free-text (review before submit)
  unknown: string[]; // labels with NO answer available — never attempted, needs a human
  failedToFill: string[]; // labels we DID attempt but the widget would not take the value
  /** Every field this visit saw, in order. Recorded so the form that was APPROVED can later
   *  be diffed against the form present at submit time — evidence, not recollection. */
  observedFields: FieldSpec[];
  reachedReview: boolean; // the Submit control was reached (we never click it)
  /**
   * The page is showing a submission confirmation and WE DID NOT MEAN TO SUBMIT.
   *
   * Never a normal outcome. It means something in the fill submitted the form — on 29 August, stray
   * Enter keystrokes did it six times — and the only thing worse than that happening is it happening
   * unnoticed. Callers must record the application as submitted, because the employer has it.
   */
  submittedUnexpectedly?: boolean;
  alreadyApplied: boolean;
  blockedRequired: string[]; // required fields still empty that blocked advancing
  /** Was the resume actually attached this run? Feeds the whole-application sanity check —
   *  an application with no resume is not an application. */
  resumeAttached: boolean;
  /** Repeatable Education / Experience outcome, when the driver has such sections. Undefined
   *  means the form has none — which is normal for Greenhouse and Lever. */
  history?: HistoryOutcome;
  /** Which documents went in, and which the form wanted and did not get. */
  documents: DocumentUploads;
}

/** Required fields we're CONFIDENT are still empty (filled === false). */
function emptyRequired(fields: FieldSpec[]): FieldSpec[] {
  return fields.filter((f) => f.required && f.filled === false);
}

/**
 * The generic driver: each turn asks the reader for the page, the agent for
 * answers, then the filler applies them and advances — until the Submit control
 * is reached. It NEVER clicks submit.
 */
export async function runApplication(
  page: Page,
  driver: AtsDriver,
  agent: Agent,
  ctx: AgentContext,
  opts: TurnLoopOptions,
): Promise<TurnLoopResult> {
  const maxTurns = opts.maxTurns ?? 8;
  const filled: string[] = [];
  const answersByLabel = new Map<string, FilledAnswer>(); // last-write-wins per field
  const filledLabels = new Set<string>(); // fields we successfully filled this run
  const drafts: string[] = [];
  const unknown: string[] = [];
  const failedToFill: string[] = [];
  // page → (label+type → the field as that page LAST read it). See the read loop for why.
  const observedByPage = new Map<string, Map<string, FieldSpec>>();
  const observed = (): Map<string, FieldSpec> => {
    const all = new Map<string, FieldSpec>();
    for (const forPage of observedByPage.values()) for (const [k, f] of forPage) all.set(k, f);
    return all;
  };
  let blockedRequired: string[] = [];
  const answers = () => [...answersByLabel.values()];
  // How many times a field we believe we filled has come back empty on re-read.
  const disputed = new Map<string, number>();
  // Fields already studied this run, so one refusal costs at most one diagnosis.
  const studied = new Set<string>();
  const TRUST_LIMIT = 2;
  /**
   * A required field blocks if it reads empty and we have no credible claim to have
   * filled it. Workday's custom widgets do sometimes report filled=false when they are
   * in fact set, so a successful fill is trusted — but only for TRUST_LIMIT rounds.
   * Trusting it forever is how a field that silently never took a value (a Workday
   * combobox reporting success without verifying) escaped the gate: it was neither
   * retried nor blocked, and the loop span every remaining turn on the same page.
   */
  /**
   * Required checkbox GROUPS with nothing ticked. "Please check one of the boxes below:*"
   * marks the question required while no individual box is, so per-field checks accept
   * three untouched boxes as answered — which is how a Workday Self Identify page reported
   * every option filled and then refused to advance. Reported as one entry per group.
   */
  const missingGroups = (fields: FieldSpec[]): FieldSpec[] => {
    const groups = new Map<string, FieldSpec[]>();
    for (const f of fields) if (f.groupKey && f.groupRequired) groups.set(f.groupKey, [...(groups.get(f.groupKey) ?? []), f]);
    const out: FieldSpec[] = [];
    for (const [, members] of groups) {
      if (members.some((m) => m.filled === true)) continue;
      const label = members[0].groupLabel || members[0].label;
      if (filledLabels.has(`group:${label}`)) continue; // we ticked one this run
      out.push({ ...members[0], label, required: true, filled: false });
    }
    return out;
  };

  const stillMissing = (fields: FieldSpec[]): FieldSpec[] =>
    fields.filter((f) => {
      if (!f.required || f.filled !== false) return false;
      if (!filledLabels.has(f.label)) return true;
      const seen = (disputed.get(f.label) ?? 0) + 1;
      disputed.set(f.label, seen);
      if (seen <= TRUST_LIMIT) return false; // give the widget the benefit of the doubt
      filledLabels.delete(f.label); // claim not credible any more — retry it, then block
      console.log(`    ⚠ "${f.label.slice(0, 50)}" reported filled but reads empty ${seen}× — no longer trusting that`);
      return true;
    });

  await driver.openApplication(page);
  let root = await driver.resolveRoot(page);
  if (await driver.isAlreadyApplied(root)) {
    return { turns: 0, filled, answers: answers(), drafts, unknown, failedToFill, observedFields: [], reachedReview: false, alreadyApplied: true, blockedRequired, resumeAttached: false, documents: { attached: [], missing: [] } };
  }

  // Fill one set of fields, recording results. Returns nothing — the caller
  // re-reads the page to learn what actually landed. `learn` lets the caller
  // opt into terminal prompting for still-unanswered fields.
  const fillFields = async (fields: FieldSpec[], learn: boolean): Promise<void> => {
    if (fields.length === 0) return;
    const answers = await agent.decide({ url: root.url(), fields, submitReady: false, nextAvailable: true }, ctx);
    const byKey = new Map(answers.map((a) => [a.key, a]));
    for (const field of fields) {
      const answer = byKey.get(field.key);
      // A known blank is an ANSWER: an optional field the candidate genuinely has nothing
      // for (a phone extension they do not have). Leave it empty and move on — listing it
      // under "no answer available" implied we failed to work out something we knew.
      if (answer?.blank && !answer.value && !field.required) {
        filledLabels.add(field.label);
        console.log(`    ✓ ${field.label} (left empty — nothing to enter)`);
        continue;
      }
      /**
       * THE DRIVER MAY OWN THIS FIELD. A skills taxonomy is filled from skill.txt, and no answer
       * string can carry "Python means eight separate rows", so the loop must invite the driver
       * rather than skip a field it sees no value for. Papering over that with a placeholder
       * answer was worse: the filler typed the placeholder into the taxonomy and was offered
       * "Skill Development".
       */
      /**
       * ONE ANSWER PER EXCLUSIVE GROUP.
       *
       * Michelin's Self Identify page asks about disability as three mutually exclusive options,
       * and the loop answered all three:
       *
       *     ✓ Yes, I have a disability, or have had one in the past
       *     ✓ No, I do not have a disability and have not had one in the past
       *     ✓ I do not want to answer
       *
       * Three contradictory answers to one question about someone's health, and the form then
       * refused to advance. The grouping was already read — groupKey, groupLabel — but only the
       * required-group GATE consulted it; the fill loop treated each option as its own question.
       *
       * RADIO only. A checkbox group is "select all that apply" and multiple ticks are the point,
       * which is how the areas-of-interest answer works.
       */
      if (
        field.groupLabel &&
        filledLabels.has(`group:${field.groupLabel}`) &&
        isExclusiveGroup(
          fields.filter((f) => f.groupLabel === field.groupLabel).map((f) => f.label),
        )
      ) {
        console.log(
          `    ↳ "${field.groupLabel.slice(0, 40)}" is already answered — not also ticking ` +
            `"${field.label.slice(0, 40)}"`,
        );
        continue;
      }
      if (driver.fillsWithoutAnswer?.(field) && !field.filled) {
        const done = await withDeadline(
          driver.fill(root, field, { key: field.key, value: "", confidence: 1, source: "curated" }),
          FIELD_TIMEOUT_MS,
          field.label,
        ).catch(() => false);
        if (done) {
          filled.push(`${field.label}: (from the curated plan)`);
          filledLabels.add(field.label);
          console.log(`    ✓ ${field.label} (from the curated plan)`);
        } else if (!failedToFill.includes(field.label)) {
          failedToFill.push(field.label);
        }
        continue;
      }
      if (!answer || answer.needsHuman || !answer.value) {
        if (learn && opts.interactive && opts.onLearn) {
          const human = await opts.onLearn(field);
          if (human) {
            const ok = await driver
              .fill(root, field, { key: field.key, value: human, confidence: 1, source: "llm" })
              .catch(() => false);
            if (ok) {
              filled.push(`${field.label}: ${human} (you)`);
              filledLabels.add(field.label);
              answersByLabel.set(field.label, { label: field.label, type: field.type, value: human, widget: field.widget });
              console.log(`    ✓ ${field.label} (from you)`);
              continue;
            }
          }
        }
        /**
         * A FIELD THAT ALREADY HOLDS A VALUE IS NOT A GAP.
         *
         * "no answer available, left for you" says two things: we have no answer, AND you need to
         * do something. The second is false when the control is already filled — the candidate
         * could see "United States (+1)" sitting correctly in "Country / Territory Phone Code*"
         * while the log told him it had been left for him.
         *
         * WHO filled it is not something this flag can answer. `filled` means the control holds a
         * value; it could be the tenant deriving it from the country, the resume autofill, or OUR
         * OWN earlier run — Workday saves a part-finished application as a draft, so a re-run opens
         * a form already carrying what we typed last time. An earlier version of this comment said
         * "already filled by the form", which is an attribution the code cannot make, and the
         * candidate corrected it: that value was ours.
         *
         * Still logged, because a value nobody chose this run is worth seeing — the ATS autofills
         * badly elsewhere, which is why skill pruning exists. But it is not counted as missing.
         */
        if (field.filled) {
          /**
           * A PREFILLED FREE-TEXT FIELD IS NOT THE SAME AS A PREFILLED DIALLING CODE.
           *
           * Leaving a filled field alone is right when the tenant derived it — the country picks
           * the phone code and gets it right. It is WRONG for the long text the ATS writes from
           * its own parse of the resume: those arrive badly formatted, and the same parse is what
           * put BART in the experience list twice and guesses Skills so poorly that skill.txt
           * exists to delete them. Accepting that silently would submit the ATS's prose as
           * Nathan's, which nobody has read.
           *
           * We cannot rewrite what we have no answer for, so this is reported rather than fixed:
           * it goes into `unknown`, which is what puts it in front of a human, and says WHY.
           */
          if (field.type === "textarea") {
            if (!unknown.includes(field.label)) unknown.push(field.label);
            console.log(
              `    ⚠ prefilled from the resume parse and we have no answer to replace it with — ` +
                `left for you to read: ${field.label.slice(0, 56)}`,
            );
            continue;
          }
          /**
           * RECORD WHAT THE FORM HOLDS. Leaving it alone is right; recording nothing is not. The
           * readiness gate builds its "answered" set from these, so a correctly prefilled required
           * field was refused at Review as having no answer — and the review the candidate reads
           * showed a blank where the form had a value.
           */
          /**
           * A PREFILLED VALUE CAN BE FALSE, AND RECORDING IT MAKES IT OURS.
           *
           * Workday saves a part-finished application as a draft, so a re-run opens a form holding
           * whatever the last run typed — including an answer a later fix was meant to correct.
           * Michelin's GPA question sat at "Below 2.60" for a 3.44 through TWO runs this way: the
           * value was recorded as the answer, the review showed it as a chosen one, and the
           * candidate found it on the live form himself.
           *
           * So a prefilled value gets the same check a stated one does. A contradiction is not
           * recorded and the field is reported unanswered, which BLOCKS the application rather
           * than presenting a false answer for approval. Only the three resume facts are checked;
           * contradictsResume returns nothing for anything else.
           */
          const conflict = opts.facts && field.value?.trim()
            ? contradictsResume(field.label, field.value.trim(), opts.facts)
            : undefined;
          if (conflict) {
            console.log(`    ⚠ the form already holds a value that is FALSE — not recording it: ${conflict}`);
            if (!unknown.includes(field.label)) unknown.push(field.label);
            continue;
          }
          if (field.value?.trim()) {
            answersByLabel.set(field.label, {
              label: field.label,
              type: field.type,
              value: field.value.trim(),
              widget: field.widget,
            });
            filledLabels.add(field.label);
          }
          console.log(
            `    ↳ already has a value, leaving it: ${field.label.slice(0, 48)}` +
              `${field.value?.trim() ? ` = ${JSON.stringify(field.value.trim().slice(0, 30))}` : ""}`,
          );
          continue;
        }
        if (!unknown.includes(field.label)) unknown.push(field.label);
        // Log it. This branch used to skip silently, which is why a field could vanish from
        // the run with no trace and leave "no answer available" impossible to interpret —
        // was it tried, or never reached?
        console.log(`    – no answer available, and the field is EMPTY: ${field.label.slice(0, 60)}`);
        continue;
      }
      // Cap how long ONE field may take. A hung fill used to stall the whole worker: a submit for
      // Aquatic Capital sat "submitting" for nearly three hours with the log silent, holding six
      // queued commands behind it, because nothing in the widget hunting has a deadline. A field
      // that overruns is reported as failed-to-fill — which the required-field gate then handles
      // — instead of taking the daemon down with it.
      const ok = await withDeadline(driver.fill(root, field, answer), FIELD_TIMEOUT_MS, field.label);
      if (ok) {
        filled.push(`${field.label}: ${answer.value}${answer.draft ? " (DRAFT)" : ""}`);
        filledLabels.add(field.label);
        /**
         * A ticked box satisfies its whole group; an untouched one ("No") does not. But when the
         * group is EXCLUSIVE, choosing any option is the answer — including "I do not want to
         * answer", which is a legitimate reply to a self-identification question and must not
         * leave the group looking unanswered and the gate blocking on it.
         */
        const exclusive =
          Boolean(field.groupLabel) &&
          isExclusiveGroup(
            fields.filter((f) => f.groupLabel === field.groupLabel).map((f) => f.label),
          );
        if (field.groupKey && field.groupLabel && (exclusive || /^(yes|true|checked)/i.test(answer.value.trim()))) {
          filledLabels.add(`group:${field.groupLabel}`);
        }
        answersByLabel.set(field.label, { label: field.label, type: field.type, value: answer.value, widget: field.widget, draft: answer.draft });
        if (answer.draft) drafts.push(field.label);
        console.log(`    ✓ ${field.label}${answer.draft ? " (DRAFT — review)" : ""}`);
      } else {
        if (!failedToFill.includes(field.label)) failedToFill.push(field.label);
        console.log(`    ✗ tried but the field would not take it: ${field.label}`);
        /**
         * STUDY IT NOW, while the page is still open.
         *
         * Every diagnosis in this project has been made afterwards, by hand, from a screenshot and
         * a DOM dump - and usually after the failure had already cost an application. The run can
         * do that itself at the moment it fails: what the control is, whether anything is covering
         * it, what its own HTML says. Recorded against this ATS and this field, so the next run
         * and a person both start from what was already learned.
         *
         * Only for a REQUIRED field, and only once per field per run: a diagnosis costs a model
         * call, and an optional field that refuses a value is not worth one.
         */
        /**
         * A GROUPED OPTION IS NEVER "required" ON ITS OWN.
         *
         * read() deliberately clears `required` on each member of a radio or checkbox group and
         * puts it on the GROUP ("Please check one of the boxes below:*"), because no single box is
         * individually mandatory. My trigger asked for field.required, so the one class of field
         * most likely to refuse a value - a styled radio whose real input is hidden - could never
         * be studied. Five refusals since study mode shipped, zero studies.
         */
        /**
         * AND NOT ONLY WHEN SOMETHING SAYS IT IS REQUIRED.
         *
         * Uline's CC-305 boxes carry neither flag — the group detection did not attach the
         * question on that tenant, so `groupRequired` was false too — and the box that refused to
         * tick was therefore never studied. data/field-notes.json did not exist at all when the
         * candidate asked why the same application kept coming back to him. Requiredness is a
         * property of the FORM; a control that was told to take a value and did not is a failure
         * whatever the form thinks, and it is the only moment the page is still open to look at.
         *
         * Still once per field per run, so a diagnosis stays bounded.
         */
        if (driver.studyFailedField && !studied.has(field.label)) {
          studied.add(field.label);
          const ats = driver.type ?? "unknown";
          /**
           * WHAT DID WE LEARN LAST TIME? Asked before the study, because the same tenant asks the
           * same question of every applicant and its widgets do not change overnight. A note
           * saying "click-label recovered it" makes this one action instead of a model call and
           * four guesses; a note saying a remedy did not help stops it being repeated.
           */
          const learned = driver.knownRemedy ? await driver.knownRemedy(ats, field.label).catch(() => undefined) : undefined;
          if (learned && driver.applyRemedy) {
            console.log(`    📓 seen before on ${ats}: ${learned} recovered "${field.label.slice(0, 40)}" — trying that first`);
            const ok = await driver.applyRemedy(root, field, learned).catch(() => false);
            const again = ok
              ? await withDeadline(driver.fill(root, field, answer), FIELD_TIMEOUT_MS, field.label).catch(() => false)
              : false;
            await driver.recordRemedyOutcome?.(ats, field.label, learned, Boolean(again)).catch(() => undefined);
            if (again) {
              console.log(`    ✓ recovered from what we learned before: ${field.label.slice(0, 46)}`);
              filled.push(`${field.label}: ${answer.value}`);
              filledLabels.add(field.label);
              answersByLabel.set(field.label, {
                label: field.label,
                type: field.type,
                value: answer.value,
                widget: field.widget,
              });
              continue;
            }
          }
          await driver
            .studyFailedField(root, field, {
              ats: driver.type ?? "unknown",
              ...(opts.runDir ? { runDir: opts.runDir } : {}),
            })
            // A study that throws used to vanish here, which is the same silence it exists to end.
            .catch((error: Error) => {
              console.log(`    🔬 the study itself threw: ${error.message.split("\n")[0].slice(0, 100)}`);
              return "";
            });
          /**
           * AND THEN TRY THE REMEDY, HERE, WHILE THE PAGE IS STILL OPEN.
           *
           * "once you fail, immediately kick off the study mode, which will involve LLM, and
           * figure out why it fail, and try to fix it." A diagnosis filed away for later is not a
           * fix, and a retry that carries no new question fails the same way - which is what four
           * GLDUAY retries did.
           *
           * The remedy comes from a FIXED set the driver already knows how to perform; the model
           * only chooses among them. Then the fill is attempted again and its own verification
           * decides - so a remedy that did not help is reported as still stuck, never as recovered.
           */
          const remedy = driver.lastRemedy;
          if (remedy && remedy !== "none" && driver.applyRemedy) {
            const applied = await driver.applyRemedy(root, field, remedy).catch(() => false);
            if (applied) {
              const second = await withDeadline(
                driver.fill(root, field, answer),
                FIELD_TIMEOUT_MS,
                field.label,
              ).catch(() => false);
              await driver.recordRemedyOutcome?.(driver.type ?? "unknown", field.label, remedy, Boolean(second)).catch(
                () => undefined,
              );
              if (second) {
                console.log(`    ✓ recovered after ${remedy}: ${field.label.slice(0, 50)}`);
                filled.push(`${field.label}: ${answer.value}`);
                filledLabels.add(field.label);
                answersByLabel.set(field.label, {
                  label: field.label,
                  type: field.type,
                  value: answer.value,
                  widget: field.widget,
                });
                continue;
              }
              console.log(`    ✗ still stuck after ${remedy}: ${field.label.slice(0, 50)}`);
            }
          }
        }
      }
    }
  };

  let turns = 0;
  let resumeUploaded = false;
  /**
   * One OCR of the current page, then fill whatever it says is still required.
   *
   * Bounded on purpose: one screenshot, one OCR, one corrective pass. It is a second opinion, not a
   * loop — and it is best-effort, so no service or a slow one costs the run nothing but the wait.
   */
  const verifiedPages = new Set<string>();
  let pagesVerified = 0;
  /**
   * NEVER FILL A PAGE WE CANNOT READ.
   *
   * workdayEnglishUrl rewrites a /fr-CA/ URL before loading, on the reasoning that a form in
   * another language misses the answer store on every label. Nothing checked that the page STAYED
   * readable, and on 2026-09-03 it did not: the option scan opened Michelin's header language
   * picker and committed a selection, the application turned Thai, and the run filled fifteen
   * fields against labels it could not match — putting "LinkedIn" into "How did you hear about
   * us". Every guard downstream was working; none of them is about this.
   */
  const readablePage = async (): Promise<boolean> => {
    const text = (await root.locator("body").innerText({ timeout: 5_000 }).catch(() => "")) || "";
    const verdict = judgePageLanguage(text);
    if (verdict.readable) return true;
    console.log(
      `  ⛔ this page is not in English (${Math.round(verdict.latinShare * 100)}% Latin letters) — ` +
        `refusing to fill it. Labels would match nothing and the answers would go in the wrong ` +
        `boxes. Seen: "${verdict.sample.slice(0, 70)}"`,
    );
    return false;
  };

  const resumeAlreadyOnPage = async (): Promise<boolean> => {
    // The name the form would be showing: the resume we would have uploaded.
    const fileName = opts.resumePath ? path.basename(opts.resumePath) : "";
    if (!driver.hasResumeOnPage || !fileName) return false;
    const there = await driver.hasResumeOnPage(root, fileName).catch(() => false);
    if (there) console.log(`    ↳ the form is already showing ${fileName} — resume attached`);
    return there;
  };

  const verifyThisPage = async (): Promise<void> => {
    if (!opts.runDir || process.env.PAGE_VERIFY === "0") return;
    // One check per page. The loop asks before deciding a page is done AND before advancing, which
    // on a multi-page form is the same page twice.
    const signature = (await driver.read(root).catch(() => null))?.fields.map((f) => f.label).sort().join("|") ?? "";
    if (signature && verifiedPages.has(signature)) return;
    if (signature) verifiedPages.add(signature);
    // No cap. A long form is exactly the case this exists for, and an application that takes
    // minutes longer but is right beats one that is quick and wrong.
    pagesVerified += 1;
    /**
     * SLICED, because a full-page capture of a long form cannot be read.
     *
     * Measured with paddleocr unreachable: 1761px read in 9-16s, 3080px and 12206px both dead
     * after 301s. It is the pixel height, not the byte size. This check therefore passed on short
     * pages and failed on exactly the long ones it matters most for, which is what refused every
     * approved application and sent it back to be approved again.
     *
     * The full-page shot is still written, because the website shows it and recheck:screens
     * re-judges it. Only the OCR is sliced.
     */
    const shot = path.join(opts.runDir, `page-${pagesVerified}.png`);
    let pageHeight = 0;
    try {
      // The same reason as applyJob's scrollToTop: fullPage is the whole DOCUMENT, and Workday's
      // content sits in a scrollable container, so a capture taken mid-scroll silently loses
      // everything above the fold — the review screenshot came out starting at "Education".
      await page
        .evaluate(`(() => {
          window.scrollTo(0, 0);
          document.documentElement.scrollTop = 0;
          if (document.body) document.body.scrollTop = 0;
          for (const el of Array.from(document.querySelectorAll("*"))) {
            if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight + 4) el.scrollTop = 0;
          }
          return true;
        })()`)
        .catch(() => undefined);
      await page.waitForTimeout(250);
      await captureFormShot(page, shot);
      pageHeight = Number(
        await page.evaluate(
          "(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))()",
        ),
      );
    } catch {
      return;
    }
    const width = Number(
      await page
        .evaluate("(() => document.documentElement.clientWidth || window.innerWidth)()")
        .catch(() => 1440),
    );
    const viewportHeight = page.viewportSize()?.height ?? 1000;

    /**
     * PHOTOGRAPH THE PAGE, THEN CHECK THE PHOTOGRAPHS ARE OF THE PAGE.
     *
     * Two passes, and the second only when the first gives us reason.
     *
     * FIRST PASS — one full-page capture clipped into tall slices. Correct and cheap for a form
     * served in the top document, which is every ATS we drive directly.
     *
     * SECOND PASS — a viewport at a time, scrolling to each band first. This is for a form that
     * is NOT in the top document: C3.ai serves the Greenhouse form as a cross-origin frame
     * injected at runtime, Chromium renders that out of process, and a capture beyond the viewport
     * leaves it WHITE. QDLZFL's full-page shot is 1440x9423 with 5000px of nothing where the
     * application is, and the slices disagree with that same shot band for band even when all of
     * them are taken inside one second: slice2 has content where the full page is blank, slice5 is
     * blank where the full page is at its densest. There is no offset to correct — the frame paints
     * wherever the viewport is at the moment of the capture. What the viewport shows is the only
     * thing that can be trusted, so the fallback photographs the screen.
     *
     * The trigger is EVIDENCE, not a guess about the page: a slice x8ocr read and found no text in.
     * A heuristic (does this page hold a big cross-origin iframe?) could not be checked here —
     * headless, and without the session, C3.ai never renders the embed at all — and a detector
     * nobody can test is worse than a signal we already receive. Blankness also has causes beyond
     * iframes, and this catches those too.
     */
    const shootTiles = async (viewportAtATime: boolean): Promise<Array<string | null>> => {
      const plan = viewportAtATime ? planTiles(pageHeight || 1, viewportHeight) : planTiles(pageHeight || 1);
      if (!viewportAtATime) {
        /**
         * Cut the slices out of a capture taken with the WHOLE DOCUMENT on screen — see formShot.
         * An embedded cross-origin form paints only where the viewport is, so slices clipped out
         * of an ordinary fullPage capture hold white where the application should be.
         */
        const tall = await captureTallTiles(page, plan, (i) =>
          path.join(opts.runDir!, `page-${pagesVerified}-slice${i + 1}.png`),
        );
        if (tall) return tall;
      }
      const out: Array<string | null> = [];
      for (const [i, tile] of plan.entries()) {
        if (!viewportAtATime && plan.length === 1) {
          out.push(shot); // already readable in one piece; do not re-shoot
          break;
        }
        const file = path.join(
          opts.runDir!,
          `page-${pagesVerified}-slice${i + 1}${viewportAtATime ? "-vp" : ""}.png`,
        );
        try {
          if (viewportAtATime) {
            await page.evaluate(`(() => window.scrollTo(0, ${tile.offsetY}))()`).catch(() => undefined);
            await page.waitForTimeout(400);
            const scrolled = Number(
              await page.evaluate("(() => window.scrollY)()").catch(() => tile.offsetY),
            );
            // Clip VIEWPORT-relative here, which is the whole point: what the viewport shows is
            // what has actually painted. At the bottom the page stops scrolling, so the band sits
            // lower in the viewport than its offset suggests.
            const top = Math.max(0, Math.min(tile.offsetY - scrolled, viewportHeight - 1));
            const height = Math.max(1, Math.min(tile.height, viewportHeight - top));
            await page.screenshot({ path: file, clip: { x: 0, y: top, width: width || 1440, height } });
          } else {
            /**
             * fullPage IS REQUIRED FOR THE CLIP TO MEAN WHAT WE INTEND.
             *
             * Without it Playwright clips to the VIEWPORT, so a tile at y=2000 on a 1000px
             * viewport is entirely outside the image: the capture is empty or invalid, and x8ocr
             * rejects it. That is what stopped ID.me being submitted twice after the candidate
             * approved it — "the visual checker did not answer" was the checker refusing our
             * picture, not the checker being down. Verified against Playwright 1.58 on a 10400px
             * page: fullPage with a clip at y=4000 returns exactly the band at y=4000.
             *
             * EVERY SLICE IS SHOT BEFORE ANY OF THEM IS READ. They used to be captured inside the
             * OCR loop, an engine ladder apart — 30 to 60 seconds — and the page does not hold
             * still for that.
             */
            await page.screenshot({
              path: file,
              fullPage: true,
              clip: { x: 0, y: tile.offsetY, width: width || 1440, height: tile.height },
            });
          }
          out.push(file);
        } catch {
          out.push(null);
        }
      }
      return out;
    };

    const firstFiles = await shootTiles(false);
    let layout = await ocrLayoutTiled(async (_tile, i) => firstFiles[i] ?? null, pageHeight || 1).catch(
      () => null,
    );
    if (layout && !layout.unavailable && (layout.blankTiles ?? 0) > 0) {
      console.log(
        `  [ocr] ${layout.blankTiles} of ${layout.tileCount} slice(s) held no text — re-reading the page a viewport at a time`,
      );
      const vpFiles = await shootTiles(true);
      await page.evaluate("(() => window.scrollTo(0, 0))()").catch(() => undefined);
      const second = await ocrLayoutTiled(
        async (_tile, i) => vpFiles[i] ?? null,
        pageHeight || 1,
        viewportHeight,
      ).catch(() => null);
      // Keep whichever pass actually saw the page. The second is normally the fuller one; if it
      // is not, the first was fine and the blank slices were honest white space.
      if (second && !second.unavailable && second.blocks.length > layout.blocks.length) {
        console.log(
          `  [ocr] the viewport pass read ${second.blocks.length} blocks against ${layout.blocks.length} — using it`,
        );
        layout = second;
      }
    }
    /**
     * A CHECKER THAT IS DOWN STOPS THE RUN.
     *
     * Everything else here is best-effort, and that was right while this was a bonus check. It is
     * wrong now: x8ocr is the only thing that can see a field the DOM reader missed, so filling
     * without it is filling blind, and the result would be applications nobody has verified sitting
     * in the queue looking exactly like verified ones.
     */
    if (!layout || layout.unavailable) {
      const why = layout?.unavailable ?? "x8ocr returned nothing";
      // ocrLayout already recorded this outcome into the health window — it is the single writer
      // of what the real checks found, so writing it again here could only disagree with itself.
      throw new OcrUnavailableError(why);
    }
    if (!boxesAreExact(layout.capability) || !textIsLiteral(layout.capability)) return;

    const missing = unansweredOnScreen(layout.blocks, answers().map((a) => ({ label: a.label, value: a.value })));
    if (!missing.length) return;
    console.log(`  👁 the page still requires ${missing.length} answer(s) — filling before moving on:`);
    for (const m of missing) console.log(`     • ${m}`);

    // Re-read and fill only what is still empty. The reader may now see the field the screen named;
    // when it cannot, the required-field gate below reports it rather than the page being left.
    const fresh = await driver.read(root);
    const stillEmpty = [...stillMissing(fresh.fields), ...missingGroups(fresh.fields)];
    if (stillEmpty.length) await fillFields(stillEmpty, false);
  };

  let documentsDone = false;
  let documents: DocumentUploads = { attached: [], missing: [] };
  let historyDone = false;
  let history: HistoryOutcome | undefined;
  let reachedReview = false;
  let noProgress = 0; // consecutive turns that showed the same page and filled nothing new
  const everFilled = new Set<string>(); // labels filled at any point, for progress detection
  let lastSignature = "";
  for (let t = 0; t < maxTurns; t += 1) {
    turns = t + 1;
    root = await driver.resolveRoot(page); // re-resolve — the frame can change between pages
    // ONCE per run. Calling this every turn attached the resume repeatedly — five copies on
    // one Workday application — and each attachment triggered another resume autofill, which
    // is where the duplicated work-experience blocks came from.
    if (!documentsDone) {
      documentsDone = true;
      documents = await driver
        .uploadDocuments(root, opts.resumePath)
        .catch(() => ({ attached: [] as string[], missing: [] as string[] }));
      resumeUploaded = documents.attached.includes("resume");
      // A document the form ASKED FOR and did not get is invisible to every field-level check,
      // because read() excludes file inputs. Say it here or it is never said.
      for (const m of documents.missing) console.log(`    ⚠ missing document: ${m}`);
    }

    // Repeatable Education / Experience sections, ONCE per run and before the read. They are not
    // ordinary fields: each entry must be committed with its own Update before the next can be
    // added, and a committed entry's inputs leave the DOM — so filling them after the read would
    // both miss the other entries and confuse the required-field gate.
    if (!historyDone && driver.fillHistorySections) {
      historyDone = true;
      history = await driver.fillHistorySections(root, ctx).catch((error) => {
        console.log(`    history sections failed: ${(error as Error).message.split("\n")[0]}`);
        return undefined;
      });
      /**
       * Fold what went into the repeatable sections into the run's ANSWERS.
       *
       * These entries are committed to the form and then vanish from the DOM, so without this the
       * work history is invisible everywhere downstream: the review page cannot show it, no fact
       * check can read it, and compareToApproved has nothing to verify at submit. The application
       * carried seven jobs and the record of it carried none.
       */
      for (const e of history?.entries ?? []) {
        if (e.value?.trim()) answersByLabel.set(e.label, { label: e.label, type: "text", value: e.value });
      }
    }

    // Prune BEFORE reading. The resume autofill commits skills the ATS guessed from the PDF,
    // and a committed value reads as filled — so the fill path never revisits it and the wrong
    // ones would go in untouched. Reading after the prune also means the review email shows
    // the form as it will actually be submitted, not as the autofill left it.
    /**
     * ADD THE WORK-EXPERIENCE ROWS THE HISTORY NEEDS, before anything is read.
     *
     * Workday renders one row and waits for a click on "Add" for each further one, and nothing
     * here ever clicked it — so every application carried exactly ONE job out of the seven on the
     * resume. It read as a truncated screenshot rather than a missing employment history.
     *
     * How many: the resume's own count, capped by MAX_EXPERIENCE_BLOCKS (default 3, the most
     * recent roles). The cap is not squeamishness about the history — the resume is attached and
     * carries all of it — it is that each row is six more fields to fill and verify on a live
     * form, and a run that stalls on row seven delivers nothing. Raise it with the env var.
     */
    /**
     * SAY WHICH PRE-READ STEP WE ARE IN.
     *
     * An Akuna Capital run stopped dead after "✓ resume attached" — twice, reproducibly — and the
     * log said nothing more, so there was no way to tell which of the four things that happen
     * before read() had swallowed it. A hang inside a single await is invisible to maxTurns and to
     * the worker, which goes on reporting "busy" truthfully for as long as it lasts.
     *
     * One short line per step. Cheap, and the difference between "it hangs somewhere" and a bug
     * report.
     */
    const step = (what: string) => {
      if (process.env.QUIET_STEPS !== "1") console.log(`      · ${what}`);
    };

    step("expanding repeated sections");
    if (driver.expandRepeatedBlocks) {
      /**
       * ALL OF THEM, because the readiness gate already insists on all of them.
       *
       * This was capped at 3 on my own reasoning that each row is six more fields to fill on a
       * live form. TMEIC then went from "only 1 of 7 work-experience entries from the resume went
       * in" to "only 6 of 7" and was STILL refused — by our own gate, which has always wanted the
       * full history. A cap that fights the gate delivers nothing: the rows cost real time and
       * then the application is held back anyway.
       *
       * MAX_EXPERIENCE_BLOCKS still overrides, for a form that will not take seven.
       */
      const onResume = opts.experienceCount ?? 0;
      const cap = Number(process.env.MAX_EXPERIENCE_BLOCKS ?? onResume);
      const wanted = Math.min(onResume, Number.isFinite(cap) && cap > 0 ? cap : onResume);
      if (wanted > 1) {
        const grown = await driver.expandRepeatedBlocks(root, wanted).catch(() => []);
        for (const g of grown) {
          console.log(`    + "${g.section}": ${g.from} → ${g.to} row(s) for ${onResume} on the resume`);
          filled.push(`${g.section} — added ${g.to - g.from} row(s) (${g.to} of ${onResume} on the resume)`);
        }
      }
    }

    /**
     * DUPLICATES FIRST. Pony.ai reached review listing Carnegie Mellon three times and BART twice,
     * because the ATS's own resume parse committed them and nothing ever removed one. Before the
     * read, for the same reason as the skills prune: the review has to show the form as it will be
     * submitted, and a duplicate that appears after the read is one nobody sees.
     */
    step("removing duplicate profile entries");
    if (driver.pruneDuplicateEntries) {
      const gone = await driver.pruneDuplicateEntries(root).catch(() => [] as string[]);
      for (const g of gone) filled.push(`removed a duplicate entry the form already carried: ${g}`);
    }

    step("pruning autofilled skills");
    if (driver.pruneSkills) {
      const dropped = await driver.pruneSkills(root).catch(() => [] as string[]);
      if (dropped.length) {
        console.log(`    ✂ removed ${dropped.length} autofilled skill(s): ${dropped.join(", ")}`);
        // Recorded in the human-readable fill list, never in `answers`: answers is what the
        // replay types and what compareToApproved checks value-for-value, and a removal is
        // not a value the form holds.
        filled.push(`Skills — removed autofilled: ${dropped.join(", ")}`);
      }
    }

    step("checking the page language");
    // Before anything is read or filled: is this page in a language whose labels can match?
    if (!(await readablePage())) {
      break;
    }
    step("reading the form");
    /**
     * THE WHOLE READ NEEDS THE DEADLINE, not just its page script.
     *
     * Akuna Capital's Greenhouse form hangs here, and I bounded the wrong half first: the evaluate
     * that builds the field list got a 60s race and the run STILL sat there, because the expensive
     * part comes after it — per-field option enrichment, where a speculative locator read without
     * an explicit timeout waits Playwright's default 30 SECONDS PER ROW. CLAUDE.md records that
     * exact failure costing 776 field timeouts in one batch; this is another instance of it, and
     * one long option list is enough to outlast any patience.
     *
     * So the deadline goes around read() itself. A page whose read cannot finish in
     * READ_TIMEOUT_MS is reported and the run ends — which is a diagnosable minute instead of the
     * twenty the run deadline used to take, three times on this one form.
     */
    /**
     * FIVE MINUTES, NOT ONE. 60s was too tight and it killed a healthy run.
     *
     * This cap exists to stop a read HANGING for twenty minutes, not to judge a slow page. At 60s
     * it abandoned Michelin's autofill page — a form with 250-option country lists and seven
     * experience rows, mid "transient error — refreshing and retrying" — and the re-fill the
     * candidate was waiting on died on my own guard.
     *
     * CLAUDE.md already records this exact mistake one line over: "Do not shorten
     * FIELD_TIMEOUT_MS. It is 90s. Lowering it to 30s broke Country Phone Code on RTX... The cost
     * of a field that will never accept a value belongs to whatever DETECTS that, not to a
     * deadline short enough to fail the slow ones too." A read deadline is the same bargain, and I
     * picked the same wrong side of it.
     *
     * 5 minutes is far past any legitimate read and still a quarter of the run deadline, so a real
     * hang is caught four times sooner than before this guard existed.
     */
    const readMs = Number(process.env.READ_TIMEOUT_MS ?? 5 * 60_000);
    let readTimer: NodeJS.Timeout | undefined;
    const snapshot = await Promise.race([
      driver.read(root),
      new Promise<never>((_, reject) => {
        readTimer = setTimeout(
          // NOT `where`: that is declared below, from the page label read AFTER this. Referencing
          // it here compiles and then throws ReferenceError inside the timer — which crashed the
          // whole worker twice, losing the run in flight, because an exception in a setTimeout
          // callback has nothing to catch it. The URL is available and is enough to identify the
          // page.
          () => reject(new Error(`reading the form took longer than ${Math.round(readMs / 1000)}s — abandoning the run rather than holding the browser (${String(page.url()).slice(0, 120)})`)),
          readMs,
        );
      }),
    ]).finally(() => {
      if (readTimer) clearTimeout(readTimer);
    });
    /**
     * SAY WHICH PAGE THIS IS. Every turn, from the page itself — not inferred from how many fields
     * came back. "17 field(s)" told nobody whether this was My Information for the third time or
     * My Experience for the first.
     */
    const where = driver.pageLabel ? await driver.pageLabel(root).catch(() => "") : "";
    if (where) console.log(`    on ${where}`);
    /**
     * EACH PAGE CONTRIBUTES ITS LATEST SNAPSHOT, NOT ITS FIRST.
     *
     * This was a first-sighting map: a field seen once was kept forever, with the `filled` state
     * it had at that moment. So when ticking "I currently work here" on Work Experience 1 made
     * Workday REMOVE that row's To date — the screenshot shows only From* 08/2026, there is no To
     * box on the page — the two To fields stayed on the record as required and unanswered, and the
     * readiness gate refused a finished application over fields the form itself had taken away.
     * Michelin was blocked on exactly that, twice.
     *
     * Keyed by PAGE, because the union across pages is what a multi-page form is: My Information's
     * fields are legitimately absent while we are on My Experience, so "not in the last read"
     * cannot mean "gone" globally. Within one page, the newest read wins and fields that vanished
     * from it are dropped — and every field's `filled` state is the final one rather than a
     * mid-fill guess.
     *
     * A read that came back EMPTY replaces nothing: a page that failed to read is not a page whose
     * fields all disappeared.
     */
    const pageKey = where || `turn-${turns}`;
    if (snapshot.fields.length) {
      const forPage = new Map<string, FieldSpec>();
      for (const f of snapshot.fields) forPage.set(`${f.label}\u0000${f.type}`, f);
      observedByPage.set(pageKey, forPage);
    }
    console.log(`  [turn ${turns}] ${snapshot.fields.length} field(s), submitReady=${snapshot.submitReady}`);
    const filledBefore = filled.length;

    // First pass: answer everything the reader found.
    await fillFields(snapshot.fields, true);

    // Required-field gate: re-read and make sure no REQUIRED field is still empty
    // before we advance. We never want to reach Review with empty red-star fields.
    // Try up to 2 more targeted passes (auto, then terminal-learning) on just the
    // stragglers — a field can miss the first pass (options captured late, an
    // option that didn't match, a value that failed to stick).
    let after = await driver.read(root);
    let missing = [...stillMissing(after.fields), ...missingGroups(after.fields)];
    for (let attempt = 0; attempt < 2 && missing.length > 0; attempt += 1) {
      console.log(`  ${missing.length} required field(s) still empty — retry pass ${attempt + 1}: ${missing.map((f) => f.label).join(" | ")}`);
      await fillFields(missing, attempt === 1); // enable learning on the final pass
      await page.waitForTimeout(500);
      after = await driver.read(root);
      missing = [...stillMissing(after.fields), ...missingGroups(after.fields)];
    }

    /**
     * VERIFY BEFORE DECIDING THIS PAGE IS DONE, not only before advancing.
     *
     * A single-page form never advances — it breaks out here at submitReady — so the check that was
     * wired in before `next()` never ran on one. Measured on a 42-application batch: 14 page
     * screenshots across the whole run, all of them from the few multi-page forms, while every
     * Greenhouse and Ashby application skipped it entirely. That is most of the queue, and exactly
     * the forms the check was built for.
     */
    if (after.submitReady) {
      await verifyThisPage();
      after = await driver.read(root);
      missing = [...stillMissing(after.fields), ...missingGroups(after.fields)];
    }

    if (after.submitReady) {
      // Only treat Review as reached if nothing required is left empty.
      if (missing.length === 0) {
        /**
         * ASK THE FORM before believing our own reading.
         *
         * read() cannot see a file input — they are excluded — so a REQUIRED upload is invisible to
         * `missing`, and two applications reached "ready for review" with a required transcript
         * unattached while the page itself printed "This field is required." under the very field.
         * The form's own words outrank anything inferred here, and until now they were only
         * consulted when the loop was already STUCK: a single-page Greenhouse form fills, sees
         * Submit, and never asks.
         *
         * A validation message the form is showing means the form is not ready, whatever we think.
         */
        const showing = (await driver.validationErrors?.(root).catch(() => [])) ?? [];
        if (showing.length) {
          blockedRequired = showing.map((e) => `form says: ${e}`);
          console.log(
            `  ⚠ Submit is present and nothing reads as empty, but the FORM is showing ${showing.length} error(s) — NOT review-ready: ${showing
              .map((e) => `"${e}"`)
              .join("; ")}`,
          );
          break;
        }
        reachedReview = true;
        console.log("  Submit control reached, all required fields filled — stopping (never clicked).");
        break;
      }
      blockedRequired = missing.map((f) => f.label);
      /**
       * STUDY WHAT THE RUN IS ABOUT TO GIVE UP ON.
       *
       * Not every failure announces itself as "the field would not take it". The Uline one does
       * the opposite: the fields report filled, and only the final read finds them empty - so
       * nothing was ever studied, four retries in a row, and each retry was a hope rather than a
       * question. His words: "otherwise, you just hope things will fix by itself which it will
       * NOT."
       *
       * At most three, because this costs a model call each and the first three are enough to see
       * what kind of failure it is.
       */
      for (const f of missing.slice(0, 3)) {
        if (!driver.studyFailedField || studied.has(f.label)) continue;
        studied.add(f.label);
        await driver
          .studyFailedField(root, f, {
            ats: driver.type ?? "unknown",
            ...(opts.runDir ? { runDir: opts.runDir } : {}),
          })
          .catch(() => "");
      }
      console.log(`  ⚠ Submit is present but ${missing.length} required field(s) are still empty — NOT advancing to submit: ${blockedRequired.join(" | ")}`);
      break;
    }

    if (missing.length > 0) {
      // Required fields we cannot fill automatically and (in non-interactive runs)
      // cannot ask about. Refuse to advance into holes — stop and report them.
      blockedRequired = missing.map((f) => f.label);
      console.log(`  ⚠ ${missing.length} required field(s) unfilled and unresolved — stopping before advancing: ${blockedRequired.join(" | ")}`);
      break;
    }

    // Guard against a stuck step. Compare the LABELS filled and the page's field set, not
    // the cumulative count: re-filling the same fields each turn kept `filled.length`
    // rising, so this never fired and one job burned all 18 turns on an unchanged page.
    void filledBefore;
    const newLabels = [...filledLabels].filter((l) => !everFilled.has(l));
    for (const l of newLabels) everFilled.add(l);
    const signature = after.fields.map((f) => f.label).sort().join("|");
    if (newLabels.length === 0 && signature === lastSignature) {
      noProgress += 1;
      // A form that is ACTIVELY REJECTING the page needs no second opinion. GE Vernova DUSKAZ ran
      // SIXTEEN turns re-answering the same thirteen fields while the page said "94085 is not a
      // valid postal code for Pennsylvania" the entire time — roughly ten minutes to reach a
      // conclusion that was available on turn four. If nothing new was filled AND the form is
      // showing a blocking error, another identical turn cannot change it.
      const blocking = (await driver.validationErrors?.(root).catch(() => [])) ?? [];
      if (blocking.length) {
        blockedRequired = blocking.map((e) => `form error: ${e}`);
        console.log(`  Form is rejecting the page and nothing new is being filled — stopping. ${blocking.map((e) => `"${e}"`).join("; ")}`);
        break;
      }
      if (noProgress >= 2) {
        // Report what the FORM says is wrong, not just that we stopped making progress.
        const errors = (await driver.validationErrors?.(root).catch(() => [])) ?? [];
        if (errors.length) {
          blockedRequired = errors.map((e) => `form error: ${e}`);
          console.log(`  Form is rejecting the page — ${errors.map((e) => `"${e}"`).join("; ")}`);
        }
        console.log(`  Same ${after.fields.length} field(s) and nothing new filled for ${noProgress + 1} turns (stuck) — stopping.`);
        break;
      }
    } else {
      noProgress = 0;
    }
    lastSignature = signature;

    /**
     * CHECK THE PAGE BEFORE LEAVING IT.
     *
     * The whole-application check runs on the review screenshot, at the end. On a single-page form
     * that is the same moment; on a multi-page one it is far too late — the only remedy a late
     * verdict allows is "go back to page three and try again", which is slower and less reliable
     * than never advancing with a required question unanswered.
     *
     * This asks the SCREEN what it still requires, which is the one question our own reader cannot
     * answer about itself: five required Ashby questions were invisible to read(), so nothing in
     * the DOM path knew they existed. Anything it names is filled here, on the page where it was
     * found, before the form moves on.
     */
    await verifyThisPage();

    if (!(await driver.next(root))) {
      console.log("  No next control — stopping.");
      break;
    }
    await page.waitForTimeout(1500);
  }

  /**
   * ASK THE PAGE whether we just applied, however the run ended.
   *
   * "No next control — stopping" and "Thank you for applying" look identical from inside the loop:
   * both mean read() found no fields. Applications went in that way and were recorded as pending.
   * One read at the end tells them apart.
   *
   * WHOSE SUBMISSION, though. The candidate applies by hand too — he did to SpaceX rather than wait
   * for this system — and arriving at a page he already submitted also shows a confirmation.
   * Blaming the run for that would be a false accusation, and excusing a real one is worse.
   *
   * The discriminator is whether we ever had a FORM. If this run read fields, the form was live when
   * we arrived and something between then and now submitted it — us. If we never saw a field, the
   * confirmation was there before we were, and that is `alreadyApplied`, which this system has
   * always known how to record.
   */
  const confirmation = (await driver.submissionConfirmed?.(root).catch(() => false)) ?? false;
  const sawAForm = observed().size > 0;
  const submittedUnexpectedly = confirmation && sawAForm;
  if (submittedUnexpectedly) {
    console.log(
      `  ⛔ THE PAGE IS A SUBMISSION CONFIRMATION and this run read ${observed().size} field(s) on the way — ` +
        "the form was live when we arrived, so this application went in DURING THIS RUN, without approval.",
    );
  } else if (confirmation) {
    console.log("  ↳ the page is a confirmation and we never saw a form — already applied before this run.");
  }

  return {
    turns,
    filled,
    answers: answers(),
    drafts,
    unknown,
    failedToFill,
    observedFields: [...observed().values()],
    reachedReview,
    alreadyApplied: confirmation && !sawAForm,
    blockedRequired,
    submittedUnexpectedly,
    /**
     * ASK THE PAGE, if this run did not upload. Resuming a Workday draft starts at My Information
     * with the resume already attached from a previous session, so `resumeUploaded` is false and
     * the gate refused a Review-ready application with "no resume was attached". uploadDocuments
     * learned this lesson once already, by filename, and it did not reach here.
     */
    resumeAttached: resumeUploaded || (await resumeAlreadyOnPage()),
    history,
    documents,
  };
}

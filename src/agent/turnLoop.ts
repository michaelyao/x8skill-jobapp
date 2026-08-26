import type { Page } from "playwright";
import type { Agent, AgentContext, AtsDriver, FieldSpec, FilledAnswer } from "./types.js";

export interface TurnLoopOptions {
  resumePath: string;
  maxTurns?: number;
  interactive?: boolean; // pause for a human when a field needs manual input
  // Ask the user (in the terminal) for a field's value. Returns the value to
  // fill, or null to leave it for manual handling.
  onLearn?: (field: FieldSpec) => Promise<string | null>;
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
  alreadyApplied: boolean;
  blockedRequired: string[]; // required fields still empty that blocked advancing
  /** Was the resume actually attached this run? Feeds the whole-application sanity check —
   *  an application with no resume is not an application. */
  resumeAttached: boolean;
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
  const observed = new Map<string, FieldSpec>(); // label+type → first sighting, insertion-ordered
  let blockedRequired: string[] = [];
  const answers = () => [...answersByLabel.values()];
  // How many times a field we believe we filled has come back empty on re-read.
  const disputed = new Map<string, number>();
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
    return { turns: 0, filled, answers: answers(), drafts, unknown, failedToFill, observedFields: [], reachedReview: false, alreadyApplied: true, blockedRequired, resumeAttached: false };
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
        if (!unknown.includes(field.label)) unknown.push(field.label);
        // Log it. This branch used to skip silently, which is why a field could vanish from
        // the run with no trace and leave "no answer available" impossible to interpret —
        // was it tried, or never reached?
        console.log(`    – no answer available, left for you: ${field.label.slice(0, 70)}`);
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
        // A ticked box satisfies its whole group; an untouched one ("No") does not.
        if (field.groupKey && field.groupLabel && /^(yes|true|checked)/i.test(answer.value.trim())) {
          filledLabels.add(`group:${field.groupLabel}`);
        }
        answersByLabel.set(field.label, { label: field.label, type: field.type, value: answer.value, widget: field.widget, draft: answer.draft });
        if (answer.draft) drafts.push(field.label);
        console.log(`    ✓ ${field.label}${answer.draft ? " (DRAFT — review)" : ""}`);
      } else {
        if (!failedToFill.includes(field.label)) failedToFill.push(field.label);
        console.log(`    ✗ tried but the field would not take it: ${field.label}`);
      }
    }
  };

  let turns = 0;
  let resumeUploaded = false;
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
    if (!resumeUploaded) {
      resumeUploaded = await driver.uploadDocuments(root, opts.resumePath).catch(() => false);
      if (resumeUploaded) console.log("    ✓ resume attached");
    }

    // Prune BEFORE reading. The resume autofill commits skills the ATS guessed from the PDF,
    // and a committed value reads as filled — so the fill path never revisits it and the wrong
    // ones would go in untouched. Reading after the prune also means the review email shows
    // the form as it will actually be submitted, not as the autofill left it.
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

    const snapshot = await driver.read(root);
    for (const f of snapshot.fields) {
      const k = `${f.label}\u0000${f.type}`;
      if (!observed.has(k)) observed.set(k, f);
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

    if (after.submitReady) {
      // Only treat Review as reached if nothing required is left empty.
      if (missing.length === 0) {
        reachedReview = true;
        console.log("  Submit control reached, all required fields filled — stopping (never clicked).");
        break;
      }
      blockedRequired = missing.map((f) => f.label);
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

    if (!(await driver.next(root))) {
      console.log("  No next control — stopping.");
      break;
    }
    await page.waitForTimeout(1500);
  }

  return {
    turns,
    filled,
    answers: answers(),
    drafts,
    unknown,
    failedToFill,
    observedFields: [...observed.values()],
    reachedReview,
    alreadyApplied: false,
    blockedRequired,
    resumeAttached: resumeUploaded,
  };
}

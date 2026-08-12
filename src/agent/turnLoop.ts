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

export interface TurnLoopResult {
  turns: number;
  filled: string[]; // "label: value" that were filled
  answers: FilledAnswer[]; // structured record of every filled field (for replay on submit)
  drafts: string[]; // labels of LLM-drafted free-text (review before submit)
  unknown: string[]; // labels left for a human (sensitive/ungrounded)
  reachedReview: boolean; // the Submit control was reached (we never click it)
  alreadyApplied: boolean;
  blockedRequired: string[]; // required fields still empty that blocked advancing
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
  let blockedRequired: string[] = [];
  const answers = () => [...answersByLabel.values()];
  // A required field blocks only if it's confirmed empty AND we didn't successfully
  // fill it. Workday's custom widgets (comboboxes, radios) often report filled=false
  // on re-read even when set, so trust our own successful fill over the flaky signal.
  const stillMissing = (fields: FieldSpec[]): FieldSpec[] =>
    fields.filter((f) => f.required && f.filled === false && !filledLabels.has(f.label));

  await driver.openApplication(page);
  let root = await driver.resolveRoot(page);
  if (await driver.isAlreadyApplied(root)) {
    return { turns: 0, filled, answers: answers(), drafts, unknown, reachedReview: false, alreadyApplied: true, blockedRequired };
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
        continue;
      }
      const ok = await driver.fill(root, field, answer).catch(() => false);
      if (ok) {
        filled.push(`${field.label}: ${answer.value}${answer.draft ? " (DRAFT)" : ""}`);
        filledLabels.add(field.label);
        answersByLabel.set(field.label, { label: field.label, type: field.type, value: answer.value, widget: field.widget, draft: answer.draft });
        if (answer.draft) drafts.push(field.label);
        console.log(`    ✓ ${field.label}${answer.draft ? " (DRAFT — review)" : ""}`);
      } else {
        if (!unknown.includes(field.label)) unknown.push(field.label);
        console.log(`    ✗ could not fill: ${field.label}`);
      }
    }
  };

  let turns = 0;
  let reachedReview = false;
  let noProgress = 0; // consecutive turns that read no fields and filled nothing
  for (let t = 0; t < maxTurns; t += 1) {
    turns = t + 1;
    root = await driver.resolveRoot(page); // re-resolve — the frame can change between pages
    await driver.uploadDocuments(root, opts.resumePath).catch(() => undefined);

    const snapshot = await driver.read(root);
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
    let missing = stillMissing(after.fields);
    for (let attempt = 0; attempt < 2 && missing.length > 0; attempt += 1) {
      console.log(`  ${missing.length} required field(s) still empty — retry pass ${attempt + 1}: ${missing.map((f) => f.label).join(" | ")}`);
      await fillFields(missing, attempt === 1); // enable learning on the final pass
      await page.waitForTimeout(500);
      after = await driver.read(root);
      missing = stillMissing(after.fields);
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

    // Guard against a stuck step: if no NEW fields got filled this turn, we're
    // not making progress (validation gate, unmatchable option, etc.).
    if (filled.length === filledBefore) {
      noProgress += 1;
      if (noProgress >= 3) {
        console.log("  No new fields filled for 3 turns (stuck) — stopping.");
        break;
      }
    } else {
      noProgress = 0;
    }

    if (!(await driver.next(root))) {
      console.log("  No next control — stopping.");
      break;
    }
    await page.waitForTimeout(1500);
  }

  return { turns, filled, answers: answers(), drafts, unknown, reachedReview, alreadyApplied: false, blockedRequired };
}

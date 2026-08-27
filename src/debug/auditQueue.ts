import fs from "node:fs";
import path from "node:path";
import { loadPendingQueue } from "../knowledge/approvalQueue.js";
import { loadProfile } from "../knowledge/profile.js";
import { parseResumeHistory } from "../knowledge/resumeHistory.js";
import { reviewApplication } from "../core/applicationSanity.js";
import { DATA_DIR } from "../config.js";
import type { FieldSpec, FilledAnswer } from "../agent/types.js";

/**
 * Run the current guardrails over every application ALREADY waiting for approval.
 *
 *   npx tsx src/debug/auditQueue.ts            # report
 *   npx tsx src/debug/auditQueue.ts --json     # machine-readable
 *
 * Every guardrail in this project checks an application as it is being filled. None of them ever
 * looked at the queue, so everything filled before they existed sits there unexamined — and those
 * are exactly the applications most likely to be wrong, because they were produced by the code the
 * guardrails were written in response to. Four were found by a human reading the review page one at
 * a time; this asks the question of all of them at once.
 *
 * READ-ONLY. It writes nothing and re-fills nothing: it names the applications that would now be
 * refused, so the re-fills can be a deliberate decision rather than a side effect of an audit.
 *
 * Necessarily a PARTIAL audit, and the gaps are stated rather than glossed:
 *   - `documents` and `history` were not recorded before those checks existed, so a missing
 *     transcript or a 1-of-7 history CANNOT be detected retrospectively for older entries. Absence
 *     of a finding here is not evidence the application is complete.
 *   - The visual (OCR) cross-check needs the screenshot, which is on disk but would take 25-56s
 *     each. Not run; see --shots to list which entries still have one.
 */

interface RoundFile {
  fields?: FieldSpec[];
  answers?: FilledAnswer[];
  outcome?: string;
}

/** The newest recorded round for a job code — that is the fill the queue entry describes. */
function newestRound(code: string): { file: string; data: RoundFile } | undefined {
  const dir = path.join(DATA_DIR, "rounds", code);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return undefined;
  }
  let best: { file: string; mtime: number } | undefined;
  for (const name of names) {
    const file = path.join(dir, name);
    const mtime = fs.statSync(file).mtimeMs;
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  if (!best) return undefined;
  try {
    return { file: best.file, data: JSON.parse(fs.readFileSync(best.file, "utf8")) as RoundFile };
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const profile = await loadProfile();
  const edu = parseResumeHistory(profile.resumeText || profile.rawText || "").education[0];
  const facts = { degree: edu?.degree, fieldOfStudy: edu?.fieldOfStudy, gpa: profile.gpa ?? edu?.gpa };

  const queue = await loadPendingQueue();
  const awaiting = queue.filter((e) => e.status === "awaiting_approval");

  const findings: Array<{ code: string; company: string; title: string; problems: string[]; shot?: string }> = [];
  let audited = 0;
  let noRound = 0;

  for (const entry of awaiting) {
    const code = entry.code ?? entry.key;
    const round = newestRound(code);
    if (!round) {
      noRound += 1;
      continue;
    }
    audited += 1;
    const problems = reviewApplication({
      /**
       * The ENTRY's answers, not the round's — this must judge what would actually be submitted.
       *
       * The first version read `round.answers`, and after a failed re-fill that is the FAILED
       * attempt's answers, not the queued ones. It condemned nine applications; DVDFRR turned out
       * to hold School "Carnegie Mellon University", Degree "Bachelor's Degree" and GPA 3.53 all
       * along — complete, and reported as broken because the newest round was a re-fill that had
       * stopped early with 8 of 19 answers.
       *
       * An audit that cries wolf is worse than no audit: it sent nine unnecessary re-fills at a
       * live employer's form. Same source as the submit gate now, so the two always agree.
       */
      answers: (entry.answers ?? []) as FilledAnswer[],
      // Fields still come from the round — the queue entry does not record them, and they are what
      // makes "the form asked for education" answerable at all.
      observedFields: round.data.fields ?? [],
      // Not knowable retrospectively — assume the resume went on, so this cannot raise a
      // false "no resume" on every historical entry.
      resumeAttached: true,
      facts,
      // history/documents deliberately omitted: they were not recorded then. See the header.
    }).map((p) => p.message);

    if (problems.length) {
      findings.push({
        code,
        company: entry.company ?? "?",
        title: entry.title ?? "?",
        problems,
      });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ awaiting: awaiting.length, audited, noRound, findings }, null, 2));
    return;
  }

  console.log(`\n${awaiting.length} application(s) awaiting approval · ${audited} audited · ${noRound} with no round file\n`);
  if (!findings.length) {
    console.log("No application in the queue fails the current guardrails.\n");
  } else {
    console.log(`${findings.length} would now be REFUSED:\n`);
    for (const f of findings) {
      console.log(`  ${f.code}  ${f.company.slice(0, 28)} — ${f.title.slice(0, 44)}`);
      for (const p of f.problems) console.log(`      • ${p}`);
    }
    console.log(`\nRe-fill them with:  ${findings.map((f) => f.code).join(" ")}`);
  }
  console.log(
    `\nPARTIAL: history (n-of-m entries) and documents (missing transcript) were not recorded\n` +
      `before those checks existed, so they cannot be judged retrospectively. A clean result here\n` +
      `does NOT mean an old application is complete — only that nothing detectable is wrong.\n`,
  );
}

void main();

import { loadPendingQueue } from "../knowledge/approvalQueue.js";
import { loadProfile } from "../knowledge/profile.js";
import { splitQueue } from "../core/queueReadiness.js";

/**
 * Run the current guardrails over every application ALREADY waiting for approval.
 *
 *   npm run audit:queue            # report
 *   npm run audit:queue --json     # machine-readable
 *
 * Every guardrail here checks an application while it is being FILLED. None ever looked at the
 * queue, so everything filled before they existed sat there unexamined — and those are the ones
 * most likely to be wrong, because they were produced by the code the guardrails were written in
 * response to.
 *
 * It shares splitQueue with the website's /queue page and with what submitApprovedEntry refuses, so
 * the report, the list you look at and the actual refusal can never disagree. READ-ONLY: it names
 * what would be refused; the re-fills stay a decision.
 *
 * PARTIAL BY CONSTRUCTION: history counts (n-of-m entries) and document uploads were not recorded
 * before those checks existed, so a 1-of-7 history or a missing transcript cannot be judged
 * retrospectively. A clean result does NOT mean an old application is complete.
 */
async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const profile = await loadProfile();
  const entries = (await loadPendingQueue()).filter((e) => e.status === "awaiting_approval");
  const { ready, needsWork } = splitQueue(entries, profile);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          awaiting: entries.length,
          ready: ready.length,
          findings: needsWork.map((n) => ({
            code: n.entry.code,
            company: n.entry.company,
            title: n.entry.title,
            problems: n.problems,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\n${entries.length} awaiting approval · ${ready.length} ready for review · ${needsWork.length} not ready\n`);
  if (!needsWork.length) {
    console.log("Every queued application passes the current guardrails.\n");
  } else {
    for (const { entry, problems } of needsWork) {
      console.log(`  ${entry.code}  ${(entry.company ?? "?").slice(0, 28)} — ${(entry.title ?? "?").slice(0, 44)}`);
      for (const p of problems) console.log(`      • ${p}`);
    }
    console.log(`\nRe-fill them with:  ${needsWork.map((n) => n.entry.code).join(" ")}`);
  }
  console.log(
    `\nPARTIAL: history (n-of-m entries) and documents (missing transcript) were not recorded\n` +
      `before those checks existed, so they cannot be judged retrospectively. A clean result here\n` +
      `does NOT mean an old application is complete — only that nothing detectable is wrong.\n`,
  );
}

void main();

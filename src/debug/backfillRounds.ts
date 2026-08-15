import { loadPendingQueue } from "../knowledge/approvalQueue.js";
import { listRounds, saveRound } from "../knowledge/rounds.js";

/**
 * The history only starts from the moment rounds were introduced, which would leave every job
 * already in the queue with nothing to compare against — including the ones under dispute.
 *
 * The queue does hold what was approved, so a first copy can be rebuilt from it: the answers
 * are exact, and each answered question implies a field. The field list is therefore INCOMPLETE
 * (unanswered questions leave no trace), so these rounds are marked `reconstructed` and the UI
 * says so. A partial baseline that is labelled partial beats no baseline.
 *
 *   npx tsx src/debug/backfillRounds.ts          # report only
 *   npx tsx src/debug/backfillRounds.ts --write
 */

const write = process.argv.includes("--write");

const queue = await loadPendingQueue();
let created = 0;
let skipped = 0;

for (const entry of queue) {
  const code = entry.code;
  if (!code || !entry.answers?.length) {
    skipped += 1;
    continue;
  }
  // Never fabricate a baseline over observed history — a real round always wins.
  const existing = await listRounds(code);
  if (existing.length) {
    skipped += 1;
    continue;
  }

  const round = {
    code,
    reconstructed: true,
    phase: "fill" as const,
    at: entry.reviewSentAt ?? entry.updatedAt,
    url: entry.applyUrl,
    fields: entry.answers.map((a) => ({
      label: a.label,
      type: "unknown",
      // Required-ness was not recorded per answer; claiming "required" would invent a fact,
      // so it is left false and a later diff simply cannot report a required-ness change.
      required: false,
    })),
    answers: entry.answers.map((a) => ({ label: a.label, value: a.value, draft: a.draft })),
    outcome: `reconstructed from the approval queue (status: ${entry.status})`,
  };

  if (write) await saveRound(round);
  created += 1;
  console.log(`${write ? "wrote" : "would write"} ${code} — ${entry.company} · ${entry.answers.length} answers @ ${round.at}`);
}

console.log(`\n${created} baseline round(s) ${write ? "written" : "pending (run with --write)"}, ${skipped} skipped.`);

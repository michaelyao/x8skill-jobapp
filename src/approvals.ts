import { loadEnv } from "./utils/env.js";
import { scanEmailForDecisions } from "./knowledge/emailScan.js";

/**
 * One-shot inbox scan: read APPROVE / SKIP / CHANGE replies and hand them to the worker.
 *
 * This file used to BE the email executor — it launched its own Chrome, re-filled forms and
 * submitted, carrying its own copy of the double-submit guards. That copy had already drifted
 * from the one in submitApprovedEntry, and two processes driving a single-instance browser
 * profile were only ever kept apart by a lock file.
 *
 * Now the worker owns execution and scans the inbox on its own timer (EMAIL_POLL_MS). This
 * command remains for the times you want a scan RIGHT NOW without waiting for that timer —
 * it enqueues, it does not act, and it is safe to run while the worker is busy.
 *
 *   npm run approvals
 */

loadEnv();

const result = await scanEmailForDecisions();

if (!result.candidates) {
  console.log("No queued application has a reply waiting.");
} else {
  console.log(`${result.candidates} queued application(s) have a reply.`);
}
for (const note of result.notes) console.log(`  · ${note}`);
for (const item of result.enqueued) {
  console.log(`  → [${item.code}] ${item.decision.toUpperCase()} queued for the worker (${item.command})`);
}
if (result.candidates && !result.enqueued.length && !result.notes.length) {
  console.log("  (nothing new — every reply here has already been acted on)");
}
console.log(
  result.enqueued.length
    ? "\nThe worker picks these up within ~10s. Watch it with: jobapp status"
    : "\nNothing to do.",
);

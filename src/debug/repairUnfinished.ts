/**
 * `npx tsx src/debug/repairUnfinished.ts [--write]`
 *
 * Ledger records that say "filled, left at the review step" for runs that never reached it.
 *
 * applyJob recorded `prefilled_pending_submit` whenever a run stopped before review. That status
 * is in ENGAGED_STATUSES, so each of those jobs is skipped by every future sweep — they were
 * retired without ever being finished. The code no longer does it; these are the ones already
 * written, accumulating since 28 August.
 *
 * A run that reached review ALWAYS enqueued to pending-approvals, and queue entries are kept after
 * a decision (submitted and skipped ones are still there). So a `prefilled_pending_submit` record
 * with NO queue entry never reached review. A review screenshot is accepted as evidence too —
 * belt and braces, because getting this wrong in the other direction would re-open applications
 * that are genuinely finished.
 *
 * Dry by default. --write moves the survivors to `error`, which is not an engaged status, so the
 * next sweep sees the job again.
 */
import fs from "node:fs";
import path from "node:path";
import { APPLICATIONS_JSON_PATH } from "../config.js";
import { loadApplications } from "../knowledge/applications.js";

const write = process.argv.includes("--write");
const records = await loadApplications();

const queueRaw = JSON.parse(fs.readFileSync("data/pending-approvals.json", "utf8"));
const entries = Array.isArray(queueRaw) ? queueRaw : (queueRaw.entries ?? queueRaw);
const queueCodes = new Set<string>(
  (Array.isArray(entries) ? entries : Object.values(entries)).map((e: { code?: string }) => String(e?.code ?? "")),
);

const hasReviewShot = (code: string): boolean => {
  for (const dir of fs.readdirSync("logs", { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    if (fs.existsSync(path.join("logs", dir.name, `review-${code}.png`))) return true;
  }
  return false;
};

const claimed = records.filter((r) => r.status === "prefilled_pending_submit");
const unfinished = claimed.filter((r) => {
  const code = String((r as { code?: string }).code ?? r.id ?? "");
  return code && !queueCodes.has(code) && !hasReviewShot(code);
});

console.log(`  ledger: ${records.length} records`);
console.log(`  claiming "filled, left at review": ${claimed.length}`);
console.log(`  of those, no queue entry AND no review screenshot: ${unfinished.length}`);
for (const r of unfinished.slice(0, 10)) {
  console.log(`     ${String((r as { code?: string }).code ?? r.id).slice(0, 8).padEnd(9)}${String(r.company).slice(0, 34)}`);
}
if (unfinished.length > 10) console.log(`     … and ${unfinished.length - 10} more`);

if (!write) {
  console.log(`\n  dry run — pass --write to move these ${unfinished.length} to "error" so sweeps see them again`);
} else {
  const backup = `${APPLICATIONS_JSON_PATH}.bak-unfinished-${Date.now()}`;
  fs.copyFileSync(APPLICATIONS_JSON_PATH, backup);
  const ids = new Set(unfinished.map((r) => r.id));
  for (const r of records) if (ids.has(r.id)) r.status = "error";
  fs.writeFileSync(APPLICATIONS_JSON_PATH, `${JSON.stringify(records, null, 2)}\n`);
  console.log(`\n  backup: ${backup}`);
  console.log(`  rewrote ${ids.size} record(s) to "error" — they are no longer excluded from sweeps`);
}

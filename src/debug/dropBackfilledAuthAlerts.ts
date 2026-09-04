/**
 * `npx tsx src/debug/dropBackfilledAuthAlerts.ts [--write]`
 *
 * The auth banner says 38 employers need an account created by hand, and for 35 of them we do not
 * know that.
 *
 * Those 35 were written by backfillAuthAlerts.ts, which read historical runs that predate the
 * create -> sign-in -> reset flow and recorded the conclusion anyway. Their own detail line admits
 * it: "create, sign-in and password reset were all tried BEFORE THE ALARM EXISTED". The banner
 * then states, flatly, that a reset email never arrived "which is what Workday does when there is
 * no account to reset" — a diagnosis of something nobody performed.
 *
 * That is the same fault as a ledger record claiming an application was filled when the run
 * stopped early: a stored conclusion nothing measured, which then steers real decisions. Here it
 * asks the candidate to go and create 35 accounts by hand.
 *
 * Dropping them is not a claim that the tenants work. It restores "we do not know", which is the
 * truth, and the next sweep finds out — the postings behind them are back in scope now that their
 * ledger records no longer say "filled". A genuine failure re-raises the alarm with a reason that
 * was actually observed, which is what the three surviving entries are.
 */
import fs from "node:fs";
import { readAuthAlerts, clearAuthAlert } from "../knowledge/authAlerts.js";

const write = process.argv.includes("--write");
const alerts = await readAuthAlerts();
const backfilled = alerts.filter((a) => /before the alarm existed/i.test(a.detail ?? ""));
const measured = alerts.filter((a) => !/before the alarm existed/i.test(a.detail ?? ""));

console.log(`  alerts: ${alerts.length}`);
console.log(`  written by the backfill, never tried with the current flow: ${backfilled.length}`);
console.log(`  actually tried and failed (keeping these):                  ${measured.length}`);
for (const a of measured) console.log(`     ${a.tenant}`);

if (!write) {
  console.log(`\n  dry run — pass --write to drop the ${backfilled.length} unmeasured ones`);
} else {
  const backup = `data/auth-alerts.json.bak-backfilled-${Date.now()}`;
  fs.copyFileSync("data/auth-alerts.json", backup);
  for (const a of backfilled) await clearAuthAlert(a.tenant);
  const left = await readAuthAlerts();
  console.log(`\n  backup: ${backup}`);
  console.log(`  dropped ${backfilled.length}; ${left.length} alert(s) remain — the ones a run actually observed`);
}

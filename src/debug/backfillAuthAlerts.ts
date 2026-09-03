import { loadEnv } from "../utils/env.js";
loadEnv();
import { loadApplications } from "../knowledge/applications.js";
import { loadPendingQueue } from "../knowledge/approvalQueue.js";
import { recordAuthAlert, readAuthAlerts } from "../knowledge/authAlerts.js";
import { tenantOf } from "../agent/drivers/workday.js";

/**
 * Raise the alarm for the tenants we ALREADY know are blocked.  npm run backfill:authalerts
 *
 * The alarm is written when a run exhausts create, sign-in and the reset email. Sixty-six
 * applications reached exactly that point BEFORE the alarm existed, so the page showed nothing and
 * the honest answer to "where do I see it?" was "you don't, yet". Their tenants are recorded in the
 * ledger, so the state can be reconstructed rather than waited for.
 *
 * The signature is specific: a Workday record, stopped after ONE turn, having filled between one
 * and nineteen fields — which in practice is the single "Email Address*" of a sign-in page it never
 * got past. A run that filled the real form is a different failure and is left alone.
 *
 * Nothing here is permanent: a tenant clears itself the moment a run gets in, and a posting that
 * has since closed drops out when the job is recorded expired.
 */
const [apps, queue] = await Promise.all([loadApplications(), loadPendingQueue()]);
const inQueue = new Set(queue.map((e) => e.code ?? e.key));
const stuck = apps.filter(
  (r) =>
    r.status === "prefilled_pending_submit" &&
    !inQueue.has(r.code ?? r.id ?? "") &&
    r.ats === "workday" &&
    (r.notes ?? []).join(" ").includes("turns: 1") &&
    (r.filledFields ?? []).length > 0 &&
    (r.filledFields ?? []).length < 20,
);

const byTenant = new Map<string, { company?: string; code?: string; n: number }>();
for (const r of stuck) {
  const tenant = tenantOf(r.applyUrl ?? "");
  const seen = byTenant.get(tenant) ?? { company: r.company, code: r.code ?? r.id, n: 0 };
  seen.n += 1;
  byTenant.set(tenant, seen);
}

console.log(`${stuck.length} application(s) across ${byTenant.size} tenant(s)\n`);
for (const [tenant, info] of [...byTenant.entries()].sort((a, b) => b[1].n - a[1].n)) {
  for (let i = 0; i < info.n; i += 1) {
    await recordAuthAlert({
      tenant,
      stage: "reset-email",
      detail:
        "create, sign-in and password reset were all tried before the alarm existed, and no reset " +
        "email arrived — this tenant needs an account created by hand",
      email: process.env.JOB_APP_USERNAME ?? "(the configured login)",
      company: info.company,
      jobCode: info.code,
    });
  }
  console.log(`  ${String(info.n).padStart(2)}  ${tenant.padEnd(44)}${String(info.company ?? "").slice(0, 24)}`);
}
const written = await readAuthAlerts();
console.log(`\nwrote ${written.length} alarm(s); the website shows them on every page.`);

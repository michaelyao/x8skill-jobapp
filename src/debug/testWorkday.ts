/**
 * Runs WorkdayAdapter.fill() against the first fresh Workday job (skipping Cohesity)
 * without any interactive prompts. Feed /dev/null as stdin so readline returns instantly.
 *
 * Usage (from repo root):
 *   npx tsx src/debug/testWorkday.ts < /dev/null 2>&1 | tee /tmp/workday-debug.log
 *   SKIP_COMPANY=cohesity JOB_INDEX=2 npx tsx src/debug/testWorkday.ts < /dev/null
 */

import { chromium } from "playwright";
import { loadEnv } from "../utils/env.js";
import { AUTH_DIR } from "../config.js";
import { loadProfile } from "../knowledge/profile.js";
import { loadAnswers } from "../knowledge/answerStore.js";
import { loadSimplifyJobs } from "../sources/simplify.js";
import { filterJobs } from "../core/filterJobs.js";
import { buildJobIdentity } from "../core/jobIdentity.js";
import { WorkdayAdapter } from "../adapters/workday.js";
import { makeRunDir, ensureDir } from "../utils/log.js";
import type { FilteredJob } from "../types.js";

loadEnv();

// ── Launch browser ────────────────────────────────────────────────────────────
const context = await chromium.launchPersistentContext(AUTH_DIR, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1440, height: 1000 },
  args: ["--remote-debugging-port=9222"],
});
const page = context.pages()[0] ?? (await context.newPage());

// ── Pick a job ────────────────────────────────────────────────────────────────
console.log("[debug] fetching Simplify jobs...");
const jobs = await loadSimplifyJobs(page);
const filtered = filterJobs(jobs);

const skipCompany = (process.env.SKIP_COMPANY ?? "cohesity").toLowerCase();
const jobIndexEnv = process.env.JOB_INDEX !== undefined ? parseInt(process.env.JOB_INDEX, 10) : undefined;

let job: FilteredJob | undefined;
if (jobIndexEnv !== undefined) {
  job = filtered[jobIndexEnv];
} else {
  job = filtered.find(
    (j) => j.applyUrl.toLowerCase().includes("workday") && !j.company.toLowerCase().includes(skipCompany),
  );
}
if (!job) {
  job = filtered.find((j) => j.applyUrl.toLowerCase().includes("workday"));
}
if (!job) throw new Error("No Workday job found");

console.log(`[debug] job: ${job.company} — ${job.title}`);
console.log(`[debug] url: ${job.applyUrl}`);

// ── Load profile + answers ────────────────────────────────────────────────────
const profile = await loadProfile();
const answers = await loadAnswers();
const runDir = makeRunDir();
await ensureDir(runDir);
console.log(`[debug] runDir: ${runDir}`);

// ── Open job page ─────────────────────────────────────────────────────────────
const jobPage = await context.newPage();
await jobPage.goto(job.applyUrl, { waitUntil: "domcontentloaded" });
await jobPage.waitForTimeout(2500);

// ── Run adapter ───────────────────────────────────────────────────────────────
const adapter = new WorkdayAdapter();
const identity = buildJobIdentity(job);

// ── DOM dump of formField-* containers before fill ───────────────────────────
// Sign in first (reuse enterApplicationFlow via a quick manual nav)
await jobPage.waitForTimeout(3000);
const bodyCheck = (await jobPage.locator("body").innerText().catch(() => "")).toLowerCase();
if (bodyCheck.includes("create account") || bodyCheck.includes("sign in")) {
  // quick sign-in
  const signInTab = jobPage.getByRole("button", { name: /^sign in$/i }).first();
  if (await signInTab.count()) { await signInTab.click(); await jobPage.waitForTimeout(1000); }
  const emailEl = jobPage.locator('input[type="email"], input[type="text"]').first();
  const passEl = jobPage.locator('input[type="password"]').first();
  await emailEl.fill(process.env.JOB_APP_USERNAME ?? "");
  await passEl.fill(process.env.JOB_APP_PASSWORD ?? "");
  const submitBtn = jobPage.locator('[data-automation-id="click_filter"][aria-label="Sign In"]').first();
  if (await submitBtn.count()) await submitBtn.click();
  else await jobPage.locator("button").filter({ hasText: /^sign in$/i }).first().click();
  await jobPage.waitForTimeout(5000);
}
const formFields = await jobPage.evaluate(() => {
  const results: Record<string, string>[] = [];
  const containers = document.querySelectorAll<HTMLElement>('[data-automation-id^="formField-"]');
  for (const c of containers) {
    const label = c.querySelector("label")?.textContent?.trim() ?? "";
    const btn = c.querySelector<HTMLElement>("button, [role='button'], [role='combobox'], select");
    results.push({
      containerId: c.getAttribute("data-automation-id") ?? "",
      label,
      btnTag: btn?.tagName?.toLowerCase() ?? "",
      btnRole: btn?.getAttribute("role") ?? "",
      btnText: btn?.textContent?.trim().slice(0, 50) ?? "",
      btnAutoId: btn?.getAttribute("data-automation-id") ?? "",
    });
  }
  return results;
});
console.log("\n[debug] === formField-* DOM dump ===");
for (const f of formFields) {
  console.log(`  ${f.containerId}: label="${f.label}" btn=${f.btnTag}[role=${f.btnRole}] text="${f.btnText}" btnAutoId="${f.btnAutoId}"`);
}

console.log("\n[debug] === starting WorkdayAdapter.fill() ===\n");

const result = await adapter.fill({
  browserContext: context,
  page: jobPage,
  job,
  identity,
  profile,
  answers,
  runDir,
});

console.log("\n[debug] === fill() result ===");
console.log(JSON.stringify(result, null, 2));

// Keep browser open for inspection
console.log("\n[debug] done — browser stays open. Ctrl+C to exit.");
await new Promise(() => {}); // wait forever

/**
 * Full flow: launches the browser, navigates to the first Workday job,
 * handles auth, reaches My Information, and dumps the complete DOM.
 *
 * Run from your terminal:
 *   npx tsx src/debug/inspectMyInfo.ts
 *
 * The browser stays open so you can see what's happening.
 * Press Enter in the terminal at each prompt to advance.
 */

import { chromium } from "playwright";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadEnv } from "../utils/env.js";
import { AUTH_DIR, RESUME_PATH } from "../config.js";
import { loadSimplifyJobs } from "../sources/simplify.js";
import { filterJobs } from "../core/filterJobs.js";

loadEnv();

const rl = readline.createInterface({ input, output });
async function prompt(msg: string) {
  process.stdout.write(`\n>>> ${msg}\n    Press Enter to continue > `);
  await rl.question("");
}

// ── Launch ───────────────────────────────────────────────────────────────────
const context = await chromium.launchPersistentContext(AUTH_DIR, {
  channel: "chrome",
  headless: false,
  chromiumSandbox: true,
  viewport: { width: 1440, height: 1000 },
  args: ["--remote-debugging-port=9222"],
});
const page = context.pages()[0] ?? (await context.newPage());

// ── Find first Workday job ────────────────────────────────────────────────────
console.log("Fetching jobs from Simplify...");
const jobs = await loadSimplifyJobs(page);
const filtered = filterJobs(jobs);
// Use JOB_INDEX env var to pick a specific job, otherwise find first Workday job
// that is NOT the Cohesity one (since that has a half-filled application).
const skipCompany = (process.env.SKIP_COMPANY ?? "cohesity").toLowerCase();
const jobIndexEnv = process.env.JOB_INDEX ? parseInt(process.env.JOB_INDEX, 10) : undefined;

let workdayJob = jobIndexEnv !== undefined
  ? filtered[jobIndexEnv]
  : filtered.find((j) =>
      j.applyUrl.toLowerCase().includes("workday") &&
      !j.company.toLowerCase().includes(skipCompany)
    );

if (!workdayJob) {
  // Fall back to any Workday job
  workdayJob = filtered.find((j) => j.applyUrl.toLowerCase().includes("workday"));
}
if (!workdayJob) throw new Error("No Workday job found in filtered list");

console.log(`\nJob: ${workdayJob.company} — ${workdayJob.title}`);
console.log(`URL: ${workdayJob.applyUrl}\n`);

const jobPage = await context.newPage();
await jobPage.goto(workdayJob.applyUrl, { waitUntil: "domcontentloaded" });
await jobPage.waitForTimeout(2000);

// ── Apply button ──────────────────────────────────────────────────────────────
const applyBtn = jobPage.getByRole("button", { name: /^apply$|^continue application$/i }).first();
if (await applyBtn.count()) {
  const label = await applyBtn.innerText();
  console.log(`[nav] clicking '${label.trim()}'...`);
  await applyBtn.click();
  await jobPage.waitForTimeout(2500);
}

// ── Start Your Application dialog ─────────────────────────────────────────────
const startDialog = jobPage.locator('[role="dialog"]').filter({ hasText: /start your application/i });
if (await startDialog.count()) {
  const useLastApp = jobPage.getByRole("button", { name: /use my last application/i }).first();
  const resumeBtn  = jobPage.getByRole("button", { name: /autofill with resume/i }).first();
  const manualBtn  = jobPage.getByRole("button", { name: /apply manually/i }).first();

  if (await useLastApp.count()) {
    console.log("[nav] clicking 'Use My Last Application'...");
    await useLastApp.click();
    await jobPage.waitForTimeout(4000);
  } else if (await resumeBtn.count()) {
    console.log("[nav] clicking 'Autofill with Resume'...");
    await resumeBtn.click();
    await jobPage.waitForTimeout(3000);
  } else if (await manualBtn.count()) {
    await manualBtn.click();
    await jobPage.waitForTimeout(3000);
  }
}

// ── Auth loop ─────────────────────────────────────────────────────────────────
for (let i = 0; i < 6; i++) {
  const body = (await jobPage.locator("body").innerText().catch(() => "")).toLowerCase();

  if (body.includes("already have an account")) {
    console.log("[auth] Create Account page — clicking Sign In link...");
    const link = jobPage.getByRole("link", { name: /^sign in$/i }).first();
    if (await link.count()) { await link.click(); await jobPage.waitForTimeout(2000); continue; }
  }

  // Sign In — either a full page or a modal dialog. Scope to dialog when present.
  const hasSignInModal = await jobPage.locator('[role="dialog"]').filter({ hasText: /sign in/i }).count() > 0;
  const hasSignInPage  = body.includes("sign in") && body.includes("email address") && !body.includes("autofill with resume");
  if (hasSignInModal || hasSignInPage) {
    const signInDialog = jobPage.locator('[role="dialog"]').filter({ hasText: /sign in/i });
    const scope = hasSignInModal ? signInDialog.first() : jobPage.locator("body");
    console.log(`[auth] Sign In detected (modal=${hasSignInModal}) — filling credentials...`);
    const emailEl = scope.locator('input[type="email"]').first();
    const textEl  = scope.locator('input[type="text"]').first();
    const passEl  = scope.locator('input[type="password"]').first();
    const emailTarget = (await emailEl.count() && await emailEl.isVisible().catch(() => false)) ? emailEl : textEl;
    await emailTarget.fill(process.env.JOB_APP_USERNAME ?? "").catch((e) => console.log("[auth] email fill error:", e));
    await passEl.fill(process.env.JOB_APP_PASSWORD ?? "").catch((e) => console.log("[auth] pass fill error:", e));
    const signInBtn = scope.locator("button").filter({ hasText: /^sign in$/i }).first();
    await signInBtn.click().catch((e) => console.log("[auth] submit error:", e));
    await jobPage.waitForTimeout(6000);
    continue;
  }

  if (body.includes("drop file here") || (body.includes("autofill with resume") && body.includes("select file"))) {
    console.log("[nav] Resume upload step — uploading PDF...");
    const fileInput = jobPage.locator('input[type="file"]').first();
    if (await fileInput.count()) {
      await fileInput.setInputFiles(RESUME_PATH);
      await jobPage.waitForSelector("text=Successfully Uploaded", { timeout: 15000 }).catch(() => {});
      console.log("[nav] Resume uploaded.");
      await jobPage.waitForTimeout(1000);
    }
    const continueBtn = jobPage.getByRole("button", { name: /^continue$/i }).first();
    await continueBtn.click().catch(() => {});
    console.log("[nav] Clicked Continue after resume upload.");
    await jobPage.waitForTimeout(3000);
    continue;
  }

  if (body.includes("my information")) {
    console.log("[nav] Reached My Information page!\n");
    break;
  }

  console.log(`[nav] Unknown state at step ${i} — url=${jobPage.url()}`);
  await jobPage.waitForTimeout(2000);
}

await prompt("If you're not on My Information yet, complete auth manually in the browser, then press Enter.");

// ── Dump DOM ──────────────────────────────────────────────────────────────────
console.log("\n═══════════════════════════════════════════════════");
console.log("DOM INSPECTION — My Information page");
console.log("═══════════════════════════════════════════════════\n");

const fields = await jobPage.evaluate(() => {
  const results: Record<string, string>[] = [];

  const els = document.querySelectorAll<HTMLElement>(
    'input:not([type="hidden"]), select, textarea, [role="combobox"], [role="radio"], [role="listbox"]'
  );

  for (const el of els) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    // Find label
    let label = "";
    const id = el.id;
    if (id) {
      const lbl = document.querySelector(`label[for="${id}"]`);
      if (lbl) label = lbl.textContent?.trim() ?? "";
    }
    if (!label) label = el.getAttribute("aria-label") ?? "";
    if (!label) label = el.getAttribute("placeholder") ?? "";
    if (!label) {
      const nearest = el.closest("[data-automation-id]")
        ?? el.closest("fieldset")
        ?? el.closest("div");
      if (nearest) {
        const lbl = nearest.querySelector("label");
        if (lbl) label = lbl.textContent?.trim() ?? "";
      }
    }

    results.push({
      label,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") ?? "",
      role: el.getAttribute("role") ?? "",
      id: el.id,
      name: el.getAttribute("name") ?? "",
      dataAutomationId: el.getAttribute("data-automation-id") ?? "",
      ariaLabel: el.getAttribute("aria-label") ?? "",
      ariaRequired: el.getAttribute("aria-required") ?? "",
      value: (el as HTMLInputElement).value ?? "",
      className: el.className.toString().slice(0, 80),
    });
  }

  return results;
});

console.log(`Found ${fields.length} controls:\n`);
for (const f of fields) {
  console.log(`  LABEL: "${f.label}"`);
  console.log(`    tag=${f.tag} type=${f.type} role=${f.role}`);
  console.log(`    id="${f.id}" name="${f.name}" data-automation-id="${f.dataAutomationId}"`);
  console.log(`    aria-label="${f.ariaLabel}" aria-required="${f.ariaRequired}" value="${f.value}"`);
  console.log();
}

// Page text for reference
const pageText = await jobPage.locator("body").innerText().catch(() => "");
console.log("═══ PAGE TEXT (first 2000 chars) ═══\n");
console.log(pageText.slice(0, 2000));

await prompt("Done inspecting. Press Enter to close.");
rl.close();
await context.close();

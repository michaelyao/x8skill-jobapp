import { chromium } from "playwright";
import { AshbyDriver } from "../agent/drivers/ashby.js";
import { GreenhouseDriver } from "../agent/drivers/greenhouse.js";
import { LeverDriver } from "../agent/drivers/lever.js";
import { OracleDriver } from "../agent/drivers/oracle.js";
import { WorkableDriver } from "../agent/drivers/workable.js";
import { WorkdayDriver } from "../agent/drivers/workday.js";
import type { AtsDriver } from "../agent/types.js";

/**
 * Drive a real driver against a real posting, READ-ONLY: detect → openApplication → resolveRoot →
 * read, then print the snapshot. Nothing is filled, nothing is submitted, no answers are consulted.
 *
 *   npx tsx src/debug/probeDriver.ts <url> [--headed]
 *
 * This is the check that matters when adding an ATS. A driver that compiles and "looks right"
 * still tells you nothing: the question is whether openApplication reaches the form and read()
 * comes back with the fields and submitReady. Both Workable failures found while writing this
 * driver — the consent overlay eating the Apply click, and the honeypot being read as a field —
 * were invisible until a real driver ran against a real page.
 *
 * A throwaway browser on purpose, never playwright/.auth: the worker holds data/.browser.lock and
 * Chrome is single-instance per user-data-dir.
 */
const url = process.argv[2];
if (!url) {
  console.error("usage: npx tsx src/debug/probeDriver.ts <url> [--headed]");
  process.exit(1);
}

const drivers: AtsDriver[] = [
  new WorkdayDriver(), new AshbyDriver(), new GreenhouseDriver(),
  new LeverDriver(), new WorkableDriver(), new OracleDriver(),
];

const browser = await chromium.launch({
  headless: !process.argv.includes("--headed"),
  ignoreDefaultArgs: ["--enable-automation"],
  args: ["--disable-blink-features=AutomationControlled"],
});
try {
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    viewport: { width: 1400, height: 1000 },
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3000);

  // The SAME expiry check applyJob() runs before any driver touches the page. Without it this
  // tool reported a withdrawn Workable posting as a 5-field form — it had read the company's job
  // SEARCH filters. A probe that skips the production guards does not tell you about production.
  const pageText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  if (/doesn'?t exist|no longer (available|accepting|active)|posting (has )?closed|job not found|page not found/.test(pageText)) {
    console.log("posting expired/closed — applyJob() would record it as `expired` and never open a driver.");
    process.exit(0);
  }

  let driver: AtsDriver | undefined;
  for (const candidate of drivers) {
    if (await candidate.detect(page).catch(() => false)) { driver = candidate; break; }
  }
  if (!driver) { console.log("no driver detected this page — it would never be opened"); process.exit(2); }
  console.log(`driver:   ${driver.type}`);

  await driver.openApplication(page);
  const root = await driver.resolveRoot(page);
  console.log(`url:      ${page.url()}`);
  console.log(`root:     ${root === page ? "main page" : `frame ${root.url()}`}`);
  console.log(`applied?  ${await driver.isAlreadyApplied(root).catch(() => "?")}`);

  const snap = await driver.read(root);
  console.log(`\nsubmitReady=${snap.submitReady}  nextAvailable=${snap.nextAvailable}  fields=${snap.fields.length}\n`);
  for (const f of snap.fields) {
    console.log(`  ${f.required ? "*" : " "} [${f.type}] ${f.label}${f.filled ? "   (already filled)" : ""}` +
      (f.options?.length ? `\n        options: ${f.options.slice(0, 6).join(" | ")}${f.options.length > 6 ? ` (+${f.options.length - 6})` : ""}` : ""));
  }
  // Oracle only: report the authentication gate explicitly. Read-only — atAuthGate() inspects,
  // and next() at the gate refuses rather than clicking.
  if (driver instanceof OracleDriver) {
    const gate = await driver.atAuthGate(root).catch(() => false);
    console.log(`\nat auth gate: ${gate}`);
    if (gate) console.log(`next() says:`), await driver.next(root);
  }
  const errors = (await driver.validationErrors?.(root).catch(() => [])) ?? [];
  if (errors.length) console.log(`\nform is showing: ${errors.join(" · ")}`);
  console.log(`\nNOTHING was filled or submitted.`);
} finally {
  await browser.close();
}

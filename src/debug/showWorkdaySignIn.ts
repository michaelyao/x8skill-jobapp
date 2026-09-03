/**
 * Open a Workday posting in a HEADED browser, drive the real driver's openApplication, and LEAVE
 * IT OPEN so a human can look at where it stops.
 *
 *   npx tsx src/debug/showWorkdaySignIn.ts <url>
 *
 * Sixty-five applications stopped having filled one field, "Email Address*". The log says why —
 * sign-in fails, a password reset is attempted, the reset email never arrives — but a log line is
 * not the same as seeing the page. Read-only: it fills nothing and clicks no submit.
 */
import { chromium } from "playwright";
import { loadEnv } from "../utils/env.js";
import { AUTH_DIR } from "../config.js";
import { WorkdayDriver } from "../agent/drivers/workday.js";

loadEnv();
const url = process.argv[2];
if (!url) { console.error("usage: npx tsx src/debug/showWorkdaySignIn.ts <url>"); process.exit(1); }

const context = await chromium.launchPersistentContext(AUTH_DIR, {
  channel: "chrome",
  headless: false,
  chromiumSandbox: true,
  viewport: { width: 1440, height: 1000 },
  ignoreDefaultArgs: ["--enable-automation"],
  args: ["--disable-blink-features=AutomationControlled"],
});
const page = context.pages()[0] ?? (await context.newPage());
console.log(`\n>>> going to ${url}`);
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch((e) => console.log("  goto: " + e.message));
await page.waitForTimeout(2500);
console.log(`>>> landed on ${page.url()}`);

const driver = new WorkdayDriver();
// The names the CODE reads. WORKDAY_EMAIL/WORKDAY_PASSWORD appear nowhere in src/ — printing
// those was my own error and it read as "the credentials are missing" when they are not.
console.log(
  `>>> sign-in will use JOB_APP_USERNAME=${(process.env.JOB_APP_USERNAME ?? "(unset -> falls back to the resume's email)").replace(/^(.{4}).*@/, "$1***@")}` +
    `  JOB_APP_PASSWORD=${process.env.JOB_APP_PASSWORD ? "set" : "(unset)"}`,
);
console.log(`>>> running the real openApplication — watch the window\n`);
try {
  await driver.openApplication(page);
} catch (e) {
  console.log(`  openApplication threw: ${(e as Error).message.split("\n")[0]}`);
}
await page.waitForTimeout(1500);
console.log(`\n>>> now on ${page.url()}`);
const root = await driver.resolveRoot(page).catch(() => page);
const snap = await driver.read(root).catch(() => null);
console.log(`>>> read() sees ${snap?.fields.length ?? 0} field(s), submitReady=${snap?.submitReady}`);
for (const f of snap?.fields ?? []) console.log(`      ${f.required ? "*" : " "} ${f.label.slice(0, 70)}`);
const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 400);
console.log(`\n>>> what the page says:\n    ${text}\n`);
/**
 * HOLD THE WINDOW WITHOUT WAITING ON STDIN.
 *
 * This used to end on readline.question(). Run in the background — which is the only way to keep
 * a browser open while still doing anything else — there is no interactive stdin, so it blocked
 * forever and every line above it stayed buffered. The window was open on screen and the log was
 * empty, which is indistinguishable from the tool having hung.
 */
const holdMin = Number(process.env.HOLD_MIN ?? 20);
console.log(`>>> holding the window open for ${holdMin} min (HOLD_MIN=n to change). Reporting what changes.`);
let was = page.url();
for (let i = 0; i < holdMin * 6; i += 1) {
  await page.waitForTimeout(10_000);
  const now = page.url();
  if (now !== was) {
    console.log(`>>> navigated: ${now}`);
    was = now;
    const n = (await driver.read(await driver.resolveRoot(page).catch(() => page)).catch(() => null))?.fields.length ?? 0;
    console.log(`    read() now sees ${n} field(s)`);
  }
}
console.log(">>> hold expired — closing.");
await context.close();

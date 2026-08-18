/**
 * Find out which popup a Workday taxonomy prompt (Field of Study / Skills) actually fills,
 * and whether the search runs on Enter.
 *
 * The existing inspector stops on "My Information"; these fields are on "My Experience", so
 * this advances until the label is on screen. Read-only: types into one prompt, never submits.
 *
 * Usage: AUTH_DIR=/tmp/wd-probe FIELD_LABEL="Field of Study" TYPE_TEXT=information \
 *        npx tsx src/debug/probeTaxonomy.ts
 *
 * NOTE: every page.evaluate is passed as a STRING — tsx/esbuild rewrites inline arrows with
 * helpers (__name) that do not exist in the page.
 */
import { chromium } from "playwright";
import { AUTH_DIR, RESUME_PATH } from "../config.js";
import { WorkdayDriver } from "../agent/drivers/workday.js";
import { loadEnv } from "../utils/env.js";

loadEnv();
const url =
  process.env.JOB_URL ||
  "https://pentair.wd5.myworkdayjobs.com/pentair_careers/job/Golden-Valley-MN/IT---Cybersecurity-Leadership-Development-Internship-Program----Summer-2027_R23700";
const LABEL = process.env.FIELD_LABEL || "Field of Study";
const TYPE_TEXT = process.env.TYPE_TEXT || "information";

const context = await chromium.launchPersistentContext(AUTH_DIR, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1440, height: 1000 },
  ignoreDefaultArgs: ["--enable-automation"],
  args: ["--disable-blink-features=AutomationControlled"],
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);

const driver = new WorkdayDriver();
console.log("driving apply + sign-in …");
await driver.openApplication(page).catch((e) => console.log(`openApplication: ${(e as Error).message.split("\n")[0]}`));
await page.waitForTimeout(3000);
let root = await driver.resolveRoot(page);

// Advance until the LABEL is on screen (My Experience is several Next clicks in).
const HAS_LABEL = `(() => document.body.innerText.toLowerCase().indexOf(${JSON.stringify(
  LABEL.toLowerCase(),
)}) >= 0)()`;
for (let step = 0; step < 8; step += 1) {
  const present = await root.evaluate(HAS_LABEL).catch(() => false);
  const fields = (await driver.read(root)).fields.length;
  console.log(`  step ${step}: ${fields} field(s), "${LABEL}" present=${present} — ${page.url().split("/").pop()}`);
  if (present) break;
  await driver.uploadDocuments(root, RESUME_PATH).catch(() => undefined);
  await page.waitForTimeout(1200);
  if (!(await driver.next(root).catch(() => false))) break;
  await page.waitForTimeout(3000);
  root = await driver.resolveRoot(page);
}

// Locate the control inside the formField box carrying the label.
const FIND_CTRL = `(() => {
  var norm = function (s) { return (s || "").replace(/\\s+/g, " ").trim(); };
  var boxes = Array.prototype.slice.call(document.querySelectorAll('[data-automation-id^="formField"]'));
  for (var i = 0; i < boxes.length; i++) {
    if (norm(boxes[i].innerText).toLowerCase().indexOf(${JSON.stringify(LABEL.toLowerCase())}) >= 0) {
      var c = boxes[i].querySelector('input,[role=combobox],button,textarea');
      if (!c) continue;
      c.setAttribute('data-probe-target', '1');
      return { boxAid: boxes[i].getAttribute('data-automation-id'), tag: c.tagName,
               aid: c.getAttribute('data-automation-id'), ariaControls: c.getAttribute('aria-controls'),
               ariaOwns: c.getAttribute('aria-owns'), role: c.getAttribute('role') };
    }
  }
  return null;
})()`;

const found = await root.evaluate(FIND_CTRL).catch((e) => ({ error: String(e).split("\n")[0] }));
console.log("\n===== control =====\n" + JSON.stringify(found, null, 1));

const ctrl = root.locator('[data-probe-target="1"]').first();
await ctrl.scrollIntoViewIfNeeded().catch(() => undefined);
await ctrl.click().catch(() => undefined);
await page.waitForTimeout(800);

// Every popup on the page: where it lives, whether it is visible, and what it holds.
const DUMP_POPUPS = `(() => {
  var norm = function (s) { return (s || "").replace(/\\s+/g, " ").trim(); };
  var out = [];
  var sels = ['[data-automation-id="activeListContainer"]','[role="listbox"]','[class*="select__menu"]','[data-automation-id="promptOptions"]'];
  var seen = [];
  for (var s = 0; s < sels.length; s++) {
    var nodes = Array.prototype.slice.call(document.querySelectorAll(sels[s]));
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (seen.indexOf(n) >= 0) continue;
      seen.push(n);
      var r = n.getBoundingClientRect();
      var opts = n.querySelectorAll('[data-automation-id="promptOption"], [role="option"]');
      var texts = [];
      for (var k = 0; k < opts.length && k < 8; k++) texts.push(norm(opts[k].innerText).slice(0, 44));
      // How far up the tree until we reach the target control's formField box?
      var path = [], p = n, depth = 0;
      while (p && depth < 6) { path.push((p.tagName||'') + (p.getAttribute && p.getAttribute('data-automation-id') ? '[' + p.getAttribute('data-automation-id') + ']' : '')); p = p.parentElement; depth++; }
      var target = document.querySelector('[data-probe-target="1"]');
      var box = target ? target.closest('[data-automation-id^="formField"]') : null;
      out.push({
        matchedBy: sels[s], id: n.id || null, aid: n.getAttribute('data-automation-id'),
        visible: r.width > 0 && r.height > 0, top: Math.round(r.top), left: Math.round(r.left),
        optionCount: opts.length, options: texts,
        insideTargetFormField: box ? box.contains(n) : null,
        parentChain: path.join(' < ')
      });
    }
  }
  return out;
})()`;

console.log("\n===== popups AFTER CLICK =====\n" + JSON.stringify(await root.evaluate(DUMP_POPUPS).catch((e) => String(e)), null, 1));

console.log(`\n--- typing ${JSON.stringify(TYPE_TEXT)} (no Enter) ---`);
await ctrl.fill("").catch(() => undefined);
await ctrl.pressSequentially(TYPE_TEXT, { delay: 30 }).catch(() => undefined);
await page.waitForTimeout(2000);
console.log(JSON.stringify(await root.evaluate(DUMP_POPUPS).catch((e) => String(e)), null, 1));

console.log("\n--- now pressing Enter ---");
await page.keyboard.press("Enter").catch(() => undefined);
await page.waitForTimeout(2500);
console.log(JSON.stringify(await root.evaluate(DUMP_POPUPS).catch((e) => String(e)), null, 1));

console.log("\nholding 20s so the state is visible…");
await page.waitForTimeout(20000);
await context.close();

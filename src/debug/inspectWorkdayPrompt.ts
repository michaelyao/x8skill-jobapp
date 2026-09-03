/**
 * Inspect a Workday "prompt" field (e.g. "How Did You Hear About Us?") on a live, signed-in
 * application and report exactly how a value gets committed.
 *
 * Needed because typing into a prompt does NOT select: the box shows the text while Workday
 * still reports the field required and empty. This DOM sits behind sign-in, so it must be
 * read from a real session rather than guessed at.
 *
 * Usage: AUTH_DIR=/tmp/wd-probe JOB_URL=<workday posting> npx tsx src/debug/inspectWorkdayPrompt.ts
 * Read-only: it touches only the prompt under test and never submits.
 *
 * NOTE: every page.evaluate here is passed as a STRING — tsx/esbuild rewrites inline arrow
 * functions with helpers (__name) that do not exist in the page.
 */
import { chromium } from "playwright";
import { AUTH_DIR, RESUME_PATH } from "../config.js";
import { WorkdayDriver } from "../agent/drivers/workday.js";
import { loadEnv } from "../utils/env.js";

loadEnv();
const url = process.env.JOB_URL ||
  "https://pentair.wd5.myworkdayjobs.com/pentair_careers/job/Golden-Valley-MN/IT---Cybersecurity-Leadership-Development-Internship-Program----Summer-2027_R23700";
const LABEL = process.env.FIELD_LABEL || "How Did You Hear About Us";
const WANT = process.env.WANT_OPTION || "LinkedIn";

const context = await chromium.launchPersistentContext(AUTH_DIR, {
  channel: "chrome",
  headless: false,
  chromiumSandbox: true,
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

// openApplication stops at "Autofill with Resume" (step 1 of 8). The turn loop normally
// uploads the resume and advances from there, so do the same or the prompt under test is
// never on screen.
for (let step = 0; step < 6; step += 1) {
  const fields = (await driver.read(root)).fields.length;
  console.log(`  step ${step}: ${fields} field(s) — ${page.url().split("/").pop()}`);
  if (fields >= 5) break;
  await driver.uploadDocuments(root, RESUME_PATH).catch(() => undefined);
  await page.waitForTimeout(1500);
  if (!(await driver.next(root).catch(() => false))) break;
  await page.waitForTimeout(2500);
  root = await driver.resolveRoot(page);
}

const FIELD_SCRIPT = (needle: string) => `(() => {
  var norm = function (s) { return (s || "").replace(/\\s+/g, " ").trim(); };
  var boxes = Array.prototype.slice.call(document.querySelectorAll('[data-automation-id^="formField"]'));
  var box = null;
  for (var i = 0; i < boxes.length; i++) {
    if (norm(boxes[i].innerText).toLowerCase().indexOf(${JSON.stringify(needle.toLowerCase())}) >= 0) { box = boxes[i]; break; }
  }
  if (!box) return { found: false };
  var ctrl = box.querySelector('input,button,textarea,select,[role=combobox]');
  var aids = [];
  var marked = box.querySelectorAll('[data-automation-id]');
  for (var j = 0; j < marked.length; j++) { var a = marked[j].getAttribute('data-automation-id'); if (aids.indexOf(a) < 0) aids.push(a); }
  var sel = [];
  var selish = box.querySelectorAll('[data-automation-id*="selected"], [class*="pill"], li');
  for (var k = 0; k < selish.length && sel.length < 6; k++) { var t = norm(selish[k].innerText); if (t) sel.push({ aid: selish[k].getAttribute('data-automation-id'), cls: selish[k].className, text: t.slice(0, 40) }); }
  return {
    found: true,
    containerAid: box.getAttribute('data-automation-id'),
    containerText: norm(box.innerText).slice(0, 140),
    control: ctrl ? {
      tag: ctrl.tagName, type: ctrl.getAttribute('type'), role: ctrl.getAttribute('role'),
      aid: ctrl.getAttribute('data-automation-id'), ariaExpanded: ctrl.getAttribute('aria-expanded'),
      ariaHaspopup: ctrl.getAttribute('aria-haspopup'), ariaControls: ctrl.getAttribute('aria-controls'),
      value: ctrl.value === undefined ? null : ctrl.value, text: norm(ctrl.innerText || "")
    } : null,
    automationIdsInside: aids.slice(0, 20),
    selectedish: sel
  };
})()`;

const describe = async (stage: string) => {
  const info = await root.evaluate(FIELD_SCRIPT(LABEL)).catch((e) => ({ error: String(e).split("\n")[0] }));
  console.log(`\n===== ${stage} =====`);
  console.log(JSON.stringify(info, null, 1));
};

// What the reader actually hands the agent for this field — the thing that decides whether
// the agent can pick a valid option at all.
const spec = (await driver.read(root)).fields.find((f) => f.label.toLowerCase().includes(LABEL.toLowerCase()));
console.log("\n===== FieldSpec the agent receives =====");
console.log(JSON.stringify(spec ? { label: spec.label, type: spec.type, widget: spec.widget, searchable: spec.searchable, required: spec.required, filled: spec.filled, options: spec.options } : null, null, 1));

await describe("initial state");

// Drive the REAL fill path with a value from the real option list, then report what the DOM
// looks like — this is what decides success or the "could not fill" we are chasing.
if (spec && process.env.TRY_FILL !== "0") {
  const want = spec.options?.find((o) => new RegExp(WANT, "i").test(o)) ?? spec.options?.[0] ?? WANT;
  console.log(`\n>>> driver.fill(${JSON.stringify(want)}) …`);
  const ok = await driver.fill(root, spec, { key: spec.key, value: want, confidence: 1, source: "curated" });
  console.log(`>>> returned ${ok}`);
  await page.waitForTimeout(1200);
  await describe(`after driver.fill("${want}")`);
  const reread = (await driver.read(root)).fields.find((f) => f.label.toLowerCase().includes(LABEL.toLowerCase()));
  console.log(`>>> re-read filled = ${reread?.filled}`);
}

const container = root.locator('[data-automation-id^="formField"]', { hasText: LABEL }).first();
const control = container.locator("input,button,[role=combobox]").first();
await control.scrollIntoViewIfNeeded().catch(() => undefined);
await control.click().catch(() => undefined);
await page.waitForTimeout(1500);

const POPUP_SCRIPT = `(() => {
  var norm = function (s) { return (s || "").replace(/\\s+/g, " ").trim(); };
  var opts = Array.prototype.slice.call(document.querySelectorAll('[data-automation-id="promptOption"], [role="option"], [data-automation-id="promptLeafNode"]'));
  var first = [];
  for (var i = 0; i < opts.length && i < 10; i++) first.push({ aid: opts[i].getAttribute('data-automation-id'), role: opts[i].getAttribute('role'), text: norm(opts[i].innerText).slice(0, 40) });
  var lists = Array.prototype.slice.call(document.querySelectorAll('[role="listbox"], [data-automation-id*="promptPopup"], [data-automation-id*="menuList"]'));
  var ls = [];
  for (var j = 0; j < lists.length; j++) ls.push({ aid: lists[j].getAttribute('data-automation-id'), id: lists[j].id, role: lists[j].getAttribute('role') });
  return { optionCount: opts.length, firstOptions: first, listboxes: ls };
})()`;

console.log("\n===== after clicking the control =====");
console.log(JSON.stringify(await root.evaluate(POPUP_SCRIPT).catch((e) => ({ error: String(e).split("\n")[0] })), null, 1));

const option = root.locator('[data-automation-id="promptOption"], [role="option"]').filter({ hasText: WANT }).first();
if (await option.count().catch(() => 0)) {
  await option.click().catch(() => undefined);
  await page.waitForTimeout(1500);
  await describe(`after clicking option "${WANT}"`);
} else {
  console.log(`\n(no option matching "${WANT}" — see the options listed above)`);
}

// Manual walk-through: type to filter, then try each candidate node and see which one
// actually commits a selection. This is what the driver needs to imitate.
if (process.env.MANUAL !== "0") {
  const box = root.locator('[data-automation-id^="formField"]', { hasText: LABEL }).first();
  const input = box.locator("input").first();
  await root.locator("body").press("Escape").catch(() => undefined);
  await input.click().catch(() => undefined);
  await page.waitForTimeout(800);
  await input.fill("").catch(() => undefined);
  await input.pressSequentially(WANT, { delay: 25 }).catch(() => undefined);
  await page.waitForTimeout(1500);

  const listState = await root.evaluate(`(() => {
    var norm = function (s) { return (s || "").replace(/\\s+/g, " ").trim(); };
    var active = document.querySelector('[data-automation-id="activeListContainer"]');
    var rows = active ? Array.prototype.slice.call(active.querySelectorAll('*')) : [];
    var out = [];
    for (var i = 0; i < rows.length && out.length < 12; i++) {
      var aid = rows[i].getAttribute('data-automation-id');
      var role = rows[i].getAttribute('role');
      if (!aid && !role) continue;
      out.push({ tag: rows[i].tagName, aid: aid, role: role, text: norm(rows[i].innerText).slice(0, 30) });
    }
    return { activeListPresent: !!active, nodes: out };
  })()`);
  console.log("\n===== filtered list contents =====");
  console.log(JSON.stringify(listState, null, 1));

  for (const sel of ['[data-automation-id="activeListContainer"] [role="option"]', '[data-automation-id="activeListContainer"] [data-automation-id="promptOption"]', '[data-automation-id="promptLeafNode"]']) {
    const node = root.locator(sel).filter({ hasText: WANT }).first();
    if (!(await node.count().catch(() => 0))) { console.log(`  ${sel} → no node`); continue; }
    await node.click().catch((e) => console.log(`  click threw: ${String(e).split("\n")[0]}`));
    await page.waitForTimeout(1200);
    const committed = await root.evaluate(`(() => {
      var box = null, boxes = document.querySelectorAll('[data-automation-id^="formField"]');
      for (var i = 0; i < boxes.length; i++) if ((boxes[i].innerText||"").toLowerCase().indexOf(${JSON.stringify(LABEL.toLowerCase())}) >= 0) { box = boxes[i]; break; }
      if (!box) return null;
      return { label: (box.innerText||"").replace(/\\s+/g," ").trim().slice(0,90), selectedItems: box.querySelectorAll('[data-automation-id="selectedItem"]').length };
    })()`);
    console.log(`  clicked ${sel}\n    → ${JSON.stringify(committed)}`);
    if (committed && (committed as { selectedItems: number }).selectedItems > 0) { console.log("    *** THIS ONE COMMITS ***"); break; }
  }
}

console.log("\nholding the browser open 15s so the state is visible…");
await page.waitForTimeout(15000);
await context.close();

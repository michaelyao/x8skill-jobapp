import path from "node:path";
import { chromium } from "playwright";
import { WorkdayDriver } from "../agent/drivers/workday.js";

/**
 * A CHECKBOX IN A GROUP MUST BE ADDRESSABLE ON ITS OWN.  npm run test:checkboxes
 *
 * Uline GLDUAY: Workday gives every box in the CC-305 group the same `name` and no `id`, so the
 * selector read() built from that name identified all three. Playwright refuses a multi-match in
 * strict mode; the checkbox ladder catches every error it raises; isChecked() throws the same way.
 * The result was "tried but the field would not take it" on a REQUIRED question, through label,
 * parent, grandparent and a forced click, having touched nothing — while the two boxes beside it
 * reported success by doing nothing, because their answer was No.
 *
 * The application was refused, came back for re-approval, was approved again, and refused again.
 */
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`);
  }
};

const browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
const page = await browser.newPage();
await page.goto(`file://${path.resolve("test/fake-ats/workday-checkbox-group.html")}`);

const driver = new WorkdayDriver();
const root = await driver.resolveRoot(page as never);
const snapshot = await driver.read(root);
const boxes = snapshot.fields.filter((f) => f.type === "checkbox");

check(`all three boxes and the consent box are read`, boxes.length === 4, boxes.length);

// The bug itself, stated as a fact about the page: the name read() used to build the selector from
// belongs to all three boxes, so that selector could never have addressed one of them.
const sharedName = await page.locator('[name="disabilityStatus"]').count();
check(`the shared name identifies THREE controls — which is why it cannot be the key`, sharedName === 3, sharedName);

const keys = boxes.map((f) => f.key);
check(`every checkbox has its OWN selector`, new Set(keys).size === keys.length, keys);

for (const field of boxes) {
  const matches = await page.locator(field.key).count();
  check(`"${field.label.slice(0, 44)}" selector identifies exactly one control`, matches === 1, matches);
}

// The lone box with an id keeps the stable selector; only the ambiguous ones get stamped.
const consent = boxes.find((f) => /agree to the terms/i.test(f.label));
check(`a box with a unique id keeps its id selector`, consent?.key === '[id="agree"]', consent?.key);

/**
 * The fill itself, on the box that failed in production. It must tick THAT box and leave the other
 * two alone — a selector pointing at the group could as easily have ticked "Yes, I have a
 * disability", which is a false statement about a protected characteristic.
 */
// The label carries the group question as a prefix ("Please check one of the boxes below: — ..."),
// so match on the option text wherever it sits.
const target = boxes.find((f) => f.label.includes("No, I do not have a disability"));
if (!target) {
  check(`the "No, I do not have a disability" box is read`, false);
} else {
  const filled = await driver.fill(page as never, target, {
    key: target.key,
    value: "Yes",
    confidence: 1,
    source: "test",
  } as never);
  check(`the fill reports success`, filled === true);
  const state = await page.evaluate(
    `(() => Array.from(document.querySelectorAll('input[name="disabilityStatus"]')).map((b) => b.checked))()`,
  );
  check(`only the intended box is ticked`, JSON.stringify(state) === JSON.stringify([false, true, false]), state);
}

await browser.close();
console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

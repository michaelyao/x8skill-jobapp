import path from "node:path";
/**
 * Ashby's yes/no widget.  npm run test:ashby
 *
 * A Persona AI application asked eighteen questions; read() returned twelve. Five of the six it
 * missed were REQUIRED — visa sponsorship, "Do you currently reside in Houston, TX?", and three
 * about experience. They were not filled, the required-field gate could not block on them, and the
 * review page showed no sign they existed. The candidate found them by opening the form himself.
 *
 * The control is two buttons over a checkbox that is display:none, and read() keeps only visible
 * controls — rightly, or every hidden input on a page becomes a field. The buttons ARE the control.
 */
import { chromium } from "playwright";
import { AshbyDriver } from "../agent/drivers/ashby.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};

const browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
const page = await browser.newPage();
await page.goto(`file://${path.resolve("test/fake-ats/ashby-yesno.html")}`);
const driver = new AshbyDriver();

const snap = await driver.read(page as never);
const houston = snap.fields.find((f) => f.label.startsWith("Do you currently reside"));
const robotics = snap.fields.find((f) => f.label.startsWith("Do you have experience"));

console.log("reading a control the generic reader cannot see");
check("the hidden-checkbox question is found at all", Boolean(houston), snap.fields.map((f) => f.label));
check("its options come from the buttons", JSON.stringify(houston?.options) === '["Yes","No"]', houston?.options);
// Required is a CLASS on the label, not an attribute.
check("required is read from the label's class", houston?.required === true, houston?.required);
check("and a question without that class is optional", robotics?.required === false, robotics?.required);
check("each question appears ONCE — the class prefix is on the buttons too", snap.fields.filter((f) => f.label.startsWith("Do you currently reside")).length === 1);

console.log("\nfilling it");
check("answering No", (await driver.fill(page as never, houston!, { key: houston!.key, value: "No", confidence: 1, source: "curated" } as never)) === true);
check("the form shows No", (await page.locator(houston!.key).first().locator('button[aria-pressed="true"]').innerText()) === "No");
// The second question must not be driven by the first one's selector.
check("answering Yes on the OTHER question", (await driver.fill(page as never, robotics!, { key: robotics!.key, value: "Yes", confidence: 1, source: "curated" } as never)) === true);
check("the other form shows Yes", (await page.locator(robotics!.key).first().locator('button[aria-pressed="true"]').innerText()) === "Yes");
check("and the first one still shows No", (await page.locator(houston!.key).first().locator('button[aria-pressed="true"]').innerText()) === "No");

await browser.close();
console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

import path from "node:path";
/**
 * Workday's country-dialling-code prompt is a STATIC alphabetical list of ~250 entries that
 * shows fourteen rows at a time and does not filter as you type. "United States of America
 * (+1)" sits seventeen pages below "Afghanistan (+93)", so paging a few screens never reached
 * it and a required field held a real application for eighteen turns. Sorted list, known
 * target: bisect on the scroll position.
 *
 *   npm run test:longlist
 */
import { chromium } from "playwright";
import { GreenhouseDriver } from "../agent/drivers/greenhouse.js";
import type { FieldSpec } from "../agent/types.js";

const browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
const page = await browser.newPage();
await page.goto(`file://${path.resolve("test/fake-ats/workday-longlist.html")}`);
const field: FieldSpec = { key: "#code-input", label: "Country Phone Code*", type: "single_select", required: true, searchable: true, widget: "react-select" };
const started = Date.now();
const ok = await new GreenhouseDriver().fill(page as never, field, { key: field.key, value: "United States of America (+1)", confidence: 1, source: "curated" });
const picked = await page.evaluate("(() => window.__picked)()");
console.log(`fill returned ${ok} in ${((Date.now() - started) / 1000).toFixed(1)}s — picked: ${JSON.stringify(picked)}`);
console.log(picked === "United States of America (+1)" ? "✅ found it 17 pages down a static alphabetical list" : "❌ wrong or nothing picked");
await browser.close();
process.exitCode = picked === "United States of America (+1)" ? 0 : 1;

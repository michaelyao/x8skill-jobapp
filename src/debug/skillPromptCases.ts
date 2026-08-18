import path from "node:path";
import { chromium } from "playwright";
import { GreenhouseDriver } from "../agent/drivers/greenhouse.js";
import { loadSkillPlan } from "../knowledge/skillPlan.js";
import type { FieldSpec } from "../agent/types.js";

/**
 * Drives the REAL skills filler against test/fake-ats/workday-prompt.html, which reproduces the
 * five behaviours of Workday's prompt that each cost a live run to discover (search on Enter,
 * late response with the old rows left up, a windowed list, scroll reset after a pick, and
 * selected values living on as chips that also carry promptOption nodes).
 *
 * Seconds per iteration instead of ten minutes, and no more sessions opened against a real
 * application while working out why a widget behaves the way it does.
 *
 *   npx tsx src/debug/skillPromptCases.ts            # headless
 *   HEADED=1 npx tsx src/debug/skillPromptCases.ts   # watch it
 */

const browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
const page = await browser.newPage();
await page.goto(`file://${path.resolve("test/fake-ats/workday-prompt.html")}`);

const field: FieldSpec = {
  key: "#skills-input",
  label: "Type to Add Skills",
  type: "single_select",
  required: false,
  searchable: true,
  widget: "react-select",
};

const driver = new GreenhouseDriver();
const plan = await loadSkillPlan();
const wanted = plan.flatMap((g) => g.select.map((s) => `${g.search} → ${s.trim()}`));

const startedAt = Date.now();
await driver.fill(page as never, field, { key: field.key, value: "", confidence: 1, source: "curated" });
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

const selected: string[] = await page.evaluate("(() => [...(window.__selected || [])])()");
const searches: string[] = await page.evaluate("(() => window.__searches || [])()");

// What the fixture's taxonomy can actually offer — anything else is a stale line in skill.txt,
// which is a real finding, not a failure of the filler.
const available: string[] = await page.evaluate("(() => window.__selected ? [] : [])()");
const taxonomy: string[] = await page.evaluate(
  "(() => { const s = document.documentElement.innerHTML.match(/const TAXONOMY = \\[([\\s\\S]*?)\\];/); return s ? s[1].split(',').map(x => x.trim().replace(/^\"|\"$/g, '')).filter(Boolean) : []; })()",
);

const reachable = plan.flatMap((g) =>
  g.select
    .map((s) => s.trim())
    .filter((s) => taxonomy.some((t) => t.toLowerCase() === s.toLowerCase()))
    .map((s) => `${g.search} → ${s}`),
);
const got = new Set(selected.map((s) => s.toLowerCase()));
const missed = reachable.filter((entry) => !got.has(entry.split(" → ")[1].toLowerCase()));

console.log(`${plan.length} groups · ${wanted.length} curated entries · ${searches.length} searches · ${seconds}s`);
console.log(`selected ${selected.length}: ${selected.slice(0, 8).join(" | ")}${selected.length > 8 ? ` (+${selected.length - 8})` : ""}`);
console.log(`\nin the taxonomy and REACHABLE: ${reachable.length}`);
if (missed.length) {
  console.log(`❌ missed ${missed.length} that the taxonomy does offer:`);
  for (const m of missed) console.log(`     ${m}`);
} else {
  console.log("✅ every entry the taxonomy offers was selected");
}
const absent = wanted.filter((entry) => !reachable.includes(entry));
if (absent.length) {
  console.log(`\nnot in this taxonomy at all (${absent.length}) — correctly reported, not a filler bug:`);
  for (const a of absent) console.log(`     ${a}`);
}
await browser.close();
process.exitCode = missed.length ? 1 : 0;

/**
 * What is INSIDE an open Workday prompt — specifically, which element is the search box.
 *
 *   npx tsx src/debug/inspectOpenPrompt.ts <url> [fieldMatch]
 *
 * SELECT_TRACE showed the same line over and over: `typed "Link" → control shows ""`. We type into
 * the element with aria-haspopup="listbox", which is a BUTTON — buttons hold no value, so the text
 * goes nowhere and the list never filters. The driver has a comment admitting "the node we type
 * into is not always the search box it listens to", and it has been guessing ever since.
 *
 * So open one and look: every input, its automation id, where it sits relative to the trigger and
 * to the open list.
 */
import { chromium } from "playwright";
import { loadEnv } from "../utils/env.js";
import { AUTH_DIR } from "../config.js";
import { WorkdayDriver } from "../agent/drivers/workday.js";

loadEnv();
const url = process.argv[2];
const match = (process.argv[3] ?? "").toLowerCase();
if (!url) { console.error("usage: npx tsx src/debug/inspectOpenPrompt.ts <url> [fieldMatch]"); process.exit(1); }

const ctx = await chromium.launchPersistentContext(AUTH_DIR, {
  channel: "chrome", headless: false, chromiumSandbox: true,
  viewport: { width: 1440, height: 1000 },
  ignoreDefaultArgs: ["--enable-automation"],
  args: ["--disable-blink-features=AutomationControlled"],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => undefined);
await page.waitForTimeout(2500);
await new WorkdayDriver().openApplication(page).catch(() => undefined);
await page.waitForTimeout(2000);
console.log(`\n>>> ${page.url()}`);

// Pick a prompt inside a form field, optionally matching a label.
const picked = await page.evaluate(`(() => {
  const buttons = [...document.querySelectorAll('button[aria-haspopup="listbox"]')]
    .filter((b) => b.offsetParent !== null && b.closest('[data-automation-id^="formField"]'));
  const want = ${JSON.stringify(match)};
  const chosen = buttons.find((b) => {
    const ff = b.closest('[data-automation-id^="formField"]');
    return !want || ((ff && ff.innerText) || "").toLowerCase().includes(want);
  }) || buttons[0];
  if (!chosen) return null;
  chosen.setAttribute("data-probe", "1");
  const ff = chosen.closest('[data-automation-id^="formField"]');
  return { label: ((ff && ff.innerText) || "").replace(/\\s+/g, " ").trim().slice(0, 60), id: ff ? ff.getAttribute("data-automation-id") : "" };
})()`);
if (!picked) { console.log("no prompt found in a form field"); await ctx.close(); process.exit(0); }
console.log(`>>> opening: ${(picked as { label: string }).label}  [${(picked as { id: string }).id}]\n`);

await page.locator('[data-probe="1"]').first().click().catch(() => undefined);
await page.waitForTimeout(1200);

const dump = await page.evaluate(`(() => {
  const out = { inputs: [], list: null, activeElement: null };
  const idOf = (el) => (el && el.getAttribute ? el.getAttribute("data-automation-id") || "" : "");
  const ae = document.activeElement;
  out.activeElement = ae ? { tag: ae.tagName.toLowerCase(), id: idOf(ae), type: ae.getAttribute("type") || "", aria: ae.getAttribute("aria-label") || "" } : null;
  for (const inp of document.querySelectorAll('input:not([type=hidden]), [contenteditable="true"], [role="combobox"]')) {
    if (inp.offsetParent === null) continue;
    const r = inp.getBoundingClientRect();
    out.inputs.push({
      tag: inp.tagName.toLowerCase(),
      automationId: idOf(inp),
      type: inp.getAttribute("type") || "",
      role: inp.getAttribute("role") || "",
      aria: (inp.getAttribute("aria-label") || "").slice(0, 34),
      inList: Boolean(inp.closest('[data-automation-id="activeListContainer"]')),
      inFormField: Boolean(inp.closest('[data-automation-id^="formField"]')),
      focused: inp === document.activeElement,
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width)],
    });
  }
  // WHERE DO THE OPTION ROWS ACTUALLY LIVE? Two attempts at fixing read-time option capture by
  // reasoning about locators both failed, while the fill path finds seven options every time. So
  // stop reasoning: find every option row on the page and print its ancestry.
  out.optionRows = [];
  for (const row of document.querySelectorAll('[data-automation-id="promptOption"], [role="option"], [class*="select__option"]')) {
    if (row.offsetParent === null) continue;
    const parts = [];
    for (let n = row; n && n !== document.body; n = n.parentElement) {
      const id = n.getAttribute && n.getAttribute("data-automation-id");
      if (id) parts.unshift(id);
      else if (n.tagName === "UL" || n.tagName === "LI") parts.unshift(n.tagName.toLowerCase());
    }
    out.optionRows.push({
      text: (row.textContent || "").trim().slice(0, 26),
      automationId: row.getAttribute("data-automation-id") || "",
      role: row.getAttribute("role") || "",
      inFormField: Boolean(row.closest('[data-automation-id^="formField"]')),
      inActiveList: Boolean(row.closest('[data-automation-id="activeListContainer"]')),
      ancestry: parts.slice(0, 7).join(" > "),
    });
  }
  const lc = document.querySelector('[data-automation-id="activeListContainer"]');
  if (lc) {
    out.list = {
      visible: lc.offsetParent !== null,
      rows: lc.querySelectorAll('[data-automation-id="promptOption"], [role="option"]').length,
      hasInput: Boolean(lc.querySelector("input")),
      firstRows: [...lc.querySelectorAll('[data-automation-id="promptOption"], [role="option"]')].slice(0, 4).map((r) => (r.textContent || "").trim().slice(0, 26)),
    };
  }
  return out;
})()`);
const d = dump as { inputs: Array<Record<string, unknown>>; list: Record<string, unknown> | null; activeElement: Record<string, unknown> | null };
console.log("FOCUSED after the click (this is what pressSequentially types into):");
console.log(`  ${JSON.stringify(d.activeElement)}\n`);
console.log("THE OPEN LIST:");
console.log(`  ${JSON.stringify(d.list)}\n`);
const rows = (dump as { optionRows?: Array<Record<string, unknown>> }).optionRows ?? [];
console.log(`OPTION ROWS ON THE PAGE (${rows.length}) — where they live:`);
for (const r of rows.slice(0, 10)) {
  console.log(`  "${String(r.text).padEnd(26)}" id=${String(r.automationId || "-").padEnd(14)} role=${String(r.role || "-").padEnd(8)} formField=${r.inFormField ? "Y" : "n"} activeList=${r.inActiveList ? "Y" : "n"}`);
  console.log(`     ${r.ancestry}`);
}
console.log("");
console.log(`VISIBLE INPUTS (${d.inputs.length}) — inList / inFormField / focused:`);
for (const i of d.inputs) {
  console.log(`  ${i.focused ? "FOCUSED" : "       "} ${String(i.tag + (i.type ? ":" + i.type : "")).padEnd(12)} list=${i.inList ? "Y" : "n"} field=${i.inFormField ? "Y" : "n"} id=${String(i.automationId).slice(0, 28).padEnd(30)} aria="${i.aria}"`);
}
await ctx.close();

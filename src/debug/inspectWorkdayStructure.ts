/**
 * The STRUCTURE of a Workday form page, not its values.
 *
 *   npx tsx src/debug/inspectWorkdayStructure.ts <url>
 *
 * Written because a day of failures all had one root: page-wide selectors standing in for
 * knowledge of the page. `button[aria-haspopup="listbox"]` across the whole document caught the
 * header's LANGUAGE PICKER and changed the site to Thai; an unscoped `[role="option"]` read the
 * field above's menu; a footer click landed on an overlay nobody had accounted for. Each was
 * patched separately, which is the wrong shape of fix.
 *
 * So: dump the containers, the sections, the automation ids and where every popup button actually
 * lives. Structure survives the language, which is useful right now because the account this was
 * built against is currently in Thai.
 */
import { chromium } from "playwright";
import { loadEnv } from "../utils/env.js";
import { AUTH_DIR } from "../config.js";
import { WorkdayDriver } from "../agent/drivers/workday.js";

loadEnv();
const url = process.argv[2];
if (!url) { console.error("usage: npx tsx src/debug/inspectWorkdayStructure.ts <url>"); process.exit(1); }

const ctx = await chromium.launchPersistentContext(AUTH_DIR, {
  channel: "chrome",
  headless: false,
  chromiumSandbox: true,
  viewport: { width: 1440, height: 1000 },
  ignoreDefaultArgs: ["--enable-automation"],
  args: ["--disable-blink-features=AutomationControlled"],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => undefined);
await page.waitForTimeout(2500);
const driver = new WorkdayDriver();
await driver.openApplication(page).catch((e) => console.log("openApplication: " + (e as Error).message.split("\n")[0]));
await page.waitForTimeout(2000);
console.log(`\n>>> ${page.url()}\n`);

const report = await page.evaluate(`(() => {
  const out = { popups: [], sections: [], fields: [] };
  const idOf = (el) => el && el.getAttribute ? (el.getAttribute("data-automation-id") || "") : "";
  const path = (el) => {
    const parts = [];
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const id = idOf(n);
      if (id) parts.unshift(id);
      if (parts.length >= 5) break;
    }
    return parts.join(" > ");
  };

  // EVERY popup button, and whether it is inside a form field or part of the page chrome.
  for (const b of document.querySelectorAll('button[aria-haspopup="listbox"], button[aria-haspopup="menu"]')) {
    if (b.offsetParent === null) continue;
    const ff = b.closest('[data-automation-id^="formField"]');
    out.popups.push({
      text: (b.textContent || "").trim().slice(0, 40),
      inFormField: Boolean(ff),
      ariaLabel: (b.getAttribute("aria-label") || "").slice(0, 40),
      ariaControls: b.getAttribute("aria-controls") || null,
      ancestry: path(b).slice(0, 90),
    });
  }

  // Section headings, which is how a human reads this page: Legal Name, Address, Phone.
  for (const h of document.querySelectorAll('h2, h3, h4, [role="heading"], [data-automation-id*="sectionTitle" i], [data-automation-id*="Header" i]')) {
    if (h.offsetParent === null) continue;
    const t = (h.textContent || "").replace(/\\s+/g, " ").trim();
    if (t && t.length < 70) out.sections.push({ text: t.slice(0, 50), tag: h.tagName.toLowerCase(), id: idOf(h) });
  }

  // Each form field, with the nearest heading ABOVE it — the section it belongs to.
  const headings = [...document.querySelectorAll('h2, h3, h4, [role="heading"]')].filter((h) => h.offsetParent !== null);
  for (const ff of document.querySelectorAll('[data-automation-id^="formField"]')) {
    if (ff.offsetParent === null) continue;
    let section = "";
    const top = ff.getBoundingClientRect().top + window.scrollY;
    for (const h of headings) {
      const ht = h.getBoundingClientRect().top + window.scrollY;
      if (ht <= top) section = (h.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40);
    }
    const control = ff.querySelector('input, select, textarea, button[aria-haspopup]');
    out.fields.push({
      automationId: idOf(ff),
      section,
      control: control ? control.tagName.toLowerCase() + (control.getAttribute("type") ? ":" + control.getAttribute("type") : "") : "none",
      controlId: control ? (control.getAttribute("data-automation-id") || "") : "",
    });
  }
  return out;
})()`);

const r = report as { popups: Array<Record<string, unknown>>; sections: Array<Record<string, unknown>>; fields: Array<Record<string, unknown>> };
console.log(`POPUP BUTTONS (${r.popups.length}) — the ones NOT in a form field are page chrome:`);
for (const p of r.popups) {
  console.log(`  ${p.inFormField ? "field " : "CHROME"}  ${String(p.text || p.ariaLabel).padEnd(30)} aria-controls=${p.ariaControls ?? "(none)"}`);
  console.log(`           ${p.ancestry}`);
}
console.log(`\nSECTION HEADINGS (${r.sections.length}):`);
for (const s of r.sections) console.log(`  <${s.tag}> ${s.text}${s.id ? "  [" + s.id + "]" : ""}`);
console.log(`\nFORM FIELDS (${r.fields.length}) — automationId, the section it sits under, its control:`);
for (const f of r.fields) console.log(`  ${String(f.automationId).slice(0, 40).padEnd(42)} ${String(f.section).padEnd(26)} ${f.control}${f.controlId ? " [" + f.controlId + "]" : ""}`);
await ctx.close();

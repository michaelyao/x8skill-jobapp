import { chromium } from "playwright";
import { WorkableDriver } from "../agent/drivers/workable.js";

/**
 * Work out how Workable's repeatable Education/Experience entries actually behave, before writing
 * a driver that assumes. Fills ONE education entry with obvious test values, tries each way of
 * setting the MM/YYYY date, clicks Update, and reports what survived.
 *
 *   npx tsx src/debug/probeWorkableEntry.ts <workable posting url> [--headed]
 *
 * Nothing is submitted. A throwaway browser, never playwright/.auth.
 *
 * The three unknowns it exists to answer:
 *   1. Do the MM/YYYY date inputs accept typing, or do they require the calendar widget? The
 *      agent recorded "05/2028" for an End date that the screenshot shows EMPTY, so something
 *      reported success without committing.
 *   2. What does Update do — and how can we tell an entry COMMITTED rather than just looked filled?
 *   3. After Update, does "+ Add" become available for the next entry?
 */
const url = process.argv[2];
if (!url) {
  console.error("usage: npx tsx src/debug/probeWorkableEntry.ts <url> [--headed]");
  process.exit(1);
}

const browser = await chromium.launch({
  headless: !process.argv.includes("--headed"),
  ignoreDefaultArgs: ["--enable-automation"],
  args: ["--disable-blink-features=AutomationControlled"],
});
try {
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    viewport: { width: 1400, height: 1200 },
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2500);

  const driver = new WorkableDriver();
  await driver.openApplication(page);
  await driver.resolveRoot(page); // expands the sections

  const show = async (stage: string) => {
    const dump = (await page.evaluate(`(() => {
      var vis = function (el) { return el.offsetParent !== null || el.getClientRects().length > 0; };
      var out = { inputs: [], buttons: [], entries: [] };
      var nodes = document.querySelectorAll("input:not([type=hidden]), textarea");
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (!vis(el)) continue;
        var lab = el.getAttribute("aria-label") || "";
        if (!lab && el.id) { var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) lab = (l.innerText||"").replace(/\\s+/g," ").trim(); }
        out.inputs.push({
          label: lab.slice(0, 34), name: el.getAttribute("name") || "", id: (el.id||"").slice(0,28),
          type: el.getAttribute("type") || el.tagName.toLowerCase(),
          value: (el.value || "").slice(0, 40),
          readOnly: el.readOnly === true, placeholder: (el.getAttribute("placeholder")||"").slice(0,12),
          checked: el.type === "checkbox" ? el.checked : undefined,
        });
      }
      var bn = document.querySelectorAll("button");
      for (var j = 0; j < bn.length; j++) {
        var b = bn[j];
        if (!vis(b)) continue;
        var t = (b.innerText || "").replace(/\\s+/g, " ").trim();
        if (!t) t = b.getAttribute("aria-label") || "";
        if (!t) continue;
        out.buttons.push({ text: t.slice(0, 24), disabled: b.disabled === true, aria: (b.getAttribute("aria-label")||"").slice(0,22) });
      }
      // A COMMITTED entry usually renders as a static summary row rather than inputs. Anything
      // with an Edit/Delete pair beside it is a committed record.
      var eds = document.querySelectorAll('button[aria-label*="Edit" i], button[aria-label*="Delete" i], button[aria-label*="Remove" i]');
      for (var k = 0; k < eds.length; k++) out.entries.push(eds[k].getAttribute("aria-label"));
      return out;
    })()`)) as any;
    console.log(`\n${"=".repeat(76)}\n${stage}\n${"=".repeat(76)}`);
    console.log(`  inputs (${dump.inputs.length}):`);
    for (const i of dump.inputs) {
      console.log(
        `    ${(i.label || i.name || i.id).padEnd(34)} type=${String(i.type).padEnd(8)}` +
          ` value=${JSON.stringify(i.value)}${i.readOnly ? " READONLY" : ""}${i.placeholder ? ` ph=${i.placeholder}` : ""}` +
          `${i.checked !== undefined ? ` checked=${i.checked}` : ""}`,
      );
    }
    console.log(`  buttons: ${dump.buttons.map((b: any) => `"${b.text}"${b.disabled ? "(disabled)" : ""}`).join(" ")}`);
    console.log(`  committed-entry controls: ${dump.entries.length ? dump.entries.join(", ") : "(none)"}`);
  };

  await show("AFTER EXPANDING");

  // --- the real thing: fill EVERY education and experience entry from the resume ------------
  const fs = await import("node:fs/promises");
  const { loadProfile } = await import("../knowledge/profile.js");
  const profile = await loadProfile();
  const resumeText = profile.resumeText || profile.rawText || (await fs.readFile("nathan resume 2026.txt", "utf8"));
  console.log(`\n>>> fillHistorySections\n`);
  const outcome = await driver.fillHistorySections!(page, {
    company: "probe", title: "probe", resumeText, profile, answers: [],
  });
  console.log(`\n  education: ${outcome.educationCommitted}/${outcome.educationExpected}`);
  console.log(`  experience: ${outcome.experienceCommitted}/${outcome.experienceExpected}`);
  if (outcome.derived.length) console.log(`  derived: ${outcome.derived.join(" | ")}`);
  if (outcome.problems.length) for (const p of outcome.problems) console.log(`  PROBLEM: ${p}`);
  await show("AFTER FILLING ALL HISTORY");

  console.log(`\nNOTHING was submitted.`);
} finally {
  await browser.close();
}

/**
 * Why does the reader not see a field the page plainly shows?
 *
 * Written for one live bug: GE Vernova, Northrop and RTX all fill Address Line 1, City and Postal
 * Code, never touch the required State field, and are then rejected with "94085 is not a valid
 * postal code for Pennsylvania" — the form keeping its own default because we never set it. The
 * reader HAS filled State 33 times on other tenants, so the pattern is right and something about
 * these pages hides it.
 *
 * Rather than guess, this walks the real driver to the form and prints the DOM's form fields
 * beside driver.read()'s output, so the ones the reader MISSED are named explicitly.
 *
 * Non-interactive, and it never fills or submits anything.
 *
 *   JOB_ID=ZJQCPS npx tsx src/debug/inspectAddressFields.ts
 *
 * The worker must be idle: it owns the same Chrome profile, and Chrome is single-instance per
 * user-data-dir. Check with ./bin/jobapp status.
 */
import fs from "node:fs";
import { chromium } from "playwright";
import { loadEnv } from "../utils/env.js";
import { AUTH_DIR, DATA_DIR } from "../config.js";
import { WorkdayDriver } from "../agent/drivers/workday.js";
import { workdayEnglishUrl } from "../utils/normalize.js";
import { loadApplications } from "../knowledge/applications.js";
import { loadInternshipList } from "../sources/internshipList.js";

loadEnv();

const code = (process.env.JOB_ID || "").toUpperCase();
if (!code) {
  console.error("JOB_ID=<CODE> is required, e.g. JOB_ID=ZJQCPS");
  process.exit(1);
}

// The worker holds this lock while it drives Chrome. Two processes on one user-data-dir is the
// hazard that produced "browser is busy elsewhere" for 23 queued commands.
const lock = `${DATA_DIR}/.browser.lock`;
if (fs.existsSync(lock)) {
  console.error(`data/.browser.lock exists (pid ${fs.readFileSync(lock, "utf8").trim()}) — the worker is driving Chrome. Wait for it to go idle.`);
  process.exit(1);
}

async function main(): Promise<void> {
  const listed = (await loadInternshipList().catch(() => [])).find((j) => j.id === code);
  const record = (await loadApplications()).find((a) => a.code === code);
  const url = listed?.applyUrl ?? record?.applyUrl;
  if (!url) {
    console.error(`no apply URL known for ${code}`);
    process.exit(1);
  }

  const context = await chromium.launchPersistentContext(AUTH_DIR, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1440, height: 1000 },
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const target = workdayEnglishUrl(url);
    console.log(`opening ${target}`);
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });

    const driver = new WorkdayDriver();
    console.log("running the real openApplication (auth + Apply)…");
    await driver.openApplication(page);
    const root = await driver.resolveRoot(page);
    await page.waitForTimeout(2500);

    // What the reader reports.
    const snapshot = await driver.read(root);
    // Compare on a NORMALISED key both sides. Comparing a *-stripped DOM label against a reader
    // label that keeps its asterisk reports every required field as "missed" — which is exactly
    // the false positive this probe produced on its first run.
    const key = (t: string): string => t.replace(/\*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    const seen = new Set(snapshot.fields.map((f) => key(f.label)));
    console.log(`\ndriver.read() → ${snapshot.fields.length} field(s), submitReady=${snapshot.submitReady}`);
    for (const f of snapshot.fields) {
      console.log(`    READER  ${JSON.stringify(f.label)}  type=${f.type} required=${f.required} filled=${f.filled} widget=${f.widget ?? "-"}`);
    }

    // What the DOM actually holds. Every formField wrapper, with the things the reader uses to
    // classify one: its label, the controls inside it, and how many options they offer.
    const dom = JSON.parse(
      (await root.evaluate(`(() => {
        const clean = (t) => (t || "").replace(/\\s+/g, " ").trim();
        const out = [];
        for (const box of Array.from(document.querySelectorAll('[data-automation-id^="formField-"]'))) {
          const labelEl = box.querySelector('label, legend, [id$="-label"]');
          const inputs = Array.from(box.querySelectorAll("input, select, textarea, [role=combobox], [role=listbox], [role=button]"));
          out.push({
            id: box.getAttribute("data-automation-id") || "",
            label: clean(labelEl && labelEl.textContent),
            required: /\\*/.test(clean(labelEl && labelEl.textContent)) || box.querySelector("[aria-required=true]") !== null,
            // read()'s EXACT visibility test, plus the geometry behind it. If a control fails
            // this, read() never even considers it — which is the difference between "the
            // reader has a labelling bug" and "the reader never saw the element".
            controls: inputs.map((el) => ({
              readWouldSee:
                (el.tagName.toLowerCase() === "input" && el.getAttribute("type") !== "hidden" && el.getAttribute("type") !== "file") ||
                ["textarea", "select"].includes(el.tagName.toLowerCase())
                  ? (el.offsetParent !== null || el.getClientRects().length > 0)
                  : "not-a-candidate",
              rects: el.getClientRects().length,
              offsetParent: el.offsetParent !== null,
              box: (function () { var r = el.getBoundingClientRect(); return Math.round(r.width) + "x" + Math.round(r.height); })(),
              tag: el.tagName.toLowerCase(),
              type: el.getAttribute("type") || "",
              role: el.getAttribute("role") || "",
              aid: el.getAttribute("data-automation-id") || "",
              options: el.tagName.toLowerCase() === "select" ? el.querySelectorAll("option").length : 0,
              disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
              hidden: el.getAttribute("aria-hidden") === "true",
            })),
            visible: box.getClientRects().length > 0,
          });
        }
        return JSON.stringify(out);
      })()`)) as string,
    ) as Array<{ id: string; label: string; required: boolean; visible: boolean; controls: Array<Record<string, unknown>> }>;

    console.log(`DOM → ${dom.length} formField wrapper(s)\n`);

    const missed = dom.filter((d) => d.label && !seen.has(key(d.label)));
    console.log(`=== fields the DOM has and the reader did NOT report (${missed.length}) ===`);
    for (const d of missed) {
      console.log(`  ${d.id}`);
      console.log(`    label     ${JSON.stringify(d.label)}  required=${d.required} visible=${d.visible}`);
      for (const c of d.controls) console.log(`    control   ${JSON.stringify(c)}`);
    }

    // For a wrapper whose input is 0x0, WHAT is the visible thing the user clicks? read() has to
    // find that instead. Dump every visible descendant of the two wrappers that matter.
    const triggers = JSON.parse(
      (await root.evaluate(`(() => {
        const clean = (t) => (t || "").replace(/\\s+/g, " ").trim();
        const out = [];
        for (const id of ["formField-country", "formField-countryRegion"]) {
          const box = document.querySelector('[data-automation-id="' + id + '"]');
          if (!box) continue;
          const kids = [];
          for (const el of Array.from(box.querySelectorAll("*"))) {
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            kids.push({
              tag: el.tagName.toLowerCase(),
              role: el.getAttribute("role") || "",
              aid: el.getAttribute("data-automation-id") || "",
              haspopup: el.getAttribute("aria-haspopup") || "",
              text: clean(el.textContent).slice(0, 40),
              box: Math.round(r.width) + "x" + Math.round(r.height),
            });
          }
          out.push({ id: id, visibleDescendants: kids.slice(0, 12) });
        }
        return JSON.stringify(out);
      })()`)) as string,
    ) as Array<{ id: string; visibleDescendants: Array<Record<string, unknown>> }>;
    console.log(`\n=== what the user actually clicks in those wrappers ===`);
    for (const t of triggers) {
      console.log(`  ${t.id}`);
      for (const k of t.visibleDescendants) console.log(`    ${JSON.stringify(k)}`);
    }

    console.log(`\n=== the address block, whatever its state ===`);
    for (const d of dom) {
      if (!/address|city|state|province|region|postal|zip|country/i.test(`${d.id} ${d.label}`)) continue;
      const read = seen.has(key(d.label));
      console.log(`  ${read ? "READ  " : "MISSED"} ${d.id.padEnd(34)} ${JSON.stringify(d.label)}`);
      for (const c of d.controls) console.log(`         ${JSON.stringify(c)}`);
    }
  } finally {
    await context.close();
  }
}

void main();

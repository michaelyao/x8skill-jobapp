import { chromium } from "playwright";
import { WorkdayDriver } from "../agent/drivers/workday.js";
import { loadEnv } from "../utils/env.js";

/**
 * Dump what a control on a real posting actually IS, when a fill keeps refusing to take.
 *
 *   npx tsx src/debug/inspectControl.ts <url> "<text on the page>" [--headed]
 *
 * Walks forward through the form until a page contains the text, then prints, for every checkbox
 * and radio near it: the selector `read()` would build, how many elements that selector MATCHES,
 * whether it is disabled or hidden, its box, and WHAT IS TOPMOST AT ITS CENTRE. Fills nothing and
 * never touches a submit control.
 *
 * Written for Uline GLDUAY, where "No, I do not have a disability and have not had one in the past"
 * reported "tried but the field would not take it" through the whole escalation ladder — label,
 * parent, grandparent, forced click — while the two boxes beside it reported success by doing
 * nothing at all (their answer was No, which is satisfied by leaving them clear). Every step in
 * that ladder swallows its own error, so a locator that matches more than one element fails
 * silently and identically to a covered control. This says which.
 *
 * A throwaway browser on purpose, never playwright/.auth: the worker holds data/.browser.lock and
 * Chrome is single-instance per user-data-dir. The driver signs in with the same credentials.
 */
loadEnv();

const url = process.argv[2];
const needle = process.argv[3];
if (!url || !needle) {
  console.error('usage: npx tsx src/debug/inspectControl.ts <url> "<text on the page>" [--headed]');
  process.exit(1);
}

const DIAGNOSE = `(() => {
  const needle = ${JSON.stringify(needle)};
  const boxes = Array.from(document.querySelectorAll('input[type="checkbox"], input[type="radio"]'));
  const labelFor = (el) => {
    const id = el.getAttribute("id");
    if (id) {
      const l = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      if (l && l.innerText) return l.innerText.trim();
    }
    const wrap = el.closest("label");
    if (wrap && wrap.innerText) return wrap.innerText.trim();
    return "";
  };
  const out = [];
  for (const el of boxes) {
    const label = labelFor(el);
    const rect = el.getBoundingClientRect();
    const idAttr = el.getAttribute("id");
    const nameAttr = el.getAttribute("name");
    // The selector read() would build, in the same order of preference.
    const key = idAttr ? '[id="' + idAttr + '"]' : nameAttr ? '[name="' + nameAttr + '"]' : "(stamped)";
    let matches = -1;
    try { matches = key === "(stamped)" ? 1 : document.querySelectorAll(key).length; } catch (e) { matches = -2; }
    const style = window.getComputedStyle(el);
    let topmost = "";
    if (rect.width > 0 && rect.height > 0) {
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (hit) {
        topmost = hit.tagName.toLowerCase() +
          (hit.getAttribute("data-automation-id") ? '[' + hit.getAttribute("data-automation-id") + ']' : "") +
          (hit === el ? " (THE INPUT ITSELF)" : hit.contains(el) ? " (an ancestor)" : " (SOMETHING ELSE)");
      }
    }
    let labelCount = 0;
    if (idAttr) {
      try { labelCount = document.querySelectorAll('label[for="' + idAttr.replace(/"/g, '\\\\"') + '"]').length; } catch (e) { labelCount = -1; }
    }
    out.push({
      label: label.slice(0, 70),
      type: el.getAttribute("type"),
      key: key.slice(0, 80),
      matches: matches,
      labelsFor: labelCount,
      checked: el.checked,
      disabled: el.disabled,
      ariaHidden: el.getAttribute("aria-hidden"),
      box: Math.round(rect.width) + "x" + Math.round(rect.height),
      display: style.display + "/" + style.visibility + "/opacity:" + style.opacity,
      pointerEvents: style.pointerEvents,
      topmost: topmost,
      parent: el.parentElement ? el.parentElement.tagName.toLowerCase() + (el.parentElement.getAttribute("data-automation-id") ? '[' + el.parentElement.getAttribute("data-automation-id") + ']' : "") : "",
    });
  }
  const hasNeedle = (document.body.innerText || "").indexOf(needle) >= 0;
  return JSON.stringify({ hasNeedle: hasNeedle, controls: out }, null, 1);
})()`;

const browser = await chromium.launch({
  headless: !process.argv.includes("--headed"),
  ignoreDefaultArgs: ["--enable-automation"],
  args: ["--disable-blink-features=AutomationControlled"],
});
try {
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 1000 },
  });
  const driver = new WorkdayDriver();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await driver.openApplication(page);
  const root = await driver.resolveRoot(page);

  for (let step = 0; step < 10; step += 1) {
    const text = ((await page.evaluate("(() => document.body.innerText || '')()")) as string) || "";
    const heading = text.split("\n").find((l) => l.trim().length > 3) ?? "";
    console.log(`  [${step}] ${page.url().slice(0, 70)} — ${heading.trim().slice(0, 50)}`);
    if (text.includes(needle)) {
      const dump = (await root.evaluate(DIAGNOSE)) as string;
      console.log(dump);
      const html = (await root.evaluate(
        `(() => {
          const needle = ${JSON.stringify(needle)};
          const all = Array.from(document.querySelectorAll("div,fieldset,section"));
          let best = null;
          for (const el of all) {
            if ((el.innerText || "").indexOf(needle) < 0) continue;
            if (el.querySelectorAll('input[type="checkbox"]').length < 1) continue;
            if (!best || el.innerText.length < best.innerText.length) best = el;
          }
          return best ? best.outerHTML.slice(0, 6000) : "(no container found)";
        })()`,
      )) as string;
      console.log("\n  === container HTML ===\n" + html);
      break;
    }
    const next = await driver.next(root);
    if (!next) {
      console.log("  no next control — stopping");
      break;
    }
    await page.waitForTimeout(2500);
  }
} finally {
  await browser.close();
}

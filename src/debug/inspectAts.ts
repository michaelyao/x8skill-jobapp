import { chromium } from "playwright";
import { APPLY, NEXT, SUBMIT } from "../agent/drivers/base.js";

/**
 * Dump the shape of an unfamiliar ATS application form, so a driver can be written from what is
 * actually on the page rather than from a guess.
 *
 *   npx tsx src/debug/inspectAts.ts <url> [--headed] [--no-apply]
 *
 * Deliberately a THROWAWAY browser, never the persistent playwright/.auth profile: the worker
 * holds data/.browser.lock and Chrome is single-instance per user-data-dir, so borrowing that
 * profile would collide with a live application. Nothing here fills or submits anything.
 */
const url = process.argv[2];
if (!url) {
  console.error("usage: npx tsx src/debug/inspectAts.ts <url> [--headed] [--no-apply]");
  process.exit(1);
}
const headed = process.argv.includes("--headed");
const skipApply = process.argv.includes("--no-apply");

const DUMP = `(() => {
  var vis = function (el) { return el.offsetParent !== null || el.getClientRects().length > 0; };
  var txt = function (el) { return ((el && el.innerText) || "").replace(/\\s+/g, " ").trim().slice(0, 90); };
  var labelFor = function (el) {
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
    var id = el.id;
    if (id) { var l = document.querySelector('label[for="' + CSS.escape(id) + '"]'); if (l) return txt(l); }
    var lab = el.closest("label"); if (lab) return txt(lab);
    var by = el.getAttribute("aria-labelledby");
    if (by) { var n = document.getElementById(by); if (n) return txt(n); }
    var fg = el.closest('[class*="field" i],[class*="form" i],[data-testid],fieldset,div');
    return fg ? txt(fg).slice(0, 70) : "";
  };
  var fields = [];
  var nodes = document.querySelectorAll("input,select,textarea,[role=combobox],[role=radiogroup],[contenteditable=true]");
  for (var i = 0; i < nodes.length && fields.length < 60; i++) {
    var el = nodes[i];
    var type = (el.getAttribute("type") || el.tagName).toLowerCase();
    if (type === "hidden") continue;
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    fields.push({
      tag: el.tagName.toLowerCase(), type: type, name: el.getAttribute("name") || "",
      id: el.id || "", testid: el.getAttribute("data-testid") || el.getAttribute("data-ui") || "",
      required: el.required || el.getAttribute("aria-required") === "true",
      visible: vis(el), label: labelFor(el),
      // Bot-trap tells. A honeypot is a REAL, focusable input that a human never sees: filling
      // it is a self-report. It usually passes the offsetParent/getClientRects visibility test
      // that read() uses, so it has to be recognised some other way.
      box: Math.round(r.width) + "x" + Math.round(r.height),
      offscreen: r.left < -500 || r.top < -500 || r.width < 2 || r.height < 2,
      clipped: cs.clip !== "auto" || (cs.clipPath && cs.clipPath !== "none") || cs.opacity === "0",
      ariaHidden: el.getAttribute("aria-hidden") || "", tabindex: el.getAttribute("tabindex") || "",
      trapName: /honey|hpot|_bot|bot_|trap|dummy|nospam/i.test((el.getAttribute("name") || "") + " " + el.id),
    });
  }
  var buttons = [];
  var bn = document.querySelectorAll('button,a[role=button],input[type=submit],[role=button]');
  for (var j = 0; j < bn.length && buttons.length < 40; j++) {
    var b = bn[j];
    if (!vis(b)) continue;
    // A generic button ("+ Add") means nothing on its own — what it adds is in the section around
    // it. Carry the nearest heading/label above it so it can be scoped by intent, not by index.
    var sect = "";
    var up = b.parentElement;
    for (var d = 0; d < 5 && up && !sect; d++) {
      var h = up.querySelector("h1,h2,h3,h4,h5,legend,label,[class*=label i]");
      if (h && h.innerText) sect = h.innerText.replace(/\\s+/g, " ").trim().slice(0, 40);
      up = up.parentElement;
    }
    buttons.push({ text: txt(b) || b.getAttribute("aria-label") || "", type: b.getAttribute("type") || "",
                   id: b.id || "", testid: b.getAttribute("data-testid") || "",
                   aria: b.getAttribute("aria-label") || "", section: sect });
  }
  // Checkboxes and radios that a plain .check() will not move: dump enough structure to see WHAT
  // the human actually clicks. Guessing this twice is worse than looking once.
  var toggles = [];
  var tg = document.querySelectorAll('input[type=checkbox],input[type=radio],[role=checkbox],[role=switch]');
  for (var k = 0; k < tg.length && toggles.length < 8; k++) {
    var t = tg[k];
    var chain = [];
    var up = t.parentElement;
    for (var d = 0; d < 3 && up; d++) {
      chain.push("<" + up.tagName.toLowerCase() +
        (up.id ? ' id="' + up.id + '"' : "") +
        (up.className && typeof up.className === "string" ? ' class="' + up.className.slice(0, 70) + '"' : "") +
        (up.getAttribute("role") ? ' role="' + up.getAttribute("role") + '"' : "") + ">");
      up = up.parentElement;
    }
    var lbl = t.id ? document.querySelector('label[for="' + CSS.escape(t.id) + '"]') : null;
    toggles.push({
      html: t.outerHTML.slice(0, 220),
      id: t.id || "", name: t.getAttribute("name") || "", checked: t.checked === true,
      labelFor: lbl ? lbl.outerHTML.slice(0, 200) : "(no label[for])",
      ancestors: chain,
      siblings: Array.prototype.map.call(t.parentElement ? t.parentElement.children : [], function (c) {
        return "<" + c.tagName.toLowerCase() + (c.className && typeof c.className === "string" ? "." + c.className.split(" ")[0] : "") + ">";
      }).join(" "),
    });
  }
  return {
    toggles: toggles,
    title: document.title, forms: document.querySelectorAll("form").length,
    iframes: Array.prototype.map.call(document.querySelectorAll("iframe"), function (f) { return f.src; }).slice(0, 8),
    fileInputs: document.querySelectorAll('input[type=file]').length,
    fields: fields, buttons: buttons,
    bodyStart: (document.body.innerText || "").replace(/\\s+/g, " ").trim().slice(0, ${Number(process.env.BODY_CHARS ?? 400)}),
  };
})()`;

const browser = await chromium.launch({
  headless: !headed,
  ignoreDefaultArgs: ["--enable-automation"],
  args: ["--disable-blink-features=AutomationControlled"],
});
try {
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    viewport: { width: 1400, height: 1000 },
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  // Oracle HCM's CandidateExperience is a heavy SPA: at domcontentloaded the body is still empty.
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 3500));

  // Dismiss cookie consent BEFORE anything else. A OneTrust/Workable banner is a fixed overlay:
  // the Apply button is visible and enabled, the click lands on the banner, and the page simply
  // does not change — which reads exactly like "Apply did nothing".
  for (const name of [/^accept all$/i, /^accept$/i, /allow all/i, /^got it$/i, /^i agree$/i]) {
    const b = page.getByRole("button", { name }).first();
    if (await b.isVisible().catch(() => false)) {
      console.log(`>>> dismissing cookie banner via "${name}"`);
      await b.click().catch(() => undefined);
      await page.waitForTimeout(1200);
      break;
    }
  }

  const show = async (stage: string) => {
    console.log(`\n${"=".repeat(78)}\n${stage}\n  url: ${page.url()}\n${"=".repeat(78)}`);
    for (const frame of [page, ...page.frames().filter((f) => f !== page.mainFrame())]) {
      const isMain = frame === page;
      let d = (await (isMain ? page : frame).evaluate(DUMP).catch((e) => ({ error: String(e) }))) as any;
      // Oracle redirects on first load, which destroys the execution context mid-evaluate. Settle
      // and read again rather than reporting an empty page.
      if (d.error && /context was destroyed|navigation/i.test(String(d.error))) {
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
        await page.waitForTimeout(4000);
        console.log(`   (re-read after a navigation — now at ${page.url()})`);
        d = (await (isMain ? page : frame).evaluate(DUMP).catch((e) => ({ error: String(e) }))) as any;
      }
      if (d.error) {
        // Say so. Swallowing this is how "Oracle has no fields" was reported when the truth was
        // that the SPA had not rendered yet and the dump threw.
        if (isMain) console.log(`\n-- MAIN PAGE: dump FAILED — ${d.error}`);
        continue;
      }
      const visible = (d.fields ?? []).filter((f: any) => f.visible);
      if (!isMain && visible.length === 0 && (d.buttons ?? []).length === 0) continue;
      console.log(`\n-- ${isMain ? "MAIN PAGE" : `FRAME ${(frame as any).url()}`}`);
      console.log(`   title="${d.title}" forms=${d.forms} fileInputs=${d.fileInputs} iframes=${JSON.stringify(d.iframes)}`);
      console.log(`   body: ${d.bodyStart}`);
      console.log(`   fields (${visible.length} visible of ${(d.fields ?? []).length}):`);
      for (const f of visible) {
        // NARROW on purpose. Size and clipping are NOT trap evidence: that is exactly how a
        // custom-styled checkbox hides its real input, and Oracle's REQUIRED "I agree with the
        // terms and conditions" box is 0x0 and clipped. Skipping that would leave a required
        // field permanently unfilled and stall the run — worse than the trap it was avoiding.
        // aria-hidden means "not for humans", and a trap name says it outright.
        const trap = [f.trapName && "NAME", f.ariaHidden === "true" && "ARIA-HIDDEN"].filter(Boolean);
        const styled = !trap.length && (f.offscreen || f.clipped) ? `  (custom-styled control, ${f.box})` : "";
        console.log(
          `     ${f.required ? "*" : " "} [${f.tag}/${f.type}]${f.name ? ` name=${f.name}` : ""}${f.id ? ` id=${f.id}` : ""}${f.testid ? ` testid=${f.testid}` : ""}  «${f.label}»` +
            (trap.length ? `\n         \u26A0 BOT TRAP — ${trap.join(", ")}; read() would treat this as fillable` : styled),
        );
      }
      if ((d.toggles ?? []).length) {
        console.log(`   toggles (what a .check() has to move):`);
        for (const t of d.toggles) {
          console.log(`     id=${t.id || "-"} name=${t.name || "-"} checked=${t.checked}`);
          console.log(`       input:     ${t.html}`);
          console.log(`       label[for]: ${t.labelFor}`);
          console.log(`       ancestors: ${t.ancestors.join(" < ")}`);
          console.log(`       siblings:  ${t.siblings}`);
        }
      }
      console.log(`   buttons:`);
      for (const b of d.buttons ?? []) {
        const tags = [APPLY.test(b.text) && "APPLY", NEXT.test(b.text) && "NEXT", SUBMIT.test(b.text) && "SUBMIT"].filter(Boolean);
        console.log(`       "${b.text}"${b.type ? ` type=${b.type}` : ""}${b.testid ? ` testid=${b.testid}` : ""}${b.aria ? ` aria="${b.aria}"` : ""}${b.section ? `  [section: ${b.section}]` : ""}${tags.length ? `   <-- ${tags.join("/")}` : ""}`);
      }
    }
  };

  await show("AS LANDED");

  if (!skipApply) {
    const apply = page.getByRole("button", { name: APPLY }).or(page.getByRole("link", { name: APPLY })).first();
    if (await apply.isVisible().catch(() => false)) {
      const label = await apply.innerText().catch(() => "?");
      console.log(`\n>>> clicking apply control: "${label.replace(/\s+/g, " ").trim()}"`);
      await apply.click().catch(() => undefined);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForTimeout(4000);
      await show("AFTER CLICKING APPLY");
    } else {
      console.log("\n>>> no APPLY control matched — the form is probably already on the page");
    }
  }
} finally {
  await browser.close();
}

import { chromium } from "playwright";
import { AUTH_DIR } from "../config.js";

const TARGET_URL =
  "https://tmobile.wd1.myworkdayjobs.com/External/job/Bellevue-Washington/Summer-2026-Compensation-Systems-Intelligence-Intern_REQ348996?utm_source=Simplify&ref=Simplify";

async function sample(page: import("playwright").Page, selector: string, limit = 20) {
  const locator = page.locator(selector);
  const count = await locator.count();
  const items: Array<Record<string, string>> = [];
  const sampleCount = Math.min(count, limit);
  for (let index = 0; index < sampleCount; index += 1) {
    const node = locator.nth(index);
    items.push({
      tag: await node.evaluate((element) => element.tagName.toLowerCase()).catch(() => ""),
      type: (await node.getAttribute("type")) || "",
      id: (await node.getAttribute("id")) || "",
      name: (await node.getAttribute("name")) || "",
      role: (await node.getAttribute("role")) || "",
      ariaLabel: (await node.getAttribute("aria-label")) || "",
      placeholder: (await node.getAttribute("placeholder")) || "",
      text: ((await node.textContent()) || "").replace(/\s+/g, " ").trim().slice(0, 160),
    });
  }
  return { selector, count, items };
}

async function main(): Promise<void> {
  const context = await chromium.launchPersistentContext(AUTH_DIR, {
    channel: "chrome",
    headless: false,
    chromiumSandbox: true,
    viewport: { width: 1440, height: 1000 },
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    const applyButton = page.getByRole("button", { name: /apply/i }).first();
    if (await applyButton.count()) {
      await applyButton.click();
      await page.waitForTimeout(7000);
    }
    const applyManually = page.getByRole("button", { name: /apply manually/i }).first();
    if (await applyManually.count()) {
      await applyManually.click();
      await page.waitForTimeout(8000);
    }

    const report = {
      title: await page.title(),
      url: page.url(),
      bodyPreview: (await page.locator("body").innerText()).slice(0, 4000),
      samples: [
        await sample(page, "input"),
        await sample(page, "textarea"),
        await sample(page, "select"),
        await sample(page, "button"),
        await sample(page, "label"),
        await sample(page, '[aria-label]'),
      ],
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

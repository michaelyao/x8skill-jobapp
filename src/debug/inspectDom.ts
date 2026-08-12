import { chromium } from "playwright";
import { AUTH_DIR } from "../config.js";

async function sampleSelectors(page: import("playwright").Page, selector: string, limit = 15) {
  const locator = page.locator(selector);
  const count = await locator.count();
  const items: Array<Record<string, string>> = [];
  const sampleCount = Math.min(count, limit);

  for (let index = 0; index < sampleCount; index += 1) {
    const node = locator.nth(index);
    items.push({
      tag: await node.evaluate((element) => element.tagName.toLowerCase()).catch(() => ""),
      id: (await node.getAttribute("id")) || "",
      className: (await node.getAttribute("class")) || "",
      role: (await node.getAttribute("role")) || "",
      ariaLabel: (await node.getAttribute("aria-label")) || "",
      name: (await node.getAttribute("name")) || "",
      text: ((await node.textContent()) || "").replace(/\s+/g, " ").trim().slice(0, 160),
    });
  }

  return { selector, count, items };
}

async function main(): Promise<void> {
  const targetUrl = process.argv[2];
  if (!targetUrl) {
    throw new Error("Usage: tsx src/debug/inspectDom.ts <url>");
  }

  const context = await chromium.launchPersistentContext(AUTH_DIR, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1440, height: 1000 },
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(8000);

    const html = await page.content();
    const bodyText = await page.locator("body").innerText().catch(() => "");

    const report = {
      title: await page.title(),
      url: page.url(),
      bodyPreview: bodyText.slice(0, 4000),
      samples: [
        await sampleSelectors(page, '[role="grid"]'),
        await sampleSelectors(page, '[role="gridcell"]'),
        await sampleSelectors(page, '[role="row"]'),
        await sampleSelectors(page, '[role="columnheader"]'),
        await sampleSelectors(page, ".grid-container"),
        await sampleSelectors(page, ".waffle-grid-container"),
        await sampleSelectors(page, "input"),
        await sampleSelectors(page, "textarea"),
        await sampleSelectors(page, "select"),
        await sampleSelectors(page, "button"),
        await sampleSelectors(page, "label"),
        await sampleSelectors(page, '[role="heading"]'),
      ],
      htmlPreview: html.slice(0, 12000),
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

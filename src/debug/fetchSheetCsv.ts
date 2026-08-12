import { chromium } from "playwright";
import { AUTH_DIR, TRACKER_SHEET_URL } from "../config.js";

const EXPORT_URL =
  "https://docs.google.com/spreadsheets/d/1Ugo160-wF1YvOtnwNa__7A9Lep9mBR5plEdhJ0oZh-A/export?format=csv&gid=0";

async function main(): Promise<void> {
  const context = await chromium.launchPersistentContext(AUTH_DIR, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1440, height: 1000 },
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(TRACKER_SHEET_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const result = await page.evaluate(async (url) => {
      const response = await fetch(url, { credentials: "include" });
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get("content-type"),
        bodyPreview: text.slice(0, 4000),
      };
    }, EXPORT_URL);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

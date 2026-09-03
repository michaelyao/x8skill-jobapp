import { chromium } from "playwright";
import { AUTH_DIR, TRACKER_SHEET_URL } from "../config.js";

async function main(): Promise<void> {
  const context = await chromium.launchPersistentContext(AUTH_DIR, {
    channel: "chrome",
    headless: false,
    chromiumSandbox: true,
    viewport: { width: 1440, height: 1000 },
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(TRACKER_SHEET_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6000);

    const body = page.locator("body");
    const snapshot = await body.ariaSnapshot().catch(() => "");
    const screenReaderToggle = page.getByText("Turn on screen reader support");
    const toggleCount = await screenReaderToggle.count();

    console.log(
      JSON.stringify(
        {
          title: await page.title(),
          url: page.url(),
          toggleCount,
          ariaSnapshot: snapshot,
        },
        null,
        2,
      ),
    );
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

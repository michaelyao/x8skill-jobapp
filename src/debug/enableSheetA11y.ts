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
    await page.waitForTimeout(4000);

    const toggle = page.getByText("Turn on screen reader support");
    if (await toggle.count()) {
      await toggle.first().click({ force: true });
      await page.waitForTimeout(5000);
    }
    await page.keyboard.press("Meta+Alt+z");
    await page.waitForTimeout(5000);

    const body = page.locator("body");
    const snapshot = await body.ariaSnapshot().catch(() => "");
    console.log(
      JSON.stringify(
        {
          title: await page.title(),
          url: page.url(),
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

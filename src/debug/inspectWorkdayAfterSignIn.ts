import { chromium } from "playwright";
import { AUTH_DIR } from "../config.js";

const TARGET_URL =
  "https://cohesity.wd5.myworkdayjobs.com/Cohesity_Careers/job/Santa-Clara-CA---USA-Office/Software-Engineering-Intern--Summer-2026_R01589-1?utm_source=Simplify&ref=Simplify";
const LOGIN_EMAIL = "nyao2@andrew.cmu.edu";
const LOGIN_PASSWORD = "SpamInThePan2025!";

async function sample(page: import("playwright").Page, selector: string, limit = 25) {
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
      text: ((await node.textContent()) || "").replace(/\s+/g, " ").trim().slice(0, 180),
    });
  }
  return { selector, count, items };
}

async function main(): Promise<void> {
  const context = await chromium.launchPersistentContext(AUTH_DIR, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1440, height: 1000 },
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    const cookieAccept = page.getByRole("button", { name: /accept cookies/i }).first();
    if (await cookieAccept.count()) {
      await cookieAccept.click().catch(() => undefined);
      await page.waitForTimeout(1000);
    }

    const apply = page.getByRole("button", { name: /^apply$/i }).first();
    if (await apply.count()) {
      await apply.click().catch(() => undefined);
      await page.waitForTimeout(2500);
    }

    const autofill = page.getByRole("button", { name: /autofill with resume/i }).first();
    if (await autofill.count()) {
      await autofill.click().catch(() => undefined);
      await page.waitForTimeout(3000);
    }

    const textInputs = page.locator('input[type="email"], input[type="text"]');
    if (await textInputs.count()) {
      await textInputs.first().fill(LOGIN_EMAIL).catch(() => undefined);
    }
    const password = page.locator('input[type="password"]').first();
    if (await password.count()) {
      await password.fill(LOGIN_PASSWORD).catch(() => undefined);
    }

    const signIn = page.getByRole("button", { name: /^sign in$/i }).filter({ has: page.locator('text=Sign In') }).last();
    if (await signIn.count()) {
      await signIn.click().catch(() => undefined);
      await page.waitForTimeout(8000);
    }

    const report = {
      title: await page.title(),
      url: page.url(),
      bodyPreview: (await page.locator("body").innerText()).slice(0, 7000),
      samples: [
        await sample(page, "input"),
        await sample(page, "textarea"),
        await sample(page, "select"),
        await sample(page, "button"),
        await sample(page, "label"),
        await sample(page, '[role="option"]'),
        await sample(page, '[role="listbox"]'),
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

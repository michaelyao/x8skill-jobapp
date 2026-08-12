import { chromium } from "playwright";
import { AUTH_DIR } from "../config.js";

const TARGET_URL =
  "https://cohesity.wd5.myworkdayjobs.com/Cohesity_Careers/job/Santa-Clara-CA---USA-Office/Software-Engineering-Intern--Summer-2026_R01589-1?utm_source=Simplify&ref=Simplify";
const LOGIN_EMAIL = "nyao2@andrew.cmu.edu";
const LOGIN_PASSWORD = "SpamInThePan2025!";

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
    viewport: { width: 1440, height: 1000 },
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    const applyButton = page.getByRole("button", { name: /^apply$/i }).first();
    if (await applyButton.count()) {
      await applyButton.click().catch(() => undefined);
      await page.waitForTimeout(3000);
    }

    const autofill = page.getByRole("button", { name: /autofill with resume/i }).first();
    if (await autofill.count()) {
      await autofill.click().catch(() => undefined);
      await page.waitForTimeout(4000);
    }

    const emailInputs = page.locator('input[type="email"], input[type="text"]');
    if (await emailInputs.count()) {
      await emailInputs.first().fill(LOGIN_EMAIL).catch(() => undefined);
    }

    const passwordInputs = page.locator('input[type="password"]');
    const passwordCount = await passwordInputs.count();
    if (passwordCount >= 1) {
      await passwordInputs.nth(0).fill(LOGIN_PASSWORD).catch(() => undefined);
    }
    if (passwordCount >= 2) {
      await passwordInputs.nth(1).fill(LOGIN_PASSWORD).catch(() => undefined);
    }

    const checkbox = page.locator('input[type="checkbox"]').first();
    if (await checkbox.count()) {
      await checkbox.check().catch(() => undefined);
    }

    const signIn = page.getByRole("button", { name: /^sign in$/i }).last();
    if (await signIn.count()) {
      await signIn.click().catch(() => undefined);
      await page.waitForTimeout(5000);
    } else {
      const create = page.getByRole("button", { name: /^create account$/i }).first();
      if (await create.count()) {
        await create.click().catch(() => undefined);
        await page.waitForTimeout(5000);
      }
    }

    const report = {
      title: await page.title(),
      url: page.url(),
      bodyPreview: (await page.locator("body").innerText()).slice(0, 6000),
      samples: [
        await sample(page, "input"),
        await sample(page, "textarea"),
        await sample(page, "select"),
        await sample(page, "button"),
        await sample(page, "label"),
        await sample(page, '[role="option"]'),
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

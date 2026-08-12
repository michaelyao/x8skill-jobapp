import type { Page } from "playwright";
import { BaseAdapter } from "./base.js";
import { RESUME_PATH } from "../config.js";
import type { FillContext, FillResult } from "../types.js";

export class WorkdayAdapter extends BaseAdapter {
  readonly type = "workday" as const;

  async detect(page: Page): Promise<boolean> {
    return page.url().toLowerCase().includes("workdayjobs");
  }

  async fill(context: FillContext): Promise<FillResult> {
    await context.page.waitForLoadState("domcontentloaded");
    await context.page.waitForTimeout(2000);
    await this.enterApplicationFlow(context);

    const alreadyApplied = await this.checkAlreadyApplied(context.page);
    if (alreadyApplied) {
      return { filled: [], skipped: ["already applied"], unknownQuestions: [], alreadyApplied: true, reachedReview: false };
    }

    const filled: string[] = [];
    const unknownQuestions = [];
    let consecutiveAuthFails = 0;

    for (let step = 0; step < 12; step += 1) {
      const bodyText = await context.page.locator("body").innerText().catch(() => "");
      console.log(
        `[workday] loop=${step} url=${context.page.url()} title=${await context.page.title().catch(() => "")} stepHint=${bodyText
          .slice(0, 200)
          .replace(/\s+/g, " ")}`,
      );

      if (await this.hasFinalSubmit(context.page)) {
        console.log("[workday] final submit detected; stopping for manual review.");
        return {
          filled,
          skipped: [],
          unknownQuestions,
          alreadyApplied: false,
          reachedReview: true,
        };
      }

      const authHandled = await this.handleAccountGate(context);
      if (authHandled) {
        console.log("[workday] handled account/sign-in gate.");
        consecutiveAuthFails = 0;
        continue;
      }
      // If auth gate is detected but we can't handle it, give up after 2 tries.
      const bodyForAuth = (await context.page.locator("body").innerText().catch(() => "")).toLowerCase();
      if (bodyForAuth.includes("sign in") && (bodyForAuth.includes("email") || bodyForAuth.includes("password"))) {
        consecutiveAuthFails += 1;
        if (consecutiveAuthFails >= 2) {
          console.log("[workday] auth gate unresolvable — skipping job");
          return { filled, skipped: ["auth-failed"], unknownQuestions, alreadyApplied: false, reachedReview: false };
        }
      }

      await this.preferResumeAutofill(context.page);
      await this.uploadCommonDocuments(context.page, context.resumePath);
      const result = await this.fillStandardFields(context);
      console.log(`[workday] filled=${result.filled.length} unknown=${result.unknownQuestions.length}`);
      filled.push(...result.filled);
      unknownQuestions.push(...result.unknownQuestions);

      // Fill Workday button-based selects (e.g. "How Did You Hear About Us?")
      // These use <button> elements inside [data-automation-id^="formField-"] containers,
      // invisible to standard input/combobox selectors.
      const selectFilled = await this.fillWorkdayButtonSelects(context);
      filled.push(...selectFilled);

      if (await this.hasFinalSubmit(context.page)) {
        return {
          filled,
          skipped: [],
          unknownQuestions,
          alreadyApplied: false,
          reachedReview: true,
        };
      }

      const advanced = await this.clickContinue(context.page);
      if (!advanced) {
        console.log("[workday] no next/review/continue button clicked; stopping loop.");
        break;
      }
      console.log("[workday] advanced to next page.");
      await context.page.waitForTimeout(2500);
    }

    return {
      filled,
      skipped: [],
      unknownQuestions,
      alreadyApplied: false,
      reachedReview: await this.hasFinalSubmit(context.page),
    };
  }

  private async enterApplicationFlow(context: FillContext): Promise<void> {
    const page = context.page;

    // Step 1: click Apply or Continue Application on the job posting page.
    if (!page.url().includes("/apply/")) {
      const applyButton = page.getByRole("button", { name: /^apply$|^continue application$/i }).first();
      if (await applyButton.count()) {
        const label = await applyButton.innerText().catch(() => "apply");
        console.log(`[workday] clicking '${label.trim()}'`);

        // Listen for a new tab that the button might open.
        const [newPage] = await Promise.all([
          context.browserContext.waitForEvent("page", { timeout: 4000 }).catch(() => null),
          applyButton.click().catch(() => undefined),
        ]);

        if (newPage) {
          console.log(`[workday] Apply opened a new tab — switching to it`);
          await newPage.waitForLoadState("domcontentloaded").catch(() => undefined);
          context.page = newPage;
        } else {
          await page.waitForTimeout(2500);
        }
      }
    }

    // Re-read page in case it was swapped to a new tab above.
    const activePage = context.page;

    // If "Continue Application" jumped us directly INSIDE the multi-step form, we're done.
    // Note: "autofill with resume" intentionally excluded — it's also in the Start dialog.
    const bodyAfterClick = (await activePage.locator("body").innerText().catch(() => "")).toLowerCase();
    if (
      bodyAfterClick.includes("my information") ||
      bodyAfterClick.includes("my experience") ||
      bodyAfterClick.includes("application questions")
    ) {
      console.log("[workday] jumped directly into form — skipping dialog/auth.");
      return;
    }

    // Step 2: "Start Your Application" dialog.
    const startDialog = activePage.locator('[role="dialog"]').filter({ hasText: /start your application/i });
    if (await startDialog.count()) {
      // Prefer "Use My Last Application" — skips auth entirely and pre-fills everything.
      const useLastApp = activePage.getByRole("button", { name: /use my last application/i }).first();
      if (await useLastApp.count()) {
        console.log("[workday] clicking 'Use My Last Application'");
        await useLastApp.click().catch(() => undefined);
        await activePage.waitForTimeout(4000);
        return; // already authenticated and pre-filled; jump straight to the main loop
      }

      // Otherwise click "Autofill with Resume".
      const resumeAutofill = activePage.getByRole("button", { name: /autofill with resume/i }).first();
      if (await resumeAutofill.count()) {
        console.log("[workday] clicking 'Autofill with Resume'");
        await resumeAutofill.click().catch(() => undefined);
        await activePage.waitForTimeout(3000);
      } else {
        const applyManually = activePage.getByRole("button", { name: /apply manually/i }).first();
        if (await applyManually.count()) {
          await applyManually.click().catch(() => undefined);
          await activePage.waitForTimeout(5000);
        }
      }
    }

    // Step 3: after clicking "Autofill with Resume", Workday redirects through auth:
    //   Create Account page → click "Already have an account? Sign In"
    //   Sign In page        → fill email + password → click Sign In
    await this.handlePostAutofillAuth(context);
  }

  private async handlePostAutofillAuth(context: FillContext): Promise<void> {
    const page = context.page;

    // Retry up to a few times in case of slow redirects.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();

      // Create Account page: click the "Sign In" link instead of creating an account.
      if (bodyText.includes("already have an account")) {
        console.log("[workday-auth] on Create Account page — clicking Sign In link");
        const signInLink = page.getByRole("link", { name: /^sign in$/i }).first();
        const signInButton = page.getByRole("button", { name: /^sign in$/i }).first();
        if (await signInLink.count()) {
          await signInLink.click().catch(() => undefined);
        } else if (await signInButton.count()) {
          await signInButton.click().catch(() => undefined);
        }
        await page.waitForTimeout(2000);
        continue;
      }

      // Sign In page: fill credentials.
      if (bodyText.includes("sign in") && (bodyText.includes("email address") || bodyText.includes("password"))) {
        console.log("[workday-auth] on Sign In page — filling credentials");
        await this.fillSignInForm(context);
        await page.waitForTimeout(4000);
        return;
      }

      // Autofill with Resume upload step — auth is done; upload resume and continue.
      if (bodyText.includes("autofill with resume") || bodyText.includes("drop file here") || bodyText.includes("select file")) {
        console.log("[workday-auth] resume upload step — uploading PDF");
        const fileInput = page.locator('input[type="file"]').first();
        if (await fileInput.count()) {
          await fileInput.setInputFiles(context.resumePath ?? RESUME_PATH);
          await page.waitForSelector("text=Successfully Uploaded", { timeout: 15000 }).catch(() => {});
          console.log("[workday-auth] resume uploaded");
          await page.waitForTimeout(1000);
        }
        const continueBtn = page.getByRole("button", { name: /^continue$/i }).first();
        if (await continueBtn.count() && await continueBtn.isVisible().catch(() => false)) {
          await continueBtn.click().catch(() => undefined);
          console.log("[workday-auth] clicked Continue after resume upload");
          await page.waitForTimeout(3000);
        }
        return;
      }

      // Unknown state — wait and retry.
      await page.waitForTimeout(2000);
    }
  }

  private async handleAccountGate(context: FillContext): Promise<boolean> {
    const page = context.page;

    // Accept cookie banner if present.
    const cookieAccept = page.getByRole("button", { name: /accept cookies/i });
    if (await this.clickFirstVisible(page, cookieAccept).catch(() => false)) {
      console.log("[workday-auth] accepted cookies");
      await page.waitForTimeout(500);
    }

    const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();

    // Pattern A: inline tab gate — "Create Account / Sign In" section embedded in page.
    const hasInlineGate = bodyText.includes("create account/sign in");

    // Pattern B: modal sign-in dialog (e.g. Cohesity-style popup over the page).
    const signInModal = page.locator('[role="dialog"]').filter({ hasText: /sign in/i });
    const hasModalGate = (await signInModal.count()) > 0;

    if (!hasInlineGate && !hasModalGate) {
      return false;
    }

    // For the inline gate, click the Sign In tab first.
    if (hasInlineGate) {
      const toggleSignIn = page.getByRole("button", { name: /^sign in$/i });
      const clicked = await this.clickFirstVisible(page, toggleSignIn);
      console.log(`[workday-auth] clicked sign-in tab=${clicked}`);
      await page.waitForTimeout(1000);
    }

    // Attempt sign-in with whatever form is now visible.
    const signedIn = await this.fillSignInForm(context);
    if (signedIn) {
      return true;
    }

    // Sign-in failed — check if it was a credential error (wrong password / no account).
    const postBody = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    const credentialError = /wrong email|wrong password|incorrect.*password|account.*locked|no account/i.test(postBody);

    // Try Create Account — works for both inline (toggle button) and modal (link).
    const createAccountBtn = page.getByRole("button", { name: /^create account$/i });
    const createAccountLink = page.getByRole("link", { name: /create account/i });
    let clickedCreate = await this.clickFirstVisible(page, createAccountBtn).catch(() => false);
    if (!clickedCreate) {
      clickedCreate = await this.clickFirstVisible(page, createAccountLink).catch(() => false);
    }
    if (clickedCreate) {
      console.log(`[workday-auth] sign-in failed (credentialError=${credentialError}) — clicked Create Account`);
      await page.waitForTimeout(2000);
      return this.fillCreateAccountForm(context);
    }

    // Can't create account either — return false so the main loop doesn't keep retrying.
    console.log(`[workday-auth] sign-in failed and no Create Account button found — giving up on auth gate`);
    return false;
  }

  private async fillSignInForm(context: FillContext): Promise<boolean> {
    const page = context.page;
    const email = context.profile.loginEmail ?? context.profile.email ?? "";
    const password = context.profile.loginPassword ?? "";

    // Scope inputs to the sign-in dialog when one is present, otherwise the full page.
    const signInDialog = page.locator('[role="dialog"]').filter({ hasText: /sign in/i });
    const scope = (await signInDialog.count()) ? signInDialog.first() : page.locator("body");

    const emailInput = scope.locator('input[type="email"]').first();
    const textInput  = scope.locator('input[type="text"]').first();
    const passInput  = scope.locator('input[type="password"]').first();

    // Use whichever email-type input is visible.
    const emailTarget = (await emailInput.count() && await emailInput.isVisible().catch(() => false))
      ? emailInput
      : textInput;

    if (await emailTarget.count() && await emailTarget.isVisible().catch(() => false)) {
      await emailTarget.fill(email);
      console.log(`[workday-auth] filled email: ${email}`);
    } else {
      console.log("[workday-auth] WARNING: could not find email input — aborting sign-in");
      return false;
    }

    if (await passInput.count() && await passInput.isVisible().catch(() => false)) {
      await passInput.fill(password);
      console.log("[workday-auth] filled password");
    } else {
      console.log("[workday-auth] WARNING: could not find password input — aborting sign-in");
      return false;
    }

    // Submit — Workday's real clickable Sign In is a div[role="button"] with data-automation-id="click_filter",
    // NOT the <button type="submit" aria-hidden="true"> underneath it.
    const clickFilter = scope.locator('[data-automation-id="click_filter"][aria-label="Sign In"]').first();
    const fallbackBtn = scope.locator("button").filter({ hasText: /^sign in$/i }).first();
    let clicked = false;
    if (await clickFilter.count() && await clickFilter.isVisible().catch(() => false)) {
      await clickFilter.click();
      clicked = true;
    } else if (await fallbackBtn.count() && await fallbackBtn.isVisible().catch(() => false)) {
      await fallbackBtn.click();
      clicked = true;
    }
    console.log(`[workday-auth] clicked sign-in submit=${clicked}`);

    await page.waitForTimeout(6000);
    const postText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    const modalGone = (await page.locator('[role="dialog"]').filter({ hasText: /sign in/i }).count()) === 0;
    const inlineGone = !postText.includes("create account/sign in");
    const success = modalGone && inlineGone;
    console.log(`[workday-auth] post-sign-in success=${success} hints=${this.extractAuthHints(postText).join(" | ") || "none"}`);
    return success;
  }

  private async fillCreateAccountForm(context: FillContext): Promise<boolean> {
    const page = context.page;
    const email = context.profile.loginEmail ?? context.profile.email ?? "";
    const password = context.profile.loginPassword ?? "";

    const textInputs = await this.visibleInputs(page, ['input[type="email"]', 'input[type="text"]']);
    const passwordInputs = await this.visibleInputs(page, ['input[type="password"]']);
    console.log(`[workday-auth] create-account form: text=${textInputs.length} password=${passwordInputs.length}`);

    if (textInputs.length > 0) {
      await textInputs[0].fill(email).catch(() => undefined);
    }
    if (passwordInputs.length >= 1) {
      await passwordInputs[0].fill(password).catch(() => undefined);
    }
    if (passwordInputs.length >= 2) {
      await passwordInputs[1].fill(password).catch(() => undefined);
    }

    const agreeCheckbox = page.locator('input[type="checkbox"]').first();
    if (await agreeCheckbox.count()) {
      await agreeCheckbox.check().catch(() => undefined);
    }

    const createSubmit = page.locator('button[type="submit"]').filter({ hasText: /create account/i });
    const clicked = await this.clickFirstVisible(page, createSubmit);
    console.log(`[workday-auth] clicked create-account submit=${clicked}`);
    await page.waitForTimeout(6000);

    const postText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    const stillOnGate = postText.includes("create account/sign in");
    console.log(`[workday-auth] post-create stillOnGate=${stillOnGate} hints=${this.extractAuthHints(postText).join(" | ") || "none"}`);
    return !stillOnGate;
  }

  // Collect standard fields + Workday custom comboboxes.
  // For inputs that live INSIDE a [role="combobox"], replace them with the combobox element
  // so that applyAnswer can open the dropdown correctly.
  protected async collectQuestionCandidates(page: import("playwright").Page) {
    const allBase = await super.collectQuestionCandidates(page);

    // Filter out date spinbuttons (Month/Year in work experience / education sections).
    // These are pre-filled from the resume upload and should not be touched.
    const base: import("../types.js").QuestionCandidate[] = [];
    for (const c of allBase) {
      const role = await c.control.getAttribute("role").catch(() => "");
      if (role === "spinbutton") continue;
      base.push(c);
    }

    const comboboxes = page.locator('[role="combobox"]');
    const count = await comboboxes.count();

    // Build a set of labels that have a visible combobox — these override base inputs.
    const comboboxCandidates: import("../types.js").QuestionCandidate[] = [];
    for (let i = 0; i < count; i += 1) {
      const cb = comboboxes.nth(i);
      if (!(await cb.isVisible().catch(() => false))) continue;
      const label = await this.findLabelForControl(page, cb);
      if (!label) continue;
      comboboxCandidates.push({
        label,
        type: "single_select",
        required: false,
        options: [],
        control: cb,
      });
    }

    const comboboxLabels = new Set(comboboxCandidates.map((c) => c.label));
    // Drop base candidates whose label has a combobox (the combobox version supersedes them).
    const filteredBase = base.filter((c) => !comboboxLabels.has(c.label));

    const all = [...filteredBase, ...comboboxCandidates];
    console.log(`[workday-candidates] ${all.length} total`);
    return all;
  }

  // Override applyAnswer — route combobox controls to the dropdown handler.
  protected async applyAnswer(candidate: import("../types.js").QuestionCandidate, rawAnswer: string): Promise<boolean> {
    const role = await candidate.control.getAttribute("role").catch(() => "");

    // Workday "selectinput" — text input that opens a dropdown listbox when clicked (e.g. Disney "How Did You Hear").
    const uxiType = await candidate.control.getAttribute("data-uxi-widget-type").catch(() => "");
    if (uxiType === "selectinput") {
      return this.applyWorkdayCombobox(candidate.control, candidate.label, rawAnswer);
    }

    // Also walk up the ancestor chain in case the control is an input nested inside a combobox.
    const hasComboboxAncestor = role !== "combobox" && await candidate.control.evaluate((n) => {
      let el: Element | null = n.parentElement;
      while (el) {
        if (el.getAttribute("role") === "combobox") return true;
        el = el.parentElement;
      }
      return false;
    }).catch(() => false);

    if (role === "combobox" || hasComboboxAncestor) {
      // Use the outer [role="combobox"] container for clicking, not an inner input.
      const outerCombobox = role === "combobox"
        ? candidate.control
        : candidate.control.page().locator(`[role="combobox"]:has(input)`).filter({ hasText: "" }).first();
      // Fall back to the candidate itself if xpath ancestor lookup fails.
      const clickTarget = (await outerCombobox.count().catch(() => 0)) > 0 ? outerCombobox : candidate.control;
      return this.applyWorkdayCombobox(clickTarget, candidate.label, rawAnswer);
    }

    return super.applyAnswer(candidate, rawAnswer);
  }

  // Fill a Workday custom combobox by opening it and picking the best matching option.
  // For "How Did You Hear About Us?" — falls back to Gemini if regex patterns don't match.
  private async applyWorkdayCombobox(control: import("playwright").Locator, label: string, value: string): Promise<boolean> {
    const page = control.page();

    await control.click().catch(() => undefined);
    await page.waitForTimeout(2000);

    // There may be multiple [role="listbox"] open (e.g. phone-code dropdown stays "open" in the DOM).
    // Pick the one with the most [role="option"] children — that's the freshly-opened dropdown.
    const allListboxes = page.locator('[role="listbox"]');
    const lbCount = await allListboxes.count();
    if (lbCount === 0) {
      // Some Workday selects render as <select>, fall back to base
      return false;
    }

    let listbox = allListboxes.first();
    let maxOptions = 0;
    for (let lb = 0; lb < lbCount; lb += 1) {
      const candidate = allListboxes.nth(lb);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const optCount = await candidate.locator('[role="option"]').count();
      if (optCount > maxOptions) {
        maxOptions = optCount;
        listbox = candidate;
      }
    }

    const options = listbox.locator('[role="option"]');
    const total = await options.count();
    if (total === 0) return false;

    const optionTexts: string[] = [];
    for (let i = 0; i < total; i += 1) {
      optionTexts.push((await options.nth(i).innerText().catch(() => "")).trim());
    }

    // 1. Try regex priority patterns first (fast, no API call).
    const preferences = this.getOptionPreferences(label, value);
    for (const pattern of preferences) {
      const idx = optionTexts.findIndex((t) => pattern.test(t));
      if (idx >= 0) {
        await options.nth(idx).click();
        console.log(`[workday-combobox] regex selected "${optionTexts[idx]}" for "${label}"`);
        return true;
      }
    }

    // 2. For sourcing questions, use Gemini to pick the best option.
    if (/how did you hear|referral source|how did you find/i.test(label)) {
      const chosen = await this.askGeminiForBestOption(label, optionTexts, [
        "college or university career fair / campus recruiting",
        "company careers website",
        "LinkedIn",
        "job board like Indeed or Glassdoor",
      ]);
      if (chosen !== null) {
        await options.nth(chosen).click();
        console.log(`[workday-combobox] gemini selected "${optionTexts[chosen]}" for "${label}"`);
        return true;
      }
    }

    // 3. If value matches an option directly, pick it.
    if (value) {
      const idx = optionTexts.findIndex((t) => t.toLowerCase().includes(value.toLowerCase()));
      if (idx >= 0) {
        await options.nth(idx).click();
        console.log(`[workday-combobox] value-match selected "${optionTexts[idx]}" for "${label}"`);
        return true;
      }
    }

    console.log(`[workday-combobox] no match for "${label}" — ALL options: ${optionTexts.join(" | ")}`);
    // Close the listbox by pressing Escape so it doesn't block the page.
    await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }

  // Call Gemini to pick which option best matches our intent.
  // Returns the index of the best option, or null on failure.
  private async askGeminiForBestOption(question: string, options: string[], intents: string[]): Promise<number | null> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    const prompt = `You are filling out a job application form.
The question is: "${question}"
Available options (one per line, numbered from 0):
${options.map((o, i) => `${i}: ${o}`).join("\n")}

The applicant found this job through a university/college career fair or campus recruiting channel. If none of those options exist, pick the company's own careers website. If that doesn't exist, pick LinkedIn.

Respond with ONLY the integer index (0-based) of the best matching option. No explanation.`;

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        },
      );
      const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } };
      if (json.error) {
        console.log(`[gemini] API error: ${json.error.message}`);
        return null;
      }
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
      const idx = parseInt(text, 10);
      if (!isNaN(idx) && idx >= 0 && idx < options.length) {
        return idx;
      }
      console.log(`[gemini] unexpected response: "${text}" (raw: ${JSON.stringify(json).slice(0, 300)})`);
    } catch (e) {
      console.log("[gemini] error:", e);
    }
    return null;
  }

  // Priority regex patterns — tried before Gemini.
  private getOptionPreferences(label: string, defaultValue: string): RegExp[] {
    if (/how did you hear|referral source|how did you find/i.test(label)) {
      return [
        /college|university|campus|career fair/i,
        /company website|careers website|our website/i,
        /linkedin/i,
        /job board|indeed|glassdoor/i,
      ];
    }
    if (!defaultValue) return [];
    const escaped = defaultValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [new RegExp(`^${escaped}$`, "i"), new RegExp(escaped, "i")];
  }

  // Detect whether a job is on the west coast based on its location string.
  private isWestCoastJob(context: import("../types.js").FillContext): boolean {
    const loc = (context.job.location || "").toLowerCase();
    return /\b(ca|wa|or|nv|az)\b|california|washington|oregon|nevada|arizona|san jose|san francisco|seattle|sunnyvale|los angeles|portland/.test(loc);
  }

  // Return a profile fallback for questions the base class doesn't know about.
  protected getProfileFallback(context: import("../types.js").FillContext, question: import("../types.js").FormQuestion) {
    const q = question.normalizedLabel;
    const westCoast = this.isWestCoastJob(context);

    // Address fields — use west or east coast address based on job location.
    if (q.includes("address line 1") || q === "street address") {
      return { id: "address1", question: question.label, normalizedQuestion: q, answer: westCoast ? "318 Morse Ave" : "4716 Ellsworth Ave Apt 703", answerType: "text" as const, source: "manual+curated" as const, matchers: [q] };
    }
    if (q.includes("address line 2")) {
      return { id: "address2", question: question.label, normalizedQuestion: q, answer: "", answerType: "text" as const, source: "manual+curated" as const, matchers: [q] };
    }
    if (q === "city") {
      return { id: "city", question: question.label, normalizedQuestion: q, answer: westCoast ? "Sunnyvale" : "Pittsburgh", answerType: "text" as const, source: "manual+curated" as const, matchers: [q] };
    }
    if (q === "state" || q.includes("state/province") || q.includes("province")) {
      return { id: "state", question: question.label, normalizedQuestion: q, answer: westCoast ? "California" : "Pennsylvania", answerType: "text" as const, source: "manual+curated" as const, matchers: [q] };
    }
    if (q.includes("postal code") || q.includes("zip code") || q === "zip") {
      return { id: "zip", question: question.label, normalizedQuestion: q, answer: westCoast ? "94085" : "15213", answerType: "text" as const, source: "manual+curated" as const, matchers: [q] };
    }
    if (q === "country") {
      return { id: "country", question: question.label, normalizedQuestion: q, answer: "United States of America", answerType: "text" as const, source: "manual+curated" as const, matchers: [q] };
    }

    // "How Did You Hear About Us?" — handled by priority option matching in applyWorkdayCombobox.
    if (/how did you hear|referral source|how did you find/i.test(question.label)) {
      return {
        id: "how_did_you_hear",
        question: question.label,
        normalizedQuestion: question.normalizedLabel,
        answer: "",
        answerType: "single_select" as const,
        source: "manual+curated" as const,
        matchers: [question.normalizedLabel],
      };
    }
    // Privacy / terms / consent checkboxes — always agree.
    if (/privacy|terms|consent|i have reviewed|i agree|i acknowledge/i.test(question.label) && question.type === "checkbox") {
      return {
        id: "privacy_consent",
        question: question.label,
        normalizedQuestion: question.normalizedLabel,
        answer: "Yes",
        answerType: "checkbox" as const,
        source: "manual+curated" as const,
        matchers: [question.normalizedLabel],
      };
    }
    return super.getProfileFallback(context, question);
  }

  // Skip Workday fields that should stay at their defaults or be left empty.
  protected shouldIgnoreField(label: string, name: string, typeAttr: string): boolean {
    if (super.shouldIgnoreField(label, name, typeAttr)) return true;
    // Any phone country code field — defaults to +1 (US), leave it alone.
    if (/\bphone code\b|\bcountry.*code\b/i.test(label)) return true;
    // Phone extension — leave empty.
    if (/\bphone extension\b|\bext\.?\b/i.test(label)) return true;
    // Work experience / education fields — pre-filled from resume, don't overwrite.
    if (/^(job title|company|location|role description|school or university|field of study|overall result|type to add skills|url)$/i.test(label.trim())) return true;
    return false;
  }

  // Override to use Workday's reliable automation-id before falling back to text scan.
  protected async clickContinue(page: Page): Promise<boolean> {
    // Primary: Workday's "Save and Continue" footer button.
    const nextBtn = page.locator('[data-automation-id="pageFooterNextButton"]').first();
    if (await nextBtn.count() && await nextBtn.isVisible().catch(() => false)) {
      await nextBtn.click();
      await page.waitForTimeout(2500);
      // Workday uses the same URL for all steps — detect validation failure via page content.
      const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
      const validationFailed = bodyText.includes("errors found") || bodyText.includes("required and must have a value");
      if (validationFailed) {
        // Extract the specific error fields for logging.
        const errorLinks = await page.locator('[data-automation-id="formError"] a, [class*="error"] a').allInnerTexts().catch(() => [] as string[]);
        console.log(`[workday] Next clicked — validation blocked: ${errorLinks.filter(Boolean).join(", ") || "(check browser)"}`);
        return false;
      }
      return true;
    }
    // Secondary: text-based scan from base class.
    return super.clickContinue(page);
  }

  // Override to detect Workday's final review/submit page.
  protected async hasFinalSubmit(page: Page): Promise<boolean> {
    // Workday uses "pageFooterSubmitButton" or similar for the final Submit.
    const submitBtn = page.locator('[data-automation-id="pageFooterSubmitButton"]').first();
    if (await submitBtn.count() && await submitBtn.isVisible().catch(() => false)) {
      return true;
    }
    // Also check for generic review text in the page body.
    const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    if (bodyText.includes("review and submit") || bodyText.includes("submit application")) {
      return true;
    }
    return super.hasFinalSubmit(page);
  }

  // Scan formField containers for button-based Workday dropdowns (not [role="combobox"] or <select>).
  // These show a <button> with "Select One" text when unfilled.
  private async fillWorkdayButtonSelects(context: FillContext): Promise<string[]> {
    const page = context.page;
    const filled: string[] = [];

    const { normalizeQuestion } = await import("../utils/normalize.js");
    const { findAnswer } = await import("../knowledge/answerStore.js");

    // Collect all formField containers and their button structure.
    const containerDump = await page.evaluate(() => {
      const results: { id: string; label: string; buttons: { text: string; autoId: string }[] }[] = [];
      for (const c of Array.from(document.querySelectorAll<HTMLElement>('[data-automation-id^="formField-"]'))) {
        const buttons = Array.from(c.querySelectorAll<HTMLElement>("button")).map((b) => ({
          text: (b.textContent ?? "").trim().slice(0, 60),
          autoId: b.getAttribute("data-automation-id") ?? "",
        }));
        results.push({
          id: c.getAttribute("data-automation-id") ?? "",
          label: (c.querySelector("label")?.textContent ?? "").trim(),
          buttons,
        });
      }
      return results;
    });

    for (const info of containerDump) {
      // Only handle containers whose buttons include a "Select One" placeholder (unfilled dropdown).
      const selectBtn = info.buttons.find((b) => /^select one$|^please select$/i.test(b.text.trim()));
      if (!selectBtn) continue;

      const label = info.label.replace(/\s*\*\s*$/, "").trim();
      if (!label) continue;

      console.log(`[workday-button-select] found unfilled dropdown: label="${label}" container="${info.id}"`);

      // Locate the exact button element by its text content (more precise than .first()).
      const container = page.locator(`[data-automation-id="${info.id}"]`);
      const btn = container.locator(`button`).filter({ hasText: /^select one$|^please select$/i }).first();
      if (!(await btn.count())) {
        console.log(`[workday-button-select] could not re-locate button for "${label}"`);
        continue;
      }

      const formQuestion = {
        label,
        normalizedLabel: normalizeQuestion(label),
        type: "single_select" as const,
        required: false,
        options: [],
        locatorDescription: label,
      };
      const answerEntry = findAnswer(context.answers, formQuestion) ?? this.getProfileFallback(context, formQuestion);
      const rawValue = answerEntry ? (Array.isArray(answerEntry.answer) ? answerEntry.answer.join(", ") : String(answerEntry.answer)) : "";

      const ok = await this.applyWorkdayCombobox(btn, label, rawValue);
      if (ok) {
        filled.push(`${label}: (button-select)`);
        console.log(`[workday-button-select] filled "${label}"`);
      } else {
        console.log(`[workday-button-select] could not fill "${label}"`);
      }
    }

    return filled;
  }

  private async visibleInputs(page: Page, selectors: string[]): Promise<import("playwright").Locator[]> {
    const visible: import("playwright").Locator[] = [];
    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count();
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        const isVisible = await candidate.isVisible().catch(() => false);
        if (!isVisible) {
          continue;
        }
        const name = ((await candidate.getAttribute("name")) || "").toLowerCase();
        const surrounding = (await candidate.evaluate((node) => node.closest("form, div")?.textContent || "").catch(() => "")).toLowerCase();
        if (name === "website" || surrounding.includes("do not enter if you're human")) {
          continue;
        }
        visible.push(candidate);
      }
      if (visible.length > 0) {
        return visible;
      }
    }
    return visible;
  }

  private extractAuthHints(text: string): string[] {
    const hints: string[] = [];
    const patterns = [
      /already.*account/,
      /already.*use/,
      /incorrect/,
      /invalid/,
      /required/,
      /password requirements?/,
      /error/,
      /unable to/,
      /try again/,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[0]) {
        hints.push(match[0]);
      }
    }
    return [...new Set(hints)];
  }
}

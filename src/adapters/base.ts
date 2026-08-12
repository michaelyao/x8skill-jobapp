import type { Locator, Page } from "playwright";
import { ANSWERS_JSON_PATH, RESUME_PATH, SUBMIT_TEXT_BLOCKLIST, TRANSCRIPT_PATH } from "../config.js";
import { addLearnedAnswer, findAnswer } from "../knowledge/answerStore.js";
import { normalizeQuestion } from "../utils/normalize.js";
import { waitForUserLearning } from "../utils/prompts.js";
import type { FillContext, FillResult, FormQuestion, QuestionCandidate } from "../types.js";

async function safeIsVisible(locator: Locator): Promise<boolean> {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

async function clickFirstVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await safeIsVisible(candidate)) {
      await candidate.click().catch(() => undefined);
      return true;
    }
  }
  return false;
}

export abstract class BaseAdapter {
  abstract readonly type: "workday" | "ashby" | "greenhouse";
  abstract detect(page: Page): Promise<boolean>;

  /**
   * Click an "Apply" button/link to open the application form, when the posting
   * shows the JD first (common on Ashby/Greenhouse). Best-effort and safe: it
   * never clicks a Submit control (SUBMIT_TEXT_BLOCKLIST) and does nothing if the
   * form is already inline. Returns true if it clicked something.
   */
  protected async clickApplyButton(page: Page): Promise<boolean> {
    const applyText = /^(apply|apply now|apply for this (job|role|position)|apply to this job|i'?m interested)\b/i;
    for (const role of ["button", "link"] as const) {
      const controls = page.getByRole(role, { name: applyText });
      const count = await controls.count();
      for (let index = 0; index < count; index += 1) {
        const control = controls.nth(index);
        if (!(await safeIsVisible(control))) {
          continue;
        }
        const text = ((await control.innerText().catch(() => "")) || "").trim().toLowerCase();
        if (SUBMIT_TEXT_BLOCKLIST.some((blocked) => text.includes(blocked))) {
          continue; // never click submit
        }
        await control.click().catch(() => undefined);
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        await page.waitForTimeout(1500);
        return true;
      }
    }
    return false;
  }

  protected async checkAlreadyApplied(page: Page): Promise<boolean> {
    const bodyText = (await page.locator("body").innerText()).toLowerCase();
    return (
      bodyText.includes("already applied") ||
      bodyText.includes("you have already applied") ||
      bodyText.includes("application submitted")
    );
  }

  protected async uploadCommonDocuments(page: Page, resumePath: string = RESUME_PATH): Promise<void> {
    const fileInputs = page.locator('input[type="file"]');
    const count = await fileInputs.count();
    for (let index = 0; index < count; index += 1) {
      const input = fileInputs.nth(index);
      const descriptor = ((await input.getAttribute("aria-label")) || (await input.getAttribute("name")) || "").toLowerCase();
      if (descriptor.includes("transcript")) {
        await input.setInputFiles(TRANSCRIPT_PATH);
      } else {
        await input.setInputFiles(resumePath);
      }
    }
  }

  protected async preferResumeAutofill(page: Page): Promise<void> {
    const autofillButton = page.getByRole("button", { name: /autofill with resume/i }).first();
    if (await safeIsVisible(autofillButton)) {
      await autofillButton.click().catch(() => undefined);
      await page.waitForTimeout(2000);
    }
  }

  protected async fillStandardFields(context: FillContext): Promise<{ filled: string[]; unknownQuestions: FormQuestion[] }> {
    const candidates = await this.collectQuestionCandidates(context.page);
    const filled: string[] = [];
    const unknownQuestions: FormQuestion[] = [];

    for (const candidate of candidates) {
      const question: FormQuestion = {
        label: candidate.label,
        normalizedLabel: normalizeQuestion(candidate.label),
        type: candidate.type,
        required: candidate.required,
        options: candidate.options,
        locatorDescription: candidate.label,
      };

      if (await this.isLikelySubmitControl(candidate.control, candidate.label)) {
        continue;
      }

      const answer = findAnswer(context.answers, question) ?? this.getProfileFallback(context, question);
      if (!answer) {
        unknownQuestions.push(question);
        await waitForUserLearning({
          company: context.job.company,
          title: context.job.title,
          site: this.type,
          pageUrl: context.page.url(),
          question,
        });
        const learnedValue = await this.readCurrentValue(candidate.control, candidate.type);
        if (learnedValue) {
          context.answers = await addLearnedAnswer(context.answers, question, learnedValue);
          filled.push(`${question.label}: ${learnedValue}`);
        }
        continue;
      }

      const rawAnswer = Array.isArray(answer.answer) ? answer.answer.join(", ") : String(answer.answer);
      const applied = await this.applyAnswer(candidate, rawAnswer);
      if (applied) {
        filled.push(`${question.label}: ${rawAnswer}`);
      } else {
        unknownQuestions.push(question);
      }
    }

    await this.persistAnswersSnapshot(context);
    return { filled, unknownQuestions };
  }

  protected getProfileFallback(context: FillContext, question: FormQuestion) {
    const q = question.normalizedLabel;
    const answer = (value: string) => ({
      id: "profile_fallback",
      question: question.label,
      normalizedQuestion: q,
      answer: value,
      answerType: question.type,
      source: "manual+curated" as const,
      matchers: [q],
    });

    if ((q.includes("first name") || q === "first") && context.profile.firstName) {
      return answer(context.profile.firstName);
    }
    if ((q.includes("last name") || q.includes("surname") || q === "last") && context.profile.lastName) {
      return answer(context.profile.lastName);
    }
    if (q.includes("email") && context.profile.email) {
      return answer(context.profile.email);
    }
    if ((q.includes("user name") || q.includes("username") || q.includes("login email")) && context.profile.loginEmail) {
      return answer(context.profile.loginEmail);
    }
    if (q.includes("password") && context.profile.loginPassword) {
      return answer(context.profile.loginPassword);
    }
    if ((q.includes("phone") || q.includes("mobile")) && context.profile.phone) {
      return answer(context.profile.phone);
    }
    if (q.includes("linkedin") && context.profile.linkedin) {
      return answer(context.profile.linkedin);
    }
    if (q.includes("github") && context.profile.github) {
      return answer(context.profile.github);
    }
    if (q.includes("gpa") && context.profile.gpa) {
      return answer(context.profile.gpa);
    }
    return undefined;
  }

  protected async persistAnswersSnapshot(context: FillContext): Promise<void> {
    await context.page.context().storageState({ path: ANSWERS_JSON_PATH.replace("answers.json", "storage-state.json") });
  }

  protected async collectQuestionCandidates(page: Page): Promise<QuestionCandidate[]> {
    const candidates: QuestionCandidate[] = [];

    const labeledInputs = page.locator("input:not([type='hidden']), textarea, select");
    const count = await labeledInputs.count();
    for (let index = 0; index < count; index += 1) {
      const control = labeledInputs.nth(index);
      if (!(await safeIsVisible(control))) {
        continue;
      }

      const typeAttr = ((await control.getAttribute("type")) || "").toLowerCase();
      const label = await this.findLabelForControl(page, control);
      const options = await this.extractOptions(control);
      const name = (await control.getAttribute("name")) || "";
      const required =
        (await control.getAttribute("required")) !== null ||
        ((await control.getAttribute("aria-required")) || "").toLowerCase() === "true";

      if (this.shouldIgnoreField(label, name, typeAttr)) {
        continue;
      }

      candidates.push({
        label: label || (await control.getAttribute("name")) || (await control.getAttribute("aria-label")) || "Unknown field",
        type: this.mapControlType(typeAttr, await control.evaluate((node) => node.tagName.toLowerCase())),
        required,
        options,
        control,
      });
    }

    return candidates;
  }

  protected async findLabelForControl(page: Page, control: Locator): Promise<string> {
    const id = await control.getAttribute("id");
    if (id) {
      const label = page.locator(`label[for="${id}"]`).first();
      if (await safeIsVisible(label)) {
        const text = (await label.innerText()).trim();
        if (text) {
          return text;
        }
      }
    }

    const ariaLabel = await control.getAttribute("aria-label");
    if (ariaLabel) {
      return ariaLabel.trim();
    }

    const placeholder = await control.getAttribute("placeholder");
    if (placeholder) {
      return placeholder.trim();
    }

    const parentText = await control.evaluate((node) => node.closest("label, div, section, fieldset")?.textContent || "");
    return parentText.trim().slice(0, 160);
  }

  protected mapControlType(typeAttr: string, tagName: string) {
    if (tagName === "textarea") {
      return "textarea" as const;
    }
    if (tagName === "select") {
      return "single_select" as const;
    }
    if (typeAttr === "checkbox") {
      return "checkbox" as const;
    }
    if (typeAttr === "radio") {
      return "radio" as const;
    }
    return "text" as const;
  }

  protected async extractOptions(control: Locator): Promise<string[]> {
    const tagName = await control.evaluate((node) => node.tagName.toLowerCase());
    if (tagName === "select") {
      return control.locator("option").evaluateAll((options) => options.map((option) => option.textContent?.trim() || "").filter(Boolean));
    }
    return [];
  }

  protected shouldIgnoreField(label: string, name: string, typeAttr: string): boolean {
    const text = `${label} ${name}`.toLowerCase();
    if (typeAttr === "hidden") {
      return true;
    }
    if (/\bdo not enter if you(?:'| a)?re human\b/.test(text)) {
      return true;
    }
    if (/\bfor robots only\b/.test(text)) {
      return true;
    }
    if (name.toLowerCase() === "website") {
      return true;
    }
    return false;
  }

  protected async applyAnswer(candidate: QuestionCandidate, rawAnswer: string): Promise<boolean> {
    const tagName = await candidate.control.evaluate((node) => node.tagName.toLowerCase());
    if (tagName === "select") {
      const options = await this.extractOptions(candidate.control);
      const option = options.find((value) => value.toLowerCase() === rawAnswer.toLowerCase());
      if (!option) {
        return false;
      }
      await candidate.control.selectOption({ label: option });
      return true;
    }

    if (candidate.type === "checkbox") {
      const yesLike = /^(yes|true|i agree)$/i.test(rawAnswer.trim());
      if (yesLike) {
        await candidate.control.check();
        return true;
      }
      return false;
    }

    if (candidate.type === "radio") {
      const radioGroup = candidate.control.page().locator(`input[type="radio"][name="${await candidate.control.getAttribute("name")}"]`);
      const count = await radioGroup.count();
      for (let index = 0; index < count; index += 1) {
        const radio = radioGroup.nth(index);
        const label = ((await radio.evaluate((node) => node.closest("label")?.textContent || "")) || "").trim();
        if (label.toLowerCase().includes(rawAnswer.toLowerCase())) {
          await radio.check();
          return true;
        }
      }
      return false;
    }

    // Dismiss any open dropdown/listbox that might intercept the click.
    const page = candidate.control.page();
    const openListbox = page.locator('[role="listbox"]').first();
    if (await openListbox.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(300);
    }

    // Click to focus, clear, then type with a human-like delay
    await candidate.control.click({ force: true });
    await candidate.control.fill("");
    await candidate.control.type(rawAnswer, { delay: 40 });
    return true;
  }

  protected async readCurrentValue(control: Locator, type: string): Promise<string> {
    if (type === "checkbox") {
      return (await control.isChecked()) ? "Yes" : "";
    }
    return await control.inputValue().catch(() => "");
  }

  protected async isLikelySubmitControl(control: Locator, label: string): Promise<boolean> {
    const text = `${label} ${(await control.getAttribute("value")) || ""}`.toLowerCase();
    return SUBMIT_TEXT_BLOCKLIST.some((blocked) => text.includes(blocked));
  }

  protected async clickContinue(page: Page): Promise<boolean> {
    const buttons = page.getByRole("button");
    const count = await buttons.count();
    for (let index = 0; index < count; index += 1) {
      const button = buttons.nth(index);
      const text = ((await button.innerText().catch(() => "")) || "").trim().toLowerCase();
      if (!text) {
        continue;
      }
      if (SUBMIT_TEXT_BLOCKLIST.some((blocked) => text.includes(blocked))) {
        continue;
      }
      if (/(next|continue|review|submit later|save and continue|apply manually|done)/.test(text)) {
        await button.click().catch(() => undefined);
        await page.waitForTimeout(1500);
        return true;
      }
    }
    return false;
  }

  protected async hasFinalSubmit(page: Page): Promise<boolean> {
    const buttons = page.getByRole("button");
    const count = await buttons.count();
    for (let index = 0; index < count; index += 1) {
      const button = buttons.nth(index);
      const text = ((await button.innerText().catch(() => "")) || "").trim().toLowerCase();
      if (!text) {
        continue;
      }
      if (SUBMIT_TEXT_BLOCKLIST.some((blocked) => text.includes(blocked))) {
        if (await safeIsVisible(button)) {
          return true;
        }
      }
    }
    return false;
  }

  protected async clickFirstVisible(page: Page, locator: Locator): Promise<boolean> {
    return clickFirstVisible(locator);
  }
}

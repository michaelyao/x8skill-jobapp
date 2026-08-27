import type { Page } from "playwright";
import { GenericDriver, SUBMIT } from "./base.js";
import type { AgentContext, HistoryOutcome, Root } from "../types.js";
import { parseResumeHistory } from "../../knowledge/resumeHistory.js";

const SUBMIT_BTN = 'button[type="submit"], input[type="submit"]';

/**
 * Workable driver (apply.workable.com). Single page, no login: the posting lives at
 * /{company}/j/{ID}/ and the whole application — personal details, resume upload and any custom
 * questions — is one form at /{company}/j/{ID}/apply/ ending in "Submit application". Like Lever,
 * there is no multi-step Next, so we fill, reach Submit (= review) and only click on approval.
 *
 * Verified live (pony.ai, Aug 2026): firstname, lastname, email, phone, address, city, postcode,
 * country, summary, cover_letter and an input[type=file] marked data-testid="resume".
 *
 * THE COOKIE BANNER IS LOAD-BEARING. Workable renders consent as a fixed overlay, and with it up
 * the "Apply for this job" button is visible and enabled but the click lands on the banner: the
 * URL never changes and the form never appears, which reads exactly like "Apply did nothing".
 * clickApply() in the base dismisses it first, which is why openApplication goes through it
 * rather than navigating straight to /apply/.
 */
export class WorkableDriver extends GenericDriver {
  readonly type = "workable" as const;

  async detect(page: Page): Promise<boolean> {
    return /(^|\.)workable\.com\//i.test(page.url());
  }

  private async hasForm(page: Page): Promise<boolean> {
    return (
      (await page
        .locator('input[name="firstname"], input[name="lastname"], input[name="email"], form')
        .count()
        .catch(() => 0)) > 0
    );
  }

  async openApplication(page: Page): Promise<void> {
    // A withdrawn posting 302s to /{company}/?not_found=true — the company's JOB SEARCH page.
    // applyJob() catches this earlier by page text ("this job is no longer available"), but bail
    // out here too: the fallback below would otherwise build /{company}/apply/ out of the
    // redirected URL and read the search filters (Workplace type, Location, Work type) as if they
    // were application fields.
    const original = page.url();
    if (/[?&]not_found=true/.test(original)) {
      console.log("    [workable] the posting redirected to the company job list — it is no longer available.");
      return;
    }
    if (await this.hasForm(page)) return;

    await this.clickApply(page); // dismisses the consent overlay, then clicks Apply
    await page.waitForTimeout(1500);
    if (await this.hasForm(page)) return;
    if (/[?&]not_found=true/.test(page.url())) {
      console.log("    [workable] Apply led to the company job list — the posting is no longer available.");
      return;
    }

    // Fallback: the canonical apply URL, derived from the URL we ARRIVED with rather than wherever
    // a redirect left us — building it from the current URL is what produced /{company}/apply/.
    const base = original.split("?")[0].replace(/\/(apply\/?)?$/, "");
    if (!/\/j\/[0-9A-F]+/i.test(base)) return; // not a posting URL; nothing safe to construct
    await page.goto(`${base}/apply/`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await page.waitForTimeout(2000);
  }

  /**
   * Expand the collapsed Education and Experience sections.
   *
   * Workable renders these as repeatable sections with NO fields until "+ Add" is clicked, and
   * labels them "(Optional)". So the reader saw eight fields — name, email, phone, address,
   * summary, cover letter — found nothing missing, and the run reported `reached review` with the
   * education and work history of the application completely empty. Optional to Workable; not
   * optional on an internship application. Caught on Pony.ai ZNSIQU.
   *
   * Scoped by aria-label ("Add Education" / "Add Experience"), which the buttons carry — their
   * visible text is just "+ Add" on both, so anything positional would be a coin flip.
   *
   * Idempotent: it probes for the section's fields first, so a re-fill of a form that already has
   * an entry does not stack empty ones. Verified by counting controls before and after, because a
   * click that expanded nothing must not be reported as an expansion.
   */
  private async expandSections(page: Page): Promise<void> {
    /**
     * `already` is the section's OWN field labels, not the word "education". The first version
     * probed for ids/names containing the section name — but the revealed inputs are called
     * School, Degree, Field of study, Company, Industry, so it never matched and the
     * already-expanded guard did nothing: turn 2 clicked "+ Add" a second time. Only the
     * before/after count stopped that becoming a second blank entry, and on a form where "+ Add"
     * genuinely appends one, it would have stacked empties — the very thing this guard is for.
     */
    const sections: Array<[string, RegExp, RegExp]> = [
      ["education", /^add education$/i, /school|degree|field of study|institution/i],
      ["experience", /^add experience$/i, /company|industry|employer/i],
    ];
    for (const [name, label, already] of sections) {
      const existing = await page.getByLabel(already).count().catch(() => 0);
      // Both skip paths LOG. The first version returned silently from either, and when the fix
      // did not fire in production there was no way to tell which branch had swallowed it — the
      // log contained no "[workable]" line at all, which is the least useful possible outcome.
      if (existing > 0) {
        console.log(`    [workable] ${name} already has ${existing} field(s) — not adding another.`);
        continue;
      }

      const button = page.getByRole("button", { name: label }).first();
      if (!(await button.isVisible().catch(() => false))) {
        const anyAdd = await page.getByRole("button", { name: /^\+?\s*add$/i }).count().catch(() => 0);
        console.log(
          `    [workable] no "${String(label)}" control found (${anyAdd} bare "+ Add" button(s) on the page) — ${name} left empty.`,
        );
        continue;
      }

      const before = await page.locator("input:not([type=hidden]), select, textarea").count().catch(() => 0);
      await button.scrollIntoViewIfNeeded().catch(() => undefined);
      await button.click().catch(() => undefined);
      await page.waitForTimeout(900);
      const after = await page.locator("input:not([type=hidden]), select, textarea").count().catch(() => 0);
      if (after > before) console.log(`    [workable] expanded ${name} (+${after - before} field(s))`);
      else console.log(`    [workable] "+ Add" for ${name} revealed no fields — leaving it collapsed.`);
    }
  }

  /**
   * Type a value and prove it landed.
   *
   * The MM/YYYY date fields are react-datepickers, and only ONE of the obvious approaches works.
   * Measured on Pony.ai:
   *   click + pressSequentially + Tab  -> ""
   *   fill()                           -> ""
   *   fill() then Enter                -> ""
   *   click + pressSequentially + blur -> "05/2028"   <-- the only one that commits
   * Escape is worse than useless here: it REVERTS the picker, which is why an End date the run
   * had recorded as 05/2028 was empty on the screenshot. Always verify; never assume.
   */
  private async typeField(page: Page, name: string, value: string): Promise<boolean> {
    if (!value) return true;
    const el = page.locator(`input[name="${name}"], textarea[name="${name}"]`).first();
    if (!(await el.count().catch(() => 0))) return false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await el.click().catch(() => undefined);
      await el.fill("").catch(() => undefined);
      await el.pressSequentially(value, { delay: 25 }).catch(() => undefined);
      await el.blur().catch(() => undefined);
      await page.waitForTimeout(250);
      const got = (await el.inputValue().catch(() => "")).trim();
      if (got === value.trim()) return true;
      // A datepicker can normalise what it accepts (e.g. drop a leading zero); treat a value that
      // is merely reformatted as landed, but an EMPTY field as a genuine failure.
      if (got && attempt === 1) return true;
    }
    const final = (await el.inputValue().catch(() => "")).trim();
    if (!final) console.log(`      ✗ ${name} would not take ${JSON.stringify(value)}`);
    return Boolean(final);
  }

  /** Click the Update that commits the open entry, and prove the entry actually closed. */
  private async commitEntry(page: Page, probeName: string, what: string): Promise<boolean> {
    const update = page.getByRole("button", { name: /^update$/i }).first();
    if (!(await update.isVisible().catch(() => false))) {
      console.log(`      ✗ no Update button for the ${what} entry — it cannot be committed`);
      return false;
    }
    await update.scrollIntoViewIfNeeded().catch(() => undefined);
    await update.click().catch(() => undefined);
    await page.waitForTimeout(1200);
    // A COMMITTED entry collapses: its inputs leave the DOM. That is the only honest signal —
    // Update stays visible and enabled whether or not it worked, and with a required field empty
    // it silently refuses, leaving the panel open and "+ Add" disabled.
    const stillOpen = await page.locator(`input[name="${probeName}"]`).count().catch(() => 0);
    if (stillOpen > 0) {
      console.log(`      ✗ Update did not commit the ${what} entry (its fields are still on the form)`);
      return false;
    }
    return true;
  }

  /** Open a fresh entry panel via the section's "+ Add", which is only enabled once the last one committed. */
  private async openNewEntry(page: Page, label: RegExp, what: string): Promise<boolean> {
    const add = page.getByRole("button", { name: label }).first();
    if (!(await add.isVisible().catch(() => false))) return false;
    if (!(await add.isEnabled().catch(() => false))) {
      console.log(`      ✗ "+ Add" for ${what} is disabled — the previous entry was never committed`);
      return false;
    }
    await add.scrollIntoViewIfNeeded().catch(() => undefined);
    await add.click().catch(() => undefined);
    await page.waitForTimeout(800);
    return true;
  }

  /**
   * Fill EVERY education and work-history entry from the resume, committing each one.
   *
   * The shape of this section is why the generic reader could never do it: one blank entry is
   * shown, its Update button must be clicked to commit it, "+ Add" only becomes enabled after
   * that, and a committed entry's fields disappear from the DOM. Reading the form once and filling
   * what you see gets you a single uncommitted entry — which is exactly what shipped.
   */
  async fillHistorySections(root: Root, ctx: AgentContext): Promise<HistoryOutcome> {
    const page = root as Page;
    const history = parseResumeHistory(ctx.resumeText || ctx.profile?.rawText || "");
    const out: HistoryOutcome = {
      educationExpected: history.education.length,
      educationCommitted: 0,
      experienceExpected: history.experience.length,
      experienceCommitted: 0,
      problems: [],
      derived: history.education.flatMap((e) => e.derived ?? []),
    };

    for (const [index, edu] of history.education.entries()) {
      const panelOpen = async () => (await page.locator('input[name="school"]').count().catch(() => 0)) > 0;
      if (!(await panelOpen()) && !(await this.openNewEntry(page, /^add education$/i, "education"))) {
        out.problems.push(`could not open an entry for education ${index + 1} (${edu.school})`);
        break;
      }
      if (!(await panelOpen())) {
        out.problems.push(`no education entry panel open for ${edu.school}`);
        break;
      }
      await this.typeField(page, "school", edu.school);
      await this.typeField(page, "field_of_study", edu.fieldOfStudy);
      await this.typeField(page, "degree", edu.degree);
      // Optional to Workable, expected by a human reader — fill them.
      if (edu.startDate) await this.typeField(page, "start_date", edu.startDate);
      if (edu.endDate) await this.typeField(page, "end_date", edu.endDate);
      if (await this.commitEntry(page, "school", `education (${edu.school})`)) {
        out.educationCommitted += 1;
        console.log(`      ✓ education: ${edu.school} — ${edu.degree}, ${edu.fieldOfStudy} (${edu.startDate ?? "?"}–${edu.endDate ?? "?"})`);
      } else {
        out.problems.push(`education entry for ${edu.school} would not commit`);
        break;
      }
    }

    for (const [index, job] of history.experience.entries()) {
      // expandSections already left the FIRST panel open, so "+ Add" is legitimately disabled at
      // that point — asking for a new entry there reported a failure that was not one. Only reach
      // for "+ Add" when no panel is open.
      const panelOpen = async () => (await page.locator('input[name="title"]').count().catch(() => 0)) > 0;
      if (!(await panelOpen()) && !(await this.openNewEntry(page, /^add experience$/i, "experience"))) {
        out.problems.push(`could not open an entry for ${job.company} (${index + 1} of ${history.experience.length})`);
        break;
      }
      if (!(await panelOpen())) {
        out.problems.push(`no experience entry panel open for ${job.company}`);
        break;
      }
      await this.typeField(page, "title", job.title);
      await this.typeField(page, "company", job.company);
      // The per-role Summary wants THIS role's bullet points. It was being given a general
      // candidate blurb, because two different fields on this form are both named "summary" and
      // both labelled "Summary (Optional)" — one inside the entry, one on the profile.
      await this.typeField(page, "summary", job.summary);
      if (job.startDate) await this.typeField(page, "start_date", job.startDate);
      if (job.current) {
        const box = page.locator('input[name="current"]').first();
        if (!(await box.isChecked().catch(() => false))) await box.click({ force: true }).catch(() => undefined);
      } else if (job.endDate) {
        await this.typeField(page, "end_date", job.endDate);
      }
      if (await this.commitEntry(page, "title", `experience (${job.company})`)) {
        out.experienceCommitted += 1;
        console.log(`      ✓ experience: ${job.company} — ${job.title} (${job.startDate ?? "?"}–${job.current ? "present" : job.endDate ?? "?"})`);
      } else {
        out.problems.push(`experience entry for ${job.company} would not commit`);
        break;
      }
    }

    console.log(
      `    [workable] history: ${out.educationCommitted}/${out.educationExpected} education, ` +
        `${out.experienceCommitted}/${out.experienceExpected} experience committed`,
    );
    return out;
  }

  async resolveRoot(page: Page): Promise<Root> {
    // Expanding here rather than in openApplication: turnLoop re-reads every turn, and a section
    // that collapses (or a form re-rendered after an upload) has to be re-expanded before the read
    // that decides whether anything is still missing.
    await this.expandSections(page).catch(() => undefined);
    return page;
  }

  protected async hasNext(): Promise<boolean> {
    return false; // single-page form
  }

  async next(): Promise<boolean> {
    return false; // Submit is the only control
  }

  protected async hasSubmit(root: Root): Promise<boolean> {
    if ((await root.locator(SUBMIT_BTN).count().catch(() => 0)) > 0) return true;
    return (await root.getByRole("button", { name: SUBMIT }).count().catch(() => 0)) > 0;
  }

  /** Click the final Submit — only ever invoked after explicit approval. */
  async submit(root: Root): Promise<boolean> {
    const byRole = root.getByRole("button", { name: SUBMIT }).first();
    if (await byRole.count().catch(() => 0)) {
      await byRole.scrollIntoViewIfNeeded().catch(() => undefined);
      await byRole.click().catch(() => undefined);
      return true;
    }
    const btn = root.locator(SUBMIT_BTN).first();
    if (await btn.count().catch(() => 0)) {
      await btn.scrollIntoViewIfNeeded().catch(() => undefined);
      await btn.click().catch(() => undefined);
      return true;
    }
    return false;
  }
}

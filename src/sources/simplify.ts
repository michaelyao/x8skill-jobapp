import type { Page } from "playwright";
import { SIMPLIFY_RAW_URL } from "../config.js";
import { normalizeWhitespace } from "../utils/normalize.js";
import type { JobListing } from "../types.js";

function stripHtml(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?(details|summary|strong|div|img|a|td|tr|tbody|thead|table)[^>]*>/gi, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&"),
  );
}

function extractLinks(cell: string): string[] {
  return [...cell.matchAll(/href="([^"]+)"/gi)].map((match) => match[1]);
}

function extractRows(section: string): string[] {
  return [...section.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
}

function extractCells(row: string): string[] {
  return [...row.matchAll(/<td>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
}

export async function loadSimplifyJobs(page: Page): Promise<JobListing[]> {
  await page.goto(SIMPLIFY_RAW_URL, { waitUntil: "domcontentloaded" });
  const bodyText = await page.locator("body").innerText();

  const SECTION_HEADER = "## 💻 Software Engineering Internship Roles";
  const sectionStart = bodyText.indexOf(SECTION_HEADER);
  if (sectionStart < 0) {
    throw new Error("Could not find '## 💻 Software Engineering Internship Roles' in raw README.");
  }
  const nextHeading = bodyText.indexOf("\n## ", sectionStart + SECTION_HEADER.length);
  const section = nextHeading >= 0
    ? bodyText.slice(sectionStart, nextHeading)
    : bodyText.slice(sectionStart);
  const rows = extractRows(section);
  if (rows.length === 0) {
    throw new Error("Could not parse internship table rows from raw README.");
  }

  const jobs: JobListing[] = [];
  let currentCompany = "";

  for (const row of rows) {
    const cells = extractCells(row);
    if (cells.length < 5) {
      continue;
    }

    const companyText = stripHtml(cells[0]);
    if (companyText && companyText !== "↳") {
      currentCompany = companyText;
    }

    const links = extractLinks(cells[3]);
    const applyUrl = links.find((link) => !link.includes("simplify.jobs/p/")) ?? links[0] ?? "";
    const simplifyUrl = links.find((link) => link.includes("simplify.jobs/p/"));

    jobs.push({
      company: currentCompany,
      title: stripHtml(cells[1]),
      location: stripHtml(cells[2]),
      applyUrl,
      simplifyUrl,
      age: stripHtml(cells[4]),
      sourceText: stripHtml(row),
    });
  }

  return jobs.filter((job) => job.company && job.title && job.applyUrl);
}

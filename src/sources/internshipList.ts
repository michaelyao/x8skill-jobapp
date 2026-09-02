import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { BUILD_INTERNSHIPS_SCRIPT, INTERNSHIPS_CSV_PATH, ROOT_DIR } from "../config.js";
import type { FilteredJob } from "../types.js";
import { normalizeUrl } from "../utils/normalize.js";
import { companyFromUrl, listRequests } from "../knowledge/requestedJobs.js";

/**
 * Regenerate internships_summer2027.csv from every URL in job_sites.txt by
 * running tools/build_internships.mjs. Best-effort: if the build fails (network,
 * Playwright), we log and fall back to the existing CSV. Set SKIP_REFRESH=1 to
 * skip and use the CSV as-is.
 */
export async function refreshInternshipCsv(): Promise<void> {
  if (process.env.SKIP_REFRESH === "1") {
    console.log("SKIP_REFRESH=1 — using existing internships_summer2027.csv without rebuilding.");
    return;
  }
  console.log("Rebuilding internship list from job_sites.txt ...");
  await new Promise<void>((resolve) => {
    const child = spawn("node", [BUILD_INTERNSHIPS_SCRIPT], { cwd: ROOT_DIR, stdio: "inherit" });
    child.on("error", (error) => {
      console.warn(`Could not run the list builder (${error.message}); using existing CSV if present.`);
      resolve();
    });
    child.on("close", (code) => {
      if (code !== 0) {
        console.warn(`List builder exited with code ${code}; using existing CSV if present.`);
      }
      resolve();
    });
  });
}

/** Parse CSV text into rows of cells (handles quotes, escaped quotes, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((value) => value.trim().length > 0));
}

/**
 * Load the consolidated internship list (already filtered to undergrad US
 * software/AI roles and ordered by region) as FilteredJob[]. The CSV is the
 * curated candidate set, so no further age/location filtering is applied here.
 */
export async function loadInternshipList(): Promise<FilteredJob[]> {
  let raw: string;
  try {
    raw = await fs.readFile(INTERNSHIPS_CSV_PATH, "utf8");
  } catch {
    throw new Error(
      `internships_summer2027.csv not found. Add sources to job_sites.txt and run: node tools/build_internships.mjs`,
    );
  }

  const rows = parseCsv(raw);
  if (rows.length <= 1) return [];

  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const idIdx = col("id");
  const regionIdx = col("region");
  const companyIdx = col("company");
  const titleIdx = col("job title");
  const locationIdx = col("location");
  const postedIdx = col("posted");
  const linkIdx = col("apply link");
  const sourceIdx = col("source");

  const jobs: FilteredJob[] = [];
  for (const values of rows.slice(1)) {
    const applyUrl = (values[linkIdx] ?? "").trim();
    if (!applyUrl) continue; // can't apply without a link
    jobs.push({
      id: (values[idIdx] ?? "").trim(),
      region: (values[regionIdx] ?? "").trim(),
      company: (values[companyIdx] ?? "").trim(),
      title: (values[titleIdx] ?? "").trim(),
      location: (values[locationIdx] ?? "").trim(),
      age: (values[postedIdx] ?? "").trim(),
      applyUrl,
      source: (values[sourceIdx] ?? "").trim(),
      sourceText: `${(values[idIdx] ?? "").trim()} ${(values[regionIdx] ?? "").trim()}`.trim(),
      usEligible: true,
      needsManualLocationReview: false,
    });
  }
  /**
   * AND THE URLS THE CANDIDATE HANDED OVER, as one more source.
   *
   * His framing, and the right one: a job he found himself is not a different KIND of job, just a
   * different place it came from. So it joins the list here rather than getting its own path, and
   * everything downstream — the sweep, the apply, every guard — treats it identically.
   *
   * Appended AFTER the tracker rows and skipped when the URL is already listed, so a posting the
   * trackers already carry keeps its original code. Two codes for one posting is how MERPVQ and
   * NNSRWS became the same Verkada job twice.
   */
  const listedUrls = new Set(jobs.map((j) => normalizeUrl(j.applyUrl)));
  for (const request of await listRequests().catch(() => [])) {
    if (listedUrls.has(normalizeUrl(request.url))) continue;
    listedUrls.add(normalizeUrl(request.url));
    jobs.push({
      id: request.code,
      region: "",
      company: request.company?.trim() || companyFromUrl(request.url) || "Unknown",
      // Unknown until the page is open. It must not read like a real title, because the discovery
      // filters judge titles and this one carries no information.
      title: request.title?.trim() || "(supplied by URL)",
      location: "",
      // Today, so the age filter keeps it: he asked for this one, and its posting date is not
      // something he was sifting by.
      age: "0d",
      applyUrl: request.url,
      source: "you",
      sourceText: request.note ?? "",
      usEligible: true,
      needsManualLocationReview: false,
    });
  }

  return jobs;
}

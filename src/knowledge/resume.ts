import fs from "node:fs/promises";
import path from "node:path";
import { RESUME_PATH, RESUMES_DIR } from "../config.js";
import type { JobListing } from "../types.js";

export interface ResumeChoice {
  path: string; // file to upload to the ATS
  name: string; // display name (basename)
  isStandard: boolean; // true → default resume; false → tailored for this job
  contentText?: string; // inlined text for a non-standard resume (when available)
}

const TEXT_EXTS = new Set([".md", ".markdown", ".txt"]);
const RESUME_EXTS = [".pdf", ".md", ".markdown", ".txt", ".docx"];

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Read the text of a non-standard resume: text files directly, or a same-named
 * .md/.txt sibling of a binary (pdf/docx). Returns undefined if only a binary
 * exists with no text version (we can't inline a PDF's bytes as readable text). */
async function readResumeText(filePath: string): Promise<string | undefined> {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTS.has(ext)) {
    return (await fs.readFile(filePath, "utf8")).trim();
  }
  for (const sibling of [".md", ".txt", ".markdown"]) {
    const alt = filePath.slice(0, -ext.length) + sibling;
    if (await exists(alt)) {
      return (await fs.readFile(alt, "utf8")).trim();
    }
  }
  return undefined;
}

/**
 * Decide which resume to use for a job. Priority:
 *   1. RESUME_OVERRIDE env var (explicit path)
 *   2. data/resumes/<ID>.<ext>
 *   3. data/resumes/<company-title-slug>.<ext>
 *   4. the standard resume (RESUME_PATH)
 * Only 1–3 count as "non-standard" and get their text saved to x8note.
 */
export async function resolveResumeForJob(job: JobListing): Promise<ResumeChoice> {
  const candidates: string[] = [];
  if (process.env.RESUME_OVERRIDE) candidates.push(process.env.RESUME_OVERRIDE);
  if (job.id) candidates.push(...RESUME_EXTS.map((ext) => path.join(RESUMES_DIR, `${job.id}${ext}`)));
  const bySlug = slug(`${job.company}-${job.title}`).slice(0, 80);
  candidates.push(...RESUME_EXTS.map((ext) => path.join(RESUMES_DIR, `${bySlug}${ext}`)));

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return {
        path: candidate,
        name: path.basename(candidate),
        isStandard: false,
        contentText: await readResumeText(candidate),
      };
    }
  }

  return { path: RESUME_PATH, name: path.basename(RESUME_PATH), isStandard: true };
}

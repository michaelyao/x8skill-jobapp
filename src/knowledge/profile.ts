import fs from "node:fs/promises";
import path from "node:path";
import { PROFILE_JSON_PATH, RESUME_MD_PATH, RESUME_PATH, RESUME_TXT_PATH } from "../config.js";
import { writeJson } from "../utils/log.js";
import type { ProfileData } from "../types.js";

/** Read the first file that exists from a list of candidate paths. */
async function readFirstAvailable(paths: string[]): Promise<{ text: string; path: string }> {
  for (const candidate of paths) {
    try {
      return { text: await fs.readFile(candidate, "utf8"), path: candidate };
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`No profile/resume text file found. Checked: ${paths.join(", ")}`);
}

// Ignore template placeholders like "[Email]" / "[Phone]" that appear in the resume.
const realValue = (value: string | undefined): string | undefined =>
  value && !/[\[\]]/.test(value) ? value : undefined;

/**
 * Institution name only, from a markdown resume line:
 * "**Carnegie Mellon University** — Pittsburgh, PA" → "Carnegie Mellon University".
 * School form fields are typeaheads that filter on the name, so a trailing location
 * clause (or a stray asterisk) means nothing in the dropdown matches.
 */
function cleanInstitution(line: string): string {
  return line
    .replace(/[*_`]/g, "")
    .replace(/^#+\s*/, "")
    .replace(/^[-•]\s*/, "")
    .trim()
    .split(/\s+[—–|]\s+|\s+-\s+/)[0] // drop a trailing location / date clause
    .replace(/,\s*[^,]+,\s*[A-Z]{2}\b.*$/, "") // "…, Pittsburgh, PA"
    .trim();
}

/**
 * Read the last snapshot WITHOUT re-parsing or writing anything.
 *
 * loadProfile() writes profile.json as a side effect, which a website page render must not do:
 * the worker is the single writer of state here, and a render that writes could race it. This is
 * the read-only door for display code. The snapshot is refreshed by the worker on every job, and
 * the authoritative check at submit time still calls loadProfile().
 */
export async function readProfileSnapshot(): Promise<ProfileData | null> {
  try {
    return JSON.parse(await fs.readFile(PROFILE_JSON_PATH, "utf8")) as ProfileData;
  } catch {
    return null;
  }
}

export async function loadProfile(): Promise<ProfileData> {
  // Prefer the markdown resume (easiest to parse), then the txt. Both come from
  // resumes.config, so switching resumes never means touching code.
  const { text: rawText, path: usedPath } = await readFirstAvailable([
    RESUME_MD_PATH,
    RESUME_TXT_PATH,
  ]);
  console.log(`Profile parsed from ${path.basename(usedPath)}.`);

  // Contact details are template placeholders in the resume, so take them from
  // .env when present (email falls back to the Workday login email).
  const parsedEmail = realValue(rawText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]);
  const parsedPhone = realValue(rawText.match(/\d{3}[-.\s]\d{3}[-.\s]\d{4}/)?.[0]);
  const parsedLinkedin = realValue(rawText.match(/https?:\/\/[^\s|]*linkedin[^\s|]*/i)?.[0]);
  const parsedGithub = realValue(rawText.match(/https?:\/\/[^\s|]*github[^\s|]*/i)?.[0]);

  const primaryEmail = process.env.PROFILE_EMAIL || parsedEmail || process.env.JOB_APP_USERNAME;
  const primaryPhone = process.env.PROFILE_PHONE || parsedPhone;

  // Name: prefer the resume's own heading/first line (md is "# Nathan Yao"),
  // falling back to the PDF filename (e.g. "2026 Nathan Yao's Resume - IS.pdf").
  const firstLine = rawText.split("\n").map((line) => line.trim()).find(Boolean) || "";
  const headingName = realValue(firstLine.replace(/^#+\s*/, "").trim());
  const looksLikeName = (value: string | undefined): value is string =>
    !!value && /^[A-Za-z][A-Za-z.'-]*(\s+[A-Za-z][A-Za-z.'-]*){1,3}$/.test(value);

  const resumeBasename = path.basename(RESUME_PATH, path.extname(RESUME_PATH));
  const filenameName = resumeBasename
    .replace(/^\d{4}\s+/, "")
    .replace(/[''']s\s+/g, " ")
    .replace(/\s*[-–—]\s*.+$/, "")
    .replace(/\s+(resume|cv)\s*$/i, "")
    .trim();

  const namePart = looksLikeName(headingName) ? headingName : filenameName;
  const nameParts = namePart.split(/\s+/).filter(Boolean);
  const firstName = nameParts[0];
  const lastName = nameParts.length >= 2 ? nameParts[nameParts.length - 1] : undefined;

  const profile: ProfileData = {
    rawText,
    firstName,
    lastName,
    email: primaryEmail,
    loginEmail: process.env.JOB_APP_USERNAME ?? primaryEmail,
    loginPassword: process.env.JOB_APP_PASSWORD,
    phone: primaryPhone,
    linkedin: process.env.PROFILE_LINKEDIN || parsedLinkedin,
    github: process.env.PROFILE_GITHUB || parsedGithub,
    gpa: rawText.match(/GPA[:\s]+([0-9.]+)/i)?.[1],
    resumeText: rawText,
    preferredResumePath: RESUME_PATH,
  };

  const schoolLine = rawText
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().includes("carnegie mellon university"));
  if (schoolLine) {
    profile.school = cleanInstitution(schoolLine);
  }

  // Write a sanitized snapshot — exclude credentials so they never touch disk.
  const { loginPassword, ...safeProfile } = profile;
  void loginPassword;
  await writeJson(PROFILE_JSON_PATH, safeProfile);
  return profile;
}

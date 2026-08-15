import fs from "node:fs";
import path from "node:path";

// The web console runs with its own cwd (web/), so paths cannot be derived from cwd alone —
// data/ and logs/ live at the repo root regardless of who is running.
export const ROOT_DIR = process.env.JOBAPP_ROOT || process.cwd();
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const LOGS_DIR = path.join(ROOT_DIR, "logs");
// Chrome is single-instance per user-data-dir, so a debug session cannot share the profile
// with an active fill run. AUTH_DIR lets a throwaway profile be used instead.
export const AUTH_DIR = process.env.AUTH_DIR || path.join(ROOT_DIR, "playwright", ".auth");

export const SIMPLIFY_URL =
  "https://github.com/SimplifyJobs/Summer2026-Internships/blob/dev/README.md#-software-engineering-internship-roles";
export const SIMPLIFY_RAW_URL =
  "https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/README.md";
export const TRACKER_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1Ugo160-wF1YvOtnwNa__7A9Lep9mBR5plEdhJ0oZh-A/edit?pli=1&gid=0#gid=0";
export const TRACKER_SHEET_EXPORT_URL =
  "https://docs.google.com/spreadsheets/d/1Ugo160-wF1YvOtnwNa__7A9Lep9mBR5plEdhJ0oZh-A/export?format=csv&gid=0";

export const X8NOTE_CONFIG_PATH = path.join(ROOT_DIR, ".x8note.config");
export const JOB_SITES_PATH = path.join(ROOT_DIR, "job_sites.txt");
export const INTERNSHIPS_CSV_PATH = path.join(ROOT_DIR, "internships_summer2027.csv");
export const BUILD_INTERNSHIPS_SCRIPT = path.join(ROOT_DIR, "tools", "build_internships.mjs");

export const PROFILE_TEXT_PATH = path.join(ROOT_DIR, "text version.txt");
export const QA_TEXT_PATH = path.join(ROOT_DIR, "Q&A.txt");
export const QA_MARKDOWN_PATH = path.join(ROOT_DIR, "Q&A.md");
export const PROFILE_JSON_PATH = path.join(DATA_DIR, "profile.json");
export const ANSWERS_JSON_PATH = path.join(DATA_DIR, "answers.json");
export const APPLICATIONS_JSON_PATH = path.join(DATA_DIR, "applications.json");
export const APPLICATIONS_DIR = path.join(DATA_DIR, "applications");

// The standard resume in three formats (same content). Paths are read from the
// editable resumes.config file so they can be changed without touching code;
// the values below are the fallback defaults if that file is absent.
export const RESUMES_CONFIG_PATH = path.join(ROOT_DIR, "resumes.config");

function readStandardResumes(): { pdf: string; md: string; txt: string } {
  const defaults = {
    pdf: "2026 Nathan Yao's Resume - IS.pdf",
    md: "nathan resume 2026.md",
    txt: "nathan resume 2026.txt",
  };
  let raw = "";
  try {
    raw = fs.readFileSync(RESUMES_CONFIG_PATH, "utf8");
  } catch {
    return defaults;
  }
  const get = (key: string): string | undefined => {
    const match = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "mi"));
    return match ? match[1].trim() : undefined;
  };
  return { pdf: get("pdf") || defaults.pdf, md: get("md") || defaults.md, txt: get("txt") || defaults.txt };
}

const resolveFromRoot = (p: string): string => (path.isAbsolute(p) ? p : path.join(ROOT_DIR, p));
const standardResumes = readStandardResumes();

export const RESUME_PATH = resolveFromRoot(standardResumes.pdf); // uploaded to ATS forms
export const RESUME_MD_PATH = resolveFromRoot(standardResumes.md);
export const RESUME_TXT_PATH = resolveFromRoot(standardResumes.txt);

export const TRANSCRIPT_PATH = path.join(ROOT_DIR, "unofficial_academic_record.pdf");
// Per-application tailored resumes (git-ignored under data/). A file named
// <ID>.<ext> or <company-slug>.<ext> here is treated as a non-standard resume
// for that job and its text is saved into the x8note note.
export const RESUMES_DIR = path.join(DATA_DIR, "resumes");

export const AGE_ALLOWLIST = new Set(["0d", "1d"]);

export const SUBMIT_TEXT_BLOCKLIST = [
  "submit",
  "submit application",
  "send application",
  "complete application",
];

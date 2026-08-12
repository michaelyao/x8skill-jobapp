import fs from "node:fs/promises";
import { X8NOTE_CONFIG_PATH } from "../config.js";
import type { ApplicationRecord } from "../types.js";

export interface X8NoteConfig {
  baseUrl: string;
  token: string;
  notebook: string;
}

/**
 * Read x8note access details from .x8note.config (git-ignored). Returns null if
 * the file is missing/unparseable or if X8NOTE_DISABLE=1, so the runner can
 * silently skip syncing rather than fail.
 */
export async function loadX8NoteConfig(): Promise<X8NoteConfig | null> {
  if (process.env.X8NOTE_DISABLE === "1") {
    return null;
  }
  let raw: string;
  try {
    raw = await fs.readFile(X8NOTE_CONFIG_PATH, "utf8");
  } catch {
    return null;
  }
  const baseUrl = raw.match(/Base URL:\s*(\S+)/i)?.[1]?.replace(/\/+$/, "");
  const token = raw.match(/Bearer\s+([A-Za-z0-9._-]+)/)?.[1];
  const notebook = raw.match(/Notebooks?:\s*([^\n]+)/i)?.[1]?.trim().split(/[,\s]+/)[0] || "jobdescription";
  if (!baseUrl || !token) {
    return null;
  }
  return { baseUrl, token, notebook };
}

function resumeSection(record: ApplicationRecord): string {
  const name = record.resumeName || "unknown";
  if (record.resumeStandard !== false) {
    return `Standard resume: **${name}**`;
  }
  if (record.resumeContent) {
    return `Tailored resume: **${name}**\n\n\`\`\`\n${record.resumeContent}\n\`\`\``;
  }
  return `Tailored resume: **${name}** _(binary file — text not inlined; see the uploaded file)_`;
}

function noteMarkdown(record: ApplicationRecord): string {
  const lines = [
    `# ${record.company} — ${record.title}`,
    "",
    `- **Apply link:** ${record.applyUrl}`,
    record.location ? `- **Location:** ${record.location}` : "",
    record.region ? `- **Region:** ${record.region}` : "",
    `- **ATS:** ${record.ats}`,
    `- **Status:** ${record.status}`,
    record.code ? `- **List ID:** ${record.code}` : "",
    `- **Prepared:** ${record.updatedAt}`,
    "",
    "## Application answers",
    record.filledFields.length ? record.filledFields.map((field) => `- ${field}`).join("\n") : "_none_",
    "",
    "## Questions left for manual answer",
    record.unknownQuestions.length ? record.unknownQuestions.map((question) => `- ${question}`).join("\n") : "_none_",
    "",
    "## Resume",
    resumeSection(record),
    "",
    "## Job description",
    record.jobDescription || "_none captured_",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

/**
 * Create (or upsert — x8note skips >90%-similar same-title notes) a note in the
 * jobdescription notebook for one prepared application. Best-effort: never
 * throws; returns a short status string for logging.
 */
export async function postApplicationNote(config: X8NoteConfig, record: ApplicationRecord): Promise<string> {
  const body = {
    title: `${record.title} @ ${record.company}`,
    content: noteMarkdown(record),
    notebook: config.notebook,
    source_url: record.applyUrl,
    content_type: "document" as const,
    keywords: [record.company, record.ats, record.code, "internship", "summer 2027"].filter(Boolean) as string[],
  };
  try {
    const response = await fetch(`${config.baseUrl}/api/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return `x8note HTTP ${response.status}`;
    }
    const json = (await response.json().catch(() => ({}))) as { message?: string };
    return json.message || "x8note ok";
  } catch (error) {
    return `x8note error: ${(error as Error).message}`;
  }
}

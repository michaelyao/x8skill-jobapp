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

const headers = (config: X8NoteConfig) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${config.token}`,
});

/**
 * Label vocabulary. by-label is EXACT match only — no prefix or wildcard — so every
 * lookup we want must be its own precise token, and a typo is silently invisible.
 * Keep this the single place labels are minted.
 */
export function noteLabels(record: ApplicationRecord): string[] {
  return [
    record.company,
    `source_${record.ats}`,
    record.code ? `jobid_${record.code}` : "",
    record.companyReqId ? `req_${record.companyReqId}` : "",
    `stage_${record.status}`,
    "internship",
    "summer 2027",
  ].filter(Boolean) as string[];
}

/** Note title — carries the job code so two same-titled postings cannot collide. */
export function noteTitle(record: ApplicationRecord): string {
  return `${record.title} @ ${record.company}${record.code ? ` [${record.code}]` : ""}`;
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

/**
 * The note body mirrors the review email: the same meta, the same question/answer
 * pairs with the same draft flags, and the FULL job description. The note is the
 * durable copy of what was reviewed, so it must not be a summary of it.
 */
export function noteMarkdown(record: ApplicationRecord): string {
  // Prefer the structured answers; fall back to parsing the "label: value" strings so
  // records written before answers were stored still read like the email.
  const answers =
    record.answers?.length
      ? record.answers
      : record.filledFields.map((field) => {
          const i = field.indexOf(":");
          const value = i >= 0 ? field.slice(i + 1).trim() : "";
          return {
            label: i >= 0 ? field.slice(0, i).trim() : field.trim(),
            value: value.replace(/\s*\((DRAFT|you)\)\s*$/i, "").trim(),
            draft: /\(DRAFT\)/i.test(value),
          };
        });
  const qa = answers.length
    ? answers
        .map((a) => `**${a.label}**\n\nA: ${a.value || "_(empty)_"}${a.draft ? "  \n_draft — review before submitting_" : ""}`)
        .join("\n\n")
    : "_none_";

  const lines = [
    `# ${record.company} — ${record.title}`,
    "",
    `- **Apply link:** ${record.applyUrl}`,
    record.location ? `- **Location:** ${record.location}` : "",
    record.region ? `- **Region:** ${record.region}` : "",
    `- **ATS:** ${record.ats}`,
    `- **Status:** ${record.status}`,
    record.code ? `- **List ID:** ${record.code}` : "",
    record.companyReqId ? `- **Requisition ID:** ${record.companyReqId}` : "",
    `- **Prepared:** ${record.updatedAt}`,
    "",
    record.duplicateWarning
      ? `> **Possible duplicate — ${(record.duplicateWarning.confidence * 100).toFixed(0)}% confidence.** ${record.duplicateWarning.basis}` +
        `${record.duplicateWarning.otherCode ? ` (vs ${record.duplicateWarning.otherCode})` : ""}\n`
      : "",
    "## Application answers",
    qa,
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

interface SaveArticleResponse {
  success?: boolean;
  data?: { noteId?: string };
  message?: string;
}

/**
 * Write this application to x8note, one note per posting.
 *
 * Uses save-article with upsert keyed on the apply URL. The previous implementation
 * POSTed to /api/notes, which only skips a duplicate when the title matches AND the
 * content is >90% similar — but the body carries the status, a timestamp and the answer
 * list, so every re-run differed and created ANOTHER note. That produced 96 notes for 35
 * jobs (one posting had 18). Upserting on the URL keeps exactly one note per posting.
 *
 * Labels are then PUT explicitly: save-article MERGES labels, which would accumulate
 * every stage a job has ever been in (stage_prefilled_pending_submit alongside
 * stage_submitted). PUT replaces the array, so the labels always describe the job's
 * current state. Best-effort throughout: never throws, returns a status string.
 */
export async function postApplicationNote(
  config: X8NoteConfig,
  record: ApplicationRecord,
): Promise<{ status: string; noteId?: string }> {
  try {
    // x8note is the ONLY store, so a writer that has no description must never replace one
    // that is already there. Anything that reaches this point without text — a blocked
    // re-run, a status-only update, a re-sync from the metadata ledger — keeps what the
    // note already holds. (Learned the hard way: a re-sync from the slim ledger wiped 30
    // freshly captured descriptions in one pass.)
    let toWrite = record;
    if (!record.jobDescription && record.code) {
      const stored = await fetchStoredJobDescription(config, record.code);
      if (stored) toWrite = { ...record, jobDescription: stored };
    }
    const response = await fetch(`${config.baseUrl}/api/save-article`, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({
        // The job code makes the title unique per posting. Without it, save-article fell
        // back to matching on title when the URL did not match, so two DIFFERENT postings
        // that happen to share a title at the same company collapsed into one note: the
        // Palantir "Software Engineer Intern" listings QHKEQP and DWOXTX, where the second
        // overwrote the first's content and labels while keeping the first's source_url.
        title: noteTitle(record),
        content: noteMarkdown(toWrite),
        notebook: config.notebook,
        url: record.applyUrl, // the upsert key — one note per posting
        upsert: true,
        labels: noteLabels(record),
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) return { status: `x8note HTTP ${response.status}` };
    const json = (await response.json().catch(() => ({}))) as SaveArticleResponse;
    // save-article returns data.noteId — NOT data.id like POST /api/notes.
    const noteId = json.data?.noteId;
    if (noteId) await replaceLabels(config, noteId, noteLabels(record));
    return { status: noteId ? "synced" : json.message || "x8note ok", noteId };
  } catch (error) {
    return { status: `x8note error: ${(error as Error).message}` };
  }
}

/** PUT replaces the whole keywords array (it does not merge) — send the full list. */
async function replaceLabels(config: X8NoteConfig, noteId: string, labels: string[]): Promise<void> {
  await fetch(`${config.baseUrl}/api/notes/${noteId}`, {
    method: "PUT",
    headers: headers(config),
    body: JSON.stringify({ keywords: labels }),
    signal: AbortSignal.timeout(30000),
  }).catch(() => undefined);
}

export interface SimilarPosting {
  id: string;
  title: string;
  score: number;
  keywords: string[];
}

/**
 * Semantically similar postings already in the notebook. This is the duplicate signal
 * for Lever and Ashby, which expose no requisition id — measured on live data, the
 * search is meaning-based, so it finds the same role posted elsewhere even when the
 * wording differs. Hits carrying `excludeLabel` (this job's own id) are dropped, since
 * a posting always matches itself.
 *
 * Returns [] on any failure, including the documented 503 when the search backend is
 * down: a duplicate check that cannot run must never block an application.
 */
export async function findSimilarPostings(
  config: X8NoteConfig,
  query: string,
  opts: { excludeLabel?: string; minScore?: number; limit?: number } = {},
): Promise<SimilarPosting[]> {
  const { excludeLabel, minScore = 0.6, limit = 5 } = opts;
  try {
    const url = `${config.baseUrl}/api/notes/search?q=${encodeURIComponent(query)}&notebook=${encodeURIComponent(config.notebook)}&limit=${limit}`;
    const response = await fetch(url, { headers: headers(config), signal: AbortSignal.timeout(20000) });
    if (!response.ok) return [];
    // NOTE: search returns `results` at the top level, not `data`.
    const json = (await response.json().catch(() => ({}))) as { results?: Array<Record<string, unknown>> };
    return (json.results ?? [])
      .map((hit) => ({
        id: String(hit.id ?? ""),
        title: String(hit.title ?? ""),
        score: Number(hit.score ?? 0),
        keywords: (hit.keywords ?? []) as string[],
      }))
      .filter((hit) => hit.score >= minScore)
      .filter((hit) => !excludeLabel || !hit.keywords.some((k) => k.toLowerCase() === excludeLabel.toLowerCase()));
  } catch {
    return [];
  }
}

/**
 * The job description previously stored for this job, read back from its note. Used when
 * a re-visit fails to scrape the posting — x8note is the only store, so this is where a
 * previously captured description comes from. Empty string when there is none.
 */
export async function fetchStoredJobDescription(config: X8NoteConfig, code: string): Promise<string> {
  try {
    const ids = await findNoteIdsByLabels(config, [`jobid_${code}`]);
    if (ids.length === 0) return "";
    // by-label is immediately consistent (search is not), so this is safe right after a write.
    const url = `${config.baseUrl}/api/notes/batch-get?ids=${encodeURIComponent(ids.slice(0, 100).join(","))}&fields=full`;
    const response = await fetch(url, { headers: headers(config), signal: AbortSignal.timeout(20000) });
    if (!response.ok) return "";
    const json = (await response.json().catch(() => ({}))) as { data?: { notes?: Array<{ content?: string }> } };
    const bodies = (json.data?.notes ?? []).map((n) => n.content ?? "");
    // Take the longest stored description across any notes for this job.
    let best = "";
    for (const content of bodies) {
      const idx = content.indexOf("## Job description");
      if (idx < 0) continue;
      const jd = content.slice(idx + "## Job description".length).trim();
      if (jd && jd !== "_none captured_" && jd.length > best.length) best = jd;
    }
    return best;
  } catch {
    return "";
  }
}

/** Note ids carrying every one of these labels (AND). Exact match, immediately consistent. */
export async function findNoteIdsByLabels(config: X8NoteConfig, labels: string[]): Promise<string[]> {
  if (labels.length === 0) return [];
  try {
    const params = labels.map((l) => `label=${encodeURIComponent(l)}`).join("&");
    const url = `${config.baseUrl}/api/notes/by-label?${params}&notebook=${encodeURIComponent(config.notebook)}&fields=id&limit=200`;
    const response = await fetch(url, { headers: headers(config), signal: AbortSignal.timeout(20000) });
    if (!response.ok) return [];
    const json = (await response.json().catch(() => ({}))) as { data?: string[] };
    return json.data ?? [];
  } catch {
    return [];
  }
}

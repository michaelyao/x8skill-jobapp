import fs from "node:fs/promises";
import path from "node:path";
import { LOGS_DIR, X8NOTE_CONFIG_PATH } from "../config.js";
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
export function noteMarkdown(record: ApplicationRecord, screenshotUrl?: string): string {
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
    "## Review screenshot",
    screenshotSection(record, screenshotUrl),
    "",
    "## Job description",
    record.jobDescription || "_none captured_",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

/**
 * Put the review screenshot in x8note's own image store and return the URL it hands back.
 *
 * `POST /api/images/upload` takes multipart `images` and proxies to x8img with x8note's own
 * credential, so this needs nothing from us but the token we already hold — which is why it is the
 * way in rather than serving the file to a remote fetcher off our own website.
 *
 * NOTE THE HEADERS. `headers()` sets Content-Type: application/json, and setting any content type
 * by hand on a FormData body loses the multipart boundary, so only the Authorization header goes.
 *
 * THE URL IT RETURNS IS PUBLIC. Verified: fetching one with no credential at all answers 200. The
 * id is eight random characters, so it is unguessable rather than listed, but it is not protected —
 * and the image is the filled application. `X8NOTE_EMBED_SCREENSHOT=0` turns the upload off and
 * leaves the note with links only.
 */
export async function uploadNoteImage(config: X8NoteConfig, filePath: string): Promise<string | null> {
  try {
    const bytes = await fs.readFile(filePath);
    const body = new FormData();
    body.append("images", new Blob([bytes], { type: "image/png" }), path.basename(filePath));
    const response = await fetch(`${config.baseUrl}/api/images/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}` },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) return null;
    const json = (await response.json().catch(() => ({}))) as {
      data?: { images?: Array<{ url?: string }> };
    };
    return json.data?.images?.[0]?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * The review screenshot on disk, or null. `lastRunDir` is an absolute HOST path and this may be
 * running somewhere that path does not exist, so the run's NAME is also tried against the local
 * logs directory — the same correction `findScreenshot` needed on the website.
 */
export async function reviewScreenshotPath(record: ApplicationRecord): Promise<string | null> {
  if (!record.code || !record.lastRunDir) return null;
  const name = `review-${record.code}.png`;
  for (const candidate of [
    path.join(record.lastRunDir, name),
    path.join(LOGS_DIR, path.basename(record.lastRunDir), name),
  ]) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try the next one
    }
  }
  return null;
}

/**
 * WHERE THE PICTURE OF THE FILLED FORM IS, rather than the picture itself.
 *
 * The note LINKS to the screenshot; it does not embed it. save-article takes `imageUrls` and
 * downloads them, so embedding would mean serving the image to a remote fetcher — x8note is behind
 * Cloudflare, not on this machine — and it would then be re-hosted on x8img. That screenshot is the
 * filled application: name, email, phone, home address and every answer. `/api/screenshot/[code]`
 * says it plainly — "Screenshots show the filled application — PII. Never serve one without a
 * session" — and that is a decision already taken in this codebase, not one to reverse in passing.
 *
 * A link costs nothing and gives up nothing: the note is read in a browser, and the browser either
 * has the session or is asked for it.
 */
function screenshotSection(record: ApplicationRecord, screenshotUrl?: string): string {
  if (!record.code) return "_no code — cannot link a screenshot_";
  // PUBLIC_URL is deliberately unset in .env so the LAN address and the public name both work; the
  // note is read by a person, so it gets the name they actually browse.
  const base = (process.env.PUBLIC_URL?.trim() || "https://job.studiox8.com").replace(/\/+$/, "");
  if (!record.lastRunDir) return "_none captured for this run_";
  return [
    // The image when it is in x8note's own store, and a link back to ours when it is not — an
    // upload that failed should still leave the note pointing at the picture.
    screenshotUrl
      ? `![The filled form as it was photographed](${screenshotUrl})`
      : `[The filled form as it was photographed](${base}/api/screenshot/${record.code})`,
    "",
    `[Review page](${base}/queue/${record.code}) — the same screenshot beside the answers, with the buttons.`,
    "",
    "_The screenshot carries the address and phone number that were filled in._",
  ].join("\n");
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
): Promise<{ status: string; noteId?: string; screenshotUrl?: string }> {
  try {
    /**
     * The picture goes into x8note's OWN image store, and the note embeds the URL that comes
     * back. Uploaded once per run: `x8noteScreenshotRun` records which run the stored URL is of,
     * so a re-sync of the same application re-uses it rather than leaving another copy behind
     * every time a status changes. A new run means a new picture and a new upload.
     *
     * X8NOTE_EMBED_SCREENSHOT=0 skips the upload; the note then links back to our own
     * session-guarded copy instead. See uploadNoteImage for what the URL does and does not
     * protect.
     */
    let screenshotUrl = record.x8noteScreenshotUrl;
    const runName = record.lastRunDir ? path.basename(record.lastRunDir) : "";
    if (process.env.X8NOTE_EMBED_SCREENSHOT !== "0" && runName && record.x8noteScreenshotRun !== runName) {
      const file = await reviewScreenshotPath(record);
      if (file) {
        const uploaded = await uploadNoteImage(config, file);
        if (uploaded) screenshotUrl = uploaded;
      }
    }
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
        content: noteMarkdown(toWrite, screenshotUrl),
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
    return { status: noteId ? "synced" : json.message || "x8note ok", noteId, screenshotUrl };
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

/**
 * Bring a note's labels in line with the record's current status, writing NOTHING else.
 *
 * For a status change that happens outside a fill run (a manual submit), where there is no
 * new content to store. Labels-only by construction, so it cannot overwrite a captured
 * description the way a full note write with no content would.
 */
export async function syncNoteStage(config: X8NoteConfig, record: ApplicationRecord): Promise<boolean> {
  if (!record.code) return false;
  const ids = record.x8noteId ? [record.x8noteId] : await findNoteIdsByLabels(config, [`jobid_${record.code}`]);
  if (!ids.length) return false;
  for (const id of ids) await replaceLabels(config, id, noteLabels(record));
  return true;
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

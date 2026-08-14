/**
 * Push every ledger application into x8note — one note per posting, upserted on the
 * apply URL, with the current label vocabulary.
 *
 * x8note is the single store for application content, so this is how existing records
 * get there. Descriptions that were never captured (the page.evaluate bug) stay missing
 * until the posting is visited again; this reports how many are in that state rather
 * than pretending they synced.
 *
 * DRY_RUN=1 to preview.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { APPLICATIONS_DIR, APPLICATIONS_JSON_PATH } from "../config.js";
import { loadX8NoteConfig, noteLabels, postApplicationNote } from "../knowledge/x8note.js";
import type { ApplicationRecord } from "../types.js";

const dry = process.env.DRY_RUN === "1";
const cfg = await loadX8NoteConfig();
if (!cfg) throw new Error("no x8note config");

const records = JSON.parse(await fs.readFile(APPLICATIONS_JSON_PATH, "utf8")) as ApplicationRecord[];
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "job";

let synced = 0;
let withText = 0;
let missingText = 0;

for (const record of records) {
  // Content used to be written per-application on disk; pick it up so nothing is lost in
  // the move to x8note, then that local copy stops being written at all.
  const dir = path.join(APPLICATIONS_DIR, safeId(record.id));
  let description = record.jobDescription || "";
  if (!description) {
    try {
      const raw = await fs.readFile(path.join(dir, "job-description.txt"), "utf8");
      const body = raw.split("\n").slice(3).join("\n").trim();
      if (body && body !== "(no description captured)") description = body;
    } catch {
      /* nothing saved locally */
    }
  }
  let answers = record.answers;
  if (!answers) {
    try {
      const prev = JSON.parse(await fs.readFile(path.join(dir, "application.json"), "utf8")) as ApplicationRecord;
      answers = prev.answers;
    } catch {
      /* no per-application record */
    }
  }

  const full: ApplicationRecord = { ...record, jobDescription: description, answers };
  if (description) withText += 1;
  else missingText += 1;

  if (dry) {
    console.log(`  ${(record.code ?? record.id).padEnd(10)} ${description.length.toString().padStart(6)} chars  labels=${noteLabels(full).join(", ")}`);
    continue;
  }
  const result = await postApplicationNote(cfg, full);
  if (result.noteId) synced += 1;
  console.log(`  ${(record.code ?? record.id).padEnd(10)} ${result.status.padEnd(10)} ${description.length} chars`);
}

console.log(
  `\n${dry ? "would sync" : `synced ${synced}/${records.length}`} — ${withText} supplied a description from this machine; ` +
    `for the other ${missingText}, postApplicationNote preserves whatever the note already stores ` +
    `(run backfillDescriptions.ts to capture any that are still empty)`,
);

/**
 * Move any inline job-description text out of applications.json into the per-application
 * text file, so the ledger holds metadata only. Idempotent; DRY_RUN=1 to preview.
 *
 * Why: the ledger was rewritten in full after every job. With real descriptions captured
 * that is ~21 KB/record, so a 2000-job run would write ~81 GB for text already saved on
 * disk next to each application.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { APPLICATIONS_DIR, APPLICATIONS_JSON_PATH } from "../config.js";
import type { ApplicationRecord } from "../types.js";

const dry = process.env.DRY_RUN === "1";
const safeId = (id: string) => id.replace(/[^a-z0-9]+/gi, "_").toLowerCase();

const records = JSON.parse(await fs.readFile(APPLICATIONS_JSON_PATH, "utf8")) as ApplicationRecord[];
const before = Buffer.byteLength(JSON.stringify(records));
let moved = 0;
let alreadyOnDisk = 0;

for (const record of records) {
  const dir = path.join(APPLICATIONS_DIR, safeId(record.id));
  const file = path.join(dir, "job-description.txt");
  const inline = record.jobDescription || "";

  let onDisk = "";
  try {
    const raw = await fs.readFile(file, "utf8");
    onDisk = raw.split("\n").slice(3).join("\n").trim();
    if (onDisk === "(no description captured)") onDisk = "";
  } catch {
    /* no file yet */
  }

  // Whichever copy is longer is the one worth keeping.
  const best = inline.length >= onDisk.length ? inline : onDisk;
  if (best && best.length > onDisk.length) {
    console.log(`  ${(record.code ?? record.id).padEnd(10)} writing ${best.length} chars → ${path.relative(process.cwd(), file)}`);
    if (!dry) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, `${record.company} — ${record.title}\n${record.applyUrl}\n\n${best}\n`);
    }
    moved += 1;
  } else if (onDisk) {
    alreadyOnDisk += 1;
  }

  record.jobDescriptionChars = best.length;
  record.jobDescriptionFile = path.relative(process.cwd(), file);
  record.jobDescription = ""; // ledger keeps metadata only
}

const after = Buffer.byteLength(JSON.stringify(records));
console.log(
  `\n${moved} description(s) written to disk, ${alreadyOnDisk} already there.\n` +
    `ledger ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB${dry ? " (dry run — not written)" : ""}`,
);
if (!dry) {
  await fs.copyFile(APPLICATIONS_JSON_PATH, `${APPLICATIONS_JSON_PATH}.bak-jd-migration`);
  await fs.writeFile(APPLICATIONS_JSON_PATH, JSON.stringify(records, null, 2));
}

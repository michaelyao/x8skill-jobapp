/**
 * Visit every application whose note has no job description, capture it, and store it in
 * x8note. READ-ONLY: it opens the posting, reads text, and never touches a form — safe to
 * run against applications that were already submitted.
 *
 * Also picks up the employer's requisition id while the page is open, since most postings
 * only print it in the body. LIMIT=n to cap, DRY_RUN=1 to preview.
 */
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { APPLICATIONS_JSON_PATH } from "../config.js";
import { findRequisitionId } from "../core/requisitionId.js";
import { fetchStoredJobDescription, loadX8NoteConfig, postApplicationNote } from "../knowledge/x8note.js";
import { captureJobDescription } from "../utils/jobDescription.js";
import type { ApplicationRecord } from "../types.js";

const dry = process.env.DRY_RUN === "1";
const limit = Number(process.env.LIMIT ?? 100);
const cfg = await loadX8NoteConfig();
if (!cfg) throw new Error("no x8note config");

const records = JSON.parse(await fs.readFile(APPLICATIONS_JSON_PATH, "utf8")) as ApplicationRecord[];

// Ask the store itself what is missing, rather than trusting a counter in the ledger —
// the note is the source of truth, so this stays correct however the ledger drifted.
const todo: ApplicationRecord[] = [];
for (const record of records) {
  if (todo.length >= limit) break;
  const stored = record.code ? await fetchStoredJobDescription(cfg, record.code) : "";
  if (!stored) todo.push(record);
}
console.log(`${todo.length} of ${records.length} application(s) have no stored description${dry ? " (dry run)" : ""}`);

const browser = await chromium.launch({
  headless: true,
  chromiumSandbox: true,
  ignoreDefaultArgs: ["--enable-automation"],
  args: ["--disable-blink-features=AutomationControlled"],
});

let captured = 0;
let reqIds = 0;
let failed = 0;

for (const record of todo) {
  const page = await browser.newPage();
  try {
    await page.goto(record.applyUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);
    const description = await captureJobDescription(page);
    const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    const reqId = findRequisitionId(record.applyUrl, `${bodyText}\n${description}`);

    if (!description || description.length < 200) {
      console.log(`  ${(record.code ?? record.id).padEnd(10)} nothing usable (${description.length} chars) — posting may be closed`);
      failed += 1;
      continue;
    }
    if (reqId && !record.companyReqId) reqIds += 1;
    console.log(`  ${(record.code ?? record.id).padEnd(10)} ${String(description.length).padStart(6)} chars${reqId ? `  req=${reqId}` : ""}`);
    captured += 1;
    if (dry) continue;

    record.jobDescription = description;
    record.jobDescriptionChars = description.length;
    if (reqId) record.companyReqId = reqId;
    const result = await postApplicationNote(cfg, record);
    if (result.noteId) record.x8noteId = result.noteId;
    record.jobDescription = ""; // ledger stays metadata-only
  } catch (error) {
    console.log(`  ${(record.code ?? record.id).padEnd(10)} error: ${(error as Error).message.split("\n")[0].slice(0, 60)}`);
    failed += 1;
  } finally {
    await page.close().catch(() => undefined);
  }
}
await browser.close();

if (!dry) {
  await fs.copyFile(APPLICATIONS_JSON_PATH, `${APPLICATIONS_JSON_PATH}.bak-backfill-desc`);
  await fs.writeFile(APPLICATIONS_JSON_PATH, JSON.stringify(records, null, 2));
}
console.log(`\ncaptured ${captured}, ${reqIds} new requisition id(s), ${failed} failed (closed postings or login-walled)`);

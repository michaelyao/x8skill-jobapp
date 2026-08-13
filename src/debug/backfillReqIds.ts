/**
 * Backfill companyReqId on existing ledger + queue records from their URLs alone (no
 * network). Workday puts the requisition id in the URL, so this recovers those for free;
 * records whose id only appears in the page body are filled in the next time the job is
 * opened. DRY_RUN=1 to preview.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { APPLICATIONS_JSON_PATH, DATA_DIR } from "../config.js";
import { reqIdFromUrl } from "../core/requisitionId.js";

const QUEUE_PATH = path.join(DATA_DIR, "pending-approvals.json");
const dry = process.env.DRY_RUN === "1";

async function patch(file: string, label: string): Promise<void> {
  const rows = JSON.parse(await fs.readFile(file, "utf8")) as Array<Record<string, unknown>>;
  let changed = 0;
  for (const row of rows) {
    if (row.companyReqId) continue;
    const found = reqIdFromUrl(String(row.applyUrl ?? ""));
    if (!found) continue;
    row.companyReqId = found;
    changed += 1;
    console.log(`  ${label} ${String(row.code ?? row.id).padEnd(10)} ← ${found}   ${row.company}`);
  }
  console.log(`${label}: ${changed}/${rows.length} record(s) gained a requisition id${dry ? " (dry run — not written)" : ""}`);
  if (!dry && changed) {
    await fs.copyFile(file, `${file}.bak-reqid-backfill`);
    await fs.writeFile(file, JSON.stringify(rows, null, 2));
  }
}

await patch(APPLICATIONS_JSON_PATH, "ledger");
await patch(QUEUE_PATH, "queue ");

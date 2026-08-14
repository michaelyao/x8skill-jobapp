/**
 * Cross-check application status across all three places it is recorded:
 *   ledger (data/applications.json)   — authoritative status
 *   approval queue (pending-approvals) — in-flight approval workflow only
 *   x8note stage_* label               — the shared/queryable copy
 * Any disagreement is a tracking hole; this prints them rather than assuming.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { APPLICATIONS_JSON_PATH, DATA_DIR } from "../config.js";
import { loadX8NoteConfig } from "../knowledge/x8note.js";
import type { ApplicationRecord } from "../types.js";

const cfg = await loadX8NoteConfig();
const records = JSON.parse(await fs.readFile(APPLICATIONS_JSON_PATH, "utf8")) as ApplicationRecord[];
const queue = JSON.parse(await fs.readFile(path.join(DATA_DIR, "pending-approvals.json"), "utf8")) as Array<{
  code?: string; status: string; key: string;
}>;

// stage_* label per job code, straight from the notebook.
const stageByCode = new Map<string, string>();
if (cfg) {
  const auth = { Authorization: `Bearer ${cfg.token}` };
  for (let offset = 0; ; offset += 100) {
    const r = await fetch(`${cfg.baseUrl}/api/notes?notebook=${encodeURIComponent(cfg.notebook)}&limit=100&offset=${offset}`, { headers: auth });
    const j = (await r.json()) as { data?: Array<{ keywords?: string[] }>; hasMore?: boolean };
    for (const n of j.data ?? []) {
      const code = (n.keywords ?? []).find((k) => k.startsWith("jobid_"))?.slice("jobid_".length);
      const stage = (n.keywords ?? []).find((k) => k.startsWith("stage_"))?.slice("stage_".length);
      if (code && stage) stageByCode.set(code, stage);
    }
    if (!j.hasMore) break;
  }
}

const queueByCode = new Map(queue.filter((q) => q.code).map((q) => [q.code!, q.status]));
// The queue tracks approval workflow, so it legitimately has no entry for a job that was
// never queued (submitted straight from the terminal) — that is not a mismatch.
const QUEUE_EQUIV: Record<string, string[]> = {
  submitted: ["submitted"],
  already_applied_on_site: ["submitted"],
  prefilled_pending_submit: ["awaiting_approval", "submitting", "skipped", "error"],
};

let mismatches = 0;
console.log(`${"code".padEnd(8)} ${"ledger".padEnd(26)} ${"queue".padEnd(18)} x8note`);
for (const r of records) {
  const code = r.code ?? "(none)";
  const q = queueByCode.get(code);
  const stage = stageByCode.get(code);
  const queueOk = !q || (QUEUE_EQUIV[r.status] ?? []).includes(q);
  const noteOk = !cfg || stage === r.status;
  if (!queueOk || !noteOk) mismatches += 1;
  const flag = !queueOk || !noteOk ? "  ← MISMATCH" : "";
  if (flag || process.env.VERBOSE === "1") {
    console.log(`${code.padEnd(8)} ${r.status.padEnd(26)} ${(q ?? "—").padEnd(18)} ${stage ?? "—"}${flag}`);
  }
}
const submitted = records.filter((r) => r.status === "submitted" || r.status === "already_applied_on_site").length;
console.log(
  `\n${records.length} application(s): ${submitted} submitted, ${records.length - submitted} not.\n` +
    `${stageByCode.size} carry an x8note stage label. Mismatches: ${mismatches}`,
);

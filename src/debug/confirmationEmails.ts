import { spawn } from "node:child_process";
import { loadEnv } from "../utils/env.js";
loadEnv();
import { loadApplications } from "../knowledge/applications.js";
import { loadPendingQueue } from "../knowledge/approvalQueue.js";
import { normalizeCompany } from "../utils/normalize.js";

/**
 * WHICH EMPLOYERS ACTUALLY HOLD AN APPLICATION — read from the acknowledgement emails.
 *
 *   npm run audit:emails
 *
 * Two applications reached the review queue while the employer already had them, and both were
 * found by the candidate reading his own inbox: DV Trading (our own submit, missed because a
 * contraction defeated the confirmation check) and Notion (Nathan's own, sent 32 hours before we
 * first saw the posting). Each sat behind an Approve button.
 *
 * The email is the employer's own word, and it is the only source that sees BOTH kinds. Timing is
 * what separates them: an acknowledgement that predates our first sighting of the posting cannot
 * be ours.
 *
 * Read-only. It writes nothing and enqueues nothing — the worker is the only writer of the stores,
 * and what to do about a finding is a decision, not a tidy-up.
 */
const account = () => process.env.GOG_ACCOUNT || "myao@studiox8.com";

function gog(args: string[], timeoutMs = 120_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("gog", args);
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    const timer = setTimeout(() => { child.kill(); resolve({ code: 124, out }); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 1, out: String(e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 0, out }); });
  });
}

const SUBJECTS = [
  '"thank you for applying"',
  '"thank you for your application"',
  '"application received"',
  '"we received your application"',
  '"we\'ve received your application"',
  '"your application has been received"',
  '"thanks for applying"',
];

interface Mail { id: string; subject: string; from: string; date: string }

async function fetchConfirmations(days: number): Promise<Mail[]> {
  const seen = new Map<string, Mail>();
  for (const phrase of SUBJECTS) {
    const q = `newer_than:${days}d ${phrase}`;
    const r = await gog(["-a", account(), "gmail", "search", q, "-j", "--max", "100"]);
    if (r.code !== 0 && !r.out.trim().startsWith("[") && !r.out.includes('"id"')) {
      console.log(`  ! search failed for ${phrase}: ${r.out.split("\n")[0].slice(0, 100)}`);
      continue;
    }
    let rows: Array<Record<string, unknown>> = [];
    try {
      const parsed = JSON.parse(r.out);
      rows = Array.isArray(parsed) ? parsed : ((parsed as { messages?: [] }).messages ?? []);
    } catch {
      rows = [...r.out.matchAll(/"id"\s*:\s*"([0-9a-fA-F]+)"/g)].map((m) => ({ id: m[1] }));
    }
    for (const row of rows) {
      const id = String(row.id ?? "");
      if (!id || seen.has(id)) continue;
      seen.set(id, {
        id,
        subject: String(row.subject ?? row.Subject ?? ""),
        from: String(row.from ?? row.From ?? ""),
        date: String(row.date ?? row.Date ?? row.internalDate ?? ""),
      });
    }
  }
  return [...seen.values()];
}

const days = Number(process.argv[2] ?? 60);
console.log(`Reading acknowledgement emails from the last ${days} days…\n`);
const mails = await fetchConfirmations(days);
console.log(`${mails.length} acknowledgement email(s) found.\n`);

const [apps, queue] = await Promise.all([loadApplications(), loadPendingQueue()]);
const awaiting = new Set(
  queue.filter((e) => e.status === "awaiting_approval").map((e) => e.code ?? e.key),
);

/** Does this email plausibly name that employer? Company names appear in the subject or sender. */
const namesCompany = (mail: Mail, company: string): boolean => {
  const c = normalizeCompany(company);
  if (!c || c.length < 3) return false;
  const hay = `${mail.subject} ${mail.from}`.toLowerCase();
  return hay.includes(c.toLowerCase()) || c.toLowerCase().split(" ").every((w) => w.length > 2 && hay.includes(w));
};

const findings: string[] = [];
for (const record of apps) {
  const hit = mails.find((m) => namesCompany(m, record.company ?? ""));
  if (!hit) continue;
  const code = record.code ?? record.id ?? "?";
  const emailAt = Date.parse(hit.date) || Number(hit.date) || 0;
  const firstSeen = Date.parse(record.firstSeenAt ?? "") || 0;
  const ours = emailAt && firstSeen ? emailAt >= firstSeen : undefined;
  const inQueue = awaiting.has(code);
  const alreadyRecorded = ["submitted", "manual_submitted", "already_applied_on_site"].includes(
    String(record.status),
  );
  if (alreadyRecorded && !inQueue) continue; // known, and not offered for approval
  const who = ours === undefined ? "unknown when" : ours ? "after we first saw it — likely OURS" : "BEFORE we first saw it — Nathan's own";
  const line =
    `  ${code}  ${String(record.company).slice(0, 22).padEnd(22)} ${String(record.status).padEnd(24)}` +
    `${inQueue ? "IN THE APPROVAL QUEUE" : ""}\n` +
    `        email: ${hit.subject.slice(0, 74)}\n` +
    `        ${new Date(emailAt || 0).toISOString().slice(0, 16)} vs first seen ${String(record.firstSeenAt ?? "?").slice(0, 16)} — ${who}`;
  findings.push(line);
}

if (!findings.length) {
  console.log("No employer acknowledgement matches an application that is not already recorded as sent.");
} else {
  console.log(`${findings.length} application(s) an employer has acknowledged but our stores do not call sent:\n`);
  findings.forEach((f) => console.log(f + "\n"));
  console.log("Nothing was changed. Decide each one: manual_submit if Nathan sent it, otherwise it was ours.");
}

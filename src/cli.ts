import os from "node:os";
import { loadEnv } from "./utils/env.js";
import {
  enqueueCommand,
  pendingCommands,
  recentCommands,
  type Command,
  type CommandResult,
  type NewCommand,
} from "./knowledge/commands.js";
import { loadPendingQueue, type PendingEntry } from "./knowledge/approvalQueue.js";
import { loadApplications } from "./knowledge/applications.js";
import { loadInternshipList } from "./sources/internshipList.js";
import { isStale, readWorkerStatus } from "./knowledge/workerStatus.js";

/**
 * Terminal client for the worker.
 *
 * It does NOT drive a browser. Like the web website, it only writes a command file and lets
 * the daemon — which owns Chrome — execute it. That is the whole point: `npm start` and
 * `npm run approvals` each launch their own Chrome and become a second driver competing for a
 * profile that can only have one; this shares the single lane instead.
 *
 *   jobapp status
 *   jobapp queue
 *   jobapp approve SBXFMD
 *   jobapp retry BXGRTC --hint "the school is Carnegie Mellon University"
 *   jobapp skip QFOBUG
 *   jobapp manual-submit HDHJVW
 *   jobapp sweep --max 10
 *   jobapp refresh
 *
 * By default it waits and streams the outcome, because "queued" is a useless answer when the
 * work takes four minutes. Ctrl-C detaches from the output; the daemon owns the work either
 * way and keeps going.
 */

loadEnv();

const HELP = `jobapp — terminal client for the job application worker

Usage
  jobapp status                       what the worker is doing, what is queued
  jobapp queue [--all]                applications awaiting your approval
  jobapp sweep [--max N]              pick the next N jobs (default 10) and queue them
  jobapp refresh                      rebuild the job list from job_sites.txt
  jobapp apply <CODE>                 apply to one job by code (fill only, never submits)
  jobapp approve <CODE>               re-fill, verify against approved answers, submit
  jobapp retry <CODE> [--hint TEXT]   re-fill a blocked or new job (never submits)
  jobapp change <CODE> --hint TEXT    re-fill applying a correction, then re-review
  jobapp skip <CODE>                  drop it from the queue — no application was filed
  jobapp manual-submit <CODE>         you filled and submitted it yourself on the ATS
  jobapp history <CODE>               every recorded copy of that application

Flags
  --max N        how many jobs a sweep should queue (default 10)
  --no-wait      enqueue and exit instead of streaming the outcome
  --json         machine-readable output
  -h, --help     this text

Nothing here submits without an explicit approve, and an approve only submits values you
have already read — see DESIGN.md §18.
`;

type Argv = { _: string[]; hint?: string; wait: boolean; json: boolean; all: boolean; max?: number };

function parseArgs(argv: string[]): Argv {
  const out: Argv = { _: [], wait: true, json: false, all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--hint" || a === "--instruction") out.hint = argv[++i];
    else if (a === "--no-wait") out.wait = false;
    else if (a === "--json") out.json = true;
    else if (a === "--all") out.all = true;
    else if (a === "--max") {
      const n = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isNaN(n) && n > 0) out.max = n;
    }
    else if (a === "-h" || a === "--help") out._.push("help");
    else out._.push(a);
  }
  return out;
}

const actor = () => process.env.JOBAPP_ACTOR || os.userInfo().username;
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const when = (iso?: string) => (iso ? iso.slice(0, 16).replace("T", " ") : "—");

/**
 * Refuse an unknown code HERE rather than letting the worker discover it a tick later. The
 * queue, the ledger and the posting list are all valid places for a job to live: a new posting
 * exists only in the CSV, a blocked one only in the ledger.
 */
async function resolveCode(code: string): Promise<{ ok: true; where: string; label: string } | { ok: false; message: string }> {
  const wanted = code.toUpperCase();
  const queue = await loadPendingQueue().catch(() => [] as PendingEntry[]);
  const entry = queue.find((e) => e.code?.toUpperCase() === wanted || e.key.toUpperCase() === wanted);
  if (entry) return { ok: true, where: `queue (${entry.status})`, label: `${entry.company} · ${entry.title}` };

  const record = (await loadApplications().catch(() => [])).find((a) => a.code?.toUpperCase() === wanted);
  if (record) return { ok: true, where: `ledger (${record.status})`, label: `${record.company} · ${record.title}` };

  const listed = (await loadInternshipList().catch(() => [])).find((j) => j.id?.toUpperCase() === wanted);
  if (listed) return { ok: true, where: "posting list (never opened)", label: `${listed.company} · ${listed.title}` };

  return { ok: false, message: `no job known as ${wanted} — not in the queue, the ledger or the posting list` };
}

/** Poll for this command's completion, narrating what the worker is doing meanwhile. */
async function waitFor(id: string, json: boolean): Promise<number> {
  let lastActivity = "";
  let announcedPickup = false;
  const startedAt = Date.now();

  for (;;) {
    const done = (await recentCommands(60)).find((c) => c.id === id);
    if (done?.result) {
      const result = done.result as CommandResult;
      if (json) console.log(JSON.stringify({ id, ...result }));
      else console.log(`${result.ok ? "✅" : "⚠️ "} ${result.message}`);
      return result.ok ? 0 : 1;
    }

    const status = await readWorkerStatus();
    if (!json) {
      if (isStale(status) && Date.now() - startedAt > 30_000) {
        console.log("   (the worker is not responding — is the daemon running? `launchctl list | grep jobapp`)");
        return 2;
      }
      const stillQueued = (await pendingCommands()).some((c) => c.id === id);
      if (!stillQueued && !announcedPickup) {
        console.log("   worker picked it up");
        announcedPickup = true;
      }
      // Only narrate real work. "waiting for commands" is the idle string and reads as
      // progress when it is the opposite.
      if (status?.state === "busy" && status.activity && status.activity !== lastActivity) {
        console.log(`   ${status.activity}`);
        lastActivity = status.activity;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function send(
  name: Command["name"],
  code: string | undefined,
  args: Argv,
  extra: Record<string, unknown> = {},
): Promise<number> {
  if (code) {
    const found = await resolveCode(code);
    if (!found.ok) {
      console.error(found.message);
      return 1;
    }
    if (!args.json) console.log(`${name} ${code.toUpperCase()} — ${found.label}  [${found.where}]`);
  }

  const command = await enqueueCommand({
    name,
    ...(code ? { code: code.toUpperCase() } : {}),
    ...(args.hint ? { instruction: args.hint } : {}),
    ...extra,
    source: "cli",
    actor: actor(),
  } as NewCommand);

  if (!args.wait) {
    console.log(args.json ? JSON.stringify({ queued: command.id }) : `queued (${command.id}) — the worker takes it within ~10s`);
    return 0;
  }
  if (!args.json) console.log(`queued as ${actor()} …`);
  return waitFor(command.id, args.json);
}

async function status(args: Argv): Promise<number> {
  const [worker, pending, queue] = await Promise.all([readWorkerStatus(), pendingCommands(), loadPendingQueue().catch(() => [])]);
  const awaiting = queue.filter((e) => e.status === "awaiting_approval");
  const held = awaiting.filter((e) => e.reapproval);
  // "submitting" means either a submit running RIGHT NOW or one whose outcome was never
  // recorded. Only the second needs you. The worker's own status says which.
  const submitting = queue.filter((e) => e.status === "submitting");
  const inFlight = submitting.filter((e) => !isStale(worker) && worker?.state === "busy" && worker?.code === e.code);
  const stuck = submitting.filter((e) => !inFlight.includes(e));

  if (args.json) {
    console.log(JSON.stringify({ worker, stale: isStale(worker), pending: pending.length, awaiting: awaiting.length, held: held.length, inFlight: inFlight.length, stuck: stuck.length }));
    return 0;
  }

  const stale = isStale(worker);
  console.log(`worker    ${stale ? "NOT RESPONDING" : worker?.state ?? "unknown"}${worker?.pid ? ` (pid ${worker.pid})` : ""}`);
  if (worker?.activity && !stale) console.log(`          ${worker.activity}`);
  if (worker?.lastError) console.log(`          last error: ${short(worker.lastError, 90)}`);
  console.log(`commands  ${pending.length} queued`);
  console.log(`awaiting  ${awaiting.length} application(s) need your approval${held.length ? `, ${held.length} held for re-approval` : ""}`);
  if (inFlight.length) console.log(`in flight ${inFlight.map((e) => e.code).join(", ")} — submitting now`);
  if (stuck.length) console.log(`stuck     ${stuck.length} mid-submit — confirm on the ATS: ${stuck.map((e) => e.code).join(", ")}`);

  const recent = (await recentCommands(5)).filter((c) => c.result);
  if (recent.length) {
    console.log("\nrecent");
    for (const c of recent) {
      console.log(`  ${c.result!.ok ? "✅" : "⚠️ "} ${when(c.result!.finishedAt)}  ${c.name} ${("code" in c && c.code) || ""}  ${short(c.result!.message, 70)}`);
    }
  }
  return 0;
}

async function showQueue(args: Argv): Promise<number> {
  const queue = await loadPendingQueue().catch(() => []);
  const rows = args.all ? queue : queue.filter((e) => e.status === "awaiting_approval");
  if (args.json) {
    console.log(JSON.stringify(rows.map((e) => ({ code: e.code, company: e.company, title: e.title, status: e.status, answers: e.answers?.length ?? 0, held: Boolean(e.reapproval) }))));
    return 0;
  }
  if (!rows.length) {
    console.log("nothing waiting on you.");
    return 0;
  }
  for (const e of rows.sort((a, b) => (b.reviewSentAt ?? "").localeCompare(a.reviewSentAt ?? ""))) {
    const flags = [e.reapproval ? "HELD" : "", (e.answers ?? []).some((a) => a.draft) ? "draft" : ""].filter(Boolean).join(" ");
    console.log(
      `${e.code ?? e.key}  ${short(e.company, 22).padEnd(22)} ${short(e.title, 44).padEnd(44)} ${String(e.answers?.length ?? 0).padStart(3)} ans  ${when(e.reviewSentAt)}${flags ? `  [${flags}]` : ""}`,
    );
  }
  console.log(`\n${rows.length} shown. Review at ${process.env.PUBLIC_URL || "http://localhost:8088"}/queue`);
  return 0;
}

async function history(code: string, args: Argv): Promise<number> {
  const { listRounds, diffRounds, describeDiff } = await import("./knowledge/rounds.js");
  const rounds = await listRounds(code.toUpperCase());
  if (!rounds.length) {
    console.log(`no recorded copies for ${code.toUpperCase()}`);
    return 1;
  }
  if (args.json) {
    console.log(JSON.stringify(rounds));
    return 0;
  }
  rounds.forEach((r, i) => {
    console.log(`${i + 1}. ${r.phase}${r.reconstructed ? " (reconstructed)" : ""}  ${when(r.at)}  ${r.fields.length} fields, ${r.answers.length} answers`);
    if (r.outcome) console.log(`   ${short(r.outcome, 100)}`);
    if (i > 0) {
      const lines = describeDiff(diffRounds(rounds[i - 1], r));
      if (!lines.length) console.log("   no change from the previous copy");
      for (const line of lines) console.log(`   • ${short(line, 120)}`);
    }
  });
  return 0;
}

const args = parseArgs(process.argv.slice(2));
const [verb, code] = args._;

let exit = 0;
switch (verb) {
  case "status":
  case undefined:
    exit = await status(args);
    break;
  case "queue":
    exit = await showQueue(args);
    break;
  case "history":
    exit = code ? await history(code, args) : ((console.error("usage: jobapp history <CODE>"), 1) as number);
    break;
  case "sweep":
    exit = await send("sweep", undefined, args, { maxJobs: args.max, refreshList: true });
    break;
  case "refresh":
  case "refresh_list":
    exit = await send("refresh_list", undefined, args);
    break;
  case "approve":
  case "retry":
  case "apply":
  case "skip":
  case "manual-submit":
  case "manual_submit":
  case "change": {
    if (!code) {
      console.error(`usage: jobapp ${verb} <CODE>`);
      exit = 1;
      break;
    }
    if (verb === "change" && !args.hint) {
      console.error('change needs an instruction: jobapp change CODE --hint "use my Sunnyvale address"');
      exit = 1;
      break;
    }
    // The verb is hyphenated for typing; the command name is not.
    exit = await send(verb === "manual-submit" ? "manual_submit" : verb, code, args);
    break;
  }
  case "help":
    console.log(HELP);
    break;
  default:
    console.error(`unknown command "${verb}"\n`);
    console.log(HELP);
    exit = 1;
}
process.exit(exit);

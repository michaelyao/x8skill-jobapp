import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { loadApplications } from "@core/knowledge/applications.js";
import { normalizeCompany } from "@core/utils/normalize.js";
import { loadPendingQueue, type PendingEntry } from "@core/knowledge/approvalQueue.js";
import { pendingCommands, recentCommands, type Command } from "@core/knowledge/commands.js";
import { readWorkerStatus, isStale, type WorkerStatus } from "@core/knowledge/workerStatus.js";
import type { ApplicationRecord } from "@core/types.js";
import { ensureEnv } from "./env";
import { loadInternshipList } from "@core/sources/internshipList.js";
import { detectAtsType } from "@core/core/jobIdentity.js";
import { normalizeUrl } from "@core/utils/normalize.js";
import { ledgerStage, queueStage } from "@core/core/statusVocabulary.js";

/**
 * Read-only view of the state the worker owns. The website NEVER writes application state —
 * it enqueues commands and the worker applies them. Keeping that one-way is what stops two
 * processes racing on the same JSON.
 */

const ROOT = process.env.JOBAPP_ROOT ?? process.cwd();

export type { ApplicationRecord, PendingEntry, WorkerStatus };

export interface Overview {
  applications: ApplicationRecord[];
  queue: PendingEntry[];
  worker: { status: WorkerStatus | null; stale: boolean };
  pendingCommandCount: number;
  /**
   * WHAT is queued, not just how many. The bar showed "15 queued" and there was no way to see
   * behind it — the candidate asked for a button, which is the right instinct: a number you cannot
   * open is a number you have to take on trust.
   *
   * Ordered the way the worker will actually claim them (see the PRIORITY table), because "what is
   * next" is the question the list is being opened to answer.
   */
  pendingCommandList: Array<{
    name: string;
    code?: string;
    company?: string;
    createdAt: string;
    priority?: number;
    instruction?: string;
  }>;
}

export async function getOverview(): Promise<Overview> {
  ensureEnv();
  const [applications, queue, status, pending] = await Promise.all([
    loadApplications(),
    loadPendingQueue(),
    readWorkerStatus(),
    pendingCommands(),
  ]);
  return {
    applications,
    queue,
    worker: { status, stale: isStale(status) },
    pendingCommandCount: pending.length,
    pendingCommandList: describePending(pending, applications),
  };
}

/** The queued commands, in the order the worker will take them, with a company where we know one. */
function describePending(
  pending: ReadonlyArray<Command>,
  applications: ReadonlyArray<{ code?: string; company?: string; title?: string }>,
): Overview["pendingCommandList"] {
  // Mirrors src/knowledge/commands.ts. Kept as a display concern: the worker's copy decides what
  // actually runs, and duplicating the numbers here cannot change that — it only shows the order.
  const RANK: Record<string, number> = {
    approve: 0, skip: 0, manual_submit: 0, visual_check: 0,
    update_answers: 1, update_guidelines: 1, forget_answers: 1,
    change: 2, retry: 3, apply: 3, refresh_list: 4, sweep: 4,
  };
  const byCode = new Map(applications.filter((a) => a.code).map((a) => [String(a.code), a]));
  return pending
    .map((c) => {
      const any = c as Command & { code?: string; priority?: number; instruction?: string };
      const name = String(any.name ?? "");
      const code = any.code ? String(any.code) : undefined;
      const explicit = typeof any.priority === "number" ? any.priority : undefined;
      return {
        name,
        ...(code ? { code } : {}),
        ...(code && byCode.get(code)?.company ? { company: String(byCode.get(code)!.company) } : {}),
        createdAt: String(any.createdAt ?? ""),
        ...(explicit !== undefined ? { priority: explicit } : {}),
        ...(any.instruction ? { instruction: String(any.instruction).slice(0, 120) } : {}),
        rank: explicit ?? RANK[name] ?? 2,
      };
    })
    .sort((a, b) => a.rank - b.rank || a.createdAt.localeCompare(b.createdAt))
    .map(({ rank: _rank, ...rest }) => rest);
}

/**
 * The pid holding the Chrome profile, if it is alive. A truer liveness signal than the
 * heartbeat: the heartbeat can freeze while the worker is deep inside a multi-minute submit,
 * but the lock is held for exactly as long as a browser session is really open.
 */
export async function browserLockHolder(): Promise<number | null> {
  try {
    const raw = await fs.readFile(path.join(ROOT, "data", ".browser.lock"), "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(pid)) return null;
    process.kill(pid, 0); // throws if the process is gone
    return pid;
  } catch {
    return null;
  }
}

/**
 * What decision, if any, has already been taken on each queued job — keyed by code.
 *
 * A queue row that says nothing about this is misleading: an approved job whose submit failed
 * looks identical to one nobody has looked at, and a job the worker is mid-way through looks
 * like it is still waiting. Both happened.
 */
export interface DecisionState {
  /** A command for this job is queued or running: the worker is on it. */
  pending?: string;
  working?: boolean;
  /** A decision was recorded, with who and when. */
  decidedAt?: string;
  decidedBy?: string;
  /** The copy in the queue is NEWER than the decision — it was re-filled since, so the
   *  decision applied to answers that are no longer the ones on offer. */
  superseded?: boolean;
}

export async function getDecisions(): Promise<Map<string, DecisionState>> {
  ensureEnv();
  const [queue, pending, status] = await Promise.all([
    loadPendingQueue().catch(() => [] as PendingEntry[]),
    pendingCommands().catch(() => []),
    readWorkerStatus().catch(() => null),
  ]);
  const live = !isStale(status) && status?.state === "busy" ? status?.code : undefined;
  const out = new Map<string, DecisionState>();
  for (const entry of queue) {
    const code = entry.code ?? entry.key;
    const queued = pending.find((c) => "code" in c && c.code === code);
    const state: DecisionState = {};
    if (queued) state.pending = queued.name;
    if (live && live === code) state.working = true;
    if (entry.decidedAt) {
      state.decidedAt = entry.decidedAt;
      state.decidedBy = entry.approvedBy;
      state.superseded = Boolean(entry.reviewSentAt && entry.reviewSentAt > entry.decidedAt);
    }
    out.set(code, state);
  }
  return out;
}

export async function getActivity(limit = 20) {
  return recentCommands(limit);
}

export async function getQueueEntry(code: string): Promise<PendingEntry | null> {
  const queue = await loadPendingQueue();
  return queue.find((e) => e.code === code || e.key === code) ?? null;
}

export async function getApplication(code: string): Promise<ApplicationRecord | null> {
  const apps = await loadApplications();
  return apps.find((a) => a.code === code || a.id === code) ?? null;
}

/**
 * Every application at the SAME EMPLOYER, so a decision about one is made knowing the others.
 *
 * Chicago Trading Company runs two Greenhouse boards and posts "Software Engineer Intern" on both;
 * The Nuclear Company had four roles open. Reviewing one at a time, there is no way to tell a second
 * opening from a second application to the same opening — which is exactly the question a reviewer
 * has to answer before approving, and the one the candidate had to answer from confirmation emails.
 *
 * Matched on the normalized company name, the same way the identity rules do, so "Chicago Trading
 * Company (CTC)" and "Chicago Trading Company" are one employer.
 */
export interface SiblingApplication {
  code: string;
  title: string;
  applyUrl: string;
  /** The ATS's own id for the posting — two rows sharing one is the same job twice. */
  jobId?: string;
  ledgerStatus?: string;
  queueStatus?: string;
  at?: string;
  isThisOne: boolean;
}

export async function getSiblingApplications(code: string): Promise<SiblingApplication[]> {
  const [apps, queue] = await Promise.all([loadApplications(), loadPendingQueue()]);
  const me = apps.find((a) => a.code === code || a.id === code);
  const company = normalizeCompany(me?.company ?? (await getQueueEntry(code))?.company ?? "");
  if (!company) return [];

  const byCode = new Map(queue.map((e) => [e.code ?? e.key, e]));
  const rows = apps
    .filter((a) => normalizeCompany(a.company ?? "") === company)
    .map((a) => {
      const id = (a.applyUrl ?? "").match(/\/jobs?\/(\d{4,})/)?.[1] ?? a.externalJobId ?? a.companyReqId;
      return {
        code: a.code ?? a.id ?? "",
        title: a.title ?? "",
        applyUrl: a.applyUrl ?? "",
        jobId: id ? String(id) : undefined,
        ledgerStatus: a.status,
        queueStatus: byCode.get(a.code ?? a.id ?? "")?.status,
        at: a.updatedAt ?? a.firstSeenAt,
        isThisOne: (a.code ?? a.id) === code,
      } satisfies SiblingApplication;
    })
    .sort((x, y) => (y.at ?? "").localeCompare(x.at ?? ""));
  // One row is just this application; there is nothing to compare it against.
  return rows.length > 1 ? rows : [];
}

/**
 * Locate the screenshot for a job. `review-<CODE>.png` is the completed application;
 * `debug-<CODE>.png` is what a blocked run left behind. Newest run directory wins, because a
 * job can be re-run many times.
 */
export async function findScreenshot(code: string): Promise<string | null> {
  const app = await getApplication(code);
  const logsDir = path.join(ROOT, "logs");
  const candidates: string[] = [];

  /**
   * `lastRunDir` is stored as an ABSOLUTE HOST PATH — /Users/baibai/dev/git/x8skill-jobapp/logs/…
   * — and the website runs in a container where that path does not exist; it sees /jobapp/logs/….
   * So the best candidate always failed here, silently, and the fallback below was doing all the
   * work. Take the run's NAME and rebuild the path from this process's own root.
   */
  if (app?.lastRunDir) candidates.push(path.join(logsDir, path.basename(app.lastRunDir)));

  /**
   * Then every run, newest first. It used to be the newest FORTY entries of a directory that now
   * holds 789 — three of which are log files rather than runs — so any screenshot older than that
   * window was unreachable. That is why "lots of pages have no screenshot": not a missing file, a
   * search that stopped too early. A run directory is named for its timestamp; the existence check
   * is cheap and stops at the first hit.
   */
  const runs = (await fs.readdir(logsDir).catch(() => []))
    .filter((name) => /^\d{4}-\d{2}-\d{2}T/.test(name))
    .sort()
    .reverse();
  for (const r of runs) candidates.push(path.join(logsDir, r));

  for (const dir of candidates) {
    for (const kind of ["review", "debug"]) {
      const file = path.join(dir, `${kind}-${code}.png`);
      if (await fs.access(file).then(() => true, () => false)) return file;
    }
  }
  return null;
}

export interface RunSummary {
  dir: string;
  startedAt: string;
  outcomes: Record<string, number>;
  total: number;
}

/** Run history from logs/<run>/summary.json — the website's "what happened when". */
export async function getRuns(limit = 20): Promise<RunSummary[]> {
  const logsDir = path.join(ROOT, "logs");
  const dirs = (await fs.readdir(logsDir).catch(() => [])).sort().reverse().slice(0, limit);
  const out: RunSummary[] = [];
  for (const dir of dirs) {
    try {
      const raw = await fs.readFile(path.join(logsDir, dir, "summary.json"), "utf8");
      const items = JSON.parse(raw) as Array<{ outcome?: string }>;
      const outcomes: Record<string, number> = {};
      for (const i of items) outcomes[i.outcome ?? "unknown"] = (outcomes[i.outcome ?? "unknown"] ?? 0) + 1;
      out.push({ dir, startedAt: dir.replace(/-/g, ":").replace("T", " ").slice(0, 19), outcomes, total: items.length });
    } catch {
      /* a run still in flight has no summary yet */
    }
  }
  return out;
}

export interface IncomingJob {
  code?: string;
  company: string;
  title: string;
  location?: string;
  source?: string;
  age?: string;
  applyUrl: string;
  ats: string;
  /** Short state word, and the sentence that explains it. */
  state: string;
  meaning?: string;
  tone: string;
  href?: string;
}

/**
 * EVERY job we know about, from every source, and what became of each.
 *
 * The trackers in job_sites.txt produce ~600 listings into internships_summer2027.csv, and until
 * now NO page read that file: a posting became visible only once an application had been attempted
 * and a ledger record or queue entry existed. Jobs added by hand had their own table on /add, so
 * the two sources — which are the same kind of thing — were visible in completely different ways,
 * and "where do the new ones go?" had no answer.
 *
 * The state is derived, never stored: the ledger and the queue are the truth, a pending command
 * means a run is coming, and everything else is simply waiting for a sweep to reach it.
 */
export async function getIncoming(): Promise<IncomingJob[]> {
  ensureEnv();
  const [listed, apps, queue, waiting] = await Promise.all([
    loadInternshipList().catch(() => []),
    loadApplications(),
    loadPendingQueue(),
    pendingCommands().catch(() => []),
  ]);
  const byUrl = new Map<string, (typeof apps)[number]>();
  for (const a of apps) if (a.applyUrl) byUrl.set(normalizeUrl(a.applyUrl), a);
  const queueByUrl = new Map<string, (typeof queue)[number]>();
  for (const e of queue) if (e.applyUrl) queueByUrl.set(normalizeUrl(e.applyUrl), e);
  const commandFor = new Set(
    waiting.map((c) => ("code" in c ? c.code : undefined)).filter((c): c is string => Boolean(c)),
  );

  return listed.map((job) => {
    const key = job.applyUrl ? normalizeUrl(job.applyUrl) : "";
    const q = queueByUrl.get(key);
    const l = byUrl.get(key);
    const ats = detectAtsType(job.applyUrl ?? "");
    const code = q?.code ?? l?.code ?? job.id;
    const stage = q ? queueStage(q.status) : ledgerStage(l?.status);
    let state = stage?.label;
    let meaning = stage?.meaning;
    let tone = stage?.tone ?? "muted";
    let href = q ? `/queue/${code}` : l ? `/applications/${code}` : undefined;
    if (!state) {
      if (job.id && commandFor.has(job.id)) {
        state = "a run is queued";
        meaning = "A command is waiting for the worker; it will be opened shortly.";
        tone = "accent";
      } else if (ats === "unknown" || ats === "smartrecruiters") {
        state = "cannot be applied to";
        meaning =
          ats === "smartrecruiters"
            ? "SmartRecruiters sits behind DataDome, which serves a CAPTCHA to automation. It is counted, never opened."
            : "No driver for this ATS. It will never be opened, so it is not waiting for anything.";
        tone = "warn";
      } else {
        state = "waiting";
        meaning = "On the list, nothing attempted yet. A sweep will reach it.";
        tone = "muted";
      }
    }
    return {
      code,
      company: job.company,
      title: job.title,
      location: job.location,
      source: job.source,
      age: job.age,
      applyUrl: job.applyUrl,
      ats,
      state,
      meaning,
      tone,
      href,
    } satisfies IncomingJob;
  });
}

export interface WorkerHistoryRow {
  id: string;
  at: string;
  name: string;
  code?: string;
  ok?: boolean;
  message: string;
}

/**
 * What the worker has finished, newest first.
 *
 * Reads the completed COMMAND records - one per job it opened, each carrying the outcome the
 * worker reported. /runs used to read run directories for a summary.json that nothing writes any
 * more, so it showed "No completed runs yet" while the worker was busy all day.
 */
export async function getWorkerHistory(limit = 50): Promise<WorkerHistoryRow[]> {
  ensureEnv();
  const done = await recentCommands(limit).catch(() => []);
  return done
    .map((c) => {
      const any = c as Command & { code?: string; createdAt?: string; result?: { ok?: boolean; message?: string } };
      return {
        id: String(any.id ?? `${any.createdAt}-${any.name}`),
        at: String(any.createdAt ?? ""),
        name: String(any.name ?? ""),
        ...(any.code ? { code: String(any.code) } : {}),
        ...(typeof any.result?.ok === "boolean" ? { ok: any.result.ok } : {}),
        message: String(any.result?.message ?? "").slice(0, 400),
      } satisfies WorkerHistoryRow;
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

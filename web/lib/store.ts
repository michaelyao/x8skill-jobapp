import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { loadApplications } from "@core/knowledge/applications.js";
import { loadPendingQueue, type PendingEntry } from "@core/knowledge/approvalQueue.js";
import { pendingCommands, recentCommands } from "@core/knowledge/commands.js";
import { readWorkerStatus, isStale, type WorkerStatus } from "@core/knowledge/workerStatus.js";
import type { ApplicationRecord } from "@core/types.js";
import { ensureEnv } from "./env";

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
  };
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
 * Locate the screenshot for a job. `review-<CODE>.png` is the completed application;
 * `debug-<CODE>.png` is what a blocked run left behind. Newest run directory wins, because a
 * job can be re-run many times.
 */
export async function findScreenshot(code: string): Promise<string | null> {
  const app = await getApplication(code);
  const candidates: string[] = [];
  if (app?.lastRunDir) candidates.push(app.lastRunDir);

  const logsDir = path.join(ROOT, "logs");
  const runs = (await fs.readdir(logsDir).catch(() => [])).sort().reverse().slice(0, 40);
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

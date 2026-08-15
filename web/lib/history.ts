import "server-only";
import {
  diffAnswers,
  diffRounds,
  listJobsWithRounds,
  listRounds,
  type AnswerDiff,
  type Round,
  type RoundDiff,
} from "@core/knowledge/rounds.js";
import { loadPendingQueue } from "@core/knowledge/approvalQueue.js";
import { loadApplications } from "@core/knowledge/applications.js";
import { ensureEnv } from "./env";

/**
 * Transaction history: every recorded copy of an application, and what changed between
 * consecutive copies.
 *
 * The point is that "what changed" is never my summary of events — it is computed here from
 * two stored snapshots the user can open and read for themselves.
 */

export interface HistoryEntry {
  code: string;
  company: string;
  title: string;
  applyUrl: string;
  status: string;
  rounds: number;
  first: string;
  last: string;
  /** Did anything change across the whole history — the flag that makes a row worth opening. */
  formChanges: number;
  answerChanges: number;
}

export interface RoundStep {
  round: Round;
  /** Change from the PREVIOUS round; absent on the first. */
  form?: RoundDiff;
  answers?: AnswerDiff;
}

export async function getHistoryIndex(): Promise<HistoryEntry[]> {
  ensureEnv();
  const [jobs, queue, applications] = await Promise.all([
    listJobsWithRounds(),
    loadPendingQueue().catch(() => []),
    loadApplications().catch(() => []),
  ]);

  const entries: HistoryEntry[] = [];
  for (const job of jobs) {
    const rounds = await listRounds(job.code);
    if (!rounds.length) continue;

    let formChanges = 0;
    let answerChanges = 0;
    for (let i = 1; i < rounds.length; i += 1) {
      const f = diffRounds(rounds[i - 1], rounds[i]);
      formChanges += f.added.length + f.removed.length + f.requiredChanged.length;
      const a = diffAnswers(rounds[i - 1], rounds[i]);
      answerChanges += a.changed.length + a.added.length + a.removed.length;
    }

    const pending = queue.find((e) => e.code === job.code);
    const record = applications.find((r) => r.code === job.code);
    entries.push({
      code: job.code,
      company: pending?.company ?? record?.company ?? "—",
      title: pending?.title ?? record?.title ?? "—",
      applyUrl: pending?.applyUrl ?? record?.applyUrl ?? rounds[rounds.length - 1].url,
      status: pending?.status ?? record?.status ?? "—",
      rounds: rounds.length,
      first: rounds[0].at,
      last: rounds[rounds.length - 1].at,
      formChanges,
      answerChanges,
    });
  }
  return entries.sort((a, b) => b.last.localeCompare(a.last));
}

/** Every round for one job, each annotated with what changed since the one before it. */
export async function getHistory(code: string): Promise<RoundStep[]> {
  ensureEnv();
  const rounds = await listRounds(code);
  return rounds.map((round, i) => ({
    round,
    form: i > 0 ? diffRounds(rounds[i - 1], round) : undefined,
    answers: i > 0 ? diffAnswers(rounds[i - 1], round) : undefined,
  }));
}

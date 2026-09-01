import { browserLockHolder, getDecisions, getOverview } from "@/lib/store";
import { draftCount } from "@/lib/stats";
import { WorkerBar } from "@/components/WorkerBar";
import { splitQueue, type QueueSplit, type Readiness } from "@core/core/queueReadiness.js";
import { readProfileSnapshot } from "@core/knowledge/profile.js";
import { classifyRoleTerm } from "@core/core/roleTerm.js";

export const dynamic = "force-dynamic";

/**
 * The decisions page — and ONLY the decisions.
 *
 * Everything the system will move on its own (a submit in flight, a queued re-fill, an application
 * that reached Review with something missing) now lives on /status. It used to share this page, and
 * each of those arrived beside an Approve button — approving a copy that is being re-filled sends
 * answers that are being rewritten as you read them. The split is by "is a human the next step",
 * not by status.
 *
 * What stays here needs a person and nothing else can resolve it: a finished application to approve,
 * one that gave up after three failed submits, and one stuck mid-submit that must be checked on the
 * ATS before anything else happens to it.
 */
export default async function QueuePage() {
  const { queue, worker, pendingCommandCount } = await getOverview();
  const decisions = await getDecisions();
  const withWorker = (code?: string) => {
    const d = decisions.get(code ?? "");
    return Boolean(d?.working || d?.pending);
  };
  /**
   * "Awaiting approval" was doing two jobs: an application that is FINISHED and waiting on you,
   * and one that reached review with something missing. Both showed here as though a decision was
   * all they needed — which is how an application with eleven unanswered required fields sat in
   * this list looking reviewable.
   *
   * splitQueue applies the same guardrail submitApprovedEntry will apply, so this list and that
   * refusal cannot disagree. Read-only: it computes a verdict, it does not write one.
   */
  const profileSnapshot = await readProfileSnapshot();
  const split = profileSnapshot
    ? splitQueue(queue.filter((e) => e.status === "awaiting_approval"), profileSnapshot)
    : ({
        ready: queue
          .filter((e) => e.status === "awaiting_approval")
          .map((entry): Readiness => ({ entry, problems: [] })),
        needsWork: [] as Readiness[],
      } satisfies QueueSplit);
  const readyKeys = new Set(split.ready.map((r) => r.entry.key));
  // Counted, not listed: they belong on /status, but a page that silently drops them would read as
  // "there is nothing else", which is the opposite of true.
  const elsewhere =
    split.needsWork.filter((r) => !withWorker(r.entry.code ?? r.entry.key)).length +
    queue.filter((e) => e.status === "awaiting_approval" && withWorker(e.code ?? e.key)).length;
  // "Why can I approve this again?" — because the submit failed and nothing was sent. That is
  // correct behaviour (only a genuine "nothing was submitted" outcome resets an entry), but the
  // page gave no sign of it, so a job approved on 19 Aug looked brand new.
  const priorApproval = new Map(
    [...split.ready, ...split.needsWork]
      .filter((r) => r.previouslyApproved)
      .map((r) => [r.entry.key, r.previouslyApproved!]),
  );

  /**
   * An entry with a re-fill ALREADY QUEUED is not a decision either: the copy on screen is about to
   * be replaced, so approving it would send answers that are being rewritten as you look at them.
   * It showed here with a "retry queued" badge and an Approve button, which is a footgun.
   */
  const awaiting = queue
    .filter((e) => e.status === "awaiting_approval" && readyKeys.has(e.key) && !withWorker(e.code ?? e.key))
    .sort((a, b) => (b.reviewSentAt ?? "").localeCompare(a.reviewSentAt ?? ""));

  // "submitting" means two very different things, and conflating them is alarming: a submit
  // running RIGHT NOW, or one whose outcome was never recorded because the process died.
  // The worker's heartbeat is what tells them apart — the live one is progress and shows on
  // /status; only the abandoned one needs a person, so only it stays here.
  // A job that failed three submit attempts is parked as "error". It is not in the awaiting list,
  // and /blocked skips anything that has a queue entry — so it was visible on neither page. It
  // needs you more than anything else here.
  const gaveUp = queue.filter((e) => e.status === "error");
  const submitting = queue.filter((e) => e.status === "submitting");
  // Two liveness signals, because the heartbeat alone is not enough: it can freeze while the
  // worker is inside a long submit, and a frozen heartbeat would make a live submission look
  // abandoned. A held browser lock whose owner is still running proves a session is open.
  const lockHolder = await browserLockHolder();
  const workerLive = (!worker.stale || lockHolder !== null) && worker.status?.state === "busy";
  const abandoned = submitting.filter((e) => !(workerLive && worker.status?.code === e.code));

  return (
    <>
      <h1>Queue</h1>
      <p className="sub">
        {awaiting.length} ready for your review. Nothing is submitted until you approve it — and a
        job you approved that then failed comes back here as a new copy needing a fresh look.
        {elsewhere ? (
          <>
            {" "}
            {elsewhere} more are still being worked on — see <a href="/status">Status</a>.
          </>
        ) : null}
      </p>

      <WorkerBar initial={worker} pendingCommands={pendingCommandCount} />

      {gaveUp.length ? (
        <div className="card" style={{ borderColor: "var(--bad)", marginTop: 14 }}>
          <h3 style={{ color: "var(--bad)" }}>Gave up after repeated attempts</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Approved, but the submit failed three times, so it stopped trying. Nothing was submitted.
            Re-fill it to get a fresh copy, then approve that.
          </p>
          {gaveUp.map((e) => (
            <div key={e.key} style={{ paddingBottom: 8 }}>
              <span className="code">{e.code}</span> — {e.company} · {e.title}{" "}
              <a href={`/queue/${e.code}`}>review</a> ·{" "}
              <a href={e.applyUrl} target="_blank" rel="noreferrer">
                open posting
              </a>
              {e.lastError ? (
                <div className="muted" style={{ fontSize: 12 }}>
                  {e.lastError.length > 130 ? `${e.lastError.slice(0, 129)}…` : e.lastError}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {abandoned.length ? (
        <div className="card" style={{ borderColor: "var(--bad)", marginTop: 14 }}>
          <h3 style={{ color: "var(--bad)" }}>Stuck mid-submit — confirm on the ATS</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            A submit was clicked but the outcome was never recorded, and the worker is not working on it now.
            These are never retried automatically — check the posting before approving again.
          </p>
          {abandoned.map((e) => (
            <div key={e.key} className="code">
              {e.code} — {e.company} ·{" "}
              <a href={e.applyUrl} target="_blank" rel="noreferrer">
                open posting
              </a>
            </div>
          ))}
        </div>
      ) : null}

      {awaiting.length === 0 ? (
        <p className="empty" style={{ marginTop: 14 }}>Nothing waiting on you.</p>
      ) : (
        <div className="card" style={{ padding: 0, marginTop: 14 }}>
          <table>
            <thead>
              <tr>
                <th>Code</th><th>Company</th><th>Role</th><th>Decision</th><th>Answers</th><th className="right">Filled</th>
              </tr>
            </thead>
            <tbody>
              {awaiting.map((e) => {
                const drafts = draftCount(e);
                const d = decisions.get(e.code ?? e.key) ?? {};
                return (
                  <tr key={e.key} className="clickable">
                    <td className="code"><a href={`/queue/${e.code}`}>{e.code}</a></td>
                    <td>{e.company}</td>
                    <td>
                      <a href={`/queue/${e.code}`}>{e.title}</a>
                      {/* Not the summer internship — a co-op or new-grad role is a different
                          decision, and seeing it here saves opening the page to find out. */}
                      {classifyRoleTerm(e.title ?? "").needsAThought ? (
                        <span className="pill warn" style={{ marginLeft: 6, fontSize: 11 }}>
                          {classifyRoleTerm(e.title ?? "").term.replace(/-/g, " ")}
                        </span>
                      ) : null}
                      {e.lastError ? (
                        <div className="muted" style={{ fontSize: 12 }}>
                          last attempt: {e.lastError.length > 90 ? `${e.lastError.slice(0, 89)}…` : e.lastError}
                        </div>
                      ) : null}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {e.reapproval ? (
                        <span className="pill warn">held — form changed</span>
                      ) : d.superseded ? (
                        <>
                          <span className="pill warn">re-filled since you decided</span>
                          <div className="muted" style={{ marginTop: 3 }}>
                            you {d.decidedBy ? `(${d.decidedBy}) ` : ""}approved the {d.decidedAt!.slice(0, 10)} copy
                          </div>
                        </>
                      ) : d.decidedAt ? (
                        /**
                         * A green "approved" pill on an item sitting in the APPROVAL queue reads as
                         * a contradiction — which is what it looked like on TXWZQB: approved on
                         * 19 Aug, still here, still approvable. The behaviour is right (the submit
                         * failed, nothing was sent, and only a genuine "nothing was submitted"
                         * outcome resets an entry) but the page never said so. Say it.
                         */
                        <>
                          <span className="pill warn">approved {d.decidedAt.slice(0, 10)} — not sent</span>
                          <div className="muted" style={{ marginTop: 3 }}>
                            the submit failed, so nothing was submitted; it needs a fresh approval
                            {priorApproval.get(e.key)?.failure
                              ? ` — ${priorApproval.get(e.key)!.failure!.slice(0, 70)}`
                              : ""}
                          </div>
                        </>
                      ) : (
                        <span className="muted">not decided</span>
                      )}
                    </td>
                    <td>
                      {(e.answers ?? []).length}
                      {drafts ? <span className="pill warn" style={{ marginLeft: 6 }}>{drafts} draft</span> : null}
                    </td>
                    <td className="right muted nowrap">{(e.reviewSentAt ?? "").slice(0, 16).replace("T", " ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

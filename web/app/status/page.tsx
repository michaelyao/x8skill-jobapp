import { browserLockHolder, getDecisions, getOverview } from "@/lib/store";
import { WorkerBar } from "@/components/WorkerBar";
import { splitQueue } from "@core/core/queueReadiness.js";
import { readProfileSnapshot } from "@core/knowledge/profile.js";

export const dynamic = "force-dynamic";

/**
 * Applications in motion — nothing here is waiting on a decision.
 *
 * /queue is for the one job a person actually has: read a finished application and approve, edit or
 * skip it. Everything else was sharing that page — a submit in flight, a re-fill queued, an
 * application that reached Review with something missing — and each one arrived with an Approve
 * button beside it. That is worse than clutter: approving a copy that is being re-filled sends
 * answers that are being rewritten as you read them.
 *
 * So the split is by "is a human the next step", not by status. Anything the system will move on its
 * own belongs here, where the only question is whether it is progressing.
 */
export default async function StatusPage() {
  const { queue, worker, pendingCommandCount } = await getOverview();
  const decisions = await getDecisions();
  const busy = (code?: string) => {
    const d = decisions.get(code ?? "");
    return Boolean(d?.working || d?.pending);
  };

  const profile = await readProfileSnapshot();
  const awaiting = queue.filter((e) => e.status === "awaiting_approval");
  const split = profile ? splitQueue(awaiting, profile) : { ready: [], needsWork: [] };

  const beingRefilled = awaiting.filter((e) => busy(e.code ?? e.key));
  const notReady = split.needsWork.filter((r) => !busy(r.entry.code ?? r.entry.key));

  // Two very different things wear the same status, and the worker's heartbeat is what separates
  // them: a submit running right now, or one whose outcome was never recorded because the process
  // died. Only the second needs a person, and it stays on /queue.
  const lockHolder = await browserLockHolder();
  const workerLive = (!worker.stale || lockHolder !== null) && worker.status?.state === "busy";
  const inFlight = queue.filter((e) => e.status === "submitting" && workerLive && worker.status?.code === e.code);

  const nothing = !inFlight.length && !beingRefilled.length && !notReady.length;

  return (
    <>
      <h1>Status</h1>
      <p className="sub">
        {inFlight.length + beingRefilled.length + notReady.length} application(s) the system is still
        working on. Nothing here needs you — anything waiting on a decision is on{" "}
        <a href="/queue">Queue</a>.
      </p>

      <WorkerBar initial={worker} pendingCommands={pendingCommandCount} />

      {nothing ? <p className="empty">Nothing in motion.</p> : null}

      {inFlight.length ? (
        <div className="card" style={{ borderColor: "var(--accent)", marginTop: 14 }}>
          <h3 style={{ color: "var(--accent)" }}>Submitting now — {inFlight.length}</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            The worker is filling and submitting these. It takes a few minutes each.
          </p>
          {inFlight.map((e) => (
            <div key={e.key} className="code" style={{ paddingBottom: 4 }}>
              {e.code} — {e.company} · {e.title}
            </div>
          ))}
        </div>
      ) : null}

      {beingRefilled.length ? (
        <div className="card" style={{ marginTop: 14 }}>
          <h3>Being re-filled — {beingRefilled.length}</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            A re-fill is queued or running, so the current copy is about to be replaced. They move to
            Queue once the new copy passes its checks.
          </p>
          {beingRefilled.map((e) => (
            <div key={e.key} style={{ paddingBottom: 4 }}>
              <span className="code">
                <a href={`/queue/${e.code}`}>{e.code}</a>
              </span>{" "}
              — {e.company} · {e.title}
            </div>
          ))}
        </div>
      ) : null}

      {notReady.length ? (
        <div className="card" style={{ marginTop: 14 }}>
          <h3>Reached review, but incomplete — {notReady.length}</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Something is missing or wrong in these, so they are not a decision waiting on you —
            approving one would be refused at submit for the reason shown. Re-fill with{" "}
            <span className="code">./bin/jobapp retry CODE</span>.
          </p>
          {notReady.map(({ entry, problems }) => (
            <div key={entry.key} style={{ paddingBottom: 10 }}>
              <span className="code">
                <a href={`/queue/${entry.code}`}>{entry.code}</a>
              </span>{" "}
              — {entry.company} · {entry.title}{" "}
              <a href={entry.applyUrl} target="_blank" rel="noreferrer">
                open posting
              </a>
              <ul className="muted" style={{ fontSize: 12, margin: "4px 0 0 0", paddingLeft: 18 }}>
                {problems.slice(0, 3).map((p) => (
                  <li key={p}>{p.length > 150 ? `${p.slice(0, 149)}…` : p}</li>
                ))}
                {problems.length > 3 ? <li>+{problems.length - 3} more</li> : null}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

import { browserLockHolder, getOverview } from "@/lib/store";
import { draftCount } from "@/lib/stats";
import { WorkerBar } from "@/components/WorkerBar";

export const dynamic = "force-dynamic";

export default async function QueuePage() {
  const { queue, worker, pendingCommandCount } = await getOverview();
  const awaiting = queue
    .filter((e) => e.status === "awaiting_approval")
    .sort((a, b) => (b.reviewSentAt ?? "").localeCompare(a.reviewSentAt ?? ""));

  // "submitting" means two very different things, and conflating them is alarming: a submit
  // running RIGHT NOW, or one whose outcome was never recorded because the process died.
  // The worker's heartbeat is what tells them apart — if it is alive and working on this
  // exact code, the job is in flight, not abandoned.
  const submitting = queue.filter((e) => e.status === "submitting");
  // Two liveness signals, because the heartbeat alone is not enough: it can freeze while the
  // worker is inside a long submit, and a frozen heartbeat would make a live submission look
  // abandoned. A held browser lock whose owner is still running proves a session is open.
  const lockHolder = await browserLockHolder();
  const workerLive = (!worker.stale || lockHolder !== null) && worker.status?.state === "busy";
  const inFlight = submitting.filter((e) => workerLive && worker.status?.code === e.code);
  const abandoned = submitting.filter((e) => !inFlight.includes(e));

  return (
    <>
      <h1>Queue</h1>
      <p className="sub">
        {awaiting.length} application{awaiting.length === 1 ? "" : "s"} filled and waiting on you. Nothing is submitted until you approve it.
      </p>

      <WorkerBar initial={worker} pendingCommands={pendingCommandCount} />

      {inFlight.length ? (
        <div className="card" style={{ borderColor: "var(--accent)", marginTop: 14 }}>
          <h3 style={{ color: "var(--accent)" }}>Submitting now</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            The worker is filling and submitting this application. It takes a few minutes — this page updates itself when it finishes.
          </p>
          {inFlight.map((e) => (
            <div key={e.key} className="code">
              <span className="pill accent">in progress</span> {e.code} — {e.company} · {e.title}
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
                <th>Code</th><th>Company</th><th>Role</th><th>ATS</th><th>Answers</th><th className="right">Filled</th>
              </tr>
            </thead>
            <tbody>
              {awaiting.map((e) => {
                const drafts = draftCount(e);
                return (
                  <tr key={e.key} className="clickable">
                    <td className="code"><a href={`/queue/${e.code}`}>{e.code}</a></td>
                    <td>{e.company}</td>
                    <td><a href={`/queue/${e.code}`}>{e.title}</a></td>
                    <td><span className="pill">{e.ats}</span></td>
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

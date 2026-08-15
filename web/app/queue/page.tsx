import { getOverview } from "@/lib/store";
import { draftCount } from "@/lib/stats";

export const dynamic = "force-dynamic";

export default async function QueuePage() {
  const { queue } = await getOverview();
  const awaiting = queue
    .filter((e) => e.status === "awaiting_approval")
    .sort((a, b) => (b.reviewSentAt ?? "").localeCompare(a.reviewSentAt ?? ""));
  const stuck = queue.filter((e) => e.status === "submitting");

  return (
    <>
      <h1>Queue</h1>
      <p className="sub">{awaiting.length} application{awaiting.length === 1 ? "" : "s"} filled and waiting on you. Nothing is submitted until you approve it.</p>

      {stuck.length ? (
        <div className="card" style={{ borderColor: "var(--bad)", marginBottom: 14 }}>
          <h3 style={{ color: "var(--bad)" }}>Stuck mid-submit — confirm on the ATS</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            A submit was clicked but the outcome was never recorded. These are never retried automatically.
          </p>
          {stuck.map((e) => (
            <div key={e.key} className="code">{e.code} — {e.company} · <a href={e.applyUrl} target="_blank" rel="noreferrer">open posting</a></div>
          ))}
        </div>
      ) : null}

      {awaiting.length === 0 ? (
        <p className="empty">Nothing waiting. Start a sweep to fill more jobs.</p>
      ) : (
        <div className="card" style={{ padding: 0 }}>
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

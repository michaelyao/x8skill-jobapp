import { getRuns } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const runs = await getRuns(25);
  return (
    <>
      <h1>Runs</h1>
      <p className="sub">What each fill run did, newest first.</p>
      {runs.length === 0 ? (
        <p className="empty">No completed runs yet.</p>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead><tr><th>Started</th><th>Jobs</th><th>Outcomes</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.dir}>
                  <td className="nowrap code">{r.startedAt}</td>
                  <td>{r.total}</td>
                  <td>
                    {Object.entries(r.outcomes).map(([k, v]) => (
                      <span key={k} className={`pill ${k === "submitted" ? "good" : k === "error" ? "bad" : ""}`} style={{ marginRight: 6 }}>
                        {k} {v}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

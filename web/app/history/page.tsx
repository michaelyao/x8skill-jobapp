import { getHistoryIndex } from "@/lib/history";

export const dynamic = "force-dynamic";

const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

export default async function HistoryPage() {
  const entries = await getHistoryIndex();
  const withChanges = entries.filter((e) => e.formChanges || e.answerChanges);

  return (
    <>
      <h1>History</h1>
      <p className="sub">
        Every copy of every application, as it was read from the ATS. Kept so &ldquo;did the form change?&rdquo;
        is something you can check, not something you have to take my word for.
      </p>

      {entries.length === 0 ? (
        <p className="empty" style={{ marginTop: 14 }}>
          No history recorded yet. A copy is saved each time a job is filled, re-filled or submitted.
        </p>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 13 }}>
            {entries.length} job{entries.length === 1 ? "" : "s"} ·{" "}
            {entries.reduce((n, e) => n + e.rounds, 0)} recorded copies ·{" "}
            {withChanges.length} with differences between copies.
          </p>

          <div className="card" style={{ padding: 0, marginTop: 14 }}>
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Company</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th className="right">Copies</th>
                  <th>Changed</th>
                  <th className="right">Latest</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.code} className="clickable">
                    <td className="code">
                      <a href={`/history/${e.code}`}>{e.code}</a>
                    </td>
                    <td>{e.company}</td>
                    <td>
                      <a href={`/history/${e.code}`}>{e.title}</a>
                    </td>
                    <td>
                      <span className="pill">{e.status}</span>
                    </td>
                    <td className="right">{e.rounds}</td>
                    <td>
                      {e.formChanges ? (
                        <span className="pill warn">{e.formChanges} form</span>
                      ) : null}{" "}
                      {e.answerChanges ? (
                        <span className="pill">{e.answerChanges} answers</span>
                      ) : null}
                      {!e.formChanges && !e.answerChanges ? (
                        <span className="muted">identical</span>
                      ) : null}
                    </td>
                    <td className="right muted nowrap">{when(e.last)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

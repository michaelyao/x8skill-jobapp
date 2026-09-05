import { getWorkerHistory } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * WHAT THE WORKER HAS ACTUALLY DONE, newest first.
 *
 * This page listed run DIRECTORIES that contain a summary.json - an artefact the retired batch
 * path used to write and nothing has written since. 1,220 run directories on disk, 86 with a
 * summary, all of them old, so the page read "No completed runs yet" while the worker had been
 * working all day. The candidate asked twice where to see what it is doing.
 *
 * The worker's real record is its finished COMMANDS: one per job it opened, each with the outcome
 * it reported. 1,613 of them, and they are what this shows now.
 */
export default async function RunsPage() {
  const history = await getWorkerHistory(60);
  const failed = history.filter((h) => h.ok === false).length;

  return (
    <>
      <h1>Runs</h1>
      <p className="sub">
        Every job the worker has opened, newest first — what it was asked to do, and what it
        reported. {history.length} shown, {failed} of them unsuccessful. Anything still WAITING to
        run is behind the &ldquo;queued&rdquo; button on <a href="/queue">Queue</a>.
      </p>
      {history.length === 0 ? (
        <p className="empty">The worker has not finished anything yet.</p>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Asked to</th>
                  <th>Job</th>
                  <th>Result</th>
                  <th>What it said</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="muted nowrap">{h.at.slice(0, 16).replace("T", " ")}</td>
                    <td className="nowrap">{h.name}</td>
                    <td className="code nowrap">
                      {h.code ? <a href={`/queue/${h.code}`}>{h.code}</a> : <span className="muted">—</span>}
                    </td>
                    <td className="nowrap">
                      <span className={`pill ${h.ok === false ? "bad" : h.ok ? "good" : ""}`} style={{ fontSize: 12 }}>
                        {h.ok === false ? "failed" : h.ok ? "ok" : "—"}
                      </span>
                    </td>
                    <td style={{ maxWidth: 560 }}>{h.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

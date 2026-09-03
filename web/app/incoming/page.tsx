import { getIncoming } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Every posting from every source, and what became of it.
 *
 * The trackers and the postings added by hand are THE SAME KIND OF THING — a source — so they
 * belong on one page. Before this, ~600 tracker listings were visible nowhere until an application
 * had been attempted, while the handful added by hand had their own table; "where do the new ones
 * go?" had no answer.
 */
export default async function IncomingPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; source?: string }>;
}) {
  const { state, source } = await searchParams;
  const all = await getIncoming();

  const states = [...new Set(all.map((j) => j.state))].sort();
  const sources = [...new Set(all.map((j) => j.source ?? "—"))].sort();
  const rows = all
    .filter((j) => (state ? j.state === state : true))
    .filter((j) => (source ? (j.source ?? "—") === source : true));

  const count = (k: string) => all.filter((j) => j.state === k).length;

  return (
    <>
      <h1>Jobs found</h1>
      <p className="sub">
        Everything the trackers in job_sites.txt carry, plus everything you added by hand — one list,
        because they are the same kind of thing. {all.length} postings.
      </p>

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <a href="/incoming" className={`pill${!state && !source ? " accent" : ""}`}>
            all {all.length}
          </a>
          {states.map((s) => (
            <a key={s} href={`/incoming?state=${encodeURIComponent(s)}`} className={`pill${state === s ? " accent" : ""}`}>
              {s} {count(s)}
            </a>
          ))}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, alignItems: "center" }}>
          <span className="muted" style={{ fontSize: 12 }}>source:</span>
          {sources.map((s) => (
            <a
              key={s}
              href={`/incoming?source=${encodeURIComponent(s)}${state ? `&state=${encodeURIComponent(state)}` : ""}`}
              className={`pill${source === s ? " accent" : ""}`}
            >
              {s === "you" ? "you (added by hand)" : s}
            </a>
          ))}
        </div>
      </div>

      <p className="sub">{rows.length} shown.</p>
      {rows.length === 0 ? (
        <p className="empty">Nothing matches that.</p>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Company</th>
                  <th>Role</th>
                  <th>ATS</th>
                  <th>What became of it</th>
                  <th>Source</th>
                  <th className="right">Posted</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 400).map((j) => (
                  <tr key={`${j.code ?? ""}-${j.applyUrl}`}>
                    <td className="code">
                      {j.href ? <a href={j.href}>{j.code}</a> : <span>{j.code ?? "—"}</span>}
                    </td>
                    <td>{j.company}</td>
                    <td style={{ maxWidth: 320 }}>
                      <a href={j.applyUrl} target="_blank" rel="noreferrer">
                        {j.title || "(untitled)"}
                      </a>
                    </td>
                    <td className="muted nowrap">{j.ats}</td>
                    <td>
                      <span className={`pill ${j.tone}`} style={{ fontSize: 12 }}>
                        {j.state}
                      </span>
                      {j.meaning ? (
                        <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                          {j.meaning}
                        </div>
                      ) : null}
                    </td>
                    <td className="muted nowrap">{j.source ?? "—"}</td>
                    <td className="right muted nowrap">{j.age ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {rows.length > 400 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          Showing the first 400 of {rows.length}. Narrow it with the filters above — a silent
          truncation would read as "that is all of them".
        </p>
      ) : null}
    </>
  );
}

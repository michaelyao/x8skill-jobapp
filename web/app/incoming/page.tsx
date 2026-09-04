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
  searchParams: Promise<{ state?: string | string[]; source?: string | string[]; q?: string }>;
}) {
  const { state, source, q } = await searchParams;
  const all = await getIncoming();

  const states = [...new Set(all.map((j) => j.state))].sort();
  const sources = [...new Set(all.map((j) => j.source ?? "—"))].sort();
  /**
   * FIND ONE JOB. Six hundred rows and no search is "scroll until you see it" — the question
   * "where is ANTRMA?" had no answer on any page. Matches the code, the company or the role, so
   * a code from a log line and a company name from an email both land.
   */
  const needle = (q ?? "").trim().toLowerCase();
  /**
   * TICK WHAT YOU WANT TO SEE.
   *
   * These were single-select links: one state, one source, and choosing a second replaced the
   * first. "Show me everything still to come" is two states — never attempted AND failed-will-be-
   * retried — so the one question the page exists to answer could not be asked. Repeated query
   * parameters (state=a&state=b) come back as an array, and NOTHING ticked means everything, so a
   * bare /incoming still shows the whole list.
   */
  const asSet = (v?: string | string[]) =>
    new Set((Array.isArray(v) ? v : v ? [v] : []).filter(Boolean));
  const wantStates = asSet(state);
  const wantSources = asSet(source);
  const rows = all
    .filter((j) => (wantStates.size ? wantStates.has(j.state) : true))
    .filter((j) => (wantSources.size ? wantSources.has(j.source ?? "—") : true))
    .filter((j) =>
      !needle
        ? true
        : `${j.code ?? ""} ${j.company} ${j.title} ${j.applyUrl}`.toLowerCase().includes(needle),
    );

  const count = (k: string) => all.filter((j) => j.state === k).length;
  // The backlog: nothing attempted yet, plus the failures the ledger deliberately keeps retryable.
  const stillToCome = count("waiting") + count("failed — will be retried");

  return (
    <>
      <h1>Jobs found</h1>
      <p className="sub">
        Everything the trackers in job_sites.txt carry, plus everything you added by hand — one list,
        because they are the same kind of thing. {all.length} postings.
      </p>

      {/*
        HOW MANY ARE STILL TO COME. The per-state counts below have always been here, but nothing
        added up the ones a sweep will still reach — so "how many are left?" could only be answered
        from a sweep's own log line, which is not a place anybody should have to look. Two states
        make up the backlog: never attempted, and attempted-and-failed, which the ledger keeps
        retryable on purpose.
      */}
      <p className="sub" style={{ marginTop: -6 }}>
        <strong>{stillToCome}</strong> of them are still to come — {count("waiting")} never attempted
        and {count("failed — will be retried")} that failed and are queued to be tried again. A sweep
        takes them in batches, newest first.
      </p>

      <form className="card" style={{ marginBottom: 14 }} action="/incoming" method="get">
        <label htmlFor="q" style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>
          Find a job — by code, company, role or URL
        </label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            id="q"
            name="q"
            defaultValue={q ?? ""}
            placeholder="ANTRMA, or Universal Health, or uhsinc.com"
            style={{ flex: "1 1 320px", minWidth: 220 }}
          />
          <button className="primary" type="submit">Search</button>
          {q || wantStates.size || wantSources.size ? (
            <a className="pill" href="/incoming">clear all</a>
          ) : null}
        </div>
        {q ? (
          <p className="muted" style={{ marginBottom: 0, marginTop: 8, fontSize: 13 }}>
            {rows.length} match{rows.length === 1 ? "" : "es"} for {JSON.stringify(q)}.
          </p>
        ) : null}

        <fieldset style={{ border: 0, padding: 0, margin: "14px 0 0" }}>
          <legend style={{ fontWeight: 600, padding: 0, marginBottom: 6 }}>
            What became of it{" "}
            <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
              — tick any; none ticked shows all
            </span>
          </legend>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
            {states.map((sName) => (
              <label key={sName} style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400 }}>
                <input type="checkbox" name="state" value={sName} defaultChecked={wantStates.has(sName)} />
                <span>
                  {sName} <span className="muted">{count(sName)}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset style={{ border: 0, padding: 0, margin: "12px 0 0" }}>
          <legend style={{ fontWeight: 600, padding: 0, marginBottom: 6 }}>Source</legend>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
            {sources.map((sName) => (
              <label key={sName} style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400 }}>
                <input type="checkbox" name="source" value={sName} defaultChecked={wantSources.has(sName)} />
                <span>
                  {sName === "you" ? "you (added by hand)" : sName}{" "}
                  <span className="muted">{all.filter((j) => (j.source ?? "—") === sName).length}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button className="primary" type="submit">Show these</button>
          {/* The page's own question, one click: everything a sweep will still reach. */}
          <a
            className="pill"
            href={`/incoming?state=${encodeURIComponent("waiting")}&state=${encodeURIComponent("failed — will be retried")}`}
          >
            still to come ({stillToCome})
          </a>
        </div>
      </form>

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
                  {/* An explicit way OUT to the posting. The role title has always linked there,
                      but nothing said so: the candidate looked at 175 "cannot be applied to" rows
                      and asked why there was no link to open any of them. A link nobody can find
                      is not a link. */}
                  <th className="right">Open</th>
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
                    <td className="right nowrap">
                      {j.applyUrl ? (
                        <a href={j.applyUrl} target="_blank" rel="noreferrer" title={j.applyUrl}>
                          posting ↗
                        </a>
                      ) : (
                        <span className="muted">—</span>
                      )}
                      {j.href ? (
                        <>
                          {" · "}
                          <a href={j.href}>ours</a>
                        </>
                      ) : null}
                    </td>
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

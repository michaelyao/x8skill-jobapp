import type { SiblingApplication } from "@/lib/store";
import { SkipRowButton } from "@/components/SkipRowButton";
import { ledgerStage, queueStage } from "@core/core/statusVocabulary.js";

/**
 * Every application at this employer, so a decision about one is made knowing the others.
 *
 * Reviewing one application at a time, there is no way to tell a SECOND OPENING from a second
 * application to the same opening. Chicago Trading Company runs two Greenhouse boards and posts
 * "Software Engineer Intern" on both; The Nuclear Company had four roles live at once. The
 * candidate could only answer that question from confirmation emails, after the fact.
 *
 * The job id is the column that settles it: two rows sharing one are the same posting twice, and
 * that is the case to stop. Different ids are different jobs, however alike the titles read.
 */
export function SiblingApplications({ rows }: { rows: SiblingApplication[] }) {
  if (!rows.length) return null;
  const company = rows.length;
  // Two rows with the same job id are the same posting — the thing worth shouting about.
  const seen = new Map<string, number>();
  for (const r of rows) if (r.jobId) seen.set(r.jobId, (seen.get(r.jobId) ?? 0) + 1);
  const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);

  return (
    <div className="card" style={{ marginBottom: 14, borderColor: duplicated.length ? "var(--bad)" : undefined }}>
      <h3 style={{ marginTop: 0 }}>
        {company} applications at this employer
        {duplicated.length ? (
          <span className="pill bad" style={{ marginLeft: 8, fontSize: 12 }}>
            same posting more than once
          </span>
        ) : null}
      </h3>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Different job ids are different openings, however alike the titles look. The same id twice is
        the same posting — check before approving.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Role</th>
              <th>Job id</th>
              <th>Recorded</th>
              <th>In the queue</th>
              <th className="right">Last touched</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code} style={r.isThisOne ? { fontWeight: 600 } : undefined}>
                <td className="code">
                  {r.isThisOne ? r.code : <a href={`/queue/${r.code}`}>{r.code}</a>}
                  {r.isThisOne ? <span className="muted" style={{ fontWeight: 400 }}> · this one</span> : null}
                </td>
                <td>
                  <a href={r.applyUrl} target="_blank" rel="noreferrer">
                    {r.title || "(untitled)"}
                  </a>
                </td>
                <td className="code" style={duplicated.includes(r.jobId ?? "") ? { color: "var(--bad)" } : undefined}>
                  {r.jobId ?? "—"}
                </td>
                <td>{ledgerStage(r.ledgerStatus)?.label ?? r.ledgerStatus ?? "—"}</td>
                <td>{queueStage(r.queueStatus)?.label ?? r.queueStatus ?? "—"}</td>
                <td className="right muted nowrap">{(r.at ?? "").slice(0, 16).replace("T", " ")}</td>
                <td className="right">
                  {/*
                    Only a row still waiting on a decision can be skipped, and never THIS one — the
                    review panel below already has its own Skip, and two buttons for one action on
                    one page is how the wrong row gets clicked.
                  */}
                  {!r.isThisOne && r.queueStatus === "awaiting_approval" ? (
                    <SkipRowButton code={r.code} title={r.title} />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

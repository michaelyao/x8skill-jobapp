import { notFound } from "next/navigation";
import { fetchStoredJobDescription, loadX8NoteConfig } from "@core/knowledge/x8note.js";
import { listRounds } from "@core/knowledge/rounds.js";
import { getApplication, getQueueEntry } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * The page for ONE application, whatever state it is in.
 *
 * /queue/[code] only exists while a job is awaiting a decision, so every row on /applications used
 * to link straight out to the employer's posting — leaving the website with no page for the 55
 * prefilled, 10 submitted or 23 expired records it knows the most about.
 */

const when = (iso?: string) => (iso ? iso.slice(0, 16).replace("T", " ") : "—");

export default async function ApplicationPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const record = await getApplication(code);
  if (!record) notFound();

  const [entry, rounds] = await Promise.all([getQueueEntry(code), listRounds(code).catch(() => [])]);
  let description = "";
  const cfg = await loadX8NoteConfig();
  if (cfg && record.code) description = await fetchStoredJobDescription(cfg, record.code).catch(() => "");

  // The answers as last seen: the queue copy if there is one, otherwise the newest recorded round.
  const answers = entry?.answers?.length ? entry.answers : (rounds[rounds.length - 1]?.answers ?? []);

  return (
    <>
      <p className="muted" style={{ fontSize: 13 }}>
        <a href="/applications">← Applications</a>
      </p>
      <h1>
        {record.company} · {record.title}
      </h1>
      <p className="sub">
        <span className="code">{record.code}</span> <span className="pill">{record.status}</span>{" "}
        <span className="pill">{record.ats}</span>
        {record.companyReqId ? <span className="pill">req {record.companyReqId}</span> : null}
      </p>

      <div className="card">
        <table>
          <tbody>
            <tr>
              <td className="muted">Posting</td>
              <td>
                <a href={record.applyUrl} target="_blank" rel="noreferrer">
                  open on {record.ats} ↗
                </a>
              </td>
            </tr>
            <tr>
              <td className="muted">Location</td>
              <td>{record.location || "—"} {record.region ? <span className="muted">({record.region})</span> : null}</td>
            </tr>
            <tr>
              <td className="muted">Last touched</td>
              <td>{when(record.updatedAt)}</td>
            </tr>
            <tr>
              <td className="muted">In the queue</td>
              <td>
                {entry ? (
                  <>
                    <span className="pill">{entry.status}</span>{" "}
                    {entry.status === "awaiting_approval" ? <a href={`/queue/${code}`}>review and approve →</a> : null}
                  </>
                ) : (
                  <span className="muted">no — not awaiting a decision</span>
                )}
              </td>
            </tr>
            <tr>
              <td className="muted">Decision</td>
              <td>
                {entry?.decidedAt ? (
                  <>
                    approved by <strong>{entry.approvedBy ?? "unknown"}</strong> on {when(entry.decidedAt)}
                  </>
                ) : record.status === "submitted" ? (
                  <span className="muted">submitted before decisions were recorded</span>
                ) : (
                  <span className="muted">no decision recorded</span>
                )}
              </td>
            </tr>
            {/* A field we HAD an answer for but could not enter leaves the form blank, which is
                invisible unless it is said here — Deepgram went out without its Current Location. */}
            {entry?.filledFields?.length ? (
              <tr>
                <td className="muted">Fields filled</td>
                <td>{entry.filledFields.length}</td>
              </tr>
            ) : null}
            <tr>
              <td className="muted">Recorded copies</td>
              <td>{rounds.length ? <a href={`/history/${code}`}>{rounds.length} — see what changed →</a> : <span className="muted">none</span>}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {record.notes?.length ? (
        <>
          <h2>What happened</h2>
          <div className="card">
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
              {record.notes.map((n, i) => (
                <li key={`${n}-${i}`} style={{ marginBottom: 3 }}>{n}</li>
              ))}
            </ul>
          </div>
        </>
      ) : null}

      <h2>Answers ({answers.length})</h2>
      <div className="card" style={{ padding: 0 }}>
        {answers.length ? (
          <table>
            <thead>
              <tr><th style={{ width: "45%" }}>Question</th><th>Answer</th></tr>
            </thead>
            <tbody>
              {answers.map((a, i) => (
                <tr key={`${a.label}-${i}`}>
                  <td style={{ fontSize: 13 }}>{a.label}</td>
                  <td style={{ fontSize: 13 }}>{a.value || <span className="muted">(blank)</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted" style={{ margin: 0, padding: 14, fontSize: 13 }}>
            No answers recorded — this job never reached a form we could read.
          </p>
        )}
      </div>

      {record.lastRunDir ? (
        <>
          <h2>Screenshot</h2>
          <div className="card">
            <img
              src={`/api/screenshot/${code}`}
              alt="the filled application"
              style={{ width: "100%", borderRadius: 6, border: "1px solid var(--line)" }}
            />
          </div>
        </>
      ) : null}

      {description ? (
        <>
          <h2>Job description</h2>
          <div className="card" style={{ whiteSpace: "pre-wrap", fontSize: 13, maxHeight: 420, overflow: "auto" }}>
            {description}
          </div>
        </>
      ) : null}
    </>
  );
}

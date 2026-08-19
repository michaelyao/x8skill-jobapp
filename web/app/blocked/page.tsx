import { getOverview } from "@/lib/store";
import { RetryButton } from "@/components/RetryButton";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** A note that explains why a run stopped, if there is one. */
function reasonOf(notes: string[] = []): string | null {
  for (const n of notes) {
    const m = /^blocked required: (.+)$/.exec(n) ?? /^blocked by empty required: (.+)$/.exec(n) ?? /^form error: (.+)$/.exec(n);
    if (m) return m[1];
    if (n.startsWith("form error:")) return n;
  }
  return null;
}

export default async function BlockedPage() {
  const [{ applications, queue }, user] = await Promise.all([getOverview(), currentUser()]);
  // Only a job the queue is ACTIVELY handling should be hidden here. Excluding every code with a
  // queue entry meant an entry parked as "error" or "skipped" fell off this page too, and off the
  // queue, and was visible nowhere.
  const queued = new Set(
    queue
      .filter((q) => ["awaiting_approval", "submitting", "submitted"].includes(q.status))
      .map((q) => q.code)
      .filter(Boolean),
  );
  const blocked = applications
    .filter((a) => a.status === "prefilled_pending_submit" && !queued.has(a.code))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

  return (
    <>
      <h1>Blocked</h1>
      <p className="sub">
        {blocked.length} job{blocked.length === 1 ? "" : "s"} stopped before Review. Add the missing answer, then retry —
        an answer added once applies to every future application.
      </p>

      {blocked.length === 0 ? (
        <p className="empty">Nothing blocked.</p>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr><th>Code</th><th>Company</th><th>Role</th><th>Why it stopped</th><th className="right">Action</th></tr>
            </thead>
            <tbody>
              {blocked.map((a) => (
                <tr key={a.id}>
                  <td className="code">{a.code ?? "—"}</td>
                  <td>{a.company}</td>
                  <td><a href={a.applyUrl} target="_blank" rel="noreferrer">{a.title}</a></td>
                  <td className="muted" style={{ fontSize: 13 }}>
                    {reasonOf(a.notes) ?? "stopped before review"}
                    {a.unknownQuestions?.length ? (
                      <div style={{ marginTop: 4 }}>
                        <span className="pill">no answer: {a.unknownQuestions.slice(0, 2).join(", ")}{a.unknownQuestions.length > 2 ? ` +${a.unknownQuestions.length - 2}` : ""}</span>
                      </div>
                    ) : null}
                  </td>
                  <td className="right">{a.code ? <RetryButton code={a.code} disabled={user?.role !== "admin" && false} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

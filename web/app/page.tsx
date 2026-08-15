import { getActivity, getOverview } from "@/lib/store";
import { blockedReasons, countBy, daily, funnel } from "@/lib/stats";
import { WorkerBar } from "@/components/WorkerBar";

export const dynamic = "force-dynamic";

function Bar({ label, value, max, tone }: { label: string; value: number; max: number; tone?: "good" | "bad" }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className={`row${tone ? ` ${tone}` : ""}`}>
      <span className="muted">{label}</span>
      <span className="bar"><span style={{ width: `${pct}%` }} /></span>
      <span className="n">{value}</span>
    </div>
  );
}

export default async function Dashboard() {
  const { applications, queue, worker, pendingCommandCount } = await getOverview();
  const f = funnel(applications, queue);
  const activity = await getActivity(8);
  const byAts = countBy(applications, (a) => a.ats);
  const reasons = blockedReasons(applications).slice(0, 6);
  const series = daily(applications);
  const maxDay = Math.max(1, ...series.map((d) => d.engaged));

  return (
    <>
      <h1>Dashboard</h1>
      <p className="sub">Live status of every application the automation has touched.</p>

      <WorkerBar initial={worker} pendingCommands={pendingCommandCount} />

      <div className="grid cols-3" style={{ marginTop: 16 }}>
        <div className="card">
          <h3>Submitted</h3>
          <div className="stat"><span className="n">{f.submitted}</span><span className="label">applications in</span></div>
        </div>
        <div className="card">
          <h3>Awaiting your decision</h3>
          <div className="stat">
            <span className="n" style={{ color: f.awaitingApproval ? "var(--accent)" : undefined }}>{f.awaitingApproval}</span>
            <span className="label">{f.awaitingApproval ? <a href="/queue">review now →</a> : "all clear"}</span>
          </div>
        </div>
        <div className="card">
          <h3>Blocked</h3>
          <div className="stat">
            <span className="n">{f.blocked}</span>
            <span className="label">{f.blocked ? <a href="/blocked">needs an answer →</a> : "none"}</span>
          </div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <div className="card">
          <h3>Funnel</h3>
          <div className="funnel">
            <Bar label="Engaged" value={f.engaged} max={f.engaged} />
            <Bar label="Reached review" value={f.reachedReview} max={f.engaged} />
            <Bar label="Awaiting approval" value={f.awaitingApproval} max={f.engaged} />
            <Bar label="Submitted" value={f.submitted} max={f.engaged} tone="good" />
            <Bar label="Blocked" value={f.blocked} max={f.engaged} tone="bad" />
            <Bar label="Expired postings" value={f.expired} max={f.engaged} tone="bad" />
          </div>
        </div>

        <div className="card">
          <h3>By ATS</h3>
          <div className="funnel">
            {byAts.map((a) => (
              <Bar key={a.name} label={a.name} value={a.count} max={byAts[0]?.count ?? 1} />
            ))}
          </div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <div className="card">
          <h3>What blocks jobs most</h3>
          {reasons.length ? (
            <div className="funnel">
              {reasons.map((r) => (
                <Bar key={r.name} label={r.name} value={r.count} max={reasons[0].count} tone="bad" />
              ))}
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>Nothing blocked.</p>
          )}
          <p className="muted" style={{ fontSize: 12, marginBottom: 0, marginTop: 12 }}>
            Adding an answer for one of these fixes it for every future application.
          </p>
        </div>

        <div className="card">
          <h3>Recent activity</h3>
          {activity.length ? (
            <table>
              <tbody>
                {activity.map((c) => (
                  <tr key={c.id}>
                    <td className="nowrap"><span className="pill">{c.name}</span></td>
                    <td className="code">{"code" in c ? c.code : ""}</td>
                    <td className="muted" style={{ fontSize: 13 }}>{c.result?.message ?? "queued"}</td>
                    <td className="muted nowrap right" style={{ fontSize: 12 }}>{c.actor ?? c.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted" style={{ margin: 0 }}>No actions yet.</p>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Last {series.length} days</h3>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 110 }}>
          {series.map((d) => (
            <div key={d.day} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 2 }} title={`${d.day}: ${d.engaged} engaged, ${d.submitted} submitted`}>
              <div style={{ height: `${(d.engaged / maxDay) * 70}px`, background: "var(--accent)", borderRadius: "3px 3px 0 0", minHeight: d.engaged ? 2 : 0 }} />
              <div style={{ height: `${(d.submitted / maxDay) * 70}px`, background: "var(--good)", borderRadius: 3, minHeight: d.submitted ? 2 : 0 }} />
              <span className="muted" style={{ fontSize: 10, textAlign: "center" }}>{d.day.slice(5)}</span>
            </div>
          ))}
        </div>
        <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
          <span style={{ color: "var(--accent)" }}>■</span> engaged &nbsp; <span style={{ color: "var(--good)" }}>■</span> submitted
        </p>
      </div>
    </>
  );
}

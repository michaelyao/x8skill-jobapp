import { getOverview } from "@/lib/store";

export const dynamic = "force-dynamic";

const TONE: Record<string, string> = {
  submitted: "good",
  manual_submitted: "good",
  already_applied_on_site: "good",
  prefilled_pending_submit: "accent",
  expired: "",
  error: "bad",
};

export default async function ApplicationsPage({ searchParams }: { searchParams: Promise<{ status?: string; ats?: string }> }) {
  const { status, ats } = await searchParams;
  const { applications } = await getOverview();

  const filtered = applications
    .filter((a) => (status ? a.status === status : true))
    .filter((a) => (ats ? a.ats === ats : true))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

  const statuses = [...new Set(applications.map((a) => a.status))];
  const atsList = [...new Set(applications.map((a) => a.ats))];

  return (
    <>
      <h1>Applications</h1>
      <p className="sub">{filtered.length} of {applications.length} records.</p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <a href="/applications" className={`pill${!status && !ats ? " accent" : ""}`}>all</a>
        {statuses.map((s) => (
          <a key={s} href={`/applications?status=${s}`} className={`pill${status === s ? " accent" : ""}`}>{s}</a>
        ))}
        {atsList.map((a) => (
          <a key={a} href={`/applications?ats=${a}`} className={`pill${ats === a ? " accent" : ""}`}>{a}</a>
        ))}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr><th>Code</th><th>Company</th><th>Role</th><th>Status</th><th>Req ID</th><th className="right">Updated</th></tr>
          </thead>
          <tbody>
            {filtered.map((a) => (
              <tr key={a.id}>
                <td className="code">{a.code ? <a href={`/applications/${a.code}`}>{a.code}</a> : "—"}</td>
                <td>{a.company}</td>
                <td>
                  <a href={`/applications/${a.code}`}>{a.title}</a>{" "}
                  <a href={a.applyUrl} target="_blank" rel="noreferrer" title="open the posting on the ATS" className="muted" style={{ fontSize: 12 }}>
                    ↗
                  </a>
                </td>
                <td><span className={`pill ${TONE[a.status] ?? ""}`}>{a.status}</span></td>
                <td className="code muted">{a.companyReqId ?? "—"}</td>
                <td className="right muted nowrap">{(a.updatedAt ?? "").slice(0, 16).replace("T", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

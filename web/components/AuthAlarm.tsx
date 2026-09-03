import { readAuthAlerts } from "@core/knowledge/authAlerts.js";

/**
 * Employers whose candidate account has to be created by hand.
 *
 * Every Workday employer is a separate tenant with its own account, and the automation has three
 * things it can try — create, sign in, reset by email. When all three are exhausted there is
 * nothing left for it to do, and the job stops having filled one field. Sixty-five applications
 * sat in that state and the only trace was a line in worker.log: on the pages, it looked like a
 * quiet week.
 *
 * Grouped by tenant on purpose. One account unblocks every posting at that employer, so the count
 * beside it is the reason to bother, not decoration.
 */
export async function AuthAlarm() {
  const alerts = await readAuthAlerts().catch(() => []);
  if (!alerts.length) return null;
  const jobs = alerts.reduce((n, a) => n + a.hits, 0);
  const ordered = [...alerts].sort((a, b) => b.hits - a.hits);

  return (
    <div
      role="alert"
      style={{
        background: "var(--warn, #e8a33d)",
        color: "#1b1b1b",
        padding: "10px 16px",
        fontSize: 14,
        lineHeight: 1.45,
      }}
    >
      <strong>
        {alerts.length} employer{alerts.length === 1 ? "" : "s"} need an account created by hand
      </strong>{" "}
      — holding {jobs} application{jobs === 1 ? "" : "s"}. Creating, signing in and a password
      reset were all tried; the reset email never arrived, which is what Workday does when there is
      no account to reset. Make one with the usual credentials and the postings there go through on
      the next sweep.
      <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
        {ordered.slice(0, 8).map((a) => (
          <li key={a.tenant} style={{ marginBottom: 2 }}>
            <a
              href={`https://${a.tenant}`}
              target="_blank"
              rel="noreferrer"
              style={{ color: "#1b1b1b", fontWeight: 600 }}
            >
              {a.tenant}
            </a>{" "}
            — {a.hits} job{a.hits === 1 ? "" : "s"}
            {a.company ? ` · ${a.company}` : ""}
            <span style={{ opacity: 0.8 }}> · stopped at {a.stage}</span>
          </li>
        ))}
      </ul>
      {ordered.length > 8 ? (
        <p style={{ margin: "6px 0 0", opacity: 0.85 }}>
          and {ordered.length - 8} more — the full list is in data/auth-alerts.json.
        </p>
      ) : null}
    </div>
  );
}

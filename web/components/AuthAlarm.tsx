import { readAuthAlerts } from "@core/knowledge/authAlerts.js";
import { loadApplications } from "@core/knowledge/applications.js";

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

/**
 * THE LINK HAS TO LAND ON THE SIGN-IN PAGE, which is where Create Account lives.
 *
 * It used to point at `https://<tenant>` — the employer's careers home, a search page with no way
 * in. The candidate asked "how do I find the webpage of Stryker, Mastercard, and others" while
 * looking at this very banner, which is a fair verdict on it.
 *
 * Workday's sign-in URL needs the SITE path as well as the host, and the alert only records the
 * host. The site is sitting in the apply URL of any job on that tenant, so take it from there:
 * `https://mastercard.wd1.myworkdayjobs.com/Campus/job/...` gives
 * `https://mastercard.wd1.myworkdayjobs.com/en-US/Campus/login`, which answers 200 and offers
 * Create Account. Falls back to the bare host when no apply URL will parse — a worse link is
 * better than a missing one.
 */
function loginUrlFor(tenant: string, applyUrls: string[]): string {
  for (const url of applyUrls) {
    const match = /^https:\/\/([^/]+)\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)\//.exec(url);
    if (match && match[1] === tenant && match[2] && match[2] !== "job") {
      return `https://${tenant}/en-US/${match[2]}/login`;
    }
  }
  return `https://${tenant}`;
}

export async function AuthAlarm() {
  const alerts = await readAuthAlerts().catch(() => []);
  if (!alerts.length) return null;

  const applications = await loadApplications().catch(() => []);
  const urlsByTenant = new Map<string, string[]>();
  const jobsByTenant = new Map<string, Set<string>>();
  // The employer's NAME, which the alert usually does not carry — 19 of 20 had none, so the
  // banner listed "ntrs.wd1.myworkdayjobs.com" where it meant Northern Trust. Any job on the
  // tenant knows the company.
  const nameByTenant = new Map<string, string>();
  /**
   * THE POSTINGS THEMSELVES, because that is what he asked for twice.
   *
   * The first version of this told him which employers needed attention; the second linked to
   * their sign-in pages. Neither is the thing you want in front of you — "I am not asking the sign
   * in page, i am asking for the job application url". One account unblocks a tenant, but the
   * postings are the work, and they were only ever available by asking me to run a query.
   */
  const postingsByTenant = new Map<string, Array<{ code: string; title: string; url: string }>>();
  for (const app of applications) {
    const url = app.applyUrl ?? "";
    const host = /^https:\/\/([^/]+)\//.exec(url)?.[1];
    if (!host) continue;
    if (!urlsByTenant.has(host)) urlsByTenant.set(host, []);
    urlsByTenant.get(host)!.push(url);
    if (app.company && !nameByTenant.has(host)) nameByTenant.set(host, app.company);
    // Only the ones still waiting: a tenant whose jobs have all been submitted or closed is not
    // holding anything, whatever the alert remembers.
    if (app.status === "error" || app.status === "prefilled_pending_submit") {
      if (!jobsByTenant.has(host)) jobsByTenant.set(host, new Set());
      jobsByTenant.get(host)!.add(app.code ?? app.id);
      if (!postingsByTenant.has(host)) postingsByTenant.set(host, []);
      postingsByTenant.get(host)!.push({
        code: app.code ?? app.id,
        title: app.title ?? "",
        url,
      });
    }
  }

  /**
   * COUNT JOBS, NOT ATTEMPTS. `hits` is how many times we walked the auth ladder at that tenant,
   * and it was being printed as "7 jobs" — Barclays had been tried seven times over two postings.
   * The number that decides whether it is worth making an account is how many applications are
   * waiting on it.
   */
  const rows = alerts
    .map((alert) => ({
      alert,
      waiting: jobsByTenant.get(alert.tenant)?.size ?? 0,
      loginUrl: loginUrlFor(alert.tenant, urlsByTenant.get(alert.tenant) ?? []),
      postings: (postingsByTenant.get(alert.tenant) ?? []).sort((x, y) =>
        x.title.localeCompare(y.title),
      ),
    }))
    .sort((a, b) => b.waiting - a.waiting || a.alert.tenant.localeCompare(b.alert.tenant));
  const waiting = rows.reduce((n, r) => n + r.waiting, 0);

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
      — holding {waiting} application{waiting === 1 ? "" : "s"}. Creating, signing in and a password
      reset were all tried; the reset email never arrived, which is what Workday does when there is
      no account to reset. Each link opens that employer&apos;s sign-in page, where{" "}
      <em>Create Account</em> is — use the same email and password the runs use
      (<code>JOB_APP_USERNAME</code> / <code>JOB_APP_PASSWORD</code>). The alert clears itself on
      the first successful sign-in, and nothing is retried at these tenants until then, so a wrong
      password is no longer being posted at them over and over.
      <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
        {rows.map(({ alert, waiting: count, loginUrl, postings }) => (
          <li key={alert.tenant} style={{ marginBottom: 6 }}>
            <strong>{alert.company || nameByTenant.get(alert.tenant) || alert.tenant}</strong>
            {" — "}
            <a href={loginUrl} target="_blank" rel="noreferrer" style={{ color: "#1b1b1b" }}>
              create the account
            </a>
            <span style={{ opacity: 0.75 }}>
              {" · "}
              {count} waiting
              {alert.hits > 1 ? ` · tried ${alert.hits}×` : ""}
            </span>
            {postings.length ? (
              <ul style={{ margin: "2px 0 0", paddingLeft: 18, listStyle: "circle" }}>
                {postings.map((p) => (
                  <li key={p.code}>
                    {/*
                      OUR page first, the employer's second. "actually the url of webpage of in our
                      own website" — the thing he wants to open is the record we hold, where the
                      answers and the history are; the posting is the aside.
                    */}
                    <a
                      href={`/applications/${p.code}`}
                      style={{ color: "#1b1b1b", fontWeight: 600 }}
                    >
                      {p.title || p.code}
                    </a>{" "}
                    <span style={{ opacity: 0.7 }}>{p.code}</span>{" "}
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "#1b1b1b", opacity: 0.7 }}
                    >
                      posting ↗
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

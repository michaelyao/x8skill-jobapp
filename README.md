# x8skill-jobapp

Playwright + TypeScript automation that applies to US software-engineering internships
(Summer 2027) on **Workday, Greenhouse, Ashby and Lever**.

It builds a job list from the trackers in `job_sites.txt`, skips anything already applied to,
opens each posting, fills the form from your profile / resume / curated Q&A — and then **stops
at the Review step and emails you the filled application**.

**Nothing is submitted without your approval.** You reply `APPROVE` (or `SKIP`, or describe a
change) and a background poller submits the exact answers you approved.

## Run

```bash
npm install
npm start                 # fill jobs, email each one for approval
npm run approvals         # process replies: submit approved, re-fill changes
npm run check             # type-check
```

Useful flags — the full table is in [DESIGN.md](DESIGN.md#14-operating-it):

```bash
NO_SUBMIT=1 npm start                    # never submit during the fill, only email + queue
JOB_ID=DVDFRR FORCE_RETRY=1 npm start    # re-run one job by its code
SKIP_REFRESH=1 npm start                 # reuse the job list instead of rebuilding
MAX_JOBS=3 npm start                     # small test run
```

Install the 15-minute approval poller so approvals submit on their own:

```bash
./install-cron.sh
```

## Serving it at job.studiox8.com

The app binds to `127.0.0.1:3010` (override with `WEB_HOST` / `WEB_PORT`). Point your reverse
proxy at it and set two things, or login will fail in confusing ways:

```
PUBLIC_URL=https://job.studiox8.com     # in .env — what the BROWSER uses
```

Without it, redirects are built from the address the app was reached on, so a sign-in bounce
sends the browser to `http://127.0.0.1:3010` — unreachable, and the http downgrade drops the
`Secure` session cookie. Next also sets `x-forwarded-proto: http` itself when the proxy does
not, so `PUBLIC_URL` is the reliable fix rather than relying on headers.

The proxy must also **disable buffering on `/api/stream`** (server-sent events) or live status
appears frozen:

```nginx
location / {
  proxy_pass http://127.0.0.1:3010;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
}
location /api/stream {
  proxy_pass http://127.0.0.1:3010;
  proxy_buffering off;
  proxy_read_timeout 3600s;
}
```

`GET /api/health` is the only unauthenticated route — use it for the proxy health check.

## How approval works

1. A run fills a job, reaches Review, and emails you the answers plus a screenshot.
2. You reply **APPROVE** / **SKIP** / or describe a change ("use the Pittsburgh address").
3. The poller replays the approved answers exactly and submits — so what is submitted is what
   you approved. Replies are matched to a job by its 6-letter code only.

If a job can't be completed, you get a debug email with the screenshot and the reason instead.

## Where things live

| Path | What |
|---|---|
| `data/applications.json` | operational state: identity, status, per-run notes |
| `data/pending-approvals.json` | in-flight approval queue |
| `data/answers.json`, `Q&A.txt` | learned + seed answers (adding one fixes every future form) |
| x8note `jobdescription` notebook | the application content: full job description, answers as emailed |
| `logs/<run>/` | per-run summary and screenshots |

## Local files you need (not committed)

`.env` (credentials + API keys), `.x8note.config`, your resume PDF, `unofficial_academic_record.pdf`,
`Q&A.txt`, and a resume markdown/text file. See [DESIGN.md](DESIGN.md) for the details.

## Docs

- **[DESIGN.md](DESIGN.md)** — how the system actually works, and why each guard exists.
- **CLAUDE.md** — the invariants and per-ATS quirks not to break.

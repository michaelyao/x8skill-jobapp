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
npm start                 # fill jobs
npm run worker            # the daemon that owns Chrome and executes console actions
npm run check             # type-check

./web-start.sh            # start the web console (0.0.0.0:8088)
./web-stop.sh             # stop it

./worker-start.sh         # start the worker (owns Chrome, executes console actions)
./worker-stop.sh          # stop it gracefully (--force to kill mid-task)
```

Both services are needed: the console queues your decisions, the worker carries them out.
A console with no worker looks healthy but silently never submits anything — `web-start.sh`
warns when that is the case, and `/api/health` reports the worker's state.

### Run them permanently

```bash
./install-services.sh              # launchd agents: start at login, restart on crash
./install-services.sh --uninstall
```

This also removes the `*/15` approvals cron entry — the worker does that job now, within
seconds rather than up to fifteen minutes, and leaving both installed means two processes
racing for the same Chrome profile.

After a crash launchd waits **30 seconds** before restarting (`ThrottleInterval`, so a service
that fails on startup does not spin). If you kill something and it seems gone, wait half a
minute before concluding it is dead.

```bash
launchctl list | grep jobapp                                  # status
launchctl kickstart -k gui/$(id -u)/com.studiox8.jobapp.web    # force a restart
tail -f logs/web.log logs/worker.log
```

`web-start.sh` refuses to start twice, checks that `WEB_SESSION_SECRET` and at least one
account exist, builds on first run, waits for the port, and reports the worker's state.
`web-stop.sh` kills whatever holds the port — `pkill -f "next start"` misses it, because
the process re-execs as `next-server`.

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

The app listens on **`0.0.0.0:8088`** (override with `WEB_HOST` / `WEB_PORT`), so it is reachable
both directly on the LAN — `http://192.168.1.216:8088` — and through the reverse proxy at
`https://job.studiox8.com`.

Redirects follow whichever host you arrived on, so both entry points work. That only holds
while `PUBLIC_URL` is unset: setting it pins every redirect to one origin and would bounce LAN
visitors to the domain. Set it only if you stop using the LAN address.

The session cookie is marked `Secure` only when the request arrived over https, so it survives
plain-http LAN use and is still protected behind the proxy — which must therefore send
`X-Forwarded-Proto`.

**Binding to `0.0.0.0` means anyone on your network can reach the login page**, and over the LAN
the password travels in cleartext. Firewall 8088 to the proxy host if you want it reachable only
through the domain.

The proxy must also **disable buffering on `/api/stream`** (server-sent events) or live status
appears frozen:

```nginx
location / {
  proxy_pass http://127.0.0.1:8088;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
}
location /api/stream {
  proxy_pass http://127.0.0.1:8088;
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

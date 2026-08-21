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
npm start                 # queue the next 10 jobs for the worker to apply to
npm run worker            # the daemon that owns Chrome and executes your decisions
npm run check             # type-check

./web-start.sh            # start the website natively (0.0.0.0:8088)
./web-stop.sh             # stop it

./worker-start.sh         # start the worker (owns Chrome, carries out your decisions)
./worker-stop.sh          # stop it gracefully (--force to kill mid-task)
```

Both services are needed: the website queues your decisions, the worker carries them out.
A website with no worker looks healthy but silently never submits anything — `web-start.sh`
warns when that is the case, and `/api/health` reports the worker's state.

### Run them permanently

**The website runs in Docker on 8088. The worker runs natively as a LaunchAgent.** One website,
one worker — an earlier setup ran a second native website alongside it against the same data, which
was pure duplication.

```bash
./jobapp_website.sh up             # the website (8088)
./install-services.sh              # the worker as a LaunchAgent, + offers auto-login
./install-services.sh --autologin  # only (re)set auto-login
./install-services.sh --uninstall
```

Run the installer as yourself, not with `sudo` — it needs your `$HOME` and uid to place the
LaunchAgent, and calls `sudo` itself only where root is required.

The worker cannot be containerized and cannot be a daemon: it drives a real headed Chrome with
the persistent profile, which needs a GUI (Aqua) session. That is what auto-login is for.

After a crash launchd waits **30 seconds** before restarting (`ThrottleInterval`), so a service
that fails on startup does not spin.

```bash
launchctl list | grep jobapp        # worker
./jobapp_website.sh status          # website
tail -f logs/worker.log
```

`web-start.sh` / `worker-start.sh` still start either one by hand — useful over SSH.

### Applying to jobs

Nothing outside the worker drives a browser. `npm start` and `./bin/jobapp` are both clients:
they plan the batch (pure file work) and enqueue commands. The worker applies to them **one at a
time** through the single Chrome profile, so a batch of ten never means ten browsers — and a
decision you make meanwhile jumps ahead of them.

```bash
npm start                                # queue the next 10
MAX_JOBS=3 npm start                     # queue 3 instead
JOB_ID=DVDFRR FORCE_RETRY=1 npm start    # re-run one job by its code
SKIP_REFRESH=1 npm start                 # reuse the job list instead of rebuilding
SUPPORTED_ONLY=1 LATEST_FIRST=1 npm start

./bin/jobapp sweep --max 10              # same thing from the CLI
./bin/jobapp refresh                     # rebuild the job list (all three sources)
./bin/jobapp apply PTPDDZ                # one job: fill, stop at Review, never submit
./bin/jobapp status
```

A sweep is capped at 10 by default, counted **after** the dedupe checks so a run of
already-applied jobs does not eat the cap. Dedupe is `data/applications.json` alone now — the
Google tracker sheet is retired, because reading it needed a browser *and* a human to press
Enter, which no scheduled run could ever do.

<details>
<summary>Optional: a native website daemon on 8089</summary>

The container cannot start until someone logs in, because Docker Desktop is a GUI login item.
If you want a website that is up at boot regardless, `./install-services.sh
--with-website-daemon` installs the native website as a **LaunchDaemon** on 8089 — no login, no
Docker, no VM in the chain. It coexists with the container (different port, and sharing `data/`
is safe: the website never writes application state, and the derived files it rewrites on read
are written atomically with identical content).

</details>

### Running the website in Docker

The website runs as a container. The **worker cannot**, and the
setup does not try: it drives a real headed Chrome using the persistent profile in
`playwright/.auth`, which is what keeps the bot fingerprint low enough for Workday and
Greenhouse to accept a form, and what holds the ATS sessions between runs. A Linux container has
neither. So the split is: website in Docker, worker native.

```bash
./jobapp_website.sh up        # preflight, build, start
./jobapp_website.sh status
./jobapp_website.sh logs
./jobapp_website.sh down
./jobapp_website.sh rebuild   # after changing web/ or src/
```

The image holds only the built Next server. All state is bind-mounted at `/jobapp`
(`JOBAPP_ROOT`), so the container and the native worker read and write the *same* files —
`data/commands/` is the control channel between them, which is why it is mounted read-write.
`playwright/` is deliberately not mounted: the website never drives a browser, so the
container has no reason to hold live session cookies.

Two things to know before relying on it:

- **`web-stop.sh` does not apply.** It kills whatever holds port 8088, which for a container
  is `docker-proxy`. Use `./jobapp_website.sh down`. `jobapp_website.sh up` refuses to start
  if a *native* website already holds the port and points you at `./web-stop.sh`.
- **Docker does not make it reboot-safe on macOS.** Both bind port 8088; whichever loses crash-loops against the
  winner. `restart: unless-stopped` only acts once the Docker daemon is up, and on macOS that
  daemon *is* Docker Desktop — a GUI-login app. So the container cannot start before someone
  signs in, which is the exact problem the LaunchDaemon exists to solve. `install-services.sh`
  refuses to install while the container is running; run `./jobapp_website.sh down` first, or
  stay on Docker and skip the daemon.

### The 8-hour tick

`jobapp_scheduler` — its own container, same image — rebuilds the job list and queues the next
batch every 8 hours. It never touches a browser; it writes one command file and the worker does
the work, one application at a time.

```bash
docker logs -f jobapp_scheduler
docker exec jobapp_website jobapp status      # jobapp works inside the container too
docker exec jobapp_website jobapp sweep --max 5
```

It skips a tick if the previous batch is still queued, or if the worker is not running — a sweep
can mean ten applications at several minutes each, so stacking them would only bury the queue.
Tune with `SCHEDULE_EVERY_MS` and `SCHEDULE_MAX_JOBS` in `docker-compose.yml`.

The website image ships compiled JS (`dist/`), so both the scheduler and the in-container
`jobapp` run on plain node with no transpiler in production.

### Surviving a reboot

`~/Library/LaunchAgents` is loaded at **GUI login, not at boot**. On a machine you only reach
over SSH, a reboot with nobody signing in leaves both services absent, with nothing in the
logs to explain it — this happened on 2026-08-19. From an SSH session you cannot even fix it
by hand:

```
launchctl managername                  ->  Background        (not Aqua)
launchctl bootstrap gui/$(id -u) ...   ->  125: Domain does not support specified action
open -a Docker                         ->  125: same thing
```

**Auto-login is deliberately off** — someone always signs in after a reboot. That is the whole
recovery procedure: sign in, and the chain below runs itself. Nothing to type.

```
reboot -> auto-login creates a GUI session
       -> Docker Desktop starts (it is a login item)
       -> the container restarts (restart: unless-stopped)
       -> the worker LaunchAgent loads
```

Every link is automatic once that session exists. The only property given up is coming back
*before* anyone signs in — if you ever want that, `./install-services.sh --autologin` sets it
(FileVault must stay off, and anyone with physical access then gets a logged-in desktop).

Note the `gui/$(id -u)` domain *is* reachable over SSH once somebody is logged in — the failure
above happens only when no GUI session exists at all.

Auto-login requires FileVault to be **off** (it is) — macOS ignores auto-login on an encrypted
volume, because the boot-time disk unlock needs a person. The installer checks and says so
rather than appearing to succeed. The trade is real and worth stating: anyone with physical
access to the machine gets a logged-in desktop.

Headed Chrome *does* launch from an SSH session (Playwright spawns the binary directly rather
than through LaunchServices), so `./worker-start.sh` works as a stopgap before auto-login is
on. `open -a` and `launchctl bootstrap gui/…` go through the GUI domain and do not.

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

### When you apply by hand

If you fill and submit an application yourself on the employer's site, mark it — otherwise the
ledger still reads "prefilled, never submitted" and the next sweep re-opens a live application.

```bash
jobapp manual-submit HDHJVW      # or "I submitted this myself…" on the job's page
```

This is **not** a skip. A skip records that no application exists; this records that one does,
so nothing re-opens, re-fills or re-submits it. It touches no browser. An application already
mid-submit is refused instead — check the ATS for a duplicate first.

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

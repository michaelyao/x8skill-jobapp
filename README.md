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

**The console runs in Docker on 8090. The worker runs natively as a LaunchAgent.** One console,
one worker — an earlier setup ran a second native console on 8088 against the same data, which
was pure duplication.

```bash
./console-docker.sh up             # the console (8090)
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
./console-docker.sh status          # console
tail -f logs/worker.log
```

`web-start.sh` / `worker-start.sh` still start either one by hand — useful over SSH.

<details>
<summary>Optional: a native console daemon on 8088</summary>

The container cannot start until someone logs in, because Docker Desktop is a GUI login item.
If you want a console that is up at boot regardless, `./install-services.sh
--with-console-daemon` installs the native console as a **LaunchDaemon** on 8088 — no login, no
Docker, no VM in the chain. It coexists with the container (different port, and sharing `data/`
is safe: the console never writes application state, and the derived files it rewrites on read
are written atomically with identical content).

</details>

### Running the console in Docker

The console can run as a container instead of a native process. The **worker cannot**, and the
setup does not try: it drives a real headed Chrome using the persistent profile in
`playwright/.auth`, which is what carries the live Google session the tracker-sheet export
needs and what keeps the bot fingerprint low enough for Workday and Greenhouse to accept a
form. A Linux container has none of that. So the split is: console in Docker, worker native.

```bash
./console-docker.sh up        # preflight, build, start
./console-docker.sh status
./console-docker.sh logs
./console-docker.sh down
./console-docker.sh rebuild   # after changing web/ or src/
```

The image holds only the built Next server. All state is bind-mounted at `/jobapp`
(`JOBAPP_ROOT`), so the container and the native worker read and write the *same* files —
`data/commands/` is the control channel between them, which is why it is mounted read-write.
`playwright/` is deliberately not mounted: the console never drives a browser, so the
container has no reason to hold live session cookies.

Two things to know before relying on it:

- **`web-stop.sh` does not apply.** It kills whatever holds port 8088, which for a container
  is `docker-proxy`. Use `./console-docker.sh down`. `console-docker.sh up` refuses to start
  if a *native* console already holds the port and points you at `./web-stop.sh`.
- **Docker does not make it reboot-safe on macOS, and it is an ALTERNATIVE to the console
  daemon, not a companion.** Both bind port 8088; whichever loses crash-loops against the
  winner. `restart: unless-stopped` only acts once the Docker daemon is up, and on macOS that
  daemon *is* Docker Desktop — a GUI-login app. So the container cannot start before someone
  signs in, which is the exact problem the LaunchDaemon exists to solve. `install-services.sh`
  refuses to install while the container is running; run `./console-docker.sh down` first, or
  stay on Docker and skip the daemon.

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

With the console in Docker, **auto-login is the single thing that makes a reboot recover**:

```
reboot -> auto-login creates a GUI session
       -> Docker Desktop starts (it is a login item)
       -> the container restarts (restart: unless-stopped)
       -> the worker LaunchAgent loads
```

Every link needs that session. Without auto-login all four stay down until someone sits at the
machine. `./install-services.sh --autologin` sets it.

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
jobapp manual-submit HDHJVW      # or "I submitted this myself…" on the job's console page
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

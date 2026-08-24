# Quick start

From a fresh clone to a filled application waiting in your inbox. macOS only — the worker drives
a real headed Chrome, so it needs a desktop session.

For how it works and why each guard exists, read [DESIGN.md](DESIGN.md). For flags and day-to-day
commands, [README.md](README.md). This page is only the path from nothing to running.

## 1. Prerequisites

- **Node 22+** and **Docker Desktop** (the website runs in a container; the worker does not).
- A **login session on the machine itself**, at least once. The worker is a LaunchAgent and
  Docker Desktop is a login item, so neither starts over SSH alone. This is by design.

```bash
npm install
cd web && npm install && cd ..
```

You do not need to build the website — its image builds itself on first `up`.

## 2. Files that are not in the repo

All of these are git-ignored, so a fresh clone has none of them. Nothing runs without them.

| File | What it is |
|------|-----------|
| `.env` | Credentials and keys — see below |
| `resumes.config` | Points at your resume in three formats (`pdf` / `md` / `txt`) |
| the resume itself | The `pdf` is uploaded to ATS forms; the `txt`/`md` are parsed for your profile |
| `unofficial_academic_record.pdf` | Transcript, uploaded when a form asks for one |
| `Q&A.txt` | Seed answers, `Q: …` / `A: …` per pair. Corrections you make later live in `data/learned-answers.json` and override this |
| `skill.txt` | Skills to ADD, and a `REMOVE:` section for the ones the ATS wrongly guesses off your resume |
| `.x8note.config` | x8note token, for archiving job descriptions |

`resumes.config` is the indirection that keeps a person's filename out of the code:

```
pdf = My Resume.pdf
md  = my resume.md
txt = my resume.txt
```

## 3. `.env`

```
WORKDAY_EMAIL=you@example.com
WORKDAY_PASSWORD=…
GEMINI_API_KEY=…
GOG_KEYRING_PASSWORD=…        # passphrase for gog's OAuth token file, NOT a Google password
WEB_SESSION_SECRET=…          # 32+ chars; sign-in cannot work without it
WEB_USER_YOURNAME=scrypt:…    # one line per website account
```

Two that trip people up:

- **`GOG_KEYRING_PASSWORD` is not a Google credential.** It decrypts gog's local OAuth token.
  It has to be in `.env` because launchd does not read `~/.zshrc`: without it every review email
  sent by the worker fails with *"no TTY available for keyring file backend password prompt"*
  while the identical command works by hand. An app password would not help — gog uses the Gmail
  API over OAuth, not SMTP.
- **Website accounts are hashed, never plaintext.** Generate each line with:

  ```bash
  npm run hash-password        # prompts with echo off, prints the WEB_USER_… line to paste
  ```

## 4. Start it

```bash
./jobapp_website.sh up     # builds on first run, then the website on http://localhost:8088
./install-worker.sh        # the worker as a LaunchAgent (no sudo needed)
```

Run the installer as yourself, not with `sudo` — it needs your `$HOME` and uid to place the
agent. Then open **http://localhost:8088** and sign in with the account you just hashed.

Check both halves are alive:

```bash
./jobapp_website.sh status              # → health: {"ok":true,"worker":"idle"}
launchctl list | grep jobapp            # → com.studiox8.jobapp.worker
```

A website with no worker looks perfectly healthy and silently never submits anything, so
`/api/health` reports the worker's state too. Confirm you see both.

## 5. What happens on its own

Nothing needs to be triggered. Inside the website process, an 8-hour tick rebuilds the job list
and queues up to 10 applications; the worker drains them **one at a time** through its single
Chrome profile.

```bash
docker logs -f jobapp_website | grep scheduler:   # every tick, taken or skipped
tail -f logs/worker.log                           # the fill itself, field by field
```

A tick skips itself when the previous batch is still queued or the worker is down, so batches
never stack.

To start one now instead of waiting, or to drive it from the terminal at all, use the CLI —
`./bin/jobapp --help` lists everything:

```bash
./bin/jobapp status          # what the worker is doing, what is queued
./bin/jobapp sweep --max 3   # pick the next 3 jobs and queue them
./bin/jobapp queue           # applications waiting on you
```

It is a client, not a second worker: it writes a command file and the worker executes it. Nothing
here submits without an explicit approve.

## 6. Approving

For each job the worker fills the form, stops at Review, and **emails you the filled
application** — every question with the answer it is about to send, plus a 6-letter code.

Reply to that email with:

- **`APPROVE`** — it reopens the form, re-fills it, checks every value against what you approved,
  and submits only on an exact match. One difference and it stops and asks again.
- **`SKIP`** — dropped.
- **anything else** — treated as a correction: it re-fills applying your change and emails a
  fresh review.

The reply must contain the job's **code**, which is how one approval cannot submit a different
role at the same company. Or do it in the website: **Queue → the job → Approve**.

**Nothing is ever submitted without one of those.** There is no timeout that submits for you.

## 7. After a reboot

Log in at the machine. That is the whole procedure:

```
your login → Docker Desktop (login item) → website container + its 8-hour tick → worker agent
```

Every link is automatic once a session exists, so there is nothing to run by hand. What you give
up is starting *before* anyone signs in — a deliberate trade (auto-login is off; `./install-worker.sh
--autologin` turns it on if you ever want it, at the cost of a logged-in desktop for anyone with
physical access).

If things look dead after a reboot, check for a GUI session before suspecting a crash:
`launchctl list | grep jobapp` empty plus `docker ps` unreachable usually means nobody has signed
in yet, not that anything failed.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Cannot connect to the Docker daemon` | Docker Desktop is not running — it starts at GUI login, not at boot |
| worker missing from `launchctl list`, logs silent | no GUI login since the last reboot. Over SSH, `launchctl managername` prints `Background` |
| website up, nothing ever applies | worker not running — `/api/health` says so |
| `Port 8088 is held by a NATIVE process` | something else has the port; stop it or `WEB_PORT=… ./jobapp_website.sh up` |
| a job stuck in `submitting` | we clicked and never learned the outcome. Deliberately never auto-retried — check the ATS by hand |

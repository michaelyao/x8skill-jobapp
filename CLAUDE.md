# CLAUDE.md — x8skill-jobapp

## What this project does

Playwright + TypeScript automation that applies to US software engineering internships
(Summer 2027) from the trackers listed in `job_sites.txt` — Simplify, vanshb03, interndock,
zshah101.

The trackers are whatever is listed in `job_sites.txt` — currently Simplify, vanshb03, interndock
and zshah101. `tools/build_internships.mjs` auto-detects each README's shape; adding a source is a
line in that file plus a parser only if its shape is new.

It builds a job list, skips anything already engaged (see the identity rules below), then fills
Workday / Greenhouse / Ashby / Lever forms from local profile data, the resume, and a learned
Q&A store. It stops at the Review step and **emails the filled application for approval**.
Submission happens ONLY on an emailed `APPROVE` (replayed exactly) or a typed terminal
confirmation — never automatically.

## Running

```
npm start          # full run (tsx src/index.ts)
npm run check      # TypeScript type-check only
npm run build      # compile to dist/
MAX_JOBS=3 npm start   # limit to 3 jobs for testing
```

Debug / inspection scripts:
```
npx tsx src/debug/launchJob.ts          # open first filtered job in browser, wait for Enter
JOB_INDEX=3 npx tsx src/debug/launchJob.ts   # open specific job by index
npx tsx src/debug/inspectMyInfo.ts      # full flow → dump DOM of My Information page
```

## Local files required (not committed)

| File | Purpose |
|------|---------|
| `.env` | Credentials and keys (see below) |
| `resumes.config` | Names the resume in three formats — `pdf` / `md` / `txt` |
| the resume files it names | The `pdf` is uploaded to ATS forms; the `md`/`txt` are parsed for the profile |
| `Q&A.txt` | Seed Q&A pairs (`Q: …` / `A: …` format) |
| `unofficial_academic_record.pdf` | Transcript uploaded when requested |
| `.x8note.config` | x8note token, for archiving job descriptions |

**Resume filenames live in `resumes.config`, never in code or docs.** Currently
`2026 Nathan Yao's Resume - IS.pdf` + `nathan resume 2026.{md,txt}`; the earlier
`text version.txt` and `… - CS.pdf` are superseded and gone. `loadProfile` reads the md then the
txt from that config — the third fallback to a hardcoded `text version.txt` was removed
2026-08-24 along with `PROFILE_TEXT_PATH`, because a stale path that silently wins over the
configured one is worse than a missing-file error.

`skill.txt` is NOT in this table: it is committed. **Its name is lower-case in the code
(`SKILL_PLAN_PATH`) and must be lower-case on disk.** It was `Skill.txt` for a while and worked
only because macOS is case-insensitive by default — the same tree would fail to find it on a
case-sensitive volume or in a Linux container. Do not reintroduce the mismatch.

## .env format

```
JOB_APP_USERNAME=you@example.com      # ALSO the ATS candidate-account login
JOB_APP_PASSWORD=yourpassword         # ditto — profile.ts reads these two
GEMINI_API_KEY=your_key_here
GOG_KEYRING_PASSWORD=your_gog_keyring_passphrase
```

**The ATS login is `JOB_APP_USERNAME` / `JOB_APP_PASSWORD`, not `WORKDAY_*`.** This section said
`WORKDAY_EMAIL` / `WORKDAY_PASSWORD` for weeks and those names appear NOWHERE in `src/` —
`profile.ts` reads `loginEmail: process.env.JOB_APP_USERNAME ?? primaryEmail` and
`loginPassword: process.env.JOB_APP_PASSWORD`. Reading the stale names while diagnosing 65 failed
Workday sign-ins produced "WORKDAY_EMAIL = (EMPTY)" and a confident wrong conclusion that the
credentials were missing. The same pair doubles as the website's own login.

`GOG_KEYRING_PASSWORD` is **not** a Google credential — it is the local passphrase encrypting
gog's OAuth token file. It belongs in `.env` because launchd services do not read `~/.zshrc`:
without it every send under the daemon fails with *"no TTY available for keyring file backend
password prompt"* while the same code works by hand. An app password would not help; gog uses
the Gmail API over OAuth, not SMTP.

### x8ocr (the visual cross-check)

```
X8OCR_API_ENDPOINT=http://localhost:8799
X8OCR_API_KEY=<the key x8ocr issued to this app>
X8OCR_CALLBACK_URL=http://host.docker.internal:8088/api/ocr-result
X8OCR_CALLBACK_TOKEN=<shared secret, any random string>
```

x8ocr now **requires** an API key: without `X8OCR_API_KEY` every extract/job call answers 401
and the visual cross-check silently records itself as unavailable.

The cross-check is **asynchronous**. The fill run submits the review screenshot as an x8ocr job
and returns; x8ocr POSTs the result to `X8OCR_CALLBACK_URL`, which is the website's receiver, and
the website enqueues a `visual_check` command that the WORKER applies — the worker is still the
only writer of `pending-approvals.json`. `X8OCR_CALLBACK_TOKEN` is the shared secret the receiver
checks; it must be identical on both sides, and the receiver rejects everything when it is unset.

The callback URL is the **website's** address, not the worker's, because the worker is a native
process that exits between sweeps while the website container is always up and shares `./data`.
From x8ocr's container on this host that means `host.docker.internal:8088`.

Until the verdict arrives the entry carries `visualCheck.state === "pending"`, and
`submitApprovedEntry()` refuses to send. `VISUAL_CHECK_GRACE_MS` (default 10 min) is how long it
waits before ageing a stuck check out to "unavailable" and proceeding — x8ocr holds jobs in
memory, so a restart loses them and nothing may be blocked forever. `OCR_VERIFY=0` still skips
the check entirely.

**Deploying this needs a worker restart.** A running worker built before the `visual_check`
command existed rejects it as *"unrecognised command"*, so no verdict is ever applied and every
check ages out to unavailable — safe, but no verification happens.

**A verdict is only as good as the PAIRING, and a bad pairing must never read as a fault.**
Field-level checking pairs a recorded label with the block holding its value (`screenBlocks.ts`).
Three pairing bugs, each measured on a real capture, held nine finished applications out of the
review queue:

| What the check said | What was actually happening |
|---|---|
| `"Name" … but the screen shows "Current location"` | it paired with the NEXT FIELD'S LABEL 299px below, because the name input's own text was never detected. Real pairs sit 15–35px apart |
| `"High School Name" … shows "UNIVERSITY"` | a section HEADING (`label: "title"`) read as a value |
| `"…proudest of" … shows "'acking, reaching 200+…"` | the textarea was scrolled to the caret, so the box shows the value's TAIL and OCR mangled the character it clipped through |

So a value must be within reach of its label (3× the label height, min 60px), a `title` block is
never a value, a block whose text is another recorded label is never a value, and truncation is
tolerated at BOTH ends. A label block that carries text beyond the label may vouch for a value found
inside it (Workday merges a question and its answer into one region).

**"Empty" means a box we FOUND showing a placeholder — never "we found no box".** A filled value the
OCR did not detect is indistinguishable from an empty field, and blocking a finished application on
our own reader's miss is the failure this check exists to prevent. An unattributable field is
`value-not-located` and, like `label-not-found`, is NOT reported. Cases: `npm run test:blocks`.

**A stale verdict is re-judged from the SCREENSHOT, not by re-filling.** When the judging code
changes, verdicts already written are stale about themselves, not about the form — and re-filling to
get a fresh screenshot re-opens a live application at an employer to photograph a form we already
have a photograph of. `npm run recheck:screens` re-runs OCR on the saved `review-CODE.png` and
enqueues the same `visual_check` command the callback uses, so the WORKER still writes the verdict.

## Architecture

```
src/
  index.ts          entry — loads .env, calls run()
  config.ts         paths, URLs, constants
  types.ts          shared TypeScript types
  core/
    runner.ts       main orchestration loop
    filterJobs.ts   age + location + title filtering
    jobIdentity.ts  ATS detection, job ID extraction, dedupe against sheet
  sources/
    simplify.ts     fetches raw GitHub README, parses HTML job table
    trackerSheet.ts opens Google Sheet (browser auth), exports CSV
  adapters/
    base.ts         shared form-filling logic, submit blocklist, learning mode
    workday.ts      Workday — multi-step loop, account creation / sign-in
    ashby.ts        Ashby — multi-step loop
    greenhouse.ts   Greenhouse — multi-step loop
  knowledge/
    profile.ts      parses profile text, reads creds from env vars
    answerStore.ts  loads Q&A.txt, persists learned answers, syncs Q&A.md
  utils/
    env.ts          reads .env into process.env (no package needed)
    log.ts          run directories, JSON/markdown output helpers
    normalize.ts    question normalization, URL normalization, US location check
    prompts.ts      terminal prompts for learning mode and user confirmation
  debug/
    launchJob.ts    open a job in browser and wait (manual exploration)
    inspectMyInfo.ts  full flow then DOM dump of My Information page
data/              generated — profile.json, answers.json (git-ignored)
logs/              per-run logs (git-ignored)
playwright/.auth/  persistent browser profile for Google login (git-ignored)
```

## Key invariants — do not break these

- **DRIVE FORMS BY CLICKING. The Enter key is banned except on a Workday prompt.** Enter goes to
  whatever has focus, so on a single-page application form it is one missed condition away from
  filing the application — which it did SEVEN times: three at The Nuclear Company (2026-08-29), two
  at Chicago Trading, four at HP IQ (2026-09-01, hours after a guard was supposed to have closed
  it). A click lands on one element and cannot submit a form by accident. Two attempts to make the
  keystroke safe with a general guard both left a hole, and the second carried a confident comment
  explaining why it could not — "an open menu anywhere is enough for safety: the keystroke goes to
  the listbox rather than the form". It does not. `pressEnterOnWorkdayPrompt` now refuses unless the
  control is inside a Workday `multiSelectContainer`/`formField` ancestor AND that widget's own list
  is present; on Greenhouse, Ashby, Lever or Workable the answer is always no. The one real
  exception is measured: Workday's taxonomy prompt runs its search on ENTER, not on keystrokes —
  typing "python" alone leaves the unfiltered A-page. Everything else picks by clicking the option
  row, and `npm run test:reactselect` passes without a single Enter. Cases: `npm run test:enter`,
  whose fixture carries a second field with its menu deliberately left open.
- **A fill run must ASK THE PAGE whether it just applied.** "No next control — stopping" and "Thank
  you for applying" are indistinguishable from inside the turn loop: both mean `read()` found no
  fields. `submissionConfirmed()` runs at the end of every run; a confirmation records `submitted`
  in the ledger immediately (every dedupe guard reads it) and reports loudly. It is what turned the
  HP IQ repeat from seventeen hours of silence into a log line at the moment it happened. Attribution
  matters: a confirmation with NO fields read this run is `alreadyApplied` — the candidate applies by
  hand too, and recording his own applications as ours would be a false statement in the store
  everything reasons from.
- **Never click submit.** `SUBMIT_TEXT_BLOCKLIST` in `config.ts` is the guard. Do not weaken it.
  (Exception: Option-B per-job submit only on the user's explicit typed "submit" confirmation in the terminal.)
- **Keep automation stealthy.** Minimize the bot fingerprint to avoid ATS anti-bot blocks: launch with
  `ignoreDefaultArgs: ["--enable-automation"]` + `args: ["--disable-blink-features=AutomationControlled"]`
  (in `runner.ts`), prefer real Chrome headed with the persistent profile, use human-like typing
  (`pressSequentially` w/ delay) and let pages settle. Never try to defeat explicit CAPTCHAs.
- **The worker is never containerized; the website may be.** The worker drives a real headed
  Chrome on the host with the `playwright/.auth` profile — that profile is the live Google
  session the tracker-sheet export needs and the low bot fingerprint the ATS forms need. A
  Linux container has no macOS Chrome, no GUI and no access to it, so containerizing the
  worker would trade the property the automation depends on for a deploy convenience. The
  website is the opposite: it never drives a browser, so `Dockerfile.jobapp_website` /
  `docker-compose.yml` run it with state bind-mounted at `/jobapp` (`JOBAPP_ROOT`) and
  `data/commands/` read-write as the channel to the native worker. `playwright/` is not
  mounted. Docker is NOT a reboot-safety fix — see the next point.
- **ONE website, in Docker on 8088; the worker native as a LaunchAgent. There is no second
  website and no fallback.** Decided 2026-08-21, finished 2026-08-24. `install-worker.sh`
  (formerly `install-services.sh`) installs the WORKER and nothing else — the
  `--with-website-daemon` flag that installed the same Next app as a boot-time LaunchDaemon on
  8089 is DELETED, and so are `web-start.sh` / `web-stop.sh`, the hand-run native website.
  `./jobapp_website.sh` is the ONLY way to run it. The daemon's only advantage was starting
  before anyone signs in, which is exactly the property the next bullet says we are choosing to
  give up, so it was a second copy of the website hedging a decision already made. Do not add
  any of it back. Two reasons beyond the duplication: the tick now runs INSIDE the website
  process, so two websites means two tickers both enqueueing sweeps; and a second server on
  `data/` is one more writer to reason about. `web-stop.sh` was also a live footgun — it killed
  whatever held port 8088, which for the container is `docker-proxy`. The installer still
  REMOVES a legacy website agent/daemon if it finds one, so a machine that had it installed does
  not end up with an orphan nothing maintains.
- **Recovery waits for a login, and that is the chosen design.** Decided 2026-08-21: auto-login
  is NOT wanted — someone always signs in after a reboot. Do not re-propose it, and do not add a
  boot-time workaround for it. The chain is: login → Docker Desktop (a login item) → website
  (`restart: unless-stopped`, and the 8-hour tick starts with it) → worker LaunchAgent
  (`RunAtLoad`). Every link is automatic ONCE that session exists, so there is nothing to run by
  hand after a reboot; the only property being given up is starting before anyone signs in.
  `install-worker.sh` therefore does not prompt for auto-login (`--autologin` still sets it if
  that ever changes).
- **LaunchAgents load at GUI login, not at boot.** A reboot with nobody signed in leaves an
  agent absent and the logs silent; from SSH, `launchctl managername` is `Background` and
  `launchctl bootstrap gui/$(id -u) …` fails with `125: Domain does not support specified
  action` (`open -a Docker` fails identically). IMPORTANT correction to an earlier claim: the
  `gui/$(id -u)` domain IS reachable over SSH once somebody is logged in — `bootout` and
  `bootstrap` both work then. The 125 happens only when NO GUI session exists. So "it failed
  from SSH" is not evidence about the mechanism; re-check `launchctl list` after a login before
  concluding a service is missing. (Two workers ran at once on 2026-08-21 because a GUI login
  had quietly loaded the agent while a hand-started one was already going.) Headed Chrome *does*
  launch over SSH (Playwright spawns the binary directly), so `./worker-start.sh` is the stopgap
  when there is no GUI domain to bootstrap into — which is what the installer falls back to
  rather than leaving the worker down.
- **Autofilled skills are PRUNED, and only by exact match.** Uploading the resume makes the ATS
  populate Skills from its own parse of the PDF, and it guesses badly. `skill.txt` only says
  what to ADD, and an autofilled value is already committed — so the field reads as filled and
  is never offered for filling. The `REMOVE:` section of `skill.txt` names what to delete and
  `GenericDriver.pruneSkills` does it, called from `turnLoop` BEFORE `read()` so the review
  shows the form as it will be submitted. Matching is EXACT (trimmed, case-insensitive):
  "Natural Language" goes, "Language Processing" stays; "Verification" goes, "Formal
  Verification" stays. Do not relax it into substring or similarity matching — that silently
  deletes skills the candidate has. Removal is scoped to a container whose own LABEL asks
  about skills (never its full text, which contains the pills), and confirmed by a re-read: a
  click that dispatched without deleting is reported as stuck, never as removed. The decision
  is a pure function (`pillsToRemove`), NOT logic inside an `evaluate()` string, so it can be
  tested. Cases: `src/debug/skillRemovalCases.ts`.
- **`launchctl kickstart -k` does NOT reliably kill the worker — check the process table.** The
  agent runs `node_modules/.bin/tsx`, which spawns the real node process as a CHILD. launchd tracks
  the parent (`launchctl list` showed 82099) and kills that; the node process actually running the
  worker (82101) survived, so a restart on 2026-08-28 left TWO workers alive at once, the old one
  still holding Chrome and running the old code — the second time this has happened. After any
  restart, use `./worker-restart.sh` — it kills the survivor, clears an orphaned Chrome and
  verifies the result. By hand, `pgrep -fl "src/worker.ts"` must show the wrapper and ONE node child — matching on
  `"tsx src/worker.ts"` finds only the wrapper, which is how the second occurrence survived a
  cleanup that was written to prevent it — and if an orphaned Chrome is
  still on the profile (`pgrep -f "user-data-dir=.*playwright/.auth"`) kill it and delete
  `playwright/.auth/Singleton{Lock,Socket,Cookie}` — otherwise every launch fails with *"Target
  page, context or browser has been closed"*.
- **A dropdown that will not take a value and one whose menu never opened look identical in the
  log.** `SELECT_TRACE=1` prints one line per attempt (what was typed, how many options came back,
  what the control shows). 776 field timeouts in one batch were diagnosed only by reconstructing
  that by hand; do not remove it. The four causes, all fixed and all covered by `npm run
  test:reactselect` against `test/fake-ats/greenhouse-select.html`:
  1. every speculative locator read must carry an explicit `timeout`. The `data-automation-label`
     probe is WORKDAY-only; on any other ATS it matches nothing and `getAttribute` waits the
     Playwright default of 30 SECONDS per option row before the `catch` turns it into null.
  2. `fill("")` on a react-select input closes the menu the click just opened — clear only when
     there is something to clear.
  3. Enter into a list that has not filtered down closes the menu instead of choosing from it, so
     the filtered list is read and clicked FIRST; Enter is the fallback for Workday's remote search.
  4. type-and-Enter IS a complete selection. The committed value lives in `.select__single-value`
     (react-select clears the input) and may be SHORTER than the row chosen — "United States +1"
     commits as "+1" — so the check compares against the row that was clicked as well as the value
     that was wanted.
- **THE STAGE WORDS LIVE IN ONE PLACE: `src/core/statusVocabulary.ts`.** Two stores each have their
  own enum — the LEDGER (`ApplicationRecord.status`, one per job, permanent) and the QUEUE
  (`PendingStatus`, one per decision in flight, dropped once decided) — and they overlap without
  agreeing: `skipped` against `skipped_existing`, `error` meaning "the run failed" in one and
  "approved but the submit failed three times" in the other. The website had THREE hand-written
  label maps on top, which is how the word "applied" appeared in one table and nowhere else, reading
  like a confirmed fact when all it meant was that a submit had been clicked. Labels, one-line
  meanings and tone now come from that module; do not write a fourth map.
  **`submitted` means WE CLICKED and the run reported success — not that the employer confirmed
  anything.** The only status resting on the employer's word is `already_applied_on_site`.
  `confirmed` is deliberately absent: nothing yet reads the acknowledgement email, and adding the
  word before the mechanism repeats the "applied" mistake. When it exists it is its own stage, never
  folded into `submitted`.
- **`/queue` is for decisions; `/status` is for progress.** The split is by "is a human the next
  step", not by status. An application being re-filled, one mid-submit, and one that reached Review
  with something missing are all things the system moves on its own — they used to sit on the
  approval page, each beside an Approve button, which is a footgun: approving a copy that is being
  re-filled sends answers that are being rewritten as you read them. Both pages call the same
  `splitQueue`, so the list you approve from and the guard that refuses a submit cannot disagree.
  `/queue` keeps a COUNT of what moved with a link to `/status` — a page that silently dropped 26
  items would read as "there is nothing else".
- **`manual_submitted` is a submitted status, not a skip, and must be written to BOTH stores.**
  A skip means no application exists; this means the user filled and submitted it by hand on
  the ATS, so it is the most important kind to never re-open. The `manual_submit` command
  writes the queue entry (so `listAwaiting()` drops it and `isSubmittedStatus()` makes approve
  and retry refuse it) AND the ledger record (every dedupe guard reads the LEDGER —
  `hasSubmittedBefore` would otherwise say no and the next sweep would re-fill a live
  application). It is in `ENGAGED_STATUSES` and `SUBMITTED_STATUSES` so the guards hold without
  naming it. The ledger write is `setApplicationStatus`, never `recordApplication`: ledger
  records are slim, so the full writer would write the description and answers back empty. An
  entry stuck in `submitting` is REFUSED rather than marked — we clicked and never learned the
  outcome, so a hand submission on top of it may mean two applications, which is worth a look
  at the ATS rather than a silent tidy-up.
- **Only the worker launches Chrome.** `src/worker.ts` is the one place in the production path
  that calls `launchPersistentContext`, and it holds `data/.browser.lock`. `npm start` used to
  launch its own Chrome on the same profile while taking NO lock, so a hand-run fill could
  collide with the worker mid-application — Chrome is single-instance per user-data-dir. It is a
  client now: it plans the batch (pure file work) and enqueues a `sweep`. The only other browser
  launches are hand-run `src/debug/` tools and the throwaway headless Chromium that
  `tools/build_internships.mjs` uses for the JS-rendered interndock page. Do not add a browser
  launch anywhere else.
- **A sweep enqueues; it does not apply.** `planSweep` (no browser) picks jobs and the worker
  enqueues one `apply` command each, capped at `DEFAULT_SWEEP_CAP` (10). Applying inline would
  hold Chrome for as long as ten applications take, with your decisions stuck behind it — the
  problem the command priority table fixed. As separate commands each apply is one claimable
  unit, drained ONE AT A TIME, and an approve outranks all of them.
- **`apply`, `retry` and `change` are one handler.** A fresh job, a re-run and a correction differ
  only in what we knew beforehand; the "is this already done?" guards must not exist three times.
- **The Google tracker sheet is retired.** Reading it needed a browser AND a human to press
  Enter, so it could never run on a schedule. `applications.json` is the only dedupe source now —
  it matches on requisition id, `identityKey`, `externalJobId` and normalized apply URL, none of
  which need a session. `decideDedupe`/`SheetRow` are gone with it.
- **The 8-hour tick runs INSIDE the website process; the work happens in the worker.**
  `src/scheduler.ts` is a library — `startScheduler()` — started once from
  `web/instrumentation.ts`. It only ever writes a command file, no browser, which is why it can
  live where there is no Chrome. It enqueues ONE `sweep` with `refreshList`, and the worker does
  the rest. It is an interval, not a wall-clock cron: "every 8 hours" is about noticing new
  postings, so drift is irrelevant and a restart checks immediately instead of waiting for a
  slot. It SKIPS a tick when a sweep/refresh/apply is still queued, or when the worker is
  stale — otherwise a slow batch would have two more stacked behind it. Tuned via
  `SCHEDULE_EVERY_MS` / `SCHEDULE_MAX_JOBS` on the `website` service; `SCHEDULE_EVERY_MS=0`
  disables it.
- **Do not split the tick back into its own container.** It was `jobapp_scheduler`, a second
  compose service on the website's image, and the justification on record ("the image has no
  cron, and adding one means supervising two processes") was wrong on its own terms: this code
  was always a `setInterval`, never a cron job, so there was never a second process to
  supervise, and the website already enqueues commands in-process
  (`web/app/api/command/route.ts`). What the split actually cost was a second `dist/`
  entrypoint and a hand-maintained duplicate of the website's whole volume block. A JS cron
  library would be a step backwards for a different reason — those give wall-clock semantics,
  which is exactly what the interval was chosen over.
- **`register()` needs the edge escape hatch.** `web/instrumentation.ts` is bundled for the EDGE
  runtime as well, because `middleware.ts` puts the edge compiler in play, and the tick reaches
  `node:fs`/`node:path` through `@core/*`. A `NEXT_RUNTIME === "nodejs"` guard and a lazy
  `import()` are NOT enough — webpack follows the import while bundling and the edge build dies
  with *"Reading from node:fs is not handled by plugins"*. The node-only half lives in
  `web/instrumentation.node.ts` and `next.config.mjs` drops it from the edge bundle with
  `IgnorePlugin`. All three pieces are load-bearing; removing any one breaks `next build`.
  (`resolve.alias` does not work here — the `@core/*` path mapping resolves first.)
- **The image ships compiled JS, not tsx.** `Dockerfile.jobapp_website` runs `tsc -p tsconfig.json` in the
  builder and copies `dist/`, so the in-container `jobapp` CLI runs on plain node.
  Anything running `dist/*.js` needs an ABSOLUTE path and `working_dir: /app` — the image's
  WORKDIR is `/app/web` for `next start`, so a relative `dist/cli.js` resolves to
  `/app/web/dist/` and dies with MODULE_NOT_FOUND.
- **Credentials stay in `.env`.** `profile.ts` must read them from `process.env`, never hardcode.
- **profile.json must not contain `loginPassword`.** It is stripped in `profile.ts` before writing.
- **Simplify parsing reads the raw GitHub URL** (`raw.githubusercontent.com`), not the rendered page.
  The raw README uses HTML `<table>/<tr>/<td>` inside markdown, so the HTML regex parsers work.
- **A pipe-table source is mapped by HEADER NAME, never by column position.** zshah101's README is
  the same markdown as vanshb03's but with SEVEN columns
  (`Company|Role|Category|Location|Skills|Posted|Apply`). Read positionally, `Category` lands in
  location and `Location` lands in the link column, so every row comes out with no apply link and
  is dropped by the "can't apply" guard — the source contributed **zero** jobs while the run still
  reported success. `parseGithub` routes on a `Category` column being present; `parseHeaderTable`
  maps by name. Cases: `npm run test:sources`.
- **A table is only a jobs table if it has an APPLY column.** That check, not the section name, is
  what keeps zshah101's Drop Radar out: it holds a forecast of when companies *might* post, and a
  "Recently closed — roles that left the list". The first invents jobs that never existed, the
  second resurrects dead ones. `## Fall 2026` is a real jobs table but the wrong cycle, and the
  section allowlist (`SECTION_KEEP`) is what drops that. Every skip is counted and logged with its
  reason — a source that silently contributes nothing is the bug this whole area is about.
- **`TODAY` in the list builder must be the real date.** It was hardcoded to `2026-08-08`, the day
  the tool was written, so `dateToDays` saw anything newer as "later than today, must be last
  year" and reported a three-day-old posting as ~360 days old — burying the newest roles at the
  bottom of the `latestFirst` ordering that exists to surface them. `LIST_TODAY` pins it for tests.
- **Tracker sheet access is browser-driven.** The code navigates to the sheet URL in the headed
  browser (so the user's Google session applies), then exports CSV from the same authenticated
  context. Do not replace this with OAuth or API key approaches.
- **Learning mode pauses and waits for user input** when a form field has no known answer.
  The terminal bell rings and the user fills the field manually in the browser.
- **Required-field gate.** The turn loop must never advance (or reach Review) while a REQUIRED
  field is still empty. `read()` reports `filled` per field; `turnLoop` re-reads after each fill
  pass, retries the stragglers, and if a required field stays empty it STOPS and reports
  `blockedRequired` rather than clicking Next. Do not remove this gate.
- **REVIEW HAPPENS ON THE WEBSITE. There is no review email and no email poller — do not
  describe one.** Retired along with the 15-minute cron (`src/worker.ts`: "the web website only
  enqueues commands… replaces the 15-minute approvals cron so an action taken in the website
  happens within seconds"). `gog` survives for exactly two things, neither of them review: Workday
  reset/activation links (`workdayReset.ts`) and Oracle verification codes (`oracleVerify.ts`).
  There is no `sendReviewEmail`, no `--body-html`, no `npm run approvals`, no `approvals-cron.sh`
  entry in crontab. This section described the email flow for long enough to mislead someone
  reading it in Aug 2026 — if you are about to write "it emails you for approval", check `gog`
  usage first.
- **Approval is decoupled — the fill run NEVER blocks for a long approval.** Approval can take days.
  The fill (`applyToJob` mode `"fill"`) reaches Review and **enqueues to
  `data/pending-approvals.json`**, then moves on. You then act on `/queue` in the website, which
  writes a command the worker picks up within a tick. The three outcomes are the same three as
  before — **APPROVE / SKIP / CHANGE** — they just arrive as commands rather than as replies.
  - **APPROVE** → `applyToJob` mode `"submit"` with a `HybridAgent`: re-open and **re-fill** the live
    form, using an approved answer wherever the question still exists (matched positionally, so repeated
    blocks keep their own values) and the LLM only for what the approved set does not cover. Before the
    submit control is touched, `compareToApproved()` checks every value on the form against the approved
    ones; **one difference and nothing is submitted** — the job returns to the queue with `reapproval`
    holding both copies and the exact differences, and only a fresh approval can move it. Re-filling is
    what makes a days-old approval work at all (the session is long gone); the check is what keeps
    submitted == approved. Cases: `src/debug/driftCases.ts`.
  - **CHANGE** (reply asks for an edit) → `applyToJob` mode `"fill"` with `changeInstruction`: LLM
    re-fills applying the correction, emails a **fresh review**, requeues awaiting. The original reply
    is marked processed (`processedReplyIds`) so it never re-triggers; only a new APPROVE acts next.
  - **SKIP** → dropped.
  A lockfile + profile-busy guard keep the poller from colliding with an active fill run. Submit still
  happens ONLY on an emailed APPROVE (or the terminal grace-wait "submit").
- **A DISAPPEARED field blocks the submit too.** If a question we approved an answer for is no
  longer being read, the likely cause is OUR reader, not the employer — the field is still on
  the page and we would submit it blank, silently dropping an answer the user gave. Measured on
  this queue, nearly every recorded difference was our own code changing, not a posting changing.
  Treat a difference as a suspected bug here first.
- **A value the user has not read is never submitted.** The re-fill can only reuse approved values or
  stop. A REWORDED question passes only when the value going into it is character-for-character the
  approved one; "equivalent" is not a judgement this code is allowed to make. Do not relax
  `compareToApproved` into similarity matching.
- **The guard sequence exists once.** `submitApprovedEntry` is the only path to a submit, shared by the
  email poller and the website worker. It previously existed twice and the copies had already drifted.
- **Never submit the same application twice.** The poller runs unattended every 15 min
  (`install-cron.sh`), so every layer below must hold. Do not remove any of them:
  1. `listAwaiting()` returns ONLY `awaiting_approval` — a `submitted` entry can never be picked up.
  2. **A submit during a fill run closes out the queue entry.** `applyJob` marks the entry
     `submitted` when a terminal confirmation or grace-wait approval submits. Skipping this is
     how a terminal-approved job gets submitted again by cron, which finds the same APPROVE
     reply still unprocessed.
  3. **Write-ahead `submitting`.** Set immediately BEFORE the submit attempt. If the run dies
     between the click and recording the result, the entry stays `submitting`, is excluded from
     `listAwaiting()`, and is NEVER auto-retried — the poller reports it for manual confirmation
     on the ATS. Only a genuine "nothing was submitted" outcome resets it to `awaiting_approval`
     (which leaves the reply unprocessed, so the retry path still works).
  4. **Ledger cross-check.** `hasSubmittedBefore` is consulted before touching a live form; if
     the ledger and the queue disagree, `submitted` wins. Re-submitting is not undoable.
  5. **Atomic lock.** `data/.approvals.lock` is created with `wx` so the check and the claim are
     one operation — a stat-then-write race would let two pollers submit the same job.
  6. `processedReplyIds` stops one reply from ever acting twice, and the driver's
     `isAlreadyApplied` page check is the last line of defence.
- **Approval matches the UNIQUE CODE ONLY — never company name.** `checkApprovalOnce` requires the
  job's 6-letter code to appear in the reply. Matching by company cross-contaminates roles at the
  same employer: an approval for one (e.g. Cybernetic Labs WVJGTG) would submit another (KDUGRO).
  A job with no code is never auto-acted. Do not reintroduce company/title matching.
- **"Do not submit" means `NO_SUBMIT=1`, not a short grace.** A grace-wait can still submit on a
  detected approval. When the user says don't submit, run with `NO_SUBMIT=1` — it QUEUES the job
  for review in the website but never submits during the fill.
- **Structured answers come from `TurnLoopResult.answers`** — that is what the website's review
  page, the replay and the queue all read. (It also fed the old HTML review email, which is gone.)
- **`college_app/` is BACKGROUND, never a source of facts.** Five of Nathan's college-application
  essays, added 2026-09-01, git-ignored like the resume and `Q&A.txt`. They are ~3 years old and
  they CONTRADICT the current sources on measurable things: the essays say the Alviso project
  "secured $30,000 from Silicon Valley Clean Energy" and "recruited 23 people and 5 mentors", while
  the answer store says "$2,000 in grants" and "200+ community members". Both cannot go on an
  application. **THE LATER STORY WINS, and the later story is the RESUME and `Q&A.txt`** — those two
  are the current, curated sources of every number, date, title and claim; `college_app/` is the
  older material. The grouping is by KIND, not by file date: a document dropped in tomorrow does
  NOT outrank `Q&A.txt` just for being new, and being newer on disk is not what makes a source
  authoritative. So this directory is for VOICE and MOTIVATION only, and nothing in it may be copied
  into an answer as fact. Do not "correct" the resume from these essays — if the older figure is the
  right one, the fix is to update `Q&A.txt`, which is what makes it the later story.
  What they are good for: what Nathan cares about and how he works — Sea Scouts guarding Alviso's
  pink lake, a mural design REJECTED by the county and redesigned four times over three months
  after interviewing environmentalists, historians and park rangers; founding Denali-Hacks for
  students with no programming experience and moving it to another school when his own shut down
  mid-project; leading the Alviso environmental dashboard (Raspberry Pi + SparkFun SGP40, Azure,
  Tableau) with a Santa Clara University professor as mentor. The through-line is technology in
  service of a specific place, and organising through setbacks. Useful for a "tell us about a
  project that failed" or "what motivates you" answer; useless and dangerous for a GPA.
- **A FACT LIVES IN MORE THAN ONE PLACE. Changing it in the resume is not enough.** The GPA went
  from 3.53 to 3.44 and all three resume files were updated, but two other sources still held the
  old number and both outrank the resume for any question they match:
  - **`Q&A.txt`** — the seed answer store. `loadAnswers()` rebuilds from it on every read, so a
    stale line there keeps being handed out no matter what the resume says. It had `GPA: 3.53`.
  - **`data/learned-answers.json`** — a correction there beats everything, including the resume and
    the band picker. It held `"For your most recent degree… GPA…" -> "3.5-4.0"`, which for a 3.44
    OVERSTATES — a false claim rather than a gap, and the worst kind of error on an application.
    That form offered `[NA, < 3.0, 3.0 -3.5, 3.6-4.0]`, so `3.5-4.0` was never even an option and
    had been typed by hand. Remove one with a `forget_answers` command; never edit the file while
    the worker is running (it is the single writer).
  - `data/profile.json` caches it too, but is write-only and self-heals on the next `loadProfile()`.
  After changing a fact, run `npm run audit:queue` — the checks are anchored on the resume, so they
  follow the new value on their own and will name every queued application that now misstates it.
  Nine of eleven did.
- **Corrections live in `data/learned-answers.json` and OVERRIDE the seed.** `loadAnswers()` rebuilds
  every entry from `Q&A.txt` on each read, so an answer recorded anywhere else was erased by the next
  read — which is why "remember what I edited" quietly failed for a day. Learned entries are merged on
  top after the rebuild. Editing `Q&A.txt` therefore does NOT change a question you have corrected;
  correct it again (or Forget it) on `/answers`.
- **One address, used everywhere**: `318 Morse Ave, Sunnyvale, CA 94085`, taken from the
  `Home address` fact in the answer store. There is no region-dependent second address.
- **Address parts must all come from the SAME address.** Street, city, state and postal code are
  filled together in `llmAgent`, never inferred field by field — Motorola rejected an application
  with *"94085 is not a valid postal code for Pennsylvania"* because the street came from the
  stored Sunnyvale address while the state was inferred from the resume's Pittsburgh schooling.

## Job identity, storage and failure modes

The reasoning, the measurements and the per-bug history live in **[DESIGN.md](DESIGN.md)** —
sections 4 (identity), 12 (storage) and 15 (failure modes). Keep that file in step with any
change here; do not duplicate its narrative back into this file. The rules that must hold:

- **Identity is layered and redundant.** `sameJob()` matches on ANY of: company + requisition
  id, `identityKey`, `externalJobId`, normalized apply URL. The requisition id is an
  ADDITIONAL route, never a replacement — `identityKey` stays ATS-derived so old records keep
  matching without migration.
- **Requisition ids are discovered after the page opens** (`withRequisitionId`), because most
  employers print them only in the body. Every caller must work when it is `undefined`.
- **`findCrossAtsDuplicate` hard-blocks** a different listing, already submitted, sharing the
  employer's requisition id.
- **CHECK WHETHER THE POSTING RULES HIM OUT.** Every other guard asks whether the FORM was filled
  correctly; none asked whether he is eligible at all. So a complete, correct, visually-verified
  application sat in the queue for a Pony.ai role whose own text reads *"Currently pursuing a Masters
  or PhD program in Computer Science, Machine Learning, Robotics, or similar field"* — and the
  candidate found it by reading the description himself. `checkEligibility` reports it, quoting the
  posting rather than paraphrasing, because employers do sometimes consider a strong undergraduate
  and that is not a call this code should make silently.
  **The whole difficulty is NOT flagging the inclusive phrasings, which are the majority.** A finding
  needs a requirement phrase AND a graduate degree AND no undergraduate route in the same line — and
  two of the first four findings on the real queue were still wrong: a posting that says "Open to
  current undergraduate students, graduate students, and recent graduates" further up is inclusive
  whatever one later line says, and "If you're enrolled or plan on enrolling in a Master's program,
  use that program's expected graduation month/year" is FORM INSTRUCTIONS. Both are suppressed;
  "Master: $7000/month" is a pay band, not a requirement. Result on 30 queued applications: 2 real,
  0 false. Cases: `npm run test:eligibility`.
- **Never hard-block on company + title.** RTX posts two distinct "Software Engineer Intern"
  requisitions. `classifyJobMatch` returns confidence + `needsHumanConfirmation`, and the review
  page in the website asks the user.
- **Unlabelled digits are not requisition ids** — bare matches need an `R`/`JR`/`REQ` prefix;
  labelled ones may be all digits. Cases: `src/debug/reqIdCases.ts`.
- **`data/applications.json` is operational state; x8note holds the content.** One store per
  job, no second copy of the description.
- **One x8note note per posting**: `save-article` + `upsert: true` keyed on the apply URL, with
  the job CODE in the title (title-only matching merged two different Palantir roles). Never
  go back to `POST /api/notes`.
- **A writer without content must never overwrite content** — `postApplicationNote` reads the
  stored description back when it has none. This exists because a re-sync wiped 30 captured
  descriptions.
- **Labels are the schema, exact-match only**: `jobid_`, `req_`, `source_`, `stage_`, company.
  Mint them only in `noteLabels()`; `PUT` them after `save-article` (which merges).
- **Always pass `notebook` on reads** — the token is a write boundary, not a read boundary.
- **`by-label` for exact lookup, `search` for meaning** (search lags ~2 s; never search
  straight after a write).
- **Nothing reports success without verification.** A fill returns true only when a re-read /
  selection marker confirms it. Returning true after a click is what made a required Workday
  field show a checkmark while staying empty for 18 turns.
- **Labels must carry their question.** Lever cards, checkbox groups and bare `Month`/`Year`
  sub-fields each broke because the option lost its question and the agent answered blind.
- **`page.evaluate()` takes a STRING and it must be an invoked IIFE** — `"(() => {…})()"`.
  A non-invoked arrow silently returns `undefined`.
- **Inside that string, `\s` is the LETTER "s". Every regex escape must be DOUBLED.** A template
  literal has no `\s` escape, so JS collapses it: `.replace(/\s+/g, " ")` written with one
  backslash reaches the page as `/s+/g` and replaces every "s" with a space. `"startDate"` became
  `" tartDate"` and 652 recorded fields carry a mangled label ("tart Date", "fir t Year Attended")
  — while "endDate" and "dateSignedOn", which hold no lowercase s, came through perfect, so it read
  as a few odd labels rather than one broken regex. `\b` is worse: it is a valid escape
  (BACKSPACE), so the honeypot detector's `_bot\b` matched "_bot" followed by U+0008 and never
  fired. The files already MIX correct `\\s` with broken `\s`, which is why it survived — both
  spellings look right and neither errors. `npm run test:escapes` scans every template passed to
  evaluate or opening with the IIFE; half its cases test the SCANNER, because the first version
  skipped every escape and pronounced a corrupting file clean.
- **A label is a KEY, so a mangled label is not cosmetic** — it is how an answer is matched to its
  question in the store, to its approved value on re-fill, and to its block in the visual check.
- **Keep the two outcome lists separate**: `unknown` (never attempted) vs `failedToFill`
  (attempted, refused). Both are logged; neither is silent.

## ATS coverage

Six drivers: Workday, Greenhouse, Ashby, Lever, **Workable** and **Oracle HCM** (opt-in). On the
current 318-listing sweep that is 207 fillable, or 226 with `ORACLE_ATS=1`. `detectAtsType` also
classifies SmartRecruiters so an unopened listing can say WHY. Cases: `npm run test:ats`.

- **A honeypot is read as an ordinary field unless something stops it.** Oracle HCM ships
  `<input name="honey-pot" aria-hidden="true">` on its apply screen and it PASSES the
  offsetParent/getClientRects test `read()` uses, so it was fillable — and filling a honeypot
  announces us as a bot on every application. `isBotTrap` in `GenericDriver.read()` drops it, for
  every ATS, not just Oracle.
  **The test is narrow on purpose: `aria-hidden="true"` or a honeypot-ish name. NOT size or
  clipping.** That is exactly how a custom-styled checkbox hides its real input, and Oracle's own
  REQUIRED "I agree with the terms and conditions" box is 0x0 and clipped — skipping it would
  leave a required field unfillable and stall the run on the required-field gate, a worse failure
  than the trap. Verified live: the apply screen reads 2 fields, the consent box and not the trap.
- **A consent overlay eats the Apply click, and it looks like "Apply did nothing".** The banner is
  fixed-position and animates out; a click issued in the same tick lands on the banner, the URL
  never changes, and nothing says why. Cost a debugging pass on BOTH Workable and Oracle. Dismiss
  consent, WAIT for it to go, then click.
- **Oracle HCM is an SPA and cannot be deep-linked.** Going straight to `…/job/{id}/apply/email`
  renders ZERO fields; the same URL reached by clicking Apply Now renders the form. It also
  redirects on first load, which destroys the execution context mid-`evaluate` — a read issued too
  early fails with *"Execution context was destroyed"* and looks like an empty page. Wait for the
  control, never sleep and hope: a fixed settle clicked nothing and reported `0 field(s)`.
- **Oracle stops at the authentication gate, and that is a decision not a bug.** The tenant wants
  an email before the form — "your profile will be created automatically" — so continuing CREATES
  A CANDIDATE PROFILE at that employer, usually via an emailed verification code. `atAuthGate()`
  recognises it and `next()` refuses with a sentence saying so, rather than stalling namelessly.
  This is why Oracle is behind `ORACLE_ATS=1`.
- **SmartRecruiters is behind DataDome — do not add a driver without a plan.** The first automated
  apply click returned *"Access is temporarily restricted — we detected unusual activity from your
  device or network"*, naming the IP, and served a CAPTCHA. "Never try to defeat explicit
  CAPTCHAs" applies, and retrying degrades the reputation of an IP every other ATS in the run
  shares. 9 roles are not worth that. It is detected and counted, never opened.
- **Workable is single-page** (`apply.workable.com/{co}/j/{ID}/` → `/apply/`), no login, clean
  `name` attributes. A withdrawn posting 302s to `/{co}/?not_found=true` — the company's job
  SEARCH page — and building the apply URL from the post-redirect location produced
  `/{co}/apply/`, whose search filters (Workplace type, Location, Work type) then read as
  application fields. Derive it from the URL we arrived with, and bail on `not_found=true`.
- **Verify a new driver with the real driver.** `npx tsx src/debug/probeDriver.ts <url>` runs
  detect → openApplication → resolveRoot → read and prints the snapshot, filling nothing. It also
  runs `applyJob`'s expiry check first — without that it reported a withdrawn posting as a 5-field
  form. `src/debug/inspectAts.ts <url>` is the rawer DOM dump, and flags bot traps.

## Workday-specific implementation notes

Discovered from live DOM inspection (F5 / Cohesity applications):

- **Sign In button**: The real clickable element is `<div role="button" data-automation-id="click_filter" aria-label="Sign In">`.
  The underlying `<button type="submit" aria-hidden="true" data-automation-id="signInSubmitButton">` has `tabindex="-2"` and is NOT clickable. Always click `[data-automation-id="click_filter"][aria-label="Sign In"]`.
- **"Save and Continue" button**: `[data-automation-id="pageFooterNextButton"]` — always try this first.
- **Final Submit button**: `[data-automation-id="pageFooterSubmitButton"]` — signals the review page.
- **Form fields**: All follow `[data-automation-id="formField-{name}"]` wrapper pattern (e.g., `formField-country`, `formField-addressLine1`, `formField-phone-device-type`).
- **Custom comboboxes**: `[role="combobox"]` — click to open, then pick from `[role="listbox"] [role="option"]`.
- **"How Did You Hear About Us?"**: Open combobox, prefer college/university > company website > LinkedIn > job board.

### Workday failure signatures seen live (2026-08-21 batch: 1/17 reached Review)

A failure taxonomy, because the log line alone does not tell you which of these it is. `0 field(s),
submitReady=false` followed by `No next control — stopping` means **we are not on the form** — do
not go looking for a filling bug.

| Signature | Cause | Fix |
|---|---|---|
| `0 field(s)` + `No next control`, page is in French ("Postuler", "Ouvrir une session") | the URL carried a `/fr-CA/` locale — 7 of 49 Workday URLs in the live list, ALL RTX | `workdayEnglishUrl()` rewrites the locale to `en-US` before `goto`. **5 of 11 failures in one batch.** |
| `0 field(s)` + `No next control`, page shows "Sign in with Google / OR / Sign in with email" | a sign-in METHOD chooser before the credential form (NVIDIA). No inputs, no footer button, so the reader sees nothing | `chooseEmailSignIn()` takes the email branch. Never drive the SSO branch — it leads into Google's consent flow. |
| Same N fields re-answered every turn, `form error: … is not a valid postal code for …` | a **required State field the reader did not report**, so the form keeps its own default (Pennsylvania) while street/city/postal say Sunnyvale | UNRESOLVED — see below |
| `posting expired/closed` | genuinely closed | nothing to fix |

**The locale is not cosmetic.** Filling a French form would be worse than failing: every field
label would miss the answer store too. `normalizeUrl` folds the locale as well, so the same
posting in two languages is ONE job — without that, `/fr-CA/` and `/en-US/` of one requisition
dedupe as different listings and could both be applied to.

**The State field, unresolved.** GE Vernova DUSKAZ and Northrop GXGMCV both filled Address Line 1,
City and Postal Code and never touched State — the screenshot shows it present and required, and
the reader has filled `State` 33 times on other tenants, so the pattern in `llmAgent`'s address
block is right and the field is simply absent from the snapshot on these pages. Suspected: a
dependent dropdown whose options load only after Country/Territory resolves, so it is read with no
options and dropped. Needs a live DOM dump (`src/debug/inspectMyInfo.ts`) to confirm before
changing the reader. Until then the run stops fast and says why, instead of burning sixteen turns.

**A Workday taxonomy can offer a CHOOSER instead of the list.** Seen on RTX's and Intel's
`Education — Field of Study*`: the prompt returns two rows, `Partial List (First 500 Entries)` and
`All`, neither of them a field of study, so every search reported "no match for Computer and
Information Science" and a REQUIRED field stayed empty. `listChooserRow` clicks through and the
options are re-read one level down, preferring `All` — the answer may be outside the first 500, and
a partial list that lacks it looks identical to a taxonomy that lacks it. It requires EVERY row to
be list navigation: `All` beside `United States` is a real answer, and clicking through that would
discard the options we came for. Cases: `npm run test:chooser`.

**FIXED — was: a workday-select fill reported success without committing.** The fill is now
verified by reading the button text back (its text IS its value), so a pick that did not land is
reported as a failure. It earned itself immediately: it caught the agent answering a yes/no with
"English", from option capture reading a stray menu (also fixed — Escape first, then scope to
aria-controls).

 RTX ZJQCPS now reaches
the application-questions page, and `What is your Current Degree Program?` logs `✓` while the form
still answers `The field … is required and must have a value`. So `fillReactSelect` is returning
true for an `aria-haspopup="listbox"` control whose selection did not stick — a FALSE SUCCESS,
which is the one thing the fill path is not allowed to do ("Nothing reports success without
verification"). Reading the button back turned out to be exactly right, and it works.

**Do not shorten FIELD_TIMEOUT_MS.** It is 90s. Lowering it to 30s (2026-08-21) broke
"Country Phone Code*" on RTX — the 250-entry list reached by bisecting the scroll position — which
had succeeded at 90s. `longListCases` reports 4.2s for that field, but it drives ONE field on a
freshly opened page; mid-form the same field is far slower. Two separate bugs this session came
from trusting that isolated timing (see also the reverted combobox early-out). The cost of a field
that will never accept a value belongs to whatever DETECTS that, not to a deadline short enough to
fail the slow ones too.

**A form that is rejecting the page gets one turn, not sixteen.** `turnLoop` breaks as soon as a
blocking `validationErrors()` message repeats with nothing newly filled. DUSKAZ spent ~10 minutes
re-answering thirteen fields against an error that never changed.

**Workday renders ONE Work Experience row and waits for a click on "Add Another".** Nothing ever
clicked it, so every application carried one job out of the seven on the resume — and the review
screenshot showing a single experience read as a truncated screenshot rather than a missing
employment history. `expandRepeatedBlocks` runs BEFORE `read()` (same reason as `pruneSkills`) and
confirms each click by RE-COUNTING; rows are counted by the field every row must have (Job Title,
Company, its own Delete control), because `panelSet-` wrappers and headings numbered "Work
Experience 2" both read 0 on a real tenant and a count pinned at 1 reported a working click as
broken. `MAX_EXPERIENCE_BLOCKS` overrides the count for a form that will not take that many; the
DEFAULT is the resume's own count, because the readiness gate has always insisted on the full
history — TMEIC went from "only 1 of 7 work-experience entries" to "only 6 of 7" and was still
refused, so a cap that fights the gate spends the rows and delivers nothing anyway.

**A Workday date part is a TWO-DIGIT spinbutton — a single digit never commits.** Answered "1", it
treats the entry as part-typed and discards it on blur, so Michelin's Start Date kept the resume
autofill's 12/2025 while the answer on record said 1/2025. `datePartValue` pads month/day and takes
month names; it refuses to invent (a 13, a 40 or a sentence passes through untouched). The same run
proved the general rule: `fill()` must READ THE VALUE BACK, never `fill().catch(() => undefined);
return true`. It refuses only on EMPTY — inputs reformat, and treating that as failure would retry
fields that are already right. Cases: `npm run test:dateparts`.

**`observedFields` is per PAGE, newest read wins.** It was a first-sighting map, so a field the form
REMOVED stayed on the record as required and unanswered: ticking "I currently work here" makes
Workday drop that row's To date, and the readiness gate then refused a finished application over a
field with no box on the page. Per page because the union across pages IS a multi-page form — My
Information's fields are legitimately absent while on My Experience. An empty read replaces nothing.

**A GPA band question that says "degree" is still a GPA question.** "What is your cumulative GPA for
your 4 year degree on a 4.0 scale?" tripped the do-not-invent rule, which refused the correctly
derived band and left the field holding "Below 2.60" from an earlier DRAFT — Workday saves
part-finished applications, so a re-run opens a form carrying whatever the last run typed. Two
consequences, both now enforced: a band is derived arithmetically and validated by `checkFacts`, so
it is never an "invention"; and a PREFILLED value gets the same fact check a stated one does — a
contradiction is not recorded, and the application is BLOCKED rather than presented for approval
with a false answer in it. `parseGpaBand` also reads "Between 3.00 and 3.49": that separator was
missing, so the only rungs it could see were the top and the bottom, and the gate then EXCUSED the
understatement as the best on offer.

**A closed list may name a record differently, and that is not a guess.** "What is your current
major?" offers ten options here; the stored "Computer and Information Science" is not among them,
so the model's answer was refused and the question went out blank — while the resume's "Information
Systems" names "Information Systems Technology" token for token. `optionForRecorded` does the
mapping and only accepts an option that spells the record out; ambiguous or absent still refuses,
so it never settles for "Other". The store also files a major under **"Field of Study"** — a
one-directional alias, for records-only questions.

**"How did you hear about us?" is a TREE and chasing LinkedIn down it is the wrong goal.** Tier one
is Campus Campaign | Career Websites | Employee Referral | Job Board | Other | Social Media, with
LinkedIn nested under Social Media. A recorded "LinkedIn" matches nothing, so the fill scrolls a
list that cannot scroll and leaves a REQUIRED field empty. Campus first, and **Career Websites is
acceptable** — both are tier one. The preference now applies on the react-select path too, which is
what actually drives this control.

**An exclusive checkbox group needs the boxes to be CONTIGUOUS, not alone.** The CC-305 disability
trio sits in a container that also holds Name, Employee ID, Date and Language, so the
"nothing-but-checkboxes" climb found no group, the question was never attached, and the agent
answered No to all three — leaving "Please check one of the boxes below:*" with nothing ticked. The
second path accepts 2–15 checkboxes with no other input BETWEEN the first and the last, and takes
the question from the last label PRECEDING the first box (the container's first label is "Name").

### Workday auth flow (complete)

```
job posting page
  → click "Apply" (or "Continue Application" → jumps directly into form)
  → "Start Your Application" dialog
      → prefer "Use My Last Application" (skips auth)
      → else click "Autofill with Resume"
  → Create Account page (if no existing account)
      → click "Already have an account? Sign In" link
  → Sign In page (modal or full page)
      → fill email + password
      → click [data-automation-id="click_filter"][aria-label="Sign In"]
  → Resume upload ("drop file here" / "select file")
      → setInputFiles(RESUME_PATH)
      → wait for "Successfully Uploaded"
      → click Continue
  → My Information page (form filling begins)
```

## Reference

- **[DESIGN.md](DESIGN.md)** — how the system works and why each guard exists (read this
  before changing form reading, identity, approval or storage).
- **[QUICKSTART.md](QUICKSTART.md)** — fresh clone → first filled application. Keep the required
  local files, the `.env` keys and the start commands here in step with it.
- **[README.md](README.md)** — flags, layout, and what runs where.

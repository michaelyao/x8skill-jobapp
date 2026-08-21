# CLAUDE.md — x8skill-jobapp

## What this project does

Playwright + TypeScript automation that applies to US software engineering internships
(Summer 2027) from the trackers listed in `job_sites.txt` — Simplify, vanshb03, interndock.

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
| `text version.txt` | Plain-text resume / profile |
| `Q&A.txt` | Seed Q&A pairs (`Q: …` / `A: …` format) |
| `2026 Nathan Yao's Resume - CS.pdf` | Resume uploaded to ATS forms |
| `unofficial_academic_record.pdf` | Transcript uploaded when requested |
| `.env` | Workday login credentials + Gemini API key (see below) |

## .env format

```
WORKDAY_EMAIL=you@example.com
WORKDAY_PASSWORD=yourpassword
GEMINI_API_KEY=your_key_here
GOG_KEYRING_PASSWORD=your_gog_keyring_passphrase
```

`GOG_KEYRING_PASSWORD` is **not** a Google credential — it is the local passphrase encrypting
gog's OAuth token file. It belongs in `.env` because launchd services do not read `~/.zshrc`:
without it every send under the daemon fails with *"no TTY available for keyring file backend
password prompt"* while the same code works by hand. An app password would not help; gog uses
the Gmail API over OAuth, not SMTP.

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
- **One website, in Docker on 8088; the worker native as a LaunchAgent.** Decided 2026-08-21.
  A second native website on 8088 ran the same app against the same `data/` for no benefit —
  don't reintroduce it. `install-services.sh` installs the WORKER only; the native website
  daemon is opt-in behind `--with-website-daemon` (port 8088, so it cannot clash with the
  container). Two websites sharing `data/` is *safe* if you ever want the fallback — the
  website never writes application state (the worker is the single writer) and the derived
  files it rewrites on read are written atomically with identical content — but safe is not the
  same as useful.
- **Recovery waits for a login, and that is the chosen design.** Decided 2026-08-21: auto-login
  is NOT wanted — someone always signs in after a reboot. Do not re-propose it, and do not add a
  boot-time workaround for it. The chain is: login → Docker Desktop (a login item) → website +
  scheduler (`restart: unless-stopped`) → worker LaunchAgent (`RunAtLoad`). Every link is
  automatic ONCE that session exists, so there is nothing to run by hand after a reboot; the only
  property being given up is starting before anyone signs in. `install-services.sh` therefore
  does not prompt for auto-login (`--autologin` still sets it if that ever changes).
- **LaunchAgents load at GUI login, not at boot — which is why a website daemon is the only
  thing that can start without one.** A reboot with nobody signed in leaves an agent absent and the logs
  silent; from SSH, `launchctl managername` is `Background` and
  `launchctl bootstrap gui/$(id -u) …` fails with `125: Domain does not support specified
  action` (`open -a Docker` fails identically). IMPORTANT correction to an earlier claim: the
  `gui/$(id -u)` domain IS reachable over SSH once somebody is logged in — `bootout` and
  `bootstrap` both work then. The 125 happens only when NO GUI session exists. So "it failed
  from SSH" is not evidence about the mechanism; re-check `launchctl list` after a login before
  concluding a service is missing. (Two workers ran at once on 2026-08-21 because a GUI login
  had quietly loaded the agent while a hand-started one was already going.) `--with-website-daemon`
  runs as the USER not root — root-owned files in `data/` would be unwritable by the worker —
  and invokes `web/node_modules/.bin/next` directly, never `npx`, which wants a writable npm
  cache under `$HOME`. Headed Chrome *does* launch over SSH (Playwright spawns the binary
  directly), so `./worker-start.sh` is the stopgap.
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
- **The 8-hour tick lives in the container, the work happens in the worker.** `src/scheduler.ts`
  runs as its own compose service (`jobapp_scheduler`, same image) and only ever writes a command
  file — no browser, which is why it can live where there is no Chrome. It enqueues ONE `sweep`
  with `refreshList`, and the worker does the rest. It is an interval, not a wall-clock cron:
  "every 8 hours" is about noticing new postings, so drift is irrelevant and a restart checks
  immediately instead of waiting for a slot. It SKIPS a tick when a sweep/refresh/apply is still
  queued, or when the worker is stale — otherwise a slow batch would have two more stacked behind
  it. Its own service rather than cron in the web container: that image has no cron, and adding
  one means supervising two processes in a container built to run one.
- **The image ships compiled JS, not tsx.** `Dockerfile.jobapp_website` runs `tsc -p tsconfig.json` in the
  builder and copies `dist/`, so the scheduler and the in-container `jobapp` run on plain node.
  Anything running `dist/*.js` needs an ABSOLUTE path and `working_dir: /app` — the image's
  WORKDIR is `/app/web` for `next start`, so a relative `dist/scheduler.js` resolves to
  `/app/web/dist/` and dies with MODULE_NOT_FOUND.
- **Credentials stay in `.env`.** `profile.ts` must read them from `process.env`, never hardcode.
- **profile.json must not contain `loginPassword`.** It is stripped in `profile.ts` before writing.
- **Simplify parsing reads the raw GitHub URL** (`raw.githubusercontent.com`), not the rendered page.
  The raw README uses HTML `<table>/<tr>/<td>` inside markdown, so the HTML regex parsers work.
- **Tracker sheet access is browser-driven.** The code navigates to the sheet URL in the headed
  browser (so the user's Google session applies), then exports CSV from the same authenticated
  context. Do not replace this with OAuth or API key approaches.
- **Learning mode pauses and waits for user input** when a form field has no known answer.
  The terminal bell rings and the user fills the field manually in the browser.
- **Required-field gate.** The turn loop must never advance (or reach Review) while a REQUIRED
  field is still empty. `read()` reports `filled` per field; `turnLoop` re-reads after each fill
  pass, retries the stragglers, and if a required field stays empty it STOPS and reports
  `blockedRequired` rather than clicking Next. Do not remove this gate.
- **Approval is decoupled — the fill run NEVER blocks for a long approval.** Approval can take days.
  Phase A (`npm start` → `applyToJob` mode `"fill"`): fill → reach Review → email → short grace
  wait (`APPROVE_TIMEOUT_MS`, default 2 min) → **enqueue to `data/pending-approvals.json`** → move on.
  Phase B (`npm run approvals`, run by cron every 15 min via `approvals-cron.sh`): scan the inbox and
  classify each reply three ways — **APPROVE / SKIP / CHANGE**.
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
- **An APPROVE sent from the monitored account counts.** The review email goes to both
  `nyao2@` and `myao@studiox8.com`, so a reply written from `myao@` is labelled `SENT` by
  Gmail. Skipping every `SENT` message — the old behaviour — silently ignored those
  approvals. The message to skip is OUR OWN outgoing review copy, and the subject is what
  separates them: our copy is not a reply (`Review & Approve: …`), a reply is (`Re: …`).
  Never widen this back to "skip all SENT", and never drop the check entirely — our own
  review body contains the word APPROVE in its instructions, so reading it as a reply
  would auto-act on every job.
- **Approval matches the UNIQUE CODE ONLY — never company name.** `checkApprovalOnce` requires the
  job's 6-letter code to appear in the reply. Matching by company cross-contaminates roles at the
  same employer: an approval for one (e.g. Cybernetic Labs WVJGTG) would submit another (KDUGRO).
  A job with no code is never auto-acted. Do not reintroduce company/title matching.
- **"Do not submit" means `NO_SUBMIT=1`, not a short grace.** A grace-wait can still submit on a
  detected approval. When the user says don't submit, run with `NO_SUBMIT=1` — it emails the review
  and QUEUES the job (so the poller can submit later on approval) but never submits during the fill.
- **Review email is HTML** (`gog --body-html`, plain-text fallback): bold questions, a distinct green
  `A:`, a "draft" badge on LLM free-text, a meta table with the posting link, and the JD in a framed
  box. Structured answers come from `TurnLoopResult.answers` (also what the replay/queue use).
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
- **Never hard-block on company + title.** RTX posts two distinct "Software Engineer Intern"
  requisitions. `classifyJobMatch` returns confidence + `needsHumanConfirmation`, and the
  review email asks the user.
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
- **Keep the two outcome lists separate**: `unknown` (never attempted) vs `failedToFill`
  (attempted, refused). Both are logged; neither is silent.

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

**OPEN BUG — a workday-select fill reports success without committing.** RTX ZJQCPS now reaches
the application-questions page, and `What is your Current Degree Program?` logs `✓` while the form
still answers `The field … is required and must have a value`. So `fillReactSelect` is returning
true for an `aria-haspopup="listbox"` control whose selection did not stick — a FALSE SUCCESS,
which is the one thing the fill path is not allowed to do ("Nothing reports success without
verification"). Reading the field back is not enough here either: the button text may update
optimistically. Next step is to re-read via the same `read()` pass after the click and compare, and
to check whether the click lands on the option row or on a wrapper. Until then this field blocks
RTX (5 listings).

**A form that is rejecting the page gets one turn, not sixteen.** `turnLoop` breaks as soon as a
blocking `validationErrors()` message repeats with nothing newly filled. DUSKAZ spent ~10 minutes
re-answering thirteen fields against an error that never changed.

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
- **[README.md](README.md)** — quick start and flags.

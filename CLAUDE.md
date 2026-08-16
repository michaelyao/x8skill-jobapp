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
  email poller and the console worker. It previously existed twice and the copies had already drifted.
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
- **Address logic**: west coast jobs (CA/WA/OR/WA) → `318 Morse Ave, Sunnyvale, CA 94085`;
  east coast → `4716 Ellsworth Ave Apt 703, Pittsburgh PA 15213`. Resume autofill usually picks
  the right one; override when wrong.

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

# CLAUDE.md — x8skill-jobapp

## What this project does

Playwright + TypeScript automation that applies to US software engineering internships from the
[Simplify Summer 2026 list](https://github.com/SimplifyJobs/Summer2026-Internships).

It reads fresh job listings (posted 0–1 days ago), checks a private Google Sheets tracker for
already-applied jobs, then autofills Workday / Ashby / Greenhouse forms using local profile data
and a learned Q&A store. **It never clicks the final submit button** — the user reviews and submits
manually.

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
```

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
  - **APPROVE** → `applyToJob` mode `"submit"` with a `ReplayAgent`: re-open and **replay the EXACT
    approved answers** (stored in the queue), no LLM, then submit. Guarantees submitted == approved.
  - **CHANGE** (reply asks for an edit) → `applyToJob` mode `"fill"` with `changeInstruction`: LLM
    re-fills applying the correction, emails a **fresh review**, requeues awaiting. The original reply
    is marked processed (`processedReplyIds`) so it never re-triggers; only a new APPROVE acts next.
  - **SKIP** → dropped.
  A lockfile + profile-busy guard keep the poller from colliding with an active fill run. Submit still
  happens ONLY on an emailed APPROVE (or the terminal grace-wait "submit").
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
  detected approval. When the user says don't submit, run with `NO_SUBMIT=1` — it emails the review
  and QUEUES the job (so the poller can submit later on approval) but never submits during the fill.
- **Review email is HTML** (`gog --body-html`, plain-text fallback): bold questions, a distinct green
  `A:`, a "draft" badge on LLM free-text, a meta table with the posting link, and the JD in a framed
  box. Structured answers come from `TurnLoopResult.answers` (also what the replay/queue use).
- **Address logic**: west coast jobs (CA/WA/OR/WA) → `318 Morse Ave, Sunnyvale, CA 94085`;
  east coast → `4716 Ellsworth Ave Apt 703, Pittsburgh PA 15213`. Resume autofill usually picks
  the right one; override when wrong.

## Job identity — what makes two listings "the same job"

An ATS posting id identifies a **listing**, not a **job**. The same opening is often posted
through more than one channel, each with its own id, so ATS ids alone allow applying twice.
Identity is therefore layered, strongest first, and every layer is stored per job in
`data/applications.json` (history) and `data/pending-approvals.json` (in-flight state).

| Signal | Field | Strength | Availability (measured on live postings) |
|---|---|---|---|
| Employer's requisition id | `companyReqId` | **Spans ATS** — the only signal that catches the same job on a second board | Workday nearly always (`R73630`, `R265684`); Greenhouse sometimes (`JR11987`); Lever/Ashby never |
| ATS posting id | `externalJobId` | Exact listing | Greenhouse `/jobs/<n>`, Ashby/Lever UUID, else `sha1(url)` |
| `company::externalJobId` | `identityKey` | Exact listing; the ledger's primary key | always |
| Normalized apply URL | `normalizedApplyUrl` | Exact listing | always |
| 6-letter code | `code` | Human/email handle, `fnv1a(url)`; the ONLY thing approval replies match | from the CSV build |
| Company + title (+ location, description overlap) | — | **Suspicion only, never a decision** | always |

- `sameJob()` matches on **any** hard route, so a job stays recognisable when one identifier
  changes. The requisition id is an *additional* route — `identityKey` stays ATS-derived so
  records written before requisition ids existed keep matching. No ledger migration.
- **Requisition ids are usually only in the page body**, so identity is *upgraded* after the
  posting opens (`withRequisitionId`), not fixed at CSV-read time. Anything downstream must
  work when it is `undefined`.
- `findCrossAtsDuplicate` hard-blocks the case ATS ids cannot see: a **different** listing,
  already submitted, sharing this employer's requisition id.
- **Never hard-block on company + title.** RTX posts two distinct "Software Engineer Intern"
  requisitions (Burnsville MN and Largo FL); merging them would silently drop a real
  application. `classifyJobMatch` returns `possibly_same_job` with a confidence score and
  `needsHumanConfirmation`, and the review email asks the user — approving submits it as a
  separate application, `SKIP` treats it as the same job.
- Bare all-digit strings are only accepted as requisition ids when **labelled** ("Job ID:
  01865635"); unlabelled digits collide with years, salaries and counts. Unlabelled matches
  require a letter prefix (`R`/`JR`/`REQ`). See `src/debug/reqIdCases.ts`.

## Playbook — diagnosing a field that won't fill

Most failures here are *form-reading* failures, not logic failures. The log line tells you
which kind, and each kind has a different cause. Read this table before touching code.

| Log signature | What it means | Where to look |
|---|---|---|
| `✗ could not fill: X` | An answer existed; the driver's fill returned false | `fill()` / `fillReactSelect` in `drivers/base.ts` |
| `answered N/N fields` but **no ✓ and no ✗** for X | The answer was discarded as `needsHuman` and silently skipped (non-interactive runs have no `onLearn`) | the guardrails in `llmAgent.ts` — usually the option-allowlist check |
| `✓ X` then X is in `still empty — retry pass` | Fill claimed success but the re-read says empty; the widget rejected the value | `read()`'s `filled` detection, or a value the widget silently reverted |
| Label is a raw `name` attribute (`cards[<uuid>][field5]`, `formField-…`) | Every `labelFor()` path missed; it fell through to `name` | `labelFor()` in the `READ_SCRIPT` |
| `Could not parse <provider> response as JSON` | Usually the reply was **truncated**, not malformed — check whether it ends mid-object | `max_tokens` first, then `stripToJson` |

**Method that works — never guess at DOM structure:**

1. Get the posting URL from the queue or `logs/<run>/filtered-jobs.json`.
2. Write a throwaway Playwright script (`_t_*.ts` — gitignored) that opens the live form and
   dumps the ancestor chain, classes, `role`, `aria-*`, and label candidates for the field.
3. Then verify with the **real driver**, not a reimplementation: `driver.read()` → check the
   `FieldSpec`, `driver.fill()` → re-read and confirm `filled` plus the value the control shows.
   A fix isn't done until the re-read agrees.
4. Delete the scratch script; keep anything durable as a `src/debug/` script.

**Async ("searchable") comboboxes — the big one.** A type-to-filter combobox serves only a
*slice* of its options before you type: Greenhouse's School field returns 100 alphabetical
entries starting at "Aalborg University". So:

- A captured option list is a **sample, never an allowlist**. `FieldSpec.searchable` marks these;
  the agent must not reject an answer for missing the sample.
- Rejecting-by-sample is invisible: it becomes `needsHuman`, which non-interactive runs skip
  silently, and the required-field gate then blocks the whole job on one field.
- Never widen a guardrail without keeping a real gate. It stays safe here because
  `fillReactSelect` can only ever **click an option that exists** — a wrong value fails loudly
  instead of being typed in as free text.
- Menus resolve asynchronously and render `Loading...` first. **Poll for options**; a fixed wait
  is a race that reads zero options and looks like "the menu never opened".

**Label reading.** Each ATS hangs the question text somewhere different, and the option-stripping
step (which removes option text like "Yes"/"No" from a radio group's question) can erase a wrong
guess down to an empty string, which then falls through to the raw `name`. Known containers:
`[data-automation-id^="formField"]` (Workday), `[class*="fieldEntry"]` (Ashby),
`[class*="application-question"]` (Lever — text is in a sibling `.application-label`, so the
control's own container holds only the option list).

**Retrying a job after a fix.** A blocked run is recorded `prefilled_pending_submit`, which
`hasAppliedBefore` treats as engaged — so it is skipped forever and a form fix would only ever
help *new* postings. Use `JOB_ID=<CODE> FORCE_RETRY=1` to re-open it. `FORCE_RETRY` cannot
override a `submitted` / `already_applied_on_site` record (that would duplicate a real
application) and does not override a tracker-sheet match.

**LLM replies.** Field-heavy pages with drafted free-text blow past a small `max_tokens` and get
cut mid-array; the parse error is the symptom, the token limit is the cause. `stripToJson`
tolerates an unpaired ``` fence and repairs a truncated array by keeping the objects that arrived
whole — and logs what it recovered, because a silent partial fill looks like a complete one.

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

## Milestones (from DESIGN.md)

- [x] M1 — TypeScript + Playwright setup, profile parsing, Simplify ingestion
- [x] M2 — Tracker sheet reading, job identity, dedupe
- [x] M3 — Base adapter, Workday with auth + learning mode
  - [x] Full auth flow mapped (Create Account → Sign In link → Sign In modal)
  - [x] `click_filter` data-automation-id for Sign In button
  - [x] `pageFooterNextButton` for Save and Continue
  - [x] `pageFooterSubmitButton` for final Submit detection
  - [x] Resume upload in auth flow (after sign-in)
  - [x] Combobox handling for "How Did You Hear About Us?"
  - [x] Gemini API key wired in `.env` (for future semantic matching)
  - [ ] Address override when autofill picks wrong coast
  - [ ] Full end-to-end test against a fresh Workday job
- [ ] M4 — Ashby + Greenhouse polished, screenshots on error
- [ ] M5 — Matching refinement, prep for skill packaging

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

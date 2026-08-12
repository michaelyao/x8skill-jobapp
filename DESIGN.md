# Job Application Automation Design

## Goal

Build a Playwright + TypeScript project that:

1. Reads the Software Engineering Internship Roles section from the Simplify Summer 2026 internships list.
2. Only considers jobs marked `0 day ago` or `1 day ago`.
3. Only keeps US roles and skips Canada or international roles.
4. Extracts `company`, `title`, `apply link`, and the posting identifier when available.
5. Compares each job against the tracking Google Sheet, with special care for job IDs and prior application status.
6. Skips already-applied jobs, logs them, and opens only new jobs.
7. Supports major ATS site types in v1:
   - Workday
   - Ashby
   - Greenhouse
8. Autofills application forms using local source files and a learning mode.
9. Never clicks final submit. The automation must stop at the final review/submit step.

This first version is a local project, not yet a reusable skill.

## Inputs

Local files currently present:

- `text version.txt`
- `Q&A.txt`
- `2026 Nathan Yao's Resume - CS.pdf`
- `unofficial_academic_record.pdf`

External sources:

- Simplify internships list:
  `https://github.com/SimplifyJobs/Summer2026-Internships/blob/dev/README.md#-software-engineering-internship-roles`
- Tracking spreadsheet:
  `https://docs.google.com/spreadsheets/d/1Ugo160-wF1YvOtnwNa__7A9Lep9mBR5plEdhJ0oZh-A/edit?pli=1&gid=0#gid=0`

## Proposed Scope For V1

### Included

- Fetch and parse internship rows from the Software Engineering Internship Roles section.
- Filter by recency text (`0 day ago`, `1 day ago`).
- Filter by location text to US-only roles, including US-remote roles.
- Open and normalize application URLs.
- Read the tracking sheet and determine whether a job is already applied.
- Open new jobs in Playwright and attempt autofill.
- Support resumable progress and logs.
- Stop before submission.
- Learning mode for unknown questions.

### Deferred

- Turning this into a reusable skill.
- Full support for every ATS vendor.
- Automatic submission.
- Multi-account or multi-user support.
- Long-term cloud storage.

## High-Level Architecture

### 1. Source ingestion

Module: `src/sources/simplify.ts`

Responsibilities:

- Load the GitHub README page.
- Locate the `Software Engineering Internship Roles` section.
- Parse the job table rows.
- Extract:
  - company
  - title
  - location
  - posted age text
  - apply link
  - simplify/source row metadata
- Normalize the row into a common `JobListing` model.

Notes:

- GitHub README rendering may change, so the parser should prefer DOM/table parsing first and keep a fallback text parser.
- We should preserve the original row text for debugging.

### 2. Filtering

Module: `src/core/filterJobs.ts`

Rules:

- Keep only rows where age text is exactly `0d` or `1d` in the source table.
- Keep only Software Engineering Internship rows from the target section.
- Keep only US roles.

US filter approach:

- Accept rows whose location clearly indicates US cities/states, `United States`, `USA`, or `Remote, US`.
- Accept plain `Remote` when the posting does not mention Canada or another non-US country.
- Reject rows containing `Canada`, non-US countries, or obvious international markers.
- If the location is ambiguous but not explicitly non-US, mark as `manual_review` instead of auto-applying.

### 3. Job identity and dedupe

Module: `src/core/jobIdentity.ts`

Each job should have several identifiers:

- `sourceApplyUrl`
- `normalizedApplyUrl`
- `company`
- `title`
- `location`
- `externalJobId` when derivable
- `atsType`

Job ID extraction strategy:

- Workday: usually `.../job/.../<slug>_<REQ123>` or similar requisition tail.
- Ashby: often UUID in the path.
- Greenhouse: usually numeric job ID in the path.
- Fallback: a stable hash of normalized URL + company + title.

Matching against the spreadsheet should prioritize:

1. Exact `(external job ID + company)` match
2. Exact normalized apply URL match
3. Strong company + title match
4. Company + title + location fuzzy match

If a match is weak or conflicting, send to manual review rather than auto-applying.

Additional already-applied rule:

- If the ATS site itself shows that the user has already applied after login, log the job as already applied and skip it even if spreadsheet matching is incomplete.

### 4. Spreadsheet integration

Module: `src/sources/trackerSheet.ts`

Responsibilities:

- Open the private Google Sheet in headed Playwright using a persistent browser profile.
- Rely on the signed-in browser session rather than CSV export or direct HTTP fetching.
- Read the visible rows from the rendered worksheet.
- Extract the columns needed to compare:
  - company
  - title
  - apply link
  - job ID if present
  - status/applied indicator

Because spreadsheet layouts often drift, the parser should:

- Read the header row first.
- Use header names to find columns rather than hard-coded indices when possible.
- Store a local snapshot of parsed rows for debugging.

If the sheet cannot be parsed reliably, the run should stop with a clear diagnostic.

Important constraint:

- V1 supports spreadsheet access through browser-driven Playwright only.
- We should not depend on `curl`, CSV export endpoints, or undocumented Google Sheets APIs.

### 5. ATS adapters

Module pattern:

- `src/adapters/base.ts`
- `src/adapters/workday.ts`
- `src/adapters/ashby.ts`
- `src/adapters/greenhouse.ts`

Common adapter responsibilities:

- Detect whether the current page matches the adapter.
- Wait for the application UI to become interactive.
- Upload resume and other documents if required.
- Fill standard fields using profile data and learned answers.
- Surface unknown questions to learning mode.
- Navigate to the final review step without clicking submit.

Each adapter should expose methods like:

- `detect(page): Promise<boolean>`
- `prepare(page): Promise<void>`
- `extractQuestions(page): Promise<FormQuestion[]>`
- `fill(page, context): Promise<FillResult>`
- `reachReview(page): Promise<ReviewState>`

### 6. Knowledge and learning mode

Module: `src/knowledge/answerStore.ts`

Data sources:

- `text version.txt`: profile and experience data
- `Q&A.txt`: raw reusable answers

Planned normalized storage:

- Build a generated structured cache, for example:
  - `data/profile.json`
  - `data/answers.json`
- Maintain a cleaned human-readable markdown knowledge file:
  - `Q&A.md`

Learning mode behavior:

1. When the automation sees a field it cannot fill confidently, it pauses.
2. It logs:
   - site
   - company
   - title
   - page URL
   - field label
   - field type
   - available options
   - nearby helper text
3. It prompts the user to answer manually in the browser.
4. It visibly notifies the user that the run is waiting.
5. Proposed v1 notification methods:
   - terminal message with company, title, and unknown field label
   - terminal bell
   - clear wait-state log entry
6. It records what the user selected or entered.
7. It proposes a reusable normalized Q/A entry.
8. It updates the structured answer store.
9. It updates the cleaned markdown knowledge file.

Matching strategy for learned answers:

- Normalize labels by lowercasing, trimming punctuation, and stripping company-specific names.
- Match exact normalized text first.
- Then try semantic buckets such as:
  - work authorization
  - sponsorship
  - prior employment
  - location flexibility
  - demographic self-ID
  - government affiliation
  - internship availability

Confidence rules:

- Auto-fill only when confidence is above threshold.
- Otherwise trigger learning mode.

### 7. Run logging

Suggested output files:

- `logs/run-YYYYMMDD-HHMMSS.json`
- `logs/run-YYYYMMDD-HHMMSS.md`

For each job, store:

- source row data
- filter decision
- dedupe decision
- ATS type
- filled fields summary
- unknown questions
- stopped-before-submit confirmation
- errors/screenshots if any

## End-To-End Workflow

1. Start Playwright in headed mode.
2. Open Simplify GitHub page.
3. Parse the Software Engineering Internship Roles table.
4. Filter to `0d` and `1d`.
5. Filter to US-only roles.
6. Open the Google Sheet and load existing application records.
7. For each candidate job:
   - compute normalized identity
   - compare against the sheet
   - if already applied, log and skip
   - if sheet matching is uncertain, also check for an ATS-native already-applied signal after login
   - if new, open application page
   - detect ATS type
   - run corresponding adapter
   - fill known answers
   - if unknown field appears, trigger learning mode
   - continue until review/submit page
   - stop before submit
8. Write logs and a summary report.

## Project Structure

Suggested initial layout:

```text
src/
  index.ts
  config.ts
  types.ts
  core/
    filterJobs.ts
    jobIdentity.ts
    runner.ts
  sources/
    simplify.ts
    trackerSheet.ts
  adapters/
    base.ts
    workday.ts
    ashby.ts
    greenhouse.ts
  knowledge/
    profile.ts
    answerStore.ts
  utils/
    log.ts
    normalize.ts
    urls.ts
    screenshots.ts
data/
  profile.json
  answers.json
logs/
```

## Playwright Strategy

### Why headed mode

- The spreadsheet and some ATS sites may require active login/session state.
- It makes learning mode practical because the user can step in.
- It is the only supported spreadsheet access path for this private sheet.

### Browser state

We should use persistent browser state so login sessions survive:

- `playwright/.auth/` or similar storage state directory.

This is especially important for:

- Google Sheets access
- Some ATS flows that use anti-bot/session redirects

### Selector philosophy

Because ATS pages differ a lot, selectors should be layered:

1. Accessible labels and roles
2. Known semantic input names
3. Visible text nearby
4. Site-specific fallbacks

We should also capture screenshots and HTML snippets when selector logic fails.

## Data Normalization

### Profile model

The profile parser should extract:

- name
- email
- phone
- addresses
- school
- GPA
- citizenship/work authorization
- links
- experience bullets
- skills

### Answer model

Each learned answer can look like:

```json
{
  "id": "work_auth_us",
  "matchers": [
    "are you legally authorized to work in the country where the job is located without restrictions",
    "are you authorized to work in the united states"
  ],
  "answerType": "single_select",
  "answer": "Yes",
  "confidence": 0.99,
  "source": "manual+curated"
}
```

## Risks And Constraints

### 1. Google Sheets parsing

The sheet is private, requires login, and may render differently depending on account/session state.

Mitigation:

- Use headed persistent context.
- Parse the rendered DOM and grid semantics rather than relying on download/export endpoints.
- Build header-based extraction.
- Save snapshots/screenshots.

### 2. ATS variation within the same vendor

Workday, Ashby, and Greenhouse pages vary by employer configuration.

Mitigation:

- Build adapters around question extraction and generic field filling, not page-specific hardcoding only.
- Add strong error logging and screenshot capture.

### 3. Ambiguous or high-risk answers

Demographic, legal, and compliance fields may need careful handling.

Mitigation:

- Default to learning mode when confidence is low.
- Never guess on sensitive questions.

### 4. Never-submit guarantee

Automation must not accidentally submit.

Mitigation:

- Explicit code guard that forbids clicking buttons with text like `Submit`, `Submit Application`, `Send Application`, or equivalent.
- Optional dry-run mode that stops one step earlier.

### 5. Secrets handling

The current `text version.txt` appears to include sensitive personal data and what looks like a password.

Mitigation:

- Move secrets into `.env` or a local ignored config file.
- Keep structured personal profile data in local ignored JSON.
- Add `.gitignore` before code is committed.

## Recommended Milestones

### Milestone 1

- Initialize TypeScript + Playwright project.
- Parse local profile/Q&A files.
- Parse Simplify listings and filter target jobs.

### Milestone 2

- Read the tracking sheet through headed Playwright.
- Implement job identity matching and skip logic.

### Milestone 3

- Implement base adapter and first-pass Workday support.
- Add learning mode and answer persistence.

### Milestone 4

- Add Ashby and Greenhouse adapters.
- Improve resilience with screenshots, snapshots, and logs.

### Milestone 5

- Refine matching rules and prepare for later skill packaging.

## Confirmed Decisions For V1

- Spreadsheet access is browser-driven only through headed Playwright.
- Remote jobs are allowed.
- Learning mode should visibly notify the user and then wait for manual browser input.
- Learned answers should update both structured storage and a cleaner markdown Q&A file.
- Dedupe should prioritize `(job ID + company)`.
- If the ATS site itself shows the user already applied, log and skip even if sheet matching is incomplete.
- Process all matching new jobs in a run.
- Never click any final submit button; the user submits manually.

## Remaining Open Questions

1. We still need to inspect the live spreadsheet to determine the exact headers and status semantics used for `already applied`.
2. We should confirm whether demographic self-ID fields should be auto-filled or always left for manual review.
3. We should confirm the default address rule for remote roles when no geography-specific office is listed.

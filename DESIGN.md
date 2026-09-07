# Design — x8skill-jobapp

Written for review, 2026-09-07. Every number in it is measured from the live stores on that date,
not estimated. Where the design is weak I have said so rather than described the intent.

The question behind this review is fair: after ~20 days there are **222 ledger records in `error`**
against **68 submitted**. Section 10 answers it directly. Sections 1–9 are what the system does;
section 6 is the worked example — "How Did You Hear About Us?" traced through every layer, because
that one field is the largest single cause in the failure list and it exposes most of the
architecture's real weaknesses in one place.

---

## 1. What it is, and the one rule everything serves

A Playwright automation that applies to US software-engineering internships (Summer 2027) taken
from the trackers in `job_sites.txt`. It builds a job list, skips anything already engaged, fills
Workday / Greenhouse / Ashby / Lever / Workable / Oracle forms from the résumé and a learned Q&A
store, stops at the Review step, and **waits for a human**.

**Nothing is ever submitted without the candidate's approval.** Every other rule exists to protect
that one, and the two failure modes it forbids are asymmetric:

| Failure | Cost |
|---|---|
| We stop when we could have proceeded | A delay. Recoverable. |
| We submit something wrong, or submit twice | **Not recoverable.** It is at the employer. |

So the system is deliberately biased toward stopping. Section 10 shows the price of that bias, and
where the bias has been miscalibrated.

---

## 2. Processes: what runs where, and why

Three things run, and the split is not arbitrary.

```
┌─────────────────────────┐        data/commands/*.json         ┌──────────────────────────┐
│  WEBSITE (Docker :8088) │ ──────── claim by rename ─────────▶ │  WORKER (native, macOS)  │
│  Next.js, no browser    │ ◀─────── data/*.json (shared) ───── │  drives real Chrome      │
│  enqueues commands      │                                     │  the ONLY browser owner  │
│  8-hour tick lives here │                                     │  holds data/.browser.lock│
└─────────────────────────┘                                     └──────────┬───────────────┘
                                                                           │ review screenshot
                                                                           ▼
                                                            ┌──────────────────────────────┐
                                                            │  x8ocr (Docker :8799)        │
                                                            │  paddle → sonnet → gemini    │
                                                            │  answers by callback to :8088│
                                                            └──────────────────────────────┘
```

**The worker is never containerised.** It drives real headed Chrome on the host with the
`playwright/.auth` profile — that profile is the low bot fingerprint the ATS forms need. A Linux
container has no macOS Chrome and no GUI, so containerising the worker would trade the property the
automation depends on for a deployment convenience.

**The website never drives a browser**, so it is containerised, with state bind-mounted at
`/jobapp`. There is exactly one website. The 8-hour tick (`src/scheduler.ts`) runs *inside* that
process because it only ever writes a command file — two websites would mean two tickers.

**Only the worker launches Chrome.** `npm start` is a client: it plans a batch (pure file work) and
enqueues a `sweep`. Chrome is single-instance per user-data-dir, so a second launcher would collide
with a live application mid-fill.

---

## 3. Stores, and the single-writer rule

Five stores, and confusing them has caused real damage, so the boundaries are strict.

| Store | Written by | Meaning | Lifetime |
|---|---|---|---|
| `data/applications.json` — **the ledger** | worker | one record per job, permanent | forever |
| `data/pending-approvals.json` — **the queue** | worker | one entry per decision in flight | dropped once decided |
| `data/commands/*.json` | website, CLI | work requests | claimed by rename, then `done/` |
| `Q&A.txt` + `data/learned-answers.json` | seed file / worker | what the candidate's answers ARE | forever |
| x8note | worker | the job description and answers, one note per posting | forever |

**The worker is the only writer of the ledger and the queue.** The website only ever writes command
files. This is what makes the website safe to restart, rebuild or run in a container.

**Some facts must be written to BOTH stores.** Every dedupe guard reads the *ledger*; the queue is
what the pages show. So `manual_submitted` and `expired` write both — marking only the queue would
leave the next sweep free to re-open a live application. Getting this wrong is how four dead
postings kept being offered to the candidate for a week: the expiry check told the ledger and
nothing else.

**The knowledge store has a precedence order**, and it is not the obvious one:

```
data/learned-answers.json   ← a correction here beats everything
Q&A.txt                     ← the seed; rebuilt on every read, so an edit here is overridden by the above
the résumé (pdf/md/txt)     ← facts: dates, titles, GPA
college_app/                ← VOICE ONLY. Three years old. Contradicts the résumé on figures.
```

A fact lives in more than one place, so changing it in the résumé is not enough. The GPA went 3.53
→ 3.44 and two other stores kept the old number; one of them (`learned-answers.json`) held a band
that *overstated* it, which is worse than a gap.

---

## 4. The command queue and priority

The website and CLI enqueue; the worker claims one at a time by renaming the file (`.claimed`), so
two workers cannot take the same command.

```
rank 0   approve · skip · manual_submit · mark_closed · visual_check     decisions — seconds, a human is waiting
rank 1   update_answers · anything with --now                            work asked for by name
rank 2   apply · retry · change · sweep · refresh_list                   background
```

**Anything the candidate points at jumps the queue.** A re-fill he asked for by name is not
background work; a sweep is. An explicit priority may **promote** a command and never demote it —
`--now` writes rank 1, and `approve` is already rank 0, so `approve --now` used to push his own
approval *behind* the ordinary decisions. Found live with 243 re-runs queued in front of it.

**A sweep enqueues; it does not apply.** `planSweep` (no browser) picks jobs and the worker
enqueues one `apply` each, capped at 10. Applying inline would hold Chrome for as long as ten
applications take, with every decision stuck behind it.

---

## 5. Life of one application

```
claim command
  │
  ├─ guards BEFORE opening anything: already submitted? closed? cross-ATS duplicate?
  │        (all read the LEDGER — a submit is not undoable)
  │
  ├─ openApplication(page)          driver-specific: Apply → dialog → account/sign-in → upload step
  │
  └─ turnLoop.runApplication        ◀── repeats up to 8 turns, one per form page
        │
        ├─ 1. read(root)            → FieldSpec[] { key, label, type, options, required, filled, value }
        ├─ 2. agent.decide(fields)  → FilledAnswer[] { key, value, source }
        ├─ 3. driver.fill(field)    → per field, VERIFIED by reading the value back
        │       └─ on refusal: studyFailedField → knownRemedy → applyRemedy → re-fill
        ├─ 4. required-field gate    → any required field still empty? do not advance
        ├─ 5. visual cross-check     → screenshot → x8ocr → compare to what we recorded
        └─ 6. driver.next()          → verified by the page actually TURNING, not by the click
        │
        ▼
  Review reached → screenshot → queue entry → STOP. Never clicks submit.
        │
        ▼
  human approves on the website
        │
        ▼
  applyToJob(mode:"submit") — re-opens the LIVE form, re-fills from the approved answers,
  compareToApproved(): one difference and nothing is submitted
```

Two properties worth stating separately because they are what makes the thing trustworthy:

**Nothing reports success without verification.** A fill returns true only when a re-read confirms
it. Returning true after a click is what once made a required Workday field show a checkmark while
staying empty for 18 turns.

**A fill run asks the page whether it just applied.** "No next control — stopping" and "Thank you
for applying" are indistinguishable from inside the loop — both mean `read()` found no fields.
`submissionConfirmed()` runs at the end of every run.

---

## 6. Worked example — "How Did You Hear About Us?"

This is the field to review. It is the **single largest cause of failure in the list: 29 records**
(20 as `How Did You Hear About Us?`, 9 as the starred variant). It is also the clearest illustration
of how the layers are supposed to divide, and of how they actually failed.

### 6.1 What the field is

On Mastercard's Workday tenant it is a **tree prompt**: a text box with a small list icon, no
visible dropdown arrow. Clicking it opens three rows, each with a chevron:

```
Job Board                            >
Mastercard's Talent Acquisition Team >
University/College (Campus)          >
```

**Every one of those is a parent.** Handshake — the answer the candidate wants — is a *child* of
Job Board. Clicking a parent drills in; it does not commit a value. The tiers differ per tenant:
Adobe shows six tier-one rows, other tenants show Handshake at the top level.

### 6.2 The intended path through the layers

The architecture says a question is handled at three separate levels, and each has exactly one job:

| Layer | Job | Where |
|---|---|---|
| **Top — meaning** | What IS the answer to this question? | `llmAgent.ts`, `guidelines.txt`, the answer store |
| **ATS — mechanics** | How does *this widget on this tenant* take that value? | `drivers/base.ts`, `drivers/workday.ts` |
| **Guardrail — evidence** | Is the value actually on the screen? | `screenBlocks.ts` + x8ocr |

For this field the top layer holds a decided preference, `HEAR_ABOUT_LADDER`:

```
1. Handshake        under /job board/     ← where these roles are actually found
2. a campus event   (no parent)
3. LinkedIn         under /social/
4… company site, job board, referral, social, other
```

`hearAboutUsPlan(options)` reads the rows currently on screen and returns one of two things:

- `{kind:"pick", option}` — the row to click, or
- `{kind:"expand", parent, want}` — the tier-one row to **open** to reach the child we want.

Asked with Mastercard's three rows it returns, correctly:

```
{ kind: "expand", parent: "Job Board", why: "Handshake, where these roles are found" }
```

and after Job Board is opened, `{kind:"pick", option:"Handshake"}`. The ATS layer opens the parent,
**confirms by re-reading** that the child appeared (a parent that reveals nothing must not read as a
choice), clicks the child, and verifies the commit by reading the control's own text back.

### 6.3 What actually happened, and why

It failed for weeks anyway. The trace from Mastercard DLRHMS:

```
· select[University] 3 option(s): Job Board | Mastercard's Talent Acquisition Team | University/College (Campus)
· select[College (Campus)] attempt 1 — clicked
✗ tried but the field would not take it: How Did You Hear About Us?*
⛔ blocked by 1 empty required field(s)
```

Three defects stacked, and each one hid the next:

**(a) The ladder was never called.** The call site was gated on `idx < 0` — consult the ladder only
when the model's answer is *not* among the visible rows. The model answered
`"University/College (Campus)"`, which **is** a visible row, so the gate closed and the whole plan
was skipped. The fill clicked that row, the menu drilled in, nothing committed.

**(b) A parent that expands looked identical to a control that refuses.** All the log said was
"the field would not take it" — which reads as a broken widget, and sent me looking at click
mechanics for hours instead of at the answer.

**(c) The agent was guessing in the first place.** `read()` must *open* a prompt to see its options,
and attribution requires closing any previously open menu first, so on this tenant the field
reached the agent with **no options at all**:

```
[agent] "How Did You Hear About Us?*" arrived with NO options — cannot pick the campus channel
```

With no options the campus rule cannot fire and the model answers from the label alone — which is
how "University/College (Campus)" got chosen. The *fill* then re-opens the control and sees all
three rows. **The agent and the fill see different worlds**, and that is an architectural fault, not
a bug: the layer that decides meaning is working from less information than the layer that acts.

### 6.4 Why the tests did not catch it

`npm run test:storelookup` passes **92 cases** against `hearAboutUsPlan`, including this exact tree.
The function was never wrong. **The tests cover the function; the bug was in the decision to call
it.** Every pure function in this repo is well covered, and almost every real failure has been in a
call site or in browser interaction, which the suites barely touch.

### 6.5 Fixed, and verified on the live form

The gate is gone — this question is decided by the candidate's order, not by whichever row the model
liked — and an expansion is now reported as one:

```
· select[LinkedIn] "Handshake, where these roles are found" is nested — opening "Job Board"
✓ How Did You Hear About Us?*
    on step 2 of 7 — My Experience
```

Deliberately **not** fixed by drilling in and taking the first child: which child to take is an
answer, and taking one because it is there is the invention this code refuses everywhere else.

**Still open (6.3c):** the agent still receives this field with no options on some tenants. It works
now only because the ladder does not need them. That is a patched symptom, not a fixed cause.

---

## 7. Verification — three independent checks

Verification is where the design invests most, because the unrecoverable failure is submitting
something wrong.

1. **Read-back, per field.** `fill()` returns true only when the control reports the value.
   Read-back is on the *committed* value, not the typed string: a Workday date part shows
   `09/05/2026` while the widget's own state is empty until it is blurred.
2. **The drift check, at submit.** Approval can take days, so the submit **re-opens and re-fills the
   live form** and then `compareToApproved()` compares every value with what was approved. One
   difference and nothing is submitted. A *reworded* question passes only if the value going in is
   character-for-character the approved one — "equivalent" is not a judgement this code may make.
3. **The visual cross-check, against the screen.** The review screenshot goes to x8ocr; the verdict
   pairs each recorded label with the block holding its value. This is the only check that can see a
   field our own reader missed. It runs asynchronously and gates the submit, not the fill.

The visual check is also the one with the most false-positive risk, so its rules are conservative:
"empty" means *a box we found showing a placeholder*, never "we found no box" — blocking a finished
application on our own reader's miss is the failure it exists to prevent.

---

## 8. The human in the loop

Two stores means two status vocabularies, and they overlap without agreeing, so all wording comes
from one module, `src/core/statusVocabulary.ts`.

```
LEDGER   prefilled_pending_submit · submitted · manual_submitted · expired
         already_applied_on_site · unsupported_ats · error ("will be retried")
QUEUE    awaiting_approval · submitting · submitted · manual_submitted
         skipped · expired · error ("gave up — nothing sent")
```

**`submitted` means we clicked and the page reported success — not that the employer confirmed
anything.** `submit()` waits and records what the page did: confirmed / navigated away / control
disappeared / **nothing changed**, and that sentence goes in the ledger note. `confirmed` is
deliberately absent: nothing reads the acknowledgement email yet, and adding the word before the
mechanism would repeat an earlier mistake where "applied" appeared in one table and meant only that
a button had been clicked.

**Pages split by "is a human the next step", not by status.** `/queue` is for decisions; `/status`
is for progress. An application being re-filled and one that reached Review with something missing
are both things the system moves on its own — they used to sit on the approval page beside an
Approve button, which is a footgun. Both pages call the same `splitQueue`, so the list you approve
from and the guard that refuses a submit cannot disagree.

Actions available to the candidate: **Approve & submit · Skip · I submitted this myself · Posting
is closed · Request a change**, plus inline edits that *become* the approved answers before the
approval, so "submitted == approved" holds.

---

## 9. Double-submit safety

Six independent layers, because the poller runs unattended:

1. `listAwaiting()` returns only `awaiting_approval` — a submitted entry can never be picked up.
2. A submit during a fill run closes out the queue entry immediately.
3. **Write-ahead `submitting`**, set *before* the attempt. If the run dies between the click and
   recording the result, the entry stays `submitting`, is excluded from `listAwaiting()`, and is
   **never auto-retried** — it is reported for confirmation on the ATS.
4. **Ledger cross-check** before touching a live form; if ledger and queue disagree, `submitted`
   wins.
5. **Atomic lock** (`wx`) so the check and the claim are one operation.
6. `processedReplyIds` and the driver's own `isAlreadyApplied` page check.

---

## 10. Why 222 records say `error` — the honest answer

This is the section to argue with. Measured 2026-09-07:

```
LEDGER   error 222 · submitted 68 · expired 63 · prefilled_pending_submit 39
         unsupported_ats 16 · manual_submitted 11 · already_applied_on_site 7
```

The 222 break down by **cause**, not by job:

| Count | Cause | Status |
|---|---|---|
| **100** | stopped at turn 1 — never reached the form | **root cause fixed 2026-09-07** |
| 73 | one required field was empty | partly fixed; see below |
| 39 | stopped mid-form (turns 2–4) | mixed |
| 10 | miscellaneous | — |

And the empty-field 73 cluster is dominated by a handful of questions:

```
29  How Did You Hear About Us?        ← section 6. Fixed and verified today.
 9  Degree                            ← the do-not-invent rule refusing a value it should derive
 6  State/Local/Non-U.S. Government Employment
 3  driver's licence · 3 felony · singletons after that
```

**The single biggest thing this review should say: the failure count is not 222 distinct problems.
It is roughly a dozen causes with long tails, and the largest were invisible for weeks because the
mechanisms built to explain failures were themselves broken.**

Three examples, all found and fixed in the last day:

- **Study mode had never run once since it shipped.** Its page script was written `(el) => {…}` — a
  bare arrow as a *string*, which returns `undefined` silently. It was the only `evaluate` in the
  codebase breaking a rule the codebase itself documents. Every refusal produced no diagnosis and
  `data/field-notes.json` did not exist, which is indistinguishable from "we looked and learned
  nothing".
- **`clickAny` reported success for a click that never happened.** It took the first selector that
  *existed*, clicked it, swallowed the error, and returned true. On Workday create-account pages the
  first match is an `aria-hidden`, `tabindex="-2"` button sitting behind the real control; Playwright
  waits 30 seconds for it and the function reports success. **20 Workday tenants** were logged as
  needing hand-made accounts because of this. The candidate found it by reading the DOM and telling
  me the button was right there.
- **A finished application could be invisible.** The readiness gate returned without writing a queue
  entry, while the ledger recorded `prefilled_pending_submit`. Ten applications were finished,
  recorded, and absent from every page. He found one (CDRDUK) and asked why.

The pattern is one thing: **this system is much better at stopping than at explaining why it
stopped**, and for three weeks the explanations were wrong or absent. The bias described in section
1 is correct, but it was miscalibrated — stopping is only cheap if the reason is legible, and it
was not.

---

## 11. Known weaknesses

Stated plainly, worst first.

1. **The agent and the fill see different option lists** (6.3c). The layer that decides meaning
   often has less information than the layer that acts. Every "the model guessed" failure traces
   back here.
2. **Tests cover pure functions, not call sites.** 33 suites, ~500 cases, almost all against
   functions that were never wrong. The bugs live in gates, orderings, and browser interaction.
   There is no test that would have caught any of the three failures in section 10.
3. **Swallowed errors are still the default idiom.** `.catch(() => undefined)` appears throughout
   the fill path. It is right for a speculative probe and wrong for an action, and the difference is
   not marked anywhere.
4. **Retrying is not fixing.** `requeue:stale` re-runs everything newest-first, but a re-run against
   an unfixed cause reproduces the list. The queue looked busy for days while nothing converged.
5. **Some questions have no answer in any store** — conflict-of-interest, driver's licence,
   government employment. The system correctly refuses to invent, so they stop. There is no path for
   the candidate to answer one *from the failure* other than `/answers`.
6. **`expired` is discovered only by opening the posting.** 63 records are dead listings, and the
   only way to learn that is a full run.
7. **No employer confirmation is read.** `submitted` rests on what the page did. Two applications
   carried the word with no acknowledgement email, which is how the weakness was found.

## 12. What I would change, in order

1. **Make `read()` and `fill()` share one option-capture path** so the agent decides on what the
   fill will act on (fixes 11.1, and the root cause behind section 6).
2. **A test layer for call sites** — a fake ATS page per widget shape, asserting the *decision*, not
   the helper. `test/fake-ats/` exists and is used by four suites; this is a matter of extending it.
3. **Ban the bare `.catch(() => undefined)` on actions**, by convention and by a scanner like the
   one that now catches non-invoked page scripts.
4. **Surface unanswerable questions as a decision**, not a failure: a queue entry that asks the
   candidate for the one missing answer, so it converts into a submission instead of a retry.
5. **Read the acknowledgement mailbox** and add `confirmed` as its own stage.

---

## 13. Reference

- `CLAUDE.md` — the invariants, in the form "do not break this, here is what it cost when we did".
- `QUICKSTART.md` — fresh clone → first filled application.
- `src/core/statusVocabulary.ts` — every stage word, one place.
- Suites: `npm run test:*` (33 of them). `test:escapes` and `test:notes` are the meta-checks.

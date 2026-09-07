# Proposal — answering a question whose shape keeps changing

Companion to `DESIGN.md` (as-built). Written 2026-09-07 in answer to two things:

> "even for same ATS, the different job will have some kind of variant of the way to ask the same
> or similar question. The answer could be in the multiple layer of dropdown, or a list of checkbox,
> etc. In the situation we do have answer, or a list of preferred answer, it is still very hard for
> the worker to somehow find and select the correct answer."

> "the status of each post is kind of not so well organized, this reflect on our website with a lot
> of tabs"

Part 1 is what is actually wrong. Part 2 is my answer on the screenshot+OCR idea — half right, and I
want to argue with the other half. Part 3 is the proposal. Part 5 is the website. Part 6 is what I
need from you.

---

## 1. What is actually wrong

The pipeline is three steps, and the information is in the wrong one:

```
read()          →   decide()           →   fill()
FieldSpec[]         a text answer          find that text among the options, click it
{options?: string[]}
```

**1.1 The decision is made on less information than the action.** `read()` opens each combobox
(open → read → close) specifically so the agent gets options — that part of the design is right. But
when attribution fails, the field is deliberately handed over with **no options at all**, on the
correct principle that a field with someone else's options is worse than a field with none:

```
[workday] "How Did You Hear About Us?" opened no menu — leaving its options unread
[agent]   "How Did You Hear About Us?*" arrived with NO options — cannot pick the campus channel
```

The agent then answers from the label alone, and the fill re-opens the same control and sees three
rows. Two layers, two different views of the same widget.

**1.2 `options?: string[]` is flat, so a parent is indistinguishable from an answer.** Mastercard's
prompt offers three rows and every one is a tier-one parent with a chevron:

```
Job Board  >     Mastercard's Talent Acquisition Team  >     University/College (Campus)  >
```

Nothing in the type can say "this row opens; it does not answer". So the model chose
`University/College (Campus)` — a perfectly reasonable answer to the *question* and not an answer
this *widget* accepts. The click drilled in, nothing committed, and the log said "the field would
not take it". **The type system permitted the bug.**

**1.3 There is no single place where "held answer + offered options → choice" happens.** There are
eleven mappers across six files, each wired at its own call site with its own gate:

| mapper | file | call sites |
|---|---|---|
| `hearAboutUsPlan` | `agent/llmAgent.ts` | 1 |
| `preferredHearAboutUs` | `agent/llmAgent.ts` | 3 |
| `optionForRecorded` | `agent/llmAgent.ts` | 6 |
| `chooseOfferedOption` | `agent/llmAgent.ts` | 1 |
| `workAuthorizationOption` | `agent/llmAgent.ts` | 2 |
| `parseGpaBand` | `core/factChecks.ts` | 4 |
| `listChooserRow` | `core/listChooser.ts` | 3 |
| `isExclusiveGroup` | `core/fieldGroups.ts` | 2 |
| `optionsUnderGuideline` | `knowledge/guidelines.ts` | 1 |
| `datePartValue` | `core/dateParts.ts` | 1 |
| `pillsToRemove` | `knowledge/skillPlan.ts` | 2 |

Roughly 25 call sites. **One of those gates — `idx < 0` — silently disabled an entire ladder for
weeks**, and no test caught it because the tests cover the mappers, not the wiring. That is not bad
luck; it is what a design with 25 independent gates should be expected to produce.

**1.4 The measured consequence.** 29 of the 222 `error` records are this one question. The rest of
the empty-field cluster is the same shape: an answer we hold, a widget that would not take it.

---

## 2. On screenshot + OCR — the half I would change

You proposed: screenshot + OCR to learn the set of questions, then drive the DOM parser to find and
fill. I want to split that in two, because one half is already true and the other I think is wrong.

**Where you are right, and it is already load-bearing.** The DOM cannot be trusted alone. That is
exactly why the visual cross-check exists and why it gates submits rather than fills: it is the only
check that can see a field our own reader missed. Nothing below reduces its role.

**Where I would push back: OCR cannot enumerate the answer space, because the answer space is not on
the screen.** This is the fact that decides it — a closed list shows an empty box until it is
clicked. `read()` already opens every combobox for this reason. So:

- A screenshot of the page shows `How Did You Hear About Us?` and an **empty rectangle**. There is
  nothing to OCR. The three rows do not exist in the pixels until something clicks the control.
- OCR of an *opened* menu is possible — but by then you have the rows in the DOM already, and OCR
  adds a **box → element join** to get back to something clickable. We have that join today in
  `screenBlocks.ts`, and three pairing bugs in it held nine finished applications out of the queue.
  Adding it to the fill path would put that failure mode inside every field.
- Cost: measured, paddle 3–6s and airouter/sonnet 47–62s per capture, with over 900 aborts in the
  current log under load. The field budget is 90s. Per-field OCR does not fit, and per-*option-tier* OCR
  certainly does not.

**Where OCR should grow instead:** when option probing finds nothing — the 1.1 case — capture the
opened menu and record it as a field note against that ATS and question. That converts our worst
current blind spot into evidence, without putting vision on the critical path. Diagnosis, not
primary.

So: keep vision as the guardrail and make it the fallback *reporter*. Fix the reading problem in the
DOM layer, where the information actually lives.

---

## 3. Proposal — three changes

### 3.1 Model the option space as a tree, discovered by probing

One capture path, owned by the driver, used by **both** read and fill:

```ts
type OptionNode = {
  text: string;
  kind: "leaf" | "parent" | "nav";   // nav = "All" / "Partial List (First 500 Entries)"
  target: string;                     // how to click it
  children?: OptionNode[];            // filled lazily, only when descended
};

probeOptions(root, field): Promise<OptionNode[]>
```

`kind` is decided from evidence already on the row — a chevron, `aria-expanded`, a child count, the
existing `listChooserRow` test for navigation rows. Probing is **lazy**: only for a field the
resolver cannot settle from a stored leaf match, and cached per field for the turn, so the cost is
paid on the fields that need it rather than on all of them.

This alone removes two whole classes: *the agent had no options*, and *a parent was mistaken for an
answer*.

### 3.2 One resolver, replacing the eleven mappers

```ts
resolveChoice({ question, store, guidelines, tree }):
  | { kind: "path";   path: string[] }   // ["Job Board", "Handshake"] — click in order
  | { kind: "expand"; parent: string }   // open this, re-probe, ask again
  | { kind: "refuse"; why: string }      // no truthful answer — never invent
```

The eleven mappers become **ordered strategies inside it**, not call sites:

1. exact leaf match against a stored answer (`learned-answers` → `Q&A.txt` → résumé)
2. `guidelines.txt` PREFER minus AVOID filter over the leaves
3. domain ladders as **data**: hear-about-us, work authorisation, degree, GPA band
4. `chooseOfferedOption` — the model maps a held answer onto an offered row, may only return a row
5. refuse, with the reason

Two properties matter more than the tidiness:

- **It is a pure function** of question + tree + store. It can be tested exhaustively without a
  browser — which is the direct fix for `DESIGN.md` weakness 11.2, where 500 cases test mappers that
  were never wrong while the wiring failed.
- **There is exactly one gate**, so there is exactly one place a gate can be wrong.

### 3.3 The fill becomes an executor

`fill()` stops searching and stops deciding. It executes a path: click row, verify (a parent must
reveal children; a leaf must commit a value), report which step failed. The `idx < 0` shape of bug
becomes structurally unavailable, because there is no longer a branch that asks "did the model's
answer happen to match a visible row".

### 3.4 And remember the path, per question rather than per job

This is the part aimed squarely at *"same ATS, different job, different shape"*. Generalise
`field-notes.json` from "remedy that worked" to "the path that committed":

```
fingerprint("how did you hear about us") + workday  + tree    → ["Job Board", "Handshake"]
fingerprint("how did you hear about us") + greenhouse + select → ["Handshake"]
fingerprint("are you legally authorized…") + ashby   + radio  → ["Yes"]
```

Keyed on the **normalised question** (`normalizeQuestion` already exists) plus ATS plus widget
shape — never on the job. The second occurrence of a question is then a lookup and one click, not a
model call and four guesses. Same rules as the existing notes: exact match first, then the same ATS
with a label differing only in the ways labels differ; never across ATSes.

---

## 4. What this fixes, and what it does not

**Fixes:** the option-blind agent (1.1); parent-as-answer (1.2); the 25-gate surface (1.3); the
untestable wiring; and the repeat cost of a question we have already solved once.

**Does not fix:** questions with no answer in any store — conflict of interest, driver's licence,
government employment, about 15 records. Those *should* refuse. What is missing is a way for you to
answer one **from the failure**, which is item 5 in section 6 below.

---

## 5. The website, and the status vocabulary

**The diagnosis: the pages are organised by data store, not by what you need to do.** `/applications`
is the ledger, `/queue` is the queue, `/runs` is the logs, `/incoming` is the CSV, `/blocked` is
ledger-minus-queue. That is why there are ten tabs and why "the status of each post" is spread across
several of them — a single posting can appear on `/applications`, `/queue`, `/status` and `/history`
with different words for the same moment.

**It is worse than cosmetic**, and section 10 of `DESIGN.md` has the evidence: ten finished
applications existed in the ledger and on no page at all, because "which page shows this" was derived
from which store held it.

### Proposed shape

**One lifecycle, one enum.** Today there are two — `ApplicationRecord.status` and `PendingStatus` —
overlapping without agreeing (`skipped` vs `skipped_existing`; `error` meaning "the run failed" in
one and "the submit failed three times" in the other). `statusVocabulary.ts` already centralises the
*words*; the next step is one **stage** field with one set of values, and the two stores keep their
own concerns (permanence vs decision-in-flight) without inventing separate vocabularies.

**Three lists, not ten tabs**, derived from that one stage:

| List | What is in it | Why it exists |
|---|---|---|
| **Decide** | waiting for you: approve, or answer one question | the only page with buttons |
| **Working** | the system is moving it — with the reason it is here | so nothing is invisible |
| **Done** | submitted · sent by hand · skipped · posting closed | the record |

**One page per posting** — `/j/CODE` — showing that posting's whole life: what was filled, the
screenshot, the visual verdict, every run, every decision. Today that is split across
`/applications/CODE`, `/queue/CODE` and `/history/CODE`.

Everything else becomes a filter on those three (`/incoming` → Working, filtered "not yet applied")
or a settings page (`/answers`, `/preference`). Ten tabs → three lists + settings.

---

## 6. Answers, and the revised centrepiece

Reviewed 2026-09-07. His answers changed what this proposal is about.

**On the option tree (Q2) he redirected it, and he is right:**

> "For this particular 'How do you hear from us' question, it is the workday only problem. Other
> ATS might have similar issue, but i am not sure. What i want address is the deeper issue: When
> this does not work, how to make LLM to automatically find out the issue and fix it, instead of I
> have to find it out. I proposed a study mode should be trigger when worker's code can not fill in
> a field, especially common field. The study mode should invoke LLM and Vision to study the page,
> and then DOM and get the problem solve, and fix the code onward."

So the option tree drops from centrepiece to a narrow fix for one known widget, and the centrepiece
becomes **self-repair**: when a field refuses a value, the run itself works out why and gets past it,
without him finding it.

Other answers: **Q1** — put the question and its real options on the job's page, he chooses, and the
answer is remembered for the same question anywhere. **Q3** — converge the two status enums first.
**Q4** — Handshake always, overridable at review.

---

## 7. Self-repair — what it may search over, and what it may not

The one line that makes this safe:

> **The loop may search over MECHANISM. It may never search over MEANING.**

It may discover *how* to tick a box — which element takes the click, whether a parent must be opened
first, whether the control needs a blur to commit. It may never discover *what* to tick: the value
always comes from the store, the ladder, or `guidelines.txt`, and when there is no value the answer
is to ask him (§8), never to try options until one sticks. That distinction is what keeps a
self-repairing filler from becoming a machine that invents answers on live employer forms.

### 7.1 The loop

Triggered the moment a field was told to take a value and did not, while the page is still open.

```
0. LOOK IT UP     fingerprint(question) + ats + widgetShape → a recipe that worked before?
                  → apply it. One action instead of a model call and four guesses.
1. OBSERVE        DOM facts (already built) + NEW: a screenshot of the control and its
                  neighbours + the opened menu if it is a choice control
2. HYPOTHESISE    ask the model WITH THE IMAGE: what is this control, and what would a
                  person do to set it to X? Answer constrained to the recipe catalogue.
3. EXPERIMENT     try it; verify by read-back. Failed → next candidate. Bounded.
4. LEARN          success → store the winning recipe under that key. Failure → store that
                  too, so it is never tried again.
5. GIVE UP WELL   write a repair dossier: screenshot, DOM, ancestry, everything tried,
                  what the model said, the failing selector. Surface it for review.
```

Steps 0–4 already exist in weaker form — `studyFailedField`, `REMEDIES`, `applyRemedy`,
`knownRemedy`, `recordRemedyOutcome`, `fieldNotes`. This is an upgrade of a mechanism that shipped
broken and ran for the first time yesterday, not a greenfield build.

### 7.2 What is genuinely missing

| Gap | What it needs |
|---|---|
| **No vision.** `callModel` sends text only — `content: user` as a string, `parts:[{text}]` for Gemini | both APIs take images; a contained addition to one client |
| **The catalogue has no notion of a path.** Seven remedies, all single actions | add `option-path`: open parents to reach a leaf. That is the Workday tree case |
| **Notes are keyed per field, per ATS** | key on `fingerprint(question) + ats + widgetShape` so a *different job* with the same shape reuses it |
| **Budget is flat** | scale it by how many applications the field blocks — 29 for hear-about-us earns vision and six experiments; a one-off earns one |
| **Giving up is silent** | the dossier, and a page that lists them |

### 7.3 On "fix the code onward"

Two different things, and I want to be explicit about which I will do.

**Data-level repair, applied automatically.** Almost every fix so far has been *data*, not logic:
which element takes the click (the `click_filter` wrapper, not the inert button), which path commits
(Job Board → Handshake), whether a blur is needed, what the answer is. Learned, verified on the spot,
stored, reused. That is a permanent behaviour change with no code edit, and it is where the loop
should live.

**Code-level repair, proposed and never auto-applied.** When the loop exhausts its budget, a new
widget family probably needs real code. The dossier makes that a short job with evidence instead of a
day of hunting. I am not going to have a model rewrite the fill path unseen: `CLAUDE.md` already
says a fix invented by a model and applied unseen is the false success everything else guards
against, and the last day produced three separate bugs whose whole nature was code *reporting*
success it did not have. If you want that line moved, say so and I will move it — but I want it
recorded as your decision, not mine.

---

## 8. Asking him the question — his Q1 answer

> "They should put such question, with the available option, in the webpage of this job. I will make
> the correct selection. However, once i answered, they need remember this type of question, as
> their knowledge, and use it again if they see the similar question"

So a field with no truthful answer stops being a failure and becomes **a question on the job's page**:
the question as the form words it, the options as the form offers them, and his choice recorded
against the question fingerprint — so the next employer asking the same thing, in whatever shape, is
answered without him. Roughly 15 records today, and the same memory store as §7.

---

## 9. The plan, in order

Each step is useful alone, and each one earns the next.

1. **The memory store** — `fingerprint(question) + ats + widgetShape` → the recipe or path that
   committed, and the answer he gave. Foundation for both 7 and 8; replaces `field-notes.json`'s
   per-field keying.
2. **Ask him the question** (§8). Converts ~15 stopped applications into one-field decisions, and is
   the first thing that visibly reduces the count.
3. **Vision in the study, and the verified experiment loop** (§7). The deeper ask.
4. **The Workday tree prompt** — option-tree probe and resolver, that widget only, as he scoped it.
5. **Converge the two status enums** (his Q3). 34 postings currently disagree; two of them disagree
   about whether an application exists at all.

---

## 10. What I need from you


Answered above; kept for the record.

1. **Appetite.** 3.1–3.3 touch the centre of the fill path. Done properly it is a week of careful
   work with the suite extended first; done fast it is a day and I will break things I cannot see. I
   would rather be told which.
2. **Refuse, or fill-and-flag?** Today an unanswerable required question stops the application. The
   alternative is to fill the best available option, mark the answer **draft**, and let it reach your
   queue clearly flagged. That converts ~15 stopped applications into decisions — but it means a
   value you have not read appears on a live form, which every rule in this system currently forbids.
   Your call, not mine.
3. **Website: rebuild or converge?** Three lists is a rebuild of the navigation. Converging the two
   status enums is most of the value for a fraction of the work, and can ship first.
4. **Is Handshake always the answer?** The ladder treats it as the top preference everywhere. If
   there are employers where the honest answer is different — a referral, a campus event you actually
   attended — that belongs in `guidelines.txt` as data rather than in my head.
5. **The unanswerable questions.** Shall I add "answer this one question" to the queue entry, so a
   blocked application becomes one field for you to fill rather than a re-run? That is the smallest
   change here with the most direct effect on the count.

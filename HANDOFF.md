# Implementation handoff

For an agent that has not seen the conversation this came out of. `PROPOSAL.md` is the *why*;
this is the *how*. Read `CLAUDE.md` first — it is the invariant list, and every rule in it was
written after breaking something.

Written 2026-09-07. Six tasks, ordered. **Each one is independently shippable and independently
verifiable — do them in order and commit between them.** Do not start T4 before T1 and T2 are
live, because T4 depends on both.

---

## 0. Before you touch anything

### 0.1 Ground rules that will bite you

These are not style preferences. Each has cost an application.

| Rule | Why |
|---|---|
| `page.evaluate()` takes a **STRING**, and it must be an **invoked IIFE**: `"(() => {…})()"` | a bare arrow returns `undefined` silently. It disabled study mode for its entire life. `npm run test:escapes` scans for it |
| Inside an evaluate template, **every regex escape must be doubled** — `\\s`, not `\s` | a template literal eats `\s` into the letter "s". It mangled 652 field labels |
| **Never** `.catch(() => undefined)` on an **action** | fine on a speculative probe, fatal on a click: `clickAny` reported success for clicks that never happened, at 20 tenants |
| Nothing reports success without **reading the value back** | a fill that returns true after a click is a false success |
| **The worker is the only writer** of `data/applications.json` and `data/pending-approvals.json` | the website writes command files only |
| **The Enter key is banned** except on a Workday prompt with its own list open | it filed seven applications by accident |
| **Never click submit.** `SUBMIT_TEXT_BLOCKLIST` in `config.ts` | — |
| Never invent a fact — degree, GPA, field of study, an answer to a question with no stored answer | it put a false GPA band on applications |

### 0.2 The loop you must work inside

```
npm run check                 # tsc, must be clean
npm run test:<suite>          # 36 suites; see package.json
./worker-restart.sh           # REQUIRED after any src/ change, or the worker runs the old code
./jobapp_website.sh rebuild   # REQUIRED after any web/ change
```

**The worker caches code at start.** It prints `running code <sha> but the tree is at <sha>` when
stale. `worker-restart.sh` refuses while a submit is in flight — that is correct; wait.

### 0.3 The trap that matters most for this work

This codebase's characteristic failure is **a mechanism that exists and is never called.** Study
mode was written, shipped, and ran zero times for its whole life. `recordAuthAlert` wrote a file
nothing read back for weeks. Two of the three pieces below are in that state *right now*.

So for every task: **the acceptance test is that it changed behaviour in a real run**, not that
it compiles and has passing cases. Grep the live log for your own marker before calling it done.

---

## 1. State of the three new pieces

| File | Built | Cases | Wired |
|---|---|---|---|
| `src/core/readingSanity.ts` | yes | `test:reading`, 18 | **yes** — `turnLoop.ts`, verified firing |
| `src/knowledge/questionMemory.ts` | yes | `test:memory`, 20 | **no — nothing imports it** |
| `src/agent/modelCall.ts` vision | yes | proven by hand | **no — 0 callers pass an image** |

T1 and T2 exist to fix the last two rows. Do them first; they are small.

---

## T1 — Let the study see (≈1 hour)

**Problem.** `studyFailedField` already screenshots the control, then asks a **text-only** model
what to do. Whether a dropdown row *opens* or *answers* is a visual fact — a chevron on the right
edge — and the DOM expresses it in tenant-specific ways or not at all. Measured on the real
Mastercard capture: asked as three strings the model says it cannot tell and picks one; shown the
picture it says *"all three rows are folders, each has a '>' chevron on the right"*.

**Files.**
- `src/agent/fieldStudy.ts` — `explainStuckField(label, facts)` at line ~34; `callModel(system, user)` at ~47
- `src/agent/drivers/base.ts` — `studyFailedField`, `const shot = …` at ~359, calls `explainStuckField` at ~440

**Do.**
1. Widen the signature: `explainStuckField(label, facts, images?: ModelImage[])` and pass them
   through to `callModel(system, user, images)`. `ModelImage` is exported from
   `src/agent/modelCall.ts` as `{ path: string; caption?: string }`.
2. In `studyFailedField`, pass the capture it already takes:
   `[{ path: shot, caption: "the control that refused the value" }]` — only when `shot` is set.
3. Extend the system prompt to ask about the *shape*: is this row a final answer or a folder that
   opens more rows; is anything covering the control; is the real clickable the input or a wrapper.
   The remedy must still be exactly one of `REMEDIES` (line ~18) — do not let the model free-text
   an action.

**Do not.** Do not add a new remedy that clicks something the model names by text. The remedy
vocabulary is fixed on purpose: a model choosing among known mechanisms is safe, a model inventing
a selector is not.

**Verify.**
```
npm run check && npm run -s test:escapes
./worker-restart.sh
# then, on the next run that has a refusing field:
grep -E '🔬|\[model\] cannot see' logs/worker.log | tail
```
Done when a `🔬` line describes a control's *shape* and no `[model] cannot see` line appears
(that message means the file path was wrong — see §0.1's note on macOS screenshot names, which
contain U+202F, a narrow no-break space).

---

## T2 — Give `questionMemory` its first readers (≈2–3 hours)

**Problem.** `src/knowledge/questionMemory.ts` is a complete store with no callers. Its purpose is
the candidate's own complaint: *"even for same ATS, the different job will have some kind of
variant of the way to ask the same or similar question."* Keyed on the **question**, not the job.

**The asymmetry it enforces, and you must not break it:** an **answer** travels between employers
and widgets (`recallAnswer` searches every ATS); a **mechanism** does not (`recallMechanism`
refuses to leave its own `ats` + `shape`). `CLAUDE.md` already forbids carrying a field note across
ATSes — that rule is about mechanism. `test:memory` holds this line; if you find yourself editing
those cases, stop and re-read them.

**Files.**
- `src/knowledge/questionMemory.ts` — exports `recallAnswer`, `recallMechanism`,
  `mechanismsRuledOut`, `rememberQuestion`, `studyBudgetFor`, `fingerprintOf`
- `src/agent/drivers/base.ts` — `knownRemedy` at ~466 (the existing per-field-note lookup),
  `studyFailedField` at ~330–455, `fillReactSelectOne` at ~2127
- `src/agent/turnLoop.ts` — the reading-doubt block (search `🤨`)

**Do.**
1. **Record.** In `studyFailedField`, on a remedy that *worked*, also
   `rememberQuestion({ sampleLabel: field.label, ats, shape, mechanism: { recipe }, source: "learned", worked: true })`.
   On one that failed, the same with `worked: false`. Derive `shape` from the `FieldSpec`:
   `widget === "workday-select" → "workday-prompt"`, `widget === "react-select" → "react-select"`,
   else the `type` mapped onto `WidgetShape`. Put that mapping in **one** exported helper —
   do not inline it twice.
2. **Recall before studying.** `knownRemedy` currently reads `field-notes.json` keyed on
   `(ats, label)`. Add `recallMechanism` **in front of it**, and pass
   `mechanismsRuledOut(...)` into the study so it never proposes a recipe already known to fail
   here. Keep `field-notes.json` working — do not migrate or delete it in this task.
3. **Record the reading doubt.** In the `turnLoop` doubt block, when a doubt *survives the second
   read*, `rememberQuestion({ …, mechanism: { recipe: "reader-cannot-see" }, worked: false })`.
   "Our reader cannot see this control here" is exactly the sort of thing that should be known
   before the next employer asks the same question.

**Verify.**
```
npm run check && npm run -s test:memory && npm run -s test:notes
./worker-restart.sh
ls -l data/question-memory.json          # must EXIST and grow after a run with a refusal
python3 -c "import json;d=json.load(open('data/question-memory.json'));print(len(d))"
```
Done when the file exists with entries whose `fingerprint` is the normalised question, **and** a
second run on the same question logs that it used a remembered mechanism rather than studying again.

---

## T3 — Ask the candidate the question (≈4–6 hours)

**Problem.** ~15 records are blocked on a required question with no truthful answer anywhere —
conflict of interest, driver's licence, government employment. The system correctly refuses to
invent one, so the application stops and stays stopped. His instruction:

> "They should put such question, with the available option, in the webpage of this job. I will
> make the correct selection. However, once i answered, they need remember this type of question,
> as their knowledge, and use it again if they see the similar question"

So the outcome is: **the question, worded as the form words it, with the options the form offers,
on that job's page — and his answer remembered by fingerprint so the next employer is automatic.**

**Files.**
- `src/knowledge/approvalQueue.ts` — `PendingEntry` at ~53. Add
  `openQuestions?: Array<{ label: string; options?: string[]; required: boolean; type: string }>`
- `src/core/applyJob.ts` — the gaps branch that queues an incomplete application (search
  `IT IS QUEUED ANYWAY`). Populate `openQuestions` from `result.unknown` joined against
  `result.observedFields` so each carries its real options
- `src/knowledge/commands.ts` — add `| { name: "answer_question"; code: string; entries: Array<{ question: string; answer: string }> }`
  to the union at ~151, add `"answer_question"` to `CommandName` at ~23, and give it **rank 0** in
  `PRIORITY` (~208): it is a decision and he is waiting
- `src/worker.ts` — a handler beside `manual_submit`. It must **record the answer via the existing
  `update_answers` path AND `rememberQuestion({ source: "candidate" })`**, then enqueue a `retry`
  for that code so the application continues without him asking
- `web/app/api/command/route.ts` — add to `ALLOWED` and to `needsCode` (~12, ~31)
- `web/components/ReviewPanel.tsx` — render `openQuestions` as a small form: the label verbatim, a
  radio/select of the real options, or a text box when there are none. One "Save answers" button
- `web/app/queue/[code]/page.tsx` — pass `entry.openQuestions` through

**Do not.** Do not fill anything from these answers during the same run — the answer arrives as a
command after the run has ended. Do not put the question on `/answers`; it belongs on the job's own
page, which is where he is when he sees the problem.

**Verify.**
```
npm run check && npx tsc -p web/tsconfig.json --noEmit
./worker-restart.sh && ./jobapp_website.sh rebuild
# pick a blocked job:
python3 -c "import json;d=json.load(open('data/pending-approvals.json'));print([e['code'] for e in (d if isinstance(d,list) else d['entries']) if e.get('openQuestions')][:3])"
```
Done when a blocked job shows its unanswered question with real options on `/queue/<CODE>`,
answering it writes `question-memory.json` with `source: "candidate"`, and the job re-runs and gets
past that field.

---

## T4 — The self-repair loop (≈1 week; do not rush this one)

**Problem, in his words:**

> "When this does not work, how to make LLM to automatically find out the issue and fix it, instead
> of I have to find it out. I proposed a study mode should be trigger when worker's code can not
> fill in a field… The study mode should invoke LLM and Vision to study the page, and then DOM and
> get the problem solve, and fix the code onward."

**The line that keeps it safe, and it is not negotiable:**

> **The loop may search over MECHANISM. It may never search over MEANING.**

It may discover *how* to tick a box — which element takes the click, whether a parent must open
first, whether a blur is needed. It may never discover *what* to tick: the value comes from the
store, the ladder, or `guidelines.txt`, and where there is none the answer is T3, never trying
options until one sticks.

**The loop.** Most of it exists in weaker form in `base.ts` (`studyFailedField`, `applyRemedy`,
`knownRemedy`, `recordRemedyOutcome`). Upgrade, do not rewrite.

```
0. RECALL      recallMechanism(...) → apply it, verify, done. (T2 gives you this)
1. OBSERVE     the DOM facts it already gathers + the control screenshot (T1) +
               for a choice control, a capture of the OPENED menu
2. HYPOTHESISE callModel with the images; answer constrained to REMEDIES
3. EXPERIMENT  try it; verify by read-back; on failure the next candidate,
               skipping mechanismsRuledOut(...). Bounded by studyBudgetFor(blocking)
4. LEARN       rememberQuestion(worked: true/false) either way
5. GIVE UP WELL write data/repairs/<ats>-<fingerprint>.json: screenshot paths, DOM,
               ancestry, everything tried, what the model said, the failing selector
```

`studyBudgetFor(blocking)` already exists in `questionMemory.ts` — `blocking` is how many ledger
records list this field in their blocked-required note. A field blocking 29 applications earns
vision and six experiments; a one-off earns two and no vision.

**Safety envelope, all of it required.** Never on a submit control. Never Enter. Bounded attempts
and wall-clock. Every experiment verified by read-back. **If an experiment leaves a value on the
form that nobody chose, stop the run and report it** — that is worse than the original failure.

**On "fix the code onward".** Data-level repair (which recipe, which path, which answer) is applied
automatically and is where ~90% of every fix so far has lived. **Code-level repair is a written
dossier and is never auto-applied.** `CLAUDE.md`: a fix invented by a model and applied unseen is
the false success everything else guards against. If the candidate moves that line he will say so;
until then, do not have a model edit `src/`.

**Verify.** A field that failed, then succeeded on a later run *without* a code change, with
`question-memory.json` showing the winning recipe. And at least one `data/repairs/*.json` from a
genuine give-up.

---

## T5 — The Workday tree prompt (≈half a day)

**Scope: Workday only.** The candidate was explicit — *"For this particular 'How do you hear from
us' question, it is the workday only problem."* Do not touch the other five drivers.

**Problem.** `FieldSpec.options` is `string[]`, so a tier-one parent is indistinguishable from an
answer. Mastercard offers `Job Board >`, `Mastercard's Talent Acquisition Team >`,
`University/College (Campus) >` — all three are folders. The model answered with one, the click
drilled in, nothing committed.

The immediate bug is already fixed (the `hearAboutUsPlan` gate at `base.ts` ~2456 no longer
requires `idx < 0`). This task removes the *class*.

**Do.** Add to the Workday driver a probe returning
`{ text, kind: "leaf" | "parent" | "nav", target }` per row — `kind` from the chevron,
`aria-expanded`, a child count, and the existing `listChooserRow` test in
`src/core/listChooser.ts` for navigation rows (`All` / `Partial List (First 500 Entries)`). Then
resolve to a **path** (`["Job Board", "Handshake"]`) and have the fill execute it: click, verify a
parent revealed children, verify a leaf committed.

**Verify.** `npm run test:storelookup` and `test:chooser` still pass, plus a new suite over a
fixture in `test/fake-ats/` with a two-tier prompt. Then live:
```
grep -E 'is nested — opening|OPENED a sub-list' logs/worker.log | tail
```

---

## T6 — Converge the two status enums (≈half a day)

**Problem.** `ApplicationRecord.status` (`src/types.ts` ~190) and `PendingStatus`
(`approvalQueue.ts` ~24) overlap without agreeing — `skipped` vs `skipped_existing`, and `error`
meaning "the run failed" in one and "the submit failed three times" in the other. Measured:
**34 postings where the two stores use different words**, and **2 that disagree about whether an
application exists at all** — `NJRBUL` (Appian) is `submitted` in the ledger and `skipped` in the
queue. One of those is wrong and which page you open decides what you believe.

**Do.** One `stage` vocabulary, defined once. `src/core/statusVocabulary.ts` already centralises
the *words* (`LEDGER_STAGES` ~32, `QUEUE_STAGES` ~96) — extend that to the values. Keep both
stores: they have different jobs (permanence vs decision-in-flight). What must go is two
vocabularies for one lifecycle.

Add a reconciliation check that reports any posting whose two records disagree, and run it once to
resolve the existing 34 — **by hand for the 2 existence conflicts**, because guessing whether an
application was sent is exactly the thing this system must never do.

**Do not** rebuild the navigation in this task. Three lists (`Decide` / `Working` / `Done`) is a
separate change and he chose to converge the enums first.

**Verify.**
```
npm run check && npm run -s test:confirm && npm run -s test:history
python3 -c "
import json
a=json.load(open('data/applications.json')); a=a if isinstance(a,list) else a['applications']
q=json.load(open('data/pending-approvals.json')); q=q if isinstance(q,list) else q['entries']
led={x.get('code'):x.get('status') for x in a}; que={x.get('code'):x.get('status') for x in q}
print(sum(1 for c in led if c in que and led[c]!=que[c]), 'still disagree')"
```

---

## Reference

- `CLAUDE.md` — the invariants. Read before editing the fill path.
- `DESIGN.md` — as built, with the failure taxonomy and measured numbers.
- `PROPOSAL.md` — why these six tasks, and what was rejected (notably: OCR as the primary
  option reader, because a closed list is an empty rectangle until it is clicked).
- Current: 36 test suites, `npm run check` clean, worker at the HEAD of `main`.

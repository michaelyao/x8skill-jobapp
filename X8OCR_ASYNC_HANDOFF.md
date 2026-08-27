# x8ocr is now async and authenticated — what this repo needs to change

**Written for whoever works on this repo next.** The x8ocr side is done, deployed and verified;
this file is the contract plus the specific traps in *this* codebase.

**No code here has been changed.** The only edits are `.env` (this app's x8ocr key and callback
settings — section 1) and this file. See [Reference implementation](#reference-implementation) at
the end for a working version to compare against, set aside in `git stash`.

Three things happened on the x8ocr side. The first two break the current integration in
`src/knowledge/visualCheck.ts`:

1. **Every call now needs an API key.** Without one, x8ocr answers `401` and `ocrImage()` returns
   null — the visual cross-check silently stops working, permanently.
2. **There is a new async job API.** The fill run no longer has to wait 6–56s for OCR.
3. **Layout-aware OCR from more than one engine** — normalized blocks with boxes, a per-engine
   trust statement, and a compare mode. This answers four items in `requirement_ocr.md` that
   PaddleOCR alone could not (section 4).

There is also a **bug fix you were blocked by without knowing it** (see [Why your OCR was
returning nothing](#why-your-ocr-was-returning-nothing)).

---

## 1. The API key (already in `.env` — just use it)

**Done for you.** `.env` now carries this app's own x8ocr key, plus the callback settings from
section 6:

```
X8OCR_API_ENDPOINT=http://localhost:8799     # was http://192.168.1.210:8799 — see below
X8OCR_API_KEY=<set>
X8OCR_CALLBACK_URL=http://host.docker.internal:8088/api/ocr-result
X8OCR_CALLBACK_TOKEN=<set>
VISUAL_CHECK_GRACE_MS=600000
```

The key is issued to `jobapp` specifically, not shared with meatchain or meatos, so it can be
rotated or revoked on its own and x8ocr's logs attribute calls to it (`client=jobapp`).

> ### The endpoint moved, deliberately
> It pointed at `http://192.168.1.210:8799` — a **different machine**, still running pre-auth
> x8ocr with the payload bug described at the bottom of this file. That instance returns zero
> pages for every image, so the visual cross-check has been silently dead there.
>
> It now points at `localhost:8799`, an x8ocr on *this* host (192.168.1.216) running the current
> build. That is x8ocr's documented same-host-sidecar shape: no LAN hop, and the API key never
> crosses the network in plaintext. Verified working with this app's key.
>
> If `.210` is meant to be the canonical instance, it needs the new build deployed and a key
> issued there, and this line points back at it — but then the key travels the LAN over plain
> HTTP, so sign the callback body rather than relying on the shared token.

Send it on every x8ocr request, as either header:

```ts
headers: { authorization: `Bearer ${process.env.X8OCR_API_KEY}` }
// or: { "x-api-key": process.env.X8OCR_API_KEY }
```

`/healthz` and `/mcp/health` stay open. `/v1/extract`, `/v1/jobs` and `/mcp` do not.

A 401 body distinguishes the two cases so you can tell them apart in logs:

```jsonc
{ "error": "Missing API key.", "reason": "MISSING_API_KEY", "message": "…", "acceptedHeaders": [...] }
{ "error": "Invalid API key.", "reason": "INVALID_API_KEY", "message": "…", "acceptedHeaders": [...] }
```

Keys are per-application, so this app has its own — a rotation elsewhere will not affect it, and
a leak here is revocable on its own.

**Minimum viable change:** add the header to the existing `ocrImage()` and you are working again,
synchronously, exactly as before. Everything below is the async upgrade.

---

## 2. Why go async

Measured against the live provider, 2026-08-26, using `screenshots/issue 2.png` and scaled copies:

| Input | Megapixels | Samples (ms) | Median |
|---|---|---|---|
| small region | 0.15 | 5849 · 1620 · 4925 | 4925 |
| half | 0.59 | 6681 · 9923 · 9420 | 9420 |
| full screenshot | 1.17 | 10743 · 6528 · 2887 | 6528 |
| `fullPage` shot | 8.91 | 56493 | 56493 |

Two findings that matter more than the absolute numbers:

- **Latency is not proportional to size below ~1.2MP.** An 8× pixel reduction buys ~1.3× median
  time and the ranges overlap completely. The same bytes submitted three times took 2.1s, 5.2s and
  9.4s. Cropping the screenshot is *not* a latency fix in this range.
- **Only the `fullPage` shot is genuinely size-bound** (8.9MP → 56s). Your review screenshot is
  exactly that.

So the problem is not "OCR is slow", it is "OCR takes somewhere between 1.6s and 56s and you cannot
know which". No timeout is both safe and tight. That is what the job API is for.

> ### Do NOT clip the review screenshot
> The obvious optimisation — `clip:` instead of `fullPage: true` in `applyJob.ts` — is wrong here,
> and it is worth stating because it looks so tempting. `missingFromScreen()` compares **every**
> recorded answer against the whole page text. A clipped screenshot would report correctly-filled
> off-screen fields as missing: false "not on screen" gaps, which your own code calls the failure
> mode that would make the check worthless. Going async removes the reason to clip anyway.

---

## 3. The async contract

### Submit

`POST /v1/jobs` — identical inputs to `/v1/extract` (multipart `file`, or JSON `fileBase64`), plus:

| Field | Meaning |
|---|---|
| `callbackUrl` | Where x8ocr POSTs the result. Echoed back **verbatim**, so put your own correlation id in its query string. |
| `callbackToken` | Returned to you as `Authorization: Bearer <token>` on the callback, so you can verify the sender. |

Returns immediately:

```jsonc
// 202
{ "jobId": "2ce5a2ff-…", "state": "queued", "statusUrl": "/v1/jobs/2ce5a2ff-…",
  "callback": { "url": "…", "state": "pending" } }
```

Measured: **42ms to submit against 15,079ms of actual work.**

An invalid `callbackUrl` is rejected at submit time (`400 BAD_CALLBACK_URL`) rather than surfacing
30s later as a delivery failure nobody is watching.

### Receive

When the job finishes, x8ocr POSTs to your `callbackUrl`:

```jsonc
// headers: authorization: Bearer <your callbackToken>
//          x8ocr-job-id: <jobId>
{ "jobId": "…", "state": "done", "result": { /* the usual ExtractResult */ }, "error": undefined }
```

- `state: "done"` means **the job ran**, not that extraction succeeded — check `result.ok`.
  `state: "failed"` means the job itself threw, and `error` says why.
- Retries: 3 attempts with backoff on 5xx / 408 / 429 / network error. A non-retryable 4xx stops
  immediately, because that is you rejecting the payload and retrying will not fix it.
- **Return 2xx even for a failed extraction.** A 4xx makes x8ocr give up on a delivery that
  actually worked.

### Two rules you must honour

1. **Correlate with your own id**, not `jobId` alone — put the job code in the callbackUrl query
   string. You need to know which application a verdict belongs to.
2. **Have a fallback for silence.** x8ocr holds jobs **in memory** with a 1h TTL, and a restart
   loses in-flight work. `GET /v1/jobs/:id` exists for recovery/debugging but is not the intended
   flow. Never leave anything blocked forever waiting on a result that may never come.

---

## 4. Layout-aware OCR: blocks, capability, and compare

New since this file was first written, and directly relevant to `requirement_ocr.md`.

### Normalized blocks

`includeLayout: true` now returns `pages[].blocks` — one shape across every engine, so you do
not parse provider JSON:

```jsonc
{ "label": "placeholder",      // title | value | placeholder | checkbox | button | table | text | footer | other
  "text": "MM/YYYY",
  "box": [111, 784, 211, 808], // pixels [x0,y0,x1,y1]
  "order": 9, "score": 0.44, "checked": false }
```

This is what your "will move to `pages[].layout.parsing_res_list` for box-level pairing" plan
wanted, already normalized. The raw `parsing_res_list` is still there as `pages[].layout` if you
prefer it.

### Read `capability` before trusting a box

Returned next to the blocks, because the engines are **complementary, not ranked**:

| engine | boxes | deterministic | text |
|---|---|---|---|
| `paddleocr` | **`exact`** — safe to correlate with `getBoundingClientRect()` | **yes** | `literal` |
| `vision` (Gemini) | `approximate` — mean IoU 0.54 vs exact | no | `normalized` |
| `pdftotext` | `none` | yes | `literal` |

**Only `boxes: "exact"` may be lined up against DOM geometry.** Gemini's boxes are an estimate;
using them for your OCR↔DOM cross-check would produce confident nonsense.

### Compare mode

`POST /v1/compare?engines=paddleocr,vision` runs both concurrently (wall clock = the slower, not
the sum) and returns every result plus pairwise agreement. Live on the real
`screenshots/issue 2.png`:

```
paddleocr      ok  15730ms  14 blocks  boxes=exact         deterministic=true
vision/gemini  ok   7338ms  18 blocks  boxes=approximate   deterministic=false
agreement: 13 matched, meanIoU 0.695, 10 label conflicts
```

`labelConflicts` and `onlyIn` are the useful part — they surface each engine's blind spots
without you knowing in advance where to look:

```
MM/YYYY          paddleocr:"text"    gemini:"placeholder"   ← the empty-field signal
Update / Cancel  paddleocr:"text"    gemini:"button"
onlyIn paddleocr:  "<table>Title|Oct|Nov|Dec</table>"       ← its bad overlay merge
onlyIn gemini:     "* Title", the Title value, Oct, Nov, Dec
```

### What this changes for `requirement_ocr.md`

| | before | now |
|---|---|---|
| **R2** placeholder vs value | not possible from PaddleOCR | **available** — Gemini labels it `placeholder` natively |
| **R4** typed toggle | glyph inside a text block | **available** — `label:"checkbox"` + `checked`, from Gemini *and* recovered from PaddleOCR's `☐`/`☑` glyph |
| **R6** overlay awareness | PaddleOCR merges them | **available** — Gemini keeps them apart; compare's `onlyIn` flags the merge |
| **R7** required marker `*` | stripped | **available** — Gemini preserves `* Title` |
| **R5** per-block confidence | not plumbed | plumbed onto blocks as `score` — but **still not diagnostic**, see the warning below |
| **R3** clipped text | no signal | **still no signal** |
| **R8** determinism | PaddleOCR only | PaddleOCR only — no LLM engine is reproducible |

R5's warning stands unchanged: `score` is layout-*detection* confidence. On the real screenshot
the garbled table merge scores 0.339 and a flawless "Start date (Optional)" scores 0.337. Do not
threshold on it.

### Which engine for which check in `visualCheck.ts`

This is the part that matters for correctness:

- **`missingFromScreen` → `engine=paddleocr`.** It asks "is this recorded value on the screen?",
  and a false *no* blocks a finished application. PaddleOCR is `literal` and deterministic.
  Gemini is `normalized` — it may tidy or drop part of a string, which would make present text
  look absent. Do not use a `normalized` engine for this check.
- **`placeholdersShowing` → Gemini's `placeholder` label.** Strictly better than pattern-matching
  known placeholder strings, which your own notes call fragile and per-ATS: a `placeholder` label
  is per-*pixel*, so the next form's convention needs no new regex.
- **OCR↔DOM box correlation → `paddleocr` only.** See capability above.
- **Both in one call → `/v1/compare`.** Costs the slower engine (~16s), which is affordable now
  that the check no longer blocks the fill run.

### Known gap: compare is synchronous only

`POST /v1/jobs` runs a **single** engine. There is no async compare yet, so for the design in
section 6 you have two options:

1. Submit **one job with `engine=paddleocr`** (the safe engine for `missingFromScreen`) and treat
   Gemini as a later enhancement. Simplest, and loses nothing you have today.
2. Submit **two jobs**, one per engine, and correlate the two callbacks yourself using the job
   code. More work on this side, and you would be re-implementing what `/v1/compare` already does.

If async compare would actually be used, ask for it on the x8ocr side rather than building
option 2 — it is a small change there and none here.

---

## 5. What makes this hard in *this* repo

Do not just fire-and-forget and patch the entry later. Two constraints in this codebase rule that
out, and both are easy to miss.

### The OCR verdict is a GATE, not a note

`applyJob.ts` (~line 515) merges `visualGaps` into the same list as `reviewApplication()` problems.
A non-empty list means the application is marked `error` and **never enters the approval queue**.

So if you queue an entry as `awaiting_approval` and patch it when the callback lands, there is a
window — measured 7–16s, but unbounded — in which a human can approve and send an application whose
screen was never verified. That is precisely the class of bug the check exists to prevent.

### The website may not write application state

`web/app/api/command/route.ts` says it outright:

> *The ONLY write path from the website, and it writes a command — never application state. The
> worker applies it. Every guard that prevents a double submission lives on the worker side.*

And `commands.ts` explains why: the worker is the single writer of `pending-approvals.json`, and
two processes racing on that file has corrupted state here before. So the callback receiver must not
evaluate the OCR text or touch the queue.

### Also: `PendingStatus` warns you off adding a value

> *A set rather than a literal comparison at each site: the guards that read it are spread across
> the worker and the submit path, and adding a status without finding all of them is exactly how one
> of them would keep saying "not submitted yet".*

A `verifying` status would work but means auditing every read site. There is a lower-risk design
that needs no new status.

---

## 6. Recommended design

Carry the verdict **on the entry** and gate the **submit**, not the queueing.

```
applyJob (worker, native)          x8ocr                    website (container)        worker
  screenshot
  POST /v1/jobs ──────────────────▶ 202 {jobId}  (42ms)
  queue entry, visualCheck:pending
  return  ◀── no waiting                │ OCR runs 6-56s
                                        └─▶ POST /api/ocr-result?code=… ──▶ enqueue
                                                                          visual_check ──▶ evaluate
                                                                                           + write verdict
```

Then `submitApprovedEntry()` refuses while the verdict is outstanding. That is the one place every
send passes through, which is where this repo already puts its guards.

**Concretely:**

1. **`approvalQueue.ts`** — add to `PendingEntry`:
   ```ts
   visualCheck?: {
     state: "pending" | "clean" | "gaps" | "unavailable";
     gaps?: string[];
     jobId?: string;
     at: string;   // ISO
   };
   ```
   plus a `setVisualCheck(key, visualCheck)` writer alongside `updatePendingStatus`.

2. **`visualCheck.ts`** — add `submitOcrJob(imagePath, { code })` that POSTs to `/v1/jobs` with the
   API key and returns the `jobId` (or null). Bound only the *submit* with a timeout, never the
   extraction. Also extract the verdict logic currently inline in `applyJob.ts` into one
   `evaluateScreen(screenText, answers)` so the fill path and the callback path cannot drift.

3. **`applyJob.ts`** — replace `await ocrImage(shotPath)` with `submitOcrJob(...)`; record
   `visualCheck: { state: "pending", jobId, at }` on the upsert (`unavailable` if the submit
   failed); and **remove `visualGaps` from the pre-queue gate** — it cannot be known yet.
   A fresh fill must overwrite `visualCheck`, never inherit it: the old verdict describes a
   screenshot that no longer exists.

4. **`commands.ts`** — add a `visual_check` command: `{ code, jobId?, screenText?, failed? }`.

5. **`web/app/api/ocr-result/route.ts`** — new. Not session-authenticated (the caller is a service);
   checks `X8OCR_CALLBACK_TOKEN` with a constant-time compare of SHA-256 digests; reads `?code=`;
   enqueues the command. **Does not look at the OCR text.**

6. **`worker.ts`** — `case "visual_check"`: evaluate with `evaluateScreen`, then `setVisualCheck` to
   `clean` / `gaps` / `unavailable`. Drop the verdict if the entry is gone, or if
   `entry.visualCheck.jobId` no longer matches the command's — a re-fill during OCR produces a new
   screenshot and its own job, and applying an old verdict to a new entry is worse than applying
   none.

7. **`submitApproved.ts`** — the gate, before the write-ahead marker:
   - `gaps` → refuse, set status `error` with the findings.
   - `pending` and younger than `VISUAL_CHECK_GRACE_MS` (suggest 10 min) → return `will_retry`,
     leave it queued.
   - `pending` and older → age out to `unavailable` and proceed. **This matters**: x8ocr jobs do not
     survive a restart, so without ageing out a lost job parks an application forever.
   - `clean` / `unavailable` / absent → proceed.

### Env

Already set — see section 1. `X8OCR_CALLBACK_TOKEN` is generated and shared with x8ocr's
deployment; the website container reads it from the `./.env:/jobapp/.env:ro` mount, so it needs a
container restart to pick it up.

**The callback goes to the website, not the worker** — and this is the part most likely to be got
wrong. The worker is native on the host and *exits between sweeps*, so it cannot receive anything;
the website container is always up and shares `./data`. From x8ocr's container that address is
`host.docker.internal:8088` (verified working).

The receiver must reject everything when `X8OCR_CALLBACK_TOKEN` is unset — fail closed, not open.

---

## 7. Preserve the best-effort contract

This is the single most important invariant to keep, and going async adds three new ways to break it.
`visualCheck.ts` states it: *"Best-effort by design: no service, a timeout, or an empty result makes
the check say nothing rather than block an application. A verifier that fails closed would stop
every submission the moment the sidecar went down."*

Every one of these must end as `unavailable` and let the application through:

- x8ocr unreachable, or the submit 401s / times out
- the callback never arrives (x8ocr restarted and lost the job)
- the job ran but extraction failed (`result.ok === false`)
- OCR returned empty or whitespace-only text

Only a **real gap on real text** may block. `evaluateScreen("")` must return `[]`, not a complaint.

---

## 8. Deploying

**Restart the worker.** A worker built before `visual_check` exists rejects the command as
*"unrecognised command"* — observed live while testing. The failure mode is safe (no verdict is
applied, the check ages out to `unavailable`, nothing is blocked) but no verification happens at all,
which silently defeats the point.

x8ocr itself is already up and current on this host — `curl -sS http://localhost:8799/healthz`
reports `auth.keys: 3` and `jobs`. Until the receiver route exists, x8ocr's callback attempts get
a 401 from the website and give up after one attempt (no retry on a 4xx, by design), which is
harmless: the check simply ages out to `unavailable`.

Sanity checks after deploying:

```bash
curl -sS http://localhost:8799/healthz          # engines + auth + job stats, no key needed
npm run check && npm run test:visual && npm run test:sanity
```

Then watch one real fill run for: `visual cross-check queued (x8ocr job …)` in the fill log, a
`visual_check` command appearing in `data/commands/`, and `visualCheck` landing on the queue entry.

---

## Why your OCR was returning nothing

Worth knowing, because it means the layout data you were told was unavailable is in fact available.

x8ocr sent three pipeline flags on every request. Two of them make this provider fail, and all three
together return `errorMsg: "Success"` with **zero pages** — so x8ocr reported `EMPTY` and the failure
looked like an unreadable screenshot rather than a bad request. Deterministic, verified repeatedly:

```
minimal payload                    pages=1  blocks=13   Success
+ useDocOrientationClassify:false  pages=1  blocks=14   Success
+ useDocUnwarping:false            pages=0              系统错误-解析
+ useChartRecognition:false        pages=0              系统错误-解析
all three (what x8ocr sent)        pages=0              Success
```

Fixed in x8ocr. `screenshots/issue 2.png` now returns `ok=true engine=paddleocr`, 14 typed blocks,
15 detection boxes, page 1130×1038, with reading order — so the `parsing_res_list` box-level pairing
your requirements doc plans for is ready to build on.

**R8 (determinism) is confirmed** for PaddleOCR — byte-identical blocks and identical scores
across three runs of the same bytes. No LLM engine has this, so a screenshot before/after diff
must pin `engine=paddleocr`.

Where every other requirement now stands is in [section 4](#4-layout-aware-ocr-blocks-capability-and-compare):
R2, R4, R6 and R7 became available once a second engine was added, R5 is plumbed but still not
diagnostic, and R3 has no signal. Note this supersedes the earlier written assessment on those
four items — it was accurate when PaddleOCR was the only layout engine.

---

## Reference implementation

A complete, typechecking, tested implementation of everything in section 6 exists — written while
working out the constraints above, then set aside so this repo's own agent owns the change.

```bash
git stash list          # "x8ocr async visual-check reference implementation (verified…)"
git stash show -p stash@{0} | less     # read it without applying
git stash pop           # apply it, if you want it as a starting point
```

It touches `applyJob.ts`, `submitApproved.ts`, `approvalQueue.ts`, `commands.ts`, `visualCheck.ts`,
`worker.ts`, `visualCheckCases.ts`, `CLAUDE.md`, and adds `web/app/api/ocr-result/route.ts`
(+308 lines). `npm run check`, the web typecheck, `test:visual` (20 cases) and `test:sanity`
(12 cases) all pass on it.

What was verified on it end-to-end, with the real provider and the real route handler: submit →
OCR → callback → `401` on missing and on wrong token → `visual_check` command written to
`data/commands/` with the real 1077-character page text → verdict evaluated:

```
• "Start date" was recorded as "08/2026" but is not on the screen
• "End date" was recorded as "05/2028" but is not on the screen
• 2 date field(s) still showing the MM/YYYY placeholder
→ gaps → SUBMIT BLOCKED
```

That is the original reverted-datepicker bug, caught — while staying correctly silent on the
visually truncated Title, and on Company and Industry.

**Not verified:** a full Playwright fill run against a live ATS form. The seam to watch on the first
real run is `applyJob` recording `visualCheck` on the queue entry.

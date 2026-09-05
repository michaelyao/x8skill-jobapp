import fs from "node:fs";
import path from "node:path";
import {
  boxesAreExact,
  describeVerdicts,
  textIsLiteral,
  unansweredOnScreen,
  verifyFields,
  type ScreenBlock,
  type ScreenCapability,
} from "./screenBlocks.js";
import { recordOcrOutcome } from "./ocrHealth.js";
import { mergeTileBlocks, planTiles, type Tile } from "./tiles.js";

/**
 * What the page LOOKS like, via OCR of the review screenshot — the one source of truth the DOM
 * cannot give us.
 *
 * Every bad application this session shared a shape: the DOM said a value was there and the screen
 * disagreed. The clearest case was a Workable End date recorded as "05/2028" that the screenshot
 * showed as an empty "MM/YYYY" placeholder, because the react-datepicker had reverted it. read()
 * asked the input for its value and the input lied. A screenshot cannot lie in that direction.
 *
 * DELIBERATELY A VERIFICATION PASS, NOT A READER. Measured against x8ocr on real pages:
 *   - The output is markdown TEXT with no coordinates, so it cannot give a fillable handle. You
 *     still need input[name="end_date"] to type into; OCR only tells you what is showing.
 *   - It cannot separate two identically-labelled fields (this form has two "Summary (Optional)")
 *     any better than the DOM could.
 *   - SLOW AND UNPREDICTABLE: 1.6-10.7s for a small region, ~56s for a full-page screenshot,
 *     with a 4x spread on repeat submissions of identical bytes. No timeout is both safe and
 *     tight, which is why this is submitted as an x8ocr JOB and the verdict arrives later via
 *     callback (see submitOcrJob) rather than being awaited inside the fill run.
 *   - Overlays confuse it: with the date picker open it rendered the Title field as a table of
 *     "Title | Oct | Nov | Dec". It is least reliable exactly where reading is hardest.
 *
 * So it runs once, on the review screenshot, and its only job is to catch a value we believe we
 * filled that is not actually on the screen.
 */

const endpoint = (): string => process.env.X8OCR_API_ENDPOINT || "http://localhost:8799";

/** x8ocr requires an API key on every extract/job call; without one it answers 401. */
const apiKeyHeader = (): Record<string, string> => {
  const key = (process.env.X8OCR_API_KEY || "").trim();
  return key ? { authorization: `Bearer ${key}` } : {};
};

/** OCR one image. Returns null on any failure — this must never block an application. */
export async function ocrImage(imagePath: string, timeoutMs = 90_000): Promise<string | null> {
  if (!fs.existsSync(imagePath)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new FormData();
    const bytes = await fs.promises.readFile(imagePath);
    body.append("file", new Blob([bytes], { type: "image/png" }), path.basename(imagePath));
    const res = await fetch(`${endpoint().replace(/\/$/, "")}/v1/extract`, {
      method: "POST",
      headers: apiKeyHeader(),
      body,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { ok?: boolean; markdown?: string };
    return json.markdown ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * OCR with layout, SYNCHRONOUSLY, for a check that has to answer before the page changes.
 *
 * The whole-application check is asynchronous on purpose: it submits a job and lets the verdict
 * arrive later, so a fill never waits on it. That is right for the review screenshot and wrong for
 * a page about to be left behind — on a multi-page ATS the only remedy a late verdict allows is
 * "go back to page 3 and try again", which is slower and less reliable than never advancing with a
 * required question unanswered.
 *
 * Best-effort like everything else here: no service, a timeout, or an empty result returns null and
 * the caller carries on. A verifier that fails closed would stop every application the moment the
 * sidecar went down.
 */
export interface LayoutResult {
  blocks: ScreenBlock[];
  capability?: ScreenCapability;
  /**
   * The SERVICE could not be reached or refused the request — as opposed to reading the page and
   * finding nothing. The difference decides whether an application may continue: a page that
   * genuinely has no text is not a reason to stop, and a checker that is down is.
   */
  unavailable?: string;
}

/**
 * Only one OCR request at a time, from this process.
 *
 * x8ocr processes one image at a time, so two of our own requests do not run in parallel — they
 * QUEUE, and each one's clock is our timeout. A 1440x10643 full-page screenshot takes it 66 seconds
 * on its own; two stacked exceed three minutes and both abort. Measured: 102 aborts in one log,
 * every single one our own AbortController rather than a service that was down, while a probe
 * moments later answered fine.
 *
 * Serialising costs nothing we were getting anyway — the requests were already serial inside the
 * service — and it stops us being the cause of our own timeouts.
 */
let ocrGate: Promise<unknown> = Promise.resolve();
function serialise<T>(work: () => Promise<T>): Promise<T> {
  const run = ocrGate.then(work, work);
  // Keep the chain alive whatever this call does, or one rejection blocks every later request.
  ocrGate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * READ A PAGE IN SLICES, and return one result in the page's own coordinates.
 *
 * A full-page capture of a long form cannot be read at all — measured, with paddleocr unreachable:
 * 1761px in 9-16s, 3080px and 12206px both dead after 301s. So the shot is taken in overlapping
 * slices no taller than MAX_TILE_HEIGHT and the blocks are put back together.
 *
 * A tile that fails does NOT sink the page. Its region is simply unread, which is the same
 * situation as a value OCR did not detect, and the field-level rules already treat an
 * unattributable field as unlocatable rather than as a fault. Only ALL tiles failing means the
 * checker could not read this page.
 */
export async function ocrLayoutTiled(
  shoot: (tile: Tile, index: number) => Promise<string | null>,
  pageHeight: number,
): Promise<LayoutResult | null> {
  const tiles = planTiles(pageHeight);
  const perTile: Array<{ tile: Tile; blocks: ScreenBlock[] }> = [];
  const texts: string[] = [];
  let capability: ScreenCapability | undefined;
  let lastFailure = "";
  for (const [i, tile] of tiles.entries()) {
    const file = await shoot(tile, i);
    if (!file) { lastFailure = "the slice could not be captured"; continue; }
    /**
     * ONE RETRY PER SLICE, because an abort here is usually contention, not a broken service.
     *
     * Measured on the last ~150 slice attempts: 20 aborted, and every abort was our own
     * AbortController while a probe moments later answered in 3-6 seconds. The serialise() gate
     * above only orders THIS process's requests, and x8ocr serves three API keys — so anything
     * else talking to it pushes our slice past its clock.
     *
     * Skipping the slice was cheap for us and expensive for the verdict: 134 pages in that same
     * log were read "1 of 4", "1 of 5", which means a "clean" cross-check that saw a fifth of the
     * form. Worse, two submits were refused outright because the first slice was the one that
     * aborted. A single retry after a pause costs seconds and recovers most of that.
     */
    let one = await ocrLayout(file).catch(() => null);
    if (!one || one.unavailable) {
      const first = one?.unavailable ?? "x8ocr returned nothing";
      await new Promise((r) => setTimeout(r, 2_000));
      one = await ocrLayout(file).catch(() => null);
      if (one && !one.unavailable) {
        console.log(`  [ocr] slice ${i + 1}/${tiles.length} (y=${tile.offsetY}) failed once (${first.slice(0, 60)}) and read on the retry`);
      }
    }
    if (!one || one.unavailable) {
      lastFailure = one?.unavailable ?? "x8ocr returned nothing";
      console.log(`  [ocr] slice ${i + 1}/${tiles.length} (y=${tile.offsetY}) failed twice: ${lastFailure}`);
      continue;
    }
    capability ??= one.capability;
    perTile.push({ tile, blocks: (one.blocks ?? []) as ScreenBlock[] });
    for (const b of (one.blocks ?? []) as ScreenBlock[]) if (String(b.text ?? "").trim()) texts.push(String(b.text));
  }
  if (!perTile.length) return { unavailable: lastFailure || "no slice could be read" } as LayoutResult;
  if (perTile.length < tiles.length) {
    // Say the COVERAGE, not just the count: "1 of 5" is 20% of the form, and a clean verdict on
    // that much is much weaker evidence than a clean verdict on all of it.
    const pct = Math.round((perTile.length / tiles.length) * 100);
    console.log(
      `  [ocr] read ${perTile.length} of ${tiles.length} slice(s) — about ${pct}% of the page; ` +
        `the rest is unread, not wrong`,
    );
  }
  // The callers that want plain text join the blocks themselves; `texts` is kept only to report
  // how much was read.
  void texts;
  return { blocks: mergeTileBlocks(perTile), capability };
}

export async function ocrLayout(
  imagePath: string,
  /**
   * Generous on purpose, and MEASURED: a 1440x10643 full-page screenshot of a long Workday form
   * takes x8ocr 66 seconds. Two of ours stacked exceeded the previous three-minute limit and both
   * aborted — 102 times in one log — which fail-closed then turned into refused fills and refused
   * submits. The cost of waiting is minutes on an application; the cost of not waiting is a required
   * question submitted blank, or a correct application refused. Waiting is the cheaper mistake.
   */
  /**
   * 300s, NOT the 600 this used to say. Node's fetch is undici, whose headersTimeout is 300
   * SECONDS and is not raised by our AbortController — so a longer number here was never
   * achievable and the code was describing a guarantee it did not have.
   *
   * That cap is what produced the "outage". x8ocr queues requests; with a bulk audit of 27
   * screenshots running in another process alongside live fills, a new request waited past 300s
   * for its turn, undici abandoned it, and Node reported the generic "fetch failed" with the real
   * reason hidden in `cause`. x8ocr then processed those same requests and logged them read in
   * 5-21 seconds. Every layer said "the checker is down" and the checker was busy — with work I
   * had queued.
   */
  timeoutMs = 300_000,
): Promise<LayoutResult | null> {
  if (!fs.existsSync(imagePath)) return null;
  /**
   * PADDLE FIRST, THEN AIROUTER/SONNET, THEN GEMINI FLASH — the candidate's order.
   *
   * x8ocr takes an `engine` per request (`/openapi.json`): "paddleocr", or
   * "vision:<provider>[:<model>]" with airouter (sonnet) and gemini (gemini-2.5-flash)
   * configured. Left unpinned it runs its own cascade, which is paddle then the DEFAULT vision
   * provider — gemini — so sonnet never got a turn and a slow paddle meant a slow everything.
   *
   * Measured on a real review screenshot: paddleocr 3-6s, airouter:sonnet 47-62s,
   * gemini-2.5-flash a few seconds. So each rung gets its own budget rather than sharing one
   * clock: a paddle that has gone quiet costs 90s and then we move on, instead of burning the
   * whole 300s and reporting the checker unavailable — which is what refused two submits today.
   *
   * ONLY PADDLE GIVES EXACT BOXES. The vision rungs still answer the text-level checks (is this
   * required question answered on screen?), and the capability gate above them keeps field-level
   * pairing off unless the boxes are exact. A fallback that reads the page is worth having; a
   * fallback that pretends to know where the words are is not.
   */
  const LADDER: Array<{ engine: string; ms: number }> = [
    { engine: "paddleocr", ms: Math.min(90_000, timeoutMs) },
    { engine: "vision:airouter:sonnet", ms: Math.min(120_000, timeoutMs) },
    { engine: "vision:gemini:gemini-2.5-flash", ms: Math.min(90_000, timeoutMs) },
  ];
  let result: LayoutResult | null = null;
  for (const [i, rung] of LADDER.entries()) {
    result = await serialise(() => ocrLayoutOnce(imagePath, rung.ms, rung.engine));
    if (result && !result.unavailable) {
      if (i > 0) console.log(`  [ocr] ${rung.engine} answered after ${LADDER.slice(0, i).map((r) => r.engine).join(", ")} did not`);
      break;
    }
    if (i < LADDER.length - 1) {
      console.log(`  [ocr] ${rung.engine} did not answer (${result?.unavailable ?? "no result"}) — trying ${LADDER[i + 1].engine}`);
    }
  }
  /**
   * TELL THE HEALTH FILE WHAT ACTUALLY HAPPENED. probeOcr posts no image, so it reports a
   * reachable service as healthy while every real check fails — which is exactly what happened
   * when both of x8ocr's engines were down and the red flag never lit.
   */
  await recordOcrOutcome(Boolean(result) && !result?.unavailable, result?.unavailable ?? "no result").catch(
    () => undefined,
  );
  return result;
}

async function ocrLayoutOnce(imagePath: string, timeoutMs: number, engine?: string): Promise<LayoutResult | null> {
  if (!fs.existsSync(imagePath)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new FormData();
    const bytes = await fs.promises.readFile(imagePath);
    body.append("file", new Blob([bytes], { type: "image/png" }), path.basename(imagePath));
    body.append("includeLayout", "true");
    // Pinning the engine disables x8ocr's own cascade, which is the point: the ladder above
    // decides the order, so a rung that fails falls to the NEXT one we chose rather than to
    // whatever the service defaults to.
    if (engine) body.append("engine", engine);
    const res = await fetch(`${endpoint().replace(/\/$/, "")}/v1/extract`, {
      method: "POST",
      headers: apiKeyHeader(),
      body,
      signal: controller.signal,
    });
    if (!res.ok) return { blocks: [], unavailable: `x8ocr answered HTTP ${res.status}` };
    const json = (await res.json()) as {
      pages?: Array<{ blocks?: ScreenBlock[] }>;
      capability?: ScreenCapability;
    };
    const blocks = json.pages?.[0]?.blocks ?? [];
    return { blocks, capability: json.capability };
  } catch (error) {
    /**
     * Unreachable, aborted, or unparseable — the checker is not working, and the caller must be
     * able to tell that apart from a page it read and found nothing on.
     *
     * KEEP THE CAUSE. Node's fetch says only "fetch failed" and puts the reason in `cause`, so
     * every failure in this system read identically whether the service was absent, the socket
     * was reset, or undici's 300-SECOND header timeout had expired. That last one is what was
     * really happening — x8ocr logged the same requests as read in 5-21 seconds — and it cost
     * hours of looking at the wrong service.
     */
    const err = error as Error & { cause?: { code?: string; message?: string } };
    const cause = err.cause?.code ?? err.cause?.message ?? "";
    return {
      blocks: [],
      unavailable: `x8ocr did not answer: ${err.message.slice(0, 60)}${cause ? ` (${String(cause).slice(0, 40)})` : ""}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Fold everything that differs between a rendered glyph and a stored string. */
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[ ]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Which fields do we check? Only the ones whose value is a FACT and short enough to survive OCR
 * intact. Long free text (cover letters, essays) wraps and re-flows, and demanding an exact
 * appearance would report every application as broken — the failure mode that would make this
 * whole check worthless.
 */
const CHECKABLE = /\b(school|university|degree|field of study|major|gpa|company|employer|title|start date|end date|first name|last name|email|phone)\b/i;

/** Values that are legitimately not rendered as text. */
const NOT_RENDERED = /^(yes|no|true|false|on|off)$/i;

export interface VisualGap {
  label: string;
  value: string;
}

/**
 * Answers we believe we filled whose value does NOT appear on screen. Pure, so it is testable
 * without a browser or the OCR service: npm run test:visual.
 *
 * Conservative on purpose — it only looks at short, factual values, and a value counts as present
 * if its folded form appears anywhere in the folded page text. A false positive here blocks a
 * finished application, so the bar is "definitely not on the screen", not "not where I expected".
 */
export function missingFromScreen(
  answers: Array<{ label: string; value: string; type?: string }>,
  screenText: string,
): VisualGap[] {
  const screen = fold(screenText);
  if (!screen) return []; // no OCR result — say nothing rather than blame the application
  const gaps: VisualGap[] = [];
  for (const { label, value } of answers) {
    const text = (value ?? "").trim();
    if (!text || text.length > 60) continue; // long free text re-flows; not checkable
    if (NOT_RENDERED.test(text)) continue;
    if (!CHECKABLE.test(label ?? "")) continue;
    const needle = fold(text);
    if (!needle || needle.length < 3) continue;

    /**
     * A narrow input TRUNCATES what it displays. "Software Engineering Intern, Shield
     * Infrastructure" renders as "Software Engineering Intern, Shield Infrastruc", so demanding
     * the whole string reported a correctly-filled field as missing — the first false positive
     * this check produced, and exactly the kind that would make it useless. For anything long,
     * require a PREFIX: enough to identify the value, short enough to survive clipping.
     */
    const probe = needle.length > 24 ? needle.slice(0, 24) : needle;
    if (!screen.includes(probe)) gaps.push({ label: (label ?? "").trim(), value: text });
  }
  return gaps;
}

/** Is a date field showing its placeholder — i.e. empty — where we recorded a value? */
export function placeholdersShowing(screenText: string): string[] {
  const out: string[] = [];
  // "MM/YYYY" on the page means an empty Workable date field. It is the single most direct
  // evidence of the reverted-datepicker bug.
  const count = (screenText.match(/MM\s*\/\s*YYYY/gi) ?? []).length;
  if (count > 0) out.push(`${count} date field(s) still showing the MM/YYYY placeholder`);
  return out;
}

/**
 * Hand the screenshot to x8ocr as a JOB and return its id immediately.
 *
 * The fill run does not wait: x8ocr POSTs the result to `callbackUrl` when it is done, the
 * website turns that into a `visual_check` command, and the worker applies the verdict to the
 * queue entry. Until then the entry carries visualCheck.state === "pending", which the submit
 * guard refuses — so nothing can be approved-and-sent on an unverified screen.
 *
 * Returns null on any failure, and a null must never block an application: the caller records
 * the check as "unavailable", which behaves exactly as a null OCR result always did.
 */
export async function submitOcrJob(
  imagePath: string,
  opts: { code: string; timeoutMs?: number },
): Promise<string | null> {
  if (!fs.existsSync(imagePath)) return null;
  const callbackUrl = process.env.X8OCR_CALLBACK_URL;
  const callbackToken = process.env.X8OCR_CALLBACK_TOKEN;
  if (!callbackUrl || !callbackToken) return null; // not configured — stay synchronous-free, say nothing

  const controller = new AbortController();
  // Only the SUBMIT is bounded here; the extraction itself has no deadline on this side.
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const body = new FormData();
    const bytes = await fs.promises.readFile(imagePath);
    body.append("file", new Blob([bytes], { type: "image/png" }), path.basename(imagePath));
    // `code` rides along so the callback can name the entry the verdict belongs to.
    body.append("callbackUrl", `${callbackUrl}${callbackUrl.includes("?") ? "&" : "?"}code=${encodeURIComponent(opts.code)}`);
    body.append("callbackToken", callbackToken);
    // Layout blocks turn this from "does the value appear anywhere on the page" into "is it in ITS
    // OWN box" — see screenBlocks.ts. Containment alone can PASS an empty field whose value happens
    // to appear elsewhere on the page.
    body.append("includeLayout", "true");

    const res = await fetch(`${endpoint().replace(/\/$/, "")}/v1/jobs`, {
      method: "POST",
      headers: apiKeyHeader(),
      body,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { jobId?: string };
    return json.jobId ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The whole verdict, from page text plus what we believe we filled. One implementation so the
 * fill run and the async callback path can never disagree about what counts as a gap.
 */
export function evaluateScreen(
  screenText: string,
  answers: Array<{ label: string; value: string; type?: string }>,
  /** Layout blocks and the engine's own trust statement, when the result carried them. */
  layout?: { blocks?: ScreenBlock[]; capability?: ScreenCapability },
): string[] {
  /**
   * FIELD-LEVEL when the engine's boxes are real, page-level otherwise.
   *
   * Page-level containment catches a false success but can produce a false PASS: a value that
   * appears somewhere else on the page — in the job description, or inside another field's text —
   * vouches for a field that is actually empty. With exact boxes each label is paired to its own
   * value box, so "empty" means empty.
   *
   * Both gates matter. `boxes: "approximate"` is an LLM's estimate and must not be lined up against
   * anything; `textFidelity: "normalized"` means the model may tidy text away, so absent text is
   * not evidence of an unfilled field. Either one and this falls back rather than guessing.
   */
  const blocks = layout?.blocks ?? [];
  if (blocks.length && boxesAreExact(layout?.capability) && textIsLiteral(layout?.capability)) {
    /**
     * Both directions. verifyFields asks "is what we recorded on the screen?" and can only confirm
     * what we already believe; unansweredOnScreen asks "is what the screen REQUIRES recorded?" and
     * is the only one of the two that can see a question the reader never found. Five required
     * questions reached review unanswered because nothing asked the second question.
     */
    return [...describeVerdicts(verifyFields(blocks, answers)), ...unansweredOnScreen(blocks, answers)];
  }

  if (!screenText.trim()) return []; // no OCR result — say nothing rather than blame the application
  return [
    ...missingFromScreen(answers, screenText).map(
      (g) => `"${g.label}" was recorded as ${JSON.stringify(g.value)} but is not on the screen`,
    ),
    ...placeholdersShowing(screenText),
  ];
}

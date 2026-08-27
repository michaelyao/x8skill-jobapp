import fs from "node:fs";
import path from "node:path";

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
 *   - 25-33 SECONDS per full-page screenshot. Per page per turn that is 3-4 minutes an
 *     application; once per application at review it is noise.
 *   - Overlays confuse it: with the date picker open it rendered the Title field as a table of
 *     "Title | Oct | Nov | Dec". It is least reliable exactly where reading is hardest.
 *
 * So it runs once, on the review screenshot, and its only job is to catch a value we believe we
 * filled that is not actually on the screen.
 */

const endpoint = (): string => process.env.X8OCR_API_ENDPOINT || "http://localhost:8799";

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
  answers: Array<{ label: string; value: string }>,
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

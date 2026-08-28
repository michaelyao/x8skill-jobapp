import fs from "node:fs";
import path from "node:path";
import { LOGS_DIR } from "../config.js";
import { loadEnv } from "../utils/env.js";
import { loadPendingQueue } from "../knowledge/approvalQueue.js";
import { enqueueCommand } from "../knowledge/commands.js";

/**
 * Re-judge a saved review SCREENSHOT, without reopening the employer's form.
 *
 * A visual verdict is a judgement about a picture, so when the judging code changes the old verdict
 * is stale — not wrong about the form, wrong about itself. Nine applications were held out of the
 * review queue by pairing bugs in screenBlocks.ts (a label paired with the next field's label, a
 * section heading read as a value, a textarea showing its tail); fixing those does not clear the
 * verdicts already written.
 *
 * The alternative — re-filling to produce a fresh screenshot — touches a live application at an
 * employer for no reason: the screenshot we already have is of the very form we would re-open. So
 * this re-runs OCR on that file and hands the result to the SAME `visual_check` command the x8ocr
 * callback uses. The worker evaluates and writes; this tool writes nothing to application state,
 * because the worker is the only writer of it.
 *
 *   npx tsx src/debug/recheckScreens.ts            # every entry whose check reported gaps
 *   npx tsx src/debug/recheckScreens.ts CODE CODE  # only these
 *
 * A screenshot OLDER than the entry's review is skipped: the answers on the entry were filled after
 * that picture was taken, so comparing them would judge the wrong screen.
 */

loadEnv();

const endpoint = (): string => (process.env.X8OCR_API_ENDPOINT || "http://localhost:8799").replace(/\/$/, "");

/** The newest review screenshot for a code, across run directories. */
function newestScreenshot(code: string): { file: string; mtime: number } | undefined {
  let best: { file: string; mtime: number } | undefined;
  let runs: string[];
  try {
    runs = fs.readdirSync(LOGS_DIR);
  } catch {
    return undefined;
  }
  for (const run of runs) {
    const file = path.join(LOGS_DIR, run, `review-${code}.png`);
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (!best || mtime > best.mtime) best = { file, mtime };
    } catch {
      /* not this run */
    }
  }
  return best;
}

interface OcrResult {
  markdown?: string;
  pages?: Array<{ blocks?: unknown[] }>;
  capability?: Record<string, unknown>;
}

async function ocr(file: string): Promise<OcrResult | null> {
  const body = new FormData();
  body.append("file", new Blob([await fs.promises.readFile(file)], { type: "image/png" }), path.basename(file));
  // The same flag submitOcrJob sends — without layout the result falls back to page-level
  // containment, which is the check being replaced.
  body.append("includeLayout", "true");
  const key = (process.env.X8OCR_API_KEY || "").trim();
  const res = await fetch(`${endpoint()}/v1/extract`, {
    method: "POST",
    headers: key ? { authorization: `Bearer ${key}` } : {},
    body,
  });
  if (!res.ok) return null;
  return (await res.json()) as OcrResult;
}

async function main(): Promise<void> {
  const only = new Set(process.argv.slice(2).map((s) => s.toUpperCase()));
  const entries = (await loadPendingQueue()).filter((e) => {
    if (only.size) return only.has((e.code ?? "").toUpperCase());
    return e.visualCheck?.state === "gaps";
  });
  if (!entries.length) {
    console.log(only.size ? "No matching entries." : "No entry is held by a visual check.");
    return;
  }
  console.log(`${entries.length} screen(s) to re-judge.\n`);

  for (const entry of entries) {
    const code = entry.code ?? entry.key;
    const shot = newestScreenshot(code);
    if (!shot) {
      console.log(`  ${code}  no saved review screenshot — skipped`);
      continue;
    }
    const reviewed = Date.parse(entry.reviewSentAt ?? "");
    if (Number.isFinite(reviewed) && shot.mtime < reviewed - 10 * 60_000) {
      console.log(`  ${code}  the newest screenshot predates this copy of the application — skipped`);
      continue;
    }
    const result = await ocr(shot.file).catch(() => null);
    if (!result?.markdown) {
      console.log(`  ${code}  OCR produced nothing — left as it was`);
      continue;
    }
    const blocks = result.pages?.[0]?.blocks;
    await enqueueCommand({
      name: "visual_check",
      code,
      screenText: result.markdown,
      blocks,
      capability: result.capability,
      source: "recheck-screens",
      actor: "recheck",
    });
    console.log(`  ${code}  queued a re-judge of ${path.relative(process.cwd(), shot.file)} (${blocks?.length ?? 0} blocks)`);
  }

  console.log("\nThe WORKER applies these — it is the only writer of the queue. Watch its log for the verdicts.");
}

void main();

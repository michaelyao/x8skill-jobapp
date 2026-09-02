import fs from "node:fs";
import path from "node:path";
import { LOGS_DIR } from "../config.js";
import { loadEnv } from "../utils/env.js";
import { loadPendingQueue } from "../knowledge/approvalQueue.js";
import { enqueueCommand } from "../knowledge/commands.js";
import { ocrLayout } from "../knowledge/visualCheck.js";

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

/**
 * Use the SHARED reader, not a private copy.
 *
 * This tool had its own fetch with the default timeout, and it silently skipped a 62-block
 * screenshot that the live path reads fine — leaving a stale verdict in place and under-reporting
 * the very improvement it was run to measure. A batch of forty-two would have done that quietly on
 * whichever ones happened to be slow.
 */
async function ocr(file: string): Promise<{ blocks: unknown[]; capability?: unknown; markdown?: string } | null> {
  const layout = await ocrLayout(file);
  if (!layout || layout.unavailable) {
    if (layout?.unavailable) console.log(`      (${layout.unavailable})`);
    return null;
  }
  return { blocks: layout.blocks, capability: layout.capability };
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
    if (!result) {
      console.log(`  ${code}  OCR produced nothing — left as it was`);
      continue;
    }
    const blocks = result.blocks;
    /**
     * SEND THE TEXT AS WELL AS THE BLOCKS. An empty screenText is how the worker recognises "OCR
     * gave us nothing", so leaving it blank made every re-judge age straight out to "unavailable"
     * without the new judging ever running — the tool reported ten queued re-judges and changed
     * ten verdicts to "we could not check", which reads like a downed service rather than a bug
     * here. The blocks carry the text already, so joining them costs nothing and also feeds the
     * page-level fallback when the engine's boxes are not exact.
     */
    const screenText = (blocks ?? [])
      .map((b) => String((b as { text?: unknown }).text ?? ""))
      .filter((t) => t.trim())
      .join("\n");
    await enqueueCommand({
      name: "visual_check",
      code,
      screenText,
      blocks,
      capability: result.capability as Record<string, unknown> | undefined,
      source: "recheck-screens",
      actor: "recheck",
    });
    console.log(`  ${code}  queued a re-judge of ${path.relative(process.cwd(), shot.file)} (${blocks?.length ?? 0} blocks)`);
  }

  console.log("\nThe WORKER applies these — it is the only writer of the queue. Watch its log for the verdicts.");
}

void main();

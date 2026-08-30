import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";

/**
 * Is the visual checker working, and does anyone know if it is not?
 *
 * This system's whole value is that an application is CORRECT before a human is asked to approve
 * it. x8ocr is the only check that can see a field the DOM reader missed — five required questions
 * on one Ashby form were invisible to read() and only the screenshot could have caught them. So
 * filling without it is filling blind, and the honest response to a checker that is down is to stop
 * rather than to produce applications nobody has verified.
 *
 * That is a deliberate reversal. Every other failure here is best-effort: no service, a timeout, a
 * bad key, all return null and the run carries on. That was right while the check was a bonus. It
 * is wrong now that it is the thing standing between a blank required field and a submitted
 * application.
 *
 * One file, written by the worker and read by the website, so a red flag on the page and the
 * worker's refusal cannot disagree about whether the checker is up.
 */
export interface OcrHealth {
  ok: boolean;
  checkedAt: string;
  /** Why it is considered down. Absent when ok. */
  reason?: string;
  /** When it last worked, so the page can say how long it has been out. */
  lastOkAt?: string;
}

const HEALTH_PATH = path.join(DATA_DIR, "ocr-health.json");

export async function readOcrHealth(): Promise<OcrHealth | null> {
  try {
    return JSON.parse(await fs.readFile(HEALTH_PATH, "utf8")) as OcrHealth;
  } catch {
    return null;
  }
}

/** Record the checker's state. Keeps `lastOkAt` across a failure so the page can say how long. */
export async function writeOcrHealth(ok: boolean, reason?: string): Promise<void> {
  const previous = await readOcrHealth();
  const now = new Date().toISOString();
  const health: OcrHealth = {
    ok,
    checkedAt: now,
    ...(ok ? {} : { reason }),
    lastOkAt: ok ? now : previous?.lastOkAt,
  };
  const tmp = `${HEALTH_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(health, null, 2), "utf8");
  await fs.rename(tmp, HEALTH_PATH);
}

/**
 * Ask x8ocr whether it is there. Cheap — no image, just whether the service answers.
 *
 * A 401 counts as DOWN: an unauthenticated checker verifies nothing, and the failure that hides
 * best is the one where every call returns 401 and every application quietly goes unverified.
 */
export async function probeOcr(timeoutMs = 10_000): Promise<{ ok: boolean; reason?: string }> {
  const base = (process.env.X8OCR_API_ENDPOINT || "http://localhost:8799").replace(/\/$/, "");
  const key = (process.env.X8OCR_API_KEY || "").trim();
  if (!key) return { ok: false, reason: "X8OCR_API_KEY is not set — every call would answer 401" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // No documented health route, so ask for something harmless: a bad request from a REACHABLE
    // service still proves it is up, where a network error does not.
    const res = await fetch(`${base}/v1/extract`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: `x8ocr rejected our key (HTTP ${res.status})` };
    if (res.status >= 500) return { ok: false, reason: `x8ocr answered HTTP ${res.status}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `x8ocr did not answer: ${(error as Error).message.slice(0, 90)}` };
  } finally {
    clearTimeout(timer);
  }
}

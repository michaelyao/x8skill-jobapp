/**
 * WHY A WHOLE RUN FAILED - diagnosed at the moment it fails, not when someone asks.
 *
 * Study mode watches one thing: a required field that refuses a value. ID.me failed at the RUN
 * level - the visual checker answered HTTP 422 to every engine because we were sending it an empty
 * slice - and nothing was watching that, so it sat in the queue until the candidate asked what the
 * message meant. His objection is exact: "Why you have to wait for me to raise it, then you fix?"
 *
 * A run knows, at the moment it gives up, everything needed to say something useful: what it was
 * doing, which page it reached, what it could not answer, and what the failing subsystem actually
 * returned. This asks for a reading of that and writes it down against the ATS, so the pattern is
 * visible after two occurrences rather than after a person notices.
 *
 * It DIAGNOSES ONLY, like the field study. Nothing here changes a form or a status.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { callModel } from "./modelCall.js";

export interface RunFailure {
  ats: string;
  code?: string;
  company?: string;
  /** The outcome the run reported, e.g. "did not reach review". */
  outcome: string;
  /** The message a human would see. */
  message: string;
  /** Where it got to, if known. */
  page?: string;
  /** Fields it could not answer, if any. */
  blocked?: string[];
}

export interface RunDiagnosis extends RunFailure {
  why: string;
  at: string;
}

const NOTES = path.join(DATA_DIR, "run-notes.json");

export async function readRunNotes(): Promise<RunDiagnosis[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(NOTES, "utf8"));
    return Array.isArray(parsed) ? (parsed as RunDiagnosis[]) : [];
  } catch {
    return [];
  }
}

/**
 * Ask what this failure IS, and record it. Kept short deliberately: the value is in a sentence
 * that names the subsystem and the likely cause, not in an essay.
 */
export async function diagnoseRunFailure(failure: RunFailure): Promise<string> {
  const system = [
    "You read a failed automated job-application run and say, in one sentence, what went wrong.",
    "Name the SUBSYSTEM at fault where the evidence supports it: the form reader, the filler, the",
    "OCR cross-check, the ATS itself, or the posting. Distinguish a service that is DOWN from one",
    "that REJECTED our request - an HTTP status in the message is decisive evidence of the latter.",
    "Under 30 words. No advice unless the evidence supports it.",
  ].join(" ");
  const user = [
    `ATS: ${failure.ats}`,
    failure.company ? `Company: ${failure.company}` : "",
    `Outcome: ${failure.outcome}`,
    `Message: ${failure.message}`,
    failure.page ? `Reached: ${failure.page}` : "",
    failure.blocked?.length ? `Could not answer: ${failure.blocked.slice(0, 6).join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const why = (await callModel(system, user).catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 240);
  const line = why || "no diagnosis available";
  const entry: RunDiagnosis = { ...failure, why: line, at: new Date().toISOString() };
  const all = await readRunNotes();
  all.push(entry);
  await fs.mkdir(path.dirname(NOTES), { recursive: true }).catch(() => undefined);
  await fs.writeFile(NOTES, `${JSON.stringify(all.slice(-300), null, 2)}\n`, "utf8").catch(() => undefined);
  return line;
}

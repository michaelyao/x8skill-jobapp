import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ringBell } from "./log.js";
import type { LearningEvent } from "../types.js";
import type { FieldSpec } from "../agent/types.js";

/**
 * Terminal-driven learning: show the field here and read the user's typed answer
 * (they can't see the browser). Returns the value to fill, or null to skip.
 */
export async function askUserForField(
  field: FieldSpec,
  meta: { company: string; title: string; url: string },
): Promise<string | null> {
  ringBell();
  console.log("");
  console.log(`──────── needs your input ────────`);
  console.log(`${meta.company} — ${meta.title}`);
  console.log(`Field: ${field.label}${field.required ? " *" : ""}  [${field.type}${field.sensitive ? ", sensitive" : ""}]`);
  if (field.options?.length) console.log(`Options: ${field.options.join(" | ")}`);
  if (!process.stdin.isTTY) {
    console.log("(non-interactive — leaving blank)");
    return null;
  }
  console.log("Type the answer to fill, or press Enter to skip:");
  const rl = readline.createInterface({ input, output });
  const answer = (await rl.question("> ")).trim();
  rl.close();
  return answer || null;
}

export async function waitForUserLearning(event: LearningEvent): Promise<void> {
  ringBell();
  console.log("");
  console.log(`[learning] unknown field: "${event.question.label}" at ${event.pageUrl}`);
  if (event.question.options.length > 0) {
    console.log(`[learning] options: ${event.question.options.join(" | ")}`);
  }
  // Non-interactive mode (stdin not a TTY): skip the pause, just log and continue.
  if (!process.stdin.isTTY) {
    console.log("[learning] non-interactive — skipping");
    return;
  }
  console.log(`Company: ${event.company} | Title: ${event.title}`);
  console.log("Fill the field in the browser, then press Enter here to continue.");
  const rl = readline.createInterface({ input, output });
  await rl.question("> ");
  rl.close();
}

/**
 * Ask the user to confirm final submission (controlled exception to never-submit).
 * Returns true only if they explicitly type "submit" (or "yes"). Non-interactive
 * always returns false — we never auto-submit.
 */
export async function confirmSubmit(meta: { company: string; title: string }): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  ringBell();
  console.log("");
  console.log(`──────── ready to submit ────────`);
  console.log(`${meta.company} — ${meta.title}`);
  console.log("Review the screenshot (copy command printed above). Type 'submit' to SUBMIT this application, or press Enter to skip:");
  const rl = readline.createInterface({ input, output });
  const answer = (await rl.question("> ")).trim().toLowerCase();
  rl.close();
  return answer === "submit" || answer === "yes";
}

export async function waitForUserConfirmation(message: string): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log(`[confirm] non-interactive — auto-continuing: ${message}`);
    return;
  }
  ringBell();
  console.log("");
  console.log(message);
  console.log("Press Enter here after you're ready.");
  const rl = readline.createInterface({ input, output });
  await rl.question("> ");
  rl.close();
}

import path from "node:path";
/**
 * Attaching a document, driven by the REAL uploader against test/fake-ats/greenhouse-upload.html.
 *
 *   npm run test:upload
 *
 * Greenhouse takes the file and then REMOVES the input, so files.length reads 0 on a detached node
 * and every upload looked like a refusal — 130 of them in one batch, each one blocking a finished
 * application on the required-document gate over a resume that was already attached. The fixture
 * removes its input exactly as the live form does, and has a second one so the index shift that
 * cost a 30-second timeout is reproduced too.
 */
import { chromium } from "playwright";
import { GreenhouseDriver } from "../agent/drivers/greenhouse.js";
import { RESUME_PATH } from "../config.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};

const browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
const page = await browser.newPage();
await page.goto(`file://${path.resolve("test/fake-ats/greenhouse-upload.html")}`);
const started = Date.now();
const result = await new GreenhouseDriver().uploadDocuments(page as never, RESUME_PATH);
const seconds = (Date.now() - started) / 1000;
const uploaded = (await page.evaluate("(() => window.__uploaded)()")) as Array<{ id: string; name: string }>;

check("the resume reaches the resume input", uploaded.some((u) => u.id === "resume"), uploaded);
check("an input that vanished on success is NOT reported missing", result.missing.length === 0, result.missing);
check("and it is reported attached", result.attached.includes("resume"), result.attached);
// The index shift used to cost the full locator timeout on the next input.
check(`no 30-second wait on the moved input (${seconds.toFixed(1)}s)`, seconds < 15, seconds);
// Matched by what the form CALLS each upload, never by position.
// Appian's nesting: the question is five levels above the input and every wrapper between reads
// "Attach Attach". Skipping it left a REQUIRED transcript unattached with nothing in the log.
check("an upload whose question is five levels up is still recognised",
  uploaded.some((u) => u.id === "transcript"), uploaded);
check("the transcript input gets the transcript, not a second copy of the CV",
  uploaded.every((u) => (u.id === "resume") === u.name.toLowerCase().includes("resume")),
  uploaded);

await browser.close();
console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

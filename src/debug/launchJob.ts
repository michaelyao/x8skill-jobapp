/**
 * Opens the first filtered job in a headed browser and waits.
 * Use this to manually walk through an application flow.
 *
 * Usage:
 *   npx tsx src/debug/launchJob.ts
 *   JOB_INDEX=3 npx tsx src/debug/launchJob.ts
 */

import { chromium } from "playwright";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadEnv } from "../utils/env.js";
import { AUTH_DIR } from "../config.js";
import { loadSimplifyJobs } from "../sources/simplify.js";
import { filterJobs } from "../core/filterJobs.js";

loadEnv();

const jobIndex = parseInt(process.env.JOB_INDEX ?? "0", 10);

const context = await chromium.launchPersistentContext(AUTH_DIR, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1440, height: 1000 },
  args: ["--remote-debugging-port=9222"],
});

const page = context.pages()[0] ?? (await context.newPage());

console.log("Fetching Simplify jobs...");
const jobs = await loadSimplifyJobs(page);
const filtered = filterJobs(jobs);

console.log(`\n${filtered.length} filtered jobs. Opening index ${jobIndex}:\n`);

for (let i = 0; i < Math.min(10, filtered.length); i++) {
  const j = filtered[i];
  console.log(`  [${i}] ${j.company} — ${j.title} (${j.location}) ${j.applyUrl}`);
}

const job = filtered[jobIndex];
if (!job) {
  console.error(`No job at index ${jobIndex}`);
  await context.close();
  process.exit(1);
}

console.log(`\nOpening: ${job.company} — ${job.title}`);
console.log(`URL: ${job.applyUrl}\n`);

const jobPage = await context.newPage();
await jobPage.goto(job.applyUrl, { waitUntil: "domcontentloaded" });

const rl = readline.createInterface({ input, output });
await rl.question("Browser is open. Press Enter to close when you're done.\n> ");
rl.close();

await context.close();

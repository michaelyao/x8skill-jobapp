import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { AUTH_DIR } from "../config.js";
import { LlmAgent } from "../agent/llmAgent.js";
import { applyToJob, type ApplyDeps } from "./applyJob.js";
import { buildJobIdentity, decideDedupe } from "./jobIdentity.js";
import { loadAnswers } from "../knowledge/answerStore.js";
import { loadApplications, hasAppliedBefore } from "../knowledge/applications.js";
import { loadProfile } from "../knowledge/profile.js";
import { loadX8NoteConfig } from "../knowledge/x8note.js";
import { loadInternshipList, refreshInternshipCsv } from "../sources/internshipList.js";
import { loadTrackerSheetRows } from "../sources/trackerSheet.js";
import { ensureDir, makeRunDir, writeJson, writeSummaryMarkdown } from "../utils/log.js";
import { waitForUserConfirmation } from "../utils/prompts.js";
import type { RunSummaryItem } from "../types.js";

const agent = new LlmAgent();

export async function run(): Promise<void> {
  const maxJobs = parseOptionalPositiveInt(process.env.MAX_JOBS);
  const profile = await loadProfile();
  let answers = await loadAnswers();
  const runDir = makeRunDir();
  await ensureDir(runDir);

  // RESET_PROFILE=1 wipes the dedicated automation Chrome profile before launch —
  // a clean recovery from a corrupted profile (you'll re-login to Google once).
  if (process.env.RESET_PROFILE === "1") {
    await fs.rm(AUTH_DIR, { recursive: true, force: true });
    console.log("RESET_PROFILE=1 — cleared the automation Chrome profile; you'll re-login to Google once.");
  }

  const context = await chromium.launchPersistentContext(AUTH_DIR, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1440, height: 1000 },
    // Hide the "Chrome is being controlled by automated test software" infobar
    // and reduce the automation fingerprint (navigator.webdriver).
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());

    // Build the consolidated list from every source in job_sites.txt, then read
    // the curated CSV as our candidate set (already filtered + region-ordered).
    await refreshInternshipCsv();
    let filteredJobs = await loadInternshipList();
    console.log(`Loaded ${filteredJobs.length} candidate jobs from internships_summer2027.csv (sources: job_sites.txt).`);

    // JOB_ID=LSQJ (or a comma-separated list) targets specific jobs by CSV code.
    const onlyIds = (process.env.JOB_ID || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (onlyIds.length) {
      filteredJobs = filteredJobs.filter((job) => job.id && onlyIds.includes(job.id.toUpperCase()));
      console.log(`JOB_ID filter → ${filteredJobs.length} job(s): ${onlyIds.join(", ")}`);
    }

    // SUPPORTED_ONLY=1: only attempt jobs on ATS we can actually drive.
    if (process.env.SUPPORTED_ONLY === "1") {
      const supported = /myworkdayjobs\.com|\.wd[0-9]\.|ashbyhq\.com|greenhouse\.io|lever\.co/i;
      const before = filteredJobs.length;
      filteredJobs = filteredJobs.filter((job) => supported.test(job.applyUrl));
      console.log(`SUPPORTED_ONLY=1 → ${filteredJobs.length}/${before} jobs on supported ATS (Workday/Ashby/Greenhouse/Lever).`);
    }

    // LATEST_FIRST=1: process freshest postings first. "age" holds the CSV "Posted"
    // value: "0d".."30d" (day counts, freshest) sort before explicit dates / "1mo".
    if (process.env.LATEST_FIRST === "1") {
      const freshOrder = (age: string): number => {
        const a = (age || "").trim();
        const m = a.match(/^(\d+)d$/);
        if (m) return Number(m[1]);
        if (/^1mo$/i.test(a)) return 40;
        return a ? 60 : 99; // explicit dates = older; blank = last
      };
      filteredJobs = [...filteredJobs].sort((x, y) => freshOrder(x.age) - freshOrder(y.age));
      console.log(`LATEST_FIRST=1 → sorted ${filteredJobs.length} jobs freshest-first.`);
    }
    await writeJson(path.join(runDir, "filtered-jobs.json"), filteredJobs);

    // SKIP_SHEET=1 bypasses the interactive Google-sheet dedupe (handy for quick
    // single-job tests). The local ledger still prevents re-applying.
    let trackerRows: Awaited<ReturnType<typeof loadTrackerSheetRows>> = [];
    if (process.env.SKIP_SHEET === "1") {
      console.log("SKIP_SHEET=1 — skipping the Google tracker sheet dedupe.");
    } else {
      await page.goto(
        "https://docs.google.com/spreadsheets/d/1Ugo160-wF1YvOtnwNa__7A9Lep9mBR5plEdhJ0oZh-A/edit?gid=0#gid=0",
        { waitUntil: "domcontentloaded" },
      );
      await waitForUserConfirmation(
        "The tracker sheet is open. Sign into Google if prompted, wait for the sheet to load, then press Enter.",
      );
      trackerRows = await loadTrackerSheetRows(page);
      await writeJson(path.join(runDir, "tracker-rows.json"), trackerRows);
      console.log(`Loaded ${trackerRows.length} rows from the tracker sheet.`);
    }

    let applications = await loadApplications();
    console.log(`Loaded ${applications.length} prior application(s) from the local ledger.`);

    const x8note = await loadX8NoteConfig();
    console.log(
      x8note
        ? `x8note sync enabled → ${x8note.baseUrl} (notebook: ${x8note.notebook}).`
        : "x8note sync disabled (no .x8note.config or X8NOTE_DISABLE=1).",
    );

    const summary: RunSummaryItem[] = [];

    const jobsToProcess = typeof maxJobs === "number" ? filteredJobs.slice(0, maxJobs) : filteredJobs;
    if (typeof maxJobs === "number") {
      console.log(`Limiting this run to ${jobsToProcess.length} job(s) because MAX_JOBS=${maxJobs}.`);
    }

    const deps: ApplyDeps = { context, profile, agent, x8note, runDir };
    // Approval can take days, so the fill run never blocks on it: it emails the
    // review, waits only a short grace period for an immediate reply, then queues
    // the job for the Phase-B approval poller and moves on. Default grace: 2 min.
    const graceMs = Number(process.env.APPROVE_TIMEOUT_MS ?? 120000);
    const interactive = process.env.NO_LEARN !== "1" && process.stdin.isTTY === true;

    for (const job of jobsToProcess) {
      const identity = buildJobIdentity(job);
      const dedupe = decideDedupe(identity, trackerRows);
      const notes: string[] = [dedupe.reason];
      if (job.needsManualLocationReview) notes.push("manual location review suggested");

      const alreadyEngaged = hasAppliedBefore(applications, identity);
      if (alreadyEngaged) notes.push("already in local application ledger");

      if (dedupe.shouldSkip || alreadyEngaged) {
        summary.push({ company: job.company, title: job.title, applyUrl: job.applyUrl, outcome: "skipped_existing", notes });
        continue;
      }

      console.log(`Opening [${job.id ?? "----"}] ${job.company} - ${job.title} (${job.region ?? "?"})`);
      const outcome = await applyToJob(job, identity, answers, applications, deps, {
        mode: "fill",
        interactive,
        graceMs,
        baseNotes: notes,
      });
      answers = outcome.answers;
      applications = outcome.applications;
      summary.push(outcome.summaryItem);
    }

    await writeJson(path.join(runDir, "applications-ledger.json"), applications);
    await writeJson(path.join(runDir, "summary.json"), summary);
    await writeSummaryMarkdown(path.join(runDir, "summary.md"), summary);
    console.log(`Run complete. Logs written to ${runDir}`);
  } finally {
    await context.close();
  }
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

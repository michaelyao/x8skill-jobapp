import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { TRACKER_SHEET_EXPORT_URL, TRACKER_SHEET_URL } from "../config.js";
import { normalizeWhitespace } from "../utils/normalize.js";
import type { SheetRow } from "../types.js";

function pickHeader(headers: string[], patterns: RegExp[]): number {
  for (const pattern of patterns) {
    const index = headers.findIndex((header) => pattern.test(header));
    if (index >= 0) {
      return index;
    }
  }
  return -1;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((candidate) => candidate.some((value) => value.trim().length > 0));
}

async function tryExportSheetCsv(page: Page): Promise<string> {
  const exportPage = await page.context().newPage();
  const downloadPath = path.join(os.tmpdir(), `tracker-sheet-${Date.now()}.csv`);

  try {
    const downloadPromise = exportPage.waitForEvent("download", { timeout: 12000 }).catch(() => undefined);
    const response = await exportPage.goto(TRACKER_SHEET_EXPORT_URL, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
    const download = await downloadPromise;

    if (download) {
      await download.saveAs(downloadPath);
      const content = await fs.readFile(downloadPath, "utf8");
      await fs.unlink(downloadPath).catch(() => undefined);
      return content;
    }

    const bodyText = await exportPage.locator("body").innerText().catch(() => "");
    if (response?.ok() && bodyText.trim()) {
      return bodyText;
    }

    throw new Error(`Sheet export failed with response status ${response?.status() ?? "unknown"}.`);
  } finally {
    await exportPage.close().catch(() => undefined);
  }
}

export async function loadTrackerSheetRows(page: Page): Promise<SheetRow[]> {
  // The caller already navigated to the sheet and waited for user confirmation.
  // If we're not on the sheet (e.g. called standalone), navigate there now.
  if (!page.url().includes("docs.google.com/spreadsheets")) {
    await page.goto(TRACKER_SHEET_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("body", { timeout: 30000 });
    await page.waitForTimeout(5000);
  }

  const csv = await tryExportSheetCsv(page);
  const rows = parseCsv(csv);
  if (rows.length === 0) {
    return [];
  }

  const headers = rows[0].map((cell) => normalizeWhitespace(cell).toLowerCase());
  const companyIndex = pickHeader(headers, [/\bcompany\b/, /\bemployer\b/]);
  const titleIndex = pickHeader(headers, [/\btitle\b/, /\brole\b/, /\bposition\b/]);
  const linkIndex = pickHeader(headers, [/\bapply\b/, /\blink\b/, /\burl\b/]);
  const jobIdIndex = pickHeader(headers, [/\bjob id\b/, /\breq\b/, /\brequisition\b/, /\bposting id\b/]);
  const statusIndex = pickHeader(headers, [/\bstatus\b/, /\bapplied\b/, /\bstate\b/]);

  return rows.slice(1).map((row, index) => {
    const values = row.map((cell) => normalizeWhitespace(cell));
    const raw = Object.fromEntries(headers.map((header, index) => [header || `col_${index + 1}`, values[index] ?? ""]));
    return {
      rowNumber: index + 2,
      raw,
      company: companyIndex >= 0 ? values[companyIndex] : undefined,
      title: titleIndex >= 0 ? values[titleIndex] : undefined,
      applyLink: linkIndex >= 0 ? values[linkIndex] : undefined,
      jobId: jobIdIndex >= 0 ? values[jobIdIndex] : undefined,
      status: statusIndex >= 0 ? values[statusIndex] : undefined,
    };
  });
}

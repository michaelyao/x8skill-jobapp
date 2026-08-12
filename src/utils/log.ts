import fs from "node:fs/promises";
import path from "node:path";
import { LOGS_DIR } from "../config.js";
import type { RunSummaryItem } from "../types.js";

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export function makeRunDir(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(LOGS_DIR, stamp);
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function writeText(filePath: string, value: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, value, "utf8");
}

export async function writeSummaryMarkdown(filePath: string, items: RunSummaryItem[]): Promise<void> {
  const lines = ["# Run Summary", ""];
  for (const item of items) {
    lines.push(`## ${item.company} - ${item.title}`);
    lines.push(`- Apply URL: ${item.applyUrl}`);
    lines.push(`- Outcome: ${item.outcome}`);
    for (const note of item.notes) {
      lines.push(`- Note: ${note}`);
    }
    lines.push("");
  }
  await writeText(filePath, lines.join("\n"));
}

export function ringBell(): void {
  process.stdout.write("\u0007");
}


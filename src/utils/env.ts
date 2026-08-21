import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "../config.js";

/**
 * Reads .env from the project root and populates process.env.
 * Runs synchronously so values are available before any async code runs.
 * Skips keys that are already set in the environment.
 */
export function loadEnv(): void {
  // ROOT_DIR honours JOBAPP_ROOT, so the web website (cwd = web/) still finds the
  // repo-root .env where the credentials and API keys live.
  const envPath = path.join(ROOT_DIR, ".env");
  let content: string;
  try {
    content = fs.readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex < 0) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    const raw = trimmed.slice(eqIndex + 1).trim();
    const value = raw.replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

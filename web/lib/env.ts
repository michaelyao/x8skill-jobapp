import "server-only";
import { loadEnv } from "@core/utils/env.js";

/**
 * Load the repo-root .env once per server process.
 *
 * Deliberately not hoisted into instrumentation.ts, even though that now exists: Next bundles it
 * for the edge runtime as well, where node:fs does not exist, and getting node-only code in there
 * takes the IgnorePlugin dance in next.config.mjs. Every caller here is node-runtime only, so
 * reading the file is safe — and it must happen before any auth check, or a correct password
 * fails because the accounts were never loaded. (startScheduler() calls loadEnv() itself for the
 * same reason, on the node side of that split.)
 */
let loaded = false;

export function ensureEnv(): void {
  if (loaded) return;
  loadEnv();
  loaded = true;
}

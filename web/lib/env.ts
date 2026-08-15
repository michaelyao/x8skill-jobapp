import "server-only";
import { loadEnv } from "@core/utils/env.js";

/**
 * Load the repo-root .env once per server process.
 *
 * Not done in instrumentation.ts: Next bundles that for the edge runtime as well, where
 * node:fs does not exist. Every caller here is node-runtime only, so reading the file is safe
 * — and it must happen before any auth check, or a correct password fails because the
 * accounts were never loaded.
 */
let loaded = false;

export function ensureEnv(): void {
  if (loaded) return;
  loadEnv();
  loaded = true;
}

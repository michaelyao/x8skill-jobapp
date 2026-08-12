#!/usr/bin/env bash
set -e

# Kill any Chrome process using the Playwright auth profile
pkill -f "playwright/.auth" 2>/dev/null && echo "[run] killed existing Chrome profile process" || true

# Remove the singleton lock if it exists
LOCK="playwright/.auth/SingletonLock"
if [ -f "$LOCK" ]; then
  rm -f "$LOCK"
  echo "[run] removed $LOCK"
fi

# Run
MAX_JOBS="${MAX_JOBS:-1}" npx tsx src/index.ts

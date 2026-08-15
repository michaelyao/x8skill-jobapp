#!/usr/bin/env bash
# Stop the worker daemon.
#
#   ./worker-stop.sh          # graceful: let an in-flight submit finish
#   ./worker-stop.sh --force  # SIGKILL immediately (see the warning below)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$DIR/data/.worker.pid"
BROWSER_LOCK="$DIR/data/.browser.lock"
STATUS="$DIR/data/worker-status.json"
FORCE="${1:-}"

pids="$(pgrep -f "tsx src/worker.ts" || true)"
if [ -z "$pids" ]; then
  echo "Worker is not running."
  rm -f "$PIDFILE"
  exit 0
fi

# Killing mid-submit leaves the queue entry in "submitting", which is deliberately never
# auto-retried — it needs confirming on the ATS by hand. Worth knowing before you do it.
state="$(sed -n 's/.*"state": *"\([^"]*\)".*/\1/p' "$STATUS" 2>/dev/null | head -1 || true)"
activity="$(sed -n 's/.*"activity": *"\([^"]*\)".*/\1/p' "$STATUS" 2>/dev/null | head -1 || true)"
if [ "$state" = "busy" ]; then
  printf '\033[33m!\033[0m worker is mid-task: %s\n' "${activity:-unknown}"
  if [ "$FORCE" != "--force" ]; then
    echo "  Sending SIGTERM — it finishes the current command, then exits."
    echo "  (./worker-stop.sh --force kills it now; if that interrupts a submit, the job is"
    echo "   left 'submitting' and must be confirmed on the ATS before approving again.)"
  fi
fi

for pid in $pids; do
  if [ "$FORCE" = "--force" ]; then
    echo "Killing pid $pid"
    kill -KILL "$pid" 2>/dev/null || true
  else
    echo "Stopping pid $pid (graceful)"
    kill -TERM "$pid" 2>/dev/null || true
  fi
done

# The worker finishes its current command before exiting, so allow real time for it.
limit=60
[ "$FORCE" = "--force" ] && limit=6
for _ in $(seq 1 "$limit"); do
  sleep 1
  pgrep -f "tsx src/worker.ts" >/dev/null 2>&1 || break
done

if pgrep -f "tsx src/worker.ts" >/dev/null 2>&1; then
  printf '\033[33m!\033[0m still shutting down after %ss (probably finishing a submit).\n' "$limit"
  echo "  Re-run with --force only if you accept the mid-submit consequence above."
  exit 1
fi

rm -f "$PIDFILE"

# The worker releases the browser lock on a clean exit; a forced kill can leave it.
if [ -f "$BROWSER_LOCK" ]; then
  owner="$(cat "$BROWSER_LOCK" 2>/dev/null || echo '?')"
  if [ "$owner" = "?" ] || ! kill -0 "$owner" 2>/dev/null; then
    rm -f "$BROWSER_LOCK"
    echo "  cleared the orphaned browser lock"
  fi
fi

printf '\033[32m✓\033[0m worker stopped\n'

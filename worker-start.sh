#!/usr/bin/env bash
# Start the worker daemon — the process that owns Chrome and executes everything the console
# asks for (approve, skip, retry, sweep). Replaces the 15-minute approvals cron.
#
#   ./worker-start.sh
#   WORKER_TICK_MS=5000 ./worker-start.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PIDFILE="$DIR/data/.worker.pid"
LOG="$DIR/logs/worker.log"
BROWSER_LOCK="$DIR/data/.browser.lock"
STATUS="$DIR/data/worker-status.json"

die() { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
note() { printf '  %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }

running_pid() {
  # The pidfile is a hint; trust the process table. Only one worker may run, because two
  # would fight over the Chrome profile and the state files.
  local pid
  pid="$(pgrep -f "tsx src/worker.ts" | head -1 || true)"
  [ -n "$pid" ] && { echo "$pid"; return; }
  if [ -f "$PIDFILE" ]; then
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "$pid"; fi
  fi
}

existing="$(running_pid)"
if [ -n "$existing" ]; then
  echo "Worker already running (pid $existing):"
  ps -p "$existing" -o pid,etime,command | tail -n +2 | cut -c1-100
  echo
  echo "Stop it first:  ./worker-stop.sh"
  exit 1
fi

[ -f "$DIR/.env" ] || die ".env not found in $DIR"
[ -d "$DIR/node_modules" ] || die "node_modules missing — run: npm install"
mkdir -p "$DIR/logs" "$DIR/data"

# A lock left behind by a crashed run would make every browser action defer silently.
if [ -f "$BROWSER_LOCK" ]; then
  owner="$(cat "$BROWSER_LOCK" 2>/dev/null || echo '?')"
  if [ "$owner" != "?" ] && kill -0 "$owner" 2>/dev/null; then
    die "the Chrome profile is held by pid $owner (a fill run?). Wait for it, or stop it first."
  fi
  warn "removing a stale browser lock (owner pid $owner is gone)"
  rm -f "$BROWSER_LOCK"
fi

# A manual `npm start` fill run also drives Chrome. They cannot run at once.
if pgrep -f "tsx src/index.ts" >/dev/null 2>&1; then
  warn "a fill run (npm start) is active — the worker will defer browser actions until it finishes"
fi

echo "Starting the worker …"
JOBAPP_ROOT="$DIR" nohup npm run worker >>"$LOG" 2>&1 &
launcher=$!

for _ in $(seq 1 40); do
  sleep 0.5
  pid="$(running_pid)"
  [ -n "$pid" ] && break
done

if [ -z "${pid:-}" ]; then
  kill "$launcher" 2>/dev/null || true
  die "worker did not start within 20s — last lines of $LOG:
$(tail -15 "$LOG" 2>/dev/null)"
fi

echo "$pid" >"$PIDFILE"

# Confirm it is actually ticking, not just alive.
state=""
for _ in $(seq 1 20); do
  sleep 0.5
  if [ -f "$STATUS" ]; then
    state="$(sed -n 's/.*"state": *"\([^"]*\)".*/\1/p' "$STATUS" | head -1)"
    [ -n "$state" ] && [ "$state" != "stopped" ] && break
  fi
done

printf '\033[32m✓\033[0m worker running (pid %s)\n' "$pid"
note "state    ${state:-starting}"
note "log      $LOG"
note "commands $DIR/data/commands/"
[ -z "$state" ] && warn "no heartbeat yet — check the log if the console still reports it stale"

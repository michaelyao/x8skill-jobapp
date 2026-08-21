#!/usr/bin/env bash
# Stop the jobapp website (native).
#
#   ./web-stop.sh
#   WEB_PORT=3010 ./web-stop.sh
#
# Kills whatever actually holds the port, not just the process we launched. `next start`
# re-execs as `next-server`, so matching on the original command line misses it — that is why
# `pkill -f "next start"` leaves the port occupied.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${WEB_PORT:-8088}"
PIDFILE="$DIR/data/.web.pid"

listeners() { lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true; }

pids="$(listeners)"
if [ -z "$pids" ]; then
  echo "Nothing listening on port $PORT."
  rm -f "$PIDFILE"
  exit 0
fi

for pid in $pids; do
  echo "Stopping pid $pid: $(ps -p "$pid" -o command= 2>/dev/null | cut -c1-70)"
  # Kill the whole process group, so the npm/npx wrapper goes too and cannot respawn.
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  if [ -n "$pgid" ]; then
    kill -TERM -- "-$pgid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  else
    kill -TERM "$pid" 2>/dev/null || true
  fi
done

# Give it a moment to shut down cleanly before forcing.
for _ in $(seq 1 20); do
  sleep 0.25
  [ -z "$(listeners)" ] && break
done

remaining="$(listeners)"
if [ -n "$remaining" ]; then
  echo "Still up after SIGTERM — sending SIGKILL to: $remaining"
  for pid in $remaining; do kill -KILL "$pid" 2>/dev/null || true; done
  sleep 1
fi

rm -f "$PIDFILE"

if [ -z "$(listeners)" ]; then
  printf '\033[32m✓\033[0m port %s is free\n' "$PORT"
else
  printf '\033[31m✗\033[0m port %s still held by: %s\n' "$PORT" "$(listeners)" >&2
  exit 1
fi

#!/usr/bin/env bash
# Restart the worker, and actually leave ONE of it running.
#
#   ./worker-restart.sh
#
# `launchctl kickstart -k` is not enough on its own. The LaunchAgent runs node_modules/.bin/tsx,
# which spawns the real worker as a CHILD process with a different command line; launchd kills the
# parent it tracks and the child survives, holding the Chrome profile and running the OLD code.
# That has now happened three times, twice inside a cleanup written to prevent it — including one
# where `pgrep -f "tsx src/worker.ts"` reported a single healthy worker while a second was live.
# Match on "src/worker.ts" and you see both.
#
# A survivor is not harmless: two workers fight over data/.browser.lock and the state files, and the
# log fills with "browser is busy elsewhere", "the browser context is dead" and resumes that will
# not attach — none of which name the actual cause.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
PROFILE="$DIR/playwright/.auth"

note() { printf '  %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }

state="$(sed -n 's/.*"state": *"\([^"]*\)".*/\1/p' data/worker-status.json 2>/dev/null | head -1 || true)"
activity="$(sed -n 's/.*"activity": *"\([^"]*\)".*/\1/p' data/worker-status.json 2>/dev/null | head -1 || true)"
if [ "$state" = "busy" ]; then
  warn "mid-task: ${activity:-unknown}"
  # A killed FILL costs nothing but its own work — the claim is released on startup and the command
  # runs again. A killed SUBMIT is different: the entry stays "submitting" and must be confirmed on
  # the ATS by hand, so refuse rather than decide that for you.
  case "$activity" in
    *submitting*|*Submitting*)
      warn "that is a SUBMIT. Refusing — confirm on the ATS first, or use ./worker-stop.sh."
      exit 1
      ;;
  esac
  note "it is a fill; the command is re-queued and runs again after the restart."
fi

before="$(pgrep -f "src/worker.ts" || true)"
[ -n "$before" ] && note "running: $(echo "$before" | tr '\n' ' ')"

launchctl kickstart -k "gui/$(id -u)/com.studiox8.jobapp.worker" 2>/dev/null || ./worker-start.sh
sleep 5

for pid in $before; do
  if kill -0 "$pid" 2>/dev/null; then
    note "killing survivor $pid"
    kill -9 "$pid" 2>/dev/null || true
  fi
done
sleep 3

# Chrome whose parent is gone keeps the user-data-dir, and Chrome is single-instance per profile —
# every launch then fails with "Target page, context or browser has been closed".
for c in $(pgrep -f "user-data-dir=$PROFILE" 2>/dev/null || true); do
  ppid="$(ps -o ppid= -p "$c" 2>/dev/null | tr -d ' ')"
  if [ -n "$ppid" ] && ! kill -0 "$ppid" 2>/dev/null; then
    note "killing orphaned Chrome $c"
    kill -9 "$c" 2>/dev/null || true
  fi
done
rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonSocket" "$PROFILE/SingletonCookie"

after="$(pgrep -f "src/worker.ts" || true)"
count="$(echo "$after" | grep -c . || true)"
note "now running: $(echo "$after" | tr '\n' ' ')"
# The wrapper plus its node child is two pids and is normal; three or more means a survivor.
if [ "$count" -gt 2 ]; then
  warn "more than one worker is alive — kill the oldest by hand before letting it run."
  exit 1
fi
printf '\033[32m✓\033[0m worker restarted\n'

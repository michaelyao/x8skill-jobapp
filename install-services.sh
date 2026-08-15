#!/usr/bin/env bash
# Install the console + worker as launchd services, so they start at login and restart on
# crash. Also retires the */15 approvals cron entry, which the worker replaces.
#
#   ./install-services.sh            # install and start both
#   ./install-services.sh --uninstall
#
# launchd, not cron, for two reasons: these are long-running daemons rather than periodic
# jobs, and launchd runs them in your GUI login session — which the worker needs, because it
# drives a headed Chrome.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
WEB_LABEL="com.studiox8.jobapp.web"
WORKER_LABEL="com.studiox8.jobapp.worker"
WEB_PLIST="$AGENTS/$WEB_LABEL.plist"
WORKER_PLIST="$AGENTS/$WORKER_LABEL.plist"

# launchd starts with a minimal PATH; node/npm live in Homebrew.
NODE_BIN="$(dirname "$(command -v node)")"
PATH_VALUE="$NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin"

ok() { printf '\033[32m✓\033[0m %s\n' "$1"; }
note() { printf '  %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }

unload() {
  local label="$1" plist="$2"
  if launchctl list | grep -q "$label"; then
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || launchctl unload "$plist" 2>/dev/null || true
  fi
}

if [ "${1:-}" = "--uninstall" ]; then
  unload "$WEB_LABEL" "$WEB_PLIST"
  unload "$WORKER_LABEL" "$WORKER_PLIST"
  rm -f "$WEB_PLIST" "$WORKER_PLIST"
  ok "services removed (the cron entry, if any, is left alone)"
  exit 0
fi

[ -f "$DIR/.env" ] || { echo "✗ .env not found in $DIR" >&2; exit 1; }
mkdir -p "$AGENTS" "$DIR/logs"

write_plist() {
  local path="$1" label="$2" program="$3" workdir="$4" logname="$5"
  cat >"$path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>exec $program</string>
  </array>
  <key>WorkingDirectory</key><string>$workdir</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATH_VALUE</string>
    <key>JOBAPP_ROOT</key><string>$DIR</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <!-- Do not hammer a service that fails on start (bad config, port taken). -->
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DIR/logs/$logname.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/$logname.log</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
PLIST
}

echo "Installing launch agents…"

# The console: run the built server directly rather than via the start script, so launchd
# supervises the real process and KeepAlive can do its job.
write_plist "$WEB_PLIST" "$WEB_LABEL" \
  "npx next start -H \${WEB_HOST:-0.0.0.0} -p \${WEB_PORT:-8088}" \
  "$DIR/web" "web"

write_plist "$WORKER_PLIST" "$WORKER_LABEL" \
  "npx tsx src/worker.ts" \
  "$DIR" "worker"

# Free the port and the browser lock before launchd takes over, or the agents crash-loop
# against processes started by hand.
[ -x "$DIR/web-stop.sh" ] && "$DIR/web-stop.sh" >/dev/null 2>&1 || true
[ -x "$DIR/worker-stop.sh" ] && "$DIR/worker-stop.sh" >/dev/null 2>&1 || true

for pair in "$WEB_LABEL|$WEB_PLIST" "$WORKER_LABEL|$WORKER_PLIST"; do
  label="${pair%%|*}"; plist="${pair#*|}"
  unload "$label" "$plist"
  launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load "$plist"
  ok "$label"
done

# The worker replaces the 15-minute approvals poller. Leaving both installed means two
# processes racing for the same Chrome profile with two different lock files.
if crontab -l 2>/dev/null | grep -q "approvals-cron.sh"; then
  crontab -l 2>/dev/null | grep -v "approvals-cron.sh" | crontab -
  ok "removed the */15 approvals cron entry (the worker does this now, within seconds)"
fi

sleep 6
echo
health="$(curl -fsS --max-time 5 "http://127.0.0.1:${WEB_PORT:-8088}/api/health" 2>/dev/null || echo '')"
if [ -n "$health" ]; then
  ok "console responding: $health"
else
  warn "console not responding yet — check $DIR/logs/web.log"
fi

note "status:    launchctl list | grep jobapp"
note "restart:   launchctl kickstart -k gui/$(id -u)/$WEB_LABEL"
note "logs:      $DIR/logs/web.log  ·  $DIR/logs/worker.log"
note "uninstall: ./install-services.sh --uninstall"

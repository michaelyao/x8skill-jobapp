#!/usr/bin/env bash
# Install the WORKER as a LaunchAgent, so it comes back on its own after a reboot.
#
#   ./install-worker.sh              # install (or reinstall) the worker agent
#   ./install-worker.sh --autologin  # only (re)set auto-login
#   ./install-worker.sh --uninstall
#   ./install-worker.sh --dry-run    # generate + validate the plist, change nothing
#
# Run it as YOURSELF, not with sudo — it needs $HOME and your uid to place the LaunchAgent.
# The normal path needs no sudo at all; only --autologin does.
#
# ---------------------------------------------------------------------------------------
# THE WEBSITE IS NOT HERE. It runs in Docker: ./jobapp_website.sh up (port 8088), with the
# 8-hour tick inside that same process. This script does not install, start or check it.
#
# There used to be a --with-website-daemon flag that installed the same Next app as a
# LaunchDaemon on 8089, whose only advantage was starting at BOOT rather than at login.
# Removed 2026-08-24: recovery-waits-for-a-login is the chosen design (see CLAUDE.md), so the
# flag was a second copy of the website maintained for a possibility we had already declined.
# Do not add it back. If a machine ever does need the site up before anyone signs in, that is a
# decision to revisit deliberately, not a flag to leave lying around.
#
# ---------------------------------------------------------------------------------------
# Why the worker MUST be a LaunchAgent and not a daemon
#
# It drives a REAL HEADED CHROME with the persistent profile in playwright/.auth. That needs an
# Aqua session, which a LaunchDaemon does not have. A LaunchAgent in ~/Library/LaunchAgents is
# loaded at GUI LOGIN, not at boot — so after a reboot with nobody signed in the worker is
# simply absent, and from an SSH session it cannot even be loaded by hand (`launchctl
# managername` is "Background"; `launchctl bootstrap gui/$(id -u) …` fails with "125: Domain
# does not support specified action"). That is expected, not a fault. Auto-login is the only
# thing that would change it, and it is off by choice.
# ---------------------------------------------------------------------------------------
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS="$HOME/Library/LaunchAgents"

WORKER_LABEL="com.studiox8.jobapp.worker"
WORKER_PLIST="$AGENTS/$WORKER_LABEL.plist"
# The retired website service, in both places it was ever installed. Kept only so this script
# can clean one up on a machine that still has it — nothing here ever creates them.
LEGACY_WEB_LABEL="com.studiox8.jobapp.web"
LEGACY_WEB_DAEMON="/Library/LaunchDaemons/$LEGACY_WEB_LABEL.plist"
LEGACY_WEB_AGENT="$AGENTS/$LEGACY_WEB_LABEL.plist"

UID_NUM="$(id -u)"
USER_NAME="$(id -un)"
NODE_BIN="$(dirname "$(command -v node)")"
PATH_VALUE="$NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin"

ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
note() { printf '  %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

DO_INSTALL=1
# Decided 2026-08-21: auto-login is NOT wanted — someone always signs in after a reboot. So this
# does not prompt for it. `--autologin` still sets it if that ever changes.
DO_AUTOLOGIN=no
case "${1:-}" in
  --uninstall)    DO_INSTALL=0 ;;
  --no-autologin) DO_AUTOLOGIN=no ;;
  --autologin)    DO_INSTALL=0; DO_AUTOLOGIN=force ;;
  --dry-run)      DO_INSTALL=0; DO_AUTOLOGIN=dryrun ;;
  "")             ;;
  *)              die "unknown flag ${1}. See the header of this script." ;;
esac

[ "$(id -u)" -ne 0 ] || die "run this as yourself, not with sudo — it needs your \$HOME and uid"

# ---------------------------------------------------------------------- plist generator
# Defined once and used by both the installer and --dry-run, so what you inspect is exactly
# what gets installed.
write_worker_plist() {
  cat >"$1" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$WORKER_LABEL</string>
  <!-- tsx directly, with NO bash wrapper. Commit 3e40adb: \`bash -lc "exec npx tsx …"\` meant
       launchd's SIGTERM reached bash while the grandchild node survived as an orphan, and an
       orphaned worker held data/.browser.lock so every command deferred with "browser is busy
       elsewhere". Two workers were alive at once. Do not reintroduce a shell here. -->
  <key>ProgramArguments</key>
  <array>
    <string>$DIR/node_modules/.bin/tsx</string>
    <string>src/worker.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
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
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DIR/logs/worker.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/worker.log</string>
  <!-- Interactive: it drives a headed Chrome in the login session. -->
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
PLIST
  plutil -lint "$1" >/dev/null || die "generated worker plist is malformed"
}

# ------------------------------------------------------------------- legacy web service
# The website daemon/agent this script used to be able to install. Only ever REMOVES; if one is
# still loaded on this machine it would keep binding a port at every boot with nothing
# maintaining it. Silent when there is nothing to do, which is the normal case.
remove_legacy_website_service() {
  if [ -f "$LEGACY_WEB_AGENT" ]; then
    launchctl bootout "gui/$UID_NUM/$LEGACY_WEB_LABEL" 2>/dev/null || true
    rm -f "$LEGACY_WEB_AGENT"
    ok "removed a retired website LaunchAgent (the container is the website now)"
  fi
  if [ -f "$LEGACY_WEB_DAEMON" ]; then
    warn "found a retired website LaunchDaemon at $LEGACY_WEB_DAEMON — removing (needs sudo)"
    sudo launchctl bootout "system/$LEGACY_WEB_LABEL" 2>/dev/null || true
    sudo rm -f "$LEGACY_WEB_DAEMON"
    ok "removed the retired website LaunchDaemon"
  fi
}

# ----------------------------------------------------------------------------- autologin
set_autologin() {
  section "Automatic login"
  if ! fdesetup status | grep -q "FileVault is Off"; then
    warn "FileVault is ON. macOS ignores auto-login on a FileVault volume — the disk unlock"
    warn "at boot needs a person, so the worker cannot be made reboot-proof this way."
    return 0
  fi

  local current
  current="$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || true)"
  if [ "$current" = "$USER_NAME" ] && [ "$DO_AUTOLOGIN" != "force" ]; then
    ok "already enabled for $USER_NAME"
    return 0
  fi

  echo "Auto-login gives the worker the GUI session it needs at boot. It also means anyone"
  echo "who can reach this machine physically gets a logged-in desktop — that is the trade."
  echo
  echo "macOS will prompt for ${USER_NAME}'s LOGIN PASSWORD. It is not passed on the command"
  echo "line and does not enter your shell history; sysadminctl reads it directly."
  echo

  # -password is omitted on purpose: that makes sysadminctl prompt interactively.
  if sudo sysadminctl -autologin set -userName "$USER_NAME"; then
    local now
    now="$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || true)"
    if [ "$now" = "$USER_NAME" ]; then
      ok "automatic login enabled for $USER_NAME"
      [ -f /etc/kcpassword ] && note "/etc/kcpassword written (obfuscated, root-only — 0600)"
    else
      warn "sysadminctl returned success but autoLoginUser is '${now:-unset}' — check System Settings › Users & Groups"
    fi
  else
    warn "could not set auto-login. Do it by hand: System Settings › Users & Groups › Automatic login"
  fi
}

# ----------------------------------------------------------------------------- uninstall
if [ "$DO_INSTALL" -eq 0 ] && [ "$DO_AUTOLOGIN" = "no" ]; then
  section "Removing the worker agent"
  launchctl bootout "gui/$UID_NUM/$WORKER_LABEL" 2>/dev/null || launchctl unload "$WORKER_PLIST" 2>/dev/null || true
  rm -f "$WORKER_PLIST"
  ok "worker agent removed"
  remove_legacy_website_service
  note "the website is untouched — stop it with: ./jobapp_website.sh down"
  note "auto-login is left alone — turn it off with: sudo sysadminctl -autologin off"
  exit 0
fi

if [ "$DO_AUTOLOGIN" = "force" ]; then
  set_autologin
  exit 0
fi

# ------------------------------------------------------------------------------- dry run
if [ "$DO_AUTOLOGIN" = "dryrun" ]; then
  out="${TMPDIR:-/tmp}/jobapp-plist.$$"
  mkdir -p "$out"
  write_worker_plist "$out/$WORKER_LABEL.plist"
  section "Worker agent → $WORKER_PLIST"
  cat "$out/$WORKER_LABEL.plist"
  section "Validation"
  ok "plist is well-formed (plutil -lint)"
  note "exec  $(plutil -extract ProgramArguments.0 raw -o - "$out/$WORKER_LABEL.plist") $(plutil -extract ProgramArguments.1 raw -o - "$out/$WORKER_LABEL.plist")"
  for f in "$DIR/node_modules/.bin/tsx" "$DIR/.env" "$DIR/playwright"; do
    [ -e "$f" ] && ok "exists: $f" || warn "MISSING: $f"
  done
  note "nothing was installed; remove the copy with: rm -rf $out"
  exit 0
fi

# ----------------------------------------------------------------------------- preflight
section "Preflight"
[ -f "$DIR/.env" ] || die ".env not found in $DIR"
[ -d "$DIR/node_modules" ] || die "node_modules missing — run: npm install"
mkdir -p "$AGENTS" "$DIR/logs" "$DIR/data"
ok "config and deps present"
note "node   $NODE_BIN/node"
note "user   $USER_NAME (uid $UID_NUM)"
remove_legacy_website_service

# ------------------------------------------------------------------- worker: LaunchAgent
section "Worker → LaunchAgent"
write_worker_plist "$WORKER_PLIST"
ok "wrote $WORKER_PLIST"

# Release the browser profile before launchd takes over, or the agent fights a hand-started
# worker — Chrome is single-instance per user-data-dir.
[ -x "$DIR/worker-stop.sh" ] && "$DIR/worker-stop.sh" >/dev/null 2>&1 || true

launchctl bootout "gui/$UID_NUM/$WORKER_LABEL" 2>/dev/null || true
if launchctl bootstrap "gui/$UID_NUM" "$WORKER_PLIST" 2>/dev/null; then
  ok "loaded into your GUI session"
else
  # Expected over SSH with nobody signed in: there is no Aqua domain to load it into.
  warn "cannot load it from here — this session has no GUI domain (launchctl managername = $(launchctl managername))."
  note "It is installed and will start at the next login."
  # We stopped the worker a moment ago to hand it to launchd, and launchd cannot take it in
  # this session. Leaving it down would mean this script made things WORSE than it found
  # them — approvals would queue with nothing to execute them. So start it by hand instead.
  if [ -x "$DIR/worker-start.sh" ]; then
    note "starting it by hand for now, so approvals keep working until the next login…"
    if "$DIR/worker-start.sh" >/dev/null 2>&1; then
      ok "worker running by hand (pid $(pgrep -f 'tsx src/worker.ts' | head -1)) — launchd takes over at the next login"
    else
      warn "could not start it by hand either — run ./worker-start.sh and check logs/worker.log"
    fi
  fi
fi

# The worker replaced the 15-minute poller; both installed means two processes racing for one Chrome.
if crontab -l 2>/dev/null | grep -q "approvals-cron.sh"; then
  crontab -l 2>/dev/null | grep -v "approvals-cron.sh" | crontab -
  ok "removed the */15 approvals cron entry (the worker does this within seconds)"
fi

# ----------------------------------------------------------------------------- autologin
[ "$DO_AUTOLOGIN" = "no" ] || set_autologin

# ------------------------------------------------------------------------------- verify
section "Verify"
autolog="$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || echo "off")"
note "auto-login  $autolog"
note "worker      $(pgrep -f 'tsx src/worker.ts' >/dev/null && echo running || echo 'not running (starts at next login)')"
health="$(curl -fsS --max-time 3 "http://127.0.0.1:8088/api/health" 2>/dev/null || true)"
if [ -n "$health" ]; then note "website     up on 8088: $health"
else note "website     not responding on 8088 — start it with: ./jobapp_website.sh up"; fi

section "What survives a reboot now"
if [ "$autolog" = "$USER_NAME" ]; then
  echo "  Everything, at boot: auto-login starts Docker Desktop (which restarts the website"
  echo "  container and its 8-hour tick) and loads the worker agent."
else
  # Auto-login is off by choice. Everything still recovers on its own — it just waits for the
  # login rather than happening at boot. Nothing to run by hand afterwards.
  echo "  Auto-login is off by choice, so recovery waits for someone to sign in. After that,"
  echo "  everything comes back with NO commands needed:"
  echo "    Docker Desktop  starts at login (login item)"
  echo "    website         restart: unless-stopped, so it follows Docker up (8-hour tick included)"
  echo "    worker          LaunchAgent, RunAtLoad"
fi
echo
note "check:     ./jobapp_website.sh status  ·  launchctl list | grep jobapp"
note "logs:      $DIR/logs/worker.log"
note "uninstall: ./install-worker.sh --uninstall"

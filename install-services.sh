#!/usr/bin/env bash
# Make the console and the worker survive a reboot with nobody signed in.
#
#   ./install-services.sh                 # worker + auto-login (console stays in Docker)
#   ./install-services.sh --with-console-daemon
#   ./install-services.sh --no-autologin  # install both, leave auto-login alone
#   ./install-services.sh --autologin     # only (re)set auto-login
#   ./install-services.sh --uninstall
#   ./install-services.sh --dry-run       # generate + validate both plists, change nothing
#
# The console daemon listens on 8088. The Docker console listens on 8090, so the two do not
# clash and can run side by side on the same data/. To put the daemon somewhere else, the value
# is baked into the plist at install time:
#
#   WEB_PORT=8089 ./install-services.sh
#
# Run it as YOURSELF, not with sudo — it needs $HOME and your uid to place the LaunchAgent,
# and calls sudo itself for the parts that need root. You will be asked for your password
# once for sudo, and again by macOS if you enable auto-login.
#
# ---------------------------------------------------------------------------------------
# THE CONSOLE RUNS IN DOCKER (port 8090). This script does NOT install a console by default.
#
# Chosen 2026-08-21: one console, in a container (`./jobapp_website.sh up`), and the worker as
# a LaunchAgent. Running a second native console alongside it was pure duplication — the same
# app, the same data, two ports to keep straight.
#
# So by default this installs the WORKER only, plus auto-login. Pass --with-console-daemon if
# you ever want the native console back as a boot-time daemon (it starts without a login,
# which the container cannot — Docker Desktop is a GUI login item). It takes 8088, not 8090,
# so it would not clash with the container.
#
# ---------------------------------------------------------------------------------------
# Why the two services would be installed DIFFERENTLY
#
# A LaunchAgent in ~/Library/LaunchAgents is loaded at GUI LOGIN, not at boot. This machine
# is administered over SSH, and after a reboot on 2026-08-19 nobody signed in at the console:
# both agents were simply absent, with nothing in the logs to explain it. From an SSH session
# they cannot even be loaded by hand — `launchctl managername` is "Background", and
# `launchctl bootstrap gui/$(id -u) …` fails with "125: Domain does not support specified
# action".
#
#   Console -> LaunchDaemon (/Library/LaunchDaemons). Starts at BOOT, no login needed. It is
#              a plain HTTP server that never drives a browser, so it has no business needing
#              a GUI session. This is what makes the site reboot-proof on its own.
#
#   Worker  -> LaunchAgent. It drives a REAL HEADED CHROME with the persistent profile, which
#              needs an Aqua session, so it genuinely cannot be a daemon. Auto-login is what
#              gives it one at boot.
#
# The daemon runs as your user, not root: it writes data/, and root-owned files there would
# then be unwritable by the worker, which runs as you.
# ---------------------------------------------------------------------------------------
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
DAEMONS="/Library/LaunchDaemons"

WEB_LABEL="com.studiox8.jobapp.web"
WORKER_LABEL="com.studiox8.jobapp.worker"
WEB_DAEMON_PLIST="$DAEMONS/$WEB_LABEL.plist"
WEB_AGENT_PLIST="$AGENTS/$WEB_LABEL.plist"   # the OLD location — removed, see above
WORKER_PLIST="$AGENTS/$WORKER_LABEL.plist"

UID_NUM="$(id -u)"
USER_NAME="$(id -un)"
GROUP_NAME="$(id -gn)"
NODE_BIN="$(dirname "$(command -v node)")"
PATH_VALUE="$NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin"
PORT="${WEB_PORT:-8088}"

ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
note() { printf '  %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

DO_INSTALL=1
DO_AUTOLOGIN=ask
# The console lives in Docker; a native console daemon is opt-in.
WITH_CONSOLE=0
case "${1:-}" in
  --with-console-daemon) WITH_CONSOLE=1 ;;
  --uninstall)    DO_INSTALL=0 ;;
  --no-autologin) DO_AUTOLOGIN=no ;;
  --autologin)    DO_INSTALL=0; DO_AUTOLOGIN=force ;;
  --dry-run)      DO_INSTALL=0; DO_AUTOLOGIN=dryrun ;;
  "")             ;;
  *)              die "unknown flag ${1}. See the header of this script." ;;
esac

[ "$(id -u)" -ne 0 ] || die "run this as yourself, not with sudo — it needs your \$HOME and uid"

# --------------------------------------------------------------------- plist generators
# Defined once and used by both the installer and --dry-run, so what you inspect is exactly
# what gets installed.

write_web_plist() {
  cat >"$1" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$WEB_LABEL</string>

  <!-- Runs as the user, NOT root: this process writes data/, and root-owned files there
       would be unwritable by the worker, which runs as the user. -->
  <key>UserName</key><string>$USER_NAME</string>
  <key>GroupName</key><string>$GROUP_NAME</string>

  <!-- No shell, for the same reason as the worker (see 3e40adb): a wrapper process is one
       more thing between launchd's signals and the server. The port is known now, so there is
       nothing left for a shell to expand.
       The local binary, NOT npx: npx wants a writable npm cache under $HOME, and boot is the
       worst time to discover it has none. -->
  <key>ProgramArguments</key>
  <array>
    <string>$DIR/web/node_modules/.bin/next</string>
    <string>start</string>
    <string>-H</string><string>${WEB_HOST:-0.0.0.0}</string>
    <string>-p</string><string>$PORT</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR/web</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATH_VALUE</string>
    <!-- Without this the console resolves data/ relative to web/ and shows an empty queue. -->
    <key>JOBAPP_ROOT</key><string>$DIR</string>
    <key>NODE_ENV</key><string>production</string>
    <!-- launchd does not reliably set HOME for a daemon running as UserName, and node
         tooling reaches for it. Set it rather than find out at boot. -->
    <key>HOME</key><string>$HOME</string>
  </dict>

  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <!-- Do not hammer a service that fails on start (bad config, port taken). -->
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DIR/logs/web.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/web.log</string>
</dict>
</plist>
PLIST
  plutil -lint "$1" >/dev/null || die "generated console plist is malformed"
}

write_worker_plist() {
  cat >"$1" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$WORKER_LABEL</string>
  <!-- tsx directly, with NO bash wrapper. Commit 3e40adb: `bash -lc "exec npx tsx …"` meant
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

# ----------------------------------------------------------------------------- autologin
set_autologin() {
  head "Automatic login"
  if ! fdesetup status | grep -q "FileVault is Off"; then
    warn "FileVault is ON. macOS ignores auto-login on a FileVault volume — the disk unlock"
    warn "at boot needs a person. Reboot safety for the WORKER is not achievable this way;"
    warn "the console daemon is unaffected and still starts at boot."
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
  if [ "$DO_AUTOLOGIN" = "ask" ]; then
    read -r -p "Enable automatic login for $USER_NAME? [y/N] " reply
    case "$reply" in [yY]*) ;; *) note "skipped — the worker will not come back until someone logs in"; return 0 ;; esac
  fi

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
if [ "$DO_INSTALL" -eq 0 ] && [ "$DO_AUTOLOGIN" != "force" ] && [ "$DO_AUTOLOGIN" != "dryrun" ]; then
  head "Removing services"
  # Unconditionally: `launchctl print` can fail unprivileged, and skipping the bootout on
  # that basis would delete the plist out from under a still-running daemon.
  sudo launchctl bootout "system/$WEB_LABEL" 2>/dev/null || true
  sudo rm -f "$WEB_DAEMON_PLIST"
  ok "console daemon removed"

  launchctl bootout "gui/$UID_NUM/$WORKER_LABEL" 2>/dev/null || launchctl unload "$WORKER_PLIST" 2>/dev/null || true
  rm -f "$WORKER_PLIST"
  ok "worker agent removed"

  note "auto-login is left alone — turn it off with: sudo sysadminctl -autologin off"
  exit 0
fi

if [ "$DO_AUTOLOGIN" = "force" ]; then
  set_autologin
  exit 0
fi

# ------------------------------------------------------------------------------- dry run
if [ "$DO_AUTOLOGIN" = "dryrun" ]; then
  out="${TMPDIR:-/tmp}/jobapp-plists.$$"
  mkdir -p "$out"
  write_web_plist "$out/$WEB_LABEL.plist"
  write_worker_plist "$out/$WORKER_LABEL.plist"
  section "Console daemon → $WEB_DAEMON_PLIST"
  cat "$out/$WEB_LABEL.plist"
  section "Worker agent → $WORKER_PLIST"
  cat "$out/$WORKER_LABEL.plist"
  section "Validation"
  ok "both plists are well-formed (plutil -lint)"
  note "exec (console)  $(plutil -extract ProgramArguments.0 raw -o - "$out/$WEB_LABEL.plist") $(plutil -extract ProgramArguments.1 raw -o - "$out/$WEB_LABEL.plist") … -p $PORT"
  note "exec (worker)   $(plutil -extract ProgramArguments.0 raw -o - "$out/$WORKER_LABEL.plist") $(plutil -extract ProgramArguments.1 raw -o - "$out/$WORKER_LABEL.plist")"
  for f in "$(plutil -extract EnvironmentVariables.JOBAPP_ROOT raw -o - "$out/$WEB_LABEL.plist")" \
           "$DIR/web/node_modules/.bin/next" "$DIR/node_modules/.bin/tsx" "$DIR/web/.next" "$DIR/.env"; do
    [ -e "$f" ] && ok "exists: $f" || warn "MISSING: $f"
  done
  note "nothing was installed; remove the copies with: rm -rf $out"
  exit 0
fi

# ----------------------------------------------------------------------------- preflight
section "Preflight"
[ -f "$DIR/.env" ] || die ".env not found in $DIR"
[ -d "$DIR/node_modules" ] || die "node_modules missing — run: npm install"
[ -d "$DIR/web/node_modules" ] || die "web/node_modules missing — run: cd web && npm install"
[ -d "$DIR/web/.next" ] || die "no production build — run: cd web && JOBAPP_ROOT=$DIR npx next build"
grep -qE '^WEB_SESSION_SECRET=.{32,}' "$DIR/.env" \
  || die "WEB_SESSION_SECRET missing or under 32 chars in .env — sign-in cannot work without it"
mkdir -p "$AGENTS" "$DIR/logs" "$DIR/data"
ok "config, build and deps present"

# The Docker console can coexist with this daemon, but ONLY on a different port. Two servers
# on one port means the loser crash-loops against the winner every 30 seconds.
#
# Sharing data/ between them is safe: the console never writes application state (the worker is
# the single writer), and the derived files it does rewrite on read — answers.json, Q&A.md —
# are written atomically with identical content, so a concurrent write replaces bytes with the
# same bytes.
#
# Running both is a reasonable belt-and-braces setup, because they fail differently: the
# container cannot start until someone logs in (Docker Desktop is a GUI app), while the daemon
# starts at boot with no login. The daemon is then the console that is always there.
container_ports="$(docker ps --filter "name=jobapp_website" --format '{{.Ports}}' 2>/dev/null || true)"
if [ -n "$container_ports" ]; then
  if printf '%s' "$container_ports" | grep -qE "(^|[^0-9])${PORT}->"; then
    warn "the jobapp_website CONTAINER is published on port $PORT: $container_ports"
    echo >&2
    echo "  Either give the daemon its own port:" >&2
    echo "      WEB_PORT=8089 ./install-services.sh" >&2
    echo "  or stop the container and let the daemon have $PORT:" >&2
    echo "      ./jobapp_website.sh down && ./install-services.sh" >&2
    die "refusing to install two consoles on the same port"
  fi
  ok "Docker console is up on $container_ports — this daemon will take $PORT instead (no clash)"
fi
note "node     $NODE_BIN/node"
note "user     $USER_NAME:$GROUP_NAME (uid $UID_NUM)"

# ----------------------------------------------------------------- console: LaunchDaemon
if [ "$WITH_CONSOLE" -eq 0 ]; then
  section "Console"
  ok "left to Docker on 8090 — nothing to install (./jobapp_website.sh up)"
  # An old console LaunchAgent from a previous install would still grab 8088 at every login,
  # running a second copy of the same app against the same data for no reason.
  if [ -f "$WEB_AGENT_PLIST" ]; then
    launchctl bootout "gui/$UID_NUM/$WEB_LABEL" 2>/dev/null || true
    rm -f "$WEB_AGENT_PLIST"
    ok "removed a leftover console LaunchAgent (it duplicated the container)"
  fi
else

section "Console → LaunchDaemon (starts at boot, no login required)"

# Both would bind port $PORT the moment someone logs in at the GUI, and the loser crash-loops
# against the winner every 30 seconds.
if [ -f "$WEB_AGENT_PLIST" ]; then
  launchctl bootout "gui/$UID_NUM/$WEB_LABEL" 2>/dev/null || launchctl unload "$WEB_AGENT_PLIST" 2>/dev/null || true
  rm -f "$WEB_AGENT_PLIST"
  ok "removed the old console LaunchAgent (the daemon replaces it — two would fight for port $PORT)"
fi

TMP_PLIST="$(mktemp)"
write_web_plist "$TMP_PLIST"

# A LaunchDaemon must be owned by root:wheel and not group/world writable, or launchd
# refuses to load it — with a message that does not say so.
sudo install -o root -g wheel -m 644 "$TMP_PLIST" "$WEB_DAEMON_PLIST"
rm -f "$TMP_PLIST"
ok "wrote $WEB_DAEMON_PLIST (root:wheel 644)"

# Free the port first, or the daemon crash-loops against a console started by hand.
[ -x "$DIR/web-stop.sh" ] && "$DIR/web-stop.sh" >/dev/null 2>&1 || true

sudo launchctl bootout "system/$WEB_LABEL" 2>/dev/null || true
sudo launchctl bootstrap system "$WEB_DAEMON_PLIST" || sudo launchctl load "$WEB_DAEMON_PLIST"
ok "loaded into the system domain"
fi

# ------------------------------------------------------------------- worker: LaunchAgent
section "Worker → LaunchAgent (needs the GUI session auto-login provides)"
write_worker_plist "$WORKER_PLIST"
ok "wrote $WORKER_PLIST"

# Release the browser profile before launchd takes over, or the agent fights a hand-started worker.
[ -x "$DIR/worker-stop.sh" ] && "$DIR/worker-stop.sh" >/dev/null 2>&1 || true

launchctl bootout "gui/$UID_NUM/$WORKER_LABEL" 2>/dev/null || true
if launchctl bootstrap "gui/$UID_NUM" "$WORKER_PLIST" 2>/dev/null; then
  ok "loaded into your GUI session"
else
  # Expected over SSH with nobody signed in: there is no Aqua domain to load it into.
  warn "cannot load it from here — this session has no GUI domain (launchctl managername = $(launchctl managername))."
  note "It is installed and will start at the next login. With auto-login on, that is the next boot."
  # We stopped the worker a moment ago to hand it to launchd, and launchd cannot take it in
  # this session. Leaving it down would mean this script made things WORSE than it found
  # them — approvals would queue with nothing to execute them. So start it by hand instead.
  if [ -x "$DIR/worker-start.sh" ]; then
    note "starting it by hand for now, so approvals keep working until the next boot…"
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
if [ "$WITH_CONSOLE" -eq 0 ]; then
  dockerhealth="$(curl -fsS --max-time 3 "http://127.0.0.1:8090/api/health" 2>/dev/null || true)"
  if [ -n "$dockerhealth" ]; then ok "Docker console on 8090: $dockerhealth"
  else warn "Docker console not responding on 8090 — start it with: ./jobapp_website.sh up"; fi
fi
for _ in $(seq 1 20); do
  [ "$WITH_CONSOLE" -eq 0 ] && break
  sleep 1
  health="$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
  [ -n "$health" ] && break
done
if [ "$WITH_CONSOLE" -eq 1 ]; then
  if [ -n "${health:-}" ]; then
    ok "console daemon responding on port $PORT: $health"
  else
    warn "console daemon not responding yet — check $DIR/logs/web.log and: sudo launchctl print system/$WEB_LABEL"
  fi
fi

[ "$WITH_CONSOLE" -eq 1 ] && sudo launchctl print "system/$WEB_LABEL" 2>/dev/null | awk '/state = /{print "  daemon state   "$3} /last exit code/{print "  last exit      "$4}' || true
autolog="$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || echo "off")"
note "auto-login     $autolog"
note "worker         $(pgrep -f 'tsx src/worker.ts' >/dev/null && echo running || echo 'not running (starts at next login)')"

section "What survives a reboot now"
if [ "$WITH_CONSOLE" -eq 1 ]; then
  echo "  Console (daemon, $PORT): yes — starts at boot before any login."
fi
if [ "$autolog" = "$USER_NAME" ]; then
  echo "  Console (Docker, 8090):  yes — auto-login starts Docker Desktop, which restarts the container."
  echo "  Worker:                  yes — LaunchAgent, loaded by the auto-login session."
else
  echo "  Console (Docker, 8090):  NO — Docker Desktop is a GUI login item, so it needs a login."
  echo "  Worker:                  NO — it needs a GUI session, and auto-login is off."
  echo "                           Fix both with: ./install-services.sh --autologin"
fi
echo
note "console    http://127.0.0.1:$PORT  (daemon)"
note "status:    sudo launchctl print system/$WEB_LABEL ; launchctl list | grep jobapp"
note "restart:   sudo launchctl kickstart -k system/$WEB_LABEL"
note "logs:      $DIR/logs/web.log · $DIR/logs/worker.log"
note "uninstall: ./install-services.sh --uninstall"

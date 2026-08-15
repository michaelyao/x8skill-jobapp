#!/usr/bin/env bash
# Start the job console web server in the background.
#
#   ./web-start.sh              # 0.0.0.0:8088
#   WEB_PORT=3010 ./web-start.sh
#
# Preflight-checks the things that otherwise fail in confusing ways: a login page with no
# accounts behind it, a missing session secret, or a stale process already on the port.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

HOST="${WEB_HOST:-0.0.0.0}"
PORT="${WEB_PORT:-8088}"
PIDFILE="$DIR/data/.web.pid"
LOG="$DIR/logs/web.log"

die() { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
note() { printf '  %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }

# --- is something already on the port? ---------------------------------------
existing="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [ -n "$existing" ]; then
  echo "Already listening on port $PORT (pid $existing):"
  ps -p "$existing" -o pid,etime,command | tail -n +2 | cut -c1-100
  echo
  echo "Stop it first:  ./web-stop.sh"
  exit 1
fi

# --- preflight ----------------------------------------------------------------
[ -f "$DIR/.env" ] || die ".env not found in $DIR"
[ -d "$DIR/web/node_modules" ] || die "web/node_modules missing — run: cd web && npm install"

grep -qE '^WEB_SESSION_SECRET=.{32,}' "$DIR/.env" \
  || die "WEB_SESSION_SECRET missing or shorter than 32 chars in .env — sign-in cannot work without it"

accounts="$(grep -cE '^(WEB_USER_[A-Z0-9_]+|WEB_USERS)=' "$DIR/.env" || true)"
if [ "$accounts" -eq 0 ]; then
  warn "No accounts configured in .env — the login page will reject every password."
  warn "Create one with:  npm run hash-password    (then re-run this script)"
fi

mkdir -p "$DIR/logs" "$DIR/data"

# Build if there is no production build yet, or if sources are newer than it.
if [ ! -d "$DIR/web/.next" ]; then
  echo "No production build found — building (first run takes a minute)…"
  (cd "$DIR/web" && JOBAPP_ROOT="$DIR" npx next build) || die "build failed"
fi

# --- start --------------------------------------------------------------------
echo "Starting the console on $HOST:$PORT …"
(
  cd "$DIR/web"
  JOBAPP_ROOT="$DIR" nohup npx next start -H "$HOST" -p "$PORT" >>"$LOG" 2>&1 &
)

# Wait for the port to actually accept connections, then record the PID that owns it.
# The launcher exits/re-execs (npm → next-server), so its own pid is not the one to keep.
for _ in $(seq 1 40); do
  sleep 0.5
  listener="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  [ -n "$listener" ] && break
done

if [ -z "${listener:-}" ]; then
  echo
  die "did not come up within 20s — last lines of $LOG:
$(tail -15 "$LOG" 2>/dev/null)"
fi

echo "$listener" >"$PIDFILE"

health="$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || echo '{}')"
worker_state="$(printf '%s' "$health" | sed -n 's/.*"worker":"\([^"]*\)".*/\1/p')"

printf '\033[32m✓\033[0m running (pid %s)\n' "$listener"
note "local    http://127.0.0.1:$PORT"
[ "$HOST" = "0.0.0.0" ] && {
  ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  [ -n "$ip" ] && note "network  http://$ip:$PORT"
}
grep -qE '^PUBLIC_URL=' "$DIR/.env" && note "public   $(grep -E '^PUBLIC_URL=' "$DIR/.env" | cut -d= -f2-)"
note "log      $LOG"

case "$worker_state" in
  idle|busy) note "worker   $worker_state" ;;
  *) warn "worker is not running (${worker_state:-unknown}) — approvals will queue but never execute. Start it with: npm run worker" ;;
esac

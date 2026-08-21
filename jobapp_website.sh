#!/usr/bin/env bash
# Run the jobapp WEBSITE as a container. The worker is NOT part of this — it stays native,
# because it drives a real headed Chrome (see Dockerfile.jobapp_website).
#
#   ./jobapp_website.sh up        # preflight, build if needed, start
#   ./jobapp_website.sh down      # stop and remove
#   ./jobapp_website.sh rebuild   # rebuild the image and restart
#   ./jobapp_website.sh status
#   ./jobapp_website.sh logs      # follow
#
# The preflight repeats the checks web-start.sh makes, because they fail the same confusing
# way in a container: a login page with no accounts behind it, or a missing session secret.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PORT="${WEB_PORT:-8090}"
SERVICE="website"
CONTAINER="jobapp_website"

die()  { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
note() { printf '  %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }

# docker-compose v1 binary vs the v2 subcommand — both exist on this machine.
compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"
  else docker-compose "$@"; fi
}

require_daemon() {
  docker version --format '{{.Server.Version}}' >/dev/null 2>&1 && return 0
  echo "The Docker daemon is not reachable." >&2
  echo >&2
  echo "On macOS the daemon IS Docker Desktop, and Docker Desktop starts at GUI login." >&2
  echo "Over SSH with nobody logged in at the console, it cannot even be launched:" >&2
  echo "  open -a Docker  ->  error 125, Domain does not support specified action" >&2
  echo >&2
  echo "Log in at the machine once (or enable automatic login), then re-run this." >&2
  echo "Meanwhile the native console still works:  ./web-start.sh" >&2
  exit 1
}

preflight() {
  [ -f "$DIR/.env" ] || die ".env not found in $DIR"

  grep -qE '^WEB_SESSION_SECRET=.{32,}' "$DIR/.env" \
    || die "WEB_SESSION_SECRET missing or shorter than 32 chars in .env — sign-in cannot work without it"

  local accounts
  accounts="$(grep -cE '^(WEB_USER_[A-Z0-9_]+|WEB_USERS)=' "$DIR/.env" || true)"
  if [ "$accounts" -eq 0 ]; then
    warn "No accounts configured in .env — the login page will reject every password."
    warn "Create one with:  npm run hash-password"
  fi

  # Every path in docker-compose.yml is a single-FILE bind mount. Docker creates a DIRECTORY
  # in place of a missing source, and the console then reads a directory as a config file and
  # fails in a way that looks nothing like the cause.
  local f
  for f in .env .x8note.config "Q&A.txt" "Q&A.md" resumes.config; do
    [ -f "$DIR/$f" ] || die "missing bind-mount source: $f  (Docker would silently create a directory there)"
  done
  mkdir -p "$DIR/data" "$DIR/logs"

  # A native console from web-start.sh holds the same port. Two servers on one data/ is not
  # itself unsafe (the worker serializes the real work), but the second one cannot bind.
  local holder
  holder="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  if [ -n "$holder" ] && ! docker ps --filter "name=$CONTAINER" --format '{{.Names}}' 2>/dev/null | grep -q .; then
    echo "Port $PORT is held by a NATIVE process (pid $holder):"
    ps -p "$holder" -o pid,etime,command | tail -n +2 | cut -c1-100
    echo
    die "stop it first:  ./web-stop.sh"
  fi
}

health() {
  curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true
}

case "${1:-up}" in
  up)
    require_daemon
    preflight
    echo "Starting the website container on port $PORT …"
    compose up -d --build "$SERVICE"
    for _ in $(seq 1 60); do
      sleep 1
      [ -n "$(health)" ] && break
    done
    h="$(health)"
    [ -n "$h" ] || die "did not become healthy within 60s — logs:
$(compose logs --tail 25 "$SERVICE" 2>&1)"
    ok "website responding: $h"
    note "local    http://127.0.0.1:$PORT"
    ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
    [ -n "$ip" ] && note "network  http://$ip:$PORT"
    grep -qE '^PUBLIC_URL=' "$DIR/.env" && note "public   $(grep -E '^PUBLIC_URL=' "$DIR/.env" | cut -d= -f2-)"
    note "logs     ./jobapp_website.sh logs"
    case "$(printf '%s' "$h" | sed -n 's/.*"worker":"\([^"]*\)".*/\1/p')" in
      idle|busy) note "worker   native, running" ;;
      *) warn "the worker is not running — approvals will queue but never execute. Start it with: ./worker-start.sh" ;;
    esac
    ;;
  down)
    require_daemon
    compose down
    ok "container stopped and removed"
    ;;
  rebuild)
    require_daemon
    preflight
    compose build --no-cache "$SERVICE"
    compose up -d "$SERVICE"
    ok "rebuilt and restarted"
    ;;
  status)
    require_daemon
    compose ps
    echo
    h="$(health)"
    if [ -n "$h" ]; then ok "health: $h"; else warn "not responding on port $PORT"; fi
    ;;
  logs)
    require_daemon
    compose logs -f --tail 100 "$SERVICE"
    ;;
  *)
    die "usage: $0 {up|down|rebuild|status|logs}"
    ;;
esac

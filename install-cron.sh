#!/bin/bash
# Install (idempotently) the every-15-min approval poller into your crontab.
# Run this yourself: it may prompt macOS for permission to modify cron.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LINE="*/15 * * * * PATH=/opt/homebrew/bin:/usr/bin:/bin ${DIR}/approvals-cron.sh"

if crontab -l 2>/dev/null | grep -qF "approvals-cron.sh"; then
  echo "Already installed:"
  crontab -l | grep "approvals-cron.sh"
  exit 0
fi

{
  crontab -l 2>/dev/null || true
  echo ""
  echo "# x8skill-jobapp — Phase-B approval poller every 15 min (submits jobs you reply APPROVE to)"
  echo "${LINE}"
} | crontab -

echo "Installed:"
crontab -l | grep "approvals-cron.sh"

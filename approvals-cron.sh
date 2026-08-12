#!/bin/bash
# Phase-B approval poller — checks the inbox for APPROVE/SKIP replies to queued
# applications and submits the approved ones. Safe to run repeatedly (lockfile
# guards against overlap; skips gracefully if the Chrome profile is busy).
#
# Installed via crontab every 15 min. PATH is set in the crontab line so cron
# finds Homebrew node/npm.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
echo "===== $(date '+%Y-%m-%d %H:%M:%S') approvals poll =====" >> logs/approvals-cron.log
npm run approvals >> logs/approvals-cron.log 2>&1

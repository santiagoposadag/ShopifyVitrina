#!/bin/sh
# Snapshot the SQLite database from the Docker volume into ./backups on the
# HOST, so a lost volume or machine wipe cannot take the backups with it.
#
#   ./scripts/backup.sh
#
# Uses the SQLite online backup API (safe while the server is writing).
# Schedule it daily, e.g. with cron at 03:30:
#   30 3 * * * cd /path/to/vitrina && ./scripts/backup.sh >> backups/backup.log 2>&1
#
# Note: the container runs as uid 1000 (node). On Linux hosts make sure
# ./backups is writable by that uid; on macOS (Docker Desktop) it just works.
set -eu
cd "$(dirname "$0")/.."
mkdir -p backups
docker compose --profile backup run --rm \
  -v "$(pwd)/backups:/backups" \
  -e BACKUP_DIR=/backups \
  backup

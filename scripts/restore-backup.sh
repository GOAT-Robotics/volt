#!/usr/bin/env bash
# Restores a Volt database backup from S3.
# usage: scripts/restore-backup.sh s3://bucket/prefix/YYYY/MM/volt-<timestamp>.db.gz [data-dir]
set -euo pipefail
SRC="${1:?usage: $0 s3://bucket/…/volt-<timestamp>.db.gz [data-dir]}"
DATA="${2:-${VOLT_DATA_DIR:-/opt/volt/data}}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $SRC"
aws s3 cp "$SRC" "$TMP/volt.db.gz"
aws s3 cp "$SRC.json" "$TMP/manifest.json" 2>/dev/null || echo "(no manifest — skipping checksum)"
gunzip "$TMP/volt.db.gz"

if [ -f "$TMP/manifest.json" ]; then
  want=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256OfUncompressedDb"])' "$TMP/manifest.json")
  have=$(sha256sum "$TMP/volt.db" | cut -d" " -f1)
  [ "$want" = "$have" ] || { echo "Checksum mismatch: $have (expected $want)"; exit 1; }
  echo "Checksum OK"
fi
if command -v python3 >/dev/null; then
  python3 -c 'import sqlite3,sys; r=sqlite3.connect(sys.argv[1]).execute("pragma integrity_check").fetchone()[0]; print("Integrity:", r); sys.exit(0 if r=="ok" else 1)' "$TMP/volt.db"
fi

read -r -p "Stop Volt and replace $DATA/volt.db with this backup? [y/N] " ok
[ "$ok" = "y" ] || { echo "Cancelled"; exit 1; }

docker compose stop volt
stamp=$(date -u +%Y%m%dT%H%M%SZ)
[ -f "$DATA/volt.db" ] && mv "$DATA/volt.db" "$DATA/volt.db.before-restore-$stamp"
rm -f "$DATA/volt.db-wal" "$DATA/volt.db-shm"
cp "$TMP/volt.db" "$DATA/volt.db"
[ -f "$DATA/volt.db.before-restore-$stamp" ] && chown --reference="$DATA/volt.db.before-restore-$stamp" "$DATA/volt.db" || true
docker compose start volt
echo "Restored. The previous database is $DATA/volt.db.before-restore-$stamp"

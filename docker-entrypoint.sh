#!/bin/sh
set -e

: "${DATA_DIR:=/app/data}"

# SQLITE_DIR default depends on whether Litestream is configured:
#   Litestream on  → /tmp (tmpfs; durability comes from GCS replication)
#   Litestream off → DATA_DIR (the persistent volume; FUSE-safe at low traffic)
# An explicit SQLITE_DIR env var always wins.
if [ -z "$SQLITE_DIR" ]; then
  if [ -n "$LITESTREAM_REPLICA_BUCKET" ]; then
    SQLITE_DIR=/tmp
  else
    SQLITE_DIR="$DATA_DIR"
  fi
fi
export SQLITE_DIR
APP_CMD="node /app/server/src/index.js"

mkdir -p "$SQLITE_DIR"

# Phase 1 — Litestream restore (if configured). Order matters: restore
# runs BEFORE the legacy bootstrap so the latest replica wins. In 0.5.x
# `restore` errors if the output path already exists, so leaving the file
# in place from a previous boot's bootstrap would block restore.
# `-if-replica-exists` keeps first-boot (no replica yet) a clean no-op.
# Any other restore failure (auth, network, corrupt replica) exits hard
# under `set -e` so the previous Cloud Run revision keeps serving.
if [ -n "$LITESTREAM_REPLICA_BUCKET" ]; then
  : "${LITESTREAM_REPLICA_TYPE:=gs}"
  export LITESTREAM_REPLICA_TYPE LITESTREAM_REPLICA_REGION LITESTREAM_REPLICA_ENDPOINT
  echo "[entrypoint] Litestream enabled (type=$LITESTREAM_REPLICA_TYPE bucket=$LITESTREAM_REPLICA_BUCKET sqlite_dir=$SQLITE_DIR)"
  litestream restore -if-replica-exists -config /etc/litestream.yml "$SQLITE_DIR/app.sqlite"
  litestream restore -if-replica-exists -config /etc/litestream.yml "$SQLITE_DIR/sessions.sqlite"
fi

# Phase 2 — Bootstrap from legacy DATA_DIR as a fallback only. Fires when
# the local file is still missing — i.e. first-ever boot (no replica yet)
# or Litestream is disabled and the local volume is empty.
if [ "$SQLITE_DIR" != "$DATA_DIR" ]; then
  for db in app.sqlite sessions.sqlite; do
    if [ ! -f "$SQLITE_DIR/$db" ] && [ -f "$DATA_DIR/$db" ]; then
      echo "[entrypoint] bootstrapping $db from legacy $DATA_DIR/$db"
      cp "$DATA_DIR/$db" "$SQLITE_DIR/$db"
    fi
  done
fi

# Phase 3 — Hand off to the app, wrapped by Litestream replicate when on.
if [ -n "$LITESTREAM_REPLICA_BUCKET" ]; then
  exec litestream replicate -config /etc/litestream.yml -exec "$APP_CMD"
else
  echo "[entrypoint] Litestream disabled (LITESTREAM_REPLICA_BUCKET unset, sqlite_dir=$SQLITE_DIR)"
  exec $APP_CMD
fi

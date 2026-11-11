#!/usr/bin/env bash
# Copy this machine's pi configuration into the container so the pane runs the
# same pi the developer runs. Sessions and the installed release are skipped:
# they are 1.7 GB of history and the image already has pi.
set -euo pipefail

SRC="${PI_CONFIG_SRC:-$HOME/.pi/agent}"
DST="${PI_CONFIG_DST:-/root/.pi/agent}"

mkdir -p "$DST"
for item in auth.json settings.json models.json models-store.json mcp.json trust.json AGENTS.md extensions npm bin skills pi-subagents; do
  if [ -e "$SRC/$item" ]; then
    cp -a "$SRC/$item" "$DST/" 2>/dev/null || true
  fi
done
echo "pi config copied from $SRC to $DST"

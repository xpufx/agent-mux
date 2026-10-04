#!/usr/bin/env bash
set -e

REAL_HOME="$(getent passwd "$USER" 2>/dev/null | cut -d: -f6)"
[[ -z "$REAL_HOME" ]] && REAL_HOME="${HOME%%/.ag*}"
LOCAL_BIN="$REAL_HOME/.local/bin"
TARGET_AGY="$LOCAL_BIN/agy"
REAL_AGY="$LOCAL_BIN/agy.bin"

echo "Uninstalling agent-mux..."

if [[ -f "$REAL_AGY" ]]; then
  echo "[+] Restoring original agy binary..."
  mv -f "$REAL_AGY" "$TARGET_AGY"
fi

if [[ -L "$LOCAL_BIN/opencode" ]]; then
  echo "[+] Removing opencode wrapper symlink..."
  rm -f "$LOCAL_BIN/opencode"
fi

rm -f "$LOCAL_BIN/agent-mux" \
      "$LOCAL_BIN/opencode-mux" \
      "$LOCAL_BIN/agy-profile" \
      "$LOCAL_BIN/agy-supervisor.py"

echo "[+] Done. System binaries restored to original state."

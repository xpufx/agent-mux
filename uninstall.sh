#!/usr/bin/env bash
set -e

REAL_HOME="$(getent passwd "$USER" 2>/dev/null | cut -d: -f6)"
[[ -z "$REAL_HOME" ]] && REAL_HOME="${HOME%%/.agy-profiles*}"
LOCAL_BIN="$REAL_HOME/.local/bin"
TARGET_AGY="$LOCAL_BIN/agy"
REAL_AGY="$LOCAL_BIN/agy.bin"

echo "Uninstalling agy-multi-account..."

if [[ -f "$REAL_AGY" ]]; then
  echo "[+] Restoring original agy binary..."
  mv -f "$REAL_AGY" "$TARGET_AGY"
fi

rm -f "$LOCAL_BIN/agy-oktaya" \
      "$LOCAL_BIN/agy-pufaysokt" \
      "$LOCAL_BIN/agy-rr" \
      "$LOCAL_BIN/agy-auto" \
      "$LOCAL_BIN/agy-supervisor.py"

echo "[+] Done. System agy binary restored to original state."

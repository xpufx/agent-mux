#!/usr/bin/env bash
#
# Minimal agent-mux bootstrap. All configuration and profile lifecycle logic
# lives in the TypeScript core (src/core/setup.ts / src/core/profiles.ts); this
# script only builds the project, installs the CLI entry point, and delegates
# the rest to `agent-mux setup`.
#
# Usage: ./install.sh [provider|all] [account1 account2 ...] [--dry-run]
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_HOME="$(getent passwd "$USER" 2>/dev/null | cut -d: -f6)"
[[ -z "$REAL_HOME" ]] && REAL_HOME="${HOME%%/.agent-mux*}"
LOCAL_BIN="${REAL_HOME}/.local/bin"

echo "==================================================="
echo "  Installing agent-mux                             "
echo "==================================================="

# 1. Install build dependencies on first run.
if [[ ! -d "$DIR/node_modules" ]]; then
	echo "[+] Installing dependencies..."
	(cd "$DIR" && npm install)
fi

# 2. Build TypeScript binaries.
echo "[+] Building TypeScript binaries..."
(cd "$DIR" && npm run build)

# 3. Install the CLI entry point so setup can be invoked by name.
mkdir -p "$LOCAL_BIN"
cp -p "$DIR/dist/cli.js" "$LOCAL_BIN/agent-mux"
chmod +x "$LOCAL_BIN/agent-mux"

# 4. Delegate configuration to the TypeScript core (single source of truth).
exec "$LOCAL_BIN/agent-mux" setup "$@"

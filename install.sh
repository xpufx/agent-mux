#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_HOME="$(getent passwd "$USER" 2>/dev/null | cut -d: -f6)"
[[ -z "$REAL_HOME" ]] && REAL_HOME="${HOME%%/.agent-mux*}"
LOCAL_BIN="${REAL_HOME}/.local/bin"

AGENT_MUX_HOME="${AGENT_MUX_HOME:-${REAL_HOME}/.agent-mux}"
PROFILES_BASE="${AGENT_MUX_HOME}/profiles/antigravity"

# 1. Check for one-time migration from legacy ~/.agy-profiles
LEGACY_DIR="${REAL_HOME}/.agy-profiles"
if [[ -d "$LEGACY_DIR" && ! -d "$PROFILES_BASE" ]]; then
  echo "[+] Migrating existing profiles from $LEGACY_DIR to $PROFILES_BASE..."
  mkdir -p "$PROFILES_BASE"
  cp -rn "$LEGACY_DIR"/* "$PROFILES_BASE/" 2>/dev/null || true
fi

ACCOUNTS=("$@")
if [[ ${#ACCOUNTS[@]} -eq 0 ]]; then
  if [[ -d "$PROFILES_BASE" ]]; then
    mapfile -t ACCOUNTS < <(ls -1 "$PROFILES_BASE" 2>/dev/null || true)
  fi
  if [[ ${#ACCOUNTS[@]} -eq 0 ]]; then
    ACCOUNTS=("primary" "secondary")
  fi
fi

echo "==================================================="
echo "  Installing agent-mux                             "
echo "==================================================="
echo "Base Directory     : $AGENT_MUX_HOME"
echo "Profiles Directory : $PROFILES_BASE"
echo "Configured Accounts: ${ACCOUNTS[*]}"
echo ""

# 2. Build TypeScript binaries
echo "[+] Building TypeScript binaries..."
(cd "$DIR" && npm run build)

mkdir -p "$LOCAL_BIN" "$PROFILES_BASE"

# 3. Configure Profile Symlinks and Shared Storage for Antigravity
echo "[+] Configuring profiles and sharing conversation history..."
PRIMARY="${ACCOUNTS[0]}"

# Configure primary profile
mkdir -p "$PROFILES_BASE/$PRIMARY"
ln -sfn "$REAL_HOME/.gemini" "$PROFILES_BASE/$PRIMARY/.gemini"
for dot in .gitconfig .git-credentials .ssh .local .config .bashrc .profile .agents; do
  [[ -e "$REAL_HOME/$dot" ]] && ln -sfn "$REAL_HOME/$dot" "$PROFILES_BASE/$PRIMARY/$dot"
done

# Configure remaining profiles
for prof in "${ACCOUNTS[@]:1}"; do
  mkdir -p "$PROFILES_BASE/$prof/.gemini/antigravity-cli"
  [[ -f "$REAL_HOME/.gemini/antigravity-cli/settings.json" ]] && \
    cp -n "$REAL_HOME/.gemini/antigravity-cli/settings.json" "$PROFILES_BASE/$prof/.gemini/antigravity-cli/settings.json" 2>/dev/null || true
  ln -sfn "$REAL_HOME/.gemini/config" "$PROFILES_BASE/$prof/.gemini/config"

  mkdir -p "$REAL_HOME/.gemini/antigravity-cli/conversations"
  if [[ ! -L "$PROFILES_BASE/$prof/.gemini/antigravity-cli/conversations" ]]; then
    rm -rf "$PROFILES_BASE/$prof/.gemini/antigravity-cli/conversations"
    ln -sfn "$REAL_HOME/.gemini/antigravity-cli/conversations" "$PROFILES_BASE/$prof/.gemini/antigravity-cli/conversations"
  fi

  for dot in .gitconfig .git-credentials .ssh .local .config .bashrc .profile .agents; do
    [[ -e "$REAL_HOME/$dot" ]] && ln -sfn "$REAL_HOME/$dot" "$PROFILES_BASE/$prof/$dot"
  done
done

# 4. Back up and link real agy binary
TARGET_AGY="$LOCAL_BIN/agy"
REAL_AGY="$LOCAL_BIN/agy.bin"

if [[ -f "$TARGET_AGY" && ! -L "$TARGET_AGY" ]]; then
  if file "$TARGET_AGY" | grep -q "ELF"; then
    echo "[+] Moving real ELF binary to $REAL_AGY..."
    mv "$TARGET_AGY" "$REAL_AGY"
  fi
fi

if [[ ! -f "$REAL_AGY" ]]; then
  SYS_AGY="$(which agy 2>/dev/null || true)"
  if [[ -n "$SYS_AGY" && -f "$SYS_AGY" ]]; then
    echo "[+] Copying system agy binary from $SYS_AGY to $REAL_AGY..."
    cp -p "$SYS_AGY" "$REAL_AGY"
  fi
fi

# 5. Install agent-mux binaries into ~/.local/bin
echo "[+] Installing binaries into $LOCAL_BIN..."
cp -p "$DIR/dist/cli.js" "$LOCAL_BIN/agent-mux"
cp -p "$DIR/dist/wrappers/agy.js" "$LOCAL_BIN/agy"
cp -p "$DIR/dist/wrappers/opencode.js" "$LOCAL_BIN/opencode-mux"

chmod +x "$LOCAL_BIN/agent-mux" "$LOCAL_BIN/agy" "$LOCAL_BIN/opencode-mux"

echo ""
echo "=== Installation Complete! ==="
echo "Live status:"
"$LOCAL_BIN/agent-mux" status

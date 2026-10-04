#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_HOME="$(getent passwd "$USER" 2>/dev/null | cut -d: -f6)"
[[ -z "$REAL_HOME" ]] && REAL_HOME="${HOME%%/.ag*}"
LOCAL_BIN="${REAL_HOME}/.local/bin"
PROFILES_BASE="${REAL_HOME}/.agy-profiles"

PRIMARY="${1:-primary}"
SECONDARY="${2:-secondary}"

echo "==================================================="
echo "  Installing agent-mux (TypeScript Edition)        "
echo "==================================================="
echo "Primary profile  : $PRIMARY"
echo "Secondary profile: $SECONDARY"
echo "Profiles base    : $PROFILES_BASE"
echo ""

# 1. Build TypeScript dist binaries
echo "[+] Building TypeScript binaries..."
(cd "$DIR" && npm run build)

mkdir -p "$LOCAL_BIN" "$PROFILES_BASE/$PRIMARY" "$PROFILES_BASE/$SECONDARY/.gemini/antigravity-cli"

# 2. Back up and link real agy binary
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

# 3. Configure Profile Symlinks and Shared Storage for Antigravity
echo "[+] Configuring profiles and sharing conversation history..."
ln -sfn "$REAL_HOME/.gemini" "$PROFILES_BASE/$PRIMARY/.gemini"
for dot in .gitconfig .git-credentials .ssh .local .config .bashrc .profile .agents; do
  [[ -e "$REAL_HOME/$dot" ]] && ln -sfn "$REAL_HOME/$dot" "$PROFILES_BASE/$PRIMARY/$dot"
done

[[ -f "$REAL_HOME/.gemini/antigravity-cli/settings.json" ]] && \
  cp -n "$REAL_HOME/.gemini/antigravity-cli/settings.json" "$PROFILES_BASE/$SECONDARY/.gemini/antigravity-cli/settings.json" 2>/dev/null || true
ln -sfn "$REAL_HOME/.gemini/config" "$PROFILES_BASE/$SECONDARY/.gemini/config"

mkdir -p "$REAL_HOME/.gemini/antigravity-cli/conversations"
if [[ ! -L "$PROFILES_BASE/$SECONDARY/.gemini/antigravity-cli/conversations" ]]; then
  rm -rf "$PROFILES_BASE/$SECONDARY/.gemini/antigravity-cli/conversations"
  ln -sfn "$REAL_HOME/.gemini/antigravity-cli/conversations" "$PROFILES_BASE/$SECONDARY/.gemini/antigravity-cli/conversations"
fi

for dot in .gitconfig .git-credentials .ssh .local .config .bashrc .profile .agents; do
  [[ -e "$REAL_HOME/$dot" ]] && ln -sfn "$REAL_HOME/$dot" "$PROFILES_BASE/$SECONDARY/$dot"
done

# 4. Install agent-mux binaries into ~/.local/bin
echo "[+] Installing binaries into $LOCAL_BIN..."
cp -p "$DIR/dist/cli.js" "$LOCAL_BIN/agent-mux"
cp -p "$DIR/dist/wrappers/agy.js" "$LOCAL_BIN/agy"
cp -p "$DIR/dist/wrappers/opencode.js" "$LOCAL_BIN/opencode-mux"

chmod +x "$LOCAL_BIN/agent-mux" "$LOCAL_BIN/agy" "$LOCAL_BIN/opencode-mux"

# Convenience shortcuts
ln -sfn "$LOCAL_BIN/agent-mux" "$LOCAL_BIN/agy-profile"

echo ""
echo "=== Installation Complete! ==="
echo "Live status:"
"$LOCAL_BIN/agent-mux" status

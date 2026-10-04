#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_HOME="$(getent passwd "$USER" 2>/dev/null | cut -d: -f6)"
[[ -z "$REAL_HOME" ]] && REAL_HOME="${HOME%%/.agent-mux*}"
LOCAL_BIN="${REAL_HOME}/.local/bin"

AGENT_MUX_HOME="${AGENT_MUX_HOME:-${REAL_HOME}/.agent-mux}"
AGY_PROFILES="${AGENT_MUX_HOME}/profiles/antigravity"
OPENCODE_PROFILES="${AGENT_MUX_HOME}/profiles/opencode"

# Optional provider argument: ./install.sh [antigravity|opencode|all] [accounts...]
TARGET_PROVIDER="all"
if [[ "$1" == "antigravity" || "$1" == "agy" ]]; then
  TARGET_PROVIDER="antigravity"
  shift
elif [[ "$1" == "opencode" ]]; then
  TARGET_PROVIDER="opencode"
  shift
elif [[ "$1" == "all" ]]; then
  TARGET_PROVIDER="all"
  shift
fi

ACCOUNTS=("$@")
if [[ ${#ACCOUNTS[@]} -eq 0 ]]; then
  if [[ -d "$AGY_PROFILES" ]]; then
    mapfile -t ACCOUNTS < <(ls -1 "$AGY_PROFILES" 2>/dev/null || true)
  fi
  if [[ ${#ACCOUNTS[@]} -eq 0 ]]; then
    ACCOUNTS=("primary" "secondary")
  fi
fi

echo "==================================================="
echo "  Installing agent-mux                             "
echo "==================================================="
echo "Base Directory     : $AGENT_MUX_HOME"
echo "Target Provider    : $TARGET_PROVIDER"
echo "Configured Accounts: ${ACCOUNTS[*]}"
echo ""

# 1. Build TypeScript binaries
echo "[+] Building TypeScript binaries..."
(cd "$DIR" && npm run build)

mkdir -p "$LOCAL_BIN"

# 2. Antigravity Configuration
if [[ "$TARGET_PROVIDER" == "all" || "$TARGET_PROVIDER" == "antigravity" ]]; then
  echo "[+] Configuring Antigravity profiles..."
  mkdir -p "$AGY_PROFILES"
  PRIMARY="${ACCOUNTS[0]}"

  # Primary profile
  mkdir -p "$AGY_PROFILES/$PRIMARY"
  ln -sfn "$REAL_HOME/.gemini" "$AGY_PROFILES/$PRIMARY/.gemini"
  for dot in .gitconfig .git-credentials .ssh .local .config .bashrc .profile .agents; do
    [[ -e "$REAL_HOME/$dot" ]] && ln -sfn "$REAL_HOME/$dot" "$AGY_PROFILES/$PRIMARY/$dot"
  done

  # Remaining profiles
  for prof in "${ACCOUNTS[@]:1}"; do
    mkdir -p "$AGY_PROFILES/$prof/.gemini/antigravity-cli"
    [[ -f "$REAL_HOME/.gemini/antigravity-cli/settings.json" ]] && \
      cp -n "$REAL_HOME/.gemini/antigravity-cli/settings.json" "$AGY_PROFILES/$prof/.gemini/antigravity-cli/settings.json" 2>/dev/null || true
    ln -sfn "$REAL_HOME/.gemini/config" "$AGY_PROFILES/$prof/.gemini/config"

    mkdir -p "$REAL_HOME/.gemini/antigravity-cli/conversations"
    if [[ ! -L "$AGY_PROFILES/$prof/.gemini/antigravity-cli/conversations" ]]; then
      rm -rf "$AGY_PROFILES/$prof/.gemini/antigravity-cli/conversations"
      ln -sfn "$REAL_HOME/.gemini/antigravity-cli/conversations" "$AGY_PROFILES/$prof/.gemini/antigravity-cli/conversations"
    fi

    for dot in .gitconfig .git-credentials .ssh .local .config .bashrc .profile .agents; do
      [[ -e "$REAL_HOME/$dot" ]] && ln -sfn "$REAL_HOME/$dot" "$AGY_PROFILES/$prof/$dot"
    done
  done

  # Back up and link real agy binary
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

  cp -p "$DIR/dist/wrappers/agy.js" "$LOCAL_BIN/agy"
  chmod +x "$LOCAL_BIN/agy"
fi

# 3. OpenCode Configuration
if [[ "$TARGET_PROVIDER" == "all" || "$TARGET_PROVIDER" == "opencode" ]]; then
  echo "[+] Configuring OpenCode profiles..."
  mkdir -p "$OPENCODE_PROFILES"
  PRIMARY="${ACCOUNTS[0]}"

  # Primary profile (inherits current auth and config)
  mkdir -p "$OPENCODE_PROFILES/$PRIMARY/.local/share/opencode" "$OPENCODE_PROFILES/$PRIMARY/.config"
  [[ -e "$REAL_HOME/.config/opencode" ]] && ln -sfn "$REAL_HOME/.config/opencode" "$OPENCODE_PROFILES/$PRIMARY/.config/opencode"
  [[ -e "$REAL_HOME/.local/share/opencode/auth.json" ]] && \
    cp -n "$REAL_HOME/.local/share/opencode/auth.json" "$OPENCODE_PROFILES/$PRIMARY/.local/share/opencode/auth.json" 2>/dev/null || true
  [[ -e "$REAL_HOME/.local/share/opencode/repos" ]] && \
    ln -sfn "$REAL_HOME/.local/share/opencode/repos" "$OPENCODE_PROFILES/$PRIMARY/.local/share/opencode/repos"
  [[ -e "$REAL_HOME/.local/share/opencode/opencode.db" ]] && \
    ln -sfn "$REAL_HOME/.local/share/opencode/opencode.db" "$OPENCODE_PROFILES/$PRIMARY/.local/share/opencode/opencode.db"

  for dot in .gitconfig .git-credentials .ssh .local .config .bashrc .profile .agents; do
    [[ -e "$REAL_HOME/$dot" ]] && ln -sfn "$REAL_HOME/$dot" "$OPENCODE_PROFILES/$PRIMARY/$dot"
  done

  # Remaining profiles (isolated auth, shared config & projects)
  for prof in "${ACCOUNTS[@]:1}"; do
    mkdir -p "$OPENCODE_PROFILES/$prof/.local/share/opencode" "$OPENCODE_PROFILES/$prof/.config"
    [[ -e "$REAL_HOME/.config/opencode" ]] && ln -sfn "$REAL_HOME/.config/opencode" "$OPENCODE_PROFILES/$prof/.config/opencode"
    [[ -e "$REAL_HOME/.local/share/opencode/repos" ]] && \
      ln -sfn "$REAL_HOME/.local/share/opencode/repos" "$OPENCODE_PROFILES/$prof/.local/share/opencode/repos"
    [[ -e "$REAL_HOME/.local/share/opencode/opencode.db" ]] && \
      ln -sfn "$REAL_HOME/.local/share/opencode/opencode.db" "$OPENCODE_PROFILES/$prof/.local/share/opencode/opencode.db"

    for dot in .gitconfig .git-credentials .ssh .local .config .bashrc .profile .agents; do
      [[ -e "$REAL_HOME/$dot" ]] && ln -sfn "$REAL_HOME/$dot" "$OPENCODE_PROFILES/$prof/$dot"
    done
  done

  cp -p "$DIR/dist/wrappers/opencode.js" "$LOCAL_BIN/opencode-mux"
  chmod +x "$LOCAL_BIN/opencode-mux"
  # Symlink wrapper ahead of /usr/bin/opencode on PATH
  ln -sfn "$LOCAL_BIN/opencode-mux" "$LOCAL_BIN/opencode"
fi

# 4. Install Main CLI
cp -p "$DIR/dist/cli.js" "$LOCAL_BIN/agent-mux"
chmod +x "$LOCAL_BIN/agent-mux"
ln -sfn "$LOCAL_BIN/agent-mux" "$LOCAL_BIN/agy-profile"

echo ""
echo "=== Installation Complete! ==="
echo "Live status:"
"$LOCAL_BIN/agent-mux" status

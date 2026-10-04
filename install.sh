#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_HOME="$(getent passwd "$USER" 2>/dev/null | cut -d: -f6)"
[[ -z "$REAL_HOME" ]] && REAL_HOME="${HOME%%/.agy-profiles*}"
LOCAL_BIN="${REAL_HOME}/.local/bin"
PROFILES_BASE="${REAL_HOME}/.agy-profiles"

PRIMARY="${1:-oktaya}"
SECONDARY="${2:-pufaysokt}"

echo "==================================================="
echo "  Installing Antigravity (agy) Multi-Account Relay "
echo "==================================================="
echo "Primary profile  : $PRIMARY"
echo "Secondary profile: $SECONDARY"
echo "Target directory : $PROFILES_BASE"
echo ""

mkdir -p "$LOCAL_BIN" "$PROFILES_BASE/$PRIMARY" "$PROFILES_BASE/$SECONDARY/.gemini/antigravity-cli"

# 1. Back up and link real agy binary
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
  else
    echo "[-] Error: Could not locate real agy binary. Please install agy first."
    exit 1
  fi
fi

# 2. Configure Profile Symlinks and Shared Storage
echo "[+] Configuring profiles and sharing conversation history..."

# Setup Primary
ln -sfn "$REAL_HOME/.gemini" "$PROFILES_BASE/$PRIMARY/.gemini"
for dot in .gitconfig .git-credentials .ssh .local .config .bashrc .profile .agents; do
  [[ -e "$REAL_HOME/$dot" ]] && ln -sfn "$REAL_HOME/$dot" "$PROFILES_BASE/$PRIMARY/$dot"
done

# Setup Secondary
[[ -f "$REAL_HOME/.gemini/antigravity-cli/settings.json" ]] && \
  cp -n "$REAL_HOME/.gemini/antigravity-cli/settings.json" "$PROFILES_BASE/$SECONDARY/.gemini/antigravity-cli/settings.json" 2>/dev/null || true
ln -sfn "$REAL_HOME/.gemini/config" "$PROFILES_BASE/$SECONDARY/.gemini/config"

# Share conversation trajectory DBs between both accounts
mkdir -p "$REAL_HOME/.gemini/antigravity-cli/conversations"
if [[ ! -L "$PROFILES_BASE/$SECONDARY/.gemini/antigravity-cli/conversations" ]]; then
  rm -rf "$PROFILES_BASE/$SECONDARY/.gemini/antigravity-cli/conversations"
  ln -sfn "$REAL_HOME/.gemini/antigravity-cli/conversations" "$PROFILES_BASE/$SECONDARY/.gemini/antigravity-cli/conversations"
fi

for dot in .gitconfig .git-credentials .ssh .local .config .bashrc .profile .agents; do
  [[ -e "$REAL_HOME/$dot" ]] && ln -sfn "$REAL_HOME/$dot" "$PROFILES_BASE/$SECONDARY/$dot"
done

# 3. Install Wrapper Binaries
echo "[+] Installing CLI wrapper and supervisor into $LOCAL_BIN..."
cp -p "$DIR/bin/agy-supervisor.py" "$LOCAL_BIN/agy-supervisor.py"
cp -p "$DIR/bin/agy-profile" "$LOCAL_BIN/agy-profile"
cp -p "$DIR/bin/agy" "$LOCAL_BIN/agy"

chmod +x "$LOCAL_BIN/agy" "$LOCAL_BIN/agy-profile" "$LOCAL_BIN/agy-supervisor.py"

# Convenience symlinks
ln -sfn "$LOCAL_BIN/agy-profile" "$LOCAL_BIN/agy-oktaya"
ln -sfn "$LOCAL_BIN/agy-profile" "$LOCAL_BIN/agy-pufaysokt"
ln -sfn "$LOCAL_BIN/agy-profile" "$LOCAL_BIN/agy-rr"
ln -sfn "$LOCAL_BIN/agy-profile" "$LOCAL_BIN/agy-auto"

# 4. Configure Paseo Plugin (if Paseo is installed)
PASEO_CONFIG="${REAL_HOME}/.paseo/config.json"
PASEO_PLUGINS_DIR="${REAL_HOME}/code/paseo/plugins"
if [[ -f "$PASEO_CONFIG" ]]; then
  echo "[+] Configuring Paseo plugin for antigravity-claude..."
  # The plugin now lives in the paseo repo (plugins/antigravity-claude).
  if [[ ! -d "$PASEO_PLUGINS_DIR/antigravity-claude" ]]; then
    echo "[-] Notice: $PASEO_PLUGINS_DIR/antigravity-claude not found; pull the paseo repo to get the plugin."
  else
  # Register plugin in config.json if not present
  python3 -c "
import json
config_path = '${PASEO_CONFIG}'
try:
    with open(config_path, 'r') as f:
        data = json.load(f)
    if 'plugins' not in data:
        data['plugins'] = {}
    if 'antigravity-claude' not in data['plugins']:
        data['plugins']['antigravity-claude'] = {
            'source': 'directory',
            'path': '${PASEO_PLUGINS_DIR}/antigravity-claude',
            'enabled': True
        }
        with open(config_path, 'w') as f:
            json.dump(data, f, indent=2)
        print('[+] Registered antigravity-claude plugin in Paseo config.')
    else:
        print('[+] antigravity-claude plugin already registered in Paseo config.')
except Exception as e:
    print(f'[-] Notice: Could not update Paseo config: {e}')
"
  fi
fi

echo ""
echo "=== Installation Complete! ==="
echo "Status check:"
"$LOCAL_BIN/agy-profile" status

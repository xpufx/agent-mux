# agent-mux

High-availability multi-account multiplexer, smart router, and stream supervisor for AI coding agent CLIs.

## Overview

Agent CLIs such as Google Antigravity (`agy`) and OpenCode enforce rolling token limits or rate limits per account. When driven by autonomous agent frameworks like Paseo, hitting a rate limit or HTTP 429 mid-turn terminates or stalls the agent session.

`agent-mux` provides:
1. **Environment Isolation**: Each account has an isolated `$HOME` directory under `~/.agent-mux/profiles/<provider>/<account>` so local configurations, credentials, and state caches never conflict.
2. **Configurable Base**: Defaults to `~/.agent-mux`, configurable via the `AGENT_MUX_HOME` environment variable.
3. **Arbitrary $N$ Accounts**: Scale beyond 2 accounts to 3, 5, or more per provider with automatic sequential fallback and round-robin scheduling.
4. **Shared Session History**: Trajectory databases (e.g. SQLite conversation stores) and developer dotfiles (`.gitconfig`, `.ssh`, `.agents`) are symlinked across profiles so project context is preserved.
5. **Persistent Cooldown State**: Rate limits and quota exhaustion timestamps are tracked persistently in `~/.agent-mux/state/cooldowns.json` per `(provider, profile, pool)`. Accounts in cooldown are skipped immediately without attempting doomed turns.
6. **Anti-Flapping Circuit Breaker**: If all accounts for a requested model/pool are exhausted, the supervisor halts immediately and surfaces the error upstream. It avoids mid-turn kills, duplicate prompt replay, or infinite flapping loops.
7. **Quota Pool & Model Awareness**: Separates quota tracking by pool (e.g. Gemini vs Claude/Partner in Antigravity) so an exhausted Claude quota does not block Gemini tasks.
8. **Active Server Probing**: High-speed, non-interactive verification (`agent-mux probe`) that tests server ground truth in seconds with zero terminal or TTY suspension.
9. **Flexible Configuration**: Stored in `~/.agent-mux/config.json` with live CLI management via `agent-mux config`.

---

## Architecture

```text
Clients (Paseo, Terminal, Automation)
        │
        ▼
   agent-mux (Smart Router)
        │
        ├── Reads persistent cooldown state (~/.agent-mux/state/cooldowns.json)
        ├── Inspects live quota and auth status across profiles (1..N)
        ├── Filters candidates matching requested pool/model
        │
        ▼
   Stream Supervisor (for stream-json sessions)
        │
        ├── Spawns Active Profile (Child Process)
        │     │
        │     ├── If 429 / RESOURCE_EXHAUSTED occurs:
        │     │     1. Records cooldown with reset timestamp to disk
        │     │     2. Queries router for healthy fallback candidate
        │     │     3. If all candidates exhausted: HALTS immediately (no flapping)
        │     │     4. If healthy candidate exists: switches HOME & replays turn
        │     ▼
        ▼
   Shared Trajectory Store (~/.gemini/.../conversations/*.db, ~/.local/share/opencode)
```

---

## Directory Structure

```text
~/.agent-mux/                           # Configurable via $AGENT_MUX_HOME
├── config.json                         # Persistent settings (surface_account, etc.)
├── state/
│   └── cooldowns.json                  # Active quota cooldowns with expiry timestamps
├── profiles/
│   ├── antigravity/
│   │   ├── primary/                    # Isolated $HOME for Account 1
│   │   ├── secondary/                  # Isolated $HOME for Account 2
│   │   └── tertiary/                   # Isolated $HOME for Account 3
│   └── opencode/
│       ├── primary/
│       └── secondary/
└── .rr_<provider>_<pool>               # Round-robin state tracking
```

---

## Supported Providers

| Provider | ID | Transparent Wrapper | Credential Store | Quota Tracking |
| :--- | :--- | :--- | :--- | :--- |
| Google Antigravity | `antigravity`, `agy` | `~/.local/bin/agy` | `.gemini/antigravity-cli/antigravity-oauth-token` | Dual-pool (Gemini vs Claude) via glog UTC timestamps |
| OpenCode | `opencode` | `~/.local/bin/opencode` | `.local/share/opencode/auth.json` | Account isolation, log rate-limit detection, model probing |

---

## Quick Start

### 1. Build and Install

```bash
git clone https://forge.mrs.uppidi.com/xpufx-org/agent-mux.git
cd agent-mux
npm install
./install.sh <account1> <account2> [account3...]
```

Example with 2 accounts:
```bash
./install.sh primary secondary
```

This will:
- Build standalone TypeScript binaries into `dist/` with ESBuild.
- Move the native `agy` binary to `~/.local/bin/agy.bin`.
- Install `agent-mux` and transparent wrappers (`agy`, `opencode-mux`) into `~/.local/bin/`.
- Configure isolated profile trees under `~/.agent-mux/profiles/` with symlinked conversation history and shared dotfiles.

### 2. Inspect Quota & Auth Status

```bash
agent-mux status
```

Output:
```text
=== agent-mux Provider & Profile Status ===

Provider: Google Antigravity (antigravity)
  • primary [Authenticated]:
      - Pool 'gemini': [READY]
      - Pool 'claude': [READY]
  • secondary [Authenticated]:
      - Pool 'gemini': [READY]
      - Pool 'claude': [LIMIT (155h 15m remaining)]
```

### 3. Active Server Probe

Verify connectivity and model access live in seconds:

```bash
# Probe Antigravity Claude pool on primary account
agent-mux probe antigravity primary claude

# Probe OpenCode models across all profiles
agent-mux probe opencode
```

---

## CLI Usage

### Direct Routing Commands

Run any provider with automatic quota routing:

```bash
agent-mux run antigravity -p "echo hello"
agent-mux run opencode -p "echo hello"
```

Or using the installed transparent wrappers:

```bash
agy -p "echo hello"
opencode
```

### Routing Options

- `--profile <name>`: Explicitly route to a specific profile.
- `--round-robin`, `--rr`: Alternate sequentially across healthy accounts.

---

## Profile Management

Manage and authenticate isolated provider accounts:

```bash
# List all configured accounts and authentication state
agent-mux profile list

# Scaffold a new account profile (symlinks dotfiles and trajectories)
agent-mux profile add antigravity tertiary

# Interactively log in to an account profile
agent-mux profile auth antigravity tertiary

# Remove / delete an account profile
agent-mux profile remove antigravity tertiary
```

---

## Quota Cooldown Management

When a profile encounters a 429 / Quota Exhaustion, `agent-mux` records a persistent cooldown:

```bash
# View active quota locks and remaining cooldown time
agent-mux cooldowns

# Manually clear all cooldown locks (e.g. after quota resets early)
agent-mux cooldowns clear

# Clear cooldown for a specific provider, profile, and pool
agent-mux cooldowns clear antigravity primary claude
```

## Configuration

Settings are saved in `~/.agent-mux/config.json` and can be inspected or modified via the CLI:

### CLI Configuration Commands

```bash
# View active configuration and resolved settings
agent-mux config list

# Get a specific setting
agent-mux config get surface_account

# Set a setting
agent-mux config set surface_account none
```

### Isolation Modes (`isolation_mode`)

Controls how account isolation and the agent process environment are handled:

- **`home`** (default): Each profile acts as an independent `$HOME` (`~/.agent-mux/profiles/<provider>/<profile>`). Fully isolated dotfiles, caches, and history per profile.
- **`scoped`**: The agent process keeps the real user `$HOME` and `cwd` (`/home/<user>`). Only provider-specific configs and credentials are scoped per profile:
  - Antigravity uses a private Linux mount overlay via `bwrap` mapping `~/.gemini` to the profile.
  - OpenCode uses `XDG_DATA_HOME` and `XDG_CONFIG_HOME`.
  - Both instances can run concurrently with real `$HOME` and real working directory.

```bash
# Switch to scoped mode (real HOME with scoped configs)
agent-mux config set isolation_mode scoped

# Switch back to isolated home mode (independent HOME per profile)
agent-mux config set isolation_mode home
```

### Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `AGENT_MUX_HOME` | Custom base directory for profiles and state | `~/.agent-mux` |
| `AGENT_MUX_ISOLATION_MODE` | Overrides `isolation_mode` (`home` or `scoped`) | Config file / `home` |
| `AGENT_MUX_SURFACE_ACCOUNT` | Overrides `surface_account` mode (`none`, `tool`, `message`, `both`) | Config file / `none` |
| `AGENT_MUX_PROFILE` | Forces execution to a specific account profile | Auto-routed |
| `AGY_TARGET_POOL` | Overrides target pool selection (`gemini` or `claude`) | Derived from `--model` |

---

## Uninstallation

To remove wrappers and restore the original binaries:

```bash
./uninstall.sh
```

---

## License

GPL-3.0
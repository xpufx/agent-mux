# agent-mux

High-availability multi-account multiplexer, smart router, and stream supervisor for AI coding agent CLIs.

## Use case

Use case:   agent-mux is ideal for CLI coding agents that do not provide an API key or other mechanism that can be incorporated into a regular AI router. For example, with the default configuration, Antigravity CLI (agy) only allows one session to be logged in at a time and uses the same HOME for everything. When juggling quotas and cooldowns this becomes problematic. 

agent-mux automatically checks all configured profiles and determines their quota status. The included optional supervisor and router watches the agent's stream and dynamically and automatically routes inference calls to the profile that is available.

The included wrapper scripts (if you run install.sh) mean you do not need to change the cli's execution path or name when using in tools like Paseo. It will keep calling one CLI which will now automatically route to where it's supposed to. Alternatively you can configure your agent fleet tool to register providers separately and have them ready to go, changing the model manually as necessary.

---

## Overview

Agent CLIs such as Google Antigravity (`agy`) and OpenCode enforce rolling token limits or rate limits per account. When driven by autonomous agent frameworks like Paseo, hitting a rate limit or HTTP 429 mid-turn terminates or stalls the agent session.

`agent-mux` provides:
1. **Environment Isolation**: By default (`isolation_mode: scoped`) each account keeps the real `$HOME` (`/home/<user>`) and only its auth/credential state is scoped per profile, so local configurations, caches, and state caches never conflict while agents still see the real host home. `isolation_mode: home` remains available as explicit opt-in for a fully isolated `$HOME` under `~/.agent-mux/profiles/<provider>/<account>`.
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
        │     │     4. If healthy candidate exists: switches profile & replays turn
        │     │        (swaps the scoped auth bind; swaps HOME only in `home` mode)
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

## Install (npm)

```bash
npm install -g @xpufx/agent-mux
agent-mux setup
```

`agent-mux setup` is idempotent and safe to re-run. It detects the real provider
binaries (`agy.bin`, `opencode.bin`), creates the isolated profile trees under
`~/.agent-mux/profiles/`, links shared developer dotfiles and session history,
and wires the `agent-mux`, `agy`, `opencode`, and `opencode-mux` wrappers into
`~/.local/bin` (make sure it is ahead of the provider binaries on `$PATH`).

Preview the changes without touching disk:

```bash
agent-mux setup --dry-run
```

No install-time scripts run automatically: published packages never install a
`postinstall`/`preinstall` hook, so configuration only happens when you
explicitly run `agent-mux setup`.

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
=== agent-mux Provider & Profile Status [Isolation Mode: scoped] ===

Provider: Google Antigravity (antigravity)
  • primary [Authenticated] (primary@example.com):
      - Pool 'gemini': [READY]
      - Pool 'claude': [READY]
  • secondary [Authenticated] (secondary@example.com):
      - Pool 'gemini': [READY]
      - Pool 'claude': [LIMIT (154h 10m remaining)]

Provider: OpenCode (opencode)
  • primary [Authenticated] (opencode-go (oc_sk_8c...FeX7)):
      - Pool 'default': [READY]
  • secondary [Authenticated] (opencode-go (oc_sk_84...tqV7)):
      - Pool 'default': [READY]
```

### 3. Active Server Probe & Model Discovery

Verify connectivity and model access live in seconds:

```bash
# Probe Antigravity Claude pool on primary account
agent-mux probe antigravity primary claude

# Probe OpenCode models across all profiles (pure execution, zero MCP/plugin cruft)
agent-mux probe opencode

# Configure a specific model to probe for OpenCode inference testing
agent-mux config set opencode_probe_model "opencode/fledge-alpha-free"

# List all available models discovered in the CLI environment
agent-mux models opencode

# List only free models
agent-mux models opencode --free
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

### Routing Options & Examples

- `--profile <name>`: Explicitly route to a specific account profile (bypasses auto-routing).
- `--round-robin`, `--rr`: Alternate sequentially across healthy accounts.

```bash
# Auto-route to the first ready account with quota:
agent-mux run antigravity -p "echo hello"

# Explicitly bind to a specific account profile:
agent-mux run antigravity --profile secondary -p "echo hello"
agent-mux agy --profile primary --model claude-3-5-sonnet

# Using the installed wrapper directly:
agy --profile secondary -p "echo hello"
opencode --profile primary

# Alternate sequentially across healthy accounts:
agy --round-robin -p "run batch test"
```

---

## Profile Management

Manage and authenticate isolated provider accounts:

```bash
# List all configured accounts and authentication state
agent-mux profile list
```

Output:
```text
=== Configured Account Profiles [Isolation Mode: scoped] ===

Provider: Google Antigravity (antigravity)
Base directory: ~/.agent-mux/profiles/antigravity
  • primary          [Authenticated] (primary@example.com) -> ~/.agent-mux/profiles/antigravity/primary
  • secondary        [Authenticated] (secondary@example.com) -> ~/.agent-mux/profiles/antigravity/secondary

Provider: OpenCode (opencode)
Base directory: ~/.agent-mux/profiles/opencode
  • primary          [Authenticated] (opencode-go (oc_sk_8c...FeX7)) -> ~/.agent-mux/profiles/opencode/primary
  • secondary        [Authenticated] (opencode-go (oc_sk_84...tqV7)) -> ~/.agent-mux/profiles/opencode/secondary
```

```bash
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

- **`scoped`** (default): The agent process keeps the real user `$HOME` and `cwd` (`/home/<user>`). Only provider-specific auth/credential state is scoped per profile, so concurrent accounts never share a login while everything else (dotfiles, `~/.gemini` conversations/config, project caches) stays on the real host home:
  - Antigravity uses a private Linux mount overlay via `bwrap` that bind-mounts **only** `~/.gemini/antigravity-cli/antigravity-oauth-token` from the profile. Real `~/.gemini` (conversations, `config`, caches) remains visible and is shared across profiles.
  - OpenCode uses `XDG_DATA_HOME` and `XDG_CONFIG_HOME`.
  - Both instances can run concurrently with real `$HOME` and real working directory.
  - `bwrap` (bubblewrap) is required for Antigravity in this mode. If it is missing, `agent-mux` fails fast with install instructions for your distro; `install.sh` also warns during setup.
- **`home`** (opt-in): Each profile acts as an independent `$HOME` (`~/.agent-mux/profiles/<provider>/<profile>`). Fully isolated dotfiles, caches, and history per profile. Use this only when agents must not see the real host home.

```bash
# Default: real HOME with per-profile auth (requires bwrap for agy)
agent-mux config set isolation_mode scoped

# Opt in to a fully isolated profile HOME
agent-mux config set isolation_mode home
```

### Failover Policy (`routingPolicy`)

Controls the order in which candidate `(profile, pool)` pairs are tried when a turn hits a `429` / quota exhaustion. The requested pool is the **target pool** (derived from `--model`, or `AGY_TARGET_POOL`); the other pool(s) come from the provider's supported pools (`adapter.getSupportedPools()`).

| Policy | Ordering | Behavior |
| :--- | :--- | :--- |
| `pool-strict` (default) | `A1:target -> A2:target -> HALT` | Exhausts the target pool across every profile, then halts. No model drift or cost variance. |
| `pool-spillover` | `[A1:target -> A2:target] -> [A1:other -> A2:other] -> HALT` | Exhausts the target pool across all profiles, then falls back to the other pool(s) across all profiles before halting. |
| `account-first` | `A1:target -> A1:other -> A2:target -> A2:other -> HALT` | Preserves profile/`$HOME` and cache locality by trying the other pool on the same profile before hopping accounts. |

Concrete example with target `gemini` and other pool `claude`:

| Policy | Order |
| :--- | :--- |
| `pool-strict` | `primary:gemini -> secondary:gemini -> HALT` |
| `pool-spillover` | `primary:gemini -> secondary:gemini -> primary:claude -> secondary:claude -> HALT` |
| `account-first` | `primary:gemini -> primary:claude -> secondary:gemini -> secondary:claude -> HALT` |

Persisted cooldowns are keyed `provider:profile:pool` and gate every candidate, so a profile that is cooling down in one pool can still serve another pool. Once every candidate in the configured order has been tried or is cooling down, the supervisor halts instead of flapping. When a policy selects a pool other than the requested one, the supervisor rewrites `--model` to that pool's fallback model and logs the profile + model it switched to.

```bash
# Inspect / change the active policy
agent-mux config get routingPolicy
agent-mux config set routingPolicy account-first

# One-off environment override
AGENT_MUX_ROUTING_POLICY=pool-spillover agy -p "echo hi"
```

### Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `AGENT_MUX_HOME` | Custom base directory for profiles and state | `~/.agent-mux` |
| `AGENT_MUX_ISOLATION_MODE` | Overrides `isolation_mode` (`scoped` or `home`) | Config file / `scoped` |
| `AGENT_MUX_SURFACE_ACCOUNT` | Overrides `surface_account` mode (`none`, `tool`, `message`, `both`) | Config file / `none` |
| `AGENT_MUX_ROUTING_POLICY` | Overrides `routingPolicy` (`pool-strict`, `pool-spillover`, `account-first`) | Config file / `pool-strict` |
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
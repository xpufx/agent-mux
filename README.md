# agent-mux

High-availability multi-account multiplexer and stream supervisor for AI coding agent CLIs.

## Overview

Agent CLIs such as Google Antigravity (`agy`) and OpenCode enforce rolling token limits or rate limits per account. When driven by autonomous agent frameworks like Paseo, hitting a rate limit or HTTP 429 mid-turn terminates or stalls the agent session.

`agent-mux` provides:
1. Environment isolation: Each account has an isolated `$HOME` directory so local configurations, credentials, and state caches never conflict.
2. Shared session history: Trajectory databases (e.g. SQLite conversation stores) and global developer dotfiles (`.gitconfig`, `.ssh`, `.agents`) are symlinked across profiles so context is preserved.
3. Stream supervision: When launched in streaming mode (such as Paseo's `stream-json`), `agent-mux` monitors the NDJSON stream. If an account encounters `RESOURCE_EXHAUSTED` or a rate limit mid-turn, the supervisor terminates the exhausted process, switches `$HOME` to the secondary account, resumes the exact conversation ID, and resends the pending prompt transparently.
4. Quota pool awareness: Tracks separate quota pools (e.g. Gemini tokens vs Claude/Partner tokens in Antigravity) without burning tokens on status checks.

## Architecture

```text
Clients (Paseo, Terminal)
        │
        ▼
   agent-mux (Smart Router)
        │
        ├── Quota/Health check across profiles
        │
        ▼
   Stream Supervisor (for stream-json sessions)
        │
        ├── Account A (active child process)
        │     │
        │     └── If 429 / RESOURCE_EXHAUSTED detected:
        │           Terminates Account A
        │           Swaps HOME to Account B
        │           Replays prompt on same conversation ID
        ▼
   Shared SQLite Trajectory Store (~/.gemini/.../conversations/*.db)
```

## Supported Providers

| Provider | ID | Binary | Credential Store | Quota Handling |
| :--- | :--- | :--- | :--- | :--- |
| Google Antigravity | `antigravity`, `agy` | `agy.bin` | `.gemini/antigravity-cli/antigravity-oauth-token` | Dual-pool (Gemini vs Claude) countdown tracking |
| OpenCode | `opencode` | `opencode` | `.local/share/opencode/auth.json` | Account isolation and rate-limit detection |

## Quick Start

### 1. Build and Install

```bash
git clone https://forge.mrs.uppidi.com/xpufx-org/agent-mux.git
cd agent-mux
npm install
./install.sh <primary_account> <secondary_account>
```

Example:
```bash
./install.sh primary secondary
```

This will:
- Build the TypeScript binaries into `dist/` with ESBuild.
- Move the native `agy` binary to `~/.local/bin/agy.bin`.
- Install `agent-mux` and transparent wrappers (`agy`, `opencode-mux`) into `~/.local/bin/`.
- Configure isolated profile trees and symlink shared conversation trajectory storage.

### 2. Check Quota & Health Status

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
      - Pool 'gemini': [LIMIT (25h 20m remaining)]
      - Pool 'claude': [READY]
```

### 3. Active Server Probe

To actively test server ground truth in an isolated `/tmp` workspace without burning unnecessary tokens or indexing directories:

```bash
agent-mux probe antigravity primary claude
```

## CLI Usage

Run any provider with auto-routing:

```bash
agent-mux run antigravity -p "echo hello"
agent-mux run opencode -p "echo hello"
```

Or using the installed transparent wrappers directly:

```bash
agy -p "echo hello"
```

Options:
- `--profile <name>`: Explicitly bind the command to a specific profile.
- `--round-robin`, `--rr`: Alternate sequentially across configured accounts.

## Uninstallation

To restore original binaries:

```bash
./uninstall.sh
```

## License

GPL-3.0
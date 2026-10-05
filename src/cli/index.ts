import { getProviderAdapter, listSupportedProviders } from "../providers/index.js";
import { getProviderStatus, listProfiles } from "../core/profiles.js";
import { selectProfile } from "../core/router.js";
import { runSupervisor, parseResetDurationSeconds } from "../core/supervisor.js";
import { recordCooldown, clearCooldown } from "../core/state.js";
import { spawn } from "node:child_process";

import {
  loadConfig,
  saveConfig,
  getSurfaceAccountMode,
  parseSurfaceAccountMode,
  getIsolationMode,
  parseIsolationMode,
  getConfigFilePath
} from "../core/config.js";
import { getAgentLogFilePath } from "../core/paths.js";
import fs from "node:fs";

async function printStatus(providerId?: string) {
  const providers = providerId
    ? [getProviderAdapter(providerId)]
    : listSupportedProviders();

  const activeIso = getIsolationMode();
  console.log(`=== agent-mux Provider & Profile Status [Isolation Mode: ${activeIso}] ===`);

  for (const prov of providers) {
    console.log(`\nProvider: ${prov.displayName} (${prov.id})`);
    const profiles = await getProviderStatus(prov);

    if (profiles.length === 0) {
      console.log(`  (No profiles configured at ${prov.profilesBaseDir})`);
      continue;
    }

    for (const p of profiles) {
      const authStr = p.authenticated ? "Authenticated" : "Pending login";
      const idStr = p.accountIdentity ? ` (${p.accountIdentity})` : "";
      console.log(`  • ${p.profile} [${authStr}]${idStr}:`);
      for (const pool of p.pools) {
        const detailStr = pool.details ? ` (${pool.details})` : "";
        console.log(`      - Pool '${pool.pool}': [${pool.state}${detailStr}]`);
      }
    }
  }
}

async function runProbe(providerId: string, profile?: string, pool?: string) {
  const prov = getProviderAdapter(providerId);
  const profiles = profile ? [profile] : listProfiles(prov);

  console.log(`=== Probing ${prov.displayName} ===`);
  for (const prof of profiles) {
    console.log(`• Profile: ${prof}`);
    if (prov.probe) {
      const poolsToProbe = pool ? [pool] : prov.getSupportedPools();
      for (const pl of poolsToProbe) {
        process.stdout.write(`  [Probing ${prof} (${pl})]... `);
        const res = await prov.probe(prof, pl);
        console.log(`[${res.state}: ${res.details}]`);
        if (res.state === "READY") {
          clearCooldown(prov.id, prof, pl);
        } else if (res.state === "LIMIT") {
          const durSec = parseResetDurationSeconds(res.details);
          recordCooldown(prov.id, prof, pl, durSec, res.details);
        }
      }
    } else {
      console.log("  (Provider does not require server-side probing)");
    }
  }
}

async function executeProvider(providerId: string, rawArgs: string[]) {
  const adapter = getProviderAdapter(providerId);

  // Parse routing flags
  let mode = "auto";
  const cmdArgs: string[] = [];
  let isStreamJson = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--profile" && i + 1 < rawArgs.length) {
      mode = rawArgs[++i];
    } else if (arg === "--round-robin" || arg === "--rr") {
      mode = "round-robin";
    } else {
      if (arg === "stream-json") isStreamJson = true;
      cmdArgs.push(arg);
    }
  }

  const decision = await selectProfile(adapter, cmdArgs, process.env, mode);

  if (isStreamJson) {
    const code = await runSupervisor({
      adapter,
      initialProfile: decision.profile,
      binaryPath: adapter.defaultBinaryPath,
      args: cmdArgs
    });
    process.exit(code);
  } else {
    const profDir = `${adapter.profilesBaseDir}/${decision.profile}`;
    const isolationMode = getIsolationMode();
    let execTarget: { binary: string; args: string[]; env: NodeJS.ProcessEnv };

    if (adapter.prepareExecution) {
      execTarget = adapter.prepareExecution(decision.profile, cmdArgs, process.env, isolationMode);
    } else {
      execTarget = {
        binary: adapter.defaultBinaryPath,
        args: cmdArgs,
        env: {
          ...process.env,
          HOME: profDir
        }
      };
    }

    const child = spawn(execTarget.binary, execTarget.args, {
      stdio: "inherit",
      env: execTarget.env
    });

    child.on("close", (code) => {
      process.exit(code ?? 0);
    });
  }
}

import {
  loadCooldowns,
  clearAllCooldowns
} from "../core/state.js";
import { runSetup } from "../core/setup.js";
import { ensureProfile, removeProfile } from "../core/profiles.js";

function printHelp() {
  console.log(`agent-mux - Multi-Account Multiplexer and Stream Supervisor

Usage:
  agent-mux status [provider]                 View live quota and auth status
  agent-mux probe <provider> [profile] [pool] Actively test live model/server access
  agent-mux models <provider> [--free]        List models available in CLI (optionally free only)
  agent-mux profile list [provider]           List all configured account profiles
  agent-mux profile add <provider> <name>     Scaffold a new account profile
  agent-mux profile auth <provider> <name>    Launch interactive login for a profile
  agent-mux profile remove <provider> <name>  Delete an account profile
  agent-mux cooldowns [list]                  View active cooldown locks and reset times
  agent-mux cooldowns clear [provider]        Clear persistent cooldown locks
  agent-mux setup [--dry-run]                 Configure profiles and wrappers (idempotent)
  agent-mux logs [--tail <n>] [-f]            View agent-mux routing and failover logs
  agent-mux config [list|get|set]             Manage global configuration
  agent-mux run <provider> [options] [args]   Run provider binary with auto-routing
  agent-mux <provider> [args]                 Shorthand for run (e.g. agent-mux agy ...)

Providers:
  antigravity, agy                            Google Antigravity CLI
  opencode                                    OpenCode CLI

Options:
  --profile <name>                            Explicitly select profile (overrides auto-routing)
  --round-robin, --rr                         Alternate healthy accounts sequentially
  --help, -h                                  Show this help message

Examples:
  agent-mux status                            View all accounts and live quota limits
  agent-mux agy -p "echo hi"                  Auto-route to healthy account and run
  agent-mux agy --profile secondary           Run using a specific account profile
  agy --profile primary -p "inspect git"      Direct transparent wrapper invocation
  agent-mux profile list                      List all accounts and authenticating emails
  agent-mux setup                             Configure profiles and transparent wrappers
  agent-mux cooldowns                         View active rate-limit locks and countdowns

Isolation Modes (agent-mux config set isolation_mode <home|scoped>):
  home                                        (Default) Each profile acts as an independent $HOME.
  scoped                                      $HOME and cwd remain user's real home; configs/tokens
                                              are scoped per profile (concurrent-safe via bwrap/XDG).

Environment Variables:
  AGENT_MUX_HOME                              Custom base dir (default: ~/.agent-mux)
  AGENT_MUX_ISOLATION_MODE                    Override isolation mode (home or scoped)
  AGENT_MUX_SURFACE_ACCOUNT                   Stream notification mode (none, tool, message, both)
  AGENT_MUX_PROFILE                           Force profile for execution
  AGY_TARGET_POOL                             Override pool (gemini or claude)
`);
}

async function handleProfileCommand(args: string[]) {
  const sub = args[0] || "list";

  if (sub === "--help" || sub === "-h" || sub === "help") {
    console.log(`Usage: agent-mux profile <action> [options]

Actions:
  list [provider]                  List configured account profiles
  add <provider> <name>            Scaffold a new account profile
  auth <provider> <name>           Launch interactive login for a profile
  remove <provider> <name>         Delete an account profile (aliases: rm, delete)
`);
    return;
  }

  if (sub === "list") {
    const providerId = args[1];
    const providers = providerId
      ? [getProviderAdapter(providerId)]
      : listSupportedProviders();

    const activeIso = getIsolationMode();
    console.log(`=== Configured Account Profiles [Isolation Mode: ${activeIso}] ===`);
    for (const prov of providers) {
      console.log(`\nProvider: ${prov.displayName} (${prov.id})`);
      console.log(`Base directory: ${prov.profilesBaseDir}`);
      const profiles = listProfiles(prov);
      if (profiles.length === 0) {
        console.log("  (No profiles configured)");
        continue;
      }
      for (const prof of profiles) {
        const auth = await prov.getAuthStatus(prof);
        const statusStr = auth ? "\x1b[32mAuthenticated\x1b[0m" : "\x1b[33mPending login\x1b[0m";
        const identity = prov.getAccountIdentity ? await prov.getAccountIdentity(prof) : undefined;
        const idStr = identity ? ` \x1b[90m(${identity})\x1b[0m` : "";
        console.log(`  • ${prof.padEnd(16)} [${statusStr}]${idStr} -> ${prov.profilesBaseDir}/${prof}`);
      }
    }
    return;
  }

  if (sub === "add") {
    const provId = args[1];
    const profName = args[2];
    if (!provId || !profName) {
      console.error("Usage: agent-mux profile add <provider> <profile-name>");
      process.exit(1);
    }
    const adapter = getProviderAdapter(provId);
    const createdPath = ensureProfile(adapter, profName);
    console.log(`\x1b[32m[+] Profile '${profName}' scaffolded successfully for ${adapter.displayName}.\x1b[0m`);
    console.log(`    Location: ${createdPath}`);
    console.log(`\nTo authenticate this profile, run:`);
    console.log(`    agent-mux profile auth ${adapter.id} ${profName}`);
    return;
  }

  if (sub === "auth") {
    const provId = args[1];
    const profName = args[2];
    if (!provId || !profName) {
      console.error("Usage: agent-mux profile auth <provider> <profile-name>");
      process.exit(1);
    }
    const adapter = getProviderAdapter(provId);
    const profDir = ensureProfile(adapter, profName);

    console.log(`\x1b[36m[*] Launching interactive authentication for ${adapter.displayName} (profile: ${profName})...\x1b[0m`);
    console.log(`    HOME=${profDir}`);

    const child = spawn(adapter.defaultBinaryPath, ["auth"], {
      stdio: "inherit",
      env: {
        ...process.env,
        HOME: profDir
      }
    });

    child.on("close", (code) => {
      if (code === 0) {
        console.log(`\x1b[32m[✓] Authentication process completed for ${profName}.\x1b[0m`);
      } else {
        console.log(`\x1b[33m[!] Authentication process exited with code ${code}.\x1b[0m`);
      }
      process.exit(code ?? 0);
    });
    return;
  }

  if (sub === "remove" || sub === "delete" || sub === "rm") {
    const provId = args[1];
    const profName = args[2];
    if (!provId || !profName) {
      console.error("Usage: agent-mux profile remove <provider> <profile-name>");
      process.exit(1);
    }
    const adapter = getProviderAdapter(provId);
    const removed = removeProfile(adapter, profName);
    if (removed) {
      console.log(`\x1b[32m[✓] Profile '${profName}' removed successfully from ${adapter.displayName}.\x1b[0m`);
    } else {
      console.log(`\x1b[33m[!] Profile '${profName}' does not exist for ${adapter.displayName}.\x1b[0m`);
    }
    return;
  }

  console.error(`Unknown profile action: ${sub}. Available actions: list, add, auth, remove`);
  process.exit(1);
}

function handleCooldownsCommand(args: string[]) {
  const sub = args[0] || "list";

  if (sub === "--help" || sub === "-h" || sub === "help") {
    console.log(`Usage: agent-mux cooldowns <action> [options]

Actions:
  list                                          View active cooldown locks and reset times
  clear [provider] [profile] [pool]             Clear all or specific persistent cooldown locks
`);
    return;
  }

  if (sub === "list") {
    const cooldowns = loadCooldowns();
    const entries = Object.values(cooldowns);
    console.log("=== Active Quota Cooldown Locks ===");
    if (entries.length === 0) {
      console.log("  (No active cooldown locks. All accounts are ready for routing.)");
      return;
    }

    const now = Date.now();
    for (const c of entries) {
      const remSec = Math.max(0, Math.floor((c.resetAt - now) / 1000));
      const hours = Math.floor(remSec / 3600);
      const mins = Math.floor((remSec % 3600) / 60);
      const secs = remSec % 60;
      const timeStr = `${hours}h ${mins}m ${secs}s`;
      console.log(
        `  • ${c.provider}:${c.profile} (pool: ${c.pool})\n` +
        `      Remaining: \x1b[33m${timeStr}\x1b[0m\n` +
        `      Reason:    ${c.reason || "429 / Quota exhausted"}\n` +
        `      Reset At:  ${new Date(c.resetAt).toISOString()}`
      );
    }
    return;
  }

  if (sub === "clear") {
    const prov = args[1];
    const prof = args[2];
    const pool = args[3];

    if (prov && prof && pool) {
      clearCooldown(prov, prof, pool);
      console.log(`\x1b[32m[✓] Cleared cooldown for ${prov}:${prof}:${pool}\x1b[0m`);
    } else {
      const cleared = clearAllCooldowns();
      console.log(`\x1b[32m[✓] Cleared all active cooldown locks (${cleared} cleared).\x1b[0m`);
    }
    return;
  }

  console.error(`Unknown cooldowns action: ${sub}. Available actions: list, clear`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    process.exit(0);
  }

  if (cmd === "profile" || cmd === "profiles") {
    await handleProfileCommand(args.slice(1));
    return;
  }

  if (cmd === "cooldown" || cmd === "cooldowns") {
    handleCooldownsCommand(args.slice(1));
    return;
  }

  if (cmd === "logs" || cmd === "log") {
    const logFile = getAgentLogFilePath();
    if (!fs.existsSync(logFile)) {
      console.log(`No logs found at ${logFile}`);
      return;
    }
    const tailIdx = args.indexOf("--tail") !== -1 ? args.indexOf("--tail") : args.indexOf("-n");
    const count = tailIdx !== -1 && args[tailIdx + 1] ? parseInt(args[tailIdx + 1], 10) : 50;
    const isFollow = args.includes("-f") || args.includes("--follow");

    if (isFollow) {
      const tailProc = spawn("tail", ["-n", String(count), "-f", logFile], { stdio: "inherit" });
      tailProc.on("close", (code) => process.exit(code ?? 0));
      return;
    }

    const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
    const slice = lines.slice(-count);
    console.log(`=== agent-mux Logs (${logFile}) ===`);
    console.log(slice.join("\n"));
    return;
  }

  if (cmd === "config") {
    const sub = args[1] || "list";
    if (sub === "list") {
      const cfg = loadConfig();
      const activeSurface = getSurfaceAccountMode();
      const activeIsolation = getIsolationMode();
      console.log("=== agent-mux Configuration ===");
      console.log(`Config file: ${getConfigFilePath()}`);
      console.log(
        `Active surface_account: ${activeSurface}${
          process.env.AGENT_MUX_SURFACE_ACCOUNT
            ? " (overridden by AGENT_MUX_SURFACE_ACCOUNT env)"
            : ""
        }`
      );
      console.log(
        `Active isolation_mode:  ${activeIsolation}${
          process.env.AGENT_MUX_ISOLATION_MODE
            ? " (overridden by AGENT_MUX_ISOLATION_MODE env)"
            : ""
        }`
      );
      console.log("\nSettings in config file:");
      console.log(JSON.stringify(cfg, null, 2));
      return;
    }

    if (sub === "get") {
      const key = args[2];
      if (!key) {
        console.error("Usage: agent-mux config get <key>");
        process.exit(1);
      }
      if (key === "surface_account") {
        console.log(getSurfaceAccountMode());
      } else if (key === "isolation_mode") {
        console.log(getIsolationMode());
      } else {
        const cfg = loadConfig();
        console.log(cfg[key] ?? "");
      }
      return;
    }

    if (sub === "set") {
      const key = args[2];
      const val = args[3];
      if (!key || val === undefined) {
        console.error("Usage: agent-mux config set <key> <value>");
        process.exit(1);
      }
      const cfg = loadConfig();
      if (key === "surface_account") {
        const parsed = parseSurfaceAccountMode(val);
        if (!parsed) {
          console.error(
            `Invalid surface_account mode: '${val}'. Valid options: tool, message, both, none`
          );
          process.exit(1);
        }
        cfg.surface_account = parsed;
      } else if (key === "isolation_mode") {
        const parsed = parseIsolationMode(val);
        if (!parsed) {
          console.error(
            `Invalid isolation_mode: '${val}'. Valid options: scoped (real HOME with scoped configs), home (independent HOME per profile)`
          );
          process.exit(1);
        }
        cfg.isolation_mode = parsed;
      } else {
        cfg[key] = val;
      }
      saveConfig(cfg);
      console.log(`Config saved: ${key} = ${val}`);
      return;
    }

    console.error(`Unknown config action: ${sub}. Use: list, get, set`);
    process.exit(1);
  }

  if (cmd === "setup") {
    const dryRun = args.includes("--dry-run");
    runSetup({ dryRun });
    return;
  }

  if (cmd === "status") {
    await printStatus(args[1]);
    return;
  }

  if (cmd === "probe") {
    if (!args[1]) {
      console.error("Usage: agent-mux probe <provider> [profile] [pool]");
      process.exit(1);
    }
    await runProbe(args[1], args[2], args[3]);
    return;
  }

  if (cmd === "models") {
    const provId = args[1];
    if (!provId) {
      console.error("Usage: agent-mux models <provider> [--free] [--profile <name>]");
      process.exit(1);
    }
    const prov = getProviderAdapter(provId);
    if (!prov.listModels) {
      console.error(`Provider '${prov.displayName}' does not support listing models.`);
      process.exit(1);
    }
    const freeOnly = args.includes("--free");
    let prof: string | undefined;
    const profIdx = args.indexOf("--profile");
    if (profIdx !== -1 && args[profIdx + 1]) {
      prof = args[profIdx + 1];
    }
    const models = await prov.listModels(prof);
    const filtered = freeOnly
      ? models.filter((m) => m.toLowerCase().includes("free"))
      : models;

    console.log(`=== Models for ${prov.displayName}${freeOnly ? " (Free only)" : ""}: ===`);
    if (filtered.length === 0) {
      console.log("  (No models found matching criteria)");
    } else {
      for (const m of filtered) {
        console.log(`  • ${m}`);
      }
    }
    return;
  }

  if (cmd === "run") {
    if (!args[1]) {
      console.error("Usage: agent-mux run <provider> [args...]");
      process.exit(1);
    }
    await executeProvider(args[1], args.slice(2));
    return;
  }

  // Direct provider shorthand: agent-mux agy [args...]
  try {
    getProviderAdapter(cmd);
    await executeProvider(cmd, args.slice(1));
  } catch {
    console.error(`Unknown command or provider: ${cmd}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[agent-mux error]", err.message);
  process.exit(1);
});

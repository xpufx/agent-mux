import { getProviderAdapter, listSupportedProviders } from "../providers/index.js";
import {
  getProviderStatus,
  listProfiles,
  listProfileInventory,
  addProfile,
  removeProfile,
  authenticateProfile,
  detectSandbox,
  SANDBOX_GUARD_MESSAGE,
  type ProfileInfo
} from "../core/profiles.js";
import { verifyCooldownWithProbe } from "../core/supervisor.js";
import { clearCooldown } from "../core/state.js";
import { spawn } from "node:child_process";
import { executeProvider, isBinaryWrapped } from "../core/runner.js";
import { parseArgs } from "../core/args.js";
import { AGENT_MUX_VERSION } from "../core/version.js";
import { findExecutableInPath } from "../providers/antigravity.js";

import {
  loadConfig,
  saveConfig,
  getSurfaceAccountMode,
  parseSurfaceAccountMode,
  getIsolationMode,
  getRoutingPolicy,
  parseRoutingPolicy,
  getConfigFilePath
} from "../core/config.js";
import { getAgentLogFilePath } from "../core/paths.js";
import fs from "node:fs";

async function printStatus(providerId?: string, options: { probe?: boolean } = {}) {
  const providers = providerId
    ? [getProviderAdapter(providerId)]
    : listSupportedProviders();

  const activeIso = getIsolationMode();
  console.log(`=== agent-mux Provider & Profile Status [Isolation Mode: ${activeIso}] ===`);

  for (const prov of providers) {
    console.log(`\nProvider: ${prov.displayName} (${prov.id})`);
    const profiles = await getProviderStatus(prov, options);

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
        // Probe-driven cooldown clearing (issue #74): only an explicit probe
        // confirming READY clears the lock; LIMIT re-records it.
        const res = await verifyCooldownWithProbe(prov, prof, pl);
        console.log(`[${res.state}: ${res.details}]`);
      }
    } else {
      console.log("  (Provider does not require server-side probing)");
    }
  }
}

async function handleWrappersCommand() {
  const providers = listSupportedProviders();
  console.log("=== agent-mux CLI Wrappers ===");
  for (const prov of providers) {
    const binName = prov.binaryName;
    const resolved = findExecutableInPath(binName);
    if (!resolved) {
      console.log(`  • ${binName.padEnd(10)} [NOT FOUND in PATH]`);
      continue;
    }
    const isWrapped = isBinaryWrapped(resolved);
    const target = prov.defaultBinaryPath;
    if (isWrapped) {
      console.log(`  • ${binName.padEnd(10)} \x1b[32m[WRAPPED]\x1b[0m   ${resolved} -> ${target}`);
    } else {
      console.log(`  • ${binName.padEnd(10)} \x1b[33m[UNWRAPPED]\x1b[0m ${resolved}`);
    }
  }
}

import {
  loadCooldowns,
  clearCooldownsMatching
} from "../core/state.js";
import { runSetup } from "../core/setup.js";

function printHelp() {
  console.log(`agent-mux - Multi-Account Multiplexer and Stream Supervisor

Usage:
  agent-mux status [provider] [--probe]       View quota and auth status (instant; --probe to check early reset)
  agent-mux probe <provider> [profile] [pool] Actively test live model/server access
  agent-mux models <provider> [--free]        List models available in CLI (optionally free only)
  agent-mux wrappers                          Inspect whether binaries on PATH are wrapped
  agent-mux profile list [provider]           List configured profiles with auth + directory state
  agent-mux profile add <name> [--provider <p>]    Scaffold a new account profile
  agent-mux profile auth <name> [--provider <p>]   Launch isolated login for a profile
  agent-mux profile remove <name> [--provider <p>] Delete a profile directory and config entry
  agent-mux cooldowns [list]                  View active cooldown locks and reset times
  agent-mux cooldowns clear [provider] [profile] [pool]  Clear cooldown locks (scoped)
  agent-mux setup [--dry-run]                 Configure profiles and wrappers (idempotent)
  agent-mux logs [--tail <n>] [-f]            View agent-mux routing and failover logs
  agent-mux config [list|get|set]             Manage global configuration
  agent-mux exec <provider> [options] [--] [args] Run provider binary with auto-routing
  agent-mux run <provider> [options] [args]   Alias for exec
  agent-mux <provider> [options] [args]       Shorthand for exec (e.g. agent-mux agy ...)

Providers:
  antigravity, agy                            Google Antigravity CLI
  opencode                                    OpenCode CLI
  pi                                          Pi coding agent CLI

Options:
  --profile <name>                            Explicitly select profile (overrides auto-routing)
  --round-robin, --rr                         Alternate healthy accounts sequentially
  --pool <name>                               Request a specific quota pool (e.g. free)
  --no-bwrap                                  Bypass bubblewrap isolation; run directly on host
  --help, -h                                  Show this help message

Examples:
  agent-mux status                            View all accounts and live quota limits
  agent-mux agy -p "echo hi"                  Auto-route to healthy account and run
  agent-mux agy --profile secondary           Run using a specific account profile
  agent-mux exec agy --profile p2 --no-bwrap -- -p "hi"  Explicit exec with native flags preserved
  agy --profile primary -p "inspect git"      Direct transparent wrapper invocation
  agent-mux profile list                      List all accounts and authenticating emails
  agent-mux setup                             Configure profiles and transparent wrappers
  agent-mux cooldowns                         View active rate-limit locks and countdowns

Environment Variables:
  AGENT_MUX_HOME                              Custom base dir (default: ~/.agent-mux)
  AGENT_MUX_SURFACE_ACCOUNT                   Stream notification mode (none, tool, message, both)
  AGENT_MUX_ROUTING_POLICY                    Failover order (pool-strict, pool-spillover, account-first)
  AGENT_MUX_PROFILE                           Force profile for execution
  AGY_TARGET_POOL                             Override pool (gemini or claude)
`);
}

const SETUP_PROVIDERS = new Set(["all", "antigravity", "agy", "opencode", "pi"]);

function normalizeSetupProvider(
  value?: string
): "all" | "antigravity" | "opencode" | "pi" | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "agy") return "antigravity";
  if (normalized === "all" || normalized === "antigravity" || normalized === "opencode" || normalized === "pi") {
    return normalized;
  }
  console.error(`Unknown setup provider '${value}'. Use one of: all, antigravity, opencode, pi.`);
  process.exit(1);
}

function guardHostProfileCommand(action: string): void {
  const detection = detectSandbox();
  if (!detection.sandboxed) return;
  console.error(`\x1b[31m[!] ${SANDBOX_GUARD_MESSAGE}\x1b[0m`);
  console.error(
    `    '${action}' cannot run here${detection.reason ? ` (${detection.reason})` : ""}.`
  );
  process.exit(1);
}

function parseProfileTarget(
  args: string[],
  action: string
): { provider: string; name: string } | null {
  let provider: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--provider" || arg === "-P") {
      provider = args[++i];
      continue;
    }
    if (arg.startsWith("--provider=")) {
      provider = arg.slice("--provider=".length);
      continue;
    }
    if (arg.startsWith("-")) continue;
    positionals.push(arg);
  }

  if (positionals.length >= 2) {
    return { provider: positionals[0], name: positionals[1] };
  }
  if (positionals.length === 1 && provider) {
    return { provider, name: positionals[0] };
  }

  console.error(
    `Usage: agent-mux profile ${action} <name> --provider <provider>\n` +
      `       agent-mux profile ${action} <provider> <name>`
  );
  return null;
}

function printProfileInventory(inventory: ProfileInfo[]): void {
  const byProvider = new Map<string, ProfileInfo[]>();
  for (const info of inventory) {
    const list = byProvider.get(info.provider) ?? [];
    list.push(info);
    byProvider.set(info.provider, list);
  }

  if (byProvider.size === 0) {
    console.log("  (No profiles configured)");
    return;
  }

  for (const [providerId, profiles] of byProvider) {
    console.log(`\nProvider: ${profiles[0].providerLabel} (${providerId})`);
    for (const info of profiles) {
      const status = !info.directoryExists
        ? "\x1b[31mmissing directory\x1b[0m"
        : info.authenticated
          ? "\x1b[32mAuthenticated\x1b[0m"
          : "\x1b[33mPending login\x1b[0m";
      const identity = info.accountIdentity ? ` \x1b[90m(${info.accountIdentity})\x1b[0m` : "";
      const registered = info.registered ? "" : " \x1b[90m[unregistered]\x1b[0m";
      console.log(
        `  • ${info.name.padEnd(16)} [${status}]${identity}${registered} -> ${info.directory}`
      );
    }
  }
}

async function handleProfileCommand(args: string[]) {
  const sub = args[0] || "list";

  if (sub === "--help" || sub === "-h" || sub === "help") {
    console.log(`Usage: agent-mux profile <action> [options]

Actions:
  list [provider]                        List configured account profiles
  add <name> [--provider <provider>]     Scaffold a new account profile
  auth <name> [--provider <provider>]    Launch isolated login for a profile
  remove <name> [--provider <provider>]  Delete a profile directory and config entry
                                         (aliases: rm, delete)

Legacy positional form: profile <action> <provider> <name>
`);
    return;
  }

  if (sub === "list") {
    const providerId = args.slice(1).find((a) => !a.startsWith("-"));
    const providers = providerId
      ? [getProviderAdapter(providerId)]
      : listSupportedProviders();

    const detection = detectSandbox();
    if (detection.sandboxed) {
      console.log(`\x1b[33m[!] ${SANDBOX_GUARD_MESSAGE}\x1b[0m`);
      console.log(
        `    Listing from a sandboxed session${detection.reason ? ` (${detection.reason})` : ""}; results may be incomplete.\n`
      );
    }

    const activeIso = getIsolationMode();
    console.log(`=== Configured Account Profiles [Isolation Mode: ${activeIso}] ===`);
    printProfileInventory(await listProfileInventory(providers));
    return;
  }

  if (sub === "add") {
    guardHostProfileCommand("profile add");
    const target = parseProfileTarget(args.slice(1), "add");
    if (!target) {
      process.exit(1);
    }
    const adapter = getProviderAdapter(target.provider);
    const result = addProfile(adapter, target.name);
    console.log(
      `\x1b[32m[+] Profile '${target.name}' ${result.created ? "scaffolded" : "already exists"} for ${adapter.displayName}.\x1b[0m`
    );
    console.log(`    Location: ${result.directory}`);
    console.log(`\nTo authenticate this profile, run:`);
    console.log(`    agent-mux profile auth ${target.name} --provider ${adapter.id}`);
    return;
  }

  if (sub === "auth") {
    guardHostProfileCommand("profile auth");
    const target = parseProfileTarget(args.slice(1), "auth");
    if (!target) {
      process.exit(1);
    }
    const adapter = getProviderAdapter(target.provider);

    console.log(
      `\x1b[36m[*] Launching isolated authentication for ${adapter.displayName} (profile: ${target.name})...\x1b[0m`
    );

    const code = await authenticateProfile(adapter, target.name);
    if (code === 0) {
      console.log(`\x1b[32m[✓] Authentication process completed for ${target.name}.\x1b[0m`);
    } else {
      console.log(`\x1b[33m[!] Authentication process exited with code ${code}.\x1b[0m`);
    }
    process.exit(code);
  }

  if (sub === "remove" || sub === "delete" || sub === "rm") {
    guardHostProfileCommand("profile remove");
    const target = parseProfileTarget(args.slice(1), "remove");
    if (!target) {
      process.exit(1);
    }
    const adapter = getProviderAdapter(target.provider);
    const removed = removeProfile(adapter, target.name);
    if (removed) {
      console.log(`\x1b[32m[✓] Profile '${target.name}' removed successfully from ${adapter.displayName}.\x1b[0m`);
    } else {
      console.log(`\x1b[33m[!] Profile '${target.name}' does not exist for ${adapter.displayName}.\x1b[0m`);
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
  clear [provider] [profile] [pool]             Clear cooldown locks (all, or scoped by provider/profile/pool)
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
    } else if (prov && prof) {
      const cleared = clearCooldownsMatching({ provider: prov, profile: prof });
      console.log(`\x1b[32m[✓] Cleared ${cleared} cooldown lock(s) for ${prov}:${prof} (all pools).\x1b[0m`);
    } else if (prov) {
      const cleared = clearCooldownsMatching({ provider: prov });
      console.log(`\x1b[32m[✓] Cleared ${cleared} cooldown lock(s) for provider ${prov}.\x1b[0m`);
    } else {
      const cleared = clearCooldownsMatching({});
      console.log(`\x1b[32m[✓] Cleared all active cooldown locks (${cleared} cleared).\x1b[0m`);
    }
    return;
  }

  console.error(`Unknown cooldowns action: ${sub}. Available actions: list, clear`);
  process.exit(1);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const parsedTop = parseArgs(rawArgs);
  const topFlags = {
    profile: parsedTop.profile,
    pool: parsedTop.pool,
    roundRobin: parsedTop.roundRobin,
    noBwrap: parsedTop.noBwrap
  };
  const args = parsedTop.cmdArgs;
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    process.exit(0);
  }

  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(`agent-mux v${AGENT_MUX_VERSION}`);
    process.exit(0);
  }

  if (cmd === "wrappers" || cmd === "wrapper") {
    await handleWrappersCommand();
    return;
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
      const activeRoutingPolicy = getRoutingPolicy();
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
        `Active routingPolicy:   ${activeRoutingPolicy}${
          process.env.AGENT_MUX_ROUTING_POLICY
            ? " (overridden by AGENT_MUX_ROUTING_POLICY env)"
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
      } else if (key === "routingPolicy" || key === "routing_policy") {
        console.log(getRoutingPolicy());
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
      } else if (key === "routingPolicy" || key === "routing_policy") {
        const parsed = parseRoutingPolicy(val);
        if (!parsed) {
          console.error(
            `Invalid routingPolicy: '${val}'. Valid options: pool-strict, pool-spillover, account-first`
          );
          process.exit(1);
        }
        cfg.routingPolicy = parsed;
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
    guardHostProfileCommand("setup");
    const dryRun = args.includes("--dry-run");
    const positionals: string[] = [];
    let provider: string | undefined;

    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--dry-run") continue;
      if (arg === "--provider" || arg === "-p") {
        provider = args[++i];
        continue;
      }
      if (arg.startsWith("--provider=")) {
        provider = arg.slice("--provider=".length);
        continue;
      }
      if (arg.startsWith("-")) continue;
      positionals.push(arg);
    }

    // First positional may be a provider keyword (legacy install.sh contract).
    if (!provider && positionals.length > 0 && SETUP_PROVIDERS.has(positionals[0].toLowerCase())) {
      provider = positionals.shift();
    }

    runSetup({
      dryRun,
      provider: normalizeSetupProvider(provider),
      accounts: positionals
    });
    return;
  }

  if (cmd === "status") {
    const probe = args.includes("--probe");
    const provId = args.slice(1).find((a) => !a.startsWith("-"));
    await printStatus(provId, { probe });
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

  if (cmd === "run" || cmd === "exec") {
    if (!args[1]) {
      console.error(`Usage: agent-mux ${cmd} <provider> [options] [--] [args...]`);
      process.exit(1);
    }
    // Strict POSIX -- separation: everything before -- belongs to agent-mux (already parsed),
    // everything after -- is passed verbatim to the target CLI.
    const providerArg = args[1];
    const targetArgs = args.slice(2);
    const code = await executeProvider(providerArg, targetArgs, process.env, topFlags);
    process.exit(code);
  }

  // Direct provider shorthand: agent-mux agy [args...]
  try {
    getProviderAdapter(cmd);
    const code = await executeProvider(cmd, args.slice(1), process.env, topFlags);
    process.exit(code);
  } catch {
    console.error(`Unknown command or provider: ${cmd}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[agent-mux error]", err.message);
  process.exit(1);
});

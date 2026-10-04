import { getProviderAdapter, listSupportedProviders } from "../providers/index.js";
import { getProviderStatus, listProfiles } from "../core/profiles.js";
import { selectProfile } from "../core/router.js";
import { runSupervisor } from "../core/supervisor.js";
import { spawn } from "node:child_process";

async function printStatus(providerId?: string) {
  const providers = providerId
    ? [getProviderAdapter(providerId)]
    : listSupportedProviders();

  console.log("=== agent-mux Provider & Profile Status ===");

  for (const prov of providers) {
    console.log(`\nProvider: ${prov.displayName} (${prov.id})`);
    const profiles = await getProviderStatus(prov);

    if (profiles.length === 0) {
      console.log(`  (No profiles configured at ${prov.profilesBaseDir})`);
      continue;
    }

    for (const p of profiles) {
      const authStr = p.authenticated ? "Authenticated" : "Pending login";
      console.log(`  • ${p.profile} [${authStr}]:`);
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
      const poolsToProbe = pool ? [pool] : ["gemini", "claude"];
      for (const pl of poolsToProbe) {
        process.stdout.write(`  [Probing ${prof} (${pl})]... `);
        const res = await prov.probe(prof, pl);
        console.log(`[${res.state}: ${res.details}]`);
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
    const child = spawn(adapter.defaultBinaryPath, cmdArgs, {
      stdio: "inherit",
      env: {
        ...process.env,
        HOME: profDir
      }
    });

    child.on("close", (code) => {
      process.exit(code ?? 0);
    });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(`agent-mux - Multi-Account Multiplexer and Stream Supervisor

Usage:
  agent-mux status [provider]               View live quota and auth status
  agent-mux probe [provider] [profile]      Actively test server status
  agent-mux run <provider> [options] [args] Run provider binary with auto-routing
  agent-mux <provider> [args]               Shorthand for run

Options:
  --profile <name>                          Explicitly select profile
  --round-robin, --rr                       Alternate accounts sequentially
  --help, -h                                Show this help message
`);
    process.exit(0);
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

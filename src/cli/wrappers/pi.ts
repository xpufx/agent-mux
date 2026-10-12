import { getProviderAdapter, PI_NON_PROMPT_SUBCOMMANDS } from "../../providers/index.js";
import { selectProfile, applyPoolModel } from "../../core/router.js";
import { runSupervisor } from "../../core/supervisor.js";
import { getIsolationMode } from "../../core/config.js";
import { spawn } from "node:child_process";

async function main() {
  const rawArgs = process.argv.slice(2);
  const adapter = getProviderAdapter("pi");

  // Bypass router if already in an isolated profile
  const home = process.env.HOME || "";
  if (home.includes("/.agent-mux/")) {
    const child = spawn(adapter.defaultBinaryPath, rawArgs, { stdio: "inherit" });
    child.on("close", (code) => process.exit(code ?? 0));
    return;
  }

  // Parse routing flags (--profile/--round-robin/--pool are wrapper flags,
  // never passed to the underlying CLI).
  let mode = "auto";
  let poolOverride: string | undefined;
  const cmdArgs: string[] = [];
  let isStreamJson = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--profile" && i + 1 < rawArgs.length) {
      mode = rawArgs[++i];
    } else if (arg === "--round-robin" || arg === "--rr") {
      mode = "round-robin";
    } else if (arg === "--pool" && i + 1 < rawArgs.length) {
      poolOverride = rawArgs[++i];
    } else {
      if (arg === "stream-json") isStreamJson = true;
      cmdArgs.push(arg);
    }
  }

  const subCmd = cmdArgs.find((a) => !a.startsWith("-"));
  const isSubcommand = subCmd !== undefined && PI_NON_PROMPT_SUBCOMMANDS.has(subCmd);

  const decision = await selectProfile(adapter, cmdArgs, process.env, mode, [], undefined, poolOverride);
  const execArgs = isSubcommand ? [...cmdArgs] : applyPoolModel(adapter, cmdArgs, decision.pool);

  if (isStreamJson) {
    const code = await runSupervisor({
      adapter,
      initialProfile: decision.profile,
      initialPool: decision.pool,
      poolOverride,
      binaryPath: adapter.defaultBinaryPath,
      args: cmdArgs
    });
    process.exit(code);
  } else {
    const profDir = `${adapter.profilesBaseDir}/${decision.profile}`;
    const isolationMode = getIsolationMode();
    let execTarget: { binary: string; args: string[]; env: NodeJS.ProcessEnv };

    if (adapter.prepareExecution) {
      execTarget = adapter.prepareExecution(decision.profile, execArgs, process.env, isolationMode);
    } else {
      execTarget = {
        binary: adapter.defaultBinaryPath,
        args: execArgs,
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

main().catch((err) => {
  console.error("[pi-mux error]", err.message);
  process.exit(1);
});

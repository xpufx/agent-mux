import { getProviderAdapter } from "../../providers/index.js";
import { selectProfile } from "../../core/router.js";
import { runSupervisor } from "../../core/supervisor.js";
import { spawn } from "node:child_process";

import { getIsolationMode } from "../../core/config.js";

async function main() {
  const rawArgs = process.argv.slice(2);
  const adapter = getProviderAdapter("opencode");

  // Bypass router if already in an isolated profile
  const home = process.env.HOME || "";
  if (home.includes("/.agent-mux/")) {
    const child = spawn(adapter.defaultBinaryPath, rawArgs, { stdio: "inherit" });
    child.on("close", (code) => process.exit(code ?? 0));
    return;
  }

  // Parse routing flags
  let mode = "auto";
  const cmdArgs: string[] = [];
  let isStream = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--profile" && i + 1 < rawArgs.length) {
      mode = rawArgs[++i];
    } else if (arg === "--round-robin" || arg === "--rr") {
      mode = "round-robin";
    } else {
      if (arg === "acp" || arg === "serve" || arg === "stream-json") isStream = true;
      cmdArgs.push(arg);
    }
  }

  const decision = await selectProfile(adapter, cmdArgs, process.env, mode);

  if (isStream) {
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

main().catch((err) => {
  console.error("[opencode-mux error]", err.message);
  process.exit(1);
});

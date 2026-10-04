import { getProviderAdapter } from "../../providers/index.js";
import { selectProfile } from "../../core/router.js";
import { runSupervisor } from "../../core/supervisor.js";
import { getIsolationMode } from "../../core/config.js";
import { spawn } from "node:child_process";

async function main() {
  const rawArgs = process.argv.slice(2);
  const adapter = getProviderAdapter("antigravity");

  // Handle Claude model filtering for Paseo / CLI
  if (rawArgs[0] === "models" && process.env.AGY_TARGET_POOL === "claude") {
    const claudeCatalog = [
      "claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)",
      "claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)",
      "claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)",
      "claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)",
      "claude-opus-5-5-high\tClaude Opus 5.5 (High)",
      "claude-opus-5-5-low\tClaude Opus 5.5 (Low)",
      "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)"
    ].join("\n");
    console.log(claudeCatalog);
    process.exit(0);
  }

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

main().catch((err) => {
  console.error("[agy-mux error]", err.message);
  process.exit(1);
});

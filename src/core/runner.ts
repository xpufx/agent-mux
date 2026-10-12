import { getProviderAdapter } from "../providers/index.js";
import { selectProfile, applyPoolModel } from "./router.js";
import { runSupervisor } from "./supervisor.js";
import { getIsolationMode } from "./config.js";
import { parseArgs, type MuxFlags } from "./args.js";
import type { ProviderAdapter } from "../types.js";
import { spawn } from "node:child_process";

export interface ExecutionOptions {
  adapter: ProviderAdapter;
  rawArgs: string[];
  env?: NodeJS.ProcessEnv;
  initialFlags?: MuxFlags;
}

/**
 * Shared execution core for both transparent wrappers (agy, opencode, pi)
 * and direct agent-mux CLI invocations (agent-mux run/exec/<provider>).
 *
 * Preserves 100% native CLI fidelity:
 *   - Only strips/handles explicit mux flags (--profile, --pool, --round-robin/--rr)
 *   - Passes all native arguments, subcommands, and flags through to the target binary
 *   - Leaves subcommands and info requests (--help, --version) free of injected model flags
 *   - Bypasses multiplexing recursion when running inside an isolated profile environment
 */
export async function executeProvider(
  providerIdOrAdapter: string | ProviderAdapter,
  rawArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
  initialFlags?: MuxFlags
): Promise<number> {
  const adapter =
    typeof providerIdOrAdapter === "string"
      ? getProviderAdapter(providerIdOrAdapter)
      : providerIdOrAdapter;

  // Bypass router if already executing within an isolated profile
  const home = env.HOME || "";
  const isAlreadyIsolated = Boolean(env.AGENT_MUX_ACTIVE_PROFILE || home.includes("/.agent-mux/"));
  if (isAlreadyIsolated) {
    return new Promise<number>((resolve) => {
      const child = spawn(adapter.defaultBinaryPath, rawArgs, {
        stdio: "inherit",
        env
      });
      child.on("close", (code) => resolve(code ?? 0));
    });
  }

  // Handle Claude model filtering catalog when requested for Antigravity
  if (adapter.id === "antigravity" && rawArgs[0] === "models" && env.AGY_TARGET_POOL === "claude") {
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
    return 0;
  }

  // Parse routing flags (--profile/--round-robin/--pool are mux flags,
  // never passed to the underlying CLI).
  const parsed = parseArgs(rawArgs, initialFlags);
  const mode = parsed.mode || env.AGENT_MUX_PROFILE || "auto";
  const poolOverride = parsed.pool || (adapter.id === "antigravity" ? env.AGY_TARGET_POOL : undefined);
  const cmdArgs = parsed.cmdArgs;

  const subCmd = cmdArgs.find((a) => !a.startsWith("-"));
  const isSubcommand = subCmd !== undefined && (adapter.isNonPromptSubcommand?.(subCmd) ?? false);
  const isInfoOnly =
    cmdArgs.includes("--help") ||
    cmdArgs.includes("-h") ||
    cmdArgs.includes("--version") ||
    cmdArgs.includes("-v");

  const decision = await selectProfile(adapter, cmdArgs, env, mode, [], undefined, poolOverride);
  const execArgs = isSubcommand || isInfoOnly
    ? [...cmdArgs]
    : applyPoolModel(adapter, cmdArgs, decision.pool);

  const isStream = adapter.isStreamCommand
    ? adapter.isStreamCommand(cmdArgs)
    : cmdArgs.includes("stream-json");

  if (isStream) {
    return await runSupervisor({
      adapter,
      initialProfile: decision.profile,
      initialPool: decision.pool,
      poolOverride,
      binaryPath: adapter.defaultBinaryPath,
      args: cmdArgs
    });
  }

  const profDir = `${adapter.profilesBaseDir}/${decision.profile}`;
  const isolationMode = getIsolationMode();
  let execTarget: { binary: string; args: string[]; env: NodeJS.ProcessEnv };

  if (adapter.prepareExecution) {
    execTarget = adapter.prepareExecution(decision.profile, execArgs, env, isolationMode);
  } else {
    execTarget = {
      binary: adapter.defaultBinaryPath,
      args: execArgs,
      env: {
        ...env,
        HOME: profDir
      }
    };
  }

  execTarget.env = {
    ...execTarget.env,
    AGENT_MUX_ACTIVE_PROFILE: decision.profile
  };

  return new Promise<number>((resolve) => {
    const child = spawn(execTarget.binary, execTarget.args, {
      stdio: "inherit",
      env: execTarget.env
    });

    child.on("close", (code) => {
      resolve(code ?? 0);
    });
  });
}

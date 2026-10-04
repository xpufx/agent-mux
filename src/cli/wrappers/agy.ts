import { getProviderAdapter } from "../../providers/index.js";
import { selectProfile } from "../../core/router.js";
import { runSupervisor } from "../../core/supervisor.js";
import { spawn } from "node:child_process";

async function main() {
  const args = process.argv.slice(2);
  const adapter = getProviderAdapter("antigravity");

  // Handle Claude model filtering for Paseo / CLI
  if (args[0] === "models" && process.env.AGY_TARGET_POOL === "claude") {
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
    const child = spawn(adapter.defaultBinaryPath, args, { stdio: "inherit" });
    child.on("close", (code) => process.exit(code ?? 0));
    return;
  }

  const isStreamJson = args.includes("stream-json");
  const decision = await selectProfile(adapter, args, process.env, "auto");

  if (isStreamJson) {
    const code = await runSupervisor({
      adapter,
      initialProfile: decision.profile,
      binaryPath: adapter.defaultBinaryPath,
      args
    });
    process.exit(code);
  } else {
    const profDir = `${adapter.profilesBaseDir}/${decision.profile}`;
    const child = spawn(adapter.defaultBinaryPath, args, {
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

main().catch((err) => {
  console.error("[agy-mux error]", err.message);
  process.exit(1);
});

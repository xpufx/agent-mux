import { getProviderAdapter } from "../../providers/index.js";
import { selectProfile } from "../../core/router.js";
import { runSupervisor } from "../../core/supervisor.js";
import { spawn } from "node:child_process";

async function main() {
  const args = process.argv.slice(2);
  const adapter = getProviderAdapter("opencode");

  // Bypass router if already in an isolated profile
  const home = process.env.HOME || "";
  if (home.includes("/.opencode-profiles/") || home.includes("/.agent-profiles/")) {
    const child = spawn(adapter.defaultBinaryPath, args, { stdio: "inherit" });
    child.on("close", (code) => process.exit(code ?? 0));
    return;
  }

  const isStream = args.includes("acp") || args.includes("serve") || args.includes("stream-json");
  const decision = await selectProfile(adapter, args, process.env, "auto");

  if (isStream) {
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
  console.error("[opencode-mux error]", err.message);
  process.exit(1);
});

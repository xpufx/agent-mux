import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ProviderAdapter, PoolQuota, QuotaState } from "../types.js";
import { getAgentProfilesDir, getRealHome } from "../core/paths.js";
import { isQuotaError } from "../core/supervisor.js";

/**
 * Auth/credential paths (relative to real $HOME) that must stay profile-scoped
 * in `scoped` isolation mode. Everything else under ~/.gemini (conversations,
 * config, caches) remains the real user's and is shared across profiles.
 */
export const AGY_SCOPED_AUTH_PATHS = [
  ".gemini/antigravity-cli/antigravity-oauth-token"
];

/**
 * Subcommands supported by agy that do not take prompt inference `--model` flags.
 */
export const AGY_NON_PROMPT_SUBCOMMANDS = new Set([
  "models",
  "agent",
  "agents",
  "changelog",
  "help",
  "install",
  "mcp",
  "mic-serve",
  "plugin",
  "plugins",
  "remote-control",
  "update"
]);

export const BWRAP_REQUIRED_MESSAGE =
  "[agent-mux] Error: 'bwrap' (bubblewrap) is required for isolation_mode 'scoped', " +
  "but was not found in PATH.\n" +
  "Please install bubblewrap using your system package manager:\n" +
  "  - Ubuntu / Debian: sudo apt install bubblewrap\n" +
  "  - Arch Linux:      sudo pacman -S bubblewrap\n" +
  "  - Fedora / RHEL:   sudo dnf install bubblewrap\n" +
  "Or configure agent-mux to use fallback mode:\n" +
  "  agent-mux config set isolation_mode home";

export function findExecutableInPath(
  name: string,
  pathEnv: string = process.env.PATH ?? ""
): string | undefined {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {}
  }
  return undefined;
}

/**
 * Build the bwrap argument list for scoped Antigravity execution. Only the
 * auth/credential files in {@link AGY_SCOPED_AUTH_PATHS} are bind-mounted from
 * the profile; the real `~/.gemini` tree stays visible for everything else.
 * Missing profile credentials are masked with an empty placeholder so a
 * not-yet-logged-in profile can never read another profile's token.
 */
export function buildScopedBwrapArgs(
  profileDir: string,
  realHome: string,
  binary: string,
  args: string[],
  options: { muxProfilesDir?: string } = {}
): string[] {
  const bwrapArgs = [
    "--dev-bind", "/", "/",
    "--tmpfs", "/run/user",
    "--unsetenv", "DBUS_SESSION_BUS_ADDRESS"
  ];
  for (const relPath of AGY_SCOPED_AUTH_PATHS) {
    const src = path.join(profileDir, relPath);
    const dest = path.join(realHome, relPath);
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(src)) fs.writeFileSync(src, "");
    bwrapArgs.push("--bind", src, dest);
  }
  const profilesDir = options.muxProfilesDir ?? path.join(realHome, ".agent-mux", "profiles");
  if (fs.existsSync(profilesDir)) {
    bwrapArgs.push("--tmpfs", profilesDir);
  }
  bwrapArgs.push(binary, ...args);
  return bwrapArgs;
}

function parseDurationSeconds(dStr: string): number {
  const hours = dStr.match(/(\d+)\s*h/);
  const mins = dStr.match(/(\d+)\s*m/);
  const secs = dStr.match(/(\d+)\s*s/);
  let total = 0;
  if (hours) total += parseInt(hours[1], 10) * 3600;
  if (mins) total += parseInt(mins[1], 10) * 60;
  if (secs) total += parseInt(secs[1], 10);
  return total;
}

export class AntigravityAdapter implements ProviderAdapter {
  id = "antigravity";
  displayName = "Google Antigravity";
  binaryName = "agy";

  get defaultBinaryPath(): string {
    const realHome = getRealHome();
    const candidate = path.join(realHome, ".local/bin/agy.bin");
    return fs.existsSync(candidate) ? candidate : "agy.bin";
  }

  get profilesBaseDir(): string {
    return getAgentProfilesDir(this.id);
  }

  resolveTargetPool(args: string[], env: NodeJS.ProcessEnv): string {
    if (env.AGY_TARGET_POOL === "claude") return "claude";
    if (env.AGY_TARGET_POOL === "gemini") return "gemini";
    let model = "";
    let prev = "";
    for (const a of args) {
      if (prev === "--model" || prev === "-m") {
        model = a;
        break;
      }
      prev = a;
    }

    if (!model) {
      // Check user/profile settings.json if available
      try {
        const settingsPath = path.join(getRealHome(), ".gemini/antigravity-cli/settings.json");
        if (fs.existsSync(settingsPath)) {
          const cfg = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
          if (cfg.model && typeof cfg.model === "string") {
            model = cfg.model;
          }
        }
      } catch {}
    }

    const m = model.toLowerCase();
    if (m.startsWith("claude") || m.startsWith("gpt")) {
      return "claude";
    }
    return "gemini";
  }

  getSharedPaths(): string[] {
    return [
      ".gemini/antigravity-cli/conversations",
      ".gemini/config"
    ];
  }

  getSupportedPools(): string[] {
    return ["gemini", "claude"];
  }

  getPoolModel(pool: string): string | undefined {
    if (pool === "claude") return "claude-sonnet-5-5-low";
    if (pool === "gemini") return "gemini-3.8-flash-low";
    return undefined;
  }

  prepareExecution(
    profile: string,
    args: string[],
    baseEnv: NodeJS.ProcessEnv,
    isolationMode: string
  ): { binary: string; args: string[]; env: NodeJS.ProcessEnv } {
    const profDir = path.join(this.profilesBaseDir, profile);
    const realHome = getRealHome();

    if (isolationMode === "scoped") {
      // In scoped mode: HOME and cwd remain the real user home. Only the
      // profile's auth/credential files are bind-mounted over the real ones via
      // bwrap, so concurrent profiles cannot read each other's login state
      // while ~/.gemini conversations/config stay shared.
      const bwrapBin = findExecutableInPath("bwrap", baseEnv.PATH ?? process.env.PATH);
      if (!bwrapBin) {
        throw new Error(BWRAP_REQUIRED_MESSAGE);
      }

      const cleanedEnv: NodeJS.ProcessEnv = {
        ...baseEnv,
        HOME: realHome,
        REAL_HOME: realHome
      };
      delete cleanedEnv.DBUS_SESSION_BUS_ADDRESS;

      const bwrapArgs = buildScopedBwrapArgs(
        profDir,
        realHome,
        this.defaultBinaryPath,
        args,
        { muxProfilesDir: path.dirname(this.profilesBaseDir) }
      );

      return {
        binary: bwrapBin,
        args: bwrapArgs,
        env: cleanedEnv
      };
    }

    // Default "home" mode: profile acts as independent HOME directory
    const cleanedEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      HOME: profDir,
      REAL_HOME: realHome
    };
    delete cleanedEnv.DBUS_SESSION_BUS_ADDRESS;

    return {
      binary: this.defaultBinaryPath,
      args,
      env: cleanedEnv
    };
  }

  async getAuthStatus(profile: string): Promise<boolean> {
    const tokenPath = path.join(
      this.profilesBaseDir,
      profile,
      ".gemini/antigravity-cli/antigravity-oauth-token"
    );
    try {
      return fs.statSync(tokenPath).size > 0;
    } catch {
      return false;
    }
  }

  async getAccountIdentity(profile: string): Promise<string | undefined> {
    const tokenPath = path.join(
      this.profilesBaseDir,
      profile,
      ".gemini/antigravity-cli/antigravity-oauth-token"
    );
    if (!fs.existsSync(tokenPath)) return undefined;

    try {
      const data = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
      const idToken = data.id_token;
      if (!idToken || typeof idToken !== "string") return undefined;

      const parts = idToken.split(".");
      if (parts.length >= 2) {
        const payloadJson = Buffer.from(parts[1], "base64url").toString("utf-8");
        const payload = JSON.parse(payloadJson);
        if (payload.email) {
          return payload.email;
        }
      }
    } catch {}

    return undefined;
  }

  async getQuotaStatus(profile: string): Promise<PoolQuota[]> {
    // Quota state is tracked deterministically via live turn supervision (429 frames)
    // and persisted cooldowns in ~/.agent-mux/state/cooldowns.json, eliminating disk log pollution.
    return [
      { pool: "gemini", state: "READY" },
      { pool: "claude", state: "READY" }
    ];
  }

  async probe(
    profile: string,
    pool: string
  ): Promise<{ state: QuotaState; details: string }> {
    const profDir = path.join(this.profilesBaseDir, profile);
    const model = pool === "claude" ? "claude-sonnet-5-5-low" : "gemini-3.8-flash-low";

    try {
      const child = spawnSync(
        this.defaultBinaryPath,
        [
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--dangerously-skip-permissions",
          "--model",
          model,
          "--effort",
          "low"
        ],
        {
          cwd: "/tmp",
          env: {
            ...process.env,
            HOME: profDir
          },
          input: JSON.stringify({ event: "user", message: { content: "ping" } }) + "\n",
          encoding: "utf-8",
          timeout: 20000,
          stdio: ["pipe", "pipe", "pipe"]
        }
      );

      if (child.error) {
        if ((child.error as any).code === "ETIMEDOUT") {
          return { state: "UNKNOWN", details: "Probe timed out (20s)" };
        }
        return { state: "UNKNOWN", details: child.error.message };
      }

      const combined = `${child.stdout || ""} ${child.stderr || ""}`;
      if (isQuotaError(combined)) {
        const m = combined.match(/Resets in [^\.]+/);
        return { state: "LIMIT", details: m ? m[0] : "Quota limit reached" };
      }

      // Check NDJSON output for result
      for (const line of (child.stdout || "").split("\n")) {
        if (!line.trim()) continue;
        try {
          const f = JSON.parse(line);
          if (f.event === "result") {
            if (f.result?.status === "SUCCESS") {
              return { state: "READY", details: "Confirmed ready" };
            }
            if (f.result?.status === "ERROR") {
              if (isQuotaError(f.result.error)) {
                return { state: "LIMIT", details: f.result.error };
              }
              return { state: "UNKNOWN", details: f.result.error };
            }
          }
        } catch {}
      }

      if (child.status === 0) {
        return { state: "READY", details: "Confirmed ready" };
      }

      return { state: "UNKNOWN", details: `Process exited with code ${child.status}` };
    } catch (err: any) {
      return { state: "UNKNOWN", details: err.message || "Probe failed" };
    }
  }

  async listModels(): Promise<string[]> {
    return [
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-3.8-flash-low",
      "claude-sonnet-4-6",
      "claude-sonnet-5-5-low",
      "claude-opus-4-6"
    ];
  }
}

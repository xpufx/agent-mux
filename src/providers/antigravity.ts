import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ProviderAdapter, PoolQuota, QuotaState } from "../types.js";
import { getAgentProfilesDir, getRealHome } from "../core/paths.js";
import { isQuotaError } from "../core/supervisor.js";

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
      // In scoped mode: HOME and cwd remain the real user home.
      // Use bwrap to overlay the profile's .gemini onto real ~/.gemini privately.
      const profGeminiDir = path.join(profDir, ".gemini");
      const realGeminiDir = path.join(realHome, ".gemini");
      fs.mkdirSync(profGeminiDir, { recursive: true });
      fs.mkdirSync(realGeminiDir, { recursive: true });

      const bwrapArgs = [
        "--dev-bind", "/", "/",
        "--bind", profGeminiDir, realGeminiDir,
        this.defaultBinaryPath,
        ...args
      ];

      return {
        binary: "bwrap",
        args: bwrapArgs,
        env: {
          ...baseEnv,
          HOME: realHome,
          REAL_HOME: realHome
        }
      };
    }

    // Default "home" mode: profile acts as independent HOME directory
    return {
      binary: this.defaultBinaryPath,
      args,
      env: {
        ...baseEnv,
        HOME: profDir,
        REAL_HOME: realHome
      }
    };
  }

  async getAuthStatus(profile: string): Promise<boolean> {
    const tokenPath = path.join(
      this.profilesBaseDir,
      profile,
      ".gemini/antigravity-cli/antigravity-oauth-token"
    );
    return fs.existsSync(tokenPath);
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

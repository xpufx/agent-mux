import fs from "node:fs";
import path from "node:path";
import type { ProviderAdapter, PoolQuota, QuotaState } from "../types.js";
import { getAgentProfilesDir } from "../core/paths.js";
import { isQuotaError } from "../core/supervisor.js";

export class OpenCodeAdapter implements ProviderAdapter {
  id = "opencode";
  displayName = "OpenCode";
  binaryName = "opencode";

  get defaultBinaryPath(): string {
    const candidates = [
      "/usr/bin/opencode",
      "/usr/local/bin/opencode",
      path.join(process.env.HOME || "", ".local/bin/opencode")
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return "opencode";
  }

  get profilesBaseDir(): string {
    return getAgentProfilesDir(this.id);
  }

  resolveTargetPool(args: string[], env: NodeJS.ProcessEnv): string {
    // OpenCode models are typically provider/model (e.g. unsloth/model, anthropic/claude, openai/gpt)
    let model = "";
    let prev = "";
    for (const a of args) {
      if (prev === "--model" || prev === "-m") {
        model = a;
        break;
      }
      prev = a;
    }
    if (model.includes("/")) {
      return model.split("/")[0];
    }
    return "default";
  }

  getSharedPaths(): string[] {
    return [
      ".local/share/opencode/repos",
      ".config/opencode"
    ];
  }

  async getAuthStatus(profile: string): Promise<boolean> {
    const authPath = path.join(
      this.profilesBaseDir,
      profile,
      ".local/share/opencode/auth.json"
    );
    if (!fs.existsSync(authPath)) return false;
    try {
      const data = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      return Array.isArray(data) ? data.length > 0 : Object.keys(data).length > 0;
    } catch {
      return false;
    }
  }

  async getQuotaStatus(profile: string): Promise<PoolQuota[]> {
    const logDir = path.join(
      this.profilesBaseDir,
      profile,
      ".local/share/opencode/log"
    );
    const pools: PoolQuota[] = [{ pool: "default", state: "READY" }];

    if (!fs.existsSync(logDir)) {
      return pools;
    }

    try {
      const logs = fs
        .readdirSync(logDir)
        .map((f) => path.join(logDir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

      const now = Date.now();
      for (const logFile of logs.slice(0, 5)) {
        const stats = fs.statSync(logFile);
        if (now - stats.mtimeMs > 3600 * 1000) continue;

        const content = fs.readFileSync(logFile, "utf-8");
        if (isQuotaError(content)) {
          pools[0] = {
            pool: "default",
            state: "LIMIT",
            details: "Recent rate limit in logs"
          };
          break;
        }
      }
    } catch {}

    return pools;
  }
}

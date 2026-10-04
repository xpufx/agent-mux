import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
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
    let model = "";
    let prev = "";
    for (const a of args) {
      if (prev === "--model" || prev === "-m") {
        model = a;
        break;
      }
      prev = a;
    }
    if (model.startsWith("claude") || model.startsWith("gpt")) {
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

  async getAuthStatus(profile: string): Promise<boolean> {
    const tokenPath = path.join(
      this.profilesBaseDir,
      profile,
      ".gemini/antigravity-cli/antigravity-oauth-token"
    );
    return fs.existsSync(tokenPath);
  }

  async getQuotaStatus(profile: string): Promise<PoolQuota[]> {
    const logDir = path.join(
      this.profilesBaseDir,
      profile,
      ".gemini/antigravity-cli/log"
    );
    const result: Record<string, PoolQuota> = {
      gemini: { pool: "gemini", state: "READY" },
      claude: { pool: "claude", state: "READY" }
    };

    if (!fs.existsSync(logDir)) {
      return Object.values(result);
    }

    let files: string[] = [];
    try {
      files = fs
        .readdirSync(logDir)
        .filter((f) => f.startsWith("cli-") && f.endsWith(".log"))
        .map((f) => path.join(logDir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    } catch {
      return Object.values(result);
    }

    const now = Date.now();
    for (const file of files.slice(0, 10)) {
      try {
        const stats = fs.statSync(file);
        if (now - stats.mtimeMs > 86400 * 1000) continue;

        const content = fs.readFileSync(file, "utf-8");
        const lines = content.split("\n");

        let currPool = "gemini";
        for (const line of lines) {
          const lower = line.toLowerCase();
          if (
            lower.includes("resolving model") ||
            lower.includes("propagating selected model")
          ) {
            if (lower.includes("claude") || lower.includes("gpt")) {
              currPool = "claude";
            } else if (lower.includes("gemini")) {
              currPool = "gemini";
            }
          }

          if (lower.includes("errorreport.go") && isQuotaError(line)) {
            const m = line.match(/Resets in ([^\.]+)/);
            if (m) {
              const durSec = parseDurationSeconds(m[1]);
              const resetAt = stats.mtimeMs + durSec * 1000;
              if (now < resetAt) {
                const rem = Math.floor((resetAt - now) / 1000);
                const h = Math.floor(rem / 3600);
                const min = Math.floor((rem % 3600) / 60);
                result[currPool] = {
                  pool: currPool,
                  state: "LIMIT",
                  remainingSeconds: rem,
                  details: `${h}h ${min}m remaining`
                };
              } else {
                result[currPool] = { pool: currPool, state: "READY" };
              }
            } else if (lower.includes("capacity exhausted")) {
              result[currPool] = {
                pool: currPool,
                state: "CAPACITY_SPIKE",
                details: "Transient capacity spike"
              };
            }
          }
        }
      } catch {}
    }

    return Object.values(result);
  }

  async probe(
    profile: string,
    pool: string
  ): Promise<{ state: QuotaState; details: string }> {
    const profDir = path.join(this.profilesBaseDir, profile);
    const model = pool === "claude" ? "claude-sonnet-5-5-low" : "gemini-3.8-flash-low";

    try {
      const out = execSync(
        `timeout 15 ${this.defaultBinaryPath} -p "echo ping" --model ${model} --effort low < /dev/null`,
        {
          cwd: "/tmp",
          env: {
            ...process.env,
            HOME: profDir
          },
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"]
        }
      );

      if (isQuotaError(out)) {
        const m = out.match(/Resets in [^\.]+/);
        return { state: "LIMIT", details: m ? m[0] : "Quota limit reached" };
      }
      return { state: "READY", details: "Confirmed ready" };
    } catch (err: any) {
      const combined = `${err.stdout || ""} ${err.stderr || ""}`;
      if (isQuotaError(combined)) {
        const m = combined.match(/Resets in [^\.]+/);
        return { state: "LIMIT", details: m ? m[0] : "Quota limit reached" };
      }
      return { state: "UNKNOWN", details: err.message || "Probe failed" };
    }
  }
}

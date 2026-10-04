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
    const latestEventTime: Record<string, number> = {
      gemini: 0,
      claude: 0
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
    for (const file of files.slice(0, 15)) {
      try {
        const stats = fs.statSync(file);
        if (now - stats.mtimeMs > 86400 * 1000) continue;

        const base = path.basename(file);
        const yearMatch = base.match(/^cli-(\d{4})/);
        const defaultYear = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();

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

          if (isQuotaError(line)) {
            // Parse exact timestamp from glog line header (e.g. E1004 11:55:39.446807)
            const tsMatch = line.match(/^[IWEF](\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
            let lineTimestamp = stats.mtimeMs;
            if (tsMatch) {
              const [, mo, da, hr, mi, se] = tsMatch;
              lineTimestamp = Date.UTC(
                defaultYear,
                parseInt(mo, 10) - 1,
                parseInt(da, 10),
                parseInt(hr, 10),
                parseInt(mi, 10),
                parseInt(se, 10)
              );
            }

            // Only consider if this event is newer than any previously seen for this pool
            if (lineTimestamp >= latestEventTime[currPool]) {
              latestEventTime[currPool] = lineTimestamp;

              const m = line.match(/Resets in ([^\.]+)/);
              if (m) {
                const durSec = parseDurationSeconds(m[1]);
                const resetAt = lineTimestamp + durSec * 1000;
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
}

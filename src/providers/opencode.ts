import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ProviderAdapter, PoolQuota, QuotaState } from "../types.js";
import { getAgentProfilesDir, getRealHome } from "../core/paths.js";
import { isQuotaError } from "../core/supervisor.js";
import { loadConfig } from "../core/config.js";
import {
  DEFAULT_POOL,
  FREE_POOL,
  innerProviderOf,
  loadDiscoveredInners,
  parseModelRequest,
  pickModelForPool,
  poolForModelRequest,
  saveDiscoveredInners
} from "../core/pools.js";

export class OpenCodeAdapter implements ProviderAdapter {
  id = "opencode";
  displayName = "OpenCode";
  binaryName = "opencode";

  get defaultBinaryPath(): string {
    const realHome = getRealHome();
    const candidates = [
      "/usr/bin/opencode",
      "/usr/local/bin/opencode",
      path.join(realHome, ".local/bin/opencode.bin")
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return "/usr/bin/opencode";
  }

  get profilesBaseDir(): string {
    return getAgentProfilesDir(this.id);
  }

  /** Inner providers seen in model catalogs (dynamic pool discovery). */
  private innerProviders = new Set<string>(loadDiscoveredInners("opencode"));
  /** Last fetched `provider/model` catalog for sync pool→model mapping. */
  private modelCache: string[] = [];

  private noteModels(models: string[]): void {
    this.modelCache = models;
    let changed = false;
    for (const m of models) {
      const inner = innerProviderOf(m);
      if (inner && !this.innerProviders.has(inner)) {
        this.innerProviders.add(inner);
        changed = true;
      }
    }
    if (changed) saveDiscoveredInners("opencode", [...this.innerProviders]);
  }

  resolveTargetPool(args: string[], env: NodeJS.ProcessEnv): string {
    // OpenCode models are typically provider/model (e.g. opencode-go/model,
    // unsloth-custom/model); free-suffixed models map to `{inner}-free`.
    return poolForModelRequest(parseModelRequest(args));
  }

  getSharedPaths(): string[] {
    return [
      ".local/share/opencode/repos",
      ".config/opencode"
    ];
  }

  getSupportedPools(): string[] {
    const inners = [...this.innerProviders].sort();
    return [
      DEFAULT_POOL,
      FREE_POOL,
      ...inners.flatMap((p) => [p, `${p}-free`])
    ];
  }

  async discoverPools(profile?: string): Promise<string[]> {
    this.noteModels(await this.listModels(profile));
    return this.getSupportedPools();
  }

  getPoolModel(pool: string): string | undefined {
    return (
      pickModelForPool(this.modelCache, pool) ??
      (pool === FREE_POOL ? "opencode/nemotron-3-ultra-free" : undefined)
    );
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
      // Redirect XDG_DATA_HOME and XDG_CONFIG_HOME to profile directories.
      const dataHome = path.join(profDir, ".local/share");
      const configHome = path.join(profDir, ".config");
      fs.mkdirSync(dataHome, { recursive: true });
      fs.mkdirSync(configHome, { recursive: true });

      return {
        binary: this.defaultBinaryPath,
        args,
        env: {
          ...baseEnv,
          HOME: realHome,
          REAL_HOME: realHome,
          XDG_DATA_HOME: dataHome,
          XDG_CONFIG_HOME: configHome
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

  async getAccountIdentity(profile: string): Promise<string | undefined> {
    const authPath = path.join(
      this.profilesBaseDir,
      profile,
      ".local/share/opencode/auth.json"
    );
    if (!fs.existsSync(authPath)) return undefined;

    try {
      const data = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      const items: string[] = [];

      for (const [providerName, cred] of Object.entries(data)) {
        if (!cred || typeof cred !== "object") continue;
        const c = cred as { key?: string; email?: string; user?: string; type?: string };
        if (c.email) {
          items.push(`${providerName}: ${c.email}`);
        } else if (c.key && typeof c.key === "string") {
          // Show key prefix/suffix fingerprint for distinguishing accounts
          const key = c.key;
          const masked = key.length > 14
            ? `${key.slice(0, 8)}...${key.slice(-4)}`
            : `${key.slice(0, 4)}...`;
          items.push(`${providerName} (${masked})`);
        } else {
          items.push(`${providerName}`);
        }
      }

      return items.length > 0 ? items.join(", ") : undefined;
    } catch {}

    return undefined;
  }

  async getQuotaStatus(profile: string): Promise<PoolQuota[]> {
    // Quota state is tracked deterministically via live turn supervision
    // and persisted cooldowns in ~/.agent-mux/state/cooldowns.json, eliminating disk log pollution.
    return this.getSupportedPools().map((pool) => ({ pool, state: "READY" as const }));
  }

  async listModels(profile = "primary"): Promise<string[]> {
    const profDir = path.join(this.profilesBaseDir, profile);
    const targetHome = fs.existsSync(profDir) ? profDir : getRealHome();

    try {
      const child = spawnSync(this.defaultBinaryPath, ["models"], {
        cwd: "/tmp",
        env: {
          ...process.env,
          HOME: targetHome
        },
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"]
      });

      if (child.stdout) {
        const models = child.stdout
          .split("\n")
          .map((m) => m.trim())
          .filter(Boolean);
        this.noteModels(models);
        return models;
      }
    } catch {}
    return [];
  }

  async probe(
    profile: string,
    pool: string
  ): Promise<{ state: QuotaState; details: string }> {
    const profDir = path.join(this.profilesBaseDir, profile);
    const hasAuth = await this.getAuthStatus(profile);
    if (!hasAuth) {
      return {
        state: "LIMIT",
        details: "Pending authentication (missing or empty auth.json)"
      };
    }

    const cfg = loadConfig();
    const probeModel = (cfg.opencode_probe_model as string) || process.env.OPENCODE_PROBE_MODEL;

    // If an explicit probe model is configured, execute a live 1-turn prompt test
    if (probeModel) {
      try {
        const child = spawnSync(
          this.defaultBinaryPath,
          ["run", "--pure", "--dir", "/tmp", "--format", "json", "-m", probeModel, "ping"],
          {
            cwd: "/tmp",
            env: {
              ...process.env,
              HOME: profDir
            },
            encoding: "utf-8",
            timeout: 25000,
            stdio: ["ignore", "pipe", "pipe"]
          }
        );

        const combined = `${child.stdout || ""} ${child.stderr || ""}`;
        if (child.status === 0) {
          // Check for successful text response
          const stdout = child.stdout || "";
          if (stdout.includes('"type":"text"') || stdout.includes('"type":"step_finish"')) {
            return { state: "READY", details: `Verified prompt on ${probeModel}` };
          }
        }

        if (isQuotaError(combined)) {
          return { state: "LIMIT", details: `Quota/credit limit on ${probeModel}` };
        }

        return {
          state: "LIMIT",
          details: child.stderr?.trim() || `Exit code ${child.status} on ${probeModel}`
        };
      } catch (err: any) {
        return { state: "UNKNOWN", details: err.message || `Probe failed on ${probeModel}` };
      }
    }

    // Default fast validation: check local auth credentials and CLI model catalog
    try {
      const child = spawnSync(this.defaultBinaryPath, ["models"], {
        cwd: "/tmp",
        env: {
          ...process.env,
          HOME: profDir
        },
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"]
      });

      if (child.status === 0 && child.stdout && child.stdout.trim().length > 0) {
        const models = child.stdout.split("\n").map((m) => m.trim()).filter(Boolean);
        this.noteModels(models);
        if (pool !== DEFAULT_POOL) {
          const match = pickModelForPool(models, pool);
          if (!match) {
            return { state: "LIMIT", details: `No models available for pool '${pool}'` };
          }
          if (pool === FREE_POOL) {
            const freeCount = models.filter((m) => pickModelForPool([m], pool) === m).length;
            return {
              state: "READY",
              details: `Authenticated (${freeCount} free models available; configure opencode_probe_model for inference probe)`
            };
          }
          return {
            state: "READY",
            details: `Authenticated (pool '${pool}' resolves to ${match}; configure opencode_probe_model for inference probe)`
          };
        }
        const modelCount = models.length;
        return {
          state: "READY",
          details: `Authenticated (${modelCount} CLI models available; configure opencode_probe_model for inference probe)`
        };
      }

      const combined = `${child.stdout || ""} ${child.stderr || ""}`;
      if (isQuotaError(combined)) {
        return { state: "LIMIT", details: "Rate limit detected" };
      }

      return {
        state: "UNKNOWN",
        details: child.stderr?.trim() || `Exit code ${child.status}`
      };
    } catch (err: any) {
      return { state: "UNKNOWN", details: err.message || "Probe failed" };
    }
  }

  isStreamCommand(args: string[]): boolean {
    return args.some((a) => a === "acp" || a === "serve" || a === "stream-json");
  }

  isNonPromptSubcommand(_subCmd: string): boolean {
    return false;
  }
}


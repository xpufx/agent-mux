import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ProviderAdapter, PoolQuota, QuotaState } from "../types.js";
import { getAgentProfilesDir, getRealHome } from "../core/paths.js";
import { isQuotaError } from "../core/supervisor.js";
import { BWRAP_REQUIRED_MESSAGE, findExecutableInPath } from "./antigravity.js";
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

/**
 * Subcommands supported by pi that do not take prompt inference `--model` flags.
 * Verified against `pi --help`. Note: model listing is the `--list-models`
 * flag, not a subcommand.
 */
export const PI_NON_PROMPT_SUBCOMMANDS = new Set([
  "install",
  "remove",
  "uninstall",
  "update",
  "list",
  "config",
  "auth",
  "mcp"
]);

/**
 * Auth/credential paths (relative to real $HOME) that must stay profile-scoped
 * in `scoped` isolation mode. Only the login credentials are bind-mounted from
 * the profile; sessions, settings, and caches stay shared.
 */
export const PI_SCOPED_AUTH_PATHS = [
  ".pi/agent/auth.json"
];

/**
 * Parse one `pi --list-models` table row into a `provider/model` id.
 * Rows look like `commandcode  deepseek/deepseek-v4-flash  1M  65.5K  yes  no`;
 * the header (`provider  model  context …`) and blank lines yield undefined.
 */
export function parsePiModelRow(line: string): string | undefined {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length < 2) return undefined;
  const [provider, model] = tokens;
  if (provider === "provider" || model === "model") return undefined;
  if (!provider || !model || model.includes("…")) return undefined;
  return `${provider}/${model}`;
}

function isMuxOwned(resolvedPath: string): boolean {
  return resolvedPath.includes("pi-mux") || resolvedPath.includes("agent-mux");
}

export class PiAdapter implements ProviderAdapter {
  id = "pi";
  displayName = "Pi";
  binaryName = "pi";
  // pi has no interactive login subcommand; `profile auth` verifies credentials.
  authArgs = ["auth", "check", "--provider", "commandcode"];

  get defaultBinaryPath(): string {
    const realHome = getRealHome();
    const candidates = [
      path.join(realHome, ".local/bin/pi.bin"),
      "/usr/local/bin/pi",
      "/usr/bin/pi"
    ];
    for (const c of candidates) {
      try {
        if (!fs.existsSync(c)) continue;
        if (isMuxOwned(fs.realpathSync(c))) continue;
        return c;
      } catch {}
    }
    // PATH lookup that follows symlinks but skips our own wrapper.
    const pathEnv = process.env.PATH ?? "";
    for (const dir of pathEnv.split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, "pi");
      try {
        if (!fs.existsSync(candidate)) continue;
        if (isMuxOwned(fs.realpathSync(candidate))) continue;
        return candidate;
      } catch {}
    }
    return "/usr/bin/pi";
  }

  get profilesBaseDir(): string {
    return getAgentProfilesDir(this.id);
  }

  /** Inner providers seen in model catalogs (dynamic pool discovery). */
  private innerProviders = new Set<string>(loadDiscoveredInners("pi"));
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
    if (changed) saveDiscoveredInners("pi", [...this.innerProviders]);
  }

  resolveTargetPool(args: string[], env: NodeJS.ProcessEnv): string {
    return poolForModelRequest(parseModelRequest(args));
  }

  getSharedPaths(): string[] {
    return [
      ".pi/agent/sessions",
      ".pi/agent/settings.json",
      ".pi/agent/npm",
      ".pi/agent/extensions"
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

  /**
   * Verified-working model ids, preferred over catalog-first picks (catalog
   * order leads with flagships the account may not be entitled to, and some
   * listed free slugs have gone stale upstream).
   */
  private preferredModel(pool: string): string | undefined {
    if (pool === FREE_POOL || pool === "commandcode-free") {
      return "commandcode/poolside/laguna-s-2.1-free";
    }
    if (pool === "commandcode") {
      return "commandcode/deepseek/deepseek-v4-flash";
    }
    return undefined;
  }

  getPoolModel(pool: string): string | undefined {
    const preferred = this.preferredModel(pool);
    if (preferred && (this.modelCache.length === 0 || this.modelCache.includes(preferred))) {
      return preferred;
    }
    return pickModelForPool(this.modelCache, pool) ?? preferred;
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
      // In scoped mode HOME stays the real home, so only the login credential
      // file is bind-mounted from the profile via bwrap (same pattern as agy).
      // pi resolves config via homedir() with no XDG override.
      const bwrapBin = findExecutableInPath("bwrap", baseEnv.PATH ?? process.env.PATH);
      if (!bwrapBin) {
        throw new Error(BWRAP_REQUIRED_MESSAGE);
      }

      const bwrapArgs = [
        "--dev-bind", "/", "/",
        "--tmpfs", "/run/user",
        "--unsetenv", "DBUS_SESSION_BUS_ADDRESS"
      ];
      for (const relPath of PI_SCOPED_AUTH_PATHS) {
        const src = path.join(profDir, relPath);
        const dest = path.join(realHome, relPath);
        fs.mkdirSync(path.dirname(src), { recursive: true });
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (!fs.existsSync(src)) fs.writeFileSync(src, "");
        bwrapArgs.push("--bind", src, dest);
      }
      const profilesDir = path.dirname(this.profilesBaseDir);
      if (fs.existsSync(profilesDir)) {
        bwrapArgs.push("--tmpfs", profilesDir);
      }
      bwrapArgs.push(this.defaultBinaryPath, ...args);

      const cleanedEnv: NodeJS.ProcessEnv = {
        ...baseEnv,
        HOME: realHome,
        REAL_HOME: realHome
      };
      delete cleanedEnv.DBUS_SESSION_BUS_ADDRESS;

      return {
        binary: bwrapBin,
        args: bwrapArgs,
        env: cleanedEnv
      };
    }

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

  private readAuth(profile: string): Record<string, any> | undefined {
    const authPath = path.join(
      this.profilesBaseDir,
      profile,
      ".pi/agent/auth.json"
    );
    if (!fs.existsSync(authPath)) return undefined;
    try {
      const data = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      if (!data || typeof data !== "object") return undefined;
      return data;
    } catch {
      return undefined;
    }
  }

  async getAuthStatus(profile: string): Promise<boolean> {
    const data = this.readAuth(profile);
    if (!data) return false;
    return Object.values(data).some(
      (cred) => cred && typeof cred === "object" && Boolean((cred as { key?: string }).key)
    );
  }

  async getAccountIdentity(profile: string): Promise<string | undefined> {
    const data = this.readAuth(profile);
    if (!data) return undefined;

    const items: string[] = [];
    for (const [providerName, cred] of Object.entries(data)) {
      if (!cred || typeof cred !== "object") continue;
      const key = (cred as { key?: string }).key;
      if (typeof key === "string" && key.length > 0) {
        const masked = key.length > 14
          ? `${key.slice(0, 8)}...${key.slice(-4)}`
          : `${key.slice(0, 4)}...`;
        items.push(`${providerName} (${masked})`);
      } else {
        items.push(providerName);
      }
    }

    return items.length > 0 ? items.join(", ") : undefined;
  }

  async getQuotaStatus(profile: string): Promise<PoolQuota[]> {
    // Live state comes from persisted cooldowns; every advertised pool
    // (including dynamically discovered inner providers) starts READY.
    return this.getSupportedPools().map((pool) => ({ pool, state: "READY" as const }));
  }

  async listModels(profile?: string): Promise<string[]> {
    const profDir = profile ? path.join(this.profilesBaseDir, profile) : getRealHome();
    const targetHome = fs.existsSync(profDir) ? profDir : getRealHome();

    try {
      const child = spawnSync(this.defaultBinaryPath, ["--list-models"], {
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
          .map((line) => parsePiModelRow(line))
          .filter((m): m is string => Boolean(m));
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

    // Pick a live model for the pool from the current catalog so inner
    // providers that appear/disappear don't need code changes.
    const catalog = await this.listModels(profile);
    const preferred = this.preferredModel(pool);
    const model = (preferred && (catalog.length === 0 || catalog.includes(preferred)))
      ? preferred
      : pickModelForPool(catalog, pool)
        ?? preferred
        ?? "commandcode/deepseek/deepseek-v4-flash";
    if (pool !== DEFAULT_POOL && pool !== FREE_POOL && !pickModelForPool(catalog, pool)) {
      return {
        state: "LIMIT",
        details: `No models available for pool '${pool}'`
      };
    }

    try {
      const child = spawnSync(
        this.defaultBinaryPath,
        ["--model", model, "-p", "ping"],
        {
          cwd: "/tmp",
          env: {
            ...process.env,
            HOME: profDir
          },
          encoding: "utf-8",
          // Free-tier models queue; 25s proved too tight in practice.
          timeout: 60000,
          stdio: ["ignore", "pipe", "pipe"]
        }
      );

      const combined = `${child.stdout || ""} ${child.stderr || ""}`;
      if (child.status === 0) {
        return { state: "READY", details: `Verified prompt on ${model}` };
      }

      // Timeouts (SIGTERM/SIGKILL from spawn timeout) are inconclusive, not
      // quota exhaustion — report UNKNOWN so no cooldown is recorded.
      if (child.status === 143 || child.status === 137 || child.status === 124) {
        return { state: "UNKNOWN", details: `Probe timed out on ${model}` };
      }

      if (isQuotaError(combined)) {
        return { state: "LIMIT", details: `Quota/credit limit on ${model}` };
      }

      return {
        state: "LIMIT",
        details: child.stderr?.trim() || `Exit code ${child.status} on ${model}`
      };
    } catch (err: any) {
      return { state: "UNKNOWN", details: err.message || `Probe failed on ${model}` };
    }
  }

  async listFreeModels(profile?: string): Promise<string[]> {
    const allModels = await this.listModels(profile);
    return allModels.filter((m) => m.endsWith(":free") || m.endsWith("-free"));
  }
}

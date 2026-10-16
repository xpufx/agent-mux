import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getRealHome, getAgentMuxHome } from "./paths.js";
import { checkCooldown, clearCooldown } from "./state.js";
import { recordCooldownFamily } from "./pools.js";
import { parseResetDurationSeconds } from "./cooldown.js";
import { loadConfig, saveConfig, getIsolationMode, type IsolationMode } from "./config.js";
import type { ProviderAdapter, ProfileStatus } from "../types.js";

export const STATUS_PROBE_CACHE_TTL_MS = 30_000;
const statusProbeCache = new Map<string, number>();

export function clearStatusProbeCache(): void {
  statusProbeCache.clear();
}

/**
 * Persisted profile registry entry. Directory presence under
 * `<agent-mux-home>/profiles/<provider>/<name>` remains authoritative for
 * routing; the registry lets `profile list` surface entries whose directory was
 * removed or never materialised.
 */
export interface ProfileRecord {
  provider: string;
  name: string;
  createdAt?: string;
}

export interface ProfileInfo {
  provider: string;
  providerLabel: string;
  name: string;
  directory: string;
  directoryExists: boolean;
  registered: boolean;
  authenticated: boolean;
  accountIdentity?: string;
}

export interface AddProfileResult {
  provider: string;
  name: string;
  directory: string;
  created: boolean;
}

export interface AuthInvocation {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export const SANDBOX_GUARD_MESSAGE =
  "Detected active sandboxed session; profile management must be run from the host environment.";

export interface SandboxDetection {
  sandboxed: boolean;
  reason?: string;
}

export interface SandboxDetectionOptions {
  env?: NodeJS.ProcessEnv;
  profilesDir?: string;
  mountInfoPath?: string;
  readFile?: (file: string) => string;
}

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateProfileName(name: string): void {
  if (!name || !PROFILE_NAME_PATTERN.test(name) || name === "." || name === "..") {
    throw new Error(
      `Invalid profile name '${name}'. Use letters, digits, dot, dash or underscore, starting with a letter or digit.`
    );
  }
}

function isProfileRecord(value: unknown): value is ProfileRecord {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.provider === "string" && typeof rec.name === "string";
}

/** Load the profile registry from the global config file. */
export function getRegisteredProfiles(provider?: string): ProfileRecord[] {
  const records = loadConfig().profiles;
  const list = Array.isArray(records) ? records.filter(isProfileRecord) : [];
  return provider ? list.filter((r) => r.provider === provider) : list;
}

function saveRegisteredProfiles(records: ProfileRecord[]): void {
  const config = loadConfig();
  config.profiles = records;
  saveConfig(config);
}

/** Add (or refresh) a profile registry entry. */
export function registerProfile(provider: string, name: string): ProfileRecord {
  const record: ProfileRecord = { provider, name, createdAt: new Date().toISOString() };
  const next = getRegisteredProfiles().filter(
    (r) => !(r.provider === provider && r.name === name)
  );
  next.push(record);
  saveRegisteredProfiles(next);
  return record;
}

/** Remove a profile registry entry. Returns whether an entry was present. */
export function unregisterProfile(provider: string, name: string): boolean {
  const records = getRegisteredProfiles();
  const next = records.filter((r) => !(r.provider === provider && r.name === name));
  if (next.length === records.length) return false;
  saveRegisteredProfiles(next);
  return true;
}

export function listProfiles(adapter: ProviderAdapter): string[] {
  const baseDir = adapter.profilesBaseDir;
  if (!fs.existsSync(baseDir)) return [];
  return fs.readdirSync(baseDir).filter((name) => {
    const fullPath = path.join(baseDir, name);
    try {
      return fs.statSync(fullPath).isDirectory();
    } catch {
      return false;
    }
  });
}

export function ensureProfile(adapter: ProviderAdapter, profile: string): string {
  validateProfileName(profile);
  const realHome = getRealHome();
  const profileDir = path.join(adapter.profilesBaseDir, profile);
  fs.mkdirSync(profileDir, { recursive: true });

  // Symlink shared provider storage if available
  const sharedPaths = adapter.getSharedPaths();
  for (const relPath of sharedPaths) {
    const src = path.join(realHome, relPath);
    const dest = path.join(profileDir, relPath);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest)) {
        try {
          fs.symlinkSync(src, dest);
        } catch {}
      }
    }
  }

  return profileDir;
}

/** Create a profile's directory tree and register it in the config. */
export function addProfile(adapter: ProviderAdapter, profile: string): AddProfileResult {
  validateProfileName(profile);
  const directory = path.join(adapter.profilesBaseDir, profile);
  const created = !fs.existsSync(directory);
  ensureProfile(adapter, profile);
  registerProfile(adapter.id, profile);
  return { provider: adapter.id, name: profile, directory, created };
}

/**
 * Remove a profile's directory tree and its config entry. Returns whether
 * anything (directory or registry entry) was removed.
 */
export function removeProfile(adapter: ProviderAdapter, profile: string): boolean {
  validateProfileName(profile);
  const profileDir = path.join(adapter.profilesBaseDir, profile);
  let removed = false;

  if (fs.existsSync(profileDir)) {
    fs.rmSync(profileDir, { recursive: true, force: true });
    removed = true;
  }
  if (unregisterProfile(adapter.id, profile)) removed = true;
  return removed;
}

/**
 * Build the isolated auth invocation for a profile. Reuses the provider's
 * execution preparation (scoped bwrap or independent HOME) so login writes
 * never touch the host credentials.
 */
export function buildAuthInvocation(
  adapter: ProviderAdapter,
  profile: string,
  env: NodeJS.ProcessEnv = process.env,
  isolationMode: IsolationMode = getIsolationMode()
): AuthInvocation {
  validateProfileName(profile);
  const authArgs = adapter.authArgs ?? ["auth"];
  if (adapter.prepareExecution) {
    return adapter.prepareExecution(profile, authArgs, env, isolationMode);
  }
  const profileDir = path.join(adapter.profilesBaseDir, profile);
  return {
    binary: adapter.defaultBinaryPath,
    args: [...authArgs],
    env: {
      ...env,
      HOME: profileDir,
      REAL_HOME: getRealHome(),
      AGENT_MUX_ACTIVE_PROFILE: profile
    }
  };
}

export interface AuthenticateProfileOptions {
  env?: NodeJS.ProcessEnv;
  isolationMode?: IsolationMode;
  spawnFn?: typeof spawn;
  onExit?: (code: number) => void;
}

/** Execute an isolated provider auth login for a profile. */
export function authenticateProfile(
  adapter: ProviderAdapter,
  profile: string,
  options: AuthenticateProfileOptions = {}
): Promise<number> {
  ensureProfile(adapter, profile);
  registerProfile(adapter.id, profile);
  const invocation = buildAuthInvocation(
    adapter,
    profile,
    options.env,
    options.isolationMode
  );
  const spawnFn = options.spawnFn ?? spawn;

  return new Promise<number>((resolve) => {
    const child = spawnFn(invocation.binary, invocation.args, {
      stdio: "inherit",
      env: invocation.env
    });
    child.on("close", (code: number | null) => {
      const exitCode = code ?? 0;
      options.onExit?.(exitCode);
      resolve(exitCode);
    });
  });
}

/**
 * Inventory every profile for the given providers, merging the config registry
 * with on-disk directories and resolving directory presence and auth status.
 */
export async function listProfileInventory(
  providers: ProviderAdapter[]
): Promise<ProfileInfo[]> {
  const inventory: ProfileInfo[] = [];

  for (const adapter of providers) {
    const onDisk = new Set(listProfiles(adapter));
    const registered = getRegisteredProfiles(adapter.id).map((r) => r.name);
    const names = [...new Set([...onDisk, ...registered])].sort();

    for (const name of names) {
      const directory = path.join(adapter.profilesBaseDir, name);
      const directoryExists = fs.existsSync(directory);
      let authenticated = false;
      let accountIdentity: string | undefined;

      if (directoryExists) {
        try {
          authenticated = await adapter.getAuthStatus(name);
        } catch {}
        if (adapter.getAccountIdentity) {
          try {
            accountIdentity = await adapter.getAccountIdentity(name);
          } catch {}
        }
      }

      inventory.push({
        provider: adapter.id,
        providerLabel: adapter.displayName,
        name,
        directory,
        directoryExists,
        registered: registered.includes(name),
        authenticated,
        accountIdentity
      });
    }
  }

  return inventory;
}

/**
 * Detect whether administrative commands are running inside a sandboxed session
 * whose profile tree is masked (agent-mux scoped bwrap mounts a tmpfs over the
 * profiles dir). Checks the active-profile marker and `/proc/self/mountinfo`.
 */
export function detectSandbox(options: SandboxDetectionOptions = {}): SandboxDetection {
  const env = options.env ?? process.env;
  const activeProfile = env.AGENT_MUX_ACTIVE_PROFILE;
  if (activeProfile) {
    return {
      sandboxed: true,
      reason: `AGENT_MUX_ACTIVE_PROFILE=${activeProfile}`
    };
  }

  const profilesDir = path.resolve(
    options.profilesDir ?? path.join(getAgentMuxHome(), "profiles")
  );
  const mountInfoPath = options.mountInfoPath ?? "/proc/self/mountinfo";
  const readFile = options.readFile ?? ((file: string) => fs.readFileSync(file, "utf-8"));

  let content: string;
  try {
    content = readFile(mountInfoPath);
  } catch {
    return { sandboxed: false };
  }

  for (const line of content.split("\n")) {
    const fields = line.trim().split(" ");
    if (fields.length < 7) continue;
    const separator = fields.indexOf("-");
    if (separator === -1 || separator + 1 >= fields.length) continue;
    const mountPoint = fields[4];
    const fsType = fields[separator + 1];
    if (fsType === "tmpfs" && path.resolve(mountPoint) === profilesDir) {
      return { sandboxed: true, reason: `tmpfs mounted over ${profilesDir}` };
    }
  }

  return { sandboxed: false };
}

/** Throw the standard guard error when running inside a sandboxed session. */
export function assertHostEnvironment(options: SandboxDetectionOptions = {}): void {
  const detection = detectSandbox(options);
  if (detection.sandboxed) {
    throw new Error(SANDBOX_GUARD_MESSAGE);
  }
}

export async function getProviderStatus(
  adapter: ProviderAdapter,
  options: { probe?: boolean } = {}
): Promise<ProfileStatus[]> {
  const profiles = listProfiles(adapter);
  const results: ProfileStatus[] = [];

  for (const prof of profiles) {
    const authenticated = await adapter.getAuthStatus(prof);
    const accountIdentity = adapter.getAccountIdentity
      ? await adapter.getAccountIdentity(prof)
      : undefined;
    const pools = await adapter.getQuotaStatus(prof);

    // Live probe is opt-in (e.g. status --probe) or opportunistic with a cache TTL (30s)
    // for cooling pools that have been in cooldown for at least PROBE_RECHECK_THRESHOLD_SEC (30s)
    // so status reflects live availability rather than stale timestamps.
    const shouldProbeAny = options.probe;
    if (adapter.probe) {
      for (const p of pools) {
        const cd = checkCooldown(adapter.id, prof, p.pool);
        if (!cd.cooling) continue;

        const now = Date.now();
        const recordedAt = cd.recordedAt ?? (cd.resetAt ? cd.resetAt - (cd.remainingSec ?? 0) * 1000 : now);
        const cooldownElapsedSec = (now - recordedAt) / 1000;
        const cacheKey = `${adapter.id}:${prof}:${p.pool}`;
        const lastProbe = statusProbeCache.get(cacheKey) ?? 0;
        const probeCacheExpired = (now - lastProbe >= STATUS_PROBE_CACHE_TTL_MS);
        const eligibleForProbe = shouldProbeAny || (cooldownElapsedSec >= 30 && probeCacheExpired);

        if (eligibleForProbe) {
          statusProbeCache.set(cacheKey, now);
          const probe = await adapter.probe(prof, p.pool);
          if (probe.state === "READY") {
            clearCooldown(adapter.id, prof, p.pool);
          } else if (probe.state === "LIMIT") {
            recordCooldownFamily(
              adapter.id,
              prof,
              p.pool,
              parseResetDurationSeconds(probe.details),
              probe.details
            );
          }
        }
      }
    }

    // Overlay active persistent cooldowns if present
    for (const p of pools) {
      const cd = checkCooldown(adapter.id, prof, p.pool);
      if (cd.cooling && cd.remainingSec !== undefined) {
        p.state = "LIMIT";
        p.remainingSeconds = cd.remainingSec;
        const h = Math.floor(cd.remainingSec / 3600);
        const min = Math.floor((cd.remainingSec % 3600) / 60);
        p.details = `${h}h ${min}m remaining`;
      }
    }

    results.push({
      profile: prof,
      authenticated,
      accountIdentity,
      pools
    });
  }

  return results;
}

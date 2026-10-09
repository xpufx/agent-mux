import fs from "node:fs";
import path from "node:path";
import { getRealHome, COMMON_DOTFILES } from "./paths.js";
import { checkCooldown, clearCooldown, recordCooldown } from "./state.js";
import { parseResetDurationSeconds } from "./cooldown.js";
import type { ProviderAdapter, ProfileStatus } from "../types.js";

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
  const realHome = getRealHome();
  const profileDir = path.join(adapter.profilesBaseDir, profile);
  fs.mkdirSync(profileDir, { recursive: true });

  // Symlink common developer dotfiles from real home
  for (const dot of COMMON_DOTFILES) {
    const src = path.join(realHome, dot);
    const dest = path.join(profileDir, dot);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      try {
        fs.symlinkSync(src, dest);
      } catch {}
    }
  }

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

export function removeProfile(adapter: ProviderAdapter, profile: string): boolean {
  const profileDir = path.join(adapter.profilesBaseDir, profile);
  if (!fs.existsSync(profileDir)) return false;

  // Cleanly remove the profile directory
  fs.rmSync(profileDir, { recursive: true, force: true });
  return true;
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

    // Live probe is opt-in (e.g. status --probe). By default status is instant (<10ms)
    // and relies on persisted cooldown timestamps which auto-clear upon expiry.
    if (options.probe && adapter.probe) {
      for (const p of pools) {
        if (!checkCooldown(adapter.id, prof, p.pool).cooling) continue;
        const probe = await adapter.probe(prof, p.pool);
        if (probe.state === "READY") {
          clearCooldown(adapter.id, prof, p.pool);
        } else if (probe.state === "LIMIT") {
          recordCooldown(
            adapter.id,
            prof,
            p.pool,
            parseResetDurationSeconds(probe.details),
            probe.details
          );
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

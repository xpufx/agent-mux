import fs from "node:fs";
import path from "node:path";
import { getRealHome, COMMON_DOTFILES } from "./paths.js";
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

export async function getProviderStatus(adapter: ProviderAdapter): Promise<ProfileStatus[]> {
  const profiles = listProfiles(adapter);
  const results: ProfileStatus[] = [];

  for (const prof of profiles) {
    const authenticated = await adapter.getAuthStatus(prof);
    const accountIdentity = adapter.getAccountIdentity
      ? await adapter.getAccountIdentity(prof)
      : undefined;
    const pools = await adapter.getQuotaStatus(prof);
    results.push({
      profile: prof,
      authenticated,
      accountIdentity,
      pools
    });
  }

  return results;
}

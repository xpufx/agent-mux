import fs from "node:fs";
import path from "node:path";
import { getAgentMuxHome } from "./paths.js";

export interface CooldownEntry {
  provider: string;
  profile: string;
  pool: string;
  resetAt: number;
  recordedAt: number;
  reason?: string;
}

export function getStateDir(): string {
  const dir = path.join(getAgentMuxHome(), "state");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getCooldownFilePath(): string {
  return path.join(getStateDir(), "cooldowns.json");
}

export function loadCooldowns(): Record<string, CooldownEntry> {
  const file = getCooldownFilePath();
  if (!fs.existsSync(file)) return {};

  try {
    const raw = fs.readFileSync(file, "utf-8");
    const data: Record<string, CooldownEntry> = JSON.parse(raw);
    const now = Date.now();
    const active: Record<string, CooldownEntry> = {};
    let changed = false;

    for (const [k, v] of Object.entries(data)) {
      if (v.resetAt > now) {
        active[k] = v;
      } else {
        changed = true;
      }
    }

    if (changed) {
      saveCooldowns(active);
    }
    return active;
  } catch {
    return {};
  }
}

export function saveCooldowns(cooldowns: Record<string, CooldownEntry>): void {
  const file = getCooldownFilePath();
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cooldowns, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

function makeCooldownKey(provider: string, profile: string, pool: string): string {
  return `${provider}:${profile}:${pool}`;
}

export function recordCooldown(
  provider: string,
  profile: string,
  pool: string,
  durationSec: number,
  reason?: string
): CooldownEntry {
  const cooldowns = loadCooldowns();
  const key = makeCooldownKey(provider, profile, pool);
  const now = Date.now();
  const resetAt = now + Math.max(durationSec, 60) * 1000;

  const entry: CooldownEntry = {
    provider,
    profile,
    pool,
    resetAt,
    recordedAt: now,
    reason
  };

  cooldowns[key] = entry;
  saveCooldowns(cooldowns);
  return entry;
}

export function clearCooldown(provider: string, profile: string, pool: string): void {
  const cooldowns = loadCooldowns();
  const key = makeCooldownKey(provider, profile, pool);
  if (cooldowns[key]) {
    delete cooldowns[key];
    saveCooldowns(cooldowns);
  }
}

export function checkCooldown(
  provider: string,
  profile: string,
  pool: string
): { cooling: boolean; remainingSec?: number; resetAt?: number; reason?: string } {
  const cooldowns = loadCooldowns();
  const key = makeCooldownKey(provider, profile, pool);
  const entry = cooldowns[key];
  if (!entry) return { cooling: false };

  const now = Date.now();
  if (entry.resetAt <= now) {
    clearCooldown(provider, profile, pool);
    return { cooling: false };
  }

  const remainingSec = Math.floor((entry.resetAt - now) / 1000);
  return {
    cooling: true,
    remainingSec,
    resetAt: entry.resetAt,
    reason: entry.reason
  };
}

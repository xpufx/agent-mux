import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ProviderAdapter, RoutingDecision } from "../types.js";
import { listProfiles } from "./profiles.js";
import { getAgentMuxHome } from "./paths.js";
import { checkCooldown, logMuxMessage } from "./state.js";

export interface CandidateStatus {
  profile: string;
  isHealthy: boolean;
  remainingSec: number;
  reason: string;
}

export async function selectProfile(
  adapter: ProviderAdapter,
  args: string[],
  env: NodeJS.ProcessEnv,
  mode: "auto" | "round-robin" | string = "auto",
  excludeProfiles: string[] = []
): Promise<RoutingDecision & { allCooldown?: boolean }> {
  const targetPool = adapter.resolveTargetPool(args, env);
  const allProfiles = listProfiles(adapter);
  const profiles = allProfiles.filter((p) => !excludeProfiles.includes(p));

  if (profiles.length === 0) {
    if (allProfiles.length === 0) {
      throw new Error(
        `No profiles found for provider '${adapter.id}' at ${adapter.profilesBaseDir}`
      );
    }
    return {
      profile: allProfiles[0],
      targetPool,
      reason: "All profiles excluded; fallback to primary",
      allCooldown: true
    };
  }

  // 1. Explicit profile request
  if (mode !== "auto" && mode !== "round-robin" && mode !== "rr") {
    if (profiles.includes(mode)) {
      return { profile: mode, targetPool, reason: "Explicit selection" };
    }
  }

  const envProfile = env.AGENT_MUX_PROFILE;
  if (envProfile && profiles.includes(envProfile)) {
    return { profile: envProfile, targetPool, reason: "Environment override" };
  }

  // 2. Evaluate quota and cooldown for all candidate profiles
  const candidates: CandidateStatus[] = [];

  for (const prof of profiles) {
    // Check persisted cooldown first
    const cd = checkCooldown(adapter.id, prof, targetPool);
    if (cd.cooling) {
      candidates.push({
        profile: prof,
        isHealthy: false,
        remainingSec: cd.remainingSec ?? 3600,
        reason: `Active cooldown (${cd.remainingSec}s remaining)`
      });
      continue;
    }

    // Check live provider quota status
    const quotas = await adapter.getQuotaStatus(prof);
    const poolQuota = quotas.find((q) => q.pool === targetPool);

    if (poolQuota) {
      if (poolQuota.state === "READY") {
        candidates.push({
          profile: prof,
          isHealthy: true,
          remainingSec: 0,
          reason: `Healthy quota in pool '${targetPool}'`
        });
      } else {
        const rem = poolQuota.remainingSeconds ?? 3600;
        candidates.push({
          profile: prof,
          isHealthy: false,
          remainingSec: rem,
          reason: `Quota ${poolQuota.state} (${poolQuota.details || `${rem}s remaining`})`
        });
      }
    } else {
      candidates.push({
        profile: prof,
        isHealthy: true,
        remainingSec: 0,
        reason: "No quota limits reported"
      });
    }
  }

  const healthy = candidates.filter((c) => c.isHealthy);

  // 3. Healthy candidates available
  if (healthy.length > 0) {
    if (mode === "round-robin" || mode === "rr") {
      const muxHome = getAgentMuxHome();
      fs.mkdirSync(muxHome, { recursive: true });
      const rrFile = path.join(muxHome, `.rr_${adapter.id}_${targetPool}`);
      let idx = 0;
      try {
        if (fs.existsSync(rrFile)) {
          idx = parseInt(fs.readFileSync(rrFile, "utf-8").trim(), 10) || 0;
        }
      } catch {}
      const chosen = healthy[idx % healthy.length];
      try {
        fs.writeFileSync(rrFile, String((idx + 1) % healthy.length));
      } catch {}
      const decision = {
        profile: chosen.profile,
        targetPool,
        reason: `Round-robin rotation (${chosen.profile})`
      };
      logMuxMessage("ROUTER", `Selected ${decision.profile} for pool ${targetPool} (${decision.reason})`);
      return decision;
    }

    const decision = {
      profile: healthy[0].profile,
      targetPool,
      reason: healthy[0].reason
    };
    logMuxMessage("ROUTER", `Selected ${decision.profile} for pool ${targetPool} (${decision.reason})`);
    return decision;
  }

  // 4. All candidate profiles are in cooldown/limit
  candidates.sort((a, b) => a.remainingSec - b.remainingSec);
  const bestCandidate = candidates[0];

  const decision = {
    profile: bestCandidate.profile,
    targetPool,
    reason: `All profiles in cooldown; selected shortest wait (${bestCandidate.remainingSec}s on ${bestCandidate.profile})`,
    allCooldown: true
  };
  logMuxMessage("ROUTER", `Fallback selection (ALL COOLDOWN): ${decision.profile} for pool ${targetPool} (${decision.reason})`);
  return decision;
}

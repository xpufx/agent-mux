import fs from "node:fs";
import path from "node:path";
import type { ProviderAdapter, PoolQuota, RoutingDecision } from "../types.js";
import { listProfiles } from "./profiles.js";
import { getAgentMuxHome } from "./paths.js";
import { checkCooldown, clearCooldown, logMuxMessage } from "./state.js";
import { recordCooldownFamily } from "./pools.js";
import { parseResetDurationSeconds } from "./cooldown.js";
import { getRoutingPolicy, type RoutingPolicy } from "./config.js";

/** Minimum elapsed seconds since a cooldown was recorded before opportunistically probing again */
export const PROBE_RECHECK_THRESHOLD_SEC = 30;

export interface CandidateStatus {
  profile: string;
  pool: string;
  isHealthy: boolean;
  remainingSec: number;
  reason: string;
}

export function candidateKey(profile: string, pool: string): string {
  return `${profile}:${pool}`;
}

/**
 * Build the ordered `(profile, pool)` candidates for a routing policy.
 * - `pool-strict`:   targetPool across all profiles.
 * - `pool-spillover`: targetPool across all profiles, then each other pool across all profiles.
 * - `account-first`:  for each profile, targetPool then each other pool.
 */
export function buildCandidateOrder(
  profiles: string[],
  targetPool: string,
  otherPools: string[],
  policy: RoutingPolicy
): Array<{ profile: string; pool: string }> {
  const pools = [targetPool, ...otherPools];
  const order: Array<{ profile: string; pool: string }> = [];

  if (policy === "pool-spillover") {
    for (const pool of pools) {
      for (const profile of profiles) order.push({ profile, pool });
    }
  } else if (policy === "account-first") {
    for (const profile of profiles) {
      for (const pool of pools) order.push({ profile, pool });
    }
  } else {
    for (const profile of profiles) order.push({ profile, pool: targetPool });
  }

  return order;
}

export function replaceModelArg(args: string[], model: string): string[] {
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "--model" || out[i] === "-m") {
      if (i + 1 < out.length) out[i + 1] = model;
      else out.push(model);
      return out;
    }
    if (out[i].startsWith("--model=")) {
      out[i] = `--model=${model}`;
      return out;
    }
  }
  out.push("--model", model);
  return out;
}

/** True when CLI args already carry an explicit `--model` / `-m` request. */
export function hasExplicitModelArg(args: string[]): boolean {
  for (const a of args) {
    if (a === "--model" || a === "-m" || a.startsWith("--model=")) return true;
  }
  return false;
}

/**
 * Rewrite the model argument when a policy selects a pool different from the requested one.
 *
 * An explicitly supplied `--model` is preserved when no pool change is required
 * (selected pool matches the requested/target pool): clobbering it with the
 * pool default would discard the caller's exact model choice. A pool change
 * (spillover/failover) still rewrites the model to the new pool's default.
 */
export function applyPoolModel(
  adapter: ProviderAdapter,
  args: string[],
  pool: string,
  targetPool?: string
): string[] {
  if (hasExplicitModelArg(args) && (targetPool === undefined || pool === targetPool)) {
    return [...args];
  }
  const model = adapter.getPoolModel?.(pool);
  if (!model) return [...args];
  return replaceModelArg(args, model);
}

export async function selectProfile(
  adapter: ProviderAdapter,
  args: string[],
  env: NodeJS.ProcessEnv,
  mode: "auto" | "round-robin" | string = "auto",
  excludeCandidates: string[] = [],
  policy: RoutingPolicy = getRoutingPolicy(),
  poolOverride?: string,
  /** When provided, the caller owns the selection log (e.g. to dedupe it). */
  onSelect?: (decision: RoutingDecision) => void
): Promise<RoutingDecision & { allCooldown?: boolean }> {
  const inferredPool = adapter.resolveTargetPool(args, env);
  if (poolOverride !== undefined) {
    let supported = adapter.getSupportedPools?.() ?? [];
    if (!supported.includes(poolOverride) && adapter.discoverPools) {
      // Cold cache: discover dynamic (inner-provider) pools on demand.
      supported = await adapter.discoverPools();
    }
    if (!supported.includes(poolOverride)) {
      throw new Error(
        `Unknown pool '${poolOverride}' for provider '${adapter.id}'. Available pools: ${supported.join(", ")}`
      );
    }
  }
  const targetPool = poolOverride ?? inferredPool;
  const allProfiles = listProfiles(adapter);

  if (allProfiles.length === 0) {
    throw new Error(
      `No profiles found for provider '${adapter.id}' at ${adapter.profilesBaseDir}`
    );
  }

  // 1. Explicit profile request / environment override bypass the policy ordering.
  if (mode !== "auto" && mode !== "round-robin" && mode !== "rr") {
    if (allProfiles.includes(mode)) {
      return { profile: mode, targetPool, pool: targetPool, reason: "Explicit selection" };
    }
  }

  const envProfile = env.AGENT_MUX_PROFILE;
  if (envProfile && allProfiles.includes(envProfile)) {
    return { profile: envProfile, targetPool, pool: targetPool, reason: "Environment override" };
  }

  // 2. Build the policy-ordered candidate matrix and evaluate each `(profile, pool)`.
  const otherPools = (adapter.getSupportedPools?.() ?? []).filter((p) => p !== targetPool);
  const order = buildCandidateOrder(allProfiles, targetPool, otherPools, policy);
  const excluded = new Set(excludeCandidates);
  const quotaCache = new Map<string, PoolQuota[]>();
  const candidates: CandidateStatus[] = [];

  for (const { profile: prof, pool } of order) {
    if (excluded.has(candidateKey(prof, pool))) continue;

    // Persisted cooldowns gate selection: provider:profile:pool.
    const cd = checkCooldown(adapter.id, prof, pool);
    if (cd.cooling) {
      // Opportunistic Probe: if adapter supports probe and cooldown is eligible for re-check, probe it.
      const now = Date.now();
      const recordedAt = cd.recordedAt ?? (cd.resetAt ? cd.resetAt - (cd.remainingSec ?? 0) * 1000 : 0);
      const elapsedSec = (now - recordedAt) / 1000;
      let recovered = false;

      if (adapter.probe && elapsedSec >= PROBE_RECHECK_THRESHOLD_SEC) {
        try {
          const probeRes = await adapter.probe(prof, pool);
          if (probeRes.state === "READY") {
            clearCooldown(adapter.id, prof, pool);
            recovered = true;
            logMuxMessage(
              "ROUTER",
              `Opportunistic probe recovered cooled candidate ${prof}/${pool}: READY (cleared cooldown)`
            );
          } else if (probeRes.state === "LIMIT") {
            recordCooldownFamily(
              adapter.id,
              prof,
              pool,
              parseResetDurationSeconds(probeRes.details),
              probeRes.details
            );
          }
        } catch {}
      }

      if (!recovered) {
        candidates.push({
          profile: prof,
          pool,
          isHealthy: false,
          remainingSec: cd.remainingSec ?? 3600,
          reason: `Active cooldown (${cd.remainingSec}s remaining)`
        });
        continue;
      }
    }

    let quotas = quotaCache.get(prof);
    if (!quotas) {
      quotas = await adapter.getQuotaStatus(prof);
      quotaCache.set(prof, quotas);
    }
    const poolQuota = quotas.find((q) => q.pool === pool);

    if (!poolQuota) {
      candidates.push({
        profile: prof,
        pool,
        isHealthy: true,
        remainingSec: 0,
        reason: "No quota limits reported"
      });
    } else if (poolQuota.state === "READY") {
      candidates.push({
        profile: prof,
        pool,
        isHealthy: true,
        remainingSec: 0,
        reason: `Healthy quota in pool '${pool}'`
      });
    } else {
      const rem = poolQuota.remainingSeconds ?? 3600;
      candidates.push({
        profile: prof,
        pool,
        isHealthy: false,
        remainingSec: rem,
        reason: `Quota ${poolQuota.state} (${poolQuota.details || `${rem}s remaining`})`
      });
    }
  }

  const healthy = candidates.filter((c) => c.isHealthy);

  // 3. Healthy candidates available: pick the first in policy order.
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
        pool: chosen.pool,
        reason: `Round-robin rotation (${chosen.profile}/${chosen.pool})`
      };
      if (onSelect) onSelect(decision);
      else
        logMuxMessage(
          "ROUTER",
          `Selected ${decision.profile}/${decision.pool} for pool ${targetPool} [${policy}] (${decision.reason})`
        );
      return decision;
    }

    const chosen = healthy[0];
    const decision = {
      profile: chosen.profile,
      targetPool,
      pool: chosen.pool,
      reason: chosen.reason
    };
    if (onSelect) onSelect(decision);
    else
      logMuxMessage(
        "ROUTER",
        `Selected ${decision.profile}/${decision.pool} for pool ${targetPool} [${policy}] (${decision.reason})`
      );
    return decision;
  }

  // 4. Every candidate in the configured order is tried, cooled, or excluded: HALT.
  if (candidates.length === 0) {
    return {
      profile: allProfiles[0],
      targetPool,
      pool: targetPool,
      reason: `All candidates already tried (policy: ${policy})`,
      allCooldown: true
    };
  }

  candidates.sort((a, b) => a.remainingSec - b.remainingSec);
  const bestCandidate = candidates[0];

  // All-Cooldown Fallback Probe: before selecting shortest wait candidate, probe it if adapter.probe exists
  if (adapter.probe) {
    try {
      const probeRes = await adapter.probe(bestCandidate.profile, bestCandidate.pool);
      if (probeRes.state === "READY") {
        clearCooldown(adapter.id, bestCandidate.profile, bestCandidate.pool);
        logMuxMessage(
          "ROUTER",
          `All-cooldown probe recovered shortest wait candidate ${bestCandidate.profile}/${bestCandidate.pool}: READY`
        );
        const recoveredDecision = {
          profile: bestCandidate.profile,
          targetPool,
          pool: bestCandidate.pool,
          reason: `Recovered via all-cooldown fallback probe (READY)`
        };
        if (onSelect) onSelect(recoveredDecision);
        else
          logMuxMessage(
            "ROUTER",
            `Selected ${recoveredDecision.profile}/${recoveredDecision.pool} for pool ${targetPool} [${policy}] (${recoveredDecision.reason})`
          );
        return recoveredDecision;
      } else if (probeRes.state === "LIMIT") {
        recordCooldownFamily(
          adapter.id,
          bestCandidate.profile,
          bestCandidate.pool,
          parseResetDurationSeconds(probeRes.details),
          probeRes.details
        );
      }
    } catch {}
  }

  const decision = {
    profile: bestCandidate.profile,
    targetPool,
    pool: bestCandidate.pool,
    reason: `All candidates in cooldown; selected shortest wait (${bestCandidate.remainingSec}s on ${bestCandidate.profile}/${bestCandidate.pool})`,
    allCooldown: true
  };
  if (onSelect) onSelect(decision);
  else
    logMuxMessage(
      "ROUTER",
      `Fallback selection (ALL COOLDOWN) [${policy}]: ${decision.profile}/${decision.pool} (${decision.reason})`
    );
  return decision;
}

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ProviderAdapter, RoutingDecision } from "../types.js";
import { listProfiles } from "./profiles.js";

export async function selectProfile(
  adapter: ProviderAdapter,
  args: string[],
  env: NodeJS.ProcessEnv,
  mode: "auto" | "round-robin" | string = "auto"
): Promise<RoutingDecision> {
  const targetPool = adapter.resolveTargetPool(args, env);
  const profiles = listProfiles(adapter);

  if (profiles.length === 0) {
    throw new Error(`No profiles found for provider '${adapter.id}' at ${adapter.profilesBaseDir}`);
  }

  // 1. Explicit profile request
  if (mode !== "auto" && mode !== "round-robin" && mode !== "rr") {
    if (profiles.includes(mode)) {
      return { profile: mode, targetPool, reason: "Explicit selection" };
    }
  }

  const envProfile = env.AGENT_MUX_PROFILE || (adapter.id === "antigravity" ? env.AGY_PROFILE : undefined);
  if (envProfile && profiles.includes(envProfile)) {
    return { profile: envProfile, targetPool, reason: "Environment override" };
  }

  // 2. Round-Robin mode
  if (mode === "round-robin" || mode === "rr") {
    const rrFile = path.join(os.tmpdir(), `agent_mux_rr_${adapter.id}`);
    let idx = 0;
    try {
      if (fs.existsSync(rrFile)) {
        idx = parseInt(fs.readFileSync(rrFile, "utf-8").trim(), 10) || 0;
      }
    } catch {}
    const chosen = profiles[idx % profiles.length];
    try {
      fs.writeFileSync(rrFile, String((idx + 1) % profiles.length));
    } catch {}
    return { profile: chosen, targetPool, reason: "Round-robin rotation" };
  }

  // 3. Health-based auto selection
  for (const prof of profiles) {
    const quotas = await adapter.getQuotaStatus(prof);
    const poolQuota = quotas.find((q) => q.pool === targetPool);
    if (poolQuota && poolQuota.state === "READY") {
      return { profile: prof, targetPool, reason: `Healthy quota in pool '${targetPool}'` };
    }
  }

  // Fallback to first profile
  return {
    profile: profiles[0],
    targetPool,
    reason: "Fallback to primary (all profiles in cooldown or limit)"
  };
}

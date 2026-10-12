import fs from "node:fs";
import path from "node:path";
import { getStateDir, recordCooldown } from "./state.js";

/**
 * Pool naming for meta-harness providers (pi, opencode), which multiplex
 * several inner providers (e.g. pi: commandcode, orcarouter; opencode:
 * opencode, opencode-go, unsloth-custom).
 *
 * - `{inner}` — all models of one inner provider (from the `provider/model` prefix)
 * - `{inner}-free` — free-suffixed models of one inner provider
 * - `free` — merged union of every `{inner}-free`
 * - `default` — no model requested
 */

export const DEFAULT_POOL = "default";
export const FREE_POOL = "free";

const FREE_SUFFIXES = [":free", "-free"];

/** True when a model id carries a free-tier suffix. */
export function isFreeModelId(model: string): boolean {
  return FREE_SUFFIXES.some((s) => model.endsWith(s));
}

/** Inner provider prefix of a `provider/model` id, or undefined when bare. */
export function innerProviderOf(model: string): string | undefined {
  const idx = model.indexOf("/");
  if (idx <= 0) return undefined;
  return model.slice(0, idx);
}

export interface ModelPoolRequest {
  /** Value of --model / -m, if any. */
  model?: string;
  /** Value of pi-style --provider, if any. */
  providerFlag?: string;
}

/**
 * Map a model request onto a pool. Free suffix wins over the provider prefix
 * so quota is tracked at the precise `{inner}-free` granularity; merged
 * `free` is selected only via explicit `--pool free`.
 */
export function poolForModelRequest(req: ModelPoolRequest): string {
  const model = req.model?.trim();
  if (model) {
    const inner = innerProviderOf(model);
    if (isFreeModelId(model)) {
      return inner ? `${inner}-free` : FREE_POOL;
    }
    if (inner) return inner;
    if (req.providerFlag) return req.providerFlag;
    return DEFAULT_POOL;
  }
  if (req.providerFlag) return req.providerFlag;
  return DEFAULT_POOL;
}

/**
 * Every cooldown key that must be recorded when `pool` exhausts. A
 * per-provider free-pool exhaustion also gates the merged `free` pool so
 * `--pool free` routing skips it; paid provider pools are left untouched.
 */
export function poolFamily(pool: string): string[] {
  if (pool !== FREE_POOL && pool.endsWith("-free")) {
    return [pool, FREE_POOL];
  }
  return [pool];
}

/** Record a cooldown for a pool and all of its parent pools. */
export function recordCooldownFamily(
  provider: string,
  profile: string,
  pool: string,
  durationSec: number,
  reason?: string
): void {
  for (const p of poolFamily(pool)) {
    recordCooldown(provider, profile, p, durationSec, reason);
  }
}

/**
 * Pick a representative model id for a pool from a `provider/model` catalog.
 * Returns undefined for `default` (leave the user's model untouched) and when
 * the pool has no matching model.
 */
export function pickModelForPool(models: string[], pool: string): string | undefined {
  if (pool === FREE_POOL) return models.find(isFreeModelId);
  if (pool !== DEFAULT_POOL && pool.endsWith("-free")) {
    const inner = pool.slice(0, -"-free".length);
    return models.find((m) => innerProviderOf(m) === inner && isFreeModelId(m));
  }
  if (pool === DEFAULT_POOL) return undefined;
  return models.find((m) => innerProviderOf(m) === pool);
}

const DISCOVERED_POOLS_FILE = "discovered-pools.json";

function discoveredPoolsPath(): string {
  return path.join(getStateDir(), DISCOVERED_POOLS_FILE);
}

/**
 * Load previously discovered inner providers for a harness provider.
 * Keeps `status` instant and complete across processes; discovery itself
 * still happens live via listModels/probe/discoverPools.
 */
export function loadDiscoveredInners(providerId: string): string[] {
  try {
    const file = discoveredPoolsPath();
    if (!fs.existsSync(file)) return [];
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    const inners = data?.[providerId];
    return Array.isArray(inners) ? inners.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** Persist discovered inner providers (no-op when unchanged). */
export function saveDiscoveredInners(providerId: string, inners: string[]): void {
  try {
    const file = discoveredPoolsPath();
    let data: Record<string, string[]> = {};
    try {
      if (fs.existsSync(file)) {
        data = JSON.parse(fs.readFileSync(file, "utf-8"));
      }
    } catch {}
    const sorted = [...new Set(inners)].sort();
    const prev = data[providerId];
    if (prev && prev.length === sorted.length && prev.every((p, i) => p === sorted[i])) {
      return;
    }
    data[providerId] = sorted;
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, file);
  } catch {}
}

/** Extract the `--model/-m` and `--provider` values from CLI args. */
export function parseModelRequest(args: string[]): ModelPoolRequest {
  let model: string | undefined;
  let providerFlag: string | undefined;
  let prev = "";
  for (const a of args) {
    if (prev === "--model" || prev === "-m") model = a;
    else if (prev === "--provider") providerFlag = a;
    prev = a;
  }
  return { model, providerFlag };
}

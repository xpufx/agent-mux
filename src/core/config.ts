import fs from "node:fs";
import path from "node:path";
import { getAgentMuxHome } from "./paths.js";

export type SurfaceAccountMode = "tool" | "message" | "both" | "none";
export type IsolationMode = "scoped" | "home";
export type RoutingPolicy = "pool-strict" | "pool-spillover" | "account-first";

export interface AgentMuxConfig {
  surface_account?: SurfaceAccountMode;
  isolation_mode?: IsolationMode;
  routingPolicy?: RoutingPolicy;
  [key: string]: unknown;
}

export function getConfigFilePath(): string {
  return path.join(getAgentMuxHome(), "config.json");
}

export function loadConfig(): AgentMuxConfig {
  const file = getConfigFilePath();
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, "utf-8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

export function saveConfig(config: AgentMuxConfig): void {
  const dir = getAgentMuxHome();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getConfigFilePath(), JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function parseSurfaceAccountMode(val: unknown): SurfaceAccountMode | undefined {
  if (typeof val !== "string") return undefined;
  const s = val.toLowerCase().trim();
  if (s === "none" || s === "0" || s === "false" || s === "off" || s === "disabled") {
    return "none";
  }
  if (s === "message" || s === "prefix" || s === "text") {
    return "message";
  }
  if (s === "both" || s === "all") {
    return "both";
  }
  if (s === "tool" || s === "card" || s === "frame" || s === "1" || s === "true" || s === "on" || s === "enabled") {
    return "tool";
  }
  return undefined;
}

export function getSurfaceAccountMode(): SurfaceAccountMode {
  // 1. Environment variable override
  if (process.env.AGENT_MUX_SURFACE_ACCOUNT !== undefined) {
    const parsed = parseSurfaceAccountMode(process.env.AGENT_MUX_SURFACE_ACCOUNT);
    if (parsed) return parsed;
  }

  // 2. Persistent config file
  const config = loadConfig();
  if (config.surface_account) {
    const parsed = parseSurfaceAccountMode(config.surface_account);
    if (parsed) return parsed;
  }

  // 3. Default to "none" (preserves clean agent conversation history without context pollution)
  return "none";
}

export function parseRoutingPolicy(val: unknown): RoutingPolicy | undefined {
  if (typeof val !== "string") return undefined;
  const s = val.toLowerCase().trim();
  if (s === "pool-strict") return "pool-strict";
  if (s === "pool-spillover") return "pool-spillover";
  if (s === "account-first") return "account-first";
  return undefined;
}

export function getRoutingPolicy(): RoutingPolicy {
  // 1. Environment variable override
  if (process.env.AGENT_MUX_ROUTING_POLICY !== undefined) {
    const parsed = parseRoutingPolicy(process.env.AGENT_MUX_ROUTING_POLICY);
    if (parsed) return parsed;
  }

  // 2. Persistent config file
  const config = loadConfig();
  if (config.routingPolicy) {
    const parsed = parseRoutingPolicy(config.routingPolicy);
    if (parsed) return parsed;
  }

  // 3. Default to "pool-strict" (stay within the requested pool, never drift)
  return "pool-strict";
}

export function parseIsolationMode(val: unknown): IsolationMode | undefined {
  if (typeof val !== "string") return undefined;
  const s = val.toLowerCase().trim();
  if (s === "scoped" || s === "shared" || s === "bwrap" || s === "mount") {
    return "scoped";
  }
  if (s === "home" || s === "profile-home" || s === "isolated-home" || s === "isolated") {
    return "home";
  }
  return undefined;
}

export function getIsolationMode(): IsolationMode {
  // 1. Environment variable override
  if (process.env.AGENT_MUX_ISOLATION_MODE !== undefined) {
    const parsed = parseIsolationMode(process.env.AGENT_MUX_ISOLATION_MODE);
    if (parsed) return parsed;
  }

  // 2. Persistent config file
  const config = loadConfig();
  if (config.isolation_mode) {
    const parsed = parseIsolationMode(config.isolation_mode);
    if (parsed) return parsed;
  }

  // 3. Default to "home" (profile directory acts as independent HOME, complete isolation)
  return "home";
}

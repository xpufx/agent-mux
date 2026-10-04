import fs from "node:fs";
import path from "node:path";
import { getAgentMuxHome } from "./paths.js";

export type SurfaceAccountMode = "tool" | "message" | "both" | "none";

export interface AgentMuxConfig {
  surface_account?: SurfaceAccountMode;
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

  // 3. Default to "tool" (stream frame injection)
  return "tool";
}

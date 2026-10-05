import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function getRealHome(): string {
  let home = process.env.REAL_HOME || os.homedir();
  if (home.includes("/.agent-mux")) {
    home = home.split("/.agent-mux")[0];
  }
  return home;
}

export function getAgentMuxHome(): string {
  if (process.env.AGENT_MUX_HOME) {
    return path.resolve(process.env.AGENT_MUX_HOME);
  }
  return path.join(getRealHome(), ".agent-mux");
}

export function getAgentProfilesDir(providerId: string): string {
  return path.join(getAgentMuxHome(), "profiles", providerId);
}

export function getAgentLogsDir(): string {
  const dir = path.join(getAgentMuxHome(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getAgentLogFilePath(): string {
  return path.join(getAgentLogsDir(), "agent-mux.log");
}

export const COMMON_DOTFILES = [
  ".gitconfig",
  ".git-credentials",
  ".ssh",
  ".local",
  ".config",
  ".bashrc",
  ".profile",
  ".agents"
];

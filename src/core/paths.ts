import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function getRealHome(): string {
  let home = process.env.REAL_HOME || os.homedir();
  if (home.includes("/.agy-profiles/") || home.includes("/.agent-profiles/")) {
    home = home.split("/.ag")[0];
  }
  return home;
}

export function getAgentProfilesDir(providerId: string): string {
  const realHome = getRealHome();
  // Support backwards compatibility for agy (~/.agy-profiles)
  if (providerId === "antigravity" || providerId === "agy") {
    const legacyPath = path.join(realHome, ".agy-profiles");
    if (fs.existsSync(legacyPath)) {
      return legacyPath;
    }
  }
  return path.join(realHome, ".agent-profiles", providerId);
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

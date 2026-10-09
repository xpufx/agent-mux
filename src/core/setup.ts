import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRealHome, getAgentMuxHome, COMMON_DOTFILES } from "./paths.js";

export type SetupProvider = "all" | "antigravity" | "opencode";

export interface SetupAction {
  kind: "mkdir" | "symlink" | "copy" | "move" | "chmod" | "skip" | "rm";
  target: string;
  source?: string;
  noClobber?: boolean;
  reason: string;
}

export interface SetupOptions {
  dryRun?: boolean;
  realHome?: string;
  agentMuxHome?: string;
  localBin?: string;
  distDir?: string;
  provider?: SetupProvider;
  accounts?: string[];
  pathEnv?: string;
  log?: (line: string) => void;
}

interface PlanContext {
  actions: SetupAction[];
  /** Directories the plan will create; treated as present during planning. */
  plannedDirs: Set<string>;
}

function defaultDistDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  // Walk up until the compiled entry points are found (bundled builds live flat
  // in dist/, unbundled tsc output lives in dist/core/).
  for (let i = 0; i < 4; i++) {
    if (
      fs.existsSync(path.join(dir, "cli.js")) ||
      fs.existsSync(path.join(dir, "wrappers", "agy.js"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(fileURLToPath(import.meta.url));
}

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function symlinkPointsTo(target: string, source: string): boolean {
  try {
    return fs.readlinkSync(target) === source;
  } catch {
    return false;
  }
}

function isElfFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      return buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function findOnPath(binary: string, pathEnv: string, exclude?: string): string | undefined {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    // Never treat our own wrapper as the real provider binary.
    if (exclude && path.resolve(candidate) === path.resolve(exclude)) continue;
    if (lexists(candidate) && !isSymlink(candidate)) return candidate;
  }
  return undefined;
}

function isAncestorRemoved(ctx: PlanContext, p: string): boolean {
  return ctx.actions.some(
    (a) => a.kind === "rm" && (p === a.target || p.startsWith(a.target + path.sep))
  );
}

function targetExistsOnDisk(ctx: PlanContext, target: string): boolean {
  if (!lexists(target)) return false;
  if (isAncestorRemoved(ctx, target)) return false;
  return true;
}

function planMkdir(ctx: PlanContext, dir: string, reason: string): void {
  if (ctx.plannedDirs.has(dir)) return;
  if (lexists(dir) && !isSymlink(dir) && fs.lstatSync(dir).isDirectory()) {
    if (!isAncestorRemoved(ctx, dir)) return;
  }
  ctx.actions.push({ kind: "mkdir", target: dir, reason });
  ctx.plannedDirs.add(dir);
}

function planSymlink(
  ctx: PlanContext,
  source: string,
  target: string,
  reason: string
): void {
  if (!isAncestorRemoved(ctx, target)) {
    if (
      ctx.plannedDirs.has(target) ||
      [...ctx.plannedDirs].some((dir) => dir.startsWith(target + path.sep))
    ) {
      ctx.actions.push({ kind: "skip", target, reason: "target is a managed directory" });
      return;
    }
    if (isSymlink(target)) {
      if (symlinkPointsTo(target, source)) {
        ctx.actions.push({ kind: "skip", target, source, reason: `already linked to ${source}` });
      } else {
        ctx.actions.push({ kind: "symlink", target, source, reason });
      }
      return;
    }
    if (lexists(target) && fs.lstatSync(target).isDirectory()) {
      ctx.actions.push({ kind: "skip", target, reason: "existing directory left untouched" });
      return;
    }
  }
  ctx.actions.push({ kind: "symlink", target, source, reason });
}

function planCopy(
  ctx: PlanContext,
  source: string,
  target: string,
  reason: string,
  opts: { noClobber?: boolean } = {}
): void {
  if (opts.noClobber && (targetExistsOnDisk(ctx, target) || ctx.plannedDirs.has(target))) {
    ctx.actions.push({ kind: "skip", target, source, reason: `already present at ${target}` });
    return;
  }
  ctx.actions.push({ kind: "copy", target, source, noClobber: opts.noClobber, reason });
}

function resolveAccounts(agentMuxHome: string, explicit?: string[]): string[] {
  if (explicit && explicit.length > 0) return explicit;
  const agyProfiles = path.join(agentMuxHome, "profiles", "antigravity");
  if (fs.existsSync(agyProfiles)) {
    const found = fs.readdirSync(agyProfiles).filter((name) => {
      try {
        return fs.statSync(path.join(agyProfiles, name)).isDirectory();
      } catch {
        return false;
      }
    });
    if (found.length > 0) return found;
  }
  return ["primary", "secondary"];
}

function planDotfileLinks(ctx: PlanContext, realHome: string, profileDir: string): void {
  for (const dot of COMMON_DOTFILES) {
    const src = path.join(realHome, dot);
    if (!fs.existsSync(src)) continue;
    planSymlink(ctx, src, path.join(profileDir, dot), `link shared ${dot}`);
  }
}

interface ResolvedRoots {
  realHome: string;
  agentMuxHome: string;
  localBin: string;
  distDir: string;
  pathEnv: string;
}

function planAntigravity(ctx: PlanContext, roots: ResolvedRoots, accounts: string[]): void {
  const agyProfiles = path.join(roots.agentMuxHome, "profiles", "antigravity");
  planMkdir(ctx, agyProfiles, "antigravity profile base");

  const primary = accounts[0];
  const realConversations = path.join(
    roots.realHome,
    ".gemini",
    "antigravity-cli",
    "conversations"
  );
  const realConfig = path.join(roots.realHome, ".gemini", "config");
  const realSettings = path.join(roots.realHome, ".gemini", "antigravity-cli", "settings.json");
  const realToken = path.join(
    roots.realHome,
    ".gemini",
    "antigravity-cli",
    "antigravity-oauth-token"
  );

  // All profiles keep isolated auth but share conversations and config.
  for (const prof of accounts) {
    const profDir = path.join(agyProfiles, prof);
    planMkdir(ctx, profDir, `antigravity profile ${prof}`);

    const geminiDir = path.join(profDir, ".gemini");
    if (isSymlink(geminiDir)) {
      ctx.actions.push({
        kind: "rm",
        target: geminiDir,
        reason: "replace shared .gemini symlink with isolated directory"
      });
    }

    const cliDir = path.join(geminiDir, "antigravity-cli");
    planMkdir(ctx, cliDir, `antigravity profile ${prof}`);

    if (fs.existsSync(realSettings)) {
      planCopy(ctx, realSettings, path.join(cliDir, "settings.json"), `seed ${prof} settings`, {
        noClobber: true
      });
    }
    if (prof === primary && fs.existsSync(realToken)) {
      planCopy(
        ctx,
        realToken,
        path.join(cliDir, "antigravity-oauth-token"),
        "seed primary auth token",
        { noClobber: true }
      );
    }
    if (fs.existsSync(realConfig)) {
      planSymlink(
        ctx,
        realConfig,
        path.join(geminiDir, "config"),
        "share ~/.gemini/config"
      );
    }

    planMkdir(ctx, realConversations, "shared antigravity conversations");
    planSymlink(
      ctx,
      realConversations,
      path.join(cliDir, "conversations"),
      "share conversation history"
    );

    planDotfileLinks(ctx, roots.realHome, profDir);
  }

  // Preserve a real (non-symlink) agy binary before wiring the wrapper.
  const targetAgy = path.join(roots.localBin, "agy");
  const realAgy = path.join(roots.localBin, "agy.bin");
  let agyBinPlanned = lexists(realAgy);
  if (lexists(targetAgy) && !isSymlink(targetAgy) && isElfFile(targetAgy)) {
    ctx.actions.push({
      kind: "move",
      source: targetAgy,
      target: realAgy,
      reason: "preserve real agy binary"
    });
    agyBinPlanned = true;
  }
  if (!agyBinPlanned) {
    const sysAgy = findOnPath("agy", roots.pathEnv, targetAgy);
    if (sysAgy) {
      planCopy(ctx, sysAgy, realAgy, "copy system agy to agy.bin", { noClobber: true });
    }
  }

  planCopy(ctx, path.join(roots.distDir, "wrappers", "agy.js"), targetAgy, "install transparent agy wrapper");
  ctx.actions.push({ kind: "chmod", target: targetAgy, reason: "make agy wrapper executable" });
}

function planOpenCode(ctx: PlanContext, roots: ResolvedRoots, accounts: string[]): void {
  const opencodeProfiles = path.join(roots.agentMuxHome, "profiles", "opencode");
  planMkdir(ctx, opencodeProfiles, "opencode profile base");

  const realData = path.join(roots.realHome, ".local", "share", "opencode");
  const realConfig = path.join(roots.realHome, ".config", "opencode");

  const primary = accounts[0];
  const primaryDir = path.join(opencodeProfiles, primary);
  const primaryData = path.join(primaryDir, ".local", "share", "opencode");

  planMkdir(ctx, primaryData, `primary opencode profile ${primary}`);
  planMkdir(ctx, path.join(primaryDir, ".config"), `primary opencode config ${primary}`);

  if (fs.existsSync(realConfig)) {
    planSymlink(
      ctx,
      realConfig,
      path.join(primaryDir, ".config", "opencode"),
      "share ~/.config/opencode"
    );
  }
  const realAuth = path.join(realData, "auth.json");
  if (fs.existsSync(realAuth)) {
    planCopy(ctx, realAuth, path.join(primaryData, "auth.json"), "seed primary auth", {
      noClobber: true
    });
  }
  const realRepos = path.join(realData, "repos");
  if (fs.existsSync(realRepos)) {
    planSymlink(ctx, realRepos, path.join(primaryData, "repos"), "share repos");
  }
  const realDb = path.join(realData, "opencode.db");
  if (fs.existsSync(realDb)) {
    planSymlink(ctx, realDb, path.join(primaryData, "opencode.db"), "share opencode.db");
  }
  planDotfileLinks(ctx, roots.realHome, primaryDir);

  // Remaining profiles: isolated auth, shared config & project stores.
  for (const prof of accounts.slice(1)) {
    const profDir = path.join(opencodeProfiles, prof);
    const profData = path.join(profDir, ".local", "share", "opencode");
    planMkdir(ctx, profData, `opencode profile ${prof}`);
    planMkdir(ctx, path.join(profDir, ".config"), `opencode config ${prof}`);

    if (fs.existsSync(realConfig)) {
      planSymlink(
        ctx,
        realConfig,
        path.join(profDir, ".config", "opencode"),
        "share ~/.config/opencode"
      );
    }
    if (fs.existsSync(realRepos)) {
      planSymlink(ctx, realRepos, path.join(profData, "repos"), "share repos");
    }
    if (fs.existsSync(realDb)) {
      planSymlink(ctx, realDb, path.join(profData, "opencode.db"), "share opencode.db");
    }
    planDotfileLinks(ctx, roots.realHome, profDir);
  }

  // Preserve a real (non-symlink) opencode binary before wiring the wrapper.
  const targetOpencode = path.join(roots.localBin, "opencode");
  const realOpencode = path.join(roots.localBin, "opencode.bin");
  let opencodeBinPlanned = lexists(realOpencode);
  if (lexists(targetOpencode) && !isSymlink(targetOpencode) && isElfFile(targetOpencode)) {
    ctx.actions.push({
      kind: "move",
      source: targetOpencode,
      target: realOpencode,
      reason: "preserve real opencode binary"
    });
    opencodeBinPlanned = true;
  }
  if (!opencodeBinPlanned) {
    const sysOpenCode = findOnPath("opencode", roots.pathEnv, targetOpencode);
    if (sysOpenCode) {
      planCopy(ctx, sysOpenCode, realOpencode, "copy system opencode to opencode.bin", {
        noClobber: true
      });
    }
  }

  const targetMux = path.join(roots.localBin, "opencode-mux");
  planCopy(ctx, path.join(roots.distDir, "wrappers", "opencode.js"), targetMux, "install opencode wrapper");
  ctx.actions.push({ kind: "chmod", target: targetMux, reason: "make opencode wrapper executable" });
  planSymlink(ctx, targetMux, targetOpencode, "wire opencode wrapper onto PATH");
}

/**
 * Compute the full set of filesystem actions needed to mirror install.sh.
 * Read-only: performs no writes, so it is safe to call with `--dry-run`.
 */
export function planSetup(options: SetupOptions = {}): SetupAction[] {
  const realHome = options.realHome ?? getRealHome();
  const agentMuxHome = options.agentMuxHome ?? getAgentMuxHome();
  const localBin = options.localBin ?? path.join(realHome, ".local", "bin");
  const distDir = options.distDir ?? defaultDistDir();
  const provider = options.provider ?? "all";
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const accounts = resolveAccounts(agentMuxHome, options.accounts);

  const ctx: PlanContext = { actions: [], plannedDirs: new Set() };
  const roots: ResolvedRoots = { realHome, agentMuxHome, localBin, distDir, pathEnv };

  planMkdir(ctx, localBin, "local bin directory");

  if (provider === "all" || provider === "antigravity") {
    planAntigravity(ctx, roots, accounts);
  }
  if (provider === "all" || provider === "opencode") {
    planOpenCode(ctx, roots, accounts);
  }

  // Install the main CLI plus its legacy agy-profile alias.
  const targetCli = path.join(localBin, "agent-mux");
  planCopy(ctx, path.join(distDir, "cli.js"), targetCli, "install agent-mux CLI");
  ctx.actions.push({ kind: "chmod", target: targetCli, reason: "make agent-mux executable" });
  planSymlink(ctx, targetCli, path.join(localBin, "agy-profile"), "install agy-profile alias");

  return ctx.actions;
}

function applyPlan(plan: SetupAction[], dryRun: boolean, log: (line: string) => void): void {
  const prefix = dryRun ? "[dry-run]" : "[+]";
  for (const action of plan) {
    switch (action.kind) {
      case "mkdir": {
        if (!dryRun) fs.mkdirSync(action.target, { recursive: true });
        log(`${prefix} mkdir -p ${action.target}`);
        break;
      }
      case "symlink": {
        if (!dryRun) {
          if (lexists(action.target)) fs.rmSync(action.target, { recursive: true, force: true });
          fs.symlinkSync(action.source!, action.target);
        }
        log(`${prefix} link ${action.target} -> ${action.source}`);
        break;
      }
      case "copy": {
        if (!dryRun) {
          if (action.noClobber && lexists(action.target)) break;
          fs.mkdirSync(path.dirname(action.target), { recursive: true });
          fs.copyFileSync(action.source!, action.target);
        }
        log(`${prefix} copy ${action.source} -> ${action.target}`);
        break;
      }
      case "move": {
        if (!dryRun) {
          fs.mkdirSync(path.dirname(action.target), { recursive: true });
          fs.renameSync(action.source!, action.target);
        }
        log(`${prefix} move ${action.source} -> ${action.target}`);
        break;
      }
      case "chmod": {
        if (!dryRun) fs.chmodSync(action.target, 0o755);
        log(`${prefix} chmod +x ${action.target}`);
        break;
      }
      case "rm": {
        if (!dryRun) {
          fs.rmSync(action.target, { recursive: true, force: true });
        }
        log(`${prefix} rm ${action.target}`);
        break;
      }
      case "skip": {
        log(`${prefix} skip ${action.target} (${action.reason})`);
        break;
      }
    }
  }
}

/**
 * Plan and apply the setup. With `dryRun` the plan is printed but nothing on
 * disk is touched. Returns the computed plan for callers/tests to inspect.
 */
export function runSetup(options: SetupOptions = {}): SetupAction[] {
  const plan = planSetup(options);
  const log = options.log ?? ((line: string) => console.log(line));
  const dryRun = options.dryRun ?? false;

  const realHome = options.realHome ?? getRealHome();
  const agentMuxHome = options.agentMuxHome ?? getAgentMuxHome();
  const localBin = options.localBin ?? path.join(realHome, ".local", "bin");

  log(`=== agent-mux setup${dryRun ? " (dry run)" : ""} ===`);
  log(`Base Directory : ${agentMuxHome}`);
  log(`Local Bin      : ${localBin}`);
  log("");

  applyPlan(plan, dryRun, log);

  const applied = plan.filter((a) => a.kind !== "skip").length;
  log("");
  log(
    dryRun
      ? `[dry-run] ${applied} action(s) would be applied.`
      : `Done. ${applied} action(s) applied.`
  );
  return plan;
}

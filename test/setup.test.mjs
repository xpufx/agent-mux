import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const { planSetup, runSetup } = await import("../dist/index.js");

function makeDist(root) {
  const distDir = path.join(root, "dist");
  fs.mkdirSync(path.join(distDir, "wrappers"), { recursive: true });
  fs.writeFileSync(path.join(distDir, "cli.js"), "// agent-mux cli\n");
  fs.writeFileSync(path.join(distDir, "wrappers", "agy.js"), "// agy wrapper\n");
  fs.writeFileSync(path.join(distDir, "wrappers", "opencode.js"), "// opencode wrapper\n");
  return distDir;
}

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mux-setup-"));
  const realHome = path.join(root, "home");
  const agentMuxHome = path.join(root, "agent-mux");
  const localBin = path.join(root, "local-bin");
  const pathEnv = path.join(root, "empty-path");
  fs.mkdirSync(realHome, { recursive: true });
  fs.mkdirSync(pathEnv, { recursive: true });

  fs.writeFileSync(path.join(realHome, ".gitconfig"), "[user]\n");
  fs.mkdirSync(path.join(realHome, ".ssh"), { recursive: true });
  fs.mkdirSync(path.join(realHome, ".gemini", "antigravity-cli"), { recursive: true });
  fs.writeFileSync(path.join(realHome, ".gemini", "antigravity-cli", "settings.json"), "{}\n");
  fs.writeFileSync(
    path.join(realHome, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    '{"id_token":"mock"}\n'
  );
  fs.mkdirSync(path.join(realHome, ".gemini", "config"), { recursive: true });
  fs.mkdirSync(path.join(realHome, ".config", "opencode"), { recursive: true });
  fs.mkdirSync(path.join(realHome, ".local", "share", "opencode"), { recursive: true });
  fs.writeFileSync(path.join(realHome, ".local", "share", "opencode", "auth.json"), "{}\n");

  return { root, realHome, agentMuxHome, localBin, pathEnv, distDir: makeDist(root) };
}

function opts(sb, extra = {}) {
  return {
    realHome: sb.realHome,
    agentMuxHome: sb.agentMuxHome,
    localBin: sb.localBin,
    distDir: sb.distDir,
    pathEnv: sb.pathEnv,
    ...extra
  };
}

test("planSetup plans profile trees, dotfile links and wrappers without writing", () => {
  const sb = makeSandbox();
  const plan = planSetup(opts(sb));

  const agyPrimary = path.join(sb.agentMuxHome, "profiles", "antigravity", "primary");
  const opencodePrimary = path.join(sb.agentMuxHome, "profiles", "opencode", "primary");

  assert.ok(plan.some((a) => a.kind === "mkdir" && a.target === agyPrimary));
  assert.ok(
    plan.some(
      (a) =>
        a.kind === "mkdir" &&
        a.target === path.join(opencodePrimary, ".local", "share", "opencode")
    )
  );
  assert.ok(
    plan.some(
      (a) => a.kind === "symlink" && a.target === path.join(agyPrimary, ".gitconfig")
    )
  );
  assert.ok(
    plan.some(
      (a) =>
        a.kind === "mkdir" &&
        a.target === path.join(agyPrimary, ".gemini", "antigravity-cli")
    )
  );
  assert.ok(
    !plan.some(
      (a) => a.kind === "symlink" && a.target === path.join(agyPrimary, ".gemini")
    )
  );
  assert.ok(
    plan.some(
      (a) =>
        a.kind === "copy" &&
        a.target === path.join(agyPrimary, ".gemini", "antigravity-cli", "antigravity-oauth-token")
    )
  );
  assert.ok(plan.some((a) => a.kind === "copy" && a.target === path.join(sb.localBin, "agy")));
  assert.ok(
    plan.some((a) => a.kind === "copy" && a.target === path.join(sb.localBin, "agent-mux"))
  );
  assert.ok(
    plan.some(
      (a) => a.kind === "symlink" && a.target === path.join(sb.localBin, "agy-profile")
    )
  );

  // Pure planning must not create anything.
  assert.equal(fs.existsSync(sb.agentMuxHome), false);
  assert.equal(fs.existsSync(sb.localBin), false);
});

test("runSetup --dry-run reports actions but never touches disk", () => {
  const sb = makeSandbox();
  const lines = [];
  const plan = runSetup(opts(sb, { dryRun: true, log: (l) => lines.push(l) }));

  assert.ok(plan.length > 0);
  assert.ok(lines.some((l) => l.startsWith("[dry-run] mkdir")));
  assert.ok(lines.some((l) => l.includes("would be applied")));

  assert.equal(fs.existsSync(sb.agentMuxHome), false);
  assert.equal(fs.existsSync(sb.localBin), false);
});

test("runSetup applies the plan and is idempotent", () => {
  const sb = makeSandbox();
  const silent = () => {};

  runSetup(opts(sb, { log: silent }));

  const agyPrimary = path.join(sb.agentMuxHome, "profiles", "antigravity", "primary");
  const opencodePrimaryData = path.join(
    sb.agentMuxHome,
    "profiles",
    "opencode",
    "primary",
    ".local",
    "share",
    "opencode"
  );
  const agySecondary = path.join(sb.agentMuxHome, "profiles", "antigravity", "secondary");
  assert.ok(fs.lstatSync(path.join(agyPrimary, ".gitconfig")).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(agyPrimary, ".gemini")).isDirectory());
  assert.ok(!fs.lstatSync(path.join(agyPrimary, ".gemini")).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(agyPrimary, ".gemini", "config")).isSymbolicLink());
  assert.ok(
    fs
      .lstatSync(path.join(agyPrimary, ".gemini", "antigravity-cli", "conversations"))
      .isSymbolicLink()
  );

  // Primary profile gets seeded token as a real file, not symlink
  const primaryToken = path.join(
    agyPrimary,
    ".gemini",
    "antigravity-cli",
    "antigravity-oauth-token"
  );
  assert.ok(fs.lstatSync(primaryToken).isFile());
  assert.ok(!fs.lstatSync(primaryToken).isSymbolicLink());

  // Secondary profile does not inherit the primary token
  const secondaryToken = path.join(
    agySecondary,
    ".gemini",
    "antigravity-cli",
    "antigravity-oauth-token"
  );
  assert.equal(fs.existsSync(secondaryToken), false);

  // Managed opencode dirs must stay real directories, not dotfile symlinks.
  assert.ok(!fs.lstatSync(path.dirname(path.dirname(opencodePrimaryData))).isSymbolicLink());
  assert.ok(fs.statSync(path.join(opencodePrimaryData, "auth.json")).isFile());
  assert.equal(fs.readFileSync(path.join(sb.localBin, "agy"), "utf-8"), "// agy wrapper\n");
  assert.equal(fs.readFileSync(path.join(sb.localBin, "agent-mux"), "utf-8"), "// agent-mux cli\n");
  assert.ok(fs.lstatSync(path.join(sb.localBin, "agy-profile")).isSymbolicLink());
  assert.equal(
    fs.readlinkSync(path.join(sb.localBin, "agy-profile")),
    path.join(sb.localBin, "agent-mux")
  );

  const second = runSetup(opts(sb, { log: silent }));
  assert.equal(fs.readFileSync(path.join(sb.localBin, "agy"), "utf-8"), "// agy wrapper\n");
  assert.ok(
    second.some(
      (a) =>
        a.kind === "skip" &&
        a.target === path.join(agyPrimary, ".gitconfig") &&
        a.reason.startsWith("already linked")
    )
  );
});

test("runSetup replaces legacy symlinked .gemini with isolated directory", () => {
  const sb = makeSandbox();
  const agyPrimary = path.join(sb.agentMuxHome, "profiles", "antigravity", "primary");
  fs.mkdirSync(agyPrimary, { recursive: true });
  fs.symlinkSync(path.join(sb.realHome, ".gemini"), path.join(agyPrimary, ".gemini"));
  assert.ok(fs.lstatSync(path.join(agyPrimary, ".gemini")).isSymbolicLink());

  runSetup(opts(sb, { log: () => {} }));

  assert.ok(fs.lstatSync(path.join(agyPrimary, ".gemini")).isDirectory());
  assert.ok(!fs.lstatSync(path.join(agyPrimary, ".gemini")).isSymbolicLink());
  assert.ok(
    fs.existsSync(path.join(agyPrimary, ".gemini", "antigravity-cli", "settings.json"))
  );
  const primaryToken = path.join(
    agyPrimary,
    ".gemini",
    "antigravity-cli",
    "antigravity-oauth-token"
  );
  assert.ok(fs.lstatSync(primaryToken).isFile());
  assert.ok(!fs.lstatSync(primaryToken).isSymbolicLink());
});

test("planSetup preserves real provider binaries before wiring wrappers", () => {
  const sb = makeSandbox();
  fs.mkdirSync(sb.localBin, { recursive: true });
  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(24)]);
  fs.writeFileSync(path.join(sb.localBin, "agy"), elf);
  fs.writeFileSync(path.join(sb.localBin, "opencode"), elf);

  const plan = planSetup(opts(sb));

  assert.ok(
    plan.some(
      (a) =>
        a.kind === "move" &&
        a.source === path.join(sb.localBin, "agy") &&
        a.target === path.join(sb.localBin, "agy.bin")
    )
  );
  assert.ok(
    plan.some(
      (a) =>
        a.kind === "move" &&
        a.source === path.join(sb.localBin, "opencode") &&
        a.target === path.join(sb.localBin, "opencode.bin")
    )
  );
  // No system binary should be sourced once a real one is being preserved.
  assert.ok(
    !plan.some((a) => a.kind === "copy" && a.target === path.join(sb.localBin, "agy.bin"))
  );
});

test("planSetup does not re-preserve an existing .bin binary", () => {
  const sb = makeSandbox();
  fs.mkdirSync(sb.localBin, { recursive: true });
  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(24)]);
  fs.writeFileSync(path.join(sb.localBin, "agy.bin"), elf);

  const plan = planSetup(opts(sb));
  assert.ok(!plan.some((a) => a.kind === "move"));
  assert.ok(
    !plan.some((a) => a.kind === "copy" && a.target === path.join(sb.localBin, "agy.bin"))
  );
});

test("planSetup honors provider and account filters", () => {
  const sb = makeSandbox();
  const plan = planSetup(opts(sb, { provider: "opencode", accounts: ["alpha", "beta"] }));

  assert.ok(
    plan.some(
      (a) =>
        a.kind === "mkdir" &&
        a.target ===
          path.join(sb.agentMuxHome, "profiles", "opencode", "beta", ".local", "share", "opencode")
    )
  );
  assert.ok(!plan.some((a) => a.target.includes(path.join("profiles", "antigravity"))));
});

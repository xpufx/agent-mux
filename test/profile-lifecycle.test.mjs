import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Test-isolated environment must be set before importing the built core.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mux-profile-test-"));
process.env.AGENT_MUX_HOME = tmpHome;

const {
  addProfile,
  removeProfile,
  listProfileInventory,
  getRegisteredProfiles,
  validateProfileName,
  buildAuthInvocation,
  authenticateProfile,
  detectSandbox,
  assertHostEnvironment,
  SANDBOX_GUARD_MESSAGE
} = await import("../dist/index.js");

function makeAdapter(id = "mock") {
  const base = path.join(tmpHome, "profiles", id);
  return {
    id,
    displayName: `Mock ${id}`,
    binaryName: "mockbin",
    defaultBinaryPath: "/bin/true",
    profilesBaseDir: base,
    authArgs: ["auth"],
    getAuthStatus: async (profile) => fs.existsSync(path.join(base, profile, "auth.ok")),
    getAccountIdentity: async (profile) =>
      fs.existsSync(path.join(base, profile, "identity")) ? "user@example.com" : undefined,
    getQuotaStatus: async () => [],
    resolveTargetPool: () => "default",
    getSharedPaths: () => [],
    getSupportedPools: () => ["default"]
  };
}

test("addProfile creates the profile directory and a config entry", () => {
  const adapter = makeAdapter("alpha");
  const result = addProfile(adapter, "primary");

  assert.equal(result.created, true);
  assert.equal(result.provider, "alpha");
  assert.equal(result.directory, path.join(adapter.profilesBaseDir, "primary"));
  assert.ok(fs.statSync(result.directory).isDirectory());
  assert.ok(getRegisteredProfiles("alpha").some((r) => r.name === "primary"));

  // Re-adding is idempotent and keeps a single registry entry.
  const again = addProfile(adapter, "primary");
  assert.equal(again.created, false);
  assert.equal(getRegisteredProfiles("alpha").filter((r) => r.name === "primary").length, 1);
});

test("listProfileInventory reports provider, directory presence and auth status", async () => {
  const adapter = makeAdapter("beta");
  addProfile(adapter, "logged-out");
  addProfile(adapter, "logged-in");
  fs.writeFileSync(path.join(adapter.profilesBaseDir, "logged-in", "auth.ok"), "1");
  fs.writeFileSync(path.join(adapter.profilesBaseDir, "logged-in", "identity"), "1");

  const inventory = await listProfileInventory([adapter]);
  const loggedIn = inventory.find((p) => p.name === "logged-in");
  const loggedOut = inventory.find((p) => p.name === "logged-out");

  assert.equal(loggedIn.provider, "beta");
  assert.equal(loggedIn.directoryExists, true);
  assert.equal(loggedIn.registered, true);
  assert.equal(loggedIn.authenticated, true);
  assert.equal(loggedIn.accountIdentity, "user@example.com");

  assert.equal(loggedOut.authenticated, false);
  assert.equal(loggedOut.accountIdentity, undefined);
});

test("listProfileInventory surfaces registered entries with missing directories", async () => {
  const adapter = makeAdapter("gamma");
  addProfile(adapter, "ghost");
  fs.rmSync(path.join(adapter.profilesBaseDir, "ghost"), { recursive: true, force: true });

  const inventory = await listProfileInventory([adapter]);
  const ghost = inventory.find((p) => p.name === "ghost");
  assert.ok(ghost);
  assert.equal(ghost.directoryExists, false);
  assert.equal(ghost.registered, true);
  assert.equal(ghost.authenticated, false);
});

test("removeProfile deletes the directory and the config entry", () => {
  const adapter = makeAdapter("delta");
  addProfile(adapter, "temp");

  assert.equal(removeProfile(adapter, "temp"), true);
  assert.equal(fs.existsSync(path.join(adapter.profilesBaseDir, "temp")), false);
  assert.ok(!getRegisteredProfiles("delta").some((r) => r.name === "temp"));

  // Removing again is a no-op.
  assert.equal(removeProfile(adapter, "temp"), false);
});

test("validateProfileName rejects traversal, separators and empty names", () => {
  for (const bad of ["", ".", "..", "a/b", "../escape", "a\\b", "has space"]) {
    assert.throws(() => validateProfileName(bad), /Invalid profile name/);
  }
  assert.doesNotThrow(() => validateProfileName("primary-2"));
  assert.doesNotThrow(() => validateProfileName("user.name_1"));
});

test("buildAuthInvocation isolates HOME for adapters without prepareExecution", () => {
  const adapter = makeAdapter("epsilon");
  const invocation = buildAuthInvocation(adapter, "primary", {}, "home");

  assert.equal(invocation.binary, "/bin/true");
  assert.deepEqual(invocation.args, ["auth"]);
  assert.equal(invocation.env.HOME, path.join(adapter.profilesBaseDir, "primary"));
  assert.equal(invocation.env.AGENT_MUX_ACTIVE_PROFILE, "primary");
});

test("buildAuthInvocation delegates to provider prepareExecution when available", () => {
  const adapter = makeAdapter("zeta");
  let seen;
  adapter.prepareExecution = (profile, args, env, mode) => {
    seen = { profile, args, mode };
    return { binary: "/custom", args, env: { ...env, HOME: `/isolated/${profile}` } };
  };

  const invocation = buildAuthInvocation(adapter, "primary", {}, "scoped");
  assert.equal(invocation.binary, "/custom");
  assert.equal(invocation.env.HOME, "/isolated/primary");
  assert.deepEqual(seen, { profile: "primary", args: ["auth"], mode: "scoped" });
});

test("authenticateProfile runs the isolated auth invocation", async () => {
  const adapter = makeAdapter("eta");
  const calls = [];
  const spawnFn = (binary, args, opts) => {
    calls.push({ binary, args, opts });
    return {
      on: (event, cb) => {
        if (event === "close") cb(0);
      }
    };
  };

  const code = await authenticateProfile(adapter, "login", {
    spawnFn,
    isolationMode: "home",
    env: {}
  });

  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, "/bin/true");
  assert.deepEqual(calls[0].args, ["auth"]);
  assert.equal(calls[0].opts.env.HOME, path.join(adapter.profilesBaseDir, "login"));
  assert.ok(getRegisteredProfiles("eta").some((r) => r.name === "login"));
});

test("detectSandbox flags an active agent-mux profile marker", () => {
  const detection = detectSandbox({
    env: { AGENT_MUX_ACTIVE_PROFILE: "primary" },
    readFile: () => ""
  });
  assert.equal(detection.sandboxed, true);
  assert.match(detection.reason, /AGENT_MUX_ACTIVE_PROFILE=primary/);
});

test("detectSandbox detects a tmpfs mounted over the profiles directory", () => {
  const profilesDir = path.join(tmpHome, "profiles");
  const line = `1199 1141 0:96 / ${profilesDir} rw,nosuid,nodev,relatime - tmpfs tmpfs rw,mode=755`;
  const detection = detectSandbox({
    env: {},
    profilesDir,
    mountInfoPath: "/proc/self/mountinfo",
    readFile: () => `${line}\n`
  });
  assert.equal(detection.sandboxed, true);
  assert.match(detection.reason, /tmpfs mounted over/);
});

test("detectSandbox ignores unrelated tmpfs mounts", () => {
  const profilesDir = path.join(tmpHome, "profiles");
  const line = "1199 1141 0:96 / /run/user rw,nosuid,nodev,relatime - tmpfs tmpfs rw";
  const detection = detectSandbox({
    env: {},
    profilesDir,
    mountInfoPath: "/proc/self/mountinfo",
    readFile: () => `${line}\n`
  });
  assert.equal(detection.sandboxed, false);
});

test("detectSandbox degrades gracefully when mountinfo is unreadable", () => {
  const detection = detectSandbox({
    env: {},
    readFile: () => {
      throw new Error("ENOENT");
    }
  });
  assert.equal(detection.sandboxed, false);
});

test("assertHostEnvironment throws the standard sandbox guard message", () => {
  assert.throws(
    () => assertHostEnvironment({ env: { AGENT_MUX_ACTIVE_PROFILE: "primary" } }),
    (err) => err.message === SANDBOX_GUARD_MESSAGE
  );
});

test("install.sh delegates setup to the CLI without provider configuration logic", () => {
  const installSh = fs.readFileSync(new URL("../install.sh", import.meta.url), "utf-8");
  assert.match(installSh, /agent-mux"\s+setup/);
  assert.ok(!installSh.includes("antigravity-cli"));
  assert.ok(!installSh.includes("profiles/antigravity"));
  assert.ok(!installSh.includes("PI_PROFILES"));
  assert.ok(!installSh.includes("OPENCODE_PROFILES"));
});

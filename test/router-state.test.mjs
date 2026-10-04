import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Set isolated AGENT_MUX_HOME for tests
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mux-test-"));
process.env.AGENT_MUX_HOME = tmpHome;

const {
  recordCooldown,
  checkCooldown,
  clearCooldown,
  loadCooldowns,
  selectProfile
} = await import("../dist/index.js");

test("Cooldown State - records, checks, and expires cooldowns", () => {
  const provider = "antigravity";
  const profile = "test-prof-1";
  const pool = "claude";

  // Initially not cooling
  assert.equal(checkCooldown(provider, profile, pool).cooling, false);

  // Record cooldown of 120 seconds
  recordCooldown(provider, profile, pool, 120, "Rate limited 429");

  const check = checkCooldown(provider, profile, pool);
  assert.equal(check.cooling, true);
  assert.ok(check.remainingSec > 0 && check.remainingSec <= 120);
  assert.equal(check.reason, "Rate limited 429");

  // Clear cooldown
  clearCooldown(provider, profile, pool);
  assert.equal(checkCooldown(provider, profile, pool).cooling, false);
});

test("Router - skips cooled down profile and selects healthy one", async () => {
  const fakeAdapter = {
    id: "test-adapter",
    displayName: "Test Adapter",
    binaryName: "test-bin",
    defaultBinaryPath: "/bin/true",
    profilesBaseDir: path.join(tmpHome, "profiles", "test-adapter"),
    resolveTargetPool: () => "claude",
    getSharedPaths: () => [],
    getAuthStatus: async () => true,
    getQuotaStatus: async () => [{ pool: "claude", state: "READY" }]
  };

  fs.mkdirSync(path.join(fakeAdapter.profilesBaseDir, "p1"), { recursive: true });
  fs.mkdirSync(path.join(fakeAdapter.profilesBaseDir, "p2"), { recursive: true });

  // When both healthy, selects p1
  const decision1 = await selectProfile(fakeAdapter, [], {}, "auto");
  assert.equal(decision1.profile, "p1");

  // Put p1 in cooldown
  recordCooldown(fakeAdapter.id, "p1", "claude", 3600, "Quota exhausted");

  // Router should now select p2 because p1 is in cooldown!
  const decision2 = await selectProfile(fakeAdapter, [], {}, "auto");
  assert.equal(decision2.profile, "p2");
  assert.equal(decision2.allCooldown, undefined);

  // Put p2 in cooldown as well (shorter duration for p1)
  recordCooldown(fakeAdapter.id, "p1", "claude", 300, "Quota exhausted");
  recordCooldown(fakeAdapter.id, "p2", "claude", 3600, "Quota exhausted");

  // When all are in cooldown, router returns soonest reset and marks allCooldown: true
  const decision3 = await selectProfile(fakeAdapter, [], {}, "auto");
  assert.equal(decision3.profile, "p1");
  assert.equal(decision3.allCooldown, true);
});

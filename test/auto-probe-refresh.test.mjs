import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Set isolated AGENT_MUX_HOME for tests
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mux-auto-probe-test-"));
process.env.AGENT_MUX_HOME = tmpHome;

const {
  recordCooldown,
  checkCooldown,
  clearCooldown,
  selectProfile,
  getProviderStatus,
  clearStatusProbeCache,
  isNativeEngineQuotaResult
} = await import("../dist/index.js");

test("Opportunistic Probe - recovers eligible cooling profile when READY", async () => {
  let probeCalls = 0;
  const fakeAdapter = {
    id: "test-adapter-auto",
    displayName: "Auto Probe Adapter",
    binaryName: "test-bin",
    defaultBinaryPath: "/bin/true",
    profilesBaseDir: path.join(tmpHome, "profiles", "test-adapter-auto"),
    resolveTargetPool: () => "claude",
    getSharedPaths: () => [],
    getAuthStatus: async () => true,
    getQuotaStatus: async () => [{ pool: "claude", state: "READY" }],
    probe: async (prof, pool) => {
      probeCalls++;
      if (prof === "p1") {
        return { state: "READY", details: "Quota restored" };
      }
      return { state: "LIMIT", details: "Quota limit reached" };
    }
  };

  fs.mkdirSync(path.join(fakeAdapter.profilesBaseDir, "p1"), { recursive: true });
  fs.mkdirSync(path.join(fakeAdapter.profilesBaseDir, "p2"), { recursive: true });

  // Record a cooldown on p1 with recordedAt 60 seconds in the past (> 30s threshold)
  const entry = recordCooldown(fakeAdapter.id, "p1", "claude", 3600, "Old 429 lock");
  assert.ok(entry);
  // Backdate recordedAt
  const { loadCooldowns, saveCooldowns } = await import("../dist/index.js");
  const cds = loadCooldowns();
  const key = `${fakeAdapter.id}:p1:claude`;
  cds[key].recordedAt = Date.now() - 60_000;
  saveCooldowns(cds);

  assert.equal(checkCooldown(fakeAdapter.id, "p1", "claude").cooling, true);

  // Router should opportunistically probe p1, see READY, clear cooldown, and select p1!
  const decision = await selectProfile(fakeAdapter, [], {}, "auto");
  assert.equal(decision.profile, "p1");
  assert.equal(decision.pool, "claude");
  assert.equal(decision.allCooldown, undefined);
  assert.equal(checkCooldown(fakeAdapter.id, "p1", "claude").cooling, false);
  assert.ok(probeCalls >= 1, "adapter.probe must be called");
});

test("Opportunistic Probe - respects eligibility threshold (< 30s elapsed skips probe)", async () => {
  let probeCalls = 0;
  const fakeAdapter = {
    id: "test-adapter-fresh",
    displayName: "Fresh Cooldown Adapter",
    binaryName: "test-bin",
    defaultBinaryPath: "/bin/true",
    profilesBaseDir: path.join(tmpHome, "profiles", "test-adapter-fresh"),
    resolveTargetPool: () => "claude",
    getSharedPaths: () => [],
    getAuthStatus: async () => true,
    getQuotaStatus: async () => [{ pool: "claude", state: "READY" }],
    probe: async () => {
      probeCalls++;
      return { state: "READY", details: "Quota restored" };
    }
  };

  fs.mkdirSync(path.join(fakeAdapter.profilesBaseDir, "p1"), { recursive: true });
  fs.mkdirSync(path.join(fakeAdapter.profilesBaseDir, "p2"), { recursive: true });

  // Fresh cooldown recorded right now (< 30s elapsed)
  recordCooldown(fakeAdapter.id, "p1", "claude", 3600, "Fresh 429");

  // Router should skip probing fresh p1, and select healthy p2
  const decision = await selectProfile(fakeAdapter, [], {}, "auto");
  assert.equal(decision.profile, "p2");
  assert.equal(probeCalls, 0, "fresh cooldown must not trigger probe immediately");
  assert.equal(checkCooldown(fakeAdapter.id, "p1", "claude").cooling, true);
});

test("All-Cooldown Fallback Probe - recovers shortest wait candidate when READY", async () => {
  let probedProfile = "";
  const fakeAdapter = {
    id: "test-adapter-all-cd",
    displayName: "All CD Adapter",
    binaryName: "test-bin",
    defaultBinaryPath: "/bin/true",
    profilesBaseDir: path.join(tmpHome, "profiles", "test-adapter-all-cd"),
    resolveTargetPool: () => "claude",
    getSharedPaths: () => [],
    getAuthStatus: async () => true,
    getQuotaStatus: async () => [{ pool: "claude", state: "READY" }],
    probe: async (prof, pool) => {
      probedProfile = prof;
      return { state: "READY", details: "Quota reset early" };
    }
  };

  fs.mkdirSync(path.join(fakeAdapter.profilesBaseDir, "p1"), { recursive: true });
  fs.mkdirSync(path.join(fakeAdapter.profilesBaseDir, "p2"), { recursive: true });

  // Both in cooldown, p1 has shorter wait (300s vs 3600s)
  recordCooldown(fakeAdapter.id, "p1", "claude", 300, "Shorter cooldown");
  recordCooldown(fakeAdapter.id, "p2", "claude", 3600, "Longer cooldown");

  // All candidates in cooldown -> router probes shortest wait (p1), recovers it, and routes cleanly without allCooldown flag!
  const decision = await selectProfile(fakeAdapter, [], {}, "auto");
  assert.equal(probedProfile, "p1");
  assert.equal(decision.profile, "p1");
  assert.equal(decision.allCooldown, undefined);
  assert.ok(decision.reason.includes("Recovered via all-cooldown fallback probe"));
  assert.equal(checkCooldown(fakeAdapter.id, "p1", "claude").cooling, false);
});

test("Status consistency - auto-probe refreshes stale cooldowns older than 30s and updates to READY", async () => {
  clearStatusProbeCache();
  let probeCalls = 0;
  const fakeAdapter = {
    id: "test-adapter-status",
    displayName: "Status Adapter",
    binaryName: "test-bin",
    defaultBinaryPath: "/bin/true",
    profilesBaseDir: path.join(tmpHome, "profiles", "test-adapter-status"),
    getAuthStatus: async () => true,
    getAccountIdentity: async () => "status-user@example.com",
    getQuotaStatus: async () => [{ pool: "gemini", state: "READY" }],
    probe: async () => {
      probeCalls++;
      return { state: "READY", details: "Quota restored" };
    }
  };

  fs.mkdirSync(path.join(fakeAdapter.profilesBaseDir, "user1"), { recursive: true });

  // Record a cooldown on user1
  recordCooldown(fakeAdapter.id, "user1", "gemini", 1800, "Old lock");
  // Backdate recordedAt by 40s
  const { loadCooldowns, saveCooldowns } = await import("../dist/index.js");
  const cds = loadCooldowns();
  const key = `${fakeAdapter.id}:user1:gemini`;
  cds[key].recordedAt = Date.now() - 40_000;
  saveCooldowns(cds);

  // First status check: auto-probes eligible cooling candidate, sees READY, clears cooldown
  const status1 = await getProviderStatus(fakeAdapter);
  const pool1 = status1[0].pools.find((p) => p.pool === "gemini");
  assert.equal(pool1.state, "READY");
  assert.equal(probeCalls, 1);
  assert.equal(checkCooldown(fakeAdapter.id, "user1", "gemini").cooling, false);

  // Subsequent status check is consistent and remains READY
  const status2 = await getProviderStatus(fakeAdapter);
  const pool2 = status2[0].pools.find((p) => p.pool === "gemini");
  assert.equal(pool2.state, "READY");
});

test("Native Frame Isolation - echoed quota strings in text deltas / tools do not trigger quota detection", () => {
  const echoedConversation = {
    event: "step_update",
    step_update: {
      step_type: "agent_response",
      text_delta: 'Individual quota reached... Resets in 17h52m52s.'
    }
  };
  // isNativeEngineQuotaResult must be false for step_update
  assert.equal(isNativeEngineQuotaResult(echoedConversation), false);

  const syntheticToolResult = {
    event: "step_update",
    step_update: {
      step_type: "tool",
      tool_info: {
        output: '429 Quota exceeded: Resource exhausted'
      }
    }
  };
  assert.equal(isNativeEngineQuotaResult(syntheticToolResult), false);
});

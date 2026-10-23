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
  isNativeEngineQuotaResult,
  cleanupAgyProbeArtifacts
} = await import("../dist/index.js");

test("selectProfile - never opportunistically probes cooling candidate and routes to healthy candidate (zero probe calls)", async () => {
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
    probe: async () => {
      probeCalls++;
      return { state: "READY", details: "Quota restored" };
    }
  };

  fs.mkdirSync(path.join(fakeAdapter.profilesBaseDir, "p1"), { recursive: true });
  fs.mkdirSync(path.join(fakeAdapter.profilesBaseDir, "p2"), { recursive: true });

  // Record a cooldown on p1 with recordedAt 60 seconds in the past
  const entry = recordCooldown(fakeAdapter.id, "p1", "claude", 3600, "Old 429 lock");
  assert.ok(entry);
  const { loadCooldowns, saveCooldowns } = await import("../dist/index.js");
  const cds = loadCooldowns();
  const key = `${fakeAdapter.id}:p1:claude`;
  cds[key].recordedAt = Date.now() - 60_000;
  saveCooldowns(cds);

  assert.equal(checkCooldown(fakeAdapter.id, "p1", "claude").cooling, true);

  // Router must not opportunistically probe p1; it must route to healthy p2 with zero probes
  const decision = await selectProfile(fakeAdapter, [], {}, "auto");
  assert.equal(decision.profile, "p2");
  assert.equal(decision.pool, "claude");
  assert.equal(decision.allCooldown, undefined);
  assert.equal(probeCalls, 0, "selectProfile must make zero probe calls");
  assert.equal(checkCooldown(fakeAdapter.id, "p1", "claude").cooling, true);
});

test("selectProfile - all-cooldown fallback selects shortest wait with allCooldown:true without probing", async () => {
  let probeCalls = 0;
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
    probe: async () => {
      probeCalls++;
      return { state: "READY", details: "Quota reset early" };
    }
  };

  fs.mkdirSync(path.join(fakeAdapter.profilesBaseDir, "p1"), { recursive: true });
  fs.mkdirSync(path.join(fakeAdapter.profilesBaseDir, "p2"), { recursive: true });

  // Both in cooldown, p1 has shorter wait (300s vs 3600s)
  recordCooldown(fakeAdapter.id, "p1", "claude", 300, "Shorter cooldown");
  recordCooldown(fakeAdapter.id, "p2", "claude", 3600, "Longer cooldown");

  // All candidates in cooldown -> router selects shortest wait (p1) with allCooldown: true without probing
  const decision = await selectProfile(fakeAdapter, [], {}, "auto");
  assert.equal(decision.profile, "p1");
  assert.equal(decision.allCooldown, true);
  assert.equal(probeCalls, 0, "all-cooldown fallback must not execute synthetic probe turns");
  assert.equal(checkCooldown(fakeAdapter.id, "p1", "claude").cooling, true);
});

test("getProviderStatus - 100% offline by default (zero probes even on stale cooldowns)", async () => {
  clearStatusProbeCache();
  let probeCalls = 0;
  const fakeAdapter = {
    id: "test-adapter-status-offline",
    displayName: "Status Offline Adapter",
    binaryName: "test-bin",
    defaultBinaryPath: "/bin/true",
    profilesBaseDir: path.join(tmpHome, "profiles", "test-adapter-status-offline"),
    getAuthStatus: async () => true,
    getAccountIdentity: async () => "status-user@example.com",
    getQuotaStatus: async () => [{ pool: "gemini", state: "READY" }],
    probe: async () => {
      probeCalls++;
      return { state: "READY", details: "Quota restored" };
    }
  };

  fs.mkdirSync(path.join(fakeAdapter.profilesBaseDir, "user1"), { recursive: true });

  // Record a cooldown on user1 backdated by 40s
  recordCooldown(fakeAdapter.id, "user1", "gemini", 1800, "Old lock");
  const { loadCooldowns, saveCooldowns } = await import("../dist/index.js");
  const cds = loadCooldowns();
  const key = `${fakeAdapter.id}:user1:gemini`;
  cds[key].recordedAt = Date.now() - 40_000;
  saveCooldowns(cds);

  // Status check without options.probe must make 0 probe calls and show LIMIT
  const status = await getProviderStatus(fakeAdapter);
  const pool = status[0].pools.find((p) => p.pool === "gemini");
  assert.equal(pool.state, "LIMIT");
  assert.equal(probeCalls, 0, "default status check must be 100% offline");
  assert.equal(checkCooldown(fakeAdapter.id, "user1", "gemini").cooling, true);
});

test("getProviderStatus - opt-in { probe: true } runs live probe and clears cooldown on READY", async () => {
  let probeCalls = 0;
  const fakeAdapter = {
    id: "test-adapter-status-optin",
    displayName: "Status Optin Adapter",
    binaryName: "test-bin",
    defaultBinaryPath: "/bin/true",
    profilesBaseDir: path.join(tmpHome, "profiles", "test-adapter-status-optin"),
    getAuthStatus: async () => true,
    getAccountIdentity: async () => "status-user@example.com",
    getQuotaStatus: async () => [{ pool: "gemini", state: "READY" }],
    probe: async () => {
      probeCalls++;
      return { state: "READY", details: "Quota restored" };
    }
  };

  fs.mkdirSync(path.join(fakeAdapter.profilesBaseDir, "user1"), { recursive: true });
  recordCooldown(fakeAdapter.id, "user1", "gemini", 1800, "Active lock");

  // Calling with { probe: true } must run the live probe
  const status = await getProviderStatus(fakeAdapter, { probe: true });
  const pool = status[0].pools.find((p) => p.pool === "gemini");
  assert.equal(pool.state, "READY");
  assert.equal(probeCalls, 1, "explicit probe option must invoke adapter.probe");
  assert.equal(checkCooldown(fakeAdapter.id, "user1", "gemini").cooling, false);
});

test("cleanupAgyProbeArtifacts - deletes conversations db files and brain directory", () => {
  const mockHome = path.join(tmpHome, "cleanup-test-home");
  const geminiDir = path.join(mockHome, ".gemini", "antigravity-cli");
  const convDir = path.join(geminiDir, "conversations");
  const brainDir = path.join(geminiDir, "brain", "conv-uuid-1234");
  fs.mkdirSync(convDir, { recursive: true });
  fs.mkdirSync(brainDir, { recursive: true });

  const files = [
    path.join(convDir, "conv-uuid-1234.db"),
    path.join(convDir, "conv-uuid-1234.db-wal"),
    path.join(convDir, "conv-uuid-1234.db-shm"),
    path.join(convDir, "conv-uuid-1234.lock"),
    path.join(convDir, "conv-uuid-1234.pbtxt"),
    path.join(brainDir, "transcript.jsonl")
  ];
  for (const f of files) {
    fs.writeFileSync(f, "mock-data");
  }

  // Preconditions: files exist
  for (const f of files) {
    assert.equal(fs.existsSync(f), true, `${f} must exist initially`);
  }
  assert.equal(fs.existsSync(brainDir), true);

  cleanupAgyProbeArtifacts("conv-uuid-1234", [mockHome]);

  // All probe artifacts must be cleaned up
  for (const f of files) {
    assert.equal(fs.existsSync(f), false, `${f} must be deleted`);
  }
  assert.equal(fs.existsSync(brainDir), false, "brain directory must be deleted");
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

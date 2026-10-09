import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Isolated AGENT_MUX_HOME so cooldown state never touches the real home.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mux-policy-test-"));
process.env.AGENT_MUX_HOME = tmpHome;

const {
  selectProfile,
  buildCandidateOrder,
  recordCooldown,
  clearAllCooldowns,
  getRoutingPolicy
} = await import("../dist/index.js");

const PROVIDER = "policy-test";
const PROFILES = ["a1", "a2"];
const POOLS = ["gemini", "claude"];
const TARGET_POOL = "gemini";

function makeAdapter(quotaByProfile = {}) {
  return {
    id: PROVIDER,
    displayName: "Policy Test",
    binaryName: "policy-test-bin",
    defaultBinaryPath: "/bin/true",
    profilesBaseDir: path.join(tmpHome, "profiles", PROVIDER),
    resolveTargetPool: () => TARGET_POOL,
    getSupportedPools: () => POOLS,
    getPoolModel: (pool) => (pool === "claude" ? "claude-test" : "gemini-test"),
    getSharedPaths: () => [],
    getAuthStatus: async () => true,
    getQuotaStatus: async (profile) =>
      quotaByProfile[profile] ?? [
        { pool: "gemini", state: "READY" },
        { pool: "claude", state: "READY" }
      ]
  };
}

for (const profile of PROFILES) {
  fs.mkdirSync(path.join(tmpHome, "profiles", PROVIDER, profile), { recursive: true });
}

function keys(decision) {
  return `${decision.profile}:${decision.pool}`;
}

test.beforeEach(() => {
  clearAllCooldowns();
});

test("buildCandidateOrder - matrix ordering per policy", () => {
  const strict = buildCandidateOrder(PROFILES, "gemini", ["claude"], "pool-strict");
  assert.deepEqual(strict, [
    { profile: "a1", pool: "gemini" },
    { profile: "a2", pool: "gemini" }
  ]);

  const spillover = buildCandidateOrder(PROFILES, "gemini", ["claude"], "pool-spillover");
  assert.deepEqual(spillover, [
    { profile: "a1", pool: "gemini" },
    { profile: "a2", pool: "gemini" },
    { profile: "a1", pool: "claude" },
    { profile: "a2", pool: "claude" }
  ]);

  const accountFirst = buildCandidateOrder(PROFILES, "gemini", ["claude"], "account-first");
  assert.deepEqual(accountFirst, [
    { profile: "a1", pool: "gemini" },
    { profile: "a1", pool: "claude" },
    { profile: "a2", pool: "gemini" },
    { profile: "a2", pool: "claude" }
  ]);
});

test("pool-strict - exhausts target pool then HALTS (never spills over)", async () => {
  const adapter = makeAdapter();
  recordCooldown(adapter.id, "a1", "gemini", 3600, "quota");
  recordCooldown(adapter.id, "a2", "gemini", 3600, "quota");

  const decision = await selectProfile(adapter, [], {}, "auto", [], "pool-strict");
  assert.equal(decision.allCooldown, true);
  assert.equal(decision.pool, "gemini");
});

test("pool-strict - selects healthy target-pool profile in order", async () => {
  const adapter = makeAdapter();
  recordCooldown(adapter.id, "a1", "gemini", 3600, "quota");

  const decision = await selectProfile(adapter, [], {}, "auto", [], "pool-strict");
  assert.equal(keys(decision), "a2:gemini");
  assert.equal(decision.allCooldown, undefined);
});

test("pool-spillover - exhausts target pool across profiles then spills to other pool", async () => {
  const adapter = makeAdapter();
  recordCooldown(adapter.id, "a1", "gemini", 3600, "quota");
  recordCooldown(adapter.id, "a2", "gemini", 3600, "quota");

  const decision = await selectProfile(adapter, [], {}, "auto", [], "pool-spillover");
  assert.equal(keys(decision), "a1:claude");
  assert.equal(decision.allCooldown, undefined);
});

test("pool-spillover - respects per-pool cooldowns while spilling", async () => {
  const adapter = makeAdapter();
  recordCooldown(adapter.id, "a1", "gemini", 3600, "quota");
  recordCooldown(adapter.id, "a2", "gemini", 3600, "quota");
  recordCooldown(adapter.id, "a1", "claude", 3600, "quota");

  const decision = await selectProfile(adapter, [], {}, "auto", [], "pool-spillover");
  assert.equal(keys(decision), "a2:claude");
});

test("pool-spillover - HALTS when every candidate is cooled", async () => {
  const adapter = makeAdapter();
  for (const profile of PROFILES) {
    for (const pool of POOLS) {
      recordCooldown(adapter.id, profile, pool, 3600, "quota");
    }
  }

  const decision = await selectProfile(adapter, [], {}, "auto", [], "pool-spillover");
  assert.equal(decision.allCooldown, true);
});

test("account-first - tries target then other pool on the same profile first", async () => {
  const adapter = makeAdapter();
  recordCooldown(adapter.id, "a1", "gemini", 3600, "quota");

  const decision = await selectProfile(adapter, [], {}, "auto", [], "account-first");
  assert.equal(keys(decision), "a1:claude");
});

test("account-first - advances to next profile before other pool of a fully cooled profile", async () => {
  const adapter = makeAdapter();
  recordCooldown(adapter.id, "a1", "gemini", 3600, "quota");
  recordCooldown(adapter.id, "a1", "claude", 3600, "quota");

  const decision = await selectProfile(adapter, [], {}, "auto", [], "account-first");
  assert.equal(keys(decision), "a2:gemini");
});

test("account-first - HALTS when all profile/pool candidates are cooled", async () => {
  const adapter = makeAdapter();
  for (const profile of PROFILES) {
    for (const pool of POOLS) {
      recordCooldown(adapter.id, profile, pool, 3600, "quota");
    }
  }

  const decision = await selectProfile(adapter, [], {}, "auto", [], "account-first");
  assert.equal(decision.allCooldown, true);
});

test("excluded candidates gate selection (supervisor tried-set)", async () => {
  const adapter = makeAdapter();

  const d1 = await selectProfile(adapter, [], {}, "auto", ["a1:gemini"], "account-first");
  assert.equal(keys(d1), "a1:claude");

  const d2 = await selectProfile(
    adapter,
    [],
    {},
    "auto",
    ["a1:gemini", "a1:claude"],
    "account-first"
  );
  assert.equal(keys(d2), "a2:gemini");

  const d3 = await selectProfile(
    adapter,
    [],
    {},
    "auto",
    ["a1:gemini", "a1:claude", "a2:gemini"],
    "account-first"
  );
  assert.equal(keys(d3), "a2:claude");

  const d4 = await selectProfile(
    adapter,
    [],
    {},
    "auto",
    ["a1:gemini", "a1:claude", "a2:gemini", "a2:claude"],
    "account-first"
  );
  assert.equal(d4.allCooldown, true);
});

test("live quota LIMIT gates selection without persisted cooldown", async () => {
  const adapter = makeAdapter({
    a1: [
      { pool: "gemini", state: "LIMIT", remainingSeconds: 1200 },
      { pool: "claude", state: "READY" }
    ]
  });

  const spillover = await selectProfile(adapter, [], {}, "auto", [], "pool-spillover");
  assert.equal(keys(spillover), "a2:gemini");

  const strict = await selectProfile(adapter, [], {}, "auto", [], "pool-strict");
  assert.equal(keys(strict), "a2:gemini");
});

test("getRoutingPolicy - env override, then config file, then pool-strict default", () => {
  const configPath = path.join(tmpHome, "config.json");

  // Default
  assert.equal(getRoutingPolicy(), "pool-strict");

  // Config file
  fs.writeFileSync(configPath, JSON.stringify({ routingPolicy: "account-first" }));
  assert.equal(getRoutingPolicy(), "account-first");

  // Env override wins over config
  process.env.AGENT_MUX_ROUTING_POLICY = "pool-spillover";
  assert.equal(getRoutingPolicy(), "pool-spillover");

  // Invalid env is ignored and falls through to config
  process.env.AGENT_MUX_ROUTING_POLICY = "nonsense";
  assert.equal(getRoutingPolicy(), "account-first");

  delete process.env.AGENT_MUX_ROUTING_POLICY;
  fs.rmSync(configPath, { force: true });
  assert.equal(getRoutingPolicy(), "pool-strict");
});

test("AGY_NON_PROMPT_SUBCOMMANDS contains non-prompt subcommands like models, help, mcp", async () => {
  const { AGY_NON_PROMPT_SUBCOMMANDS } = await import("../dist/index.js");
  assert.ok(AGY_NON_PROMPT_SUBCOMMANDS.has("models"));
  assert.ok(AGY_NON_PROMPT_SUBCOMMANDS.has("help"));
  assert.ok(AGY_NON_PROMPT_SUBCOMMANDS.has("version") === false); // agy has --version flag, not subcommand
  assert.ok(AGY_NON_PROMPT_SUBCOMMANDS.has("mcp"));
  assert.ok(AGY_NON_PROMPT_SUBCOMMANDS.has("agent"));
});

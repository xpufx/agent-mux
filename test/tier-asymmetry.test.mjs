import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import {
  AntigravityAdapter,
  getProfileSupportedPools,
  isProfileEntitledForPool,
  buildCandidateOrder,
  selectProfile,
  isEntitlementError,
  isNativeEngineEntitlementResult,
  parseResetDurationSeconds,
  checkCooldown,
  clearAllCooldowns,
  runSupervisor
} from "../dist/index.js";

const tmpHome = path.join(os.tmpdir(), `agent-mux-tier-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
fs.mkdirSync(tmpHome, { recursive: true });

test.beforeEach(() => {
  clearAllCooldowns();
});

test("AntigravityAdapter - Argon / Ultra pool routing and model mapping", () => {
  const adapter = new AntigravityAdapter();

  // 1. Supported pools include ultra
  assert.deepEqual(adapter.getSupportedPools(), ["gemini", "claude", "ultra"]);

  // 2. Normalization
  assert.equal(adapter.normalizePool?.("argon"), "ultra");
  assert.equal(adapter.normalizePool?.("ARGON"), "ultra");
  assert.equal(adapter.normalizePool?.("ultra"), "ultra");
  assert.equal(adapter.normalizePool?.("gemini"), "gemini");

  // 3. Pool model mapping
  assert.equal(adapter.getPoolModel?.("ultra"), "argon");
  assert.equal(adapter.getPoolModel?.("argon"), "argon");
  assert.equal(adapter.getPoolModel?.("gemini"), "gemini-3.8-flash-low");
  assert.equal(adapter.getPoolModel?.("claude"), "claude-sonnet-5-5-low");

  // 4. Target pool resolution from CLI flags
  assert.equal(adapter.resolveTargetPool(["--model", "argon"], {}), "ultra");
  assert.equal(adapter.resolveTargetPool(["--model=argon"], {}), "ultra");
  assert.equal(adapter.resolveTargetPool(["-m", "argon"], {}), "ultra");
  assert.equal(adapter.resolveTargetPool(["--model", "gemini-ultra-preview"], {}), "ultra");
  assert.equal(adapter.resolveTargetPool(["--model", "claude-3-5-sonnet"], {}), "claude");
  assert.equal(adapter.resolveTargetPool(["--model", "gemini-2.5-flash"], {}), "gemini");
  assert.equal(adapter.resolveTargetPool([], { AGY_TARGET_POOL: "ultra" }), "ultra");
  assert.equal(adapter.resolveTargetPool([], { AGY_TARGET_POOL: "argon" }), "ultra");
  assert.equal(adapter.resolveTargetPool([], { AGY_TARGET_POOL: "claude" }), "claude");

  // 5. Model catalog includes argon
  return adapter.listModels().then((models) => {
    assert.ok(models.includes("argon"), "catalog must include argon");
  });
});

test("getProfileSupportedPools & isProfileEntitledForPool - dictionary format", () => {
  const adapter = new AntigravityAdapter();
  const config = {
    profiles: {
      antigravity: {
        puf: { pools: ["gemini", "claude", "argon"] },
        okt: { pools: ["gemini", "claude"] }
      }
    }
  };

  // puf supports argon, which normalizes to ultra
  const pufPools = getProfileSupportedPools("antigravity", "puf", adapter, config);
  assert.deepEqual(pufPools, ["gemini", "claude", "ultra"]);
  assert.equal(isProfileEntitledForPool(adapter, "puf", "ultra", config), true);
  assert.equal(isProfileEntitledForPool(adapter, "puf", "argon", config), true);
  assert.equal(isProfileEntitledForPool(adapter, "puf", "gemini", config), true);
  assert.equal(isProfileEntitledForPool(adapter, "puf", "claude", config), true);

  // okt does not support ultra/argon
  const oktPools = getProfileSupportedPools("antigravity", "okt", adapter, config);
  assert.deepEqual(oktPools, ["gemini", "claude"]);
  assert.equal(isProfileEntitledForPool(adapter, "okt", "ultra", config), false);
  assert.equal(isProfileEntitledForPool(adapter, "okt", "argon", config), false);
  assert.equal(isProfileEntitledForPool(adapter, "okt", "gemini", config), true);
  assert.equal(isProfileEntitledForPool(adapter, "okt", "claude", config), true);

  // unconfigured profile has no restrictions (supports all)
  const unknownPools = getProfileSupportedPools("antigravity", "anonymous", adapter, config);
  assert.equal(unknownPools, undefined);
  assert.equal(isProfileEntitledForPool(adapter, "anonymous", "ultra", config), true);
});

test("getProfileSupportedPools & isProfileEntitledForPool - array format", () => {
  const adapter = new AntigravityAdapter();
  const config = {
    profiles: [
      { provider: "antigravity", name: "puf", pools: ["gemini", "claude", "ultra"] },
      { provider: "antigravity", name: "okt", pools: ["gemini"] }
    ]
  };

  assert.equal(isProfileEntitledForPool(adapter, "puf", "ultra", config), true);
  assert.equal(isProfileEntitledForPool(adapter, "okt", "ultra", config), false);
  assert.equal(isProfileEntitledForPool(adapter, "okt", "claude", config), false);
  assert.equal(isProfileEntitledForPool(adapter, "okt", "gemini", config), true);
});

test("buildCandidateOrder - filters candidates by profile entitlement", () => {
  const profiles = ["puf", "okt"];
  const isEntitled = (prof, pool) => {
    if (prof === "okt" && pool === "ultra") return false;
    return true;
  };

  // pool-strict with ultra: okt is pruned
  const strict = buildCandidateOrder(profiles, "ultra", ["gemini", "claude"], "pool-strict", isEntitled);
  assert.deepEqual(strict, [{ profile: "puf", pool: "ultra" }]);

  // pool-spillover: okt is excluded from ultra, but included in gemini and claude
  const spillover = buildCandidateOrder(profiles, "ultra", ["gemini", "claude"], "pool-spillover", isEntitled);
  assert.deepEqual(spillover, [
    { profile: "puf", pool: "ultra" },
    { profile: "puf", pool: "gemini" },
    { profile: "okt", pool: "gemini" },
    { profile: "puf", pool: "claude" },
    { profile: "okt", pool: "claude" }
  ]);

  // account-first: okt:ultra is pruned
  const accountFirst = buildCandidateOrder(profiles, "ultra", ["gemini", "claude"], "account-first", isEntitled);
  assert.deepEqual(accountFirst, [
    { profile: "puf", pool: "ultra" },
    { profile: "puf", pool: "gemini" },
    { profile: "puf", pool: "claude" },
    { profile: "okt", pool: "gemini" },
    { profile: "okt", pool: "claude" }
  ]);
});

test("selectProfile - asymmetric model routing: requesting argon selects only entitled profiles", async () => {
  const caseProfilesDir = path.join(tmpHome, "profiles", "antigravity");
  fs.mkdirSync(path.join(caseProfilesDir, "puf"), { recursive: true });
  fs.mkdirSync(path.join(caseProfilesDir, "okt"), { recursive: true });

  const adapter = {
    id: "antigravity",
    displayName: "Google Antigravity",
    binaryName: "agy",
    defaultBinaryPath: "/bin/true",
    profilesBaseDir: caseProfilesDir,
    resolveTargetPool: () => "ultra",
    getSupportedPools: () => ["gemini", "claude", "ultra"],
    normalizePool: (p) => (p.toLowerCase() === "argon" ? "ultra" : p),
    getPoolModel: (pool) => (pool === "ultra" ? "argon" : "gemini-test"),
    getSharedPaths: () => [],
    getAuthStatus: async () => true,
    getQuotaStatus: async () => [
      { pool: "gemini", state: "READY" },
      { pool: "claude", state: "READY" },
      { pool: "ultra", state: "READY" }
    ]
  };

  const config = {
    profiles: {
      antigravity: {
        puf: { pools: ["gemini", "claude", "ultra"] },
        okt: { pools: ["gemini", "claude"] }
      }
    }
  };

  // 1. Auto selection routes to puf
  const decision1 = await selectProfile(
    adapter,
    ["--model", "argon"],
    {},
    "auto",
    [],
    "pool-strict",
    undefined,
    undefined,
    config
  );
  assert.equal(decision1.profile, "puf");
  assert.equal(decision1.pool, "ultra");

  // 2. Round-robin mode still selects only puf (never okt)
  const decision2 = await selectProfile(
    adapter,
    ["--model", "argon"],
    {},
    "round-robin",
    [],
    "pool-strict",
    undefined,
    undefined,
    config
  );
  assert.equal(decision2.profile, "puf");
  assert.equal(decision2.pool, "ultra");

  // 3. Explicit --pool argon normalizes to ultra and routes to puf
  const decision3 = await selectProfile(
    adapter,
    [],
    {},
    "auto",
    [],
    "pool-strict",
    "argon",
    undefined,
    config
  );
  assert.equal(decision3.profile, "puf");
  assert.equal(decision3.pool, "ultra");

  // 4. When no profiles support the requested pool, halts cleanly with allCooldown: true
  const noEntitlementConfig = {
    profiles: {
      antigravity: {
        puf: { pools: ["gemini"] },
        okt: { pools: ["gemini"] }
      }
    }
  };
  const decision4 = await selectProfile(
    adapter,
    ["--model", "argon"],
    {},
    "auto",
    [],
    "pool-strict",
    undefined,
    undefined,
    noEntitlementConfig
  );
  assert.equal(decision4.allCooldown, true);
  assert.ok(decision4.reason.includes("No profiles entitled for pool 'ultra'"));
});

test("isEntitlementError - accurately classifies 403 / PERMISSION_DENIED without matching 429", () => {
  // True for entitlement errors
  assert.equal(isEntitlementError("403 Forbidden"), true);
  assert.equal(isEntitlementError("HTTP 403: Forbidden"), true);
  assert.equal(isEntitlementError("PERMISSION_DENIED"), true);
  assert.equal(isEntitlementError("Error: permission denied for requested model"), true);
  assert.equal(isEntitlementError("Model not available for tier"), true);
  assert.equal(isEntitlementError("Model argon is not available for your tier"), true);
  assert.equal(isEntitlementError("requires Ultra subscription"), true);
  assert.equal(isEntitlementError({ code: 403, message: "PERMISSION_DENIED: Model argon requires ultra" }), true);

  // False for normal rate-limits / 429s / capacity errors
  assert.equal(isEntitlementError("Error 429: Quota exceeded"), false);
  assert.equal(isEntitlementError("RESOURCE_EXHAUSTED"), false);
  assert.equal(isEntitlementError("HTTP 503 Service Unavailable"), false);
  assert.equal(isEntitlementError(""), false);
  assert.equal(isEntitlementError(null), false);

  // parseResetDurationSeconds returns 0 for entitlement errors (no false quota cooldown duration)
  assert.equal(parseResetDurationSeconds("403 Forbidden. Resets in 24h."), 0);
  assert.equal(parseResetDurationSeconds("PERMISSION_DENIED: Model not available for tier. Resets in 2h."), 0);
});

test("isNativeEngineEntitlementResult - detects engine result frames with entitlement errors", () => {
  const resultFrame = {
    event: "result",
    result: {
      status: "ERROR",
      error: "403 Forbidden: PERMISSION_DENIED. Model not available for tier."
    }
  };
  assert.equal(isNativeEngineEntitlementResult(resultFrame), true);

  const quotaFrame = {
    event: "result",
    result: {
      status: "ERROR",
      error: "Error 429: Quota exceeded for gemini pool. Resets in 1h."
    }
  };
  assert.equal(isNativeEngineEntitlementResult(quotaFrame), false);

  const abortFrame = {
    event: "result",
    agent_mux_failover_abort: true,
    result: {
      status: "ERROR",
      error: "Turn interrupted by agent-mux failover"
    }
  };
  assert.equal(isNativeEngineEntitlementResult(abortFrame), false);
});

test("supervisor Option C - 403 / PERMISSION_DENIED triggers failover without recording quota cooldown", async () => {
  const caseDir = path.join(tmpHome, "supervisor-entitlement-test");
  const profilesDir = path.join(caseDir, "profiles", "antigravity");
  fs.mkdirSync(path.join(profilesDir, "okt"), { recursive: true });
  fs.mkdirSync(path.join(profilesDir, "puf"), { recursive: true });

  // Child script:
  // - okt emits 403 PERMISSION_DENIED on user message
  // - puf succeeds
  const childScript = path.join(caseDir, "child.mjs");
  fs.writeFileSync(
    childScript,
    `import readline from "node:readline";\n` +
    `const prof = process.env.TEST_PROFILE || "unknown";\n` +
    `console.log(JSON.stringify({ event: "init", conversation_id: "conv-1" }));\n` +
    `const rl = readline.createInterface({ input: process.stdin });\n` +
    `rl.on("line", (line) => {\n` +
    `  try {\n` +
    `    const d = JSON.parse(line);\n` +
    `    if (d.event === "user") {\n` +
    `      if (prof === "okt") {\n` +
    `        console.log(JSON.stringify({\n` +
    `          event: "result",\n` +
    `          result: {\n` +
    `            status: "ERROR",\n` +
    `            error: "403 Forbidden: PERMISSION_DENIED. Model argon is not available for tier."\n` +
    `          }\n` +
    `        }));\n` +
    `      } else {\n` +
    `        console.log(JSON.stringify({\n` +
    `          event: "step_update",\n` +
    `          step_update: { step_type: "agent_response", text_delta: "Hello from entitled puf!" }\n` +
    `        }));\n` +
    `        console.log(JSON.stringify({\n` +
    `          event: "result",\n` +
    `          result: { status: "SUCCESS" }\n` +
    `        }));\n` +
    `      }\n` +
    `    }\n` +
    `  } catch {}\n` +
    `});\n`
  );

  const adapter = {
    id: "antigravity",
    displayName: "Google Antigravity",
    binaryName: "agy",
    defaultBinaryPath: process.execPath,
    profilesBaseDir: profilesDir,
    resolveTargetPool: () => "ultra",
    getSupportedPools: () => ["gemini", "claude", "ultra"],
    normalizePool: (p) => (p === "argon" ? "ultra" : p),
    getPoolModel: (pool) => (pool === "ultra" ? "argon" : "gemini-test"),
    getSharedPaths: () => [],
    getAuthStatus: async () => true,
    getAccountIdentity: async (p) => `${p}@example.com`,
    getQuotaStatus: async () => [
      { pool: "gemini", state: "READY" },
      { pool: "claude", state: "READY" },
      { pool: "ultra", state: "READY" }
    ],
    prepareExecution: (profile, args, env) => ({
      binary: process.execPath,
      args: [childScript, ...args],
      env: { ...env, TEST_PROFILE: profile }
    })
  };

  // Run driver in a subprocess to test runSupervisor
  const driverScript = path.join(caseDir, "driver.mjs");
  const distIndex = path.resolve("dist/index.js");
  fs.writeFileSync(
    driverScript,
    `import { runSupervisor, checkCooldown } from ${JSON.stringify(distIndex)};\n` +
    `const adapter = ${JSON.stringify({
      id: adapter.id,
      displayName: adapter.displayName,
      binaryName: adapter.binaryName,
      defaultBinaryPath: adapter.defaultBinaryPath,
      profilesBaseDir: adapter.profilesBaseDir
    })};\n` +
    `adapter.resolveTargetPool = () => "ultra";\n` +
    `adapter.getSupportedPools = () => ["gemini", "claude", "ultra"];\n` +
    `adapter.normalizePool = (p) => (p === "argon" ? "ultra" : p);\n` +
    `adapter.getPoolModel = (p) => (p === "ultra" ? "argon" : "gemini-test");\n` +
    `adapter.getSharedPaths = () => [];\n` +
    `adapter.getAuthStatus = async () => true;\n` +
    `adapter.getQuotaStatus = async () => [\n` +
    `  { pool: "gemini", state: "READY" },\n` +
    `  { pool: "claude", state: "READY" },\n` +
    `  { pool: "ultra", state: "READY" }\n` +
    `];\n` +
    `adapter.prepareExecution = (profile, args, env) => ({\n` +
    `  binary: process.execPath,\n` +
    `  args: [${JSON.stringify(childScript)}, ...args],\n` +
    `  env: { ...env, TEST_PROFILE: profile }\n` +
    `});\n` +
    `const code = await runSupervisor({\n` +
    `  adapter,\n` +
    `  initialProfile: "okt",\n` +
    `  initialPool: "ultra",\n` +
    `  binaryPath: process.execPath,\n` +
    `  args: ["--model", "argon"],\n` +
    `  env: { ...process.env }\n` +
    `});\n` +
    `process.exit(code);\n`
  );

  const proc = spawn(process.execPath, [driverScript], {
    env: { ...process.env, AGENT_MUX_KILL_GRACE_MS: "300" },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  proc.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  // Send turn
  proc.stdin.write(JSON.stringify({ event: "user", message: { content: "ping" } }) + "\n");

  await new Promise((resolve) => setTimeout(resolve, 800));
  proc.stdin.end();

  const exitCode = await new Promise((resolve) => {
    proc.on("exit", resolve);
  });

  assert.equal(exitCode, 0, "Supervisor should succeed after failing over to puf");
  assert.ok(stdout.includes("Hello from entitled puf!"), "Puf should execute successfully");

  // Verify Option C: okt MUST NOT have a quota cooldown recorded!
  const oktCooldown = checkCooldown("antigravity", "okt", "ultra");
  assert.equal(oktCooldown.cooling, false, "okt must NOT be assigned a quota cooldown after 403 entitlement error");
});

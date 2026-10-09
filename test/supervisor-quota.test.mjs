import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Workspace-scoped scratch: never touch global /tmp or the real home.
const here = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(path.join(here, "..", ".tmp"), { recursive: true });
const tmpHome = fs.mkdtempSync(path.join(here, "..", ".tmp", "supervisor-quota-"));
process.env.AGENT_MUX_HOME = tmpHome;

const {
  isQuotaError,
  isProcessCrashQuotaError,
  errorTextOf,
  parseResetDurationSeconds,
  recordCooldown,
  checkCooldown,
  clearAllCooldowns,
  selectProfile,
  getProviderStatus
} = await import("../dist/index.js");

const PROVIDER = "antigravity";
const PROFILES = ["okprofile", "otherprofile"];
const POOLS = ["gemini", "claude"];

// Mirrors AntigravityAdapter.getQuotaStatus: hardcoded READY. Any LIMIT in
// `status` output must therefore come from a persisted stream-failure
// cooldown — exactly the staleness shape from #21.
function makeAdapter() {
  return {
    id: PROVIDER,
    displayName: "Google Antigravity",
    binaryName: "agy",
    defaultBinaryPath: "/bin/true",
    profilesBaseDir: path.join(tmpHome, "profiles", PROVIDER),
    resolveTargetPool: () => "gemini",
    getSupportedPools: () => POOLS,
    getPoolModel: (pool) => (pool === "claude" ? "claude-test" : "gemini-test"),
    getSharedPaths: () => [],
    getAuthStatus: async () => true,
    getAccountIdentity: async (profile) => `${profile}@example.com`,
    getQuotaStatus: async () => [
      { pool: "gemini", state: "READY" },
      { pool: "claude", state: "READY" }
    ]
  };
}

for (const profile of PROFILES) {
  fs.mkdirSync(path.join(tmpHome, "profiles", PROVIDER, profile), { recursive: true });
}

test.beforeEach(() => {
  clearAllCooldowns();
});

test("isQuotaError - legacy string shapes still detected", () => {
  assert.equal(isQuotaError("RESOURCE_EXHAUSTED (code 429)"), true);
  assert.equal(isQuotaError("request failed with code 429"), true);
  assert.equal(isQuotaError("got status 429 from server"), true);
  assert.equal(isQuotaError("HTTP 429 Too Many Requests"), true);
  assert.equal(isQuotaError("ERR_QUOTA_EXCEEDED"), true);
});

test("isQuotaError - supervised-turn failure vocabulary detected", () => {
  assert.equal(isQuotaError("Error 429: quota exhausted"), true);
  assert.equal(isQuotaError("[AGY 429] request denied"), true);
  assert.equal(isQuotaError("Rate limit exceeded, retry later"), true);
  assert.equal(isQuotaError("rate_limit_exceeded for model"), true);
  assert.equal(isQuotaError("RATE-LIMIT hit on account"), true);
  assert.equal(isQuotaError("quota_exceeded: daily budget gone"), true);
  assert.equal(isQuotaError("Quota exceeded for gemini pool"), true);
  assert.equal(isQuotaError("quota exhausted, resets in 3h3m4s"), true);
  assert.equal(isQuotaError("insufficient quota to complete turn"), true);
  assert.equal(isQuotaError("Resource exhausted, please retry"), true);
  assert.equal(isQuotaError("429 Too Many Requests"), true);
});

test("isQuotaError - structured engine payloads detected (no [object Object] collapse)", () => {
  assert.equal(isQuotaError({ code: 429, message: "quota exceeded" }), true);
  assert.equal(
    isQuotaError({ event: "error", error: { code: 429, message: "slow down" } }),
    true
  );
  assert.equal(isQuotaError({ status: "RESOURCE_EXHAUSTED" }), true);
  assert.equal(isQuotaError({ error_code: 429 }), true);
  assert.equal(isQuotaError({ message: "Rate limit exceeded" }), true);
});

test("isQuotaError - healthy and non-quota failures stay READY (no false LIMIT)", () => {
  assert.equal(isQuotaError(""), false);
  assert.equal(isQuotaError(undefined), false);
  assert.equal(isQuotaError(null), false);
  assert.equal(isQuotaError("SUCCESS"), false);
  assert.equal(isQuotaError("Done"), false);
  assert.equal(isQuotaError({}), false);
  assert.equal(isQuotaError({ message: "ok" }), false);
  assert.equal(isQuotaError("model not found: gemini-3-flash"), false);
  assert.equal(isQuotaError("connection reset by peer"), false);
  assert.equal(isQuotaError("Error: input too long"), false);
  assert.equal(isQuotaError("Error 500: internal error"), false);
  assert.equal(isQuotaError("exit code 1"), false);
  // 429 must match as a token, not as a substring of a larger number.
  assert.equal(isQuotaError("Processed 4290 records"), false);
  // Transient capacity wording without a quota signal must not cool the account.
  assert.equal(isQuotaError("model overloaded, try again"), false);
});

test("errorTextOf - structured payloads stay readable for cooldown reasons", () => {
  assert.equal(errorTextOf("plain string"), "plain string");
  assert.equal(errorTextOf(429), "429");
  const details = errorTextOf({ code: 429, message: "Quota exceeded" });
  assert.ok(details.includes("429"), `got: ${details}`);
  assert.ok(details.includes("Quota exceeded"), `got: ${details}`);
  assert.ok(!details.includes("[object Object]"), `got: ${details}`);
  assert.equal(errorTextOf(undefined), "");
});

test("isProcessCrashQuotaError - legacy and broadened stderr shapes", () => {
  const legacy = [
    "some engine noise",
    "RESOURCE_EXHAUSTED (code 429) quota failure"
  ];
  assert.ok(isProcessCrashQuotaError(legacy)?.includes("RESOURCE_EXHAUSTED"));
  assert.equal(
    isProcessCrashQuotaError(["boot ok", "agy_error: something resource_exhausted"]),
    "agy_error: something resource_exhausted"
  );
  assert.equal(
    isProcessCrashQuotaError(['frame {"status":"resource_exhausted"}']),
    'frame {"status":"resource_exhausted"}'
  );
  assert.equal(
    isProcessCrashQuotaError(['frame {"error_code":429}']),
    'frame {"error_code":429}'
  );
  assert.equal(
    isProcessCrashQuotaError(["turn ok", "Rate limit exceeded on account"]),
    "Rate limit exceeded on account"
  );
  assert.equal(
    isProcessCrashQuotaError(["boot ok", "exit code 1", "connection reset"]),
    undefined
  );
});

test("failure -> persisted cooldown -> status overlay shows LIMIT (#21)", async () => {
  const adapter = makeAdapter();

  // Baseline: hardcoded READY, no cooldown -> status shows READY (the stale shape).
  const before = await getProviderStatus(adapter);
  const beforePool = before
    .find((p) => p.profile === "okprofile")
    .pools.find((q) => q.pool === "gemini");
  assert.equal(beforePool.state, "READY");

  // Simulate what the supervisor does when a stream turn fails with quota:
  // detect on the frame payload, then persist provider:profile:pool cooldown.
  const frame = {
    event: "result",
    result: {
      status: "ERROR",
      error: "Error 429: Quota exceeded for gemini pool. Resets in 3h3m4s."
    }
  };
  assert.equal(isQuotaError(frame.result.error), true);
  const details = errorTextOf(frame.result.error);
  recordCooldown(
    adapter.id,
    "okprofile",
    "gemini",
    parseResetDurationSeconds(details),
    details
  );

  // Cooldown is keyed provider:profile:pool — siblings untouched.
  assert.equal(checkCooldown(adapter.id, "okprofile", "gemini").cooling, true);
  assert.equal(checkCooldown(adapter.id, "okprofile", "claude").cooling, false);
  assert.equal(checkCooldown(adapter.id, "otherprofile", "gemini").cooling, false);

  // Afterwards `status` must show LIMIT without any manual probe.
  const after = await getProviderStatus(adapter);
  const limited = after
    .find((p) => p.profile === "okprofile")
    .pools.find((q) => q.pool === "gemini");
  assert.equal(limited.state, "LIMIT");
  assert.ok(limited.remainingSeconds > 0);
  assert.ok(limited.details.includes("remaining"), `got: ${limited.details}`);
  const sibling = after
    .find((p) => p.profile === "okprofile")
    .pools.find((q) => q.pool === "claude");
  assert.equal(sibling.state, "READY");

  // Router steers around the cooled candidate.
  const decision = await selectProfile(adapter, [], {}, "auto", [], "pool-strict");
  assert.equal(decision.profile, "otherprofile");
  assert.equal(decision.pool, "gemini");
});

test("failure with structured object error persists a readable cooldown (#21)", async () => {
  const adapter = makeAdapter();

  const errorPayload = { code: 429, message: "Quota exceeded for claude pool" };
  assert.equal(isQuotaError(errorPayload), true);
  const details = errorTextOf(errorPayload);
  assert.ok(!details.includes("[object Object]"));
  recordCooldown(adapter.id, "okprofile", "claude", 3600, details);

  const stored = checkCooldown(adapter.id, "okprofile", "claude");
  assert.equal(stored.cooling, true);
  assert.ok(stored.reason.includes("429"), `got: ${stored.reason}`);

  const status = await getProviderStatus(adapter);
  const limited = status
    .find((p) => p.profile === "okprofile")
    .pools.find((q) => q.pool === "claude");
  assert.equal(limited.state, "LIMIT");
});

test("status is instant by default and probe is opt-in via options.probe (#25)", async () => {
  let probes = 0;
  const adapter = {
    ...makeAdapter(),
    probe: async () => {
      probes++;
      return { state: "READY", details: "Confirmed ready" };
    }
  };

  assert.equal(parseResetDurationSeconds("Quota exceeded. Resets in 54m."), 54 * 60);
  assert.equal(parseResetDurationSeconds("Quota exceeded. Resets in 1d2h3m4s."), 93784);
  recordCooldown(
    adapter.id,
    "okprofile",
    "gemini",
    parseResetDurationSeconds("Quota exceeded. Resets in 54m."),
    "Quota exceeded. Resets in 54m."
  );

  // 1. By default, status is instant (<10ms) and does NOT perform network probes
  const defaultStatus = await getProviderStatus(adapter);
  const geminiDefault = defaultStatus
    .find((p) => p.profile === "okprofile")
    .pools.find((q) => q.pool === "gemini");

  assert.equal(probes, 0, "Default status must not probe network");
  assert.equal(geminiDefault.state, "LIMIT");
  assert.equal(checkCooldown(adapter.id, "okprofile", "gemini").cooling, true);

  // 2. Opt-in probe reconciles early reset
  const probedStatus = await getProviderStatus(adapter, { probe: true });
  const geminiProbed = probedStatus
    .find((p) => p.profile === "okprofile")
    .pools.find((q) => q.pool === "gemini");

  assert.equal(probes, 1, "Opt-in probe runs network probe");
  assert.equal(geminiProbed.state, "READY");
  assert.equal(checkCooldown(adapter.id, "okprofile", "gemini").cooling, false);
});

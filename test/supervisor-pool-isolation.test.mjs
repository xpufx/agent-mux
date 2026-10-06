import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Workspace-scoped scratch only.
const here = path.dirname(fileURLToPath(import.meta.url));
const scratchRoot = path.join(here, "..", ".tmp", "supervisor-pool-isolation");
fs.mkdirSync(scratchRoot, { recursive: true });

const distIndexUrl = new URL("../dist/index.js", import.meta.url).href;
const distIndexPath = fileURLToPath(distIndexUrl);

function writeFakeChild(caseDir, failingPool) {
  const counterFile = path.join(caseDir, "invocations");
  const childPath = path.join(caseDir, "fake-child.mjs");
  const quotaError =
    failingPool === "claude"
      ? "Error 429: Quota exceeded for claude pool. Resets in 2h5m0s."
      : "Error 429: Quota exceeded for gemini pool. Resets in 1h2m0s.";
  fs.writeFileSync(
    childPath,
    `import fs from "node:fs";\n` +
      `process.stdin.resume();\n` +
      `const counterFile = ${JSON.stringify(counterFile)};\n` +
      `let n = 0;\n` +
      `try { n = parseInt(fs.readFileSync(counterFile, "utf-8"), 10) || 0; } catch {}\n` +
      `fs.writeFileSync(counterFile, String(n + 1));\n` +
      `const quotaError = ${JSON.stringify(quotaError)};\n` +
      `if (n === 0) {\n` +
      `  console.log(JSON.stringify({ event: "init", conversation_id: "test-conv" }));\n` +
      `  setTimeout(() => {\n` +
      `    console.log(JSON.stringify({ event: "result", result: { status: "ERROR", error: quotaError } }));\n` +
      `  }, 200);\n` +
      `  setTimeout(() => process.exit(1), 1500);\n` +
      `} else {\n` +
      `  console.log(JSON.stringify({ event: "init", conversation_id: "test-conv" }));\n` +
      `  setTimeout(() => {\n` +
      `    console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }));\n` +
      `  }, 300);\n` +
      `  setTimeout(() => process.exit(0), 1200);\n` +
      `}\n`
  );
  return { childPath, counterFile };
}

function writeDriver(caseDir, { failingPool, childPath }) {
  const driverPath = path.join(caseDir, "driver.mjs");
  fs.writeFileSync(
    driverPath,
    `const { runSupervisor } = await import(${JSON.stringify(distIndexPath)});\n` +
      `const caseDir = ${JSON.stringify(caseDir)};\n` +
      `const failingPool = ${JSON.stringify(failingPool)};\n` +
      `const childPath = ${JSON.stringify(childPath)};\n` +
      `import path from "node:path";\n` +
      `import fs from "node:fs";\n` +
      `const profilesBaseDir = path.join(caseDir, "profiles", "antigravity");\n` +
      `const adapter = {\n` +
      `  id: "antigravity",\n` +
      `  displayName: "Google Antigravity",\n` +
      `  binaryName: "agy",\n` +
      `  defaultBinaryPath: process.execPath,\n` +
      `  profilesBaseDir,\n` +
      `  resolveTargetPool: () => failingPool,\n` +
      `  getSupportedPools: () => ["gemini", "claude"],\n` +
      `  getPoolModel: (pool) => (pool === "claude" ? "claude-test" : "gemini-test"),\n` +
      `  getSharedPaths: () => [],\n` +
      `  getAuthStatus: async () => true,\n` +
      `  getAccountIdentity: async (p) => p + "@example.com",\n` +
      `  getQuotaStatus: async () => [\n` +
      `    { pool: "gemini", state: "READY" },\n` +
      `    { pool: "claude", state: "READY" }\n` +
      `  ]\n` +
      `};\n` +
      `const code = await runSupervisor({\n` +
      `  adapter,\n` +
      `  initialProfile: "alice",\n` +
      `  initialPool: failingPool,\n` +
      `  binaryPath: process.execPath,\n` +
      `  args: [childPath],\n` +
      `  env: { ...process.env },\n` +
      `  surfaceAccount: "none"\n` +
      `});\n` +
      `process.exit(code);\n`
  );
  return driverPath;
}

function runDriver(driverPath, caseHome) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [driverPath], {
      env: {
        ...process.env,
        AGENT_MUX_HOME: caseHome,
        AGENT_MUX_ROUTING_POLICY: "pool-strict",
        AGENT_MUX_SURFACE_ACCOUNT: "none"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      reject(new Error(`driver timeout stdout=${stdout.slice(-500)} stderr=${stderr.slice(-500)}`));
    }, 20000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function runIsolationCase(failingPool) {
  const otherPool = failingPool === "claude" ? "gemini" : "claude";
  const caseHome = fs.mkdtempSync(path.join(scratchRoot, `${failingPool}-`));
  process.env.AGENT_MUX_HOME = caseHome;
  for (const p of ["alice", "bob"]) {
    fs.mkdirSync(path.join(caseHome, "profiles", "antigravity", p), { recursive: true });
  }
  const { childPath } = writeFakeChild(caseHome, failingPool);
  const driverPath = writeDriver(caseHome, { failingPool, childPath });

  const { code, stdout, stderr } = await runDriver(driverPath, caseHome);
  assert.equal(code, 0, `driver exit code (stdout=${stdout.slice(-300)} stderr=${stderr.slice(-300)})`);

  // Re-read state from the case home in this process.
  process.env.AGENT_MUX_HOME = caseHome;
  const { checkCooldown, getProviderStatus } = await import("../dist/index.js");

  // ONLY the failing pool on the failing profile cools.
  assert.equal(checkCooldown("antigravity", "alice", failingPool).cooling, true, `alice/${failingPool} must cool`);
  assert.equal(checkCooldown("antigravity", "alice", otherPool).cooling, false, `alice/${otherPool} must stay READY`);
  assert.equal(checkCooldown("antigravity", "bob", failingPool).cooling, false, `bob/${failingPool} must stay READY`);
  assert.equal(checkCooldown("antigravity", "bob", otherPool).cooling, false, `bob/${otherPool} must stay READY`);

  // Status overlay: LIMIT only on the failing pool.
  const adapter = {
    id: "antigravity",
    displayName: "Google Antigravity",
    binaryName: "agy",
    defaultBinaryPath: process.execPath,
    profilesBaseDir: path.join(caseHome, "profiles", "antigravity"),
    resolveTargetPool: () => failingPool,
    getSupportedPools: () => ["gemini", "claude"],
    getSharedPaths: () => [],
    getAuthStatus: async () => true,
    getAccountIdentity: async (p) => `${p}@example.com`,
    getQuotaStatus: async () => [
      { pool: "gemini", state: "READY" },
      { pool: "claude", state: "READY" }
    ]
  };
  const status = await getProviderStatus(adapter);
  const alice = status.find((p) => p.profile === "alice");
  assert.ok(alice, "alice status present");
  assert.equal(alice.pools.find((q) => q.pool === failingPool).state, "LIMIT");
  assert.equal(alice.pools.find((q) => q.pool === otherPool).state, "READY");
  const bob = status.find((p) => p.profile === "bob");
  assert.ok(bob, "bob status present");
  assert.equal(bob.pools.find((q) => q.pool === "gemini").state, "READY");
  assert.equal(bob.pools.find((q) => q.pool === "claude").state, "READY");
}

test("supervisor path: claude-pool 429 cools ONLY alice/claude (gemini stays READY)", async () => {
  await runIsolationCase("claude");
});

test("supervisor path: gemini-pool 429 cools ONLY alice/gemini (claude stays READY)", async () => {
  await runIsolationCase("gemini");
});

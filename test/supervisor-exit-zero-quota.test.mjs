import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Workspace-scoped scratch only.
const here = path.dirname(fileURLToPath(import.meta.url));
const scratchRoot = path.join(here, "..", ".tmp", "supervisor-exit-zero-quota");
fs.mkdirSync(scratchRoot, { recursive: true });

const distIndexUrl = new URL("../dist/index.js", import.meta.url).href;
const distIndexPath = fileURLToPath(distIndexUrl);

function writeFakeChildExitZeroWithQuotaStderr(caseDir) {
  const childPath = path.join(caseDir, "fake-child.mjs");
  const quotaError = "Error 429: Quota exceeded for gemini pool. Resets in 1h2m0s.";
  fs.writeFileSync(
    childPath,
    `import fs from "node:fs";\n` +
      `import path from "node:path";\n` +
      `process.stdin.resume();\n` +
      `const homeDir = process.env.HOME || "";\n` +
      `const profileName = path.basename(homeDir);\n` +
      `const isFirstProfile = profileName === "alice";\n` +
      `const quotaError = ${JSON.stringify(quotaError)};\n` +
      `console.log(JSON.stringify({ event: "init", conversation_id: "test-conv" }));\n` +
      `if (isFirstProfile) {\n` +
      `  setTimeout(() => {\n` +
      `    console.error(quotaError);\n` +
      `  }, 100);\n` +
      `}\n` +
      `setTimeout(() => {\n` +
      `  console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }));\n` +
      `}, 200);\n` +
      `setTimeout(() => process.exit(0), 500);\n`
  );
  return { childPath };
}

function writeDriver(caseDir, { childPath }) {
  const driverPath = path.join(caseDir, "driver.mjs");
  fs.writeFileSync(
    driverPath,
    `const { runSupervisor } = await import(${JSON.stringify(distIndexPath)});\n` +
      `const caseDir = ${JSON.stringify(caseDir)};\n` +
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
      `  resolveTargetPool: () => "gemini",\n` +
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
      `  initialPool: "gemini",\n` +
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

async function runExitZeroQuotaCase() {
  const caseHome = fs.mkdtempSync(path.join(scratchRoot, "exit-zero-quota-"));
  process.env.AGENT_MUX_HOME = caseHome;
  for (const p of ["alice", "bob"]) {
    fs.mkdirSync(path.join(caseHome, "profiles", "antigravity", p), { recursive: true });
  }
  const { childPath } = writeFakeChildExitZeroWithQuotaStderr(caseHome);
  const driverPath = writeDriver(caseHome, { childPath });

  const { code, stdout, stderr } = await runDriver(driverPath, caseHome);

  // The supervisor should NOT exit with code 0 on the first child.
  // It should detect the quota error in stderr and fail over to bob.
  // The second child (bob) should then run and exit cleanly with code 0.
  assert.equal(code, 0, `driver exit code (stdout=${stdout.slice(-300)} stderr=${stderr.slice(-300)})`);

  // Verify that bob's profile was used (failover happened)
  // Check cooldown was recorded for alice/gemini
  process.env.AGENT_MUX_HOME = caseHome;
  const { checkCooldown } = await import("../dist/index.js");

  assert.equal(checkCooldown("antigravity", "alice", "gemini").cooling, true, "alice/gemini must be cooled");
  assert.equal(checkCooldown("antigravity", "bob", "gemini").cooling, false, "bob/gemini must stay READY");

  // Verify stderr contains failover message
  assert.ok(stderr.includes("Automatically switching to healthy profile: bob"), `stderr should contain failover message, got: ${stderr.slice(-500)}`);

  // Verify stdout contains successful result from bob
  assert.ok(stdout.includes("SUCCESS"), `stdout should contain SUCCESS from bob, got: ${stdout.slice(-500)}`);
}

test("supervisor: exit code 0 with quota error in stderr triggers failover", async () => {
  await runExitZeroQuotaCase();
});
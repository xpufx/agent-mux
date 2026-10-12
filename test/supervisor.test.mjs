import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Workspace-scoped scratch only.
const here = path.dirname(fileURLToPath(import.meta.url));
const scratchRoot = path.join(here, "..", ".tmp", "supervisor-stderr");
fs.mkdirSync(scratchRoot, { recursive: true });

const distIndexPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const { createCandidateSelectionLogger } = await import("../dist/index.js");

const QUOTA_ERROR = "Error 429: Quota exceeded for gemini pool. Resets in 1h2m0s.";
const NON_QUOTA_ERROR = "Error: connection reset by peer";

function makeCaseHome(prefix) {
  const caseHome = fs.mkdtempSync(path.join(scratchRoot, `${prefix}-`));
  for (const profile of ["alice", "bob"]) {
    fs.mkdirSync(path.join(caseHome, "profiles", "antigravity", profile), { recursive: true });
  }
  return caseHome;
}

function writeChild(caseDir, body) {
  const childPath = path.join(caseDir, "fake-child.mjs");
  fs.writeFileSync(
    childPath,
    `import fs from "node:fs";\n` +
      `import path from "node:path";\n` +
      `import readline from "node:readline";\n` +
      `const profileName = path.basename(process.env.HOME || "");\n` +
      body
  );
  return childPath;
}

function writeDriver(caseDir, childPath) {
  const driverPath = path.join(caseDir, "driver.mjs");
  fs.writeFileSync(
    driverPath,
    `const { runSupervisor } = await import(${JSON.stringify(distIndexPath)});\n` +
      `import path from "node:path";\n` +
      `const caseDir = ${JSON.stringify(caseDir)};\n` +
      `const childPath = ${JSON.stringify(childPath)};\n` +
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
  return { driverPath };
}

function runDriver(driverPath, caseHome, { stdin = false, env = {}, inputLines = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [driverPath], {
      env: {
        ...process.env,
        AGENT_MUX_HOME: caseHome,
        AGENT_MUX_ROUTING_POLICY: "pool-strict",
        AGENT_MUX_SURFACE_ACCOUNT: "none",
        ...env
      },
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    if (stdin && child.stdin) {
      for (const line of inputLines) {
        child.stdin.write(line + "\n");
      }
      setTimeout(() => {
        try {
          child.stdin.end();
        } catch {}
      }, 100);
    }

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

test("candidate selection logger dedupes consecutive identical candidates", () => {
  const savedDebug = process.env.DEBUG;
  const savedMuxDebug = process.env.AGENT_MUX_DEBUG;
  delete process.env.DEBUG;
  delete process.env.AGENT_MUX_DEBUG;
  try {
    const messages = [];
    const logger = createCandidateSelectionLogger((m) => messages.push(m));
    assert.equal(logger.log("bob", "gemini", "healthy"), true);
    assert.equal(logger.log("bob", "gemini", "healthy, again"), false);
    assert.equal(logger.log("alice", "gemini", "healthy"), true);
    assert.equal(logger.log("alice", "gemini", "still healthy"), false);
    assert.equal(messages.length, 2, `got: ${JSON.stringify(messages)}`);
    assert.equal(logger.lastSelected(), "alice:gemini");
  } finally {
    if (savedDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = savedDebug;
    if (savedMuxDebug === undefined) delete process.env.AGENT_MUX_DEBUG;
    else process.env.AGENT_MUX_DEBUG = savedMuxDebug;
  }
});

test("candidate selection logger emits every turn under AGENT_MUX_DEBUG", () => {
  const savedDebug = process.env.DEBUG;
  const savedMuxDebug = process.env.AGENT_MUX_DEBUG;
  delete process.env.DEBUG;
  process.env.AGENT_MUX_DEBUG = "1";
  try {
    const messages = [];
    const logger = createCandidateSelectionLogger((m) => messages.push(m));
    assert.equal(logger.log("bob", "gemini", "r1"), true);
    assert.equal(logger.log("bob", "gemini", "r2"), true);
    assert.equal(messages.length, 2, `got: ${JSON.stringify(messages)}`);
  } finally {
    if (savedDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = savedDebug;
    if (savedMuxDebug === undefined) delete process.env.AGENT_MUX_DEBUG;
    else process.env.AGENT_MUX_DEBUG = savedMuxDebug;
  }
});

test("supervisor suppresses buffered quota stderr on successful failover", async () => {
  const caseHome = makeCaseHome("suppress");
  const childPath = writeChild(
    caseHome,
    `console.log(JSON.stringify({ event: "init", conversation_id: "test-conv" }));\n` +
      `if (profileName === "alice") {\n` +
      `  setTimeout(() => console.error(${JSON.stringify(QUOTA_ERROR)}), 100);\n` +
      `  setTimeout(() => process.exit(0), 400);\n` +
      `} else {\n` +
      `  setTimeout(() => console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS" } })), 150);\n` +
      `  setTimeout(() => process.exit(0), 400);\n` +
      `}\n`
  );
  const { driverPath } = writeDriver(caseHome, childPath);

  const { code, stdout, stderr } = await runDriver(driverPath, caseHome);

  assert.equal(code, 0, `driver exit (stdout=${stdout.slice(-300)} stderr=${stderr.slice(-300)})`);
  assert.ok(
    stderr.includes("Automatically switching to healthy profile: bob"),
    `stderr should report failover, got: ${stderr}`
  );
  assert.ok(
    !stderr.includes("Quota exceeded for gemini pool"),
    `recovered quota stderr must be suppressed, got: ${stderr}`
  );
  assert.ok(stdout.includes("SUCCESS"), `bob's successful result should pass through, got: ${stdout}`);
});

test("supervisor flushes buffered stderr on non-quota crash", async () => {
  const caseHome = makeCaseHome("flush-crash");
  const childPath = writeChild(
    caseHome,
    `console.log(JSON.stringify({ event: "init", conversation_id: "test-conv" }));\n` +
      `setTimeout(() => console.error(${JSON.stringify(NON_QUOTA_ERROR)}), 100);\n` +
      `setTimeout(() => process.exit(1), 400);\n`
  );
  const { driverPath } = writeDriver(caseHome, childPath);

  const { code, stderr } = await runDriver(driverPath, caseHome);

  assert.equal(code, 1, `non-quota crash should propagate exit code, got: ${code}`);
  assert.ok(
    stderr.includes(NON_QUOTA_ERROR),
    `non-quota crash stderr must reach the caller, got: ${stderr}`
  );
});

test("supervisor flushes buffered quota stderr when all candidates are exhausted", async () => {
  const caseHome = makeCaseHome("flush-exhausted");
  process.env.AGENT_MUX_HOME = caseHome;
  const { recordCooldown } = await import("../dist/index.js");
  recordCooldown("antigravity", "alice", "gemini", 3600, "Pre-cooled");
  recordCooldown("antigravity", "bob", "gemini", 1800, "Pre-cooled");

  const childPath = writeChild(
    caseHome,
    `console.log(JSON.stringify({ event: "init", conversation_id: "test-conv" }));\n` +
      `if (profileName === "alice") {\n` +
      `  setTimeout(() => console.error(${JSON.stringify(QUOTA_ERROR)}), 100);\n` +
      `  setTimeout(() => process.exit(1), 400);\n` +
      `} else {\n` +
      `  setTimeout(() => console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS" } })), 150);\n` +
      `  setTimeout(() => process.exit(0), 400);\n` +
      `}\n`
  );
  const { driverPath } = writeDriver(caseHome, childPath);

  const { code, stderr } = await runDriver(driverPath, caseHome);

  assert.equal(code, 0, `driver exit (stderr=${stderr.slice(-300)})`);
  assert.ok(
    stderr.includes("Quota exceeded for gemini pool"),
    `exhausted failover must surface the raw quota stderr, got: ${stderr}`
  );
});

test("supervisor dedupes candidate selection logs across turns unless debug is set", async () => {
  const runCase = async (prefix, env) => {
    const caseHome = makeCaseHome(prefix);
    const childPath = writeChild(
      caseHome,
      `const rl = readline.createInterface({ input: process.stdin });\n` +
        `let turns = 0;\n` +
        `console.log(JSON.stringify({ event: "init", conversation_id: "test-conv" }));\n` +
        `rl.on("line", () => {\n` +
        `  turns++;\n` +
        `  console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }));\n` +
        `  if (turns >= 2) setTimeout(() => process.exit(0), 200);\n` +
        `});\n`
    );
    const { driverPath } = writeDriver(caseHome, childPath);
    const { code } = await runDriver(driverPath, caseHome, {
      stdin: true,
      env,
      inputLines: [
        JSON.stringify({ event: "user", text: "one" }),
        JSON.stringify({ event: "user", text: "two" })
      ]
    });
    assert.equal(code, 0, "driver should exit cleanly");

    const logFile = path.join(caseHome, "logs", "agent-mux.log");
    const lines = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf-8").split("\n").filter((l) => l.includes("Selected candidate"))
      : [];
    return lines.length;
  };

  const dedupedCount = await runCase("dedup", { DEBUG: "", AGENT_MUX_DEBUG: "" });
  assert.equal(dedupedCount, 1, `unchanged candidate must log once, got ${dedupedCount}`);

  const debugCount = await runCase("dedup-debug", { AGENT_MUX_DEBUG: "1" });
  assert.equal(debugCount, 3, `debug mode must log initial + 2 turns, got ${debugCount}`);
});

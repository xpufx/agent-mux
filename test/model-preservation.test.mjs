import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Isolated home so routing/cooldown state never touches the real home.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mux-model-preserve-"));
process.env.AGENT_MUX_HOME = tmpHome;
delete process.env.AGENT_MUX_ACTIVE_PROFILE;

const {
  executeProvider,
  applyPoolModel,
  hasExplicitModelArg,
} = await import("../dist/index.js");

function makePiLikeAdapter(profilesDir) {
  return {
    id: "pi-test",
    displayName: "Pi Test",
    binaryName: "pi",
    defaultBinaryPath: "/bin/true",
    profilesBaseDir: profilesDir,
    // Mimic PiAdapter.resolveTargetPool: inner provider prefix of --model.
    resolveTargetPool: (args) => {
      let model;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--model" && i + 1 < args.length) model = args[i + 1];
        else if (args[i].startsWith("--model=")) model = args[i].slice("--model=".length);
      }
      if (!model) return "default";
      const idx = model.indexOf("/");
      return idx > 0 ? model.slice(0, idx) : "default";
    },
    getSupportedPools: () => ["default", "commandcode", "other"],
    getPoolModel: (pool) => {
      if (pool === "commandcode") return "commandcode/deepseek/deepseek-v4-flash";
      if (pool === "other") return "other/default-model";
      return undefined;
    },
    getSharedPaths: () => [],
    getAuthStatus: async () => true,
    getQuotaStatus: async () => [
      { pool: "default", state: "READY" },
      { pool: "commandcode", state: "READY" },
      { pool: "other", state: "READY" },
    ],
  };
}

test("hasExplicitModelArg detects --model forms", () => {
  assert.equal(hasExplicitModelArg(["-p", "hi"]), false);
  assert.equal(hasExplicitModelArg(["--model", "x", "-p", "hi"]), true);
  assert.equal(hasExplicitModelArg(["--model=x", "-p", "hi"]), true);
  assert.equal(hasExplicitModelArg(["-m", "x"]), true);
});

test("applyPoolModel preserves explicit --model when pool matches target", () => {
  const adapter = { getPoolModel: () => "commandcode/deepseek/deepseek-v4-flash" };
  const args = ["--model", "commandcode/Qwen/Qwen3.7-Flash", "-p", "hi"];
  assert.deepEqual(applyPoolModel(adapter, args, "commandcode", "commandcode"), args);
  // --model= form is preserved too
  const eqArgs = ["--model=commandcode/Qwen/Qwen3.7-Flash", "-p", "hi"];
  assert.deepEqual(applyPoolModel(adapter, eqArgs, "commandcode", "commandcode"), eqArgs);
});

test("applyPoolModel rewrites on pool change even with explicit --model", () => {
  const adapter = { getPoolModel: (p) => (p === "other" ? "other/default-model" : "commandcode/deepseek/deepseek-v4-flash") };
  const args = ["--model", "commandcode/Qwen/Qwen3.7-Flash", "-p", "hi"];
  assert.deepEqual(applyPoolModel(adapter, args, "other", "commandcode"), [
    "--model",
    "other/default-model",
    "-p",
    "hi",
  ]);
});

test("executeProvider preserves explicit --model when selected pool matches target (issue #56)", async () => {
  const profilesDir = path.join(tmpHome, "profiles", "pi-test");
  fs.mkdirSync(path.join(profilesDir, "p1"), { recursive: true });
  const adapter = makePiLikeAdapter(profilesDir);
  let executedArgs = null;
  adapter.prepareExecution = (profile, args, env) => {
    executedArgs = args;
    return { binary: "/bin/true", args: [], env };
  };

  await executeProvider(
    adapter,
    ["--model", "commandcode/Qwen/Qwen3.7-Flash", "-p", "hello"],
    { ...process.env }
  );
  assert.deepEqual(executedArgs, ["--model", "commandcode/Qwen/Qwen3.7-Flash", "-p", "hello"]);
});

test("executeProvider uses pool default when --pool is passed without --model", async () => {
  const profilesDir = path.join(tmpHome, "profiles", "pi-test");
  fs.mkdirSync(path.join(profilesDir, "p1"), { recursive: true });
  const adapter = makePiLikeAdapter(profilesDir);
  let executedArgs = null;
  adapter.prepareExecution = (profile, args, env) => {
    executedArgs = args;
    return { binary: "/bin/true", args: [], env };
  };

  await executeProvider(adapter, ["--pool", "commandcode", "-p", "hello"], { ...process.env });
  assert.deepEqual(executedArgs, ["-p", "hello", "--model", "commandcode/deepseek/deepseek-v4-flash"]);
});

test("supervisor failover to a new pool applies the new pool default model", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const scratchRoot = path.join(here, "..", ".tmp", "model-preserve-failover");
  fs.mkdirSync(scratchRoot, { recursive: true });
  const caseHome = fs.mkdtempSync(path.join(scratchRoot, "case-"));
  for (const p of ["alice", "bob"]) {
    fs.mkdirSync(path.join(caseHome, "profiles", "antigravity", p), { recursive: true });
  }
  const distIndexPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

  // Fake child: first invocation (alice) hits quota; record every invocation's
  // argv so the driver can assert the failover args carry the new pool model.
  const logFile = path.join(caseHome, "invocation-args.jsonl");
  const childPath = path.join(caseHome, "fake-child.mjs");
  fs.writeFileSync(
    childPath,
    `import fs from "node:fs";\n` +
      `import path from "node:path";\n` +
      `const logFile = ${JSON.stringify(logFile)};\n` +
      `const profileName = path.basename(process.env.HOME || "");\n` +
      `fs.appendFileSync(logFile, JSON.stringify({ profile: profileName, args: process.argv.slice(2) }) + "\\n");\n` +
      `process.stdin.resume();\n` +
      `console.log(JSON.stringify({ event: "init", conversation_id: "test-conv" }));\n` +
      `if (profileName === "alice") {\n` +
      `  setTimeout(() => console.log(JSON.stringify({ event: "result", result: { status: "ERROR", error: "Error 429: Quota exceeded. Resets in 1h0m0s." } })), 200);\n` +
      `  setTimeout(() => process.exit(1), 1500);\n` +
      `} else {\n` +
      `  setTimeout(() => console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS" } })), 300);\n` +
      `  setTimeout(() => process.exit(0), 1200);\n` +
      `}\n`
  );

  const driverPath = path.join(caseHome, "driver.mjs");
  fs.writeFileSync(
    driverPath,
    `const { runSupervisor } = await import(${JSON.stringify(distIndexPath)});\n` +
      `import path from "node:path";\n` +
      `const caseDir = ${JSON.stringify(caseHome)};\n` +
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
      `  getQuotaStatus: async () => [{ pool: "gemini", state: "READY" }, { pool: "claude", state: "READY" }]\n` +
      `};\n` +
      `const code = await runSupervisor({\n` +
      `  adapter,\n` +
      `  initialProfile: "alice",\n` +
      `  initialPool: "gemini",\n` +
      `  binaryPath: process.execPath,\n` +
      `  args: [childPath, "--model", "gemini-test"],\n` +
      `  env: { ...process.env },\n` +
      `  surfaceAccount: "none"\n` +
      `});\n` +
      `process.exit(code);\n`
  );

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [driverPath], {
      env: {
        ...process.env,
        AGENT_MUX_HOME: caseHome,
        AGENT_MUX_ROUTING_POLICY: "account-first",
        AGENT_MUX_SURFACE_ACCOUNT: "none",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`driver timeout stdout=${stdout.slice(-500)} stderr=${stderr.slice(-500)}`));
    }, 20000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });

  assert.equal(result.code, 0, `driver exit (stderr=${result.stderr.slice(-500)})`);
  const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.length >= 2, `expected failover to spawn twice, got ${JSON.stringify(lines)}`);
  const modelOf = (inv) => {
    const i = inv.args.findIndex((a) => a === "--model");
    return i === -1 ? undefined : inv.args[i + 1];
  };
  // First spawn uses the requested pool model.
  assert.equal(modelOf(lines[0]), "gemini-test");
  // account-first failover spills alice to the other pool before trying bob,
  // so some later spawn must carry the new pool's default model.
  const laterModels = lines.slice(1).map(modelOf);
  assert.ok(
    laterModels.includes("claude-test"),
    `failover must apply new pool default, got ${JSON.stringify(lines)}`
  );
});

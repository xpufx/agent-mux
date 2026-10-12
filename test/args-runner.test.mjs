import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Test-isolated environment
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mux-args-runner-test-"));
process.env.AGENT_MUX_HOME = tmpHome;
// Running the suite from inside an agent-mux profile session leaks this marker;
// clear it so routing tests are deterministic (the bypass test sets it itself).
delete process.env.AGENT_MUX_ACTIVE_PROFILE;

const {
  parseArgs,
  executeProvider,
  getProviderAdapter
} = await import("../dist/index.js");

test("parseArgs - extracts --profile flag in space and equals syntax", () => {
  const res1 = parseArgs(["--profile", "alice", "-p", "hello"]);
  assert.equal(res1.profile, "alice");
  assert.equal(res1.mode, "alice");
  assert.deepEqual(res1.cmdArgs, ["-p", "hello"]);

  const res2 = parseArgs(["--profile=bob", "models"]);
  assert.equal(res2.profile, "bob");
  assert.equal(res2.mode, "bob");
  assert.deepEqual(res2.cmdArgs, ["models"]);
});

test("parseArgs - extracts --round-robin and --rr", () => {
  const res1 = parseArgs(["--round-robin", "-p", "hi"]);
  assert.equal(res1.roundRobin, true);
  assert.equal(res1.mode, "round-robin");
  assert.deepEqual(res1.cmdArgs, ["-p", "hi"]);

  const res2 = parseArgs(["--rr", "-m", "flash"]);
  assert.equal(res2.roundRobin, true);
  assert.equal(res2.mode, "round-robin");
  assert.deepEqual(res2.cmdArgs, ["-m", "flash"]);
});

test("parseArgs - extracts --pool in space and equals syntax", () => {
  const res1 = parseArgs(["--pool", "free", "stream-json", "prompt"]);
  assert.equal(res1.pool, "free");
  assert.deepEqual(res1.cmdArgs, ["stream-json", "prompt"]);

  const res2 = parseArgs(["--pool=gemini", "-p", "prompt"]);
  assert.equal(res2.pool, "gemini");
  assert.deepEqual(res2.cmdArgs, ["-p", "prompt"]);
});

test("parseArgs - respects '--' delimiter verbatim without parsing mux flags", () => {
  const res = parseArgs([
    "--profile",
    "alice",
    "--",
    "--profile",
    "secondary",
    "--rr",
    "--pool=claude",
    "-p",
    "hello"
  ]);
  assert.equal(res.profile, "alice");
  assert.equal(res.mode, "alice");
  assert.equal(res.roundRobin, false);
  assert.equal(res.pool, undefined);
  assert.deepEqual(res.cmdArgs, [
    "--profile",
    "secondary",
    "--rr",
    "--pool=claude",
    "-p",
    "hello"
  ]);
});

test("parseArgs - preserves interleaved native CLI arguments and flag order", () => {
  const res = parseArgs([
    "-p",
    "analyze repository",
    "--pool",
    "gemini",
    "-v",
    "--profile",
    "primary"
  ]);
  assert.equal(res.profile, "primary");
  assert.equal(res.pool, "gemini");
  assert.deepEqual(res.cmdArgs, ["-p", "analyze repository", "-v"]);
});

test("executeProvider - handles recursion bypass when already inside isolated profile", async () => {
  const adapter = {
    id: "mock-provider",
    displayName: "Mock Provider",
    binaryName: "mock-bin",
    defaultBinaryPath: "/bin/true",
    profilesBaseDir: "/tmp",
    getAuthStatus: async () => true,
    getQuotaStatus: async () => [],
    resolveTargetPool: () => "default",
    getSharedPaths: () => [],
    getSupportedPools: () => ["default"]
  };

  const env = {
    ...process.env,
    AGENT_MUX_ACTIVE_PROFILE: "alice"
  };

  const code = await executeProvider(adapter, ["hello", "world"], env);
  assert.equal(code, 0);
});

test("executeProvider - does not inject model flags for subcommands or --help / --version", async () => {
  let executedArgs = null;
  const mockAdapter = {
    id: "test-adapter",
    displayName: "Test Adapter",
    binaryName: "test-bin",
    defaultBinaryPath: "/bin/true",
    profilesBaseDir: path.join(tmpHome, "profiles", "test-adapter"),
    getAuthStatus: async () => true,
    getQuotaStatus: async () => [],
    resolveTargetPool: () => "gemini",
    getSupportedPools: () => ["gemini"],
    getPoolModel: () => "gemini-model-override",
    getSharedPaths: () => [],
    isNonPromptSubcommand: (sub) => sub === "models" || sub === "mcp",
    prepareExecution: (profile, args, env) => {
      executedArgs = args;
      return {
        binary: "/bin/true",
        args: [], // Pass empty args to /bin/true so it doesn't print --help/--version
        env
      };
    }
  };

  // Create mock profile
  fs.mkdirSync(path.join(tmpHome, "profiles", "test-adapter", "p1"), { recursive: true });

  // 1. Subcommand 'models'
  await executeProvider(mockAdapter, ["models"], { ...process.env });
  assert.deepEqual(executedArgs, ["models"]);

  // 2. Info flag '--version'
  await executeProvider(mockAdapter, ["--version"], { ...process.env });
  assert.deepEqual(executedArgs, ["--version"]);

  // 3. Info flag '--help'
  await executeProvider(mockAdapter, ["--help"], { ...process.env });
  assert.deepEqual(executedArgs, ["--help"]);

  // 4. Regular prompt (not subcommand) -> model injected
  await executeProvider(mockAdapter, ["-p", "hi"], { ...process.env });
  assert.deepEqual(executedArgs, ["-p", "hi", "--model", "gemini-model-override"]);
});

test("executeProvider - handles --mux-version with exit 0", async () => {
  const { AGENT_MUX_VERSION } = await import("../dist/index.js");
  let logged = "";
  const origLog = console.log;
  console.log = (msg) => { logged = msg; };
  try {
    const adapter = {
      id: "agy",
      displayName: "Antigravity",
      binaryName: "agy",
      defaultBinaryPath: "/bin/true",
      profilesBaseDir: "/tmp",
      getAuthStatus: async () => true,
      getQuotaStatus: async () => [],
      resolveTargetPool: () => "default",
      getSupportedPools: () => ["default"],
      getSharedPaths: () => []
    };
    const code = await executeProvider(adapter, ["--mux-version"]);
    assert.equal(code, 0);
    assert.ok(logged.includes(AGENT_MUX_VERSION));
    assert.ok(logged.includes("wrapper: Antigravity"));
  } finally {
    console.log = origLog;
  }
});

test("isBinaryWrapped - detects wrapper script vs native binary", async () => {
  const { isBinaryWrapped } = await import("../dist/index.js");
  const wrapperFile = path.join(tmpHome, "mock-wrapper");
  fs.writeFileSync(wrapperFile, "#!/usr/bin/env node\n// agent-mux wrapper\nimport { executeProvider } from './core/runner.js';\n");

  const nativeFile = path.join(tmpHome, "mock-native");
  // Write ELF header bytes
  fs.writeFileSync(nativeFile, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));

  assert.equal(isBinaryWrapped(wrapperFile), true);
  assert.equal(isBinaryWrapped(nativeFile), false);
  assert.equal(isBinaryWrapped("/nonexistent/file"), false);
});


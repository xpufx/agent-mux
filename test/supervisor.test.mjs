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

// --- Quota-vocabulary regression tests (issue #64) ---

const INDIVIDUAL_QUOTA_MSG =
  "Individual quota reached for model gemini-3.8-flash-low in project xpufx-org/agent-mux. Please retry after 2025-07-15T12:00:00Z.";

// Unit tests for isHardQuotaError / isQuotaError are run via the built dist.
test("isHardQuotaError matches 'Individual quota reached'", async () => {
  const { isHardQuotaError } = await import("../dist/index.js");
  assert.ok(isHardQuotaError(INDIVIDUAL_QUOTA_MSG), "should match individual quota reached");
  assert.ok(
    isHardQuotaError("quota reached on project"),
    "should match plain 'quota reached'"
  );
});

test("isQuotaError matches 'Individual quota reached'", async () => {
  const { isQuotaError } = await import("../dist/index.js");
  assert.ok(isQuotaError(INDIVIDUAL_QUOTA_MSG), "isQuotaError should match individual quota reached");
});

test("supervisor suppresses non-fatal 'Individual quota reached' stderr on successful turn", async () => {
  const caseHome = makeCaseHome("suppress-individual-quota");
  const childPath = writeChild(
    caseHome,
    `console.log(JSON.stringify({ event: "init", conversation_id: "test-conv" }));\n` +
      `if (profileName === "alice") {\n` +
      `  setTimeout(() => console.error(${JSON.stringify(INDIVIDUAL_QUOTA_MSG)}), 100);\n` +
      `  setTimeout(() => process.exit(0), 400);\n` +
      `} else {\n` +
      `  setTimeout(() => console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS" } })), 150);\n` +
      `  setTimeout(() => process.exit(0), 400);\n` +
      `}\n`
  );
  const { driverPath } = writeDriver(caseHome, childPath);

  const { code, stderr } = await runDriver(driverPath, caseHome);

  assert.equal(code, 0, `driver exit (stderr=${stderr.slice(-300)})`);
  assert.ok(
    !stderr.includes("Individual quota reached"),
    `non-fatal quota notice must be suppressed on success, got: ${stderr}`
  );
});

test("isProcessCrashQuotaError detects 'Individual quota reached' in buffered stderr", async () => {
  const { isProcessCrashQuotaError } = await import("../dist/index.js");
  const lines = [INDIVIDUAL_QUOTA_MSG];
  assert.equal(
    isProcessCrashQuotaError(lines),
    INDIVIDUAL_QUOTA_MSG,
    "should detect individual quota in buffered stderr"
  );
  assert.equal(isProcessCrashQuotaError([]), undefined);
  assert.equal(
    isProcessCrashQuotaError(["normal warning line"]),
    undefined
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

// --- Mid-turn failover regression tests (issue #69) ---
//
// When a quota failover kills a child mid-turn after partial output
// (turnHadOutput === true), downstream harnesses must still observe a
// terminal `result` frame for the killed turn. Otherwise they wait on
// stdout forever (`lastStatus: "running"` -> ZOMBIE_HUNG_TURN).

function parseNdjson(stdout) {
  return stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function resultFrames(stdout) {
  return parseNdjson(stdout).filter((f) => f.event === "result");
}

// Staggered stdin: `writes` is [{ atMs, line }]; stdin ends at `endAtMs`.
function runDriverStaggered(driverPath, caseHome, { writes = [], endAtMs = 3000, env = {}, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [driverPath], {
      env: {
        ...process.env,
        AGENT_MUX_HOME: caseHome,
        AGENT_MUX_ROUTING_POLICY: "pool-strict",
        AGENT_MUX_SURFACE_ACCOUNT: "none",
        AGENT_MUX_KILL_GRACE_MS: "200",
        ...env
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timers = [];
    for (const w of writes) {
      timers.push(
        setTimeout(() => {
          try {
            child.stdin.write(w.line + "\n");
          } catch {}
        }, w.atMs)
      );
    }
    timers.push(
      setTimeout(() => {
        try {
          child.stdin.end();
        } catch {}
      }, endAtMs)
    );
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      reject(new Error(`driver timeout stdout=${stdout.slice(-500)} stderr=${stderr.slice(-500)}`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      for (const t of timers) clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      for (const t of timers) clearTimeout(t);
      reject(err);
    });
  });
}

const USER_1 = JSON.stringify({ event: "user", text: "first turn" });
const USER_2 = JSON.stringify({ event: "user", text: "second turn" });

// Bob: healthy fallback. Serves exactly one user turn with SUCCESS, then exits.
const BOB_SERVE_ONCE =
  `} else {\n` +
  `  const rl = readline.createInterface({ input: process.stdin });\n` +
  `  rl.on("line", (line) => {\n` +
  `    try {\n` +
  `      const d = JSON.parse(line);\n` +
  `      if (d.event === "user") {\n` +
  `        console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }));\n` +
  `        setTimeout(() => process.exit(0), 300);\n` +
  `      }\n` +
  `    } catch {}\n` +
  `  });\n` +
  `}\n`;

test("mid-turn quota result failover forwards terminal frame and session continues (issue #69)", async () => {
  const caseHome = makeCaseHome("midturn-result");
  const childPath = writeChild(
    caseHome,
    `console.log(JSON.stringify({ event: "init", conversation_id: "test-conv" }));\n` +
      `if (profileName === "alice") {\n` +
      `  const rl = readline.createInterface({ input: process.stdin });\n` +
      `  rl.on("line", (line) => {\n` +
      `    try {\n` +
      `      const d = JSON.parse(line);\n` +
      `      if (d.event === "user") {\n` +
      `        console.log(JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "partial hello" } }));\n` +
      `        setTimeout(() => {\n` +
      `          console.log(JSON.stringify({ event: "result", result: { status: "ERROR", error: ${JSON.stringify(QUOTA_ERROR)} } }));\n` +
      `        }, 150);\n` +
      `      }\n` +
      `    } catch {}\n` +
      `  });\n` +
      // Ignore SIGTERM: the supervisor must escalate to group SIGKILL so a
      // wedged child can never hold the session open.
      `  process.on("SIGTERM", () => {});\n` +
      BOB_SERVE_ONCE
  );
  const { driverPath } = writeDriver(caseHome, childPath);

  const { code, stdout, stderr } = await runDriverStaggered(driverPath, caseHome, {
    writes: [
      { atMs: 0, line: USER_1 },
      { atMs: 1800, line: USER_2 }
    ],
    endAtMs: 3500
  });

  assert.equal(code, 0, `driver must exit cleanly, not hang (stderr=${stderr.slice(-300)})`);
  assert.ok(stdout.includes("partial hello"), `partial turn output must pass through, got: ${stdout.slice(-500)}`);
  const results = resultFrames(stdout);
  assert.ok(
    results.length >= 2,
    `expected terminal frame for killed turn + SUCCESS for next turn, got ${results.length}: ${stdout.slice(-600)}`
  );
  assert.equal(results[0].result?.status, "ERROR", `first terminal frame must close the killed turn, got: ${JSON.stringify(results[0])}`);
  assert.ok(
    String(results[0].result?.error || "").includes("429") ||
      String(results[0].result?.error || "").toLowerCase().includes("quota"),
    `first terminal frame must carry the quota signal, got: ${JSON.stringify(results[0])}`
  );
  assert.equal(
    results[results.length - 1].result?.status,
    "SUCCESS",
    `replacement child must serve the next turn, got: ${JSON.stringify(results[results.length - 1])}`
  );
  assert.ok(
    stderr.includes("Automatically switching to healthy profile: bob"),
    `stderr should report failover, got: ${stderr.slice(-300)}`
  );
});

test("mid-turn quota error-frame failover emits synthetic abort and session continues (issue #69)", async () => {
  const caseHome = makeCaseHome("midturn-error");
  const childPath = writeChild(
    caseHome,
    `console.log(JSON.stringify({ event: "init", conversation_id: "test-conv" }));\n` +
      `if (profileName === "alice") {\n` +
      `  const rl = readline.createInterface({ input: process.stdin });\n` +
      `  rl.on("line", (line) => {\n` +
      `    try {\n` +
      `      const d = JSON.parse(line);\n` +
      `      if (d.event === "user") {\n` +
      `        console.log(JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "partial work" } }));\n` +
      // Non-terminal quota signal: no `result` frame follows from the engine.
      `        setTimeout(() => {\n` +
      `          console.log(JSON.stringify({ event: "error", error: ${JSON.stringify(QUOTA_ERROR)} }));\n` +
      `        }, 150);\n` +
      `      }\n` +
      `    } catch {}\n` +
      `  });\n` +
      `  process.on("SIGTERM", () => {});\n` +
      BOB_SERVE_ONCE
  );
  const { driverPath } = writeDriver(caseHome, childPath);

  const { code, stdout } = await runDriverStaggered(driverPath, caseHome, {
    writes: [
      { atMs: 0, line: USER_1 },
      { atMs: 1800, line: USER_2 }
    ],
    endAtMs: 3500
  });

  assert.equal(code, 0, `driver must exit cleanly, not hang (stdout=${stdout.slice(-400)})`);
  const frames = parseNdjson(stdout);
  const aborts = frames.filter((f) => f.agent_mux_failover_abort);
  assert.equal(aborts.length, 1, `expected exactly one synthetic abort frame, got ${aborts.length}: ${stdout.slice(-600)}`);
  assert.equal(aborts[0].event, "result", "abort must be a terminal result frame");
  assert.equal(aborts[0].result?.status, "ERROR", "abort must never fabricate success");
  assert.equal(aborts[0].agent_mux_failover_abort?.from, "alice");
  assert.equal(aborts[0].agent_mux_failover_abort?.to, "bob");
  const partialIdx = stdout.indexOf("partial work");
  const abortIdx = stdout.indexOf(JSON.stringify(aborts[0]));
  const successIdx = stdout.lastIndexOf("SUCCESS");
  assert.ok(
    partialIdx !== -1 && partialIdx < abortIdx && abortIdx < successIdx,
    `stream order must be partial output -> abort -> next-turn success (got ${partialIdx},${abortIdx},${successIdx})`
  );
});

test("mid-turn crash with quota stderr emits abort frame and session continues (issue #69)", async () => {
  const caseHome = makeCaseHome("midturn-crash");
  const childPath = writeChild(
    caseHome,
    `console.log(JSON.stringify({ event: "init", conversation_id: "test-conv" }));\n` +
      `if (profileName === "alice") {\n` +
      `  const rl = readline.createInterface({ input: process.stdin });\n` +
      `  rl.on("line", (line) => {\n` +
      `    try {\n` +
      `      const d = JSON.parse(line);\n` +
      `      if (d.event === "user") {\n` +
      `        console.log(JSON.stringify({ event: "step_update", step_update: { step_type: "tool", text_delta: "" } }));\n` +
      `        setTimeout(() => console.error(${JSON.stringify(QUOTA_ERROR)}), 100);\n` +
      `        setTimeout(() => process.exit(1), 250);\n` +
      `      }\n` +
      `    } catch {}\n` +
      `  });\n` +
      BOB_SERVE_ONCE
  );
  const { driverPath } = writeDriver(caseHome, childPath);

  const { code, stdout, stderr } = await runDriverStaggered(driverPath, caseHome, {
    writes: [
      { atMs: 0, line: USER_1 },
      { atMs: 1800, line: USER_2 }
    ],
    endAtMs: 3500
  });

  assert.equal(code, 0, `driver must exit cleanly, not hang (stderr=${stderr.slice(-300)})`);
  const frames = parseNdjson(stdout);
  const aborts = frames.filter((f) => f.agent_mux_failover_abort);
  assert.equal(aborts.length, 1, `crash-killed turn must be closed by one abort frame, got: ${stdout.slice(-600)}`);
  assert.equal(aborts[0].result?.status, "ERROR");
  assert.ok(stdout.includes("SUCCESS"), `replacement must serve the next turn, got: ${stdout.slice(-400)}`);
  assert.ok(
    !stderr.includes("Quota exceeded for gemini pool"),
    `recovered quota stderr must stay suppressed, got: ${stderr.slice(-300)}`
  );
});

test("pre-output quota failover replays seamlessly with no abort frame (issue #69)", async () => {
  const caseHome = makeCaseHome("preoutput-replay");
  const childPath = writeChild(
    caseHome,
    `console.log(JSON.stringify({ event: "init", conversation_id: "test-conv" }));\n` +
      `if (profileName === "alice") {\n` +
      `  const rl = readline.createInterface({ input: process.stdin });\n` +
      `  rl.on("line", (line) => {\n` +
      `    try {\n` +
      `      const d = JSON.parse(line);\n` +
      // Quota before ANY output: turn is safely replayable into the fallback.
      `      if (d.event === "user") {\n` +
      `        console.log(JSON.stringify({ event: "error", error: ${JSON.stringify(QUOTA_ERROR)} }));\n` +
      `      }\n` +
      `    } catch {}\n` +
      `  });\n` +
      BOB_SERVE_ONCE
  );
  const { driverPath } = writeDriver(caseHome, childPath);

  const { code, stdout } = await runDriverStaggered(driverPath, caseHome, {
    writes: [{ atMs: 0, line: USER_1 }],
    endAtMs: 2500
  });

  assert.equal(code, 0, `driver must exit cleanly (stdout=${stdout.slice(-400)})`);
  const frames = parseNdjson(stdout);
  const aborts = frames.filter((f) => f.agent_mux_failover_abort);
  assert.equal(aborts.length, 0, `seamless replay must not emit a spurious terminal frame, got: ${stdout.slice(-500)}`);
  const results = resultFrames(stdout);
  assert.equal(results.length, 1, `exactly one terminal frame expected, got: ${stdout.slice(-500)}`);
  assert.equal(results[0].result?.status, "SUCCESS", "replayed turn must succeed on the fallback");
});

test("pre-output quota result error frame replays seamlessly without forwarding error frame", async () => {
  const caseHome = makeCaseHome("preoutput-result-error-replay");
  const childPath = writeChild(
    caseHome,
    `console.log(JSON.stringify({ event: "init", conversation_id: "test-conv" }));\n` +
      `if (profileName === "alice") {\n` +
      `  const rl = readline.createInterface({ input: process.stdin });\n` +
      `  rl.on("line", (line) => {\n` +
      `    try {\n` +
      `      const d = JSON.parse(line);\n` +
      // Antigravity emits a terminal result ERROR frame even before any output
      `      if (d.event === "user") {\n` +
      `        console.log(JSON.stringify({ event: "result", result: { status: "ERROR", error: "Individual quota reached. Resets in 38h." } }));\n` +
      `        setTimeout(() => process.exit(0), 100);\n` +
      `      }\n` +
      `    } catch {}\n` +
      `  });\n` +
      `} else {\n` +
      `  const rl = readline.createInterface({ input: process.stdin });\n` +
      `  rl.on("line", (line) => {\n` +
      `    try {\n` +
      `      const d = JSON.parse(line);\n` +
      `      if (d.event === "user") {\n` +
      `        console.log(JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "hello from bob" } }));\n` +
      `        console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }));\n` +
      `      }\n` +
      `    } catch {}\n` +
      `  });\n` +
      `}\n`
  );
  const { driverPath } = writeDriver(caseHome, childPath);

  const { code, stdout } = await runDriverStaggered(driverPath, caseHome, {
    writes: [{ atMs: 0, line: USER_1 }],
    endAtMs: 2500
  });

  assert.equal(code, 0, `driver must exit cleanly (stdout=${stdout.slice(-400)})`);
  const frames = parseNdjson(stdout);
  const errorResults = frames.filter((f) => f.event === "result" && f.result?.status === "ERROR");
  assert.equal(errorResults.length, 0, `pre-output result ERROR must not be forwarded upstream when healthy fallback exists, got: ${stdout.slice(-500)}`);
  const successResults = frames.filter((f) => f.event === "result" && f.result?.status === "SUCCESS");
  assert.equal(successResults.length, 1, `turn must succeed seamlessly on bob, got: ${stdout.slice(-500)}`);
});


test("buildTurnAbortFrame shapes a namespaced ERROR terminal frame", async () => {
  const { buildTurnAbortFrame } = await import("../dist/index.js");
  const frame = JSON.parse(
    buildTurnAbortFrame("conv-1", "alice", "gemini", "bob", "claude", "Quota exhausted")
  );
  assert.equal(frame.event, "result");
  assert.equal(frame.result?.status, "ERROR");
  assert.ok(String(frame.result?.error).includes("alice"));
  assert.ok(String(frame.result?.error).includes("bob"));
  assert.equal(frame.agent_mux_failover_abort?.from, "alice");
  assert.equal(frame.agent_mux_failover_abort?.to, "bob");
  assert.equal(frame.conversation_id, "conv-1");

  const noConv = JSON.parse(buildTurnAbortFrame(null, "a", "gemini", "b", "gemini", "r"));
  assert.ok(!("conversation_id" in noConv), "conversation_id must be omitted when unknown");

  const noFallback = JSON.parse(buildTurnAbortFrame("c", "a", "gemini", "a", "gemini", "r", false));
  assert.equal(noFallback.agent_mux_failover_abort?.to, null);
  assert.ok(
    String(noFallback.result?.error).includes("No healthy fallback"),
    `no-fallback wording expected, got: ${noFallback.result?.error}`
  );
});

test("getKillGraceMs honors AGENT_MUX_KILL_GRACE_MS override", async () => {
  const { getKillGraceMs, CHILD_KILL_GRACE_MS } = await import("../dist/index.js");
  const saved = process.env.AGENT_MUX_KILL_GRACE_MS;
  try {
    delete process.env.AGENT_MUX_KILL_GRACE_MS;
    assert.equal(getKillGraceMs(), CHILD_KILL_GRACE_MS);
    process.env.AGENT_MUX_KILL_GRACE_MS = "123";
    assert.equal(getKillGraceMs(), 123);
    process.env.AGENT_MUX_KILL_GRACE_MS = "bogus";
    assert.equal(getKillGraceMs(), CHILD_KILL_GRACE_MS);
  } finally {
    if (saved === undefined) delete process.env.AGENT_MUX_KILL_GRACE_MS;
    else process.env.AGENT_MUX_KILL_GRACE_MS = saved;
  }
});

test("isNonInferenceHookError detects background lifecycle hook errors", async () => {
  const { isNonInferenceHookError } = await import("../dist/index.js");
  assert.ok(
    isNonInferenceHookError(
      "agent executor error: pre-invocation hook: context summarization: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 47h3m47s."
    )
  );
  assert.ok(isNonInferenceHookError("Failed to poll fetchAvailableModels: rate limit exceeded"));
  assert.ok(!isNonInferenceHookError("RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 47h3m47s."));
  assert.ok(!isNonInferenceHookError("quota exceeded for model gemini-3.8-flash-low"));
});

test("supervisor auto-heals / clears active cooldown upon successful turn", async () => {
  const { recordCooldown, checkCooldown } = await import("../dist/index.js");
  const caseHome = makeCaseHome("auto-heal-cooldown");

  // Pre-seed an active cooldown for alice
  const savedHome = process.env.AGENT_MUX_HOME;
  try {
    process.env.AGENT_MUX_HOME = caseHome;
    recordCooldown("antigravity", "alice", "gemini", 3600, "stale limit");
    assert.equal(checkCooldown("antigravity", "alice", "gemini").cooling, true, "precondition: must be cooling");

    const childPath = writeChild(
      caseHome,
      `const rl = readline.createInterface({ input: process.stdin });\n` +
        `console.log(JSON.stringify({ event: "init", conversation_id: "test-conv" }));\n` +
        `rl.on("line", () => {\n` +
        `  console.log(JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "ok" } }));\n` +
        `  console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }));\n` +
        `  setTimeout(() => process.exit(0), 100);\n` +
        `});\n`
    );
    const { driverPath } = writeDriver(caseHome, childPath);
    const { code } = await runDriver(driverPath, caseHome, {
      stdin: true,
      inputLines: [JSON.stringify({ event: "user", text: "hello" })]
    });

    assert.equal(code, 0, "turn should exit cleanly");
    const check = checkCooldown("antigravity", "alice", "gemini");
    assert.equal(check.cooling, false, "active cooldown must be cleared on successful turn");
  } finally {
    if (savedHome === undefined) delete process.env.AGENT_MUX_HOME;
    else process.env.AGENT_MUX_HOME = savedHome;
  }
});

test("supervisor caps cooldown duration to 60s for non-inference hook 429 errors", async () => {
  const { checkCooldown } = await import("../dist/index.js");
  const caseHome = makeCaseHome("cap-hook-cooldown");
  const hookError =
    "agent executor error: pre-invocation hook: context summarization: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 47h3m47s.";

  const childPath = writeChild(
    caseHome,
    `console.log(JSON.stringify({ event: "init", conversation_id: "test-conv" }));\n` +
      `if (profileName === "alice") {\n` +
      `  console.error(${JSON.stringify(hookError)});\n` +
      `  process.exit(1);\n` +
      `} else {\n` +
      `  setTimeout(() => console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS" } })), 100);\n` +
      `  setTimeout(() => process.exit(0), 200);\n` +
      `}\n`
  );
  const { driverPath } = writeDriver(caseHome, childPath);

  const savedHome = process.env.AGENT_MUX_HOME;
  try {
    process.env.AGENT_MUX_HOME = caseHome;
    const { code } = await runDriver(driverPath, caseHome);
    assert.equal(code, 0, "failover to bob should succeed");

    const cd = checkCooldown("antigravity", "alice", "gemini");
    assert.equal(cd.cooling, true, "alice should have cooldown recorded");
    assert.ok(
      cd.remainingSec <= 60,
      `hook cooldown duration must be capped at <= 60s, got: ${cd.remainingSec}s`
    );
  } finally {
    if (savedHome === undefined) delete process.env.AGENT_MUX_HOME;
    else process.env.AGENT_MUX_HOME = savedHome;
  }
});

// --- Candidate lifecycle isolation regression tests (issue #74) ---
//
// Per-candidate attempts own their stderr buffers, readline interfaces and
// exit listeners. A dying attempt's late events must never be evaluated as,
// or attribute quota to, the replacement candidate. Full-matrix exhaustion
// halts with a clean abort frame instead of ping-ponging, and cooldowns
// clear only via probe verification or verified turn completion.

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

// Driver variant with an artificially slow quota status check: it widens the
// async window between quota-frame detection and replacement selection, so a
// dying attempt's concurrent close/stderr events deterministically land while
// failover is in flight.
function writeSlowDriver(caseDir, childPath, quotaDelayMs) {
  const driverPath = path.join(caseDir, "driver.mjs");
  fs.writeFileSync(
    driverPath,
    `const { runSupervisor } = await import(${JSON.stringify(distIndexPath)});\n` +
      `import path from "node:path";\n` +
      `const caseDir = ${JSON.stringify(caseDir)};\n` +
      `const childPath = ${JSON.stringify(childPath)};\n` +
      `const delayMs = ${JSON.stringify(quotaDelayMs)};\n` +
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
      `  getQuotaStatus: async () => {\n` +
      `    await new Promise((r) => setTimeout(r, delayMs));\n` +
      `    return [\n` +
      `      { pool: "gemini", state: "READY" },\n` +
      `      { pool: "claude", state: "READY" }\n` +
      `    ];\n` +
      `  }\n` +
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

test("issue #74: dying attempt's concurrent close/stderr triggers exactly one failover and never cools the fallback", async () => {
  const caseHome = makeCaseHome("74-single-failover");
  const childPath = writeChild(
    caseHome,
    `console.log(JSON.stringify({ event: "init", conversation_id: "test-conv" }));\n` +
      `if (profileName === "alice") {\n` +
      `  const rl = readline.createInterface({ input: process.stdin });\n` +
      `  rl.on("line", (line) => {\n` +
      `    try {\n` +
      `      const d = JSON.parse(line);\n` +
      `      if (d.event === "user") {\n` +
      // Frame signal AND crash signal race: the stdout quota frame starts
      // failover while the immediate non-zero exit lands mid-flight.
      `        console.log(JSON.stringify({ event: "error", error: ${JSON.stringify(QUOTA_ERROR)} }));\n` +
      `        console.error(${JSON.stringify(QUOTA_ERROR)});\n` +
      `        setTimeout(() => process.exit(1), 20);\n` +
      `      }\n` +
      `    } catch {}\n` +
      `  });\n` +
      BOB_SERVE_ONCE
  );
  // Slow quota status keeps the failover window open while alice dies.
  const driverPath = writeSlowDriver(caseHome, childPath, 400);

  const { code, stdout, stderr } = await runDriverStaggered(driverPath, caseHome, {
    writes: [{ atMs: 0, line: USER_1 }],
    endAtMs: 3000
  });

  assert.equal(code, 0, `driver must exit cleanly (stderr=${stderr.slice(-400)})`);
  assert.equal(
    countOccurrences(stderr, "Automatically switching to healthy profile: bob"),
    1,
    `dying attempt must cause exactly one failover, got stderr: ${stderr.slice(-600)}`
  );
  assert.ok(stdout.includes("SUCCESS"), `replacement must serve the replayed turn, got: ${stdout.slice(-400)}`);
  assert.ok(
    !stderr.includes("Quota exceeded for gemini pool"),
    `recovered quota stderr must stay suppressed, got: ${stderr.slice(-300)}`
  );

  const savedHome = process.env.AGENT_MUX_HOME;
  try {
    process.env.AGENT_MUX_HOME = caseHome;
    const { checkCooldown } = await import("../dist/index.js");
    assert.equal(
      checkCooldown("antigravity", "alice", "gemini").cooling,
      true,
      "emitting candidate alice must carry the cooldown"
    );
    assert.equal(
      checkCooldown("antigravity", "bob", "gemini").cooling,
      false,
      "fallback candidate bob must NEVER inherit alice's quota lock"
    );
  } finally {
    if (savedHome === undefined) delete process.env.AGENT_MUX_HOME;
    else process.env.AGENT_MUX_HOME = savedHome;
  }
});

test("issue #74: full matrix exhaustion halts with a clean abort frame (no ping-pong)", async () => {
  const caseHome = makeCaseHome("74-exhaustion-halt");
  const childPath = writeChild(
    caseHome,
    `console.log(JSON.stringify({ event: "init", conversation_id: "test-conv" }));\n` +
      `const rl = readline.createInterface({ input: process.stdin });\n` +
      `rl.on("line", (line) => {\n` +
      `  try {\n` +
      `    const d = JSON.parse(line);\n` +
      // Every candidate fails the same turn with 429 before any output.
      `    if (d.event === "user") {\n` +
      `      console.log(JSON.stringify({ event: "error", error: ${JSON.stringify(QUOTA_ERROR)} }));\n` +
      `    }\n` +
      `  } catch {}\n` +
      `});\n`
  );
  const { driverPath } = writeDriver(caseHome, childPath);

  const { code, stdout, stderr } = await runDriverStaggered(driverPath, caseHome, {
    writes: [{ atMs: 0, line: USER_1 }],
    endAtMs: 3000,
    timeoutMs: 20000
  });

  assert.equal(code, 1, `exhausted matrix must halt with code 1 (stdout=${stdout.slice(-400)} stderr=${stderr.slice(-400)})`);
  assert.equal(
    countOccurrences(stderr, "Automatically switching to healthy profile"),
    1,
    `exactly one failover (alice->bob) before halting; no ping-pong, got: ${stderr.slice(-600)}`
  );
  assert.ok(
    stderr.includes("No healthy fallback"),
    `halt must report no healthy fallback, got: ${stderr.slice(-400)}`
  );
  const frames = parseNdjson(stdout);
  const aborts = frames.filter((f) => f.agent_mux_failover_abort);
  assert.equal(aborts.length, 1, `halt must emit exactly one terminal abort frame, got: ${stdout.slice(-500)}`);
  assert.equal(aborts[0].event, "result", "halt abort must be a terminal result frame");
  assert.equal(aborts[0].result?.status, "ERROR", "halt abort must never fabricate success");
  assert.equal(
    aborts[0].agent_mux_failover_abort?.to,
    null,
    `halt abort must carry no fallback target, got: ${JSON.stringify(aborts[0])}`
  );
  assert.ok(
    !stdout.includes("SUCCESS"),
    `no candidate serves the turn, got: ${stdout.slice(-400)}`
  );

  const savedHome = process.env.AGENT_MUX_HOME;
  try {
    process.env.AGENT_MUX_HOME = caseHome;
    const { checkCooldown } = await import("../dist/index.js");
    assert.equal(
      checkCooldown("antigravity", "alice", "gemini").cooling,
      true,
      "alice keeps its own emitted cooldown"
    );
    assert.equal(
      checkCooldown("antigravity", "bob", "gemini").cooling,
      true,
      "bob keeps its own emitted cooldown"
    );
  } finally {
    if (savedHome === undefined) delete process.env.AGENT_MUX_HOME;
    else process.env.AGENT_MUX_HOME = savedHome;
  }
});

test("issue #74: probe READY clears a long cooldown, LIMIT re-records it", async () => {
  const { recordCooldown, checkCooldown, verifyCooldownWithProbe, LONG_COOLDOWN_THRESHOLD_SEC } =
    await import("../dist/index.js");
  assert.equal(LONG_COOLDOWN_THRESHOLD_SEC, 300, "long-cooldown threshold must be 300s");

  const savedHome = process.env.AGENT_MUX_HOME;
  const caseHome = makeCaseHome("74-probe-clear");
  try {
    process.env.AGENT_MUX_HOME = caseHome;
    // 36h genuine quota exhaustion.
    recordCooldown("antigravity", "alice", "gemini", 36 * 3600, "Individual quota reached. Resets in 36h.");
    assert.equal(checkCooldown("antigravity", "alice", "gemini").cooling, true, "precondition: long lock active");

    const readyAdapter = {
      id: "antigravity",
      probe: async () => ({ state: "READY", details: "quota restored" })
    };
    const cleared = await verifyCooldownWithProbe(readyAdapter, "alice", "gemini");
    assert.equal(cleared.cleared, true, "READY probe must report clearing");
    assert.equal(
      checkCooldown("antigravity", "alice", "gemini").cooling,
      false,
      "READY probe must clear even a 36h lock"
    );

    const limitAdapter = {
      id: "antigravity",
      probe: async () => ({ state: "LIMIT", details: "Quota exceeded. Resets in 2h." })
    };
    const stillLimited = await verifyCooldownWithProbe(limitAdapter, "bob", "gemini");
    assert.equal(stillLimited.cleared, false, "LIMIT probe must not clear");
    const cd = checkCooldown("antigravity", "bob", "gemini");
    assert.equal(cd.cooling, true, "LIMIT probe must record the lock against the probed candidate");
    assert.ok(cd.remainingSec > 300, `LIMIT duration must be honored, got ${cd.remainingSec}s`);

    const noProbeAdapter = { id: "antigravity" };
    recordCooldown("antigravity", "alice", "claude", 3600, "seed");
    const untouched = await verifyCooldownWithProbe(noProbeAdapter, "alice", "claude");
    assert.equal(untouched.cleared, false, "provider without probe leaves locks untouched");
    assert.equal(checkCooldown("antigravity", "alice", "claude").cooling, true);
  } finally {
    if (savedHome === undefined) delete process.env.AGENT_MUX_HOME;
    else process.env.AGENT_MUX_HOME = savedHome;
  }
});

test("issue #74: step_update and bare exit-0 never clear a long cooldown (probe/verified-turn only)", async () => {
  const caseHome = makeCaseHome("74-no-stepupdate-clear");
  const savedHome = process.env.AGENT_MUX_HOME;
  try {
    process.env.AGENT_MUX_HOME = caseHome;
    const { recordCooldown, checkCooldown } = await import("../dist/index.js");
    // Genuine 1h quota exhaustion on alice.
    recordCooldown("antigravity", "alice", "gemini", 3600, "Quota exceeded. Resets in 1h.");

    const childPath = writeChild(
      caseHome,
      `console.log(JSON.stringify({ event: "init", conversation_id: "test-conv" }));\n` +
        `const rl = readline.createInterface({ input: process.stdin });\n` +
        `rl.on("line", () => {\n` +
        // Superficial stream output with NO terminal SUCCESS frame.
        `  console.log(JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "partial" } }));\n` +
        `  setTimeout(() => process.exit(0), 150);\n` +
        `});\n`
    );
    const { driverPath } = writeDriver(caseHome, childPath);
    const { code, stderr } = await runDriver(driverPath, caseHome, {
      stdin: true,
      inputLines: [JSON.stringify({ event: "user", text: "hello" })]
    });

    assert.equal(code, 0, `driver exit (stderr=${stderr.slice(-300)})`);
    assert.equal(
      checkCooldown("antigravity", "alice", "gemini").cooling,
      true,
      "long cooldown must survive step_update + bare exit-0; only probe or SUCCESS clears it"
    );
    assert.ok(
      !stderr.includes("Automatically switching"),
      `no failover expected, got: ${stderr.slice(-300)}`
    );
  } finally {
    if (savedHome === undefined) delete process.env.AGENT_MUX_HOME;
    else process.env.AGENT_MUX_HOME = savedHome;
  }
});



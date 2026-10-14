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

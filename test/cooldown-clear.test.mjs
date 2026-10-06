import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Workspace-scoped scratch: never touch global /tmp or the real home.
const here = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(path.join(here, "..", ".tmp"), { recursive: true });
const tmpHome = fs.mkdtempSync(path.join(here, "..", ".tmp", "cooldown-clear-"));
process.env.AGENT_MUX_HOME = tmpHome;

const {
  recordCooldown,
  checkCooldown,
  clearCooldownsMatching,
  clearAllCooldowns,
  loadCooldowns
} = await import("../dist/index.js");

function seed() {
  clearAllCooldowns();
  recordCooldown("antigravity", "alice", "gemini", 3600, "seed");
  recordCooldown("antigravity", "alice", "claude", 3600, "seed");
  recordCooldown("antigravity", "bob", "gemini", 3600, "seed");
  recordCooldown("opencode", "alice", "default", 3600, "seed");
}

test("clearCooldownsMatching - clear exact provider:profile:pool", () => {
  seed();
  const n = clearCooldownsMatching({ provider: "antigravity", profile: "alice", pool: "gemini" });
  assert.equal(n, 1);
  assert.equal(checkCooldown("antigravity", "alice", "gemini").cooling, false);
  assert.equal(checkCooldown("antigravity", "alice", "claude").cooling, true);
  assert.equal(checkCooldown("antigravity", "bob", "gemini").cooling, true);
  assert.equal(checkCooldown("opencode", "alice", "default").cooling, true);
});

test("clearCooldownsMatching - clear provider+profile leaves siblings", () => {
  seed();
  const n = clearCooldownsMatching({ provider: "antigravity", profile: "alice" });
  assert.equal(n, 2);
  assert.equal(checkCooldown("antigravity", "alice", "gemini").cooling, false);
  assert.equal(checkCooldown("antigravity", "alice", "claude").cooling, false);
  assert.equal(checkCooldown("antigravity", "bob", "gemini").cooling, true);
  assert.equal(checkCooldown("opencode", "alice", "default").cooling, true);
});

test("clearCooldownsMatching - clear provider only leaves other providers", () => {
  seed();
  const n = clearCooldownsMatching({ provider: "antigravity" });
  assert.equal(n, 3);
  assert.equal(checkCooldown("antigravity", "alice", "gemini").cooling, false);
  assert.equal(checkCooldown("antigravity", "alice", "claude").cooling, false);
  assert.equal(checkCooldown("antigravity", "bob", "gemini").cooling, false);
  assert.equal(checkCooldown("opencode", "alice", "default").cooling, true);
});

test("clearCooldownsMatching - clear all", () => {
  seed();
  const n = clearCooldownsMatching({});
  assert.equal(n, 4);
  assert.deepEqual(loadCooldowns(), {});
});

test("clearCooldownsMatching - no match clears nothing", () => {
  seed();
  const n = clearCooldownsMatching({ provider: "nope" });
  assert.equal(n, 0);
  assert.equal(Object.keys(loadCooldowns()).length, 4);
});

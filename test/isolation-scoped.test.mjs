import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Workspace-scoped scratch: never touch global /tmp or the real home.
const here = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(path.join(here, "..", ".tmp"), { recursive: true });
const root = fs.mkdtempSync(path.join(here, "..", ".tmp", "isolation-scoped-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const realHome = path.join(root, "home");
const muxHome = path.join(root, "mux");
const fakeBin = path.join(root, "fake-bin");
const realTokenRel = ".gemini/antigravity-cli/antigravity-oauth-token";
const realToken = path.join(realHome, realTokenRel);

fs.mkdirSync(path.dirname(realToken), { recursive: true });
fs.writeFileSync(realToken, "REAL-TOKEN\n");
fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(path.join(fakeBin, "bwrap"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

process.env.REAL_HOME = realHome;
process.env.AGENT_MUX_HOME = muxHome;
delete process.env.AGENT_MUX_ISOLATION_MODE;

const {
  getProviderAdapter,
  getIsolationMode,
  AGY_SCOPED_AUTH_PATHS,
  BWRAP_REQUIRED_MESSAGE,
  findExecutableInPath,
  buildScopedBwrapArgs
} = await import("../dist/index.js");

const adapter = getProviderAdapter("antigravity");

function makeProfile(name, token) {
  const profDir = path.join(muxHome, "profiles", "antigravity", name);
  if (token !== undefined) {
    const tokenPath = path.join(profDir, realTokenRel);
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, token);
  }
  return profDir;
}

test("scoped bwrap args bind only agy auth paths, mask D-Bus, and preserve real .gemini", () => {
  const profDir = makeProfile("alpha", "ALPHA-TOKEN\n");
  const args = buildScopedBwrapArgs(profDir, realHome, "/home/x/.local/bin/agy.bin", ["-p", "hi"]);

  assert.deepEqual(args, [
    "--dev-bind", "/", "/",
    "--tmpfs", "/run/user",
    "--unsetenv", "DBUS_SESSION_BUS_ADDRESS",
    "--bind", path.join(profDir, realTokenRel), realToken,
    "/home/x/.local/bin/agy.bin", "-p", "hi"
  ]);

  // The whole ~/.gemini directory must never be rebound.
  const bindTargets = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "--bind") bindTargets.push(args[i + 2]);
  }
  assert.deepEqual(bindTargets, [realToken]);
  assert.ok(!bindTargets.includes(path.join(realHome, ".gemini")));
  assert.deepEqual(AGY_SCOPED_AUTH_PATHS, [realTokenRel]);
});

test("scoped prepareExecution keeps real HOME, strips DBUS_SESSION_BUS_ADDRESS, resolves bwrap, and masks profiles", () => {
  const profDir = makeProfile("beta");
  const target = adapter.prepareExecution(
    "beta",
    ["--model", "gemini"],
    { PATH: fakeBin, DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1001/bus" },
    "scoped"
  );

  assert.equal(target.binary, path.join(fakeBin, "bwrap"));
  assert.equal(target.env.HOME, realHome);
  assert.equal(target.env.REAL_HOME, realHome);
  assert.equal(target.env.DBUS_SESSION_BUS_ADDRESS, undefined);
  assert.deepEqual(target.args.slice(0, 7), [
    "--dev-bind", "/", "/",
    "--tmpfs", "/run/user",
    "--unsetenv", "DBUS_SESSION_BUS_ADDRESS"
  ]);
  assert.ok(target.args.includes("--tmpfs"));
  assert.ok(target.args.includes(path.join(muxHome, "profiles")));
  assert.deepEqual(target.args.slice(-2), ["--model", "gemini"]);

  // A never-logged-in profile gets an empty placeholder so the real token is masked.
  const placeholder = path.join(profDir, realTokenRel);
  assert.ok(fs.existsSync(placeholder));
  assert.equal(fs.readFileSync(placeholder, "utf-8"), "");
});

test("scoped prepareExecution fails fast with actionable diagnostic when bwrap is missing", () => {
  const emptyBin = path.join(root, "empty-bin");
  fs.mkdirSync(emptyBin, { recursive: true });

  assert.throws(
    () => adapter.prepareExecution("alpha", [], { PATH: emptyBin }, "scoped"),
    (err) => {
      assert.ok(err.message.includes(BWRAP_REQUIRED_MESSAGE));
      assert.ok(err.message.includes("apt install bubblewrap"));
      assert.ok(err.message.includes("pacman -S bubblewrap"));
      assert.ok(err.message.includes("dnf install bubblewrap"));
      assert.ok(err.message.includes("config set isolation_mode home"));
      return true;
    }
  );
});

test("home mode is unchanged: profile dir becomes HOME and no bwrap involved", () => {
  const profDir = makeProfile("alpha", "ALPHA-TOKEN\n");
  const target = adapter.prepareExecution("alpha", ["-p", "hi"], { PATH: fakeBin }, "home");

  assert.equal(target.binary, adapter.defaultBinaryPath);
  assert.deepEqual(target.args, ["-p", "hi"]);
  assert.equal(target.env.HOME, profDir);
  assert.equal(target.env.REAL_HOME, realHome);
});

test("getIsolationMode resolves scoped by default, config opt-in, and env override", () => {
  const configPath = path.join(muxHome, "config.json");
  fs.rmSync(configPath, { force: true });
  delete process.env.AGENT_MUX_ISOLATION_MODE;

  assert.equal(getIsolationMode(), "scoped");

  fs.writeFileSync(configPath, JSON.stringify({ isolation_mode: "home" }));
  assert.equal(getIsolationMode(), "home");

  process.env.AGENT_MUX_ISOLATION_MODE = "scoped";
  assert.equal(getIsolationMode(), "scoped");

  delete process.env.AGENT_MUX_ISOLATION_MODE;
  fs.rmSync(configPath, { force: true });
  assert.equal(getIsolationMode(), "scoped");
});

test("findExecutableInPath ignores blank entries and non-executable files", () => {
  const nonExecBin = path.join(root, "nonexec-bin");
  fs.mkdirSync(nonExecBin, { recursive: true });
  fs.writeFileSync(path.join(nonExecBin, "bwrap"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });

  assert.equal(findExecutableInPath("bwrap", ""), undefined);
  assert.equal(findExecutableInPath("bwrap", path.join(root, "nope")), undefined);
  assert.equal(findExecutableInPath("bwrap", nonExecBin), undefined);
  assert.equal(
    findExecutableInPath("bwrap", `${nonExecBin}:${fakeBin}`),
    path.join(fakeBin, "bwrap")
  );
});

test("concurrent profiles see their own token under bwrap and never cross-contaminate", (t) => {
  const systemBwrap = findExecutableInPath("bwrap");
  if (!systemBwrap) {
    t.skip("bwrap not installed on host");
    return;
  }

  const alpha = makeProfile("alpha", "ALPHA-TOKEN\n");
  const beta = makeProfile("beta", "BETA-TOKEN\n");

  const run = (profDir, script) => {
    const args = buildScopedBwrapArgs(profDir, realHome, "/bin/sh", ["-c", script]);
    const res = spawnSync(systemBwrap, args, { encoding: "utf-8" });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  };

  const alphaSeen = run(alpha, `cat ${realToken}`);
  const betaSeen = run(beta, `cat ${realToken}`);
  assert.equal(alphaSeen, "ALPHA-TOKEN\n");
  assert.equal(betaSeen, "BETA-TOKEN\n");

  // A write from one profile is bind-mounted into that profile's token only.
  run(alpha, `printf 'ROTATED\\n' > ${realToken}`);
  assert.equal(fs.readFileSync(path.join(alpha, realTokenRel), "utf-8"), "ROTATED\n");
  assert.equal(fs.readFileSync(path.join(beta, realTokenRel), "utf-8"), "BETA-TOKEN\n");
  assert.equal(fs.readFileSync(realToken, "utf-8"), "REAL-TOKEN\n");

  // Restore for any later assertions in this process.
  fs.writeFileSync(path.join(alpha, realTokenRel), "ALPHA-TOKEN\n");
});

test("scoped bwrap isolates D-Bus and peer profile directories inside sandbox", (t) => {
  const systemBwrap = findExecutableInPath("bwrap");
  if (!systemBwrap) {
    t.skip("bwrap not installed on host");
    return;
  }

  const alpha = makeProfile("alpha", "ALPHA-TOKEN\n");
  const beta = makeProfile("beta", "BETA-TOKEN\n");
  const profilesDir = path.join(muxHome, "profiles");

  const run = (script) => {
    const args = buildScopedBwrapArgs(alpha, realHome, "/bin/sh", ["-c", script], {
      muxProfilesDir: profilesDir
    });
    return spawnSync(systemBwrap, args, {
      encoding: "utf-8",
      env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1001/bus" }
    });
  };

  // 1. D-Bus session bus address is unset and /run/user is an empty tmpfs
  const dbusRes = run('echo "DBUS=$DBUS_SESSION_BUS_ADDRESS"; ls /run/user');
  assert.equal(dbusRes.status, 0);
  assert.ok(dbusRes.stdout.includes("DBUS=\n"));

  // 2. Profiles directory is masked with empty tmpfs; peer profiles cannot be listed
  const profRes = run(`ls ${profilesDir}`);
  assert.equal(profRes.status, 0);
  assert.equal(profRes.stdout.trim(), "");

  // 3. Alpha's token is still intact and reachable at realToken
  const tokenRes = run(`cat ${realToken}`);
  assert.equal(tokenRes.status, 0);
  assert.equal(tokenRes.stdout, "ALPHA-TOKEN\n");
});

import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import type { ProviderAdapter } from "../types.js";
import { listProfiles, ensureProfile } from "./profiles.js";
import {
  getSurfaceAccountMode,
  getIsolationMode,
  type SurfaceAccountMode
} from "./config.js";
import { recordCooldown, logMuxMessage } from "./state.js";
import { selectProfile, candidateKey, applyPoolModel } from "./router.js";

export function isQuotaError(text: unknown): boolean {
  if (!text) return false;
  const t = String(text).toLowerCase();
  // Must be an actual resource exhaustion or 429 status code
  return (
    t.includes("resource_exhausted") ||
    t.includes("code 429") ||
    t.includes("status 429") ||
    t.includes("http 429") ||
    t.includes("err_quota_exceeded")
  );
}

export function isProcessCrashQuotaError(stderrLines: string[]): string | undefined {
  for (const line of stderrLines) {
    const t = line.toLowerCase();
    // Look for structured engine crash frame or explicit 429 error report
    if (
      t.includes("resource_exhausted (code 429)") ||
      t.includes("agy_error:") && t.includes("resource_exhausted") ||
      t.includes('"status":"resource_exhausted"') ||
      t.includes('"error_code":429')
    ) {
      return line;
    }
  }
  return undefined;
}

export function parseResetDurationSeconds(text: string): number {
  const m = text.match(/Resets in ([^\.]+)/);
  if (m) {
    const hours = m[1].match(/(\d+)\s*h/);
    const mins = m[1].match(/(\d+)\s*m/);
    const secs = m[1].match(/(\d+)\s*s/);
    let total = 0;
    if (hours) total += parseInt(hours[1], 10) * 3600;
    if (mins) total += parseInt(mins[1], 10) * 60;
    if (secs) total += parseInt(secs[1], 10);
    if (total > 0) return total;
  }
  return 3600; // default 1h
}

export interface SupervisorOptions {
  adapter: ProviderAdapter;
  initialProfile: string;
  initialPool?: string;
  binaryPath: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  surfaceAccount?: SurfaceAccountMode;
}

export function buildAccountToolFrame(
  conversationId: string,
  profile: string,
  isFailover = false,
  prevProfile?: string
): string {
  const stepIndex = isFailover ? 9990 : 0;
  const frame = {
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: stepIndex,
      state: "DONE",
      step_type: "tool",
      text_delta: "",
      tool_name: "agent-mux",
      tool_info: isFailover
        ? {
            name: "agent_mux_failover",
            parameters: {
              from: prevProfile || "unknown",
              to: profile,
              reason: "Quota exhausted (429)"
            },
            output: `Quota limit reached on ${prevProfile || "unknown"}. Automatically switched to ${profile}.`,
            error: null
          }
        : {
            name: "agent_mux",
            parameters: {
              account: profile
            },
            output: `Active account: ${profile}`,
            error: null
          },
      subagent_info: null,
      usage: null
    }
  };
  return JSON.stringify(frame);
}

export async function runSupervisor(options: SupervisorOptions): Promise<number> {
  const { adapter, binaryPath, args } = options;
  const surfaceMode = options.surfaceAccount ?? getSurfaceAccountMode();
  const targetPool = adapter.resolveTargetPool(args, options.env || process.env);
  let currentProfile = options.initialProfile;
  // The requested pool stays fixed for the whole session so the policy candidate
  // matrix is always built against the original request, not the current fallback.
  let currentPool = options.initialPool || targetPool;
  let currentArgs = currentPool !== targetPool ? applyPoolModel(adapter, args, currentPool) : [...args];
  let conversationId: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--conversation" && i + 1 < args.length) {
      conversationId = args[i + 1];
      break;
    }
  }

  let child: ChildProcess | null = null;
  let lastUserMessage: string | null = null;
  let activeChildStderr: string[] = [];
  const killedChildPids = new Set<number>();
  let isRelaunching = false;
  let relaunchCount = 0;
  const triedCandidates = new Set<string>([candidateKey(currentProfile, currentPool)]);

  // Turn state
  let turnSurfaced = false;
  let turnMessagePrefixed = false;
  let hadFailover = false;
  let failoverPrevProfile: string | null = null;
  let turnHadOutput = false;

  function injectAccountFrame(isFailover = false, prevProfile?: string) {
    if (surfaceMode !== "tool" && surfaceMode !== "both") return;
    if (!conversationId) return;

    try {
      const frameStr = buildAccountToolFrame(
        conversationId,
        currentProfile,
        isFailover,
        prevProfile
      );
      process.stdout.write(frameStr + "\n");
    } catch {}
  }

  function spawnChild(prof: string): { proc: ChildProcess; stderrLines: string[] } {
    const profDir = ensureProfile(adapter, prof);
    const isolationMode = getIsolationMode();

    const finalArgs = [...currentArgs];
    if (conversationId && !finalArgs.includes("--conversation")) {
      finalArgs.push("--conversation", conversationId);
    }

    const baseEnv = {
      ...process.env,
      ...options.env
    };

    let execTarget: { binary: string; args: string[]; env: NodeJS.ProcessEnv };
    if (adapter.prepareExecution) {
      execTarget = adapter.prepareExecution(prof, finalArgs, baseEnv, isolationMode);
    } else {
      execTarget = {
        binary: binaryPath,
        args: finalArgs,
        env: {
          ...baseEnv,
          HOME: profDir
        }
      };
    }

    const proc = spawn(execTarget.binary, execTarget.args, {
      env: execTarget.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const stderrLines: string[] = [];
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stderr.write(text);
      stderrLines.push(text);
      if (stderrLines.length > 25) stderrLines.shift();
    });

    return { proc, stderrLines };
  }

  const initialSpawn = spawnChild(currentProfile);
  child = initialSpawn.proc;
  activeChildStderr = initialSpawn.stderrLines;

  // Pipe stdin from parent to active child
  const parentStdinLines = readline.createInterface({ input: process.stdin });
  parentStdinLines.on("line", (line) => {
    try {
      const data = JSON.parse(line);
      if (data.event === "user") {
        lastUserMessage = line;
        activeChildStderr.length = 0; // Clear stale stderr from previous turns
        turnSurfaced = false;
        turnMessagePrefixed = false;
        turnHadOutput = false;
        relaunchCount = 0;
        triedCandidates.clear();
        triedCandidates.add(candidateKey(currentProfile, currentPool));
      }
    } catch {}

    if (child && child.stdin && !child.stdin.destroyed) {
      try {
        child.stdin.write(line + "\n");
      } catch {}
    }
  });

  parentStdinLines.on("close", () => {
    if (child && child.stdin && !child.stdin.destroyed) {
      try {
        child.stdin.end();
      } catch {}
    }
  });

  const onSigInt = () => { if (child) child.kill("SIGINT"); };
  const onSigTerm = () => { if (child) child.kill("SIGTERM"); };
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  return new Promise<number>((resolve) => {
    function attachStdoutListener(proc: ChildProcess, stderrLines: string[], prof: string, pool: string) {
      const rl = readline.createInterface({ input: proc.stdout! });

      rl.on("line", async (line) => {
        let quotaDetected = false;
        let parsedFrame: any = null;
        let errorDetails = "";

        try {
          parsedFrame = JSON.parse(line);
          const eventType = parsedFrame.event;

          if (eventType === "init") {
            if (!conversationId && parsedFrame.conversation_id) {
              conversationId = parsedFrame.conversation_id;
            }
          }

          if (eventType === "step_update") {
            const su = parsedFrame.step_update;
            if (su && (su.step_type === "agent_response" || su.step_type === "tool")) {
              turnHadOutput = true;
            }
          }

          if (eventType === "result") {
            const res = parsedFrame.result || {};
            if (res.status === "ERROR" && isQuotaError(res.error)) {
              quotaDetected = true;
              errorDetails = String(res.error);
            } else {
              lastUserMessage = null;
              turnSurfaced = false;
              turnMessagePrefixed = false;
              turnHadOutput = false;
              hadFailover = false;
              failoverPrevProfile = null;
              relaunchCount = 0;
              triedCandidates.clear();
              triedCandidates.add(candidateKey(currentProfile, currentPool));
            }
          } else if (eventType === "error" && isQuotaError(parsedFrame.error)) {
            quotaDetected = true;
            errorDetails = String(parsedFrame.error);
          }
        } catch {}

        if (quotaDetected) {
          await handleRelaunch("Quota exhausted", prof, pool, errorDetails, line);
          return;
        }

        // Handle account surfacing for active turn
        if (parsedFrame && lastUserMessage) {
          // 1. Tool card injection on first output of turn
          if (!turnSurfaced && parsedFrame.event === "step_update") {
            turnSurfaced = true;
            injectAccountFrame(false);
          }

          // 2. Message prefix injection on first agent text delta
          if (
            (surfaceMode === "message" || surfaceMode === "both") &&
            !turnMessagePrefixed &&
            parsedFrame.event === "step_update" &&
            parsedFrame.step_update?.step_type === "agent_response" &&
            parsedFrame.step_update?.text_delta
          ) {
            turnMessagePrefixed = true;
            const prefix = hadFailover
              ? `> ⚠️ **[agent-mux]** Quota exhausted on \`${failoverPrevProfile}\`. Switched to \`${currentProfile}\`\n\n`
              : `> 🔄 **[agent-mux]** Active account: \`${currentProfile}\`\n\n`;
            parsedFrame.step_update.text_delta = prefix + parsedFrame.step_update.text_delta;
            hadFailover = false;
            process.stdout.write(JSON.stringify(parsedFrame) + "\n");
            return;
          }
        }

        // Pass-through regular frames to client
        process.stdout.write(line + "\n");
      });

      proc.on("close", async (code) => {
        if (isRelaunching) return;
        if (proc.pid && killedChildPids.has(proc.pid)) return;

        // Clean exit: do not attempt quota relaunch
        if (code === 0) {
          process.off("SIGINT", onSigInt);
          process.off("SIGTERM", onSigTerm);
          resolve(0);
          return;
        }

        // Check if process crashed due to quota error during active turn
        const crashLine = isProcessCrashQuotaError(stderrLines);
        if (lastUserMessage && crashLine) {
          await handleRelaunch("Process exited with quota limit", prof, pool, crashLine);
          return;
        }

        process.off("SIGINT", onSigInt);
        process.off("SIGTERM", onSigTerm);
        resolve(code ?? 0);
      });
    }

    async function handleRelaunch(
      reason: string,
      failedProfile: string,
      failedPool: string,
      errorDetails?: string,
      rawErrorLine?: string
    ) {
      if (isRelaunching) return;

      const durSec = parseResetDurationSeconds(errorDetails || "");
      logMuxMessage("SUPERVISOR", `Quota error detected on profile '${failedProfile}' (pool: '${failedPool}'): ${reason} | details: ${errorDetails}`);
      recordCooldown(adapter.id, failedProfile, failedPool, durSec, errorDetails || reason);
      triedCandidates.add(candidateKey(failedProfile, failedPool));

      // Check if a healthy fallback exists in the policy-ordered candidate matrix
      const decision = await selectProfile(
        adapter,
        args,
        options.env || process.env,
        "auto",
        Array.from(triedCandidates)
      );

      // If all candidates are in cooldown or already tried, STOP. Do not flap!
      if (decision.allCooldown || triedCandidates.has(candidateKey(decision.profile, decision.pool))) {
        logMuxMessage("SUPERVISOR", `All candidates for requested pool '${targetPool}' in cooldown or already tried. Stopping failover.`);
        process.stderr.write(
          `\n\x1b[31;1m[agent-mux] QUOTA EXHAUSTED: ${reason} on ${failedProfile} (pool: ${failedPool}).\x1b[0m\n` +
          `\x1b[33mAll candidates in the configured failover order are currently in cooldown or rate-limited.\x1b[0m\n` +
          `\x1b[90mSuggested actions:\x1b[0m\n` +
          `  1. Check quota recovery:   \x1b[36magent-mux status ${adapter.id}\x1b[0m\n` +
          `  2. View active cooldowns:  \x1b[36magent-mux cooldowns\x1b[0m\n` +
          (targetPool === "claude"
            ? `  3. Switch model pool:      \x1b[36m--model gemini-2.5-pro\x1b[0m (Gemini pool often has quota)\n`
            : "") +
          `  4. Clear cooldown locks:   \x1b[36magent-mux cooldowns clear\x1b[0m (if provider quota reset)\n` +
          `  5. Add another account:    \x1b[36magent-mux profile add ${adapter.id} <account>\x1b[0m\n\n`
        );
        if (rawErrorLine) {
          process.stdout.write(rawErrorLine + "\n");
        }
        return;
      }

      isRelaunching = true;
      relaunchCount++;

      const prevProf = failedProfile;
      const prevPool = failedPool;
      const nextProf = decision.profile;
      const nextPool = decision.pool;
      triedCandidates.add(candidateKey(nextProf, nextPool));

      // Only rewrite the model when the policy spills over into a different pool.
      if (nextPool !== currentPool) {
        currentArgs = nextPool === targetPool ? [...args] : applyPoolModel(adapter, args, nextPool);
      }

      const appliedModel = adapter.getPoolModel?.(nextPool);
      logMuxMessage(
        "SUPERVISOR",
        `Failing over from '${prevProf}' (pool ${prevPool}) to '${nextProf}' (pool ${nextPool}${appliedModel ? `, model ${appliedModel}` : ""})`
      );
      process.stderr.write(
        `\n[agent-mux] ${reason} on ${prevProf} (pool: ${prevPool}). Automatically switching to healthy profile: ${nextProf} (pool: ${nextPool})...\n`
      );

      // Kill previous child
      if (child) {
        try {
          if (child.pid) killedChildPids.add(child.pid);
          child.kill("SIGTERM");
        } catch {}
      }

      currentProfile = nextProf;
      currentPool = nextPool;
      hadFailover = true;
      failoverPrevProfile = prevProf;

      // Inject failover tool frame upstream immediately
      injectAccountFrame(true, prevProf);

      const newSpawn = spawnChild(currentProfile);
      const newChild = newSpawn.proc;
      child = newChild;
      activeChildStderr = newSpawn.stderrLines;

      let initConsumed = false;
      const rl = readline.createInterface({ input: newChild.stdout! });

      rl.on("line", (line) => {
        if (!initConsumed) {
          try {
            const frame = JSON.parse(line);
            if (frame.event === "init") {
              initConsumed = true;
              isRelaunching = false;
              turnSurfaced = false;
              rl.close();

              // Only re-send last user message if previous turn had not produced output
              if (!turnHadOutput && lastUserMessage && newChild.stdin && !newChild.stdin.destroyed) {
                newChild.stdin.write(lastUserMessage + "\n");
              }

              // Hook normal stdout listener
              attachStdoutListener(newChild, newSpawn.stderrLines, currentProfile, currentPool);
              return;
            }
          } catch {}
        }
      });
    }

    attachStdoutListener(child!, activeChildStderr, currentProfile, currentPool);
  });
}

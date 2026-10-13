import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import type { ProviderAdapter, RoutingDecision } from "../types.js";
import { listProfiles, ensureProfile } from "./profiles.js";
import {
  getSurfaceAccountMode,
  getIsolationMode,
  getRoutingPolicy,
  type SurfaceAccountMode
} from "./config.js";
import { logMuxMessage } from "./state.js";
import { recordCooldownFamily } from "./pools.js";
import { selectProfile, candidateKey, applyPoolModel, hasExplicitModelArg } from "./router.js";
import { parseResetDurationSeconds, isCapacityError } from "./cooldown.js";

export { parseResetDurationSeconds, isCapacityError } from "./cooldown.js";

/**
 * Extract readable text from a stream error payload. Engine frames may carry
 * the failure as a plain string or as a structured object (e.g.
 * `{ event: "error", error: { code: 429, message: "..." } }`); `String(obj)`
 * would collapse those to "[object Object]" and hide the quota signal.
 */
export function errorTextOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of [
      "message",
      "error",
      "details",
      "detail",
      "reason",
      "code",
      "status",
      "error_code"
    ]) {
      const v = obj[key];
      if (typeof v === "string" || typeof v === "number") parts.push(String(v));
    }
    if (parts.length > 0) return parts.join(" ");
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function isHardQuotaError(text: unknown): boolean {
  if (!text) return false;
  let raw: string;
  if (typeof text === "string") {
    raw = text;
  } else {
    try {
      raw = JSON.stringify(text) ?? "";
    } catch {
      raw = String(text);
    }
  }
  if (!raw) return false;
  const t = raw.toLowerCase();
  return (
    t.includes("resource_exhausted") ||
    t.includes("resource exhausted") ||
    /\b429\b/.test(t) ||
    t.includes("err_quota_exceeded") ||
    t.includes("quota_exceeded") ||
    t.includes("quota exceeded") ||
    t.includes("quota exhausted") ||
    t.includes("insufficient quota") ||
    t.includes("rate limit") ||
    t.includes("rate_limit") ||
    t.includes("rate-limit") ||
    t.includes("ratelimit") ||
    t.includes("too many requests") ||
    t.includes("code 429") ||
    t.includes("status 429") ||
    t.includes("http 429")
  );
}

export function isQuotaError(text: unknown): boolean {
  return isHardQuotaError(text) || isCapacityError(text);
}

export function isProcessCrashQuotaError(stderrLines: string[]): string | undefined {
  // Same vocabulary as live-frame detection: any quota signal on stderr
  // during an active turn means the crash was a quota failure.
  for (const line of stderrLines) {
    if (isQuotaError(line)) {
      return line;
    }
  }
  return undefined;
}


export function isDebugLoggingEnabled(): boolean {
  return Boolean(process.env.DEBUG || process.env.AGENT_MUX_DEBUG);
}

export interface CandidateSelectionLogger {
  log(profile: string, pool: string, reason: string): boolean;
  lastSelected(): string | null;
}

/**
 * Emits a single 'Selected candidate ...' line per `(profile, pool)`
 * transition. Consecutive turns that keep the same candidate stay quiet
 * unless DEBUG or AGENT_MUX_DEBUG is set, so the active decision remains
 * visible without flooding the log on every turn.
 */
export function createCandidateSelectionLogger(
  write: (message: string) => void = (message) => logMuxMessage("SUPERVISOR", message)
): CandidateSelectionLogger {
  let last: string | null = null;
  return {
    log(profile: string, pool: string, reason: string): boolean {
      const key = candidateKey(profile, pool);
      if (key === last && !isDebugLoggingEnabled()) return false;
      last = key;
      write(`Selected candidate ${profile} (pool: ${pool}): ${reason}`);
      return true;
    },
    lastSelected(): string | null {
      return last;
    }
  };
}

export interface SupervisorOptions {
  adapter: ProviderAdapter;
  initialProfile: string;
  initialPool?: string;
  /** Explicit pool request (e.g. from --pool); falls back to model inference. */
  poolOverride?: string;
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
  const targetPool = options.poolOverride ?? adapter.resolveTargetPool(args, options.env || process.env);
  let currentProfile = options.initialProfile;
  // The requested pool stays fixed for the whole session so the policy candidate
  // matrix is always built against the original request, not the current fallback.
  let currentPool = options.initialPool || targetPool;
  // Preserve an explicit `--model` when no pool change is required; only
  // rewrite to the pool default on spillover/failover or when `--pool` was
  // given without a model.
  let currentArgs = currentPool !== targetPool
    ? applyPoolModel(adapter, args, currentPool, targetPool)
    : hasExplicitModelArg(args)
      ? [...args]
      : applyPoolModel(adapter, args, currentPool, targetPool);
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
  const selectionLogger = createCandidateSelectionLogger();
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
      // Buffer the whole turn: a quota failure that failover recovers from
      // must never reach the calling harness as a raw error banner.
      stderrLines.push(chunk.toString());
    });

    return { proc, stderrLines };
  }

  const initialSpawn = spawnChild(currentProfile);
  child = initialSpawn.proc;
  activeChildStderr = initialSpawn.stderrLines;
  selectionLogger.log(currentProfile, currentPool, "initial selection");

  // Pipe stdin from parent to active child
  const parentStdinLines = readline.createInterface({ input: process.stdin });
  parentStdinLines.on("line", (line) => {
    try {
      const data = JSON.parse(line);
      if (data.event === "user") {
        lastUserMessage = line;
        activeChildStderr.length = 0; // Clear stale stderr from previous turns
        selectionLogger.log(currentProfile, currentPool, "active candidate for turn");
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
    function flushBufferedStderr(buffer: string[]): void {
      if (buffer.length === 0) return;
      const text = buffer.join("");
      buffer.length = 0;
      try {
        process.stderr.write(text);
      } catch {}
    }

    function filterTransientNoise(buffer: string[]): string[] {
      return buffer.filter((chunk) => !isCapacityError(chunk));
    }

    function flushTurnStderr(buffer: string[]): void {
      // A turn that still carries a quota signal stays buffered: the child may
      // exit next and failover could still recover it.
      if (isProcessCrashQuotaError(buffer)) return;
      const clean = filterTransientNoise(buffer);
      buffer.length = 0;
      if (clean.length > 0) {
        flushBufferedStderr(clean);
      }
    }


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
              errorDetails = errorTextOf(res.error);
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
              flushTurnStderr(stderrLines);
            }
          } else if (eventType === "error" && isQuotaError(parsedFrame.error)) {
            quotaDetected = true;
            errorDetails = errorTextOf(parsedFrame.error);
          }
        } catch {}

        if (quotaDetected) {
          await handleRelaunch("Quota exhausted", prof, pool, errorDetails, line, stderrLines);
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

        // Check for quota error in stderr regardless of exit code.
        // A process may exit 0 but still have printed a quota failure to stderr.
        // However, if the turn succeeded (turnHadOutput) and exited 0, transient retry
        // warnings (like attempt 1 503) that resolved naturally are NOT crashes.
        const crashLine = isProcessCrashQuotaError(stderrLines);
        if (crashLine && (!turnHadOutput || isHardQuotaError(crashLine))) {
          await handleRelaunch("Process exited with quota limit", prof, pool, crashLine, undefined, stderrLines);
          return;
        }

        // Terminal exit: release buffered stderr, filtering out transient retry noise
        // if the turn completed cleanly with code 0.
        if (code === 0) {
          const clean = filterTransientNoise(stderrLines);
          stderrLines.length = 0;
          flushBufferedStderr(clean);
          process.off("SIGINT", onSigInt);
          process.off("SIGTERM", onSigTerm);
          resolve(0);
          return;
        }

        // Terminal (non-quota) exit: release everything the turn buffered.
        flushBufferedStderr(stderrLines);
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
      rawErrorLine?: string,
      bufferedStderr: string[] = []
    ) {
      if (isRelaunching) return;

      const durSec = parseResetDurationSeconds(errorDetails || "");
      logMuxMessage("SUPERVISOR", `Quota error detected on profile '${failedProfile}' (pool: '${failedPool}'): ${reason} | details: ${errorDetails} (cooldown: ${durSec}s)`);
      if (durSec > 0) {
        recordCooldownFamily(adapter.id, failedProfile, failedPool, durSec, errorDetails || reason);
      }
      triedCandidates.add(candidateKey(failedProfile, failedPool));


      // Check if a healthy fallback exists in the policy-ordered candidate
      // matrix. The supervisor owns the selection log so repeated turns on the
      // same candidate do not spam it.
      let decision: RoutingDecision & { allCooldown?: boolean };
      try {
        decision = await selectProfile(
          adapter,
          args,
          options.env || process.env,
          "auto",
          Array.from(triedCandidates),
          getRoutingPolicy(),
          options.poolOverride,
          (d) => selectionLogger.log(d.profile, d.pool, d.reason)
        );
      } catch (err) {
        // Failover could not be scheduled: the failure is terminal, so the raw
        // buffered stderr must reach the caller.
        flushBufferedStderr(bufferedStderr);
        logMuxMessage("SUPERVISOR", `Failover failed: ${(err as Error)?.message ?? String(err)}`);
        isRelaunching = true;
        if (child) {
          try {
            if (child.pid) killedChildPids.add(child.pid);
            child.kill("SIGTERM");
          } catch {}
        }
        process.off("SIGINT", onSigInt);
        process.off("SIGTERM", onSigTerm);
        resolve(1);
        return;
      }

      // If all candidates are in cooldown, selectProfile returns the one with
      // the shortest remaining cooldown (bestCandidate). Proceed with that
      // candidate rather than aborting — it will become healthy soonest.
      // The triedCandidates.has check is redundant because selectProfile
      // already excludes tried candidates via the excludeCandidates parameter.
      if (decision.allCooldown) {
        // Failover is not clean here, so keep the raw quota output visible.
        flushBufferedStderr(bufferedStderr);
        logMuxMessage("SUPERVISOR", `All candidates for requested pool '${targetPool}' in cooldown; failing over to shortest cooldown: ${decision.profile} (pool: ${decision.pool}, ${decision.reason})`);
      } else {
        // Recovered automatically: drop the failed candidate's raw stderr so
        // the caller never sees a transient quota banner.
        bufferedStderr.length = 0;
      }

      isRelaunching = true;
      relaunchCount++;

      const prevProf = failedProfile;
      const prevPool = failedPool;
      const nextProf = decision.profile;
      const nextPool = decision.pool;
      triedCandidates.add(candidateKey(nextProf, nextPool));

      // Only rewrite the model when the policy spills over into a different pool.
      // Returning to the originally requested pool restores the caller's args
      // (preserving an explicit --model); moving to a new pool applies that
      // pool's default model.
      if (nextPool !== currentPool) {
        currentArgs = applyPoolModel(adapter, args, nextPool, targetPool);
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

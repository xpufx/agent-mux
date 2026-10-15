import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import type { ProviderAdapter, QuotaState, RoutingDecision } from "../types.js";
import { listProfiles, ensureProfile } from "./profiles.js";
import {
  getSurfaceAccountMode,
  getIsolationMode,
  getRoutingPolicy,
  type IsolationMode,
  type SurfaceAccountMode
} from "./config.js";
import { logMuxMessage, clearCooldown } from "./state.js";
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
    t.includes("individual quota reached") ||
    t.includes("quota reached") ||
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

/**
 * A terminal quota result must come from the engine's native error payload.
 * agent-mux emits result/ERROR frames for interrupted turns too; their
 * diagnostic text is not evidence that the replacement candidate is limited.
 */
export function isNativeEngineQuotaResult(frame: unknown): boolean {
  if (!frame || typeof frame !== "object") return false;
  const candidate = frame as Record<string, unknown>;
  if (candidate.event !== "result" || candidate.agent_mux_failover_abort) return false;
  const result = candidate.result;
  if (!result || typeof result !== "object") return false;
  const payload = result as Record<string, unknown>;
  if (payload.status !== "ERROR" || !("error" in payload)) return false;
  const error = payload.error;
  if (typeof error !== "string" && (typeof error !== "object" || error === null)) {
    return false;
  }
  const text = errorTextOf(error).toLowerCase();
  const nativeStringShape =
    typeof error !== "string" ||
    /^(?:error\s+429\b|resource[_ ]exhausted\b|quota exceeded\b|individual quota reached\b|rate limit\b|rate_limit\b)/i.test(
      error.trim()
    );
  return (
    !text.includes("agent-mux") &&
    !text.includes("failover_abort") &&
    !text.includes("diagnostic") &&
    nativeStringShape &&
    isQuotaError(error)
  );
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

/**
 * Detect rate limits from non-inference background hooks (e.g. context summarization,
 * experiments, model catalog discovery) rather than actual model generation quota.
 */
export function isNonInferenceHookError(text: unknown): boolean {
  if (typeof text !== "string") {
    try {
      text = JSON.stringify(text) ?? "";
    } catch {
      text = String(text);
    }
  }
  const t = (text as string).toLowerCase();
  return (
    t.includes("context summarization") ||
    t.includes("pre-invocation hook") ||
    t.includes("fetchavailablemodels") ||
    t.includes("telemetry") ||
    t.includes("experiment refresh")
  );
}



export function isDebugLoggingEnabled(): boolean {
  return Boolean(process.env.DEBUG || process.env.AGENT_MUX_DEBUG);
}

/** Grace period between group SIGTERM and SIGKILL escalation. */
export const CHILD_KILL_GRACE_MS = 2000;
/** Max wait for a replacement child to emit `init` before unblocking failover state. */
export const RELAUNCH_INIT_TIMEOUT_MS = 15_000;

/**
 * Effective SIGTERM→SIGKILL escalation grace. Operators and tests may lower
 * it via `AGENT_MUX_KILL_GRACE_MS` (milliseconds); invalid values fall back
 * to {@link CHILD_KILL_GRACE_MS}.
 */
export function getKillGraceMs(): number {
  const raw = process.env.AGENT_MUX_KILL_GRACE_MS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return CHILD_KILL_GRACE_MS;
}

/**
 * Terminate a supervised child and everything it spawned (issue #69).
 *
 * Children are spawned detached (own process group), so grandchildren that
 * inherited stdout/stderr (runaway `grep`, subagent tasks, bwrap members)
 * would otherwise keep the OS pipe open forever and downstream harnesses
 * would never observe EOF. Killing only the direct PID leaks those handles.
 *
 * Strategy: SIGTERM the whole process group, escalate to SIGKILL after a
 * grace period, and destroy our local stdio handles so readline consumers
 * settle promptly. Escalation timers are unref'd so they never hold the
 * supervisor event loop open.
 */
export function killChildTree(
  proc: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
  graceMs: number = getKillGraceMs()
): void {
  const pid = proc.pid;
  const canGroupKill = typeof pid === "number" && process.platform !== "win32";
  const sendSignal = (sig: NodeJS.Signals): void => {
    try {
      if (canGroupKill) {
        process.kill(-(pid as number), sig);
      } else {
        proc.kill(sig);
      }
    } catch {
      try {
        proc.kill(sig);
      } catch {}
    }
  };

  sendSignal(signal);

  if (graceMs > 0 && proc.exitCode === null) {
    const timer = setTimeout(() => {
      if (proc.exitCode === null) {
        sendSignal("SIGKILL");
      }
    }, graceMs);
    try {
      timer.unref?.();
    } catch {}
    proc.once("exit", () => clearTimeout(timer));
  }

  // Release our pipe ends promptly so local readline interfaces settle even
  // if orphaned grandchildren still hold the write end open.
  try {
    proc.stdin?.destroy?.();
  } catch {}
  try {
    (proc.stdout as unknown as { destroy?: () => void })?.destroy?.();
  } catch {}
  try {
    (proc.stderr as unknown as { destroy?: () => void })?.destroy?.();
  } catch {}
}

/**
 * Build the terminal abort frame emitted when a failover kills a turn that
 * already produced output (issue #69).
 *
 * The frame mirrors the engine's own `{ event: "result", result: { status } }`
 * shape so downstream NDJSON consumers finalize the turn as failed instead
 * of waiting forever. It is namespaced (`agent_mux_failover_abort`) and
 * always `ERROR` — agent-mux never fabricates success.
 */
export function buildTurnAbortFrame(
  conversationId: string | null,
  fromProfile: string,
  fromPool: string,
  toProfile: string,
  toPool: string,
  reason: string,
  failedOver = true
): string {
  const outcome = failedOver
    ? `Failed over to '${toProfile}' (pool: ${toPool}). ` +
      `Partial output above is incomplete; retry your last message.`
    : `No healthy fallback profile is available; the turn cannot continue.`;
  const frame: Record<string, unknown> = {
    event: "result",
    result: {
      status: "ERROR",
      error:
        `[agent-mux] Turn aborted mid-stream: ${reason} on '${fromProfile}' ` +
        `(pool: ${fromPool}). ${outcome}`
    },
    agent_mux_failover_abort: {
      from: fromProfile,
      from_pool: fromPool,
      to: failedOver ? toProfile : null,
      to_pool: failedOver ? toPool : null,
      reason
    }
  };
  if (conversationId) {
    frame.conversation_id = conversationId;
  }
  return JSON.stringify(frame);
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

/**
 * Cooldowns longer than this threshold are genuine quota exhaustions: they
 * must NOT be healed by superficial stream events or bare process exits.
 * They clear only via explicit probe verification (`agent-mux probe`
 * confirming READY) or deterministic turn completion (`result SUCCESS`
 * produced by that specific profile). Shorter transient locks may heal on
 * duration expiry / clean exit.
 *
 * (issue #74)
 */
export const LONG_COOLDOWN_THRESHOLD_SEC = 300;

/**
 * A single supervised child execution for one `(profile, pool)` candidate.
 *
 * All lifecycle state — the child process handle, the buffered stderr, and
 * the retired flag — is strictly scoped to this instance. Once an attempt
 * is retired (failover initiated), its late-arriving `close`/`error`/stderr
 * events must be dropped by the supervisor instead of being evaluated in
 * the context of the replacement candidate. Cooldown attribution always
 * uses this attempt's own `profile`/`pool`, never the supervisor's mutable
 * `currentProfile`/`currentPool`.
 *
 * (issue #74: per-candidate process lifecycle isolation)
 */
export class CandidateAttempt {
  readonly id: number;
  readonly profile: string;
  readonly pool: string;
  readonly proc: ChildProcess;
  readonly stderrLines: string[] = [];
  retired = false;

  constructor(id: number, profile: string, pool: string, proc: ChildProcess) {
    this.id = id;
    this.profile = profile;
    this.pool = pool;
    this.proc = proc;
    proc.stderr?.on("data", (chunk: Buffer) => {
      // Buffered per attempt: a quota failure that failover recovers from
      // must never reach the calling harness as a raw error banner, and a
      // dying attempt's late stderr must never be attributed to its
      // replacement.
      this.stderrLines.push(chunk.toString());
    });
  }

  get key(): string {
    return candidateKey(this.profile, this.pool);
  }

  /**
   * Retire this attempt exactly once: mark it so all of its late process
   * events are ignored, record its pid so stray close handlers skip it,
   * and terminate its whole process tree.
   */
  retire(retiredPids?: Set<number>, signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.retired) return;
    this.retired = true;
    if (this.proc.pid !== undefined && retiredPids) {
      retiredPids.add(this.proc.pid);
    }
    killChildTree(this.proc, signal);
  }
}

export interface ExecuteCandidateAttemptOptions {
  adapter: ProviderAdapter;
  profile: string;
  pool: string;
  attemptId: number;
  /** Supervisor-resolved CLI args for this candidate (pool model applied). */
  args: string[];
  baseEnv: NodeJS.ProcessEnv;
  binaryPath: string;
  conversationId: string | null;
  isolationMode: IsolationMode;
  /** When true, skip bubblewrap isolation even for providers with prepareExecution. */
  noBwrap?: boolean;
}

/**
 * Spawn an isolated child execution for one candidate attempt
 * (issue #74).
 *
 * The replacement candidate always launches with a completely clean stderr
 * buffer and a freshly resolved execution environment — no state is shared
 * with, or inherited from, a previously failed attempt.
 */
export function executeCandidateAttempt(options: ExecuteCandidateAttemptOptions): CandidateAttempt {
  const {
    adapter,
    profile,
    pool,
    attemptId,
    args,
    baseEnv,
    binaryPath,
    conversationId,
    isolationMode,
    noBwrap
  } = options;
  const profDir = ensureProfile(adapter, profile);

  const finalArgs = [...args];
  if (conversationId && !finalArgs.includes("--conversation")) {
    finalArgs.push("--conversation", conversationId);
  }

  let execTarget: { binary: string; args: string[]; env: NodeJS.ProcessEnv };
  if (noBwrap) {
    // Bypass prepareExecution (bwrap); run directly on host with HOME override
    execTarget = {
      binary: binaryPath,
      args: finalArgs,
      env: {
        ...baseEnv,
        HOME: profDir,
        AGENT_MUX_ACTIVE_PROFILE: profile
      }
    };
  } else if (adapter.prepareExecution) {
    execTarget = adapter.prepareExecution(profile, finalArgs, baseEnv, isolationMode);
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
    stdio: ["pipe", "pipe", "pipe"],
    // Own process group per child (issue #69): failover must be able to
    // SIGTERM/SIGKILL grandchildren holding inherited stdout/stderr fds,
    // otherwise the OS pipe never reaches EOF for downstream consumers.
    detached: process.platform !== "win32"
  });

  return new CandidateAttempt(attemptId, profile, pool, proc);
}

/**
 * Probe-driven cooldown verification (issue #74).
 *
 * Active cooldowns clear only when an explicit probe confirms the
 * `(profile, pool)` candidate is READY again. A LIMIT probe re-records the
 * lock against that same candidate. Candidates whose provider exposes no
 * probe are left untouched.
 */
export async function verifyCooldownWithProbe(
  adapter: ProviderAdapter,
  profile: string,
  pool: string
): Promise<{ state: QuotaState; details: string; cleared: boolean }> {
  if (!adapter.probe) {
    return {
      state: "READY",
      details: "Provider does not require server-side probing",
      cleared: false
    };
  }
  const res = await adapter.probe(profile, pool);
  if (res.state === "READY") {
    clearCooldown(adapter.id, profile, pool);
    return { state: res.state, details: res.details, cleared: true };
  }
  if (res.state === "LIMIT") {
    const durSec = parseResetDurationSeconds(res.details);
    recordCooldownFamily(adapter.id, profile, pool, durSec, res.details);
  }
  return { state: res.state, details: res.details, cleared: false };
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
  /** When true, skip bubblewrap isolation even for providers with prepareExecution. */
  noBwrap?: boolean;
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

  // --- Issue #74: per-candidate isolated lifecycle ---
  // No child process state is shared between attempts. Each candidate runs
  // inside its own CandidateAttempt (own proc handle, own stderr buffer,
  // own listeners). Retired attempts have all of their late process events
  // dropped, so a dying child can never be evaluated as its replacement.
  let attemptSeq = 0;
  let activeAttempt: CandidateAttempt | null = null;
  const killedChildPids = new Set<number>();
  let lastUserMessage: string | null = null;
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
  // Set once a terminal frame (engine result or synthetic abort) has closed
  // the active turn, so failover never emits a second terminal frame.
  let turnAborted = false;

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

  /**
   * Spawn an isolated execution for one candidate. The attempt becomes the
   * active attempt; every listener created for it is guarded by
   * {@link isCurrentAttempt} so superseded attempts stay silent.
   */
  function spawnAttempt(prof: string, pool: string): CandidateAttempt {
    const attempt = executeCandidateAttempt({
      adapter,
      profile: prof,
      pool,
      attemptId: ++attemptSeq,
      args: [...currentArgs],
      baseEnv: { ...process.env, ...options.env },
      binaryPath,
      conversationId,
      isolationMode: getIsolationMode(),
      noBwrap: options.noBwrap
    });
    activeAttempt = attempt;
    return attempt;
  }

  /** True only for the live attempt: retired or superseded attempts are silent. */
  function isCurrentAttempt(attempt: CandidateAttempt): boolean {
    return !attempt.retired && activeAttempt !== null && activeAttempt.id === attempt.id;
  }

  function activeChild(): ChildProcess | null {
    return activeAttempt?.proc ?? null;
  }

  const initialAttempt = spawnAttempt(currentProfile, currentPool);
  selectionLogger.log(currentProfile, currentPool, "initial selection");

  // Pipe stdin from parent to active child
  const parentStdinLines = readline.createInterface({ input: process.stdin });
  parentStdinLines.on("line", (line) => {
    try {
      const data = JSON.parse(line);
      if (data.event === "user") {
        lastUserMessage = line;
        // Clear the ACTIVE attempt's stale stderr from previous turns. A
        // retired attempt keeps its own buffer, which failover already
        // suppressed or flushed — it is never touched here.
        if (activeAttempt) activeAttempt.stderrLines.length = 0;
        selectionLogger.log(currentProfile, currentPool, "active candidate for turn");
        turnSurfaced = false;
        turnMessagePrefixed = false;
        turnHadOutput = false;
        turnAborted = false;
        relaunchCount = 0;
        triedCandidates.clear();
        triedCandidates.add(candidateKey(currentProfile, currentPool));
      }
    } catch {}

    const target = activeChild();
    if (target && target.stdin && !target.stdin.destroyed) {
      try {
        target.stdin.write(line + "\n");
      } catch {}
    }
  });

  parentStdinLines.on("close", () => {
    const target = activeChild();
    if (target && target.stdin && !target.stdin.destroyed) {
      try {
        target.stdin.end();
      } catch {}
    }
  });

  const onSigInt = () => { const t = activeChild(); if (t) killChildTree(t, "SIGINT"); };
  const onSigTerm = () => { const t = activeChild(); if (t) killChildTree(t, "SIGTERM"); };
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  return new Promise<number>((resolve) => {
    // Settle exactly once: late events from retired attempts must never
    // resolve the session a second time (issue #74).
    let settled = false;
    function finish(code: number): void {
      if (settled) return;
      settled = true;
      process.off("SIGINT", onSigInt);
      process.off("SIGTERM", onSigTerm);
      resolve(code);
    }

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


    function attachStdoutListener(attempt: CandidateAttempt) {
      const proc = attempt.proc;
      const stderrLines = attempt.stderrLines;
      // Strict attribution: these are the emitting candidate's own identity,
      // captured by value. They never follow the supervisor's mutable
      // currentProfile/currentPool (issue #74).
      const prof = attempt.profile;
      const pool = attempt.pool;
      const rl = readline.createInterface({ input: proc.stdout! });

      rl.on("line", async (line) => {
        // Lifecycle isolation: late output from a retired or superseded
        // attempt is dropped — it must never be evaluated as, or forwarded
        // on behalf of, the replacement candidate.
        if (!isCurrentAttempt(attempt)) return;
        let quotaDetected = false;
        let quotaTriggerWasTerminal = false;
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
              // Issue #74: superficial stream events NEVER clear cooldowns.
              // Only an explicit probe (READY) or a full SUCCESS turn clears.
            }
          }

          if (eventType === "result") {
            const res = parsedFrame.result || {};
            if (isNativeEngineQuotaResult(parsedFrame)) {
              quotaDetected = true;
              // Only treat as terminal (forwarded) if turn already had output.
              // If turn had NO output, we can replay seamlessly to the fallback child
              // without surfacing the 429 result frame to the client.
              quotaTriggerWasTerminal = turnHadOutput;
              errorDetails = errorTextOf(res.error);
            } else {
              if (res.status === "SUCCESS") {
                // Verified turn completion produced by THIS profile: the
                // candidate demonstrably serves again, so its cooldown clears
                // deterministically — even a long quota exhaustion.
                clearCooldown(adapter.id, prof, pool);
              }
              lastUserMessage = null;
              turnSurfaced = false;
              turnMessagePrefixed = false;
              turnHadOutput = false;
              turnAborted = true;
              hadFailover = false;
              failoverPrevProfile = null;
              relaunchCount = 0;
              triedCandidates.clear();
              triedCandidates.add(candidateKey(prof, pool));
              flushTurnStderr(stderrLines);
            }
          } else if (eventType === "error" && isQuotaError(parsedFrame.error)) {
            quotaDetected = true;
            errorDetails = errorTextOf(parsedFrame.error);
          }
        } catch {}

        if (quotaDetected) {
          await handleRelaunch(attempt, "Quota exhausted", errorDetails, line, quotaTriggerWasTerminal);
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
        // Lifecycle isolation (issue #74): a retired attempt's close event,
        // or the close of an attempt superseded by failover, is dropped. It
        // must never be evaluated in — or attribute quota to — the
        // replacement candidate.
        if (attempt.retired) return;
        if (!isCurrentAttempt(attempt)) return;
        if (isRelaunching) return;
        if (proc.pid && killedChildPids.has(proc.pid)) return;

        // Check for quota error in stderr.
        // A process may exit non-zero or exit without producing turn output due to quota.
        // However, if the turn succeeded (turnHadOutput) and exited 0, transient retry
        // warnings or non-fatal background hook notices are NOT crashes.
        const isCleanSuccess = (code === 0 || code === null) && turnHadOutput;
        const crashLine = isProcessCrashQuotaError(stderrLines);
        if (crashLine && !isCleanSuccess) {
          await handleRelaunch(attempt, "Process exited with quota limit", crashLine, undefined);
          return;
        }

        // Terminal exit: release buffered stderr, filtering out transient retry noise
        // and non-fatal quota notices if the turn completed cleanly with code 0.
        // Issue #74: a bare exit-0 only heals SHORT transient locks; a genuine
        // long quota exhaustion requires probe verification or a full SUCCESS
        // turn (handled on the result frame above).
        if (code === 0 && turnHadOutput) {
          clearCooldown(adapter.id, prof, pool, { onlyIfShort: true });
          // Suppress non-fatal quota/rate-limit notice lines that leak to parent
          // harnesses on a successful turn. A valid result frame or agent output
          // already confirmed success; these notices are noise (e.g. "Individual
          // quota reached" warnings from upstream gateways).
          const suppressed = new Set<string>();
          const clean = stderrLines.filter((chunk) => {
            if (isQuotaError(chunk)) {
              suppressed.add(chunk);
              return false;
            }
            return true;
          });
          stderrLines.length = 0;
          if (clean.length > 0 || suppressed.size === 0) {
            flushBufferedStderr(clean);
          }
          finish(0);
          return;
        }
        if (code === 0) {
          const clean = filterTransientNoise(stderrLines);
          stderrLines.length = 0;
          flushBufferedStderr(clean);
          finish(0);
          return;
        }

        // Terminal (non-quota) exit: release everything the turn buffered.
        flushBufferedStderr(stderrLines);
        finish(code ?? 0);
      });
    }

    async function handleRelaunch(
      failedAttempt: CandidateAttempt,
      reason: string,
      errorDetails?: string,
      rawErrorLine?: string,
      triggerWasTerminal = false
    ) {
      if (isRelaunching) return;
      // Lifecycle isolation (issue #74): only the live attempt may trigger
      // failover. Signals from retired or superseded attempts are dropped.
      if (failedAttempt.retired || !isCurrentAttempt(failedAttempt)) return;

      // Strict quota attribution (issue #74): the cooldown lock is recorded
      // ONLY against the candidate that physically emitted the error. These
      // bindings are captured by value from the failed attempt and never
      // follow the supervisor's mutable currentProfile/currentPool.
      const failedProfile = failedAttempt.profile;
      const failedPool = failedAttempt.pool;
      const bufferedStderr = failedAttempt.stderrLines;

      // Snapshot the interrupted turn before any async work (issue #69). A
      // turn that already streamed output can never be replayed without
      // double-executing tools, so killing its child orphans it unless we
      // close it explicitly.
      const abortedHadOutput = turnHadOutput;
      const abortedTurnOpen = (lastUserMessage !== null || turnHadOutput) && !turnAborted;

      // When the quota signal arrived as the engine's own terminal `result`
      // frame and the turn already had output, forward it verbatim: downstream
      // already has partial output and downstream finality is needed.
      // If the turn had NO output, we do NOT forward it here so the turn can
      // be seamlessly replayed into the replacement child.
      if (triggerWasTerminal && rawErrorLine && abortedHadOutput) {
        try {
          process.stdout.write(rawErrorLine + "\n");
        } catch {}
        lastUserMessage = null;
        turnSurfaced = false;
        turnMessagePrefixed = false;
        turnHadOutput = false;
        turnAborted = true;
      }

      /** Close the interrupted turn exactly once when the engine never did. */
      const abortInterruptedTurn = (fromProf: string, fromP: string, toProf: string, toP: string, failedOver = true): void => {
        if (turnAborted || (triggerWasTerminal && abortedHadOutput)) return;
        // Only turns that produced output need synthetic finality: a
        // pre-output turn is replayed verbatim into the replacement child.
        if (!abortedHadOutput) return;
        if (!abortedTurnOpen && lastUserMessage === null && !turnHadOutput) return;
        try {
          process.stdout.write(
            buildTurnAbortFrame(conversationId, fromProf, fromP, toProf, toP, reason, failedOver) + "\n"
          );
        } catch {}
        turnAborted = true;
        lastUserMessage = null;
        turnSurfaced = false;
        turnMessagePrefixed = false;
        turnHadOutput = false;
      };

      const isHookError = isNonInferenceHookError(errorDetails || reason);
      const parsedSec = parseResetDurationSeconds(errorDetails || "");
      // Non-inference background hooks (like context summarization) should not lock
      // model pools for 50 hours when Google emits generic reset banners.
      const durSec = isHookError ? Math.min(parsedSec, 60) : parsedSec;
      logMuxMessage("SUPERVISOR", `Quota error detected on profile '${failedProfile}' (pool: '${failedPool}'): ${reason} | details: ${errorDetails} (cooldown: ${durSec}s)`);
      if (durSec > 0) {
        recordCooldownFamily(adapter.id, failedProfile, failedPool, durSec, errorDetails || reason);
      }
      triedCandidates.add(candidateKey(failedProfile, failedPool));

      // Retire the failed attempt BEFORE any async work: from this point on,
      // every late close/error/stderr/stdout event from the dying child is
      // dropped by the isolation guards instead of being evaluated as the
      // replacement candidate. This also closes the re-entrancy window while
      // selectProfile is awaited below.
      failedAttempt.retire(killedChildPids);
      isRelaunching = true;


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
        // buffered stderr must reach the caller — plus an explicit abort frame
        // or raw error line when the engine closed the active turn.
        flushBufferedStderr(bufferedStderr);
        if (triggerWasTerminal && rawErrorLine && !abortedHadOutput) {
          try {
            process.stdout.write(rawErrorLine + "\n");
          } catch {}
        }
        logMuxMessage("SUPERVISOR", `Failover failed: ${(err as Error)?.message ?? String(err)}`);
        abortInterruptedTurn(failedProfile, failedPool, failedProfile, failedPool, false);
        finish(1);
        return;
      }

      // Halt on exhaustion (issue #74): when the policy matrix has no healthy
      // candidate left AND the router's pick was already failed during this
      // turn, the full matrix is exhausted — HALT and abort the turn with a
      // clean final error frame. Never cycle between already-failed
      // candidates within the same turn (no ping-pong loop). A cooled-but-
      // untried candidate (stale lock from an earlier session) is still given
      // one attempt below.
      if (decision.allCooldown && triedCandidates.has(candidateKey(decision.profile, decision.pool))) {
        // Failover is not clean here, so keep the raw quota output visible.
        flushBufferedStderr(bufferedStderr);
        if (triggerWasTerminal && rawErrorLine && !abortedHadOutput) {
          // Pre-output terminal error with no fallback: forward it so the
          // turn still terminates downstream.
          try {
            process.stdout.write(rawErrorLine + "\n");
          } catch {}
          lastUserMessage = null;
          turnSurfaced = false;
          turnMessagePrefixed = false;
          turnHadOutput = false;
          turnAborted = true;
        } else {
          // Non-terminal trigger (error frame / crash) with no fallback:
          // the orphaned turn needs explicit finality even when it produced
          // no output yet, otherwise downstream waits forever.
          const turnOpen = (lastUserMessage !== null || abortedHadOutput) && !turnAborted;
          if (turnOpen && !abortedHadOutput) {
            try {
              process.stdout.write(
                buildTurnAbortFrame(conversationId, failedProfile, failedPool, failedProfile, failedPool, reason, false) + "\n"
              );
            } catch {}
            turnAborted = true;
            lastUserMessage = null;
            turnSurfaced = false;
            turnMessagePrefixed = false;
            turnHadOutput = false;
          } else {
            abortInterruptedTurn(failedProfile, failedPool, failedProfile, failedPool, false);
          }
        }
        logMuxMessage("SUPERVISOR", `All candidates exhausted this turn (tried: ${Array.from(triedCandidates).join(", ")}); halting without further failover`);
        process.stderr.write(
          `\n[agent-mux] ${reason} on ${failedProfile} (pool: ${failedPool}). No healthy fallback profile is available; the turn cannot continue.\n`
        );
        finish(1);
        return;
      }

      // selectProfile returned a cooled-but-untried candidate (stale lock from
      // an earlier session): give it one attempt. Failover is not clean here,
      // so keep the raw quota output visible.
      if (decision.allCooldown) {
        flushBufferedStderr(bufferedStderr);
        logMuxMessage("SUPERVISOR", `All healthy candidates for requested pool '${targetPool}' in cooldown; failing over to shortest cooldown: ${decision.profile} (pool: ${decision.pool}, ${decision.reason})`);
      } else {
        // Recovered automatically: drop the failed candidate's raw stderr so
        // the caller never sees a transient quota banner.
        bufferedStderr.length = 0;
      }

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

      // The failed attempt was already retired (and its tree killed) before
      // selectProfile ran, so its late events cannot leak into the
      // replacement. The replacement launches with a completely clean
      // stderr buffer and freshly resolved environment (issue #74).

      currentProfile = nextProf;
      currentPool = nextPool;
      hadFailover = true;
      failoverPrevProfile = prevProf;

      // Inject failover tool frame upstream immediately
      injectAccountFrame(true, prevProf);

      // Close the orphaned turn BEFORE the replacement serves new input, so
      // downstream finalizes the killed turn even if the new child idles.
      abortInterruptedTurn(prevProf, prevPool, nextProf, nextPool);

      const newAttempt = spawnAttempt(nextProf, nextPool);
      const newChild = newAttempt.proc;

      let initConsumed = false;
      const rl = readline.createInterface({ input: newChild.stdout! });

      // Guard: a replacement that never becomes ready must not wedge the
      // supervisor in `isRelaunching` forever (issue #69).
      const initTimer = setTimeout(() => {
        if (!initConsumed) {
          initConsumed = true;
          isRelaunching = false;
          logMuxMessage("SUPERVISOR", `Replacement child for '${currentProfile}' never emitted init; failover state released`);
          try {
            rl.close();
          } catch {}
        }
      }, RELAUNCH_INIT_TIMEOUT_MS);
      try {
        initTimer.unref?.();
      } catch {}

      const settleInit = (replacementDead: boolean, code: number | null): void => {
        if (initConsumed) return;
        initConsumed = true;
        clearTimeout(initTimer);
        isRelaunching = false;
        try {
          rl.close();
        } catch {}
        if (replacementDead) {
          // No healthy child left to serve the session: close any still-open
          // turn explicitly, then exit instead of hanging on stdout.
          // Only the live attempt may settle the session: a superseded
          // attempt dying here must stay silent (issue #74).
          if (!isCurrentAttempt(newAttempt)) return;
          if ((lastUserMessage !== null || turnHadOutput) && !turnAborted && !(triggerWasTerminal && abortedHadOutput)) {
            abortInterruptedTurn(prevProf, prevPool, nextProf, nextPool);
          }
          flushBufferedStderr(newAttempt.stderrLines);
          finish(code ?? 1);
        }
      };
      newChild.once("close", (code) => settleInit(true, code));
      newChild.once("error", () => settleInit(true, null));

      rl.on("line", (line) => {
        // Only the live replacement may consume init: lines from any other
        // attempt generation are dropped.
        if (!isCurrentAttempt(newAttempt)) return;
        if (!initConsumed) {
          try {
            const frame = JSON.parse(line);
            if (frame.event === "init") {
              initConsumed = true;
              clearTimeout(initTimer);
              isRelaunching = false;
              turnSurfaced = false;
              rl.close();

              // Only re-send last user message if previous turn had not produced output
              if (!turnHadOutput && lastUserMessage && newChild.stdin && !newChild.stdin.destroyed) {
                newChild.stdin.write(lastUserMessage + "\n");
              }

              // Hook normal stdout listener
              attachStdoutListener(newAttempt);
              return;
            }
          } catch {}
        }
      });
    }

    attachStdoutListener(initialAttempt);
  });
}

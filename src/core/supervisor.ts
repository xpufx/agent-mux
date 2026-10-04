import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import type { ProviderAdapter } from "../types.js";
import { listProfiles, ensureProfile } from "./profiles.js";
import { getSurfaceAccountMode, type SurfaceAccountMode } from "./config.js";

export function isQuotaError(text: unknown): boolean {
  if (!text) return false;
  const t = String(text).toLowerCase();
  return (
    t.includes("resource_exhausted") ||
    t.includes("code 429") ||
    t.includes("quota reached") ||
    t.includes("capacity exhausted") ||
    t.includes("quota exceeded") ||
    t.includes("rate_limit")
  );
}

export interface SupervisorOptions {
  adapter: ProviderAdapter;
  initialProfile: string;
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
  const profiles = listProfiles(adapter);
  let currentProfile = options.initialProfile;
  let conversationId: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--conversation" && i + 1 < args.length) {
      conversationId = args[i + 1];
      break;
    }
  }

  function getFallbackProfile(current: string): string {
    const idx = profiles.indexOf(current);
    if (idx === -1 || profiles.length <= 1) return current;
    return profiles[(idx + 1) % profiles.length];
  }

  let child: ChildProcess | null = null;
  let lastUserMessage: string | null = null;
  const recentStderr: string[] = [];
  let isRelaunching = false;
  let relaunchCount = 0;

  // Turn surfacing state
  let turnSurfaced = false;
  let turnMessagePrefixed = false;
  let hadFailover = false;
  let failoverPrevProfile: string | null = null;

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

  function spawnChild(prof: string): ChildProcess {
    const profDir = ensureProfile(adapter, prof);
    const childEnv = {
      ...process.env,
      ...options.env,
      HOME: profDir
    };

    const finalArgs = [...args];
    if (conversationId && !finalArgs.includes("--conversation")) {
      finalArgs.push("--conversation", conversationId);
    }

    const proc = spawn(binaryPath, finalArgs, {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"]
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stderr.write(text);
      recentStderr.push(text);
      if (recentStderr.length > 25) recentStderr.shift();
    });

    return proc;
  }

  child = spawnChild(currentProfile);

  // Pipe stdin from parent to active child
  const parentStdinLines = readline.createInterface({ input: process.stdin });
  parentStdinLines.on("line", (line) => {
    try {
      const data = JSON.parse(line);
      if (data.event === "user") {
        lastUserMessage = line;
        turnSurfaced = false;
        turnMessagePrefixed = false;
        relaunchCount = 0;
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
    function attachStdoutListener(proc: ChildProcess) {
      const rl = readline.createInterface({ input: proc.stdout! });

      rl.on("line", (line) => {
        let quotaDetected = false;
        let parsedFrame: any = null;

        try {
          parsedFrame = JSON.parse(line);
          const eventType = parsedFrame.event;

          if (eventType === "init") {
            if (!conversationId && parsedFrame.conversation_id) {
              conversationId = parsedFrame.conversation_id;
            }
          }

          if (eventType === "result") {
            const res = parsedFrame.result || {};
            if (res.status === "ERROR" && isQuotaError(res.error)) {
              quotaDetected = true;
            } else {
              lastUserMessage = null;
              turnSurfaced = false;
              turnMessagePrefixed = false;
              hadFailover = false;
              failoverPrevProfile = null;
              relaunchCount = 0;
            }
          } else if (eventType === "error" && isQuotaError(parsedFrame.error)) {
            quotaDetected = true;
          }
        } catch {
          if (isQuotaError(line)) {
            quotaDetected = true;
          }
        }

        if (quotaDetected) {
          handleRelaunch("Quota exhausted");
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

      proc.on("close", (code) => {
        if (isRelaunching) return;

        // Check if process crashed due to quota error during active turn
        if (lastUserMessage && recentStderr.some((err) => isQuotaError(err))) {
          handleRelaunch("Process exited with quota limit");
          return;
        }

        process.off("SIGINT", onSigInt);
        process.off("SIGTERM", onSigTerm);
        resolve(code ?? 0);
      });
    }

    function handleRelaunch(reason: string) {
      if (isRelaunching) return;

      if (relaunchCount >= profiles.length) {
        process.stderr.write(
          `\n[agent-mux] All available profiles exhausted quota. Passing failure upstream.\n`
        );
        return;
      }

      isRelaunching = true;
      relaunchCount++;

      const prevProf = currentProfile;
      const nextProf = getFallbackProfile(currentProfile);
      process.stderr.write(
        `\n[agent-mux] ${reason} on ${prevProf}. Automatically switching to ${nextProf}...\n`
      );

      // Kill previous child
      if (child) {
        try {
          child.kill("SIGTERM");
        } catch {}
      }

      currentProfile = nextProf;
      hadFailover = true;
      failoverPrevProfile = prevProf;

      // Inject failover tool frame upstream immediately
      injectAccountFrame(true, prevProf);

      const newChild = spawnChild(currentProfile);
      child = newChild;

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

              // Re-send last user message
              if (lastUserMessage && newChild.stdin && !newChild.stdin.destroyed) {
                newChild.stdin.write(lastUserMessage + "\n");
              }

              // Hook normal stdout listener
              attachStdoutListener(newChild);
              return;
            }
          } catch {}
        }
      });
    }

    attachStdoutListener(child);
  });
}

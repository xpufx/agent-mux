import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import type { ProviderAdapter } from "../types.js";
import { listProfiles, ensureProfile } from "./profiles.js";

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
}

export async function runSupervisor(options: SupervisorOptions): Promise<number> {
  const { adapter, binaryPath, args } = options;
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
      }
    } catch {}

    if (child && child.stdin && !child.stdin.destroyed) {
      try {
        child.stdin.write(line + "\n");
      } catch {}
    }
  });

  return new Promise<number>((resolve) => {
    function attachStdoutListener(proc: ChildProcess) {
      const rl = readline.createInterface({ input: proc.stdout! });

      rl.on("line", (line) => {
        let quotaDetected = false;
        try {
          const frame = JSON.parse(line);
          const eventType = frame.event;

          if (eventType === "init" && !conversationId) {
            conversationId = frame.conversation_id || null;
          }

          if (eventType === "result") {
            const res = frame.result || {};
            if (res.status === "ERROR" && isQuotaError(res.error)) {
              quotaDetected = true;
            } else {
              lastUserMessage = null;
            }
          } else if (eventType === "error" && isQuotaError(frame.error)) {
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

        resolve(code ?? 0);
      });
    }

    function handleRelaunch(reason: string) {
      if (isRelaunching) return;
      isRelaunching = true;

      const nextProf = getFallbackProfile(currentProfile);
      process.stderr.write(
        `\n[agent-mux] ${reason} on ${currentProfile}. Automatically switching to ${nextProf}...\n`
      );

      // Kill previous child
      if (child) {
        try {
          child.kill("SIGTERM");
        } catch {}
      }

      currentProfile = nextProf;
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

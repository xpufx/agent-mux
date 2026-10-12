export interface MuxFlags {
  profile?: string;
  pool?: string;
  roundRobin?: boolean;
  mode?: string;
}

export interface ParsedArgs extends MuxFlags {
  cmdArgs: string[];
}

/**
 * Cleanly separates agent-mux routing flags from target CLI arguments.
 *
 * Supported mux flags:
 *   --profile <name> | --profile=<name>
 *   --pool <name> | --pool=<name>
 *   --round-robin | --rr
 *
 * Any arguments following '--' are treated as literal arguments for the target CLI
 * and are never interpreted as mux flags.
 */
export function parseArgs(rawArgs: string[], initialFlags: MuxFlags = {}): ParsedArgs {
  let profile = initialFlags.profile;
  let pool = initialFlags.pool;
  let roundRobin = initialFlags.roundRobin ?? false;
  let mode = initialFlags.mode;
  const cmdArgs: string[] = [];

  let i = 0;
  while (i < rawArgs.length) {
    const arg = rawArgs[i];

    if (arg === "--") {
      // Pass-through delimiter: preserve remainder as target arguments verbatim
      cmdArgs.push(...rawArgs.slice(i + 1));
      break;
    }

    if (arg === "--profile") {
      if (i + 1 < rawArgs.length) {
        profile = rawArgs[++i];
        mode = profile;
      }
    } else if (arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length);
      mode = profile;
    } else if (arg === "--round-robin" || arg === "--rr") {
      roundRobin = true;
      mode = "round-robin";
    } else if (arg === "--pool") {
      if (i + 1 < rawArgs.length) {
        pool = rawArgs[++i];
      }
    } else if (arg.startsWith("--pool=")) {
      pool = arg.slice("--pool=".length);
    } else {
      cmdArgs.push(arg);
    }
    i++;
  }

  if (!mode) {
    if (roundRobin) {
      mode = "round-robin";
    } else if (profile) {
      mode = profile;
    }
  }

  return {
    profile,
    pool,
    roundRobin,
    mode,
    cmdArgs
  };
}

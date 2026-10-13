export interface MuxFlags {
  profile?: string;
  pool?: string;
  roundRobin?: boolean;
  noBwrap?: boolean;
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
 *   --no-bwrap                        Bypass bubblewrap isolation; run on host
 *
 * Any arguments following '--' are treated as literal arguments for the target CLI
 * and are never interpreted as mux flags.
 */
export function parseArgs(rawArgs: string[], initialFlags: MuxFlags = {}): ParsedArgs {
  let profile = initialFlags.profile;
  let pool = initialFlags.pool;
  let roundRobin = initialFlags.roundRobin ?? false;
  let noBwrap = initialFlags.noBwrap ?? false;
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
      }
    } else if (arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length);
    } else if (arg === "--round-robin" || arg === "--rr") {
      roundRobin = true;
    } else if (arg === "--pool") {
      if (i + 1 < rawArgs.length) {
        pool = rawArgs[++i];
      }
    } else if (arg.startsWith("--pool=")) {
      pool = arg.slice("--pool=".length);
    } else if (arg === "--no-bwrap") {
      noBwrap = true;
    } else {
      cmdArgs.push(arg);
    }
    i++;
  }

  return {
    profile,
    pool,
    roundRobin,
    noBwrap,
    cmdArgs
  };
}

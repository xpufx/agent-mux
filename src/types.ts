import type { IsolationMode } from "./core/config.js";

export type QuotaState = "READY" | "LIMIT" | "UNKNOWN" | "CAPACITY_SPIKE";

export interface PoolQuota {
  pool: string;
  state: QuotaState;
  remainingSeconds?: number;
  details?: string;
}

export interface ProfileStatus {
  profile: string;
  authenticated: boolean;
  accountIdentity?: string;
  pools: PoolQuota[];
}

export interface ProviderAdapter {
  id: string;
  displayName: string;
  binaryName: string;
  defaultBinaryPath: string;
  profilesBaseDir: string;
  
  getAuthStatus(profile: string): Promise<boolean>;
  getAccountIdentity?(profile: string): Promise<string | undefined>;
  /** Extra CLI args for interactive login (default: ["auth"]). */
  authArgs?: string[];
  getQuotaStatus(profile: string): Promise<PoolQuota[]>;
  resolveTargetPool(args: string[], env: NodeJS.ProcessEnv): string;
  getSharedPaths(): string[];
  getSupportedPools(): string[];
  getPoolModel?(pool: string): string | undefined;
  prepareExecution?(
    profile: string,
    args: string[],
    baseEnv: NodeJS.ProcessEnv,
    isolationMode?: IsolationMode
  ): { binary: string; args: string[]; env: NodeJS.ProcessEnv };
  probe?(profile: string, pool: string): Promise<{ state: QuotaState; details: string }>;
  listModels?(profile?: string): Promise<string[]>;
  /**
   * Full dynamic pool list (e.g. inner providers of a meta-harness).
   * Called on demand when an explicitly requested pool is not in
   * getSupportedPools(); adapters should refresh their cache here.
   */
  discoverPools?(profile?: string): Promise<string[]>;
  isStreamCommand?(args: string[]): boolean;
  isNonPromptSubcommand?(subcommand: string): boolean;
}

export interface RoutingDecision {
  profile: string;
  targetPool: string;
  pool: string;
  reason: string;
}

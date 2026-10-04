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
  getQuotaStatus(profile: string): Promise<PoolQuota[]>;
  resolveTargetPool(args: string[], env: NodeJS.ProcessEnv): string;
  getSharedPaths(): string[];
  getSupportedPools(): string[];
  prepareExecution?(
    profile: string,
    args: string[],
    baseEnv: NodeJS.ProcessEnv,
    isolationMode: IsolationMode
  ): { binary: string; args: string[]; env: NodeJS.ProcessEnv };
  probe?(profile: string, pool: string): Promise<{ state: QuotaState; details: string }>;
  listModels?(profile?: string): Promise<string[]>;
}

export interface RoutingDecision {
  profile: string;
  targetPool: string;
  reason: string;
}

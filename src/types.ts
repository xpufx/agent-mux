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
  probe?(profile: string, pool: string): Promise<{ state: QuotaState; details: string }>;
}

export interface RoutingDecision {
  profile: string;
  targetPool: string;
  reason: string;
}

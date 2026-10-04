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
  pools: PoolQuota[];
}

export interface ProviderAdapter {
  id: string;
  displayName: string;
  binaryName: string;
  defaultBinaryPath: string;
  profilesBaseDir: string;
  
  getAuthStatus(profile: string): Promise<boolean>;
  getQuotaStatus(profile: string): Promise<PoolQuota[]>;
  resolveTargetPool(args: string[], env: NodeJS.ProcessEnv): string;
  getSharedPaths(): string[];
  probe?(profile: string, pool: string): Promise<{ state: QuotaState; details: string }>;
}

export interface RoutingDecision {
  profile: string;
  targetPool: string;
  reason: string;
}

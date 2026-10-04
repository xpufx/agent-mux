import type { ProviderAdapter } from "../types.js";
import { AntigravityAdapter } from "./antigravity.js";
import { OpenCodeAdapter } from "./opencode.js";

const adapters: Record<string, ProviderAdapter> = {
  antigravity: new AntigravityAdapter(),
  agy: new AntigravityAdapter(),
  opencode: new OpenCodeAdapter()
};

export function getProviderAdapter(id: string): ProviderAdapter {
  const normalized = id.toLowerCase();
  const adapter = adapters[normalized];
  if (!adapter) {
    throw new Error(
      `Unsupported provider '${id}'. Available providers: ${Object.keys(adapters).filter((k) => k !== "agy").join(", ")}`
    );
  }
  return adapter;
}

export function listSupportedProviders(): ProviderAdapter[] {
  return [new AntigravityAdapter(), new OpenCodeAdapter()];
}

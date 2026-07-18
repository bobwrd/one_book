import type { Env } from "../env.js";
import { alpacaAdapter } from "./alpaca.js";
import { schwabAdapter } from "./schwab.js";
import { tradierAdapter } from "./tradier.js";
import type { BrokerAdapter, BrokerEnv, BrokerId } from "./types.js";

export * from "./types.js";

const ADAPTERS: Record<string, BrokerAdapter> = {
  alpaca: alpacaAdapter,
  tradier: tradierAdapter,
  schwab: schwabAdapter,
};

export function getAdapter(id: string): BrokerAdapter | null {
  return ADAPTERS[id] ?? null;
}

export function listAdapters(): BrokerAdapter[] {
  return Object.values(ADAPTERS);
}

/** Per-broker client credentials, pulled from Worker secrets. */
export function brokerEnv(env: Env, id: BrokerId): BrokerEnv {
  switch (id) {
    case "schwab":
      return {
        clientId: env.SCHWAB_CLIENT_ID,
        clientSecret: env.SCHWAB_CLIENT_SECRET,
      };
    case "tradier":
      return {
        clientId: env.TRADIER_CLIENT_ID,
        clientSecret: env.TRADIER_CLIENT_SECRET,
      };
    case "tradestation":
      return {
        clientId: env.TRADESTATION_CLIENT_ID,
        clientSecret: env.TRADESTATION_CLIENT_SECRET,
      };
    default:
      return {};
  }
}

/**
 * Whether a broker is usable right now. OAuth brokers need configured client
 * credentials; API-key brokers only need the user's own keys, so they are
 * always available.
 */
export function isConfigured(adapter: BrokerAdapter, env: Env): boolean {
  if (adapter.authModel === "api-key") return true;
  const config = brokerEnv(env, adapter.id);
  return Boolean(config.clientId && config.clientSecret);
}

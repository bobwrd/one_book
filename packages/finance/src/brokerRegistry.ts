/**
 * The full broker catalog — one source of truth shared by the connect UI and
 * the API's adapter layer.
 *
 * Every broker a user might plausibly hold an account with appears here,
 * including the ones with no API. Listing them honestly and routing those to
 * CSV import is far better UX than a short list that silently omits the
 * broker someone actually uses.
 */

export type BrokerTier = "available" | "approval" | "gateway" | "csv-only";

export type BrokerAuthModel =
  | "api-key"
  | "oauth2"
  | "oauth1"
  | "local-gateway"
  | "none";

export type AssetClass = "stocks" | "options" | "futures" | "crypto" | "forex";

export interface BrokerInfo {
  id: string;
  displayName: string;
  tier: BrokerTier;
  authModel: BrokerAuthModel;
  assetClasses: AssetClass[];
  /** One line, shown in the connect UI. */
  summary: string;
  /** Shown when the broker needs setup the user must do elsewhere. */
  caveat?: string;
  /** Whether an adapter is actually implemented today. */
  implemented: boolean;
  /** Fields the user supplies for api-key brokers. */
  credentialFields?: {
    key: string;
    label: string;
    secret: boolean;
    placeholder?: string;
  }[];
  docsUrl?: string;
}

export const BROKERS: BrokerInfo[] = [
  // ---------------------------------------------- available, no approval
  {
    id: "alpaca",
    displayName: "Alpaca",
    tier: "available",
    authModel: "api-key",
    assetClasses: ["stocks", "options", "crypto"],
    summary:
      "Developer-first commission-free API for stocks, options, and crypto.",
    caveat:
      "Paper trading keys work and are recommended — OneBook is read-only and never places trades.",
    implemented: true,
    credentialFields: [
      { key: "keyId", label: "API Key ID", secret: false, placeholder: "PK…" },
      { key: "secretKey", label: "API Secret Key", secret: true },
    ],
    docsUrl: "https://alpaca.markets/docs/",
  },
  {
    id: "tradier",
    displayName: "Tradier",
    tier: "available",
    authModel: "api-key",
    assetClasses: ["stocks", "options"],
    summary:
      "Simple low-cost REST API, especially strong for options trading.",
    caveat:
      "Use a personal access token from your account settings — no OAuth application approval needed.",
    implemented: true,
    credentialFields: [
      { key: "accessToken", label: "Access Token", secret: true },
    ],
    docsUrl: "https://documentation.tradier.com/",
  },
  {
    id: "tradovate",
    displayName: "Tradovate",
    tier: "available",
    authModel: "api-key",
    assetClasses: ["futures"],
    summary: "Futures-focused broker with a fast, simple REST and WebSocket API.",
    caveat: "Futures are not modeled in this version of the risk engine.",
    implemented: false,
  },
  {
    id: "ironbeam",
    displayName: "Ironbeam",
    tier: "available",
    authModel: "api-key",
    assetClasses: ["futures"],
    summary: "Low-cost futures API with straightforward REST access.",
    caveat: "Futures are not modeled in this version of the risk engine.",
    implemented: false,
  },

  // ------------------------------------------------- approval required
  {
    id: "schwab",
    displayName: "Charles Schwab",
    tier: "approval",
    authModel: "oauth2",
    assetClasses: ["stocks", "options"],
    summary:
      "Free OAuth API inherited from TD Ameritrade, with no account minimums.",
    caveat:
      "Requires an approved Schwab developer application. Approval takes time — apply well before you need it.",
    implemented: true,
    docsUrl: "https://developer.schwab.com/",
  },
  {
    id: "tradestation",
    displayName: "TradeStation",
    tier: "approval",
    authModel: "oauth2",
    assetClasses: ["stocks", "options", "futures"],
    summary:
      "Long-standing REST and streaming API aimed at active traders.",
    caveat: "Requires a registered developer application.",
    implemented: false,
    docsUrl: "https://api.tradestation.com/docs/",
  },
  {
    id: "etrade",
    displayName: "E*TRADE",
    tier: "approval",
    authModel: "oauth1",
    assetClasses: ["stocks", "options"],
    summary:
      "Established REST API notable for lot-level position selection.",
    caveat:
      "Heavier approval process, and OAuth 1.0a signing rather than OAuth 2.",
    implemented: false,
    docsUrl: "https://developer.etrade.com/",
  },
  {
    id: "lime",
    displayName: "Lime Trading",
    tier: "approval",
    authModel: "api-key",
    assetClasses: ["stocks", "options"],
    summary:
      "Low-latency direct-market-access API for serious US equities automation.",
    caveat: "Aimed at professional automation; approval required.",
    implemented: false,
  },
  {
    id: "rithmic",
    displayName: "Rithmic",
    tier: "approval",
    authModel: "api-key",
    assetClasses: ["futures"],
    summary:
      "High-performance futures execution API for latency-sensitive trading.",
    caveat: "Futures are not modeled in this version of the risk engine.",
    implemented: false,
  },

  // ----------------------------------------------------- gateway / odd
  {
    id: "ibkr",
    displayName: "Interactive Brokers",
    tier: "gateway",
    authModel: "local-gateway",
    assetClasses: ["stocks", "options", "futures", "forex", "crypto"],
    summary:
      "The most comprehensive retail API, spanning nearly all global markets and asset classes.",
    caveat:
      "The Client Portal API needs a gateway process running on your own machine, so it cannot work from a hosted app alone. You must start the gateway locally before syncing.",
    implemented: false,
    docsUrl: "https://www.interactivebrokers.com/campus/trading-course/ibkr-api/",
  },
  {
    id: "tastytrade",
    displayName: "Tastytrade",
    tier: "gateway",
    authModel: "api-key",
    assetClasses: ["stocks", "options", "futures"],
    summary:
      "Options-focused broker popular for derivatives-heavy strategies.",
    caveat:
      "The API is semi-official with no stability guarantee — expect it to break without notice.",
    implemented: false,
  },

  // ------------------------------------------------------- CSV only
  {
    id: "robinhood",
    displayName: "Robinhood",
    tier: "csv-only",
    authModel: "none",
    assetClasses: ["stocks", "options", "crypto"],
    summary: "No official public API for retail accounts.",
    caveat:
      "Unofficial community libraries exist, but they violate Robinhood's terms and have gotten accounts restricted. OneBook will not use them. Export a CSV instead.",
    implemented: false,
  },
  {
    id: "webull",
    displayName: "Webull",
    tier: "csv-only",
    authModel: "none",
    assetClasses: ["stocks", "options"],
    summary: "Offers market data but no official position API for retail.",
    implemented: false,
  },
  {
    id: "fidelity",
    displayName: "Fidelity",
    tier: "csv-only",
    authModel: "none",
    assetClasses: ["stocks", "options"],
    summary:
      "API access is limited and mostly institutional, with no retail self-serve option.",
    implemented: false,
  },
  {
    id: "vanguard",
    displayName: "Vanguard",
    tier: "csv-only",
    authModel: "none",
    assetClasses: ["stocks"],
    summary: "No retail API.",
    implemented: false,
  },
];

export const TIER_LABELS: Record<BrokerTier, string> = {
  available: "Connect now",
  approval: "Needs broker approval",
  gateway: "Requires local setup",
  "csv-only": "CSV import only",
};

export const TIER_DESCRIPTIONS: Record<BrokerTier, string> = {
  available: "Self-serve. Generate a key and connect in under a minute.",
  approval:
    "A real API, but the broker must approve your developer application first.",
  gateway:
    "Works, but needs software running on your own machine or has no stability guarantee.",
  "csv-only":
    "No official API exists. Export your positions and import the file — this works for every broker.",
};

export function getBroker(id: string): BrokerInfo | undefined {
  return BROKERS.find((b) => b.id === id);
}

export function brokersByTier(tier: BrokerTier): BrokerInfo[] {
  return BROKERS.filter((b) => b.tier === tier);
}

/** Brokers with a working adapter today. */
export function connectableBrokers(): BrokerInfo[] {
  return BROKERS.filter((b) => b.implemented);
}

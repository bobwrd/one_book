/**
 * Alpaca adapter — the first integration, per section 4.3.
 *
 * API-key auth with a free paper-trading sandbox and no approval process,
 * which makes it the only broker that can be developed and demoed end-to-end
 * without waiting on anyone.
 */

import { parseOsiSymbol } from "@onebook/finance";
import {
  BrokerAuthExpiredError,
  BrokerError,
  type BrokerAdapter,
  type BrokerCredentials,
  type BrokerTokens,
  type NormalizedPosition,
} from "./types.js";

const PAPER_BASE = "https://paper-api.alpaca.markets";
const LIVE_BASE = "https://api.alpaca.markets";

interface AlpacaPosition {
  symbol: string;
  qty: string;
  side: "long" | "short";
  avg_entry_price: string;
  asset_class: string;
}

/**
 * Credentials are stored as one JSON blob in the encrypted access-token
 * column, since Alpaca needs a key/secret pair plus the environment choice
 * rather than a single bearer token.
 */
interface AlpacaCreds {
  keyId: string;
  secretKey: string;
  paper: boolean;
}

function parseCreds(tokens: BrokerTokens): AlpacaCreds {
  try {
    const parsed = JSON.parse(tokens.accessToken) as AlpacaCreds;
    if (!parsed.keyId || !parsed.secretKey) throw new Error("incomplete");
    return parsed;
  } catch {
    throw new BrokerError("Stored Alpaca credentials are unreadable.", "alpaca");
  }
}

function headers(creds: AlpacaCreds): HeadersInit {
  return {
    "APCA-API-KEY-ID": creds.keyId,
    "APCA-API-SECRET-KEY": creds.secretKey,
    accept: "application/json",
  };
}

function baseUrl(creds: AlpacaCreds): string {
  return creds.paper ? PAPER_BASE : LIVE_BASE;
}

export const alpacaAdapter: BrokerAdapter = {
  id: "alpaca",
  displayName: "Alpaca",
  authModel: "api-key",
  notes:
    "Generate an API key in the Alpaca dashboard. Paper trading keys work and are recommended — OneBook is read-only and never places trades.",
  credentialFields: [
    { key: "keyId", label: "API Key ID", secret: false },
    { key: "secretKey", label: "API Secret Key", secret: true },
  ],

  async connectWithKeys(credentials: BrokerCredentials): Promise<BrokerTokens> {
    const paper = credentials.paper !== "false";
    const creds: AlpacaCreds = {
      keyId: (credentials.keyId ?? "").trim(),
      secretKey: (credentials.secretKey ?? "").trim(),
      paper,
    };

    if (!creds.keyId || !creds.secretKey) {
      throw new BrokerError("Both key ID and secret key are required.", "alpaca");
    }

    // Validate immediately so a typo surfaces at connect time rather than on
    // the first sync.
    const response = await fetch(`${baseUrl(creds)}/v2/account`, {
      headers: headers(creds),
    });

    if (response.status === 401 || response.status === 403) {
      throw new BrokerError(
        "Alpaca rejected these credentials. Check the key and whether it is a paper or live key.",
        "alpaca",
      );
    }
    if (!response.ok) {
      throw new BrokerError(
        `Alpaca returned ${response.status} while validating credentials.`,
        "alpaca",
        response.status >= 500,
      );
    }

    const account = (await response.json()) as { account_number?: string };

    return {
      accessToken: JSON.stringify(creds),
      accountLabel: account.account_number
        ? `${paper ? "Paper" : "Live"} ${account.account_number}`
        : paper
          ? "Paper account"
          : "Live account",
      scope: "read-only",
    };
  },

  async fetchPositions(tokens: BrokerTokens): Promise<NormalizedPosition[]> {
    const creds = parseCreds(tokens);
    const response = await fetch(`${baseUrl(creds)}/v2/positions`, {
      headers: headers(creds),
    });

    if (response.status === 401 || response.status === 403) {
      throw new BrokerAuthExpiredError("alpaca");
    }
    if (!response.ok) {
      throw new BrokerError(
        `Alpaca returned ${response.status} while fetching positions.`,
        "alpaca",
        response.status >= 500,
      );
    }

    const raw = (await response.json()) as AlpacaPosition[];
    return raw.map(toNormalized);
  },
};

export function toNormalized(p: AlpacaPosition): NormalizedPosition {
  const magnitude = Math.abs(Number(p.qty));
  // Alpaca already signs `qty`, but `side` is authoritative and cheap to honor.
  const quantity = p.side === "short" ? -magnitude : magnitude;
  const costBasis = Number(p.avg_entry_price);

  // Alpaca reports option positions under an OSI symbol.
  const osi = parseOsiSymbol(p.symbol);
  if (osi) {
    return {
      type: "option",
      ticker: osi.ticker,
      quantity,
      costBasis,
      strike: osi.strike,
      expiry: osi.expiry,
      right: osi.right,
      contractMultiplier: 100,
      // The positions endpoint carries no implied vol, so any Greeks derived
      // from this are estimates until an option quote is fetched.
      ivIsEstimate: true,
    };
  }

  return {
    type: "stock",
    ticker: p.symbol.toUpperCase(),
    quantity,
    costBasis,
  };
}

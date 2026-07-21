/**
 * Client for the OneBook Worker API.
 *
 * The dashboard runs standalone by design, so every call here is optional:
 * if no API origin is configured, or the Worker is not running, the caller
 * gets a typed failure and the app keeps working on local data rather than
 * breaking. Connecting a brokerage is the one feature that genuinely requires
 * the backend, because broker credentials must never live in the browser.
 */

import type { PriceSeries } from "@onebook/finance";
import type { Connection } from "./components/ConnectModal.js";

/**
 * Empty means same-origin: the Worker serves both the dashboard and the API,
 * so relative paths just work. VITE_API_ORIGIN overrides it for local dev,
 * where Vite serves the frontend and the API lives elsewhere.
 */
const API_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? "";

export class ApiUnavailableError extends Error {
  constructor() {
    super(
      "The OneBook API is not reachable. Signing in and brokerage connections need the Worker running, since credentials are encrypted server-side and never stored in the browser.",
    );
    this.name = "ApiUnavailableError";
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Whether an API is reachable.
 *
 * Cannot be answered from configuration alone: same-origin deploys have no
 * origin to check, and a configured origin may still be down. So probe once
 * and cache the answer.
 */
let apiAvailable: boolean | null = null;

export async function probeApi(): Promise<boolean> {
  if (apiAvailable !== null) return apiAvailable;
  try {
    const response = await fetch(`${API_ORIGIN}/health`, {
      credentials: "include",
    });
    const body = (await response.json()) as { ok?: boolean };
    apiAvailable = response.ok && body.ok === true;
  } catch {
    // Network failure, or the dev server answered with HTML that will not
    // parse as JSON — either way there is no API here.
    apiAvailable = false;
  }
  return apiAvailable;
}

/** Last known availability, without triggering a probe. */
export function isApiConfigured(): boolean {
  return apiAvailable !== false;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (apiAvailable === false) throw new ApiUnavailableError();

  let response: Response;
  try {
    response = await fetch(`${API_ORIGIN}${path}`, {
      ...init,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    // Network-level failure: Worker down, CORS, offline.
    throw new ApiUnavailableError();
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new ApiError(
      body.error ?? `Request failed with ${response.status}.`,
      response.status,
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    // A non-JSON 200 means something other than the API answered — typically
    // a dev server returning index.html for an unmatched path.
    apiAvailable = false;
    throw new ApiUnavailableError();
  }
}

export async function fetchConnections(): Promise<Connection[]> {
  const data = await request<{
    connections: {
      broker: string;
      account_label: string | null;
      created_at: number;
      last_synced_at: number | null;
      lastError: string | null;
      lastErrorAt: number | null;
    }[];
  }>("/connections");

  return data.connections.map((c) => ({
    broker: c.broker,
    accountLabel: c.account_label ?? undefined,
    connectedAt: c.created_at,
    lastSyncedAt: c.last_synced_at ?? undefined,
    lastError: c.lastError ?? undefined,
    lastErrorAt: c.lastErrorAt ?? undefined,
  }));
}

export async function connectWithKeys(
  broker: string,
  credentials: Record<string, string>,
): Promise<{ accountLabel?: string }> {
  return request(`/connect/${broker}/keys`, {
    method: "POST",
    body: JSON.stringify(credentials),
  });
}

export async function disconnect(broker: string): Promise<void> {
  await request(`/connections/${broker}`, { method: "DELETE" });
}

/** OAuth brokers redirect the whole window rather than posting credentials. */
export function beginOauth(broker: string): void {
  if (apiAvailable === false) throw new ApiUnavailableError();
  window.location.href = `${API_ORIGIN}/connect/${broker}`;
}

// ------------------------------------------------------------------ auth

export interface SessionUser {
  userId: string;
  email: string;
}

/** Current session, or null when signed out. Never throws on 401. */
export async function fetchSession(): Promise<SessionUser | null> {
  try {
    return await request<SessionUser>("/auth/me");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/**
 * Request a magic link. In dev the Worker returns the link directly rather
 * than emailing it, so the flow is testable before email delivery exists.
 */
export async function requestMagicLink(
  email: string,
): Promise<{ devLink?: string }> {
  return request("/auth/request", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function logout(): Promise<void> {
  await request("/auth/logout", { method: "POST" });
}

// ------------------------------------------------------------ portfolios

export interface PortfolioSummary {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

export async function fetchPortfolios(): Promise<PortfolioSummary[]> {
  const data = await request<{ portfolios: PortfolioSummary[] }>("/portfolios");
  return data.portfolios;
}

export async function createPortfolio(name: string): Promise<PortfolioSummary> {
  return request("/portfolios", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export interface ApiPosition {
  id: string;
  type: "stock" | "option" | "bond";
  ticker: string;
  quantity: number;
  costBasis: number;
  currency?: string;
  strike?: number;
  expiry?: string;
  right?: "call" | "put";
  contractMultiplier?: number;
  iv?: number;
  ivIsEstimate?: boolean;
  couponRate?: number;
  maturity?: string;
  faceValue?: number;
  price?: number;
  source?: string;
}

export async function fetchPortfolio(
  id: string,
): Promise<{ id: string; name: string; positions: ApiPosition[] }> {
  return request(`/portfolios/${id}`);
}

export async function addPositions(
  portfolioId: string,
  positions: unknown[],
): Promise<{ ids: string[] }> {
  return request(`/portfolios/${portfolioId}/positions`, {
    method: "POST",
    body: JSON.stringify({ positions }),
  });
}

export async function deletePosition(
  portfolioId: string,
  positionId: string,
): Promise<void> {
  await request(`/portfolios/${portfolioId}/positions/${positionId}`, {
    method: "DELETE",
  });
}

/**
 * Server-side analysis over real cached market data. Returns the same shape
 * the dashboard computes locally, so the two modes render identically.
 */
export async function fetchAnalysis(portfolioId: string): Promise<{
  empty?: boolean;
  exposure?: { byTicker: Record<string, number> };
  dataQuality?: {
    staleQuotes: string[];
    staleHistory: string[];
    missingPrices: string[];
    asOf: string;
  };
}> {
  return request(`/portfolios/${portfolioId}/analysis`);
}

/** Spot prices used for the most recent analysis. */
export async function fetchSpot(
  portfolioId: string,
): Promise<Record<string, number>> {
  const analysis = await request<{ spot?: Record<string, number> }>(
    `/portfolios/${portfolioId}/analysis`,
  );
  return analysis.spot ?? {};
}

export async function syncBroker(
  portfolioId: string,
  broker: string,
): Promise<{ imported: number }> {
  return request(`/portfolios/${portfolioId}/sync`, {
    method: "POST",
    body: JSON.stringify({ broker }),
  });
}

/** Real cached closes for a portfolio's underlyings. */
export async function fetchHistory(
  portfolioId: string,
): Promise<{
  series: PriceSeries[];
  stale: string[];
  failures?: { ticker: string; reason: string }[];
  feed?: string | null;
}> {
  return request(`/portfolios/${portfolioId}/history`);
}

// ---------------------------------------------------------------- groups

export interface ApiGroup {
  id: string;
  name: string;
  color: string;
  created_at: number;
  positionIds: string[];
}

export async function fetchGroups(portfolioId: string): Promise<ApiGroup[]> {
  const data = await request<{ groups: ApiGroup[] }>(
    `/portfolios/${portfolioId}/groups`,
  );
  return data.groups;
}

export async function createGroup(
  portfolioId: string,
  name: string,
  color: string,
): Promise<ApiGroup> {
  return request(`/portfolios/${portfolioId}/groups`, {
    method: "POST",
    body: JSON.stringify({ name, color }),
  });
}

export async function renameGroup(
  groupId: string,
  changes: { name?: string; color?: string },
): Promise<void> {
  await request(`/groups/${groupId}`, {
    method: "PATCH",
    body: JSON.stringify(changes),
  });
}

export async function deleteGroup(groupId: string): Promise<void> {
  await request(`/groups/${groupId}`, { method: "DELETE" });
}

export async function assignPositionToGroup(
  groupId: string,
  positionId: string,
): Promise<void> {
  await request(`/groups/${groupId}/positions/${positionId}`, { method: "PUT" });
}

export async function unassignPositionFromGroup(
  groupId: string,
  positionId: string,
): Promise<void> {
  await request(`/groups/${groupId}/positions/${positionId}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------- transactions

export interface ApiTransaction {
  id: string;
  ticker: string;
  position_type: "stock" | "option" | "bond";
  side: "buy" | "sell";
  quantity: number;
  price: number;
  currency: string;
  fee: number;
  strike: number | null;
  expiry: string | null;
  right: "call" | "put" | null;
  source: string;
  executed_at: number;
}

export async function fetchTransactions(
  portfolioId: string,
  ticker?: string,
): Promise<ApiTransaction[]> {
  const query = ticker ? `?ticker=${encodeURIComponent(ticker)}` : "";
  const data = await request<{ transactions: ApiTransaction[] }>(
    `/portfolios/${portfolioId}/transactions${query}`,
  );
  return data.transactions;
}

export async function recordTransaction(
  portfolioId: string,
  transaction: {
    ticker: string;
    positionType: "stock" | "option" | "bond";
    side: "buy" | "sell";
    quantity: number;
    price: number;
    currency?: string;
    fee?: number;
    executedAt?: number;
  },
): Promise<{ id: string }> {
  return request(`/portfolios/${portfolioId}/transactions`, {
    method: "POST",
    body: JSON.stringify(transaction),
  });
}

export interface RealizedSummary {
  year: number;
  realized: {
    ticker: string;
    quantity: number;
    proceeds: number;
    costBasis: number;
    realizedPnl: number;
    openedAt: string;
    closedAt: string;
  }[];
  totalRealizedPnl: number;
}

export async function fetchRealized(
  portfolioId: string,
): Promise<RealizedSummary> {
  return request(`/portfolios/${portfolioId}/realized`);
}

// ------------------------------------------------- public reference data

export interface NewsItem {
  id: string;
  headline: string;
  summary: string | null;
  source: string;
  url: string;
  publishedAt: number;
}

export async function fetchNews(
  ticker: string,
): Promise<{ items: NewsItem[]; available: boolean; stale: boolean }> {
  return request(`/instruments/${encodeURIComponent(ticker)}/news`);
}

export async function fetchFxRate(
  currency: string,
): Promise<{ currency: string; rate: number; stale: boolean }> {
  return request(`/fx/${encodeURIComponent(currency)}`);
}

// ------------------------------------------------------------- account

export interface Preferences {
  displayName: string | null;
  theme: "dark" | "light";
  currency: string;
  compactNumbers: boolean;
  showUnrealizedPnl: boolean;
}

export async function fetchPreferences(): Promise<Preferences> {
  return request("/me/preferences");
}

export async function updatePreferences(
  changes: Partial<Preferences>,
): Promise<Preferences> {
  return request("/me/preferences", {
    method: "PATCH",
    body: JSON.stringify(changes),
  });
}

export interface ApiSession {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  userAgent: string | null;
  isCurrent: boolean;
}

export async function fetchSessions(): Promise<ApiSession[]> {
  const data = await request<{ sessions: ApiSession[] }>("/me/sessions");
  return data.sessions;
}

export async function revokeSession(
  sessionId: string,
): Promise<{ signedOut: boolean }> {
  return request(`/me/sessions/${sessionId}`, { method: "DELETE" });
}

export async function deleteAccount(): Promise<void> {
  await request("/me", { method: "DELETE" });
}

// -------------------------------------------------------------- exports

/**
 * File downloads bypass `request<T>()`: the response is a file, not JSON, so
 * the JSON-parse path there would reject a perfectly good export.
 */
async function downloadFile(path: string, filename: string): Promise<void> {
  if (apiAvailable === false) throw new ApiUnavailableError();

  const response = await fetch(`${API_ORIGIN}${path}`, {
    credentials: "include",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(
      body.error ?? `Export failed with ${response.status}.`,
      response.status,
    );
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately would race the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadExportCsv(portfolioId: string): Promise<void> {
  await downloadFile(
    `/portfolios/${portfolioId}/export.csv`,
    "onebook-export.csv",
  );
}

export async function downloadTaxReportPdf(portfolioId: string): Promise<void> {
  await downloadFile(
    `/portfolios/${portfolioId}/export/tax-report.pdf`,
    "onebook-tax-report.pdf",
  );
}

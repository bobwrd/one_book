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

const API_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? "";

export class ApiUnavailableError extends Error {
  constructor() {
    super(
      "The OneBook API is not reachable. Brokerage connections need the Worker running, since credentials are encrypted server-side and never stored in the browser.",
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

export function isApiConfigured(): boolean {
  return API_ORIGIN !== "";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!isApiConfigured()) throw new ApiUnavailableError();

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

  return (await response.json()) as T;
}

export async function fetchConnections(): Promise<Connection[]> {
  const data = await request<{
    connections: {
      broker: string;
      account_label: string | null;
      created_at: number;
    }[];
  }>("/connections");

  return data.connections.map((c) => ({
    broker: c.broker,
    accountLabel: c.account_label ?? undefined,
    connectedAt: c.created_at,
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
  if (!isApiConfigured()) throw new ApiUnavailableError();
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
  type: "stock" | "option";
  ticker: string;
  quantity: number;
  costBasis: number;
  strike?: number;
  expiry?: string;
  right?: "call" | "put";
  contractMultiplier?: number;
  iv?: number;
  ivIsEstimate?: boolean;
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
): Promise<{ series: PriceSeries[]; stale: string[] }> {
  return request(`/portfolios/${portfolioId}/history`);
}

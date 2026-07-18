/**
 * Client for the OneBook Worker API.
 *
 * The dashboard runs standalone by design, so every call here is optional:
 * if no API origin is configured, or the Worker is not running, the caller
 * gets a typed failure and the app keeps working on local data rather than
 * breaking. Connecting a brokerage is the one feature that genuinely requires
 * the backend, because broker credentials must never live in the browser.
 */

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

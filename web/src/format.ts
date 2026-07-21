/** Number formatting shared across the dashboard. */

export function formatUsd(value: number, decimals = 2): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/** Signed, for deltas against a baseline. */
export function formatSignedUsd(value: number, decimals = 0): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

export function formatPercent(value: number, decimals = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

export function formatSignedPercent(value: number, decimals = 1): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(decimals)}%`;
}

export function formatNumber(value: number, decimals = 2): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatShares(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString("en-US", {
    maximumFractionDigits: 1,
  })}`;
}

/** "Jun 19 '26" — compact enough for a dense position row. */
export function formatExpiry(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${month} ${date.getUTCDate()} '${String(date.getUTCFullYear()).slice(2)}`;
}

export function daysUntil(iso: string, from = new Date()): number {
  const target = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(target)) return 0;
  const start = Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate(),
  );
  return Math.round((target - start) / 86_400_000);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * "3h ago" / "2d ago". Used for news timestamps and connection health, where
 * the exact clock time matters far less than the distance from now.
 */
export function formatRelativeTime(timestampMs: number, now = Date.now()): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "never";

  const seconds = Math.round((now - timestampMs) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  return `${Math.floor(months / 12)}y ago`;
}

/**
 * "$1.2M" instead of "$1,200,000". Only for totals — the precise figure still
 * matters everywhere a number is being reconciled against a broker statement.
 */
export function formatCompact(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);

  const scale = (divisor: number, suffix: string) => {
    const scaled = abs / divisor;
    // Keep one decimal below 10 so "$1.2M" doesn't collapse to "$1M".
    const decimals = scaled < 10 ? 1 : 0;
    return `${sign}$${scaled.toFixed(decimals)}${suffix}`;
  };

  if (abs >= 1e12) return scale(1e12, "T");
  if (abs >= 1e9) return scale(1e9, "B");
  if (abs >= 1e6) return scale(1e6, "M");
  if (abs >= 1e3) return scale(1e3, "K");
  return `${sign}$${abs.toFixed(0)}`;
}

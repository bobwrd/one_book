/**
 * End-to-end checks against the real dashboard, covering the acceptance
 * criteria in section 11 that unit tests cannot reach: the app mounts, a
 * mixed book can be entered by hand, and the scenario sliders visibly move
 * every metric together.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "../src/App.js";

function addStock(ticker: string, shares: string) {
  fireEvent.click(screen.getByText("+ Add position"));
  fireEvent.change(screen.getByLabelText("Ticker"), {
    target: { value: ticker },
  });
  fireEvent.change(screen.getByLabelText("Shares"), {
    target: { value: shares },
  });
  fireEvent.click(screen.getByText("Add"));
}

function addOption(opts: {
  ticker: string;
  contracts: string;
  right: "call" | "put";
  strike: string;
  expiry: string;
}) {
  fireEvent.click(screen.getByText("+ Add position"));
  fireEvent.click(screen.getByText("Option"));
  fireEvent.change(screen.getByLabelText("Underlying"), {
    target: { value: opts.ticker },
  });
  fireEvent.change(screen.getByLabelText("Contracts"), {
    target: { value: opts.contracts },
  });
  fireEvent.change(screen.getByLabelText("Type"), {
    target: { value: opts.right },
  });
  fireEvent.change(screen.getByLabelText("Strike"), {
    target: { value: opts.strike },
  });
  fireEvent.change(screen.getByLabelText("Expiry"), {
    target: { value: opts.expiry },
  });
  fireEvent.click(screen.getByText("Add"));
}

/** A year out, so the option always has meaningful time value. */
function futureExpiry(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Read a tile by its label. Scoped to `.tile-label` because some labels also
 * appear as panel headings, which would otherwise match ambiguously.
 */
function tileValue(label: string): string {
  const labels = [...document.querySelectorAll(".tile-label")].filter(
    (node) => node.textContent === label,
  );
  if (labels.length === 0) throw new Error(`No tile labelled "${label}"`);
  if (labels.length > 1) {
    throw new Error(`Ambiguous tile label "${label}" (${labels.length} matches)`);
  }
  const value = labels[0].closest(".tile")?.querySelector(".tile-value");
  return value?.textContent ?? "";
}

/** Tickers appear in both the rail and the exposure table, so scope to the rail. */
function railTickers(): string[] {
  return [...document.querySelectorAll(".position-ticker")].map(
    (node) => node.textContent ?? "",
  );
}

function parseUsd(text: string): number {
  const cleaned = text.replace(/[$,+]/g, "");
  return Number(cleaned);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("OneBook dashboard", () => {
  it("mounts and shows the empty state", () => {
    render(<App />);
    expect(screen.getByText("Your book is empty")).toBeTruthy();
  });

  it("always shows the not-investment-advice disclaimer", () => {
    render(<App />);
    expect(
      screen.getByText(/not investment advice/i),
    ).toBeTruthy();
  });

  it("accepts a hand-entered stock position", () => {
    render(<App />);
    addStock("AAPL", "100");

    expect(railTickers()).toEqual(["AAPL"]);
    expect(screen.getByText("1 position · 1 underlying")).toBeTruthy();
    // Stock delta-equivalent is its own share count.
    expect(tileValue("Net delta")).toBe("100.0");
  });

  it("accepts a mixed stock and option book", () => {
    render(<App />);
    addStock("AAPL", "100");
    addOption({
      ticker: "AAPL",
      contracts: "-1",
      right: "call",
      strike: "100",
      expiry: futureExpiry(),
    });

    expect(screen.getByText("2 positions · 1 underlying")).toBeTruthy();
  });

  it("nets a covered call down against its stock — the core insight", () => {
    render(<App />);
    addStock("AAPL", "100");
    const stockOnlyDelta = Number(tileValue("Net delta"));

    addOption({
      ticker: "AAPL",
      contracts: "-1",
      right: "call",
      strike: "100",
      expiry: futureExpiry(),
    });
    const coveredDelta = Number(tileValue("Net delta"));

    // Writing a call must reduce net long exposure, but not flip it short.
    expect(coveredDelta).toBeLessThan(stockOnlyDelta);
    expect(coveredDelta).toBeGreaterThan(0);
  });

  it("moves P&L, Greeks, and VaR together when the price slider is dragged", () => {
    render(<App />);
    addStock("AAPL", "100");
    addOption({
      ticker: "AAPL",
      contracts: "2",
      right: "call",
      strike: "100",
      expiry: futureExpiry(),
    });

    const before = {
      pnl: tileValue("Scenario P&L"),
      delta: Number(tileValue("Net delta")),
      var95: parseUsd(tileValue("VaR 95% · 1d")),
    };

    fireEvent.change(
      screen.getByLabelText("Underlying price shock, percent"),
      { target: { value: "20" } },
    );

    const after = {
      pnl: tileValue("Scenario P&L"),
      delta: Number(tileValue("Net delta")),
      var95: parseUsd(tileValue("VaR 95% · 1d")),
    };

    // This is the flagship interaction: one slider, every metric responds.
    expect(after.pnl).not.toBe(before.pnl);
    expect(after.pnl.startsWith("+")).toBe(true);
    // A long call driven in-the-money gains delta.
    expect(after.delta).toBeGreaterThan(before.delta);
    // More delta-equivalent exposure means more value at risk.
    expect(after.var95).toBeGreaterThan(before.var95);
  });

  it("shows a loss on a downward shock for a long book", () => {
    render(<App />);
    addStock("AAPL", "100");

    fireEvent.change(
      screen.getByLabelText("Underlying price shock, percent"),
      { target: { value: "-15" } },
    );

    expect(tileValue("Scenario P&L").startsWith("-")).toBe(true);
  });

  it("decays a long option book as the time slider advances", () => {
    render(<App />);
    addOption({
      ticker: "AAPL",
      contracts: "5",
      right: "call",
      strike: "100",
      expiry: futureExpiry(),
    });

    fireEvent.change(screen.getByLabelText("Days forward for time decay"), {
      target: { value: "60" },
    });

    expect(tileValue("Scenario P&L").startsWith("-")).toBe(true);
  });

  it("gains on a long option book when the vol slider rises", () => {
    render(<App />);
    addOption({
      ticker: "AAPL",
      contracts: "5",
      right: "call",
      strike: "100",
      expiry: futureExpiry(),
    });

    fireEvent.change(
      screen.getByLabelText("Implied volatility shock, percentage points"),
      { target: { value: "15" } },
    );

    expect(tileValue("Scenario P&L").startsWith("+")).toBe(true);
  });

  it("resets every slider back to spot", () => {
    render(<App />);
    addStock("AAPL", "100");

    fireEvent.change(
      screen.getByLabelText("Underlying price shock, percent"),
      { target: { value: "25" } },
    );
    expect(parseUsd(tileValue("Scenario P&L"))).not.toBe(0);

    fireEvent.click(screen.getByText("Reset to spot"));
    expect(parseUsd(tileValue("Scenario P&L"))).toBe(0);
  });

  it("shows the delta-equivalent share count on every position row", () => {
    render(<App />);
    addStock("AAPL", "100");

    const rows = document.querySelectorAll(".position-delta-eq");
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("+100");
    expect(rows[0].textContent).toContain("Δ-equiv sh");
  });

  it("marks hand-entered implied vol as an estimate", () => {
    render(<App />);
    addOption({
      ticker: "AAPL",
      contracts: "1",
      right: "call",
      strike: "100",
      expiry: futureExpiry(),
    });

    // Both on the position row and on the Greek tiles.
    expect(screen.getAllByText("est").length).toBeGreaterThan(0);
    expect(screen.getAllByText("estimated IV").length).toBeGreaterThan(0);
  });

  it("flags a net short gamma book in the callouts", () => {
    render(<App />);
    addOption({
      ticker: "AAPL",
      contracts: "-20",
      right: "call",
      strike: "100",
      expiry: futureExpiry(),
    });

    expect(screen.getByText("Net short gamma")).toBeTruthy();
  });

  it("renders a correlation heatmap once there are two underlyings", () => {
    render(<App />);
    addStock("AAPL", "100");
    expect(screen.getAllByText("Not enough underlyings").length).toBeGreaterThan(0);

    addStock("MSFT", "50");
    const heatmap = screen.getByLabelText(
      "Correlation matrix across underlyings",
    );
    // Diagonal must be 1.00 for both names.
    expect(within(heatmap).getAllByText("1.00").length).toBe(2);
  });

  it("removes a position", () => {
    render(<App />);
    addStock("AAPL", "100");
    expect(screen.getByText("1 position · 1 underlying")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Remove AAPL position"));
    expect(screen.getByText("Your book is empty")).toBeTruthy();
  });

  it("persists the book across a remount", () => {
    const first = render(<App />);
    addStock("AAPL", "100");
    first.unmount();

    render(<App />);
    expect(railTickers()).toEqual(["AAPL"]);
    expect(screen.getByText("1 position · 1 underlying")).toBeTruthy();
  });

  it("survives corrupt localStorage rather than failing to mount", () => {
    localStorage.setItem("onebook.positions.v1", "{not json");
    render(<App />);
    expect(screen.getByText("Your book is empty")).toBeTruthy();
  });
});

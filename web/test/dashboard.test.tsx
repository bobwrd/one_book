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
  fireEvent.click(screen.getByText("Add position"));
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
  fireEvent.click(screen.getByText("Add position"));
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

/**
 * Tickers appear in both the rail and the exposure table, so scope to the
 * rail. The symbol node also holds the quantity, so read just the leading
 * text node.
 */
function railTickers(): string[] {
  return [...document.querySelectorAll(".position-sym")].map(
    (node) => node.childNodes[0]?.textContent?.trim() ?? "",
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
  it("seeds a sample book on first load and labels it as illustrative", () => {
    render(<App />);
    // Demo numbers must never be presented as the user's own positions.
    expect(screen.getByText(/Sample book/)).toBeTruthy();
    expect(railTickers()).toContain("AAPL");
    expect(railTickers()).toContain("SPY");
  });

  it("replaces the sample book when a real position is added", () => {
    render(<App />);
    expect(screen.getByText(/Sample book/)).toBeTruthy();

    addStock("TSTA", "100");

    // Mixing real positions into sample data would corrupt every number.
    expect(screen.queryByText(/Sample book/)).toBeNull();
    expect(railTickers()).toEqual(["TSTA"]);
  });

  it("shows the empty state once the book is cleared", () => {
    render(<App />);
    addStock("TSTA", "100");
    fireEvent.click(screen.getByLabelText("Remove TSTA position"));
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
    addStock("TSTA", "100");

    expect(railTickers()).toEqual(["TSTA"]);
    expect(screen.getByText("1 pos · 1 sym")).toBeTruthy();
    // Stock delta-equivalent is its own share count.
    expect(tileValue("Net delta")).toBe("100.0");
  });

  it("accepts a mixed stock and option book", () => {
    render(<App />);
    addStock("TSTA", "100");
    addOption({
      ticker: "TSTA",
      contracts: "-1",
      right: "call",
      strike: "100",
      expiry: futureExpiry(),
    });

    expect(screen.getByText("2 pos · 1 sym")).toBeTruthy();
  });

  it("nets a covered call down against its stock — the core insight", () => {
    render(<App />);
    addStock("TSTA", "100");
    const stockOnlyDelta = Number(tileValue("Net delta"));

    addOption({
      ticker: "TSTA",
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
    addStock("TSTA", "100");
    addOption({
      ticker: "TSTA",
      contracts: "2",
      right: "call",
      strike: "100",
      expiry: futureExpiry(),
    });

    const before = {
      pnl: tileValue("Scenario P&L"),
      delta: Number(tileValue("Net delta")),
      var95: parseUsd(tileValue("VaR 95 · 1d")),
    };

    fireEvent.change(
      screen.getByLabelText("Underlying price shock, percent"),
      { target: { value: "20" } },
    );

    const after = {
      pnl: tileValue("Scenario P&L"),
      delta: Number(tileValue("Net delta")),
      var95: parseUsd(tileValue("VaR 95 · 1d")),
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
    addStock("TSTA", "100");

    fireEvent.change(
      screen.getByLabelText("Underlying price shock, percent"),
      { target: { value: "-15" } },
    );

    expect(tileValue("Scenario P&L").startsWith("-")).toBe(true);
  });

  it("decays a long option book as the time slider advances", () => {
    render(<App />);
    addOption({
      ticker: "TSTA",
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
      ticker: "TSTA",
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
    addStock("TSTA", "100");

    fireEvent.change(
      screen.getByLabelText("Underlying price shock, percent"),
      { target: { value: "25" } },
    );
    expect(parseUsd(tileValue("Scenario P&L"))).not.toBe(0);

    fireEvent.click(screen.getByText("Reset"));
    expect(parseUsd(tileValue("Scenario P&L"))).toBe(0);
  });

  it("shows the delta-equivalent share count on every position row", () => {
    render(<App />);
    addStock("TSTA", "100");

    const rows = document.querySelectorAll(".position-eq");
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("+100");
    expect(rows[0].textContent).toContain("Δ-eq");
  });

  it("marks hand-entered implied vol as an estimate", () => {
    render(<App />);
    addOption({
      ticker: "TSTA",
      contracts: "1",
      right: "call",
      strike: "100",
      expiry: futureExpiry(),
    });

    // Both on the position row and on the Greek tiles.
    expect(screen.getAllByText(/^\s*est\s*$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("est. IV").length).toBeGreaterThan(0);
  });

  it("flags a net short gamma book in the callouts", () => {
    render(<App />);
    addOption({
      ticker: "TSTA",
      contracts: "-20",
      right: "call",
      strike: "100",
      expiry: futureExpiry(),
    });

    expect(screen.getByText("Net short gamma")).toBeTruthy();
  });

  it("renders a correlation heatmap once there are two underlyings", () => {
    render(<App />);
    addStock("TSTA", "100");
    expect(screen.getAllByText("Not enough underlyings").length).toBeGreaterThan(0);

    addStock("TSTB", "50");
    const heatmap = screen.getByLabelText(
      "Correlation matrix across underlyings",
    );
    // Diagonal must be 1.00 for both names.
    expect(within(heatmap).getAllByText("1.00").length).toBe(2);
  });

  it("removes a position", () => {
    render(<App />);
    addStock("TSTA", "100");
    expect(screen.getByText("1 pos · 1 sym")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Remove TSTA position"));
    expect(screen.getByText("Your book is empty")).toBeTruthy();
  });

  it("persists the book across a remount", () => {
    const first = render(<App />);
    addStock("TSTA", "100");
    first.unmount();

    render(<App />);
    expect(railTickers()).toEqual(["TSTA"]);
    expect(screen.getByText("1 pos · 1 sym")).toBeTruthy();
  });

  it("survives corrupt localStorage rather than failing to mount", () => {
    localStorage.setItem("onebook.positions.v1", "{not json");
    render(<App />);
    // Falls back to the sample book instead of crashing.
    expect(screen.getByText(/Sample book/)).toBeTruthy();
  });
});

describe("connect accounts", () => {
  function openConnect() {
    render(<App />);
    fireEvent.click(screen.getByText(/^Accounts/));
  }

  /** The submit button, scoped to the footer so the broker rows' "Connect →"
   *  labels don't match ambiguously. */
  function submitButton(): HTMLElement {
    const foot = document.querySelector(".modal-foot");
    if (!foot) throw new Error("No modal footer");
    return within(foot as HTMLElement).getByText("Connect");
  }

  it("groups brokers by what the user actually has to do", () => {
    openConnect();
    expect(screen.getByText("Connect now")).toBeTruthy();
    expect(screen.getByText("Needs broker approval")).toBeTruthy();
    expect(screen.getByText("Requires local setup")).toBeTruthy();
    expect(screen.getByText("CSV import only")).toBeTruthy();
  });

  it("lists brokers that have no API rather than omitting them", () => {
    openConnect();
    // The whole point: someone on Fidelity must not be left hunting.
    for (const name of ["Fidelity", "Robinhood", "Vanguard", "Webull"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it("refuses to offer an unofficial Robinhood integration", () => {
    openConnect();
    const row = screen.getByText("Robinhood").closest(".broker");
    expect(row?.textContent).toContain("Import CSV");
    expect(row?.textContent).toMatch(/terms|restricted/i);
  });

  it("flags the IBKR local gateway requirement up front", () => {
    openConnect();
    const row = screen.getByText("Interactive Brokers").closest(".broker");
    expect(row?.textContent).toMatch(/gateway/i);
    expect((row as HTMLButtonElement).disabled).toBe(true);
  });

  it("only enables brokers with a working adapter", () => {
    openConnect();
    const alpaca = screen.getByText("Alpaca").closest("button");
    const etrade = screen.getByText("E*TRADE").closest("button");
    expect((alpaca as HTMLButtonElement).disabled).toBe(false);
    expect((etrade as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens a credential form for an API-key broker", () => {
    openConnect();
    fireEvent.click(screen.getByText("Alpaca"));
    expect(screen.getByLabelText("API Key ID")).toBeTruthy();
    expect(
      (screen.getByLabelText("API Secret Key") as HTMLInputElement).type,
    ).toBe("password");
  });

  it("requires every credential field before submitting", () => {
    openConnect();
    fireEvent.click(screen.getByText("Alpaca"));
    fireEvent.click(submitButton());
    expect(screen.getByText(/required/i)).toBeTruthy();
  });

  it("explains that connecting needs the API rather than failing silently", async () => {
    openConnect();
    fireEvent.click(screen.getByText("Alpaca"));
    fireEvent.change(screen.getByLabelText("API Key ID"), {
      target: { value: "PKTEST" },
    });
    fireEvent.change(screen.getByLabelText("API Secret Key"), {
      target: { value: "secret" },
    });
    fireEvent.click(submitButton());

    // No VITE_API_ORIGIN in tests, so this must say so plainly.
    expect(await screen.findByText(/not reachable/i)).toBeTruthy();
  });

  it("states that access is read-only", () => {
    openConnect();
    const foot = document.querySelector(".modal-foot") as HTMLElement;
    expect(within(foot).getByText(/never places trades/i)).toBeTruthy();
  });

  it("routes a CSV-only broker into the import flow", () => {
    openConnect();
    fireEvent.click(screen.getByText("Fidelity"));
    expect(screen.getByText("Import positions from CSV")).toBeTruthy();
  });
});

describe("theme", () => {
  it("defaults to dark and toggles to light", () => {
    render(<App />);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    fireEvent.click(screen.getByLabelText("Toggle theme"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});

describe("scenario resting state", () => {
  it("labels the resting state so sliders read as a departure from reality", () => {
    render(<App />);
    // Signed out, prices are local — must not claim to be live market data.
    expect(screen.getByText("at spot")).toBeTruthy();
    expect(screen.queryByText("simulated")).toBeNull();
  });

  it("marks the view as simulated once any slider moves", () => {
    render(<App />);

    fireEvent.change(
      screen.getByLabelText("Underlying price shock, percent"),
      { target: { value: "10" } },
    );
    expect(screen.getByText("simulated")).toBeTruthy();

    fireEvent.click(screen.getByText("Reset"));
    expect(screen.queryByText("simulated")).toBeNull();
  });

  it("marks simulated for a vol or time shock, not just price", () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText("Days forward for time decay"), {
      target: { value: "30" },
    });
    expect(screen.getByText("simulated")).toBeTruthy();
  });
});

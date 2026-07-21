/**
 * The routed pages, driven through the real app rather than by mocking
 * internals — same philosophy as dashboard.test.tsx. Everything here runs
 * signed out, which is the mode that must work with no backend at all.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { App } from "../src/App.js";

function renderApp(route = "/") {
  window.history.pushState({}, "", route);
  return render(<App />);
}

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

function sidebar(): HTMLElement {
  return document.querySelector(".sidebar") as HTMLElement;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("Instruments page", () => {
  it("lists every position in the book", () => {
    renderApp();
    addStock("TSTA", "100");
    fireEvent.click(within(sidebar()).getByText("Instruments"));

    const table = document.querySelector("table") as HTMLElement;
    expect(within(table).getByText("TSTA")).toBeTruthy();
  });

  it("filters by symbol", () => {
    renderApp();
    addStock("TSTA", "100");
    addStock("TSTB", "50");
    fireEvent.click(within(sidebar()).getByText("Instruments"));

    fireEvent.change(screen.getByLabelText("Search instruments"), {
      target: { value: "TSTB" },
    });

    const table = document.querySelector("table") as HTMLElement;
    expect(within(table).getByText("TSTB")).toBeTruthy();
    expect(within(table).queryByText("TSTA")).toBeNull();
  });

  it("says so plainly when nothing matches", () => {
    renderApp("/instruments");
    fireEvent.change(screen.getByLabelText("Search instruments"), {
      target: { value: "ZZZZ" },
    });
    expect(screen.getByText("No matches")).toBeTruthy();
  });

  it("groups by source when toggled", () => {
    renderApp();
    addStock("TSTA", "100");
    fireEvent.click(within(sidebar()).getByText("Instruments"));
    fireEvent.click(screen.getByText("By source"));

    // Hand-entered positions carry source "manual".
    expect(screen.getAllByText("Manual").length).toBeGreaterThan(0);
  });

  it("shows a dash for Day delta rather than fabricating one", () => {
    // OneBook tracks no prior close separate from spot, so there is no honest
    // day-over-day number to show.
    renderApp();
    addStock("TSTA", "100");
    fireEvent.click(within(sidebar()).getByText("Instruments"));

    const row = screen.getByText("TSTA").closest("tr") as HTMLElement;
    expect(within(row).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("navigates into an instrument's detail page", () => {
    renderApp();
    addStock("TSTA", "100");
    fireEvent.click(within(sidebar()).getByText("Instruments"));
    fireEvent.click(screen.getByText("TSTA"));

    const head = document.querySelector(".page-head") as HTMLElement;
    expect(within(head).getByText("TSTA")).toBeTruthy();
  });
});

describe("Instrument detail page", () => {
  it("summarizes holdings for the ticker", () => {
    renderApp();
    addStock("TSTA", "100");
    fireEvent.click(within(sidebar()).getByText("Instruments"));
    fireEvent.click(screen.getByText("TSTA"));

    expect(screen.getByText("Market value")).toBeTruthy();
    expect(screen.getByText("Total return")).toBeTruthy();
  });

  it("says the ticker is not held when it isn't", () => {
    renderApp("/instruments/ZZZZ");
    expect(screen.getByText("Not held")).toBeTruthy();
  });

  it("reports news as unconfigured rather than as an error", () => {
    // No API in tests, so this must read as a deployment fact, not a failure.
    renderApp("/instruments/AAPL");
    expect(
      screen.getByText(/News isn't configured for this deployment/),
    ).toBeTruthy();
  });
});

describe("History page", () => {
  it("records a transaction when a position is added signed out", () => {
    // The whole point of the local ledger: History is meaningful in demo mode.
    renderApp();
    addStock("TSTA", "100");
    fireEvent.click(within(sidebar()).getByText("History"));

    expect(screen.getByText("TSTA")).toBeTruthy();
    expect(screen.getByText("▲ BUY")).toBeTruthy();
  });

  it("switches between timeline and table modes", () => {
    renderApp();
    addStock("TSTA", "100");
    fireEvent.click(within(sidebar()).getByText("History"));

    expect(document.querySelector(".trade-card")).toBeTruthy();

    fireEvent.click(screen.getByText("Table"));
    expect(document.querySelector(".trade-card")).toBeNull();
    expect(document.querySelector("table")).toBeTruthy();
  });

  it("shows an empty state before anything is traded", () => {
    renderApp("/history");
    expect(screen.getByText("No transactions")).toBeTruthy();
  });

  it("filters transactions by symbol", () => {
    renderApp();
    addStock("TSTA", "100");
    addStock("TSTB", "50");
    fireEvent.click(within(sidebar()).getByText("History"));

    fireEvent.change(screen.getByLabelText("Search transactions"), {
      target: { value: "TSTB" },
    });
    expect(screen.getByText("TSTB")).toBeTruthy();
    expect(screen.queryByText("TSTA")).toBeNull();
  });
});

describe("Settings page", () => {
  it("renders every section signed out", () => {
    renderApp("/settings");
    for (const heading of [
      "Profile",
      "Appearance",
      "Connected accounts",
      "Security",
      "Data & privacy",
    ]) {
      expect(screen.getByText(heading)).toBeTruthy();
    }
  });

  it("tells a signed-out visitor sessions are unavailable", () => {
    renderApp("/settings");
    expect(screen.getByText("Sign in to manage sessions.")).toBeTruthy();
  });

  it("explains there is no password to change", () => {
    renderApp("/settings");
    expect(screen.getByText(/passwordless sign-in/)).toBeTruthy();
  });

  it("has no notifications section", () => {
    // Deliberately dropped: there is no email delivery behind it.
    renderApp("/settings");
    expect(screen.queryByText(/Notifications/i)).toBeNull();
  });

  it("persists a compact-numbers preference signed out", () => {
    renderApp("/settings");
    const checkbox = screen.getByLabelText(
      /Compact numbers/,
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(
      (screen.getByLabelText(/Compact numbers/) as HTMLInputElement).checked,
    ).toBe(true);
    expect(localStorage.getItem("onebook.prefs.v1")).toContain(
      "compactNumbers",
    );
  });

  it("offers the documented display currencies", () => {
    renderApp("/settings");
    const select = screen.getByLabelText("Display currency") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      "USD",
      "GBP",
      "EUR",
      "JPY",
    ]);
  });

  it("disables export until there is a portfolio to export", () => {
    renderApp("/settings");
    expect((screen.getByText("Export CSV") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("bond positions", () => {
  function addBond(opts: {
    ticker: string;
    face: string;
    coupon: string;
    maturity: string;
    price: string;
    currency: string;
  }) {
    fireEvent.click(screen.getByText("Add position"));
    fireEvent.click(screen.getByText("Bond"));
    fireEvent.change(screen.getByLabelText("Ticker"), {
      target: { value: opts.ticker },
    });
    fireEvent.change(screen.getByLabelText("Face value"), {
      target: { value: opts.face },
    });
    fireEvent.change(screen.getByLabelText("Coupon (%)"), {
      target: { value: opts.coupon },
    });
    fireEvent.change(screen.getByLabelText("Maturity"), {
      target: { value: opts.maturity },
    });
    fireEvent.change(screen.getByLabelText("Price (per 100 par)"), {
      target: { value: opts.price },
    });
    fireEvent.change(screen.getByLabelText("Currency"), {
      target: { value: opts.currency },
    });
    fireEvent.click(screen.getByText("Add"));
  }

  const BUND = {
    ticker: "DBR-2034",
    face: "100000",
    coupon: "2.5",
    maturity: "2034-05-15",
    price: "96.59",
    currency: "EUR",
  };

  function tileValue(label: string): string {
    const labels = [...document.querySelectorAll(".tile-label")].filter(
      (node) => node.textContent === label,
    );
    return labels[0]?.closest(".tile")?.querySelector(".tile-value")
      ?.textContent ?? "";
  }

  it("accepts a foreign-currency bond and sizes it by face amount", () => {
    renderApp();
    addBond(BUND);

    const rail = document.querySelector(".rail") as HTMLElement;
    expect(within(rail).getByText(/\+100000 par/)).toBeTruthy();
  });

  it("contributes to gross exposure", () => {
    renderApp();
    addBond(BUND);
    // 100,000 face at 96.59 per 100 par. No FX rate is reachable in tests, so
    // the amount stays unconverted rather than silently wrong.
    expect(tileValue("Gross exposure")).toBe("$96,590");
  });

  it("does not move when the scenario sliders are dragged", () => {
    // A bond's mark is not a function of an equity price shock, so Scenario
    // P&L must stay attributable entirely to stock and option legs.
    renderApp();
    addBond(BUND);

    fireEvent.change(
      screen.getByLabelText("Underlying price shock, percent"),
      { target: { value: "-30" } },
    );

    expect(tileValue("Scenario P&L")).toBe("$0");
  });

  it("shows coupon and maturity on the instrument detail page", () => {
    renderApp();
    addBond(BUND);
    fireEvent.click(within(sidebar()).getByText("Instruments"));
    fireEvent.click(screen.getByText(BUND.ticker));

    expect(screen.getByText("Coupon")).toBeTruthy();
    expect(screen.getByText("Maturity")).toBeTruthy();
    expect(screen.getByText("2.50%")).toBeTruthy();
  });

  it("shows face amount rather than a share count on Instruments", () => {
    renderApp();
    addBond(BUND);
    fireEvent.click(within(sidebar()).getByText("Instruments"));

    const row = screen.getByText(BUND.ticker).closest("tr") as HTMLElement;
    expect(within(row).getByText(/100,000 par/)).toBeTruthy();
    expect(within(row).getByText("bond")).toBeTruthy();
  });
});

describe("Groups", () => {
  function openGroups() {
    fireEvent.click(within(sidebar()).getByText("Manage groups"));
  }

  it("creates a group and shows it in the sidebar", () => {
    renderApp();
    openGroups();

    fireEvent.change(screen.getByLabelText("New group"), {
      target: { value: "Income" },
    });
    fireEvent.click(screen.getByText("Create"));

    expect(within(sidebar()).getByText("Income")).toBeTruthy();
  });

  it("assigns a position to a group", () => {
    renderApp();
    addStock("TSTA", "100");
    openGroups();

    fireEvent.change(screen.getByLabelText("New group"), {
      target: { value: "Income" },
    });
    fireEvent.click(screen.getByText("Create"));

    const select = screen.getByLabelText("Add TSTA to a group");
    const groupId = (select as HTMLSelectElement).options[1].value;
    fireEvent.change(select, { target: { value: groupId } });

    expect(screen.getByText("All instruments assigned.")).toBeTruthy();
  });

  it("deletes a group", () => {
    renderApp();
    openGroups();
    fireEvent.change(screen.getByLabelText("New group"), {
      target: { value: "Income" },
    });
    fireEvent.click(screen.getByText("Create"));

    fireEvent.click(screen.getByLabelText("Delete Income"));
    expect(within(sidebar()).queryByText("Income")).toBeNull();
  });

  it("says nothing is assignable before any group exists", () => {
    renderApp();
    addStock("TSTA", "100");
    openGroups();

    const select = screen.getByLabelText(
      "Add TSTA to a group",
    ) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });
});

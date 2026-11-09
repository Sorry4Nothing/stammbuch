import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentTabContext, TabsProvider, useTabs, type CurrentTab } from "../../shell/tabs";
import { renderWithProviders } from "../../test-utils";
import { composition, formatPercent, percentChange, shiftYear } from "./dashboardData";
import { createMemoryReportsService } from "./memoryService";
import { ReportsHome } from "./ReportsHome";
import { reportsModule } from "./index";
import { ReportsProvider } from "./service";
import type { ReportsService, StatementsReport } from "./types";

function TabList() {
  const { tabs } = useTabs();
  return <output aria-label="Offene Tabs">{tabs.map((x) => x.type).join(",")}</output>;
}

type Service = ReturnType<typeof createMemoryReportsService>;

function mount(service: ReportsService = createMemoryReportsService()) {
  const tab: CurrentTab = {
    id: "tab-1",
    params: {},
    setDirty: vi.fn(),
    setTitle: vi.fn(),
    setPage: vi.fn(),
    registerSave: () => () => {},
    close: vi.fn(),
  };
  return renderWithProviders(
    <ReportsProvider service={service}>
      <TabsProvider modules={[reportsModule]}>
        <CurrentTabContext.Provider value={tab}>
          <ReportsHome />
        </CurrentTabContext.Provider>
        <TabList />
      </TabsProvider>
    </ReportsProvider>,
  );
}

/** Dienst mit Boarddaten, einzelne Methoden ersetzt. */
const withService = (over: Partial<ReportsService>): Service =>
  ({ ...createMemoryReportsService(), ...over }) as Service;

/** Ertrag und Aufwand der Erfolgsrechnung, alles andere wie im Speicherdienst. */
async function statementsOf(revenue: number, expense: number): Promise<StatementsReport> {
  const base = await createMemoryReportsService().statements("2026-01-01", "2026-11-02");
  return {
    ...base,
    income: {
      ...base.income,
      revenueCents: revenue,
      expenseCents: expense,
      resultCents: revenue - expense,
    },
  };
}

const tile = (label: string) =>
  within(screen.getByRole("region", { name: "Kennzahlen" })).getByRole("button", {
    name: new RegExp(`^${label}\\s`),
  });
const named = (title: string) => new RegExp(`^${title}`);
/** Karte mit geladener Grafik (wartet auf die Daten, kein Rennen mit dem Laden). */
async function card(title: string) {
  await screen.findByRole("img", { name: named(title) });
  return screen.getByRole("region", { name: named(title) });
}
/** Karte, auch im Leer- oder Fehlerzustand. */
const shell = (title: string) => screen.getByRole("region", { name: named(title) });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-02T14:00:00"));
});
afterEach(() => vi.useRealTimers());

describe("Dashboard der Auswertungen", () => {
  it("zeigt Kennzahlen und Grafiken aus den Daten", async () => {
    const { container } = mount();
    await screen.findByRole("button", { name: /^Ertrag\s+CHF 109'500\.00/ });
    expect(screen.getByRole("heading", { name: "Auswertungen", level: 1 })).toBeInTheDocument();
    expect(tile("Aufwand")).toHaveTextContent("CHF 0.00");
    expect(tile("Ergebnis")).toHaveTextContent("CHF 109'500.00");
    expect(tile("Offene Posten")).toHaveTextContent("74 Posten");
    expect(tile("Überfällige Posten")).toHaveTextContent("Posten");
    expect(tile("Debitoren in Mahnung")).toHaveTextContent("5");
    expect(tile("Debitoren in Mahnung")).toHaveTextContent("von 61 Debitoren");
    expect(tile("MwSt-Schuld")).toHaveTextContent("CHF 1'143.65");
    expect(tile("MwSt-Schuld")).toHaveTextContent("Vorschau");

    for (const title of [
      "Ertrag und Aufwand je Monat",
      "Ergebnisverlauf",
      "Zusammensetzung des Ertrags",
      "Alterung der offenen Posten",
      "Fakturiert und beglichen je Monat",
    ]) {
      expect(within(await card(title)).getByRole("img")).toBeInTheDocument();
    }
    // 11 Monate bis November: Balken je Monat sind per Tastatur erreichbar.
    expect(
      within(await card("Ertrag und Aufwand je Monat")).getAllByRole("button", { name: / 2026: / }),
    ).toHaveLength(11);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("zeigt die Veränderung zum Vorjahr mit Pfeil, Prozent und Text", async () => {
    const svc = withService({
      statements: async (from) =>
        from.startsWith("2025")
          ? statementsOf(1_000_000, 500_000)
          : statementsOf(1_200_000, 400_000),
    });
    mount(svc);
    const revenue = await screen.findByRole("button", { name: /^Ertrag\s+CHF 12'000\.00/ });
    expect(revenue).toHaveTextContent("gestiegen um +20.0 %");
    expect(revenue).toHaveTextContent("Vorjahr: CHF 10'000.00");
    expect(tile("Aufwand")).toHaveTextContent("gesunken um −20.0 %");
    // Ergebnis 8'000 gegen 5'000
    expect(tile("Ergebnis")).toHaveTextContent("+60.0 %");
    expect(
      screen.getByText(
        /Vergleich: gleicher Zeitraum des Vorjahres \(01\.01\.2025 bis 02\.11\.2025\)/,
      ),
    ).toBeInTheDocument();
  });

  it("zeigt ohne Daten den Leer-Zustand statt erfundener Werte", async () => {
    const memory = createMemoryReportsService();
    const svc = withService({
      statements: async (from, to) => {
        const s = await memory.statements(from, to);
        return {
          ...s,
          income: { revenue: [], expenses: [], revenueCents: 0, expenseCents: 0, resultCents: 0 },
        };
      },
      monthly: async (from, to) => ({
        from,
        to,
        rows: (await memory.monthly(from, to)).rows.map((r) => ({
          ...r,
          revenueCents: 0,
          resultCents: 0,
          invoicedCents: 0,
          settledCents: 0,
        })),
      }),
      openItems: async (asOf) => ({ asOf, rows: [] }),
    });
    const { container } = mount(svc);
    expect(await screen.findByText("Keine offenen Posten")).toBeInTheDocument();
    expect(
      within(shell("Ertrag und Aufwand je Monat")).getByText("Keine Daten im Zeitraum"),
    ).toBeInTheDocument();
    expect(
      within(shell("Ergebnisverlauf")).getByText("Keine Daten im Zeitraum"),
    ).toBeInTheDocument();
    expect(
      within(shell("Zusammensetzung des Ertrags")).getByText(
        "In diesem Zeitraum ist kein Ertrag gebucht.",
      ),
    ).toBeInTheDocument();
    expect(
      within(shell("Fakturiert und beglichen je Monat")).getByText("Keine Daten im Zeitraum"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(tile("Offene Posten")).toHaveTextContent("CHF 0.00");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("meldet fehlende Mahnstufen, statt eine 0 zu behaupten", async () => {
    mount(createMemoryReportsService({ bare: true }));
    const dunning = await screen.findByRole("button", { name: /^Debitoren in Mahnung\s/ });
    await waitFor(() => expect(dunning).toHaveTextContent("Mahnstufe nicht verfügbar"));
    expect(dunning).toHaveTextContent("–");
  });

  it("zeigt bei Ausfall eine Meldung, behält den Rest und lädt auf Wunsch neu", async () => {
    const user = userEvent.setup();
    let broken = true;
    const memory = createMemoryReportsService();
    const svc = withService({
      statements: async (from, to) => {
        if (broken) throw new Error("kaputt");
        return memory.statements(from, to);
      },
    });
    const { container } = mount(svc);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Nicht alle Daten konnten geladen werden.");
    // Offene Posten und MwSt laden weiterhin.
    expect(
      await screen.findByRole("button", { name: /^MwSt-Schuld\s+CHF 1'143\.65/ }),
    ).toBeInTheDocument();
    expect(tile("Ertrag")).toHaveTextContent("Konnte nicht geladen werden.");
    expect(
      within(shell("Zusammensetzung des Ertrags")).getByText("Konnte nicht geladen werden."),
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();

    broken = false;
    await user.click(within(alert).getByRole("button", { name: "Erneut versuchen" }));
    expect(
      await screen.findByRole("button", { name: /^Ertrag\s+CHF 109'500\.00/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("zeigt die Daten einer Grafik als Tabelle", async () => {
    const user = userEvent.setup();
    const { container } = mount();
    const ring = await card("Zusammensetzung des Ertrags");
    expect(within(ring).queryByRole("table")).not.toBeInTheDocument();
    await user.click(within(ring).getByRole("button", { name: "Daten als Tabelle anzeigen" }));
    const table = within(ring).getByRole("table", { name: "Zusammensetzung des Ertrags" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Konto", "Betrag", "Anteil"]);
    expect(
      within(table).getByRole("rowheader", { name: "3000 Beiträge Aktivmitglieder" }),
    ).toBeInTheDocument();
    expect(within(table).getByText("CHF 49'440.00")).toBeInTheDocument();
    expect(within(table).getByRole("row", { name: /Total/ })).toHaveTextContent("CHF 110'650.00");
    // Erlösminderungen (negativ) stehen nicht im Ring, aber im Hinweis.
    expect(ring).toHaveTextContent(
      "Nicht dargestellt: Konten mit negativem Ertrag (CHF −1'150.00)",
    );
    expect(await axe(container)).toHaveNoViolations();
    await user.click(within(ring).getByRole("button", { name: "Tabelle ausblenden" }));
    expect(within(ring).queryByRole("table")).not.toBeInTheDocument();
  });

  it("öffnet die Detailseite mit Enter auf der Kachel und per Klick auf Grafik und Messpunkt", async () => {
    const user = userEvent.setup();
    mount();
    const revenue = await screen.findByRole("button", { name: /^Ertrag\s+CHF/ });
    revenue.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("status", { name: "Offene Tabs" })).toHaveTextContent(
      "reports,reports-statements",
    );

    await user.click(tile("Überfällige Posten"));
    await user.click(tile("Debitoren in Mahnung"));
    await user.click(tile("MwSt-Schuld"));
    await user.click(
      within(await card("Alterung der offenen Posten")).getByRole("button", {
        name: /Details öffnen/,
      }),
    );
    expect(screen.getByRole("status", { name: "Offene Tabs" })).toHaveTextContent(
      "reports,reports-statements,reports-open-items,reports-debtors,reports-vat",
    );
  });

  it("zeigt Werte per Tastaturfokus und wandert mit den Pfeiltasten", async () => {
    const user = userEvent.setup();
    mount();
    const chart = await card("Ertrag und Aufwand je Monat");
    const points = within(chart).getAllByRole("button", { name: / 2026: / });
    expect(points.filter((p) => p.tabIndex === 0)).toHaveLength(1);
    act(() => points[0]!.focus());
    const tip = await within(chart).findByRole("tooltip");
    expect(tip).toHaveTextContent("Januar 2026");
    expect(tip).toHaveTextContent("Ertrag");
    expect(tip).toHaveTextContent("Aufwand");
    await user.keyboard("{ArrowRight}");
    expect(points[1]).toHaveFocus();
    expect(within(chart).getByRole("tooltip")).toHaveTextContent("Februar 2026");
    await user.keyboard("{End}");
    expect(points[10]).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("status", { name: "Offene Tabs" })).toHaveTextContent(
      "reports-statements",
    );
    await user.tab();
    expect(within(chart).queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("wechselt den Zeitraum und lädt alles für das vorherige Geschäftsjahr", async () => {
    const user = userEvent.setup();
    const svc = withService({});
    const statements = vi.spyOn(svc, "statements");
    const monthly = vi.spyOn(svc, "monthly");
    mount(svc);
    await screen.findByRole("button", { name: /^Ertrag\s+CHF/ });
    expect(statements).toHaveBeenCalledWith("2026-01-01", "2026-11-02");
    expect(statements).toHaveBeenCalledWith("2025-01-01", "2025-11-02");
    expect(screen.getByText("01.01.2026 bis 02.11.2026")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Zeitraum" }), "previous");
    await waitFor(() => expect(monthly).toHaveBeenCalledWith("2025-01-01", "2025-12-31"));
    expect(statements).toHaveBeenCalledWith("2024-01-01", "2024-12-31");
    expect(await screen.findByText("01.01.2025 bis 31.12.2025")).toBeInTheDocument();
    // Zwölf Monate im ganzen Vorjahr.
    await waitFor(() =>
      expect(
        within(shell("Ertrag und Aufwand je Monat")).getAllByRole("button", { name: / 2025: / }),
      ).toHaveLength(12),
    );
  });
});

describe("Hilfen des Dashboards", () => {
  it("rechnet Vorjahresdaten und Prozente", () => {
    expect(shiftYear("2024-02-29", -1)).toBe("2023-02-28");
    expect(shiftYear("2026-11-02", -1)).toBe("2025-11-02");
    expect(percentChange(120, 100)).toBeCloseTo(20);
    expect(percentChange(5, 0)).toBeUndefined();
    expect(percentChange(-50, -100)).toBeCloseTo(50);
    expect(formatPercent(-4)).toBe("−4.0 %");
    expect(formatPercent(12.34)).toBe("+12.3 %");
  });

  it("fasst kleine Konten zusammen und lässt negative Erträge aus", () => {
    const rows = [
      ["3000", "A", 600],
      ["3010", "B", 500],
      ["3020", "C", 400],
      ["3030", "D", 300],
      ["3040", "E", 200],
      ["3050", "F", 100],
      ["3060", "G", 50],
      ["3900", "Minderung", -80],
    ].map(([number, name, amountCents]) => ({
      number: String(number),
      name: String(name),
      amountCents: Number(amountCents),
    }));
    const { slices, excludedCents } = composition(rows, "Übrige");
    expect(slices.map((s) => s.label)).toEqual([
      "3000 A",
      "3010 B",
      "3020 C",
      "3030 D",
      "3040 E",
      "Übrige",
    ]);
    expect(slices.at(-1)?.value).toBe(150);
    expect(excludedCents).toBe(-80);
  });
});

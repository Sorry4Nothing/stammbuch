import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { axe } from "vitest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentTabContext, TabsProvider, useTabs, type CurrentTab } from "../../shell/tabs";
import { renderWithProviders } from "../../test-utils";
import { DebtorsPage } from "./DebtorsPage";
import { createMemoryReportsService } from "./memoryService";
import { OpenItemsPage } from "./OpenItemsPage";
import { PeriodClosingPage } from "./PeriodClosingPage";
import { ReportsHome } from "./ReportsHome";
import { reportsModule } from "./index";
import { ReportsProvider } from "./service";
import { StatementsPage } from "./StatementsPage";
import { TrialBalancePage } from "./TrialBalancePage";
import type { ReportsService } from "./types";
import { VatPage } from "./VatPage";

function TabList() {
  const { tabs } = useTabs();
  return <output aria-label="Offene Tabs">{tabs.map((x) => x.type).join(",")}</output>;
}

interface Harness {
  service?: ReportsService;
  params?: Record<string, string>;
}

/** Rendert eine Seite wie im Tab: mit Dienst, Tab-Verwaltung und dem eigenen Tab. */
function mount(page: ReactElement, { service, params = {} }: Harness = {}) {
  const tab: CurrentTab = {
    id: "tab-1",
    params,
    setDirty: vi.fn(),
    setTitle: vi.fn(),
    setPage: vi.fn(),
    registerSave: () => () => {},
    close: vi.fn(),
  };
  const svc = service ?? createMemoryReportsService();
  const view = renderWithProviders(
    <ReportsProvider service={svc}>
      <TabsProvider modules={[reportsModule]}>
        <CurrentTabContext.Provider value={tab}>{page}</CurrentTabContext.Provider>
        <TabList />
      </TabsProvider>
    </ReportsProvider>,
  );
  return { ...view, tab, svc: svc as ReturnType<typeof createMemoryReportsService> };
}

beforeEach(() => {
  // Feste Uhr (nur Datum): Board 6.1 bis 6.8 zeigen den 02.11.2026.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-02T14:00:00"));
});
afterEach(() => vi.useRealTimers());

const cell = (table: HTMLElement, text: string) => within(table).getByText(text);

describe("Offene-Posten-Liste (6.1)", () => {
  it("zeigt Zusammenfassung, Liste, Zähler und Summe", async () => {
    const { container } = mount(<OpenItemsPage />);
    expect(await screen.findByRole("heading", { name: "Offene-Posten-Liste" })).toBeInTheDocument();
    expect(screen.getByText("Auswertungen / Offene-Posten-Liste")).toBeInTheDocument();
    expect(screen.getByText("Stichtag 02.11.2026")).toBeInTheDocument();

    const summary = screen.getByRole("table", { name: "Offene Posten nach Altersklasse" });
    expect(
      within(summary)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual([
      "Offene Posten nach Altersklasse",
      "Nicht fällig",
      "1–30 Tage",
      "31–60 Tage",
      "61–90 Tage",
      "Über 90 Tage",
      "Total",
    ]);
    expect(cell(summary, "74")).toBeInTheDocument();
    expect(cell(summary, "CHF 13'220.00")).toBeInTheDocument();
    expect(cell(summary, "CHF 18'640.45")).toBeInTheDocument();

    const list = screen.getByRole("table", { name: "Offene Posten" });
    expect(within(list).getAllByRole("row")).toHaveLength(13);
    expect(within(list).getAllByRole("row")[1]).toHaveTextContent("R-2026-0344");
    expect(within(list).getAllByRole("row")[1]).toHaveTextContent("Probe und Partner AG M-1031");
    expect(within(list).getAllByRole("row")[1]).toHaveTextContent("CHF 550.00");
    expect(screen.getByText("12 von 74")).toBeInTheDocument();
    expect(screen.getByText("· sortiert nach Fälligkeit, aufsteigend")).toBeInTheDocument();
    expect(screen.getByText("Total offene Posten (74)")).toBeInTheDocument();
    expect(screen.getByText("Seite 1 von 7")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("filtert, blättert und sortiert", async () => {
    const user = userEvent.setup();
    const { tab } = mount(<OpenItemsPage />);
    await screen.findByText("12 von 74");

    await user.click(screen.getByRole("button", { name: "Nächste Seite" }));
    expect(screen.getByText("Seite 2 von 7")).toBeInTheDocument();
    expect(tab.setPage).toHaveBeenLastCalledWith(2, 7);
    await user.click(screen.getByRole("button", { name: "Vorherige Seite" }));

    await user.selectOptions(screen.getByRole("combobox", { name: "Altersklasse" }), "d61_90");
    expect(screen.getByText("1 von 1")).toBeInTheDocument();
    expect(screen.getByText("Total offene Posten (1)")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Altersklasse" }), "all");

    await user.type(
      screen.getByRole("searchbox", { name: "Rechnung oder Debitor suchen" }),
      "bäckerei",
    );
    expect(screen.getByText("1 von 1")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Offene Posten" })).toHaveTextContent("R-2026-0401");
    await user.clear(screen.getByRole("searchbox", { name: "Rechnung oder Debitor suchen" }));

    await user.click(screen.getByRole("button", { name: "Fällig" }));
    expect(screen.getByText("· sortiert nach Fälligkeit, absteigend")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Fällig" })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  });

  it("exportiert als .xlsx und meldet einen Fehler", async () => {
    const user = userEvent.setup();
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { svc } = mount(<OpenItemsPage />);
    await screen.findByText("12 von 74");
    await user.click(screen.getByRole("button", { name: "Als .xlsx exportieren" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(svc.calls).toContain('export:open-items:xlsx:{"asOf":"2026-11-02"}');
    click.mockRestore();
  });

  it("zeigt den Fehlerzustand mit «Erneut laden»", async () => {
    const user = userEvent.setup();
    const service = createMemoryReportsService();
    const openItems = vi.spyOn(service, "openItems").mockRejectedValueOnce(new Error("x"));
    mount(<OpenItemsPage />, { service });
    expect(
      await screen.findByText("Die Auswertung konnte nicht geladen werden."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Erneut laden" }));
    expect(await screen.findByText("12 von 74")).toBeInTheDocument();
    expect(openItems).toHaveBeenCalledTimes(2);
  });

  it("druckt über den Browser", async () => {
    const user = userEvent.setup();
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    mount(<OpenItemsPage />);
    await screen.findByText("12 von 74");
    await user.click(screen.getByRole("button", { name: "Auswertung drucken" }));
    await user.click(screen.getByRole("button", { name: "Als PDF speichern" }));
    expect(print).toHaveBeenCalledTimes(2);
  });
});

describe("Debitorenliste (6.2)", () => {
  it("zeigt Zusammenfassung je Konto, Mahnstufen und Seiten", async () => {
    const { container } = mount(<DebtorsPage />);
    expect(await screen.findByRole("heading", { name: "Debitorenliste" })).toBeInTheDocument();
    const summary = screen.getByRole("table", { name: "Debitorenkonten" });
    expect(summary).toHaveTextContent("1100 Debitoren Mitglieder");
    expect(summary).toHaveTextContent("1101 Debitoren Firmen");
    expect(within(summary).getAllByRole("row").at(-1)).toHaveTextContent("Total6174CHF 18'640.45");

    const list = screen.getByRole("table", { name: "Debitoren" });
    const first = within(list).getAllByRole("row")[1]!;
    expect(first).toHaveTextContent("M-1031");
    expect(first).toHaveTextContent("Firma");
    expect(first).toHaveTextContent("63 Tage");
    expect(within(first).getByText("3 · 2. Mahnung")).toBeInTheDocument();
    expect(screen.getByText("12 von 61")).toBeInTheDocument();
    expect(
      screen.getByText("· sortiert nach ältester Fälligkeit, aufsteigend"),
    ).toBeInTheDocument();
    expect(screen.getByText("Seite 1 von 6")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("filtert nach Typ und Mahnstufe", async () => {
    const user = userEvent.setup();
    mount(<DebtorsPage />);
    await screen.findByText("12 von 61");
    await user.selectOptions(screen.getByRole("combobox", { name: "Mahnstufe" }), "3");
    expect(screen.getByText("1 von 1")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Mahnstufe" }), "all");
    await user.selectOptions(screen.getByRole("combobox", { name: "Typ" }), "person");
    expect(screen.getByText("3 von 3")).toBeInTheDocument();
  });

  it("lässt Typ und Mahnstufe weg, wenn die Quelle sie nicht liefert", async () => {
    mount(<DebtorsPage />, { service: createMemoryReportsService({ bare: true }) });
    await screen.findByText("12 von 61");
    expect(screen.queryByRole("combobox", { name: "Typ" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Mahnstufe" })).not.toBeInTheDocument();
    const summary = screen.getByRole("table", { name: "Debitorenkonten" });
    expect(within(summary).getAllByRole("row")).toHaveLength(2); // Kopf und Summe
  });
});

describe("Saldenliste (6.3)", () => {
  it("zeigt Konten, Summen und die Probe", async () => {
    const { container } = mount(<TrialBalancePage />);
    expect(await screen.findByRole("heading", { name: "Saldenliste" })).toBeInTheDocument();
    expect(screen.getByText("01.01.2026 bis 02.11.2026")).toBeInTheDocument();
    expect(
      await screen.findByText(
        /Soll und Haben stimmen überein: CHF 204'946\.85\. Die Salden betragen je CHF 111'793\.65\./,
      ),
    ).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Saldenliste" });
    expect(within(table).getAllByRole("row")).toHaveLength(16);
    const total = within(table).getAllByRole("row").at(-1)!;
    expect(total).toHaveTextContent("Total204'946.85204'946.85111'793.65111'793.65");
    expect(screen.getByText("14 von 14 Konten")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("filtert nach Klasse und Zeitraum", async () => {
    const user = userEvent.setup();
    const service = createMemoryReportsService();
    const trialBalance = vi.spyOn(service, "trialBalance");
    mount(<TrialBalancePage />, { service });
    await screen.findByText("14 von 14 Konten");
    await user.selectOptions(screen.getByRole("combobox", { name: "Klasse" }), "revenue");
    expect(screen.getByText("8 von 14 Konten")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Zeitraum" }), "previous");
    await waitFor(() => expect(trialBalance).toHaveBeenLastCalledWith("2025-01-01", "2025-12-31"));
  });

  it("meldet eine Liste, die nicht aufgeht", async () => {
    const service = createMemoryReportsService();
    const orig = service.trialBalance;
    service.trialBalance = async (from, to) => {
      const r = await orig(from, to);
      return { ...r, rows: r.rows.slice(1) };
    };
    mount(<TrialBalancePage />, { service });
    expect(await screen.findByText("Saldenliste nicht ausgeglichen.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

describe("Erfolgsrechnung und Bilanz (6.4)", () => {
  it("zeigt beide Rechnungen und die Kontrolle", async () => {
    const { container } = mount(<StatementsPage />);
    expect(
      await screen.findByRole("heading", { name: "Erfolgsrechnung und Bilanz" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Nur Debitoren")).toBeInTheDocument();
    expect(await screen.findByText(/Es gibt keine Aufwandkonten/)).toBeInTheDocument();
    const income = screen.getByRole("table", { name: "Erfolgsrechnung" });
    expect(income).toHaveTextContent("3900Erlösminderungen (Gutschriften)−1'150.00");
    expect(income).toHaveTextContent("Total Ertrag109'500.00");
    expect(income).toHaveTextContent("Jahresergebnis (Gewinn)109'500.00");
    expect(screen.getByRole("heading", { name: "Bilanz per 02.11.2026" })).toBeInTheDocument();
    const balance = screen.getByRole("table", { name: "Bilanz" });
    expect(balance).toHaveTextContent("Total Aktiven110'643.65");
    expect(balance).toHaveTextContent("Total Passiven110'643.65");
    expect(
      screen.getByText(/Aktiven und Passiven betragen je CHF 110'643\.65\./),
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("exportiert Erfolgsrechnung und Bilanz", async () => {
    const user = userEvent.setup();
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { svc } = mount(<StatementsPage />);
    await screen.findByText("Nur Debitoren");
    await user.click(screen.getByRole("button", { name: "Als .xlsx exportieren" }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(2));
    expect(svc.calls.filter((c) => c.startsWith("export:"))).toEqual([
      'export:income-statement:xlsx:{"from":"2026-01-01","to":"2026-11-02"}',
      'export:balance-sheet:xlsx:{"asOf":"2026-11-02"}',
    ]);
    click.mockRestore();
  });
});

describe("MwSt-Abrechnung (6.5)", () => {
  it("zeigt Umsatz, Steuer nach Satz und Angaben", async () => {
    const { container } = mount(<VatPage />);
    expect(await screen.findByRole("heading", { name: "MwSt-Abrechnung" })).toBeInTheDocument();
    expect(screen.getByText("Geschäftsjahr 2026")).toBeInTheDocument();
    expect(await screen.findByText("Vorschau")).toBeInTheDocument();
    const turnover = screen.getByRole("table", { name: "Umsatz" });
    expect(turnover).toHaveTextContent(
      "Abzüglich Beiträge (Aktiv, Passiv, Jugend, Gönner)−92'660.00",
    );
    expect(turnover).toHaveTextContent("Steuerbarer Umsatz17'650.00");
    const rates = screen.getByRole("table", { name: "Steuer nach Satz" });
    expect(rates).toHaveTextContent("8.1 %12'450.001'008.452200");
    expect(rates).toHaveTextContent("Total17'650.001'143.65");
    expect(screen.getByText("CHE-000.000.000 MWST")).toBeInTheDocument();
    expect(screen.getByText("Effektiv, nach vereinbarten Entgelten")).toBeInTheDocument();
    expect(screen.getByText("CHF 1'143.65")).toBeInTheDocument();
    expect(screen.getByText(/Das Geschäftsjahr ist nicht abgeschlossen/)).toBeInTheDocument();
    expect(screen.getByText(/Die Steuer entspricht den Konten 2200 bis 2202/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Periodenabschluss (6.6 bis 6.8)", () => {
  it("wählt ohne Parameter die früheste nicht abgeschlossene Periode", async () => {
    const { svc } = mount(<PeriodClosingPage />);
    expect(
      await screen.findByRole("heading", { name: "Periodenabschluss Oktober 2026" }),
    ).toBeInTheDocument();
    await screen.findByText("Abschluss möglich, mit 2 Warnungen.");
    expect(svc.calls).toEqual(["review:p-10"]);
  });

  it("zeigt die Prüfung der Periode aus dem Tab-Parameter", async () => {
    const { container, svc } = mount(<PeriodClosingPage />, { params: { period: "p-10" } });
    expect(
      await screen.findByRole("heading", { name: "Periodenabschluss Oktober 2026" }),
    ).toBeInTheDocument();
    expect(svc.calls).toEqual(["review:p-10"]);
    expect(screen.getByText("01.10.2026 bis 31.10.2026")).toBeInTheDocument();
    expect(await screen.findByText("Abschluss möglich, mit 2 Warnungen.")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Schritte" })).toHaveTextContent(
      "1Prüfung2Bestätigung3Abgeschlossen",
    );
    expect(screen.getByText("Prüfung").closest("li")).toHaveAttribute("aria-current", "step");

    const checks = screen.getByRole("table", { name: "Prüfpunkte" });
    expect(within(checks).getAllByRole("row")).toHaveLength(8);
    expect(within(checks).getAllByText("Erfüllt")).toHaveLength(5);
    expect(within(checks).getAllByText("Warnung")).toHaveLength(2);
    const leftovers = screen.getByRole("table", { name: "Restposten" });
    expect(leftovers).toHaveTextContent("TotalCHF 1'466.00");
    expect(screen.getByRole("table", { name: "Restposten" })).toBeInTheDocument();
    expect(screen.getByText("330")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("bestätigt mit Eingabe des Periodennamens und zeigt das Protokoll (6.7, 6.8)", async () => {
    const user = userEvent.setup();
    const { svc } = mount(<PeriodClosingPage />, { params: { period: "p-10" } });
    await screen.findByText("Abschluss möglich, mit 2 Warnungen.");

    await user.click(screen.getByRole("button", { name: "Abschluss bestätigen" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Periode Oktober 2026 abschliessen?",
    });
    expect(dialog).toHaveTextContent("2 (Restposten, Entwürfe)");
    expect(dialog).toHaveTextContent("Danach keine Buchungen mehr im Oktober.");
    expect(dialog).toHaveTextContent(
      "Korrekturen sind nur als Gegenbuchung mit Datum im November möglich.",
    );
    expect(screen.getByText("Bestätigung").closest("li")).toHaveAttribute("aria-current", "step");
    expect(await axe(dialog)).toHaveNoViolations();

    const submit = within(dialog).getByRole("button", { name: "Periode abschliessen" });
    expect(submit).toBeDisabled();
    expect(
      within(dialog).getByText("Pflichtfeld. Gross- und Kleinschreibung beachten."),
    ).toBeInTheDocument();
    const input = within(dialog).getByLabelText(/Zur Bestätigung «Oktober 2026» eintippen/);
    await user.type(input, "oktober 2026");
    expect(submit).toBeDisabled();
    await user.clear(input);
    await user.type(input, "Oktober 2026");
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(await screen.findByText("Periode Oktober 2026 abgeschlossen.")).toBeInTheDocument();
    expect(svc.calls).toContain("close:p-10");
    expect(
      screen.getByText(/Der Abschluss wurde am 02\.11\.2026 um 14:52 Uhr protokolliert\./),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Periodenabschluss Oktober 2026" }),
    ).toBeInTheDocument();
    const head = screen.getByRole("heading", {
      name: "Periodenabschluss Oktober 2026",
    }).parentElement!;
    expect(within(head).getByText("Abgeschlossen")).toBeInTheDocument();

    const periods = screen.getByRole("table", { name: "Perioden" });
    expect(within(periods).getAllByRole("row")).toHaveLength(13);
    expect(within(periods).getByText("Oktober 2026").closest("tr")).toHaveClass("is-selected");
    expect(periods).toHaveTextContent("November 2026");
    expect(within(periods).getByText("Offen")).toBeInTheDocument();
    expect(within(periods).getByText("Noch nicht begonnen")).toBeInTheDocument();
    expect(periods).toHaveTextContent(
      "Januar 202601.01. bis 31.01.2026330Abgeschlossen03.02.2026 09:10Sabine Muster",
    );
    const protocol = screen
      .getByRole("heading", { name: "Abschlussprotokoll" })
      .closest("section")!;
    expect(protocol).toHaveTextContent("2 bestätigt");
    expect(screen.getByText("Periode gesperrt.")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Schritte" })).toHaveTextContent("Erledigt:Prüfung");
    expect(screen.queryByRole("button", { name: "Abschluss bestätigen" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Abschlussbericht als PDF speichern" }),
    ).toBeInTheDocument();
  });

  it("öffnet die Saldenliste nach dem Abschluss", async () => {
    const user = userEvent.setup();
    mount(<PeriodClosingPage />, { params: { period: "p-09" } });
    await screen.findByText("Periode gesperrt.");
    await user.click(screen.getByRole("button", { name: "Saldenliste öffnen" }));
    expect(screen.getByRole("status", { name: "Offene Tabs" })).toHaveTextContent(
      "reports-trial-balance",
    );
  });

  it("sperrt den Abschluss bei einem nicht erfüllten Prüfpunkt", async () => {
    const service = createMemoryReportsService({
      checks: [
        {
          id: "trialBalance",
          title: "Saldenliste ist ausgeglichen",
          result: "Soll CHF 10.00, Haben CHF 9.00",
          status: "error",
        },
      ],
    });
    mount(<PeriodClosingPage />, { service, params: { period: "p-10" } });
    expect(await screen.findByText("Abschluss nicht möglich.")).toBeInTheDocument();
    expect(screen.getByText("Nicht erfüllt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abschluss bestätigen" })).toBeDisabled();
  });

  it("meldet einen fehlgeschlagenen Abschluss im Dialog", async () => {
    const user = userEvent.setup();
    const service = createMemoryReportsService();
    service.closePeriod = () => Promise.reject(new Error("x"));
    mount(<PeriodClosingPage />, { service, params: { period: "p-10" } });
    await screen.findByText("Abschluss möglich, mit 2 Warnungen.");
    await user.click(screen.getByRole("button", { name: "Abschluss bestätigen" }));
    await user.type(await screen.findByLabelText(/Zur Bestätigung/), "Oktober 2026");
    await user.click(screen.getByRole("button", { name: "Periode abschliessen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Der Abschluss ist fehlgeschlagen.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("bricht ab: nimmt die Prüfung zurück und schliesst den Tab", async () => {
    const user = userEvent.setup();
    const { svc, tab } = mount(<PeriodClosingPage />, { params: { period: "p-10" } });
    await screen.findByText("Abschluss möglich, mit 2 Warnungen.");
    await user.click(screen.getByRole("button", { name: "Abschluss abbrechen" }));
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(svc.calls).toContain("cancel:p-10");
  });

  it("verzichtet auf Restposten und Zähler, wenn die Quelle sie nicht liefert", async () => {
    mount(<PeriodClosingPage />, {
      service: createMemoryReportsService({ bare: true }),
      params: { period: "p-10" },
    });
    await screen.findByText("Abschluss möglich, mit 2 Warnungen.");
    expect(screen.queryByRole("table", { name: "Restposten" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Periode" })).not.toBeInTheDocument();
  });

  it("öffnet die Liste der Entwürfe aus der Prüfung", async () => {
    const user = userEvent.setup();
    mount(<PeriodClosingPage />, { params: { period: "p-10" } });
    await screen.findByText("Abschluss möglich, mit 2 Warnungen.");
    await user.click(screen.getByRole("button", { name: "Entwürfe ansehen" }));
    // Das Modul Rechnungen ist hier nicht registriert: es öffnet sich kein Tab.
    expect(screen.getByRole("status", { name: "Offene Tabs" })).not.toHaveTextContent("invoices");
  });
});

describe("Einstieg", () => {
  it("öffnet die Auswertungen als Tabs", async () => {
    const user = userEvent.setup();
    const { container } = mount(<ReportsHome />);
    expect(screen.getByRole("heading", { name: "Auswertungen" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Saldenliste" }));
    await user.click(screen.getByRole("button", { name: "MwSt-Abrechnung" }));
    expect(screen.getByRole("status", { name: "Offene Tabs" })).toHaveTextContent(
      "reports,reports-trial-balance,reports-vat",
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

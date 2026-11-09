import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../../shell/AppShell";
import { renderWithProviders } from "../../test-utils";
import type { ModuleDefinition } from "../types";
import { startModule } from ".";
import { formatChf, formatDate } from "./format";
import { memoryStartService } from "./memoryStartService";
import { StartServiceContext, type StartData } from "./startService";

/** Die Beispielwerte aus Board 2.1. */
const board: StartData = {
  tasks: [
    { id: "t1", title: "Firma «Muster Bäckerei GmbH» freigeben", due: "2026-11-02" },
    { id: "t2", title: "Mahnung Stufe 2 für 2 Rechnungen versenden", due: "2026-11-02" },
    { id: "t3", title: "3 Zahlungen manuell zuordnen", due: "2026-11-03" },
    { id: "t4", title: "Zahlungsimport CAMT.053 vom 31.10.2026 prüfen", due: "2026-11-04" },
    { id: "t5", title: "Erinnerung Anmeldeschluss GV versenden", due: "2026-11-05" },
    { id: "t6", title: "7 mögliche Duplikate prüfen", due: "2026-11-06" },
    { id: "t7", title: "Periode Oktober abschliessen", due: "2026-11-10" },
    { id: "t8", title: "Sammelrechnung Mitgliederbeitrag 2027 planen", due: "2026-11-30" },
  ],
  openItems: [
    {
      id: "i1",
      invoiceNumber: "R-2026-0340",
      debtor: "Eva Vorlage",
      amountCents: 24000,
      due: "2026-09-15",
    },
    {
      id: "i2",
      invoiceNumber: "R-2026-0352",
      debtor: "Daniel Test",
      amountCents: 12000,
      due: "2026-09-20",
    },
    {
      id: "i3",
      invoiceNumber: "R-2026-0364",
      debtor: "Muster GmbH",
      amountCents: 125000,
      due: "2026-09-25",
    },
    {
      id: "i4",
      invoiceNumber: "R-2026-0377",
      debtor: "Claudia Probe",
      amountCents: 24000,
      due: "2026-10-01",
    },
    {
      id: "i5",
      invoiceNumber: "R-2026-0391",
      debtor: "Beispiel AG",
      amountCents: 125000,
      due: "2026-10-10",
    },
    {
      id: "i6",
      invoiceNumber: "R-2026-0398",
      debtor: "Beat Muster",
      amountCents: 24000,
      due: "2026-10-15",
    },
    {
      id: "i7",
      invoiceNumber: "R-2026-0412",
      debtor: "Anna Beispiel",
      amountCents: 12000,
      due: "2026-10-31",
    },
  ],
  events: [
    {
      id: "e1",
      title: "Generalversammlung 2026",
      date: "2026-11-14",
      time: "17:00",
      confirmed: 86,
      deadline: "2026-11-06",
    },
    {
      id: "e2",
      title: "Helferessen",
      date: "2026-11-21",
      time: "19:00",
      confirmed: 24,
      deadline: "2026-11-14",
    },
    { id: "e3", title: "Vorstandssitzung", date: "2026-11-26", time: "18:30", confirmed: 7 },
  ],
};

const stub = (id: string, newTabType: string, label: string): ModuleDefinition => ({
  id,
  titleKey: "shortcuts.general",
  nav: { labelKey: "shortcuts.tabs", icon: "people", order: 1, tabType: `${id}-list` },
  newTabType,
  tabTypes: [
    { id: `${id}-list`, titleKey: "shortcuts.lists", component: () => <h1>{label}</h1> },
    { id: newTabType, titleKey: "shortcuts.new", component: () => <h1>{label} neu</h1> },
  ],
});

const people = stub("people", "person-form", "Personenformular");
const invoices = stub("invoices", "invoice-form", "Rechnungsformular");
const calendar = stub("calendar", "event-form", "Kalender");

function setup(data: StartData | "fail" | undefined, modules: ModuleDefinition[] = [startModule]) {
  const service =
    data === undefined
      ? undefined
      : memoryStartService(data === "fail" ? board : data, { fail: () => data === "fail" });
  const ui = <AppShell modules={modules} />;
  return renderWithProviders(
    service ? (
      <StartServiceContext.Provider value={service}>{ui}</StartServiceContext.Provider>
    ) : (
      ui
    ),
  );
}

beforeEach(() => {
  // «Montag, 02.11.2026» wie im Board; nur das Datum, die Timer laufen echt.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 2, 9, 0));
});
afterEach(() => vi.useRealTimers());

describe("Format", () => {
  it("schreibt Beträge und Daten wie im Design", () => {
    expect(formatChf(125000)).toBe("CHF 1'250.00");
    expect(formatChf(5)).toBe("CHF 0.05");
    expect(formatChf(346000)).toBe("CHF 3'460.00");
    expect(formatChf(-12000)).toBe("CHF −120.00");
    expect(formatDate("2026-11-02")).toBe("02.11.2026");
  });
});

describe("Startseite (Design 2.1)", () => {
  it("zeigt Kopf, drei Tabellen mit Zählern, Status, Summenzeile und Events", async () => {
    setup(board, [startModule, people, invoices, calendar]);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Startseite" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Montag, 02.11.2026")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Person anlegen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rechnung erstellen" })).toHaveClass("btn--primary");

    const tasks = await screen.findByRole("table", { name: "Offene Aufgaben" });
    expect(screen.getByRole("heading", { name: /Offene Aufgaben \(8\)/ })).toBeInTheDocument();
    expect(within(tasks).getAllByText("Heute")).toHaveLength(2);
    expect(within(tasks).getAllByText("Offen")).toHaveLength(6);
    expect(within(tasks).getByRole("columnheader", { name: /Fällig/ })).toBeInTheDocument();

    const items = screen.getByRole("table", { name: "Offene Posten, alle überfällig" });
    expect(screen.getByRole("heading", { name: /Offene Posten \(7\)/ })).toBeInTheDocument();
    expect(within(items).getAllByText("CHF 1'250.00")).toHaveLength(2);
    const total = within(items).getByText("Total").closest("tr")!;
    expect(total).not.toHaveTextContent("Posten");
    expect(total).toHaveTextContent("CHF 3'460.00");

    const events = screen.getByRole("table", { name: "Anstehende Events" });
    expect(screen.getByRole("heading", { name: /Anstehende Events \(3\)/ })).toBeInTheDocument();
    expect(within(events).getByText("14.11.2026 · 17:00")).toBeInTheDocument();
    expect(within(events).getByText("–")).toBeInTheDocument();
  });

  it("zeigt Beträge in ihrer Währung und addiert nur gleiche Währungen", async () => {
    const item = (id: string, amountCents: number, currency?: string) => ({
      id,
      invoiceNumber: `RE-${id}`,
      debtor: "Erika Beispiel",
      amountCents,
      due: "2026-10-01",
      ...(currency ? { currency } : {}),
    });
    const { unmount } = setup({
      tasks: [],
      events: [],
      openItems: [item("1", 10000, "EUR"), item("2", 5050, "EUR")],
    });
    const items = await screen.findByRole("table", { name: /Offene Posten/ });
    expect(within(items).getByText("EUR 100.00")).toBeInTheDocument();
    expect(within(items).getByText("Total").closest("tr")).toHaveTextContent("EUR 150.50");
    unmount();

    setup({ tasks: [], events: [], openItems: [item("1", 10000, "EUR"), item("2", 5050)] });
    const mixed = await screen.findByRole("table", { name: /Offene Posten/ });
    expect(within(mixed).getByText("CHF 50.50")).toBeInTheDocument();
    const total = within(mixed).getByText("Total").closest("tr")!;
    expect(total).toHaveTextContent("Total–");
    expect(total).not.toHaveTextContent("CHF 150.50");
  });

  it("zeigt ohne Daten den Leer-Zustand und keine erfundenen Zeilen", async () => {
    setup(undefined);
    expect(await screen.findAllByText("Noch keine Einträge.")).toHaveLength(2);
    // Events: eigener Leerzustand; die Aktion fehlt ohne Kalendermodul.
    expect(screen.getByRole("heading", { name: "Keine anstehenden Events." })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Event erstellen" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Offene Aufgaben \(0\)/ })).toBeInTheDocument();
    // Ohne Fachmodule gibt es keine Ziele für die Schaltflächen.
    expect(screen.queryByRole("button", { name: "Person anlegen" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Zum Kalender" })).not.toBeInTheDocument();
  });

  it("Leerzustand der Events bietet «Event erstellen» mit Kalendermodul", async () => {
    setup(undefined, [startModule, calendar]);
    await userEvent.click(await screen.findByRole("button", { name: "Event erstellen" }));
    expect(await screen.findByRole("heading", { name: "Kalender neu" })).toBeVisible();
  });

  it("die Schaltflächen öffnen die Tabs der Fachmodule", async () => {
    setup(board, [startModule, people, invoices, calendar]);
    await userEvent.click(await screen.findByRole("button", { name: "Person anlegen" }));
    expect(screen.getByRole("heading", { name: "Personenformular neu" })).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "Start" }));
    await userEvent.click(screen.getByRole("button", { name: "Zum Kalender" }));
    expect(screen.getByRole("heading", { name: "Kalender" })).toBeVisible();
  });

  it("zeigt bei einem Serverfehler Meldung, Angaben für den Support und lädt erneut", async () => {
    let fail = true;
    const service = memoryStartService(board, { fail: () => fail });
    renderWithProviders(
      <StartServiceContext.Provider value={service}>
        <AppShell modules={[startModule]} />
      </StartServiceContext.Provider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Die Startseite konnte nicht geladen werden.",
    );
    expect(screen.getByRole("heading", { name: "Angaben für den Support" })).toBeInTheDocument();
    expect(screen.getByText(/^ERR-\d{8}-[0-9A-F]{4}$/)).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Erneut laden" }));
    expect(await screen.findByRole("table", { name: "Offene Aufgaben" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    const { container } = setup(board, [startModule, people, invoices, calendar]);
    await screen.findByRole("table", { name: "Offene Aufgaben" });
    expect(await axe(container)).toHaveNoViolations();
  });
});

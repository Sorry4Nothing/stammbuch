import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { axe } from "vitest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentTabContext, TabsProvider, useTabs, type CurrentTab } from "../../shell/tabs";
import { renderWithProviders } from "../../test-utils";
import { BuchungenPage } from "./BuchungenPage";
import { chf, pairLines, parseChDate, qrReference, taxRateAllowed, taxRateLabel } from "./format";
import { createHttpBuchhaltungService } from "./httpService";
import { HubPage } from "./HubPage";
import { ImportPage } from "./ImportPage";
import { resetImports } from "./importStore";
import { accountingModule } from "./index";
import { createMemoryBuchhaltungService, type MemorySeed } from "./memoryService";
import { KontenplanPage } from "./KontenplanPage";
import { OffenePostenPage } from "./OffenePostenPage";
import { BuchhaltungProvider } from "./service";
import { TAB } from "./tabs";
import type { BuchhaltungService, CamtPayment, Entry } from "./types";
import { DebitorPage } from "./DebitorPage";
import { nameFit, ZuordnungPage } from "./ZuordnungPage";

function renderPage(ui: ReactElement, seed: MemorySeed = {}, params: Record<string, string> = {}) {
  const service = createMemoryBuchhaltungService(seed);
  return renderService(ui, service, params);
}

function renderService(ui: ReactElement, service: BuchhaltungService, params = {}) {
  const current: CurrentTab = {
    id: "t1",
    params,
    setDirty: () => {},
    setTitle: () => {},
    setPage: () => {},
    registerSave: () => () => {},
    close: () => {},
  };
  return renderWithProviders(
    <TabsProvider modules={[accountingModule]} initialType={TAB.hub}>
      <CurrentTabContext.Provider value={current}>
        <BuchhaltungProvider service={service}>{ui}</BuchhaltungProvider>
      </CurrentTabContext.Provider>
    </TabsProvider>,
  );
}

beforeEach(() => resetImports());

/** Prüft die ganze Seite samt Dialogen. Die Regel «region» betrifft nur ganze Dokumente: die Landmarken liefert der Rahmen der Shell. */
const check = () => axe(document.body, { rules: { region: { enabled: false } } });

const accounts = [
  {
    code: "1020",
    name: "Bank",
    type: "asset",
    active: true,
    debit: 9_200_320,
    credit: 0,
    balance: 9_200_320,
  },
  {
    code: "1100",
    name: "Debitoren",
    type: "asset",
    active: true,
    debit: 100,
    credit: 50,
    balance: 50,
  },
  {
    code: "3900",
    name: "Erlösminderungen",
    type: "expense",
    active: true,
    debit: 0,
    credit: 115_000,
    balance: -115_000,
  },
] as const;

describe("Format", () => {
  it("formatiert Beträge wie im Design", () => {
    expect(chf(125_000)).toBe("CHF 1'250.00");
    expect(chf(-115_000)).toBe("CHF −1'150.00");
    expect(chf(5)).toBe("CHF 0.05");
  });

  it("liest Daten als TT.MM.JJJJ und weist Unmögliches ab", () => {
    expect(parseChDate("02.11.2026")).toBe("2026-11-02");
    expect(parseChDate("31.02.2026")).toBeNull();
    expect(parseChDate("2026-11-02")).toBeNull();
  });

  it("zeigt Steuersätze und kennt die Konten, auf denen ein Satz möglich ist", () => {
    expect(taxRateLabel(810)).toBe("8.1 %");
    expect(taxRateLabel(260)).toBe("2.6 %");
    expect(taxRateLabel(380)).toBe("3.8 %");
    expect(taxRateLabel(undefined)).toBe("–");
    expect(taxRateAllowed("revenue", "3200")).toBe(true);
    expect(taxRateAllowed("liability", "2200")).toBe(true);
    expect(taxRateAllowed("liability", "2000")).toBe(false);
    expect(taxRateAllowed("asset", "1170")).toBe(true);
    expect(taxRateAllowed("asset", "1020")).toBe(false);
    expect(taxRateAllowed("equity", "2800")).toBe(false);
  });

  it("teilt eine Sammelbuchung auf Kontenpaare auf", () => {
    expect(
      pairLines([
        { accountCode: "1101", side: "debit", amount: 64_860 },
        { accountCode: "3100", side: "credit", amount: 60_000 },
        { accountCode: "2200", side: "credit", amount: 4_860 },
      ]),
    ).toEqual([
      { debit: "1101", credit: "3100", amount: 60_000 },
      { debit: "1101", credit: "2200", amount: 4_860 },
    ]);
  });

  it("gruppiert die QR-Referenz und vergleicht Namen", () => {
    expect(qrReference("RF18539007547034")).toBe("RF18539007547034");
    expect(qrReference("123456789012345678901234567")).toBe("12 34567 89012 34567 89012 34567");
    expect(nameFit("Beispiel Bäckerei GmbH", "Beispiel Bäckerei GmbH")).toBe("same");
    expect(nameFit("Beispiel AG", "Beispiel Gastro GmbH")).toBe("similar");
    expect(nameFit("Anna Muster", "Test Elektro GmbH")).toBe("other");
  });
});

describe("Kontenplan (5.1)", () => {
  it("zeigt Konten mit Salden und Details", async () => {
    renderPage(<KontenplanPage />, { accounts: [...accounts] });
    const table = await screen.findByRole("table", { name: "Kontenplan" });
    expect(within(table).getByText("CHF −1'150.00")).toBeInTheDocument();
    expect(within(table).getByText("Erlösminderungen")).toBeInTheDocument();
    expect(screen.getByText("Konto 1020 · Bank")).toBeInTheDocument();
    expect(screen.queryByText("Löschen nicht möglich.")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Konto 1100 auswählen" }));
    expect(screen.getByText("Konto 1100 · Debitoren")).toBeInTheDocument();
    expect(await check()).toHaveNoViolations();
  });

  it("filtert nach Klasse und Suche", async () => {
    renderPage(<KontenplanPage />, { accounts: [...accounts] });
    await screen.findByRole("table", { name: "Kontenplan" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Klasse" }), "expense");
    expect(screen.getByText("1 von 3")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox"), "zzz");
    expect(screen.getByText("0 von 3")).toBeInTheDocument();
  });

  it("prüft die Eingaben beim Anlegen und legt das Konto an", async () => {
    renderPage(<KontenplanPage />, { accounts: [...accounts] });
    await screen.findByRole("table", { name: "Kontenplan" });
    await userEvent.click(screen.getByRole("button", { name: "Konto anlegen" }));
    const dialog = screen.getByRole("dialog", { name: "Konto anlegen" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Konto anlegen" }));
    expect(within(dialog).getByText("Geben Sie 4 bis 6 Ziffern ein.")).toBeInTheDocument();
    expect(await check()).toHaveNoViolations();
    await userEvent.type(within(dialog).getByLabelText("Kontonummer *"), "3400");
    await userEvent.type(within(dialog).getByLabelText("Bezeichnung *"), "Mahngebühren");
    await userEvent.click(within(dialog).getByRole("button", { name: "Konto anlegen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Mahngebühren")).toBeInTheDocument();
  });

  it("benennt ein Konto um", async () => {
    const service = createMemoryBuchhaltungService({ accounts: [...accounts] });
    const rename = vi.spyOn(service, "renameAccount");
    renderService(<KontenplanPage />, service);
    await screen.findByRole("table", { name: "Kontenplan" });
    await userEvent.click(screen.getByRole("button", { name: "Bezeichnung ändern" }));
    const dialog = screen.getByRole("dialog");
    const name = within(dialog).getByLabelText("Bezeichnung *");
    await userEvent.clear(name);
    await userEvent.type(name, "Bankguthaben");
    await userEvent.click(within(dialog).getByRole("button", { name: "Bezeichnung ändern" }));
    await waitFor(() => expect(rename).toHaveBeenCalledWith("1020", "Bankguthaben"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Bankguthaben")).toBeInTheDocument();
  });

  it("zeigt den Steuersatz je Konto und «–» für Konten ohne Steuer", async () => {
    renderPage(<KontenplanPage />, {
      accounts: [accounts[0], { ...accounts[2], taxRateBp: 810 }],
    });
    const table = await screen.findByRole("table", { name: "Kontenplan" });
    expect(
      within(within(table).getByText("Erlösminderungen").closest("tr")!).getByText("8.1 %"),
    ).toBeInTheDocument();
    const bank = within(table).getByText("Bank").closest("tr")!;
    expect(within(bank).getAllByRole("cell")[3]).toHaveTextContent("–");
    await userEvent.click(screen.getByRole("button", { name: "Konto 3900 auswählen" }));
    const detail = screen.getByText("Konto 3900 · Erlösminderungen").closest("section")!;
    expect(detail).toHaveTextContent("MwSt8.1 %");
  });

  it("ändert den Steuersatz eines Kontos und entfernt ihn wieder", async () => {
    const service = createMemoryBuchhaltungService({ accounts: [...accounts] });
    const setRate = vi.spyOn(service, "setAccountTaxRate");
    renderService(<KontenplanPage />, service);
    await screen.findByRole("table", { name: "Kontenplan" });
    // Bank (Aktiven, kein Steuerkonto) kennt keinen Satz.
    expect(screen.queryByRole("button", { name: "Steuersatz ändern" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Konto 3900 auswählen" }));
    await userEvent.click(screen.getByRole("button", { name: "Steuersatz ändern" }));
    let dialog = screen.getByRole("dialog", { name: "Steuersatz ändern" });
    expect(await check()).toHaveNoViolations();
    await userEvent.selectOptions(
      within(dialog).getByRole("combobox", { name: "MwSt-Satz" }),
      "260",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Steuersatz ändern" }));
    await waitFor(() => expect(setRate).toHaveBeenCalledWith("3900", 260));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const table = screen.getByRole("table", { name: "Kontenplan" });
    expect(
      await within(within(table).getByText("Erlösminderungen").closest("tr")!).findByText("2.6 %"),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Steuersatz ändern" }));
    dialog = screen.getByRole("dialog", { name: "Steuersatz ändern" });
    const select = within(dialog).getByRole("combobox", { name: "MwSt-Satz" });
    expect(select).toHaveValue("260");
    await userEvent.selectOptions(select, "");
    await userEvent.click(within(dialog).getByRole("button", { name: "Steuersatz ändern" }));
    await waitFor(() => expect(setRate).toHaveBeenLastCalledWith("3900", null));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(
      within(within(table).getByText("Erlösminderungen").closest("tr")!).queryByText("2.6 %"),
    ).not.toBeInTheDocument();
  });

  it("meldet, wenn die API den Steuersatz ablehnt", async () => {
    const service = createMemoryBuchhaltungService({ accounts: [...accounts] });
    const { ApiError } = await import("./types");
    vi.spyOn(service, "setAccountTaxRate").mockRejectedValue(
      new ApiError(422, "RULE_VIOLATION", "Auf diesem Konto ist kein Steuersatz möglich."),
    );
    renderService(<KontenplanPage />, service);
    await screen.findByRole("table", { name: "Kontenplan" });
    await userEvent.click(screen.getByRole("button", { name: "Konto 3900 auswählen" }));
    await userEvent.click(screen.getByRole("button", { name: "Steuersatz ändern" }));
    const dialog = screen.getByRole("dialog", { name: "Steuersatz ändern" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Steuersatz ändern" }));
    expect(
      await within(dialog).findByText("Auf diesem Konto ist kein Steuersatz möglich."),
    ).toBeInTheDocument();
  });

  it("legt ein Konto mit Steuersatz an; Eigenkapital bietet keinen Satz an", async () => {
    const service = createMemoryBuchhaltungService({ accounts: [...accounts] });
    const create = vi.spyOn(service, "createAccount");
    renderService(<KontenplanPage />, service);
    await screen.findByRole("table", { name: "Kontenplan" });
    await userEvent.click(screen.getByRole("button", { name: "Konto anlegen" }));
    const dialog = screen.getByRole("dialog", { name: "Konto anlegen" });
    await userEvent.type(within(dialog).getByLabelText("Kontonummer *"), "3410");
    await userEvent.type(within(dialog).getByLabelText("Bezeichnung *"), "Werbung");
    // Aktiven (Voreinstellung) mit Nummer 3410: kein Steuerkonto, also kein Satz zur Wahl.
    expect(within(dialog).queryByRole("combobox", { name: "MwSt-Satz" })).not.toBeInTheDocument();
    await userEvent.selectOptions(
      within(dialog).getByRole("combobox", { name: "Klasse" }),
      "revenue",
    );
    await userEvent.selectOptions(
      within(dialog).getByRole("combobox", { name: "MwSt-Satz" }),
      "810",
    );
    await userEvent.selectOptions(
      within(dialog).getByRole("combobox", { name: "Klasse" }),
      "equity",
    );
    expect(within(dialog).queryByRole("combobox", { name: "MwSt-Satz" })).not.toBeInTheDocument();
    await userEvent.selectOptions(
      within(dialog).getByRole("combobox", { name: "Klasse" }),
      "revenue",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Konto anlegen" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        code: "3410",
        name: "Werbung",
        type: "revenue",
        taxRateBp: 810,
      }),
    );
    expect(await screen.findByText("Werbung")).toBeInTheDocument();
  });

  it("zeigt die Buchungszahl des gewählten Kontos im Seitenfenster, «–» wenn die Quelle sie nicht liefert", async () => {
    renderPage(<KontenplanPage />, {
      accounts: [{ ...accounts[0], entryCount: 42 }, accounts[1]],
    });
    await screen.findByRole("table", { name: "Kontenplan" });
    expect(await screen.findByText("42")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Konto 1100/ }));
    expect(screen.queryByText("42")).not.toBeInTheDocument();
  });

  it("meldet den Fehler, wenn der Export scheitert", async () => {
    const service = createMemoryBuchhaltungService({ accounts: [...accounts] });
    const { ApiError } = await import("./types");
    vi.spyOn(service, "exportXlsx").mockRejectedValue(new ApiError(500));
    renderService(<KontenplanPage />, service);
    await screen.findByRole("table", { name: "Kontenplan" });
    await userEvent.click(screen.getByRole("button", { name: "Als Excel-Datei exportieren" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Die Aktion ist fehlgeschlagen.");
  });
});

const entries: Entry[] = [
  {
    id: "e1",
    number: 1861,
    bookingDate: "2026-10-21",
    kind: "invoice",
    description: "Rechnung R-2026-0424 Muster GmbH",
    lines: [
      { accountCode: "1101", side: "debit", amount: 64_860 },
      { accountCode: "3100", side: "credit", amount: 60_000 },
      { accountCode: "2200", side: "credit", amount: 4_860 },
    ],
    reversalOf: null,
    createdBy: "u1",
  },
  {
    id: "e2",
    number: 1867,
    bookingDate: "2026-10-30",
    kind: "payment",
    description: "Zahlung R-2026-0427 Eva Vorlage",
    lines: [
      { accountCode: "1020", side: "debit", amount: 6_000 },
      { accountCode: "1100", side: "credit", amount: 6_000 },
    ],
    reversalOf: null,
    createdBy: "u1",
  },
];

describe("Buchungen (5.2, 5.3)", () => {
  const seed = () => ({ entries });

  it("zeigt Belegzeilen als Kontenpaare mit Typ", async () => {
    const service = createMemoryBuchhaltungService(seed());
    vi.spyOn(service, "listEntries").mockResolvedValue({ items: entries, hasMore: false });
    renderService(<BuchungenPage />, service, {});
    const table = await screen.findByRole("table", { name: "Buchungen" });
    expect(await within(table).findAllByText("B-2026-1861")).toHaveLength(2);
    expect(within(table).getByText("1/2")).toBeInTheDocument();
    expect(within(table).getByText("CHF 600.00")).toBeInTheDocument();
    expect(within(table).getByText("Zahlung")).toBeInTheDocument();
    expect(within(table).getByText("System")).toBeInTheDocument();
    expect(screen.queryByText("Nichts änderbar.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gegenbuchung erfassen" })).toBeDisabled();
    expect(await check()).toHaveNoViolations();
  });

  it("zeigt den Namen des Erfassers, sonst die Kennung, und die Seitenzahl aus der Gesamtzahl", async () => {
    const service = createMemoryBuchhaltungService(seed());
    vi.spyOn(service, "listEntries").mockResolvedValue({
      items: [
        { ...entries[0]!, createdByName: "Erika Muster" },
        { ...entries[0]!, id: "e3", number: 1900, createdByName: null, createdBy: "u-unbekannt" },
      ],
      hasMore: true,
      total: 120,
    });
    renderService(<BuchungenPage />, service, {});
    const table = await screen.findByRole("table", { name: "Buchungen" });
    expect((await within(table).findAllByText("Erika Muster")).length).toBeGreaterThan(0);
    expect(within(table).getAllByText("u-unbekannt").length).toBeGreaterThan(0);
    expect(screen.getByText("Seite 1 von 9")).toBeInTheDocument();
  });

  it("storniert einen gewählten Beleg per Gegenbuchung mit Vorschau und Pflichtfeldern", async () => {
    const service = createMemoryBuchhaltungService(seed());
    const reverse = vi.spyOn(service, "reverseEntry");
    const dated = vi
      .spyOn(service, "listEntries")
      .mockResolvedValue({ items: entries, hasMore: false });
    renderService(<BuchungenPage />, service, {});
    await screen.findAllByText("B-2026-1861");
    expect(dated).toHaveBeenCalled();
    expect(screen.getAllByText("1/2")).toHaveLength(1);
    expect(screen.getAllByText("Rechnung").length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: "Beleg B-2026-1861 auswählen" }));
    await userEvent.click(screen.getByRole("button", { name: "Gegenbuchung erfassen" }));

    const dialog = screen.getByRole("dialog", {
      name: "Beleg B-2026-1861 per Gegenbuchung stornieren?",
    });
    expect(within(dialog).getByText("B-2026-1861 · 21.10.2026 · 2 Zeilen")).toBeInTheDocument();
    expect(within(dialog).getByText("CHF 648.60")).toBeInTheDocument();
    const preview = within(dialog).getByRole("table", { name: "Gegenbuchung" });
    expect(within(preview).getAllByText("Storno B-2026-1861")).toHaveLength(2);
    expect(within(preview).getByText("3100")).toBeInTheDocument();
    expect(await check()).toHaveNoViolations();

    const date = within(dialog).getByLabelText("Buchungsdatum *");
    await userEvent.clear(date);
    await userEvent.type(date, "31.02.2026");
    await userEvent.click(within(dialog).getByRole("button", { name: "Gegenbuchung buchen" }));
    expect(
      within(dialog).getByText("Geben Sie ein Datum im Format TT.MM.JJJJ ein."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Geben Sie einen Grund mit mindestens 3 Zeichen an."),
    ).toBeInTheDocument();
    expect(reverse).not.toHaveBeenCalled();

    await userEvent.clear(date);
    await userEvent.type(date, "02.11.2026");
    await userEvent.type(
      within(dialog).getByLabelText("Grund der Gegenbuchung *"),
      "Rechnung storniert: falscher Betrag",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Gegenbuchung buchen" }));
    await waitFor(() => expect(reverse).toHaveBeenCalledOnce());
    expect(reverse).toHaveBeenCalledWith("e1", {
      idempotencyKey: expect.any(String) as string,
      bookingDate: "2026-11-02",
      reason: "Rechnung storniert: falscher Betrag",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("zeigt Fachfehler der API im Dialog", async () => {
    const service = createMemoryBuchhaltungService(seed());
    vi.spyOn(service, "listEntries").mockResolvedValue({ items: entries, hasMore: false });
    const { ApiError } = await import("./types");
    vi.spyOn(service, "reverseEntry").mockRejectedValue(
      new ApiError(409, "PERIOD_CLOSED", "Die Buchungsperiode ist abgeschlossen."),
    );
    renderService(<BuchungenPage />, service, {});
    await userEvent.click(
      await screen.findByRole("button", { name: "Beleg B-2026-1867 auswählen" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Gegenbuchung erfassen" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Grund der Gegenbuchung *"), "Irrtum");
    await userEvent.click(within(dialog).getByRole("button", { name: "Gegenbuchung buchen" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Die Buchungsperiode ist abgeschlossen.",
    );
  });

  it("blättert ohne Gesamtzahl: weiter nur, wenn die API eine Folgeseite meldet", async () => {
    const service = createMemoryBuchhaltungService(seed());
    const list = vi
      .spyOn(service, "listEntries")
      .mockResolvedValueOnce({ items: entries, hasMore: true })
      .mockResolvedValue({ items: [], hasMore: false });
    renderService(<BuchungenPage />, service, {});
    await screen.findAllByText("B-2026-1861");
    expect(screen.getByRole("button", { name: "Vorherige Seite" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Nächste Seite" }));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 14 })),
    );
    expect(await screen.findByText("Seite 2")).toBeInTheDocument();
  });
});

const invoices = [
  {
    id: "i1",
    number: "R-2020-0001",
    debtorName: "Probe und Partner AG",
    dueDate: "2020-08-31",
    openRappen: 55_000,
  },
  {
    id: "i2",
    number: "R-2020-0002",
    debtorName: "Beispiel Bäckerei GmbH",
    dueDate: "2020-09-14",
    openRappen: 163_045,
  },
  {
    id: "i3",
    number: "R-2099-0003",
    debtorName: "Test Elektro GmbH",
    dueDate: "2099-01-01",
    openRappen: 125_000,
  },
];

describe("Offene Posten (5.4)", () => {
  it("fasst die Posten zusammen und zeigt Überfälligkeit und Mahnstufe", async () => {
    renderPage(<OffenePostenPage />, {
      invoices,
      reminders: { i1: [{ level: 2, title: "1. Mahnung" }] },
    });
    const table = await screen.findByRole("table", { name: "Offene Posten" });
    expect(within(table).getByText("2 · 1. Mahnung")).toBeInTheDocument();
    expect(within(table).getByText("CHF 1'630.45")).toBeInTheDocument();
    expect(within(table).getAllByText("Keine")).toHaveLength(2);
    const sums = screen.getByText("Alle offenen Posten:").parentElement!;
    expect(sums).toHaveTextContent("CHF 3'430.45 3 Posten");
    expect(screen.getByText("davon überfällig:").parentElement).toHaveTextContent(
      "CHF 2'180.45 2 Posten",
    );
    expect(screen.getByText("mit Mahnstufe:").parentElement).toHaveTextContent(
      "CHF 550.00 1 Posten",
    );
    expect(await check()).toHaveNoViolations();
  });

  it("erstellt Erinnerungen für die gewählten Rechnungen", async () => {
    const service = createMemoryBuchhaltungService({ invoices });
    const issue = vi.spyOn(service, "issueReminder");
    renderService(<OffenePostenPage />, service);
    await screen.findByRole("table", { name: "Offene Posten" });
    const rows = screen.getAllByRole("checkbox", { name: "Zeile auswählen" });
    await userEvent.click(rows[0]!);
    await userEvent.click(rows[1]!);
    expect(screen.getByText("2 ausgewählt")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "2 Erinnerungen erstellen" }));
    await waitFor(() => expect(issue).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Erinnerungen erstellt.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("2 ausgewählt")).not.toBeInTheDocument());
  });

  it("filtert überfällige Posten", async () => {
    renderPage(<OffenePostenPage />, { invoices });
    await screen.findByRole("table", { name: "Offene Posten" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Fällig" }), "notdue");
    expect(screen.getByText("1 von 1")).toBeInTheDocument();
    expect(screen.getByText("R-2099-0003")).toBeInTheDocument();
  });
});

const rest: CamtPayment[] = [
  {
    id: "p1",
    status: "REST",
    restReason: "NO_REFERENCE",
    bookingDate: "2026-10-28",
    amountRappen: 84_600,
    currency: "CHF",
    direction: "CREDIT",
    reversal: false,
    debtorName: "Beispiel Bäckerei GmbH",
    debtorIban: "CH00 0000 0000 0000 0000 0",
    remittanceInfo: "Beitrag Herbst, ohne QR-Referenz",
  },
  {
    id: "p2",
    status: "REST",
    restReason: "AMOUNT_MISMATCH",
    openItemId: "i1",
    bookingDate: "2026-10-27",
    amountRappen: 10_000,
    currency: "CHF",
    direction: "CREDIT",
    reversal: false,
    debtorName: "Lukas Probe",
  },
];

describe("Zahlungszuordnung (5.5, 5.6)", () => {
  it("zeigt die Zähler der Ansichten und den Leerzustand ohne Import", async () => {
    renderPage(<ZuordnungPage />, { invoices, rest });
    expect(await screen.findByRole("tab", { name: "Manuell zuordnen (2)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Automatisch zugeordnet (0)" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Keine Einträge.")).toBeInTheDocument();
    expect(await check()).toHaveNoViolations();
  });

  it("ordnet einen Restposten von Hand zu: Passung, Teilzahlung, Buchung", async () => {
    const service = createMemoryBuchhaltungService({ invoices, rest });
    const assign = vi.spyOn(service, "assignRest");
    renderService(<ZuordnungPage />, service, { view: "manual" });
    expect(
      await screen.findByText("Zahlung 28.10.2026 · Beispiel Bäckerei GmbH"),
    ).toBeInTheDocument();
    expect(await screen.findByText("Name stimmt")).toBeInTheDocument();
    expect(screen.getByText("Name abweichend", { selector: ".badge" })).toBeInTheDocument();
    // Vorauswahl: die Rechnung mit passendem Namen. Rest = CHF 1'630.45 - CHF 846.00.
    expect(await screen.findByText("Rest offen: CHF 784.45")).toBeInTheDocument();
    expect(screen.getByText("Teilzahlung.")).toBeInTheDocument();
    expect(screen.queryByText("Rest manuell.")).not.toBeInTheDocument();
    expect(screen.getByText("2 offen")).toBeInTheDocument();
    expect(await check()).toHaveNoViolations();

    await userEvent.click(screen.getByRole("button", { name: "Zahlung zuordnen und buchen" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("p1", "i2"));
    expect(await screen.findByText("Zahlung zugeordnet und gebucht.")).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: "Manuell zuordnen (1)" })).toBeInTheDocument();
  });

  it("wählt bei abweichendem Betrag den Vorschlag der Bank vor", async () => {
    renderPage(<ZuordnungPage />, { invoices, rest }, { view: "manual", payment: "p2" });
    expect(await screen.findByText("Zahlung 27.10.2026 · Lukas Probe")).toBeInTheDocument();
    expect(await screen.findByText("Rest offen: CHF 450.00")).toBeInTheDocument();
  });

  it("stellt eine Zahlung zurück, markiert sie, stellt sie ans Ende und nimmt sie wieder auf", async () => {
    const service = createMemoryBuchhaltungService({ invoices, rest });
    const postpone = vi.spyOn(service, "postponePayment");
    renderService(<ZuordnungPage />, service, { view: "manual", payment: "p1" });
    await userEvent.click(await screen.findByRole("button", { name: "Zahlung zurückstellen" }));
    await waitFor(() => expect(postpone).toHaveBeenCalledWith("p1", true));
    expect(await screen.findByText("Zahlung zurückgestellt.")).toBeInTheDocument();
    // Zurückgestellte Zahlungen stehen am Ende; die erste Zeile ist jetzt die andere Zahlung.
    const table = screen.getByRole("table", { name: "Nicht zugeordnete Zahlungen" });
    await waitFor(() => expect(within(table).getByText("Zurückgestellt")).toBeInTheDocument());
    const rows = within(table).getAllByRole("row");
    expect(rows[rows.length - 1]).toHaveTextContent("Zurückgestellt");

    await userEvent.click(within(table).getByRole("button", { name: /Zahlung 28\.10\.2026/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Zahlung wieder aufnehmen" }));
    await waitFor(() => expect(postpone).toHaveBeenCalledWith("p1", false));
    expect(await screen.findByText("Zahlung wieder aufgenommen.")).toBeInTheDocument();
    await waitFor(() =>
      expect(within(table).queryByText("Zurückgestellt")).not.toBeInTheDocument(),
    );
  });

  it("zeigt die Importe der API samt Nachrichtenkennung, wenn der Dateiname unbekannt ist", async () => {
    renderPage(
      <ZuordnungPage />,
      {
        imports: [
          {
            importId: "imp9",
            kind: "camt.053",
            messageId: "MSG-2026-09",
            importedAt: Date.parse("2026-09-30T12:00:00Z"),
            importedBy: "Erika Muster",
            counts: { total: 7, matched: 5, rest: 2, duplicates: 0, ignored: 0 },
          },
        ],
      },
      { view: "imports" },
    );
    expect(await screen.findByRole("tab", { name: "Importe (1)" })).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "Importe" });
    expect(within(table).getByText("MSG-2026-09")).toBeInTheDocument();
    expect(within(table).getByText("7")).toBeInTheDocument();
  });
});

const camt = (kind: "053" | "054") =>
  `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.${kind}.001.08"><BkToCstmrStmt><Stmt><Acct><Id><IBAN>CH9300762011623852957</IBAN></Id></Acct><FrToDt><FrDtTm>2026-10-01T00:00:00</FrDtTm><ToDtTm>2026-10-31T23:59:59</ToDtTm></FrToDt><Ntry><NtryDtls><TxDtls/><TxDtls/><TxDtls/></NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>`;

const importResult = {
  importId: "imp1",
  kind: "camt.053" as const,
  checksum: "",
  counts: { total: 3, matched: 2, rest: 1, duplicates: 0, ignored: 0 },
  matched: [
    {
      ...rest[1]!,
      id: "m1",
      status: "MATCHED" as const,
      restReason: undefined,
      openItemId: "i1",
      amountRappen: 55_000,
      debtorName: "Probe und Partner AG",
    },
    {
      ...rest[1]!,
      id: "m2",
      status: "MATCHED" as const,
      restReason: undefined,
      openItemId: "i2",
      amountRappen: 163_045,
      debtorName: "Beispiel Bäckerei GmbH",
    },
  ],
  rest: [rest[0]!],
};

describe("Zahlungsimport (5.7 bis 5.9)", () => {
  const file = (content: string, name = "camt.053_2026-10.xml") =>
    new File([content], name, { type: "text/xml" });

  it("prüft die Datei vor dem Import und führt durch Ergebnis und Restposten", async () => {
    const service = createMemoryBuchhaltungService({ invoices, rest, importResult });
    renderService(<ImportPage />, service);
    expect(screen.getByRole("button", { name: "Zahlungen importieren" })).toBeDisabled();
    expect(screen.getByText("Datei hierher ziehen oder auswählen")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Schritte" })).toBeInTheDocument();

    await userEvent.upload(screen.getByLabelText("Datei auswählen"), file(camt("053")));
    expect(await screen.findByText("Gültiges CAMT.053 erkannt.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "3 Zahlungen im Zeitraum 01.10.2026 bis 31.10.2026, Konto CH9300762011623852957.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("camt.053_2026-10.xml")).toBeInTheDocument();
    expect(await check()).toHaveNoViolations();

    await userEvent.click(screen.getByRole("button", { name: "Zahlungen importieren" }));
    expect(
      await screen.findByRole("heading", { name: "Zahlungsimport: Ergebnis" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Import abgeschlossen.")).toBeInTheDocument();
    expect(screen.getByText(/2 von 3 Zahlungen \(CHF 2'180.45\) wurden/)).toBeInTheDocument();
    expect(
      screen.getByText("1 Zahlung (CHF 846.00) konnte nicht zugeordnet werden."),
    ).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Ergebnis des Imports" });
    expect(within(table).getByText("Restposten")).toBeInTheDocument();
    expect(await within(table).findByText("R-2020-0001")).toBeInTheDocument();
    expect(await check()).toHaveNoViolations();

    await userEvent.click(screen.getByRole("button", { name: "Restposten zuordnen" }));
    expect(
      await screen.findByRole("heading", { name: "Zahlungsimport: Restposten" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Der Restposten ist noch nicht gebucht.")).toBeInTheDocument();
    expect(screen.getByText("Referenz fehlt", { selector: ".badge" })).toBeInTheDocument();
    expect(screen.getByText("3, davon 2 gebucht")).toBeInTheDocument();
    expect(await check()).toHaveNoViolations();

    await userEvent.click(screen.getByRole("button", { name: "Import abschliessen" }));
    expect(await screen.findByRole("heading", { name: "Zahlungsimport" })).toBeInTheDocument();
    expect(screen.getAllByText("camt.053_2026-10.xml").length).toBeGreaterThan(0);
  });

  it("weist Dateien ab, die kein CAMT sind, und falsch gewählte Typen", async () => {
    renderService(<ImportPage />, createMemoryBuchhaltungService({ importResult }));
    await userEvent.upload(screen.getByLabelText("Datei auswählen"), file("kein xml", "x.xml"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Datei nicht lesbar.");
    expect(screen.getByRole("button", { name: "Zahlungen importieren" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Datei x.xml entfernen" }));
    await userEvent.click(screen.getByRole("radio", { name: "CAMT.054 Zahlungsavis" }));
    await userEvent.upload(screen.getByLabelText("Datei auswählen"), file(camt("053")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Falscher Dateityp.");
    expect(screen.getByRole("button", { name: "Zahlungen importieren" })).toBeDisabled();
  });

  it("zeigt Fehler der API, etwa eine doppelte Datei", async () => {
    const service = createMemoryBuchhaltungService({});
    const { ApiError } = await import("./types");
    vi.spyOn(service, "importFile").mockRejectedValue(new ApiError(409, "DUPLICATE_FILE"));
    renderService(<ImportPage />, service);
    await userEvent.upload(screen.getByLabelText("Datei auswählen"), file(camt("053")));
    await userEvent.click(await screen.findByRole("button", { name: "Zahlungen importieren" }));
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((a) => a.textContent === "Diese Datei wurde bereits importiert."),
      ).toBe(true),
    );
  });
});

describe("Debitorenkonto (5.10)", () => {
  const ledger = {
    personId: "p-1",
    balance: 12_000,
    debit: 48_000,
    credit: 36_000,
    openItems: [{ id: "o1", reference: "R-2026-0412", dueDate: "2026-10-31", remaining: 12_000 }],
    lines: [
      {
        entryNumber: 101,
        bookingDate: "2026-01-15",
        description: "Rechnung R-2026-0118, Mitgliederbeitrag",
        side: "debit" as const,
        amount: 24_000,
        balanceAfter: 24_000,
      },
      {
        entryNumber: 215,
        bookingDate: "2026-02-02",
        description: "Zahlung R-2026-0118",
        side: "credit" as const,
        amount: 24_000,
        balanceAfter: 0,
      },
    ],
  };

  it("zeigt Kontoauszug mit Saldozeile, offenen Posten und der Person", async () => {
    renderPage(
      <DebitorPage />,
      {
        ledgers: { "p-1": ledger },
        people: {
          "p-1": {
            name: "Anna Beispiel",
            email: "anna.beispiel@example.ch",
            group: "Aktivmitglieder",
          },
        },
      },
      { personId: "p-1" },
    );
    expect(
      await screen.findByRole("heading", { name: "Debitorenkonto Anna Beispiel" }),
    ).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "Debitorenkonto" });
    expect(within(table).getByText("B-2026-0101")).toBeInTheDocument();
    expect(within(table).getByText(/^Saldo per \d{2}\.\d{2}\.\d{4}$/)).toBeInTheDocument();
    expect(within(table).getAllByText("CHF 120.00").length).toBeGreaterThan(0);
    expect(screen.getByRole("table", { name: "Offener Posten" })).toHaveTextContent("R-2026-0412");
    expect(await screen.findByText("anna.beispiel@example.ch")).toBeInTheDocument();
    expect(screen.queryByText("Nur Debitoren.")).not.toBeInTheDocument();
    expect(await check()).toHaveNoViolations();
  });

  it("meldet, wenn der Dienst keine Datei erzeugen kann, statt eine zu erfinden", async () => {
    renderPage(<DebitorPage />, { ledgers: { "p-1": ledger } }, { personId: "p-1" });
    await screen.findByRole("table", { name: "Debitorenkonto" });
    await userEvent.click(
      screen.getByRole("button", { name: "Kontoauszug als PDF herunterladen" }),
    );
    expect(await screen.findByText("Diese Funktion ist noch nicht verfügbar.")).toBeInTheDocument();
  });

  it("zeigt den Fehlerzustand, wenn das Konto nicht geladen werden kann", async () => {
    renderPage(<DebitorPage />, {}, { personId: "unbekannt" });
    expect(await screen.findByText(/konnte nicht geladen werden/)).toBeInTheDocument();
  });
});

describe("Übersicht", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T12:00:00"));
  });
  afterEach(() => vi.useRealTimers());

  it("zeigt Kennzahlen, letzte Buchungen und die Bereiche", async () => {
    renderPage(<HubPage />, { accounts: [...accounts], invoices, rest, entries });
    const bank = (await screen.findByText("CHF 92'003.20")).closest("section")!;
    expect(bank).toHaveTextContent("BankCHF 92'003.20Konto 1020");
    const open = screen.getByText("Offene Posten", { selector: "span" }).closest("section")!;
    expect(open).toHaveTextContent("CHF 3'430.453 Posten");
    const overdue = screen.getByText("Überfällig").closest("section")!;
    expect(overdue).toHaveTextContent("CHF 2'180.452 Posten");
    const unmatched = screen.getByText("Nicht zugeordnete Zahlungen").closest("section")!;
    expect(unmatched).toHaveTextContent("CHF 946.002 Zahlungen");
    // Alle Kacheln teilen sich ein Raster, das nach der Anzahl keine Waise lässt (CSS: data-count).
    expect(unmatched.parentElement).toHaveAttribute(
      "data-count",
      String(unmatched.parentElement!.children.length),
    );

    const table = screen.getByRole("table", { name: "Letzte Buchungen" });
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("B-2026-1867");
    expect(within(table).getAllByRole("row")[2]).toHaveTextContent("B-2026-1861");
    for (const name of [
      "Kontenplan",
      "Buchungen",
      "Offene Posten",
      "Zahlungszuordnung",
      "Zahlungsimport",
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(await check()).toHaveNoViolations();
  });

  it("zeigt ohne Buchungen den Leerzustand", async () => {
    renderPage(<HubPage />, { accounts: [...accounts] });
    expect(await screen.findByText("Keine Buchungen im Geschäftsjahr 2026.")).toBeInTheDocument();
    expect(screen.getByText("Nicht zugeordnete Zahlungen").closest("section")).toHaveTextContent(
      "CHF 0.000 Zahlungen",
    );
  });

  it("zeigt die übrigen Kennzahlen, wenn eine Quelle ausfällt", async () => {
    const service = createMemoryBuchhaltungService({ accounts: [...accounts], invoices });
    vi.spyOn(service, "listRest").mockRejectedValue(new Error("aus"));
    renderService(<HubPage />, service);
    expect(await screen.findByText("CHF 3'430.45")).toBeInTheDocument();
    expect(screen.queryByText("Nicht zugeordnete Zahlungen")).not.toBeInTheDocument();
  });
});

describe("Neu laden beim Aktivieren des Tabs", () => {
  function Switcher() {
    const { openTab, activateTab } = useTabs();
    return (
      <>
        <button onClick={() => openTab(TAB.buchungen, { key: "zweiter" })}>Anderer Tab</button>
        <button onClick={() => activateTab("tab-1")}>Zurück</button>
      </>
    );
  }

  it("lädt die Liste erst nach dem Wechsel zurück in den Tab neu", async () => {
    const service = createMemoryBuchhaltungService({ accounts: [...accounts] });
    const list = vi.spyOn(service, "listAccounts");
    const current: CurrentTab = {
      id: "tab-1",
      params: {},
      setDirty: () => {},
      setTitle: () => {},
      setPage: () => {},
      registerSave: () => () => {},
      close: () => {},
    };
    renderWithProviders(
      <TabsProvider modules={[accountingModule]} initialType={TAB.kontenplan}>
        <CurrentTabContext.Provider value={current}>
          <BuchhaltungProvider service={service}>
            <KontenplanPage />
            <Switcher />
          </BuchhaltungProvider>
        </CurrentTabContext.Provider>
      </TabsProvider>,
    );
    await screen.findByRole("table", { name: "Kontenplan" });
    expect(list).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Anderer Tab" }));
    expect(list).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Zurück" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });
});

describe("HTTP-Dienst", () => {
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("sendet das CSRF-Token nur bei schreibenden Anfragen und meldet 401", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(reply({})));
    const onUnauthorized = vi.fn();
    const service = createHttpBuchhaltungService({
      csrfToken: () => "tok",
      onUnauthorized,
      fetchFn,
    });
    await service.listRest();
    await service.assignRest("p/1", "i1");
    const [read, write] = fetchFn.mock.calls;
    expect((read![1]!.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
    expect(write![0]).toBe("/camt/rest/p%2F1/zuordnen");
    expect((write![1]!.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok");

    fetchFn.mockResolvedValueOnce(reply({ error: { code: "UNAUTHENTICATED" } }, 401));
    await expect(service.listAccounts()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalled();
  });

  it("lädt die CAMT-Datei als Multipart ohne eigenen Content-Type hoch", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        reply({ importId: "i", kind: "camt.053", counts: {}, matched: [], rest: [] }),
      );
    const service = createHttpBuchhaltungService({
      csrfToken: () => "tok",
      onUnauthorized: () => {},
      fetchFn,
    });
    await service.importFile(new File(["<x/>"], "a.xml"), "abcd");
    const init = fetchFn.mock.calls[0]![1]!;
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("setzt und entfernt den Steuersatz eines Kontos per PATCH, mit CSRF-Token", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(reply({})));
    const service = createHttpBuchhaltungService({
      csrfToken: () => "tok",
      onUnauthorized: () => {},
      fetchFn,
    });
    await service.setAccountTaxRate("3200", 810);
    await service.setAccountTaxRate("3200", null);
    await service.createAccount({ code: "3210", name: "Werbung", type: "revenue", taxRateBp: 260 });
    const [set, clear, create] = fetchFn.mock.calls;
    expect(set![0]).toBe("/accounting/accounts/3200");
    expect(set![1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ taxRateBp: 810 }) });
    expect((set![1]!.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok");
    expect(clear![1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ taxRateBp: null }) });
    expect(create![1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ code: "3210", name: "Werbung", type: "revenue", taxRateBp: 260 }),
    });
  });

  it("benennt per PATCH um und stellt Zahlungen per POST zurück, mit CSRF-Token", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(reply({})));
    const service = createHttpBuchhaltungService({
      csrfToken: () => "tok",
      onUnauthorized: () => {},
      fetchFn,
    });
    await service.renameAccount("1100", "Neu");
    await service.postponePayment("p/1");
    await service.postponePayment("p/1", false);
    const [rename, postpone, resume] = fetchFn.mock.calls;
    expect(rename![0]).toBe("/accounting/accounts/1100");
    expect(rename![1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ name: "Neu" }) });
    expect((rename![1]!.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok");
    expect(postpone![0]).toBe("/camt/rest/p%2F1/zurueckstellen");
    expect(postpone![1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ postponed: true }),
    });
    expect(resume![1]).toMatchObject({ body: JSON.stringify({ postponed: false }) });
  });

  it("liest Importliste, Buchungszahl je Konto, Gesamtzahl und Namen der Erfasser", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = String(input);
      if (url.startsWith("/camt/imports")) {
        return Promise.resolve(
          reply({
            items: [
              {
                importId: "i1",
                kind: "camt.053",
                messageId: "MSG-1",
                importedAt: "2026-10-01T08:30:00.000Z",
                importedBy: "Erika Muster",
                counts: { total: 3, matched: 2, rest: 1, duplicates: 0, ignored: 0 },
              },
              {
                importId: "i2",
                kind: "camt.054",
                messageId: "MSG-2",
                importedAt: "2026-09-01T08:30:00.000Z",
                counts: {},
              },
            ],
            hasMore: false,
          }),
        );
      }
      if (url === "/accounting/accounts") {
        return Promise.resolve(
          reply([{ code: "1100", name: "Debitoren", type: "asset", active: true }]),
        );
      }
      if (url === "/accounting/trial-balance") {
        return Promise.resolve(
          reply({
            rows: [
              { code: "1100", debit: 100, credit: 40, balance: 60, entryCount: 7, taxRateBp: null },
              { code: "3200", debit: 0, credit: 5, balance: 5, entryCount: 1, taxRateBp: 810 },
            ],
          }),
        );
      }
      if (url.startsWith("/accounting/entries/count")) return Promise.resolve(reply({ total: 41 }));
      return Promise.resolve(
        reply([
          {
            id: "e",
            number: 1,
            bookingDate: "2026-01-01",
            kind: "manual",
            description: "x",
            lines: [],
            reversalOf: null,
            createdBy: "u",
            createdByName: "Erika Muster",
          },
        ]),
      );
    });
    const service = createHttpBuchhaltungService({
      csrfToken: () => null,
      onUnauthorized: () => {},
      fetchFn,
    });
    expect(await service.listImports()).toEqual([
      {
        importId: "i1",
        kind: "camt.053",
        messageId: "MSG-1",
        importedAt: Date.parse("2026-10-01T08:30:00.000Z"),
        importedBy: "Erika Muster",
        counts: { total: 3, matched: 2, rest: 1, duplicates: 0, ignored: 0 },
      },
      expect.objectContaining({ importId: "i2", importedBy: null }),
    ]);
    expect((await service.listAccounts())[0]).toMatchObject({ code: "1100", entryCount: 7 });
    // MwSt je Konto kommt aus der Saldenliste; `null` heisst ohne Steuer.
    expect((await service.listAccounts())[0]).not.toHaveProperty("taxRateBp");
    const page = await service.listEntries({ accountCode: "1100", limit: 10, offset: 0 });
    expect(page).toMatchObject({ total: 41, hasMore: false });
    expect(page.items[0]).toMatchObject({ createdByName: "Erika Muster" });
    const countCall = fetchFn.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/count"));
    expect(countCall).toBe("/accounting/entries/count?accountCode=1100");
  });

  describe("Dateien", () => {
    const file = (name: string) =>
      new Response("daten", {
        status: 200,
        headers: { "Content-Disposition": `attachment; filename="${name}"` },
      });

    function setup(fetchFn: typeof fetch) {
      const created = vi.fn(() => "blob:test");
      URL.createObjectURL = created;
      URL.revokeObjectURL = vi.fn();
      const names: string[] = [];
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        names.push(this.download);
      });
      const onUnauthorized = vi.fn();
      const service = createHttpBuchhaltungService({
        csrfToken: () => null,
        onUnauthorized,
        fetchFn,
      });
      return { service, created, click, names, onUnauthorized };
    }

    it("lädt Kontenplan, offene Posten und Kontoauszug herunter", async () => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(() => Promise.resolve(file("kontenplan.xlsx")))
        .mockImplementationOnce(() => Promise.resolve(file("open-items.xlsx")))
        .mockImplementationOnce(() => Promise.resolve(file("kontoauszug.pdf")));
      const { service, created, names } = setup(fetchFn);
      await service.exportXlsx("accounts");
      await service.exportXlsx("open-items");
      await service.downloadStatement("p/1");
      expect(fetchFn.mock.calls.map((c) => String(c[0]))).toEqual([
        "/accounting/export/accounts",
        expect.stringMatching(
          /^\/reports\/open-items\/export\?format=xlsx&asOf=\d{4}-\d{2}-\d{2}$/,
        ),
        "/accounting/persons/p%2F1/statement",
      ]);
      expect(created).toHaveBeenCalledTimes(3);
      expect(names).toEqual(["kontenplan.xlsx", "open-items.xlsx", "kontoauszug.pdf"]);
    });

    it("meldet Fehler als ApiError ohne Antworttext und 401 an die Sitzung", async () => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(() =>
          Promise.resolve(reply({ error: { code: "NOT_FOUND", message: "intern" } }, 404)),
        )
        .mockImplementationOnce(() => Promise.resolve(reply({}, 401)));
      const { service, created, onUnauthorized } = setup(fetchFn);
      await expect(service.downloadStatement("x")).rejects.toMatchObject({
        status: 404,
        code: "NOT_FOUND",
        message: "Anfrage fehlgeschlagen (404)",
      });
      await expect(service.exportXlsx("accounts")).rejects.toMatchObject({ status: 401 });
      expect(onUnauthorized).toHaveBeenCalledOnce();
      expect(created).not.toHaveBeenCalled();
    });
  });

  it("fordert eine Zeile mehr an, um die Folgeseite zu erkennen", async () => {
    const row = {
      id: "e",
      number: 1,
      bookingDate: "2026-01-01",
      kind: "manual",
      description: "x",
      lines: [],
      reversalOf: null,
      createdBy: "u",
    };
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(
          String(input).includes("/count")
            ? reply({ total: 3 })
            : reply([row, { ...row, id: "f" }, { ...row, id: "g" }]),
        ),
      );
    const service = createHttpBuchhaltungService({
      csrfToken: () => null,
      onUnauthorized: () => {},
      fetchFn,
    });
    const page = await service.listEntries({ limit: 2, offset: 0 });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.total).toBe(3);
    expect(fetchFn.mock.calls.map((c) => String(c[0])).some((u) => u.includes("limit=3"))).toBe(
      true,
    );
  });
});

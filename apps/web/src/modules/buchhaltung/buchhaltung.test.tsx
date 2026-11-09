import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { axe } from "vitest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentTabContext, TabsProvider, type CurrentTab } from "../../shell/tabs";
import { renderWithProviders } from "../../test-utils";
import { BuchungenPage } from "./BuchungenPage";
import { chf, pairLines, parseChDate, qrReference } from "./format";
import { createHttpBuchhaltungService } from "./httpService";
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
  it("zeigt Konten mit Salden, Details und den Hinweis zum Löschen", async () => {
    renderPage(<KontenplanPage />, { accounts: [...accounts] });
    const table = await screen.findByRole("table", { name: "Kontenplan" });
    expect(within(table).getByText("CHF −1'150.00")).toBeInTheDocument();
    expect(within(table).getByText("Erlösminderungen")).toBeInTheDocument();
    expect(screen.getByText("Konto 1020 · Bank")).toBeInTheDocument();
    expect(screen.getByText("Löschen nicht möglich.")).toBeInTheDocument();
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
    await userEvent.type(within(dialog).getByLabelText("Kontonummer (Pflicht)"), "3400");
    await userEvent.type(within(dialog).getByLabelText("Bezeichnung (Pflicht)"), "Mahngebühren");
    await userEvent.click(within(dialog).getByRole("button", { name: "Konto anlegen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Mahngebühren")).toBeInTheDocument();
  });

  it("meldet, wenn die API das Umbenennen nicht anbietet", async () => {
    renderPage(<KontenplanPage />, { accounts: [...accounts] });
    await screen.findByRole("table", { name: "Kontenplan" });
    await userEvent.click(screen.getByRole("button", { name: "Bezeichnung ändern" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Bezeichnung ändern" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Diese Funktion ist noch nicht verfügbar.",
    );
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

  it("zeigt Belegzeilen als Kontenpaare mit Typ und Hinweis «Nichts änderbar»", async () => {
    const service = createMemoryBuchhaltungService(seed());
    vi.spyOn(service, "listEntries").mockResolvedValue({ items: entries, hasMore: false });
    renderService(<BuchungenPage />, service, {});
    const table = await screen.findByRole("table", { name: "Buchungen" });
    expect(await within(table).findAllByText("B-2026-1861")).toHaveLength(2);
    expect(within(table).getByText("1/2")).toBeInTheDocument();
    expect(within(table).getByText("CHF 600.00")).toBeInTheDocument();
    expect(within(table).getByText("Zahlung")).toBeInTheDocument();
    expect(within(table).getByText("System")).toBeInTheDocument();
    expect(screen.getByText("Nichts änderbar.")).toBeInTheDocument();
    expect(screen.getByText("Nur anhängen")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gegenbuchung erfassen" })).toBeDisabled();
    expect(await check()).toHaveNoViolations();
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

    const date = within(dialog).getByLabelText("Buchungsdatum (Pflicht)");
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
      within(dialog).getByLabelText("Grund der Gegenbuchung (Pflicht)"),
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
    await userEvent.type(
      within(dialog).getByLabelText("Grund der Gegenbuchung (Pflicht)"),
      "Irrtum",
    );
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
    expect(sums).toHaveTextContent("CHF 3'430.45 (3 Posten)");
    expect(screen.getByText("davon überfällig:").parentElement).toHaveTextContent(
      "CHF 2'180.45 (2 Posten)",
    );
    expect(screen.getByText("mit Mahnstufe:").parentElement).toHaveTextContent(
      "CHF 550.00 (1 Posten)",
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
    expect(screen.getByText("Rest manuell.")).toBeInTheDocument();
    expect(screen.getByText("2 offen")).toBeInTheDocument();
    expect(await check()).toHaveNoViolations();

    await userEvent.click(screen.getByRole("button", { name: "Zahlung zuordnen und buchen" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("p1", "i2"));
    expect(await screen.findByText("Zahlung zugeordnet und gebucht.")).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: "Manuell zuordnen (1)" })).toBeInTheDocument();
  });

  it("wählt bei abweichendem Betrag den Vorschlag der Bank vor und meldet fehlende Funktionen", async () => {
    renderPage(<ZuordnungPage />, { invoices, rest }, { view: "manual", payment: "p2" });
    expect(await screen.findByText("Zahlung 27.10.2026 · Lukas Probe")).toBeInTheDocument();
    expect(await screen.findByText("Rest offen: CHF 450.00")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Zahlung zurückstellen" }));
    expect(await screen.findByText("Diese Funktion ist noch nicht verfügbar.")).toBeInTheDocument();
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
    expect(screen.getByText("Nur Debitoren.")).toBeInTheDocument();
    expect(await check()).toHaveNoViolations();
  });

  it("meldet fehlende Funktionen, statt Daten zu erfinden", async () => {
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

  it("verlangt für Entwurfsfunktionen ohne Route eine Meldung statt einer Anfrage", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const service = createHttpBuchhaltungService({
      csrfToken: () => null,
      onUnauthorized: () => {},
      fetchFn,
    });
    await expect(service.exportXlsx("accounts")).rejects.toThrow("Nicht verfügbar");
    await expect(service.renameAccount("1100", "x")).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
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
      .mockResolvedValue(reply([row, { ...row, id: "f" }, { ...row, id: "g" }]));
    const service = createHttpBuchhaltungService({
      csrfToken: () => null,
      onUnauthorized: () => {},
      fetchFn,
    });
    const page = await service.listEntries({ limit: 2, offset: 0 });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(String(fetchFn.mock.calls[0]![0])).toContain("limit=3");
  });
});

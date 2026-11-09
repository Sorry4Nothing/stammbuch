import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { describe, expect, it, vi } from "vitest";
import { TabBar } from "../../shell/TabBar";
import { TabPanels } from "../../shell/TabPanels";
import { TabsProvider } from "../../shell/tabs";
import { renderWithProviders } from "../../test-utils";
import { rechnungenModule } from "./index";
import { createHttpRechnungenService } from "./httpRechnungenService";
import { createMemoryRechnungenService } from "./memoryRechnungenService";
import { RechnungenServiceProvider, type RechnungenService } from "./service";

function setup<S extends RechnungenService = ReturnType<typeof createMemoryRechnungenService>>(
  service: S = createMemoryRechnungenService() as unknown as S,
  initial = "rechnungen",
) {
  const view = renderWithProviders(
    <RechnungenServiceProvider service={service}>
      <TabsProvider modules={[rechnungenModule]} initialType={initial}>
        <TabBar />
        <TabPanels />
      </TabsProvider>
    </RechnungenServiceProvider>,
  );
  return { ...view, service, user: userEvent.setup() };
}

/** Öffnet eine Rechnung der Liste im Tab «Offen». */
async function openInvoice(user: ReturnType<typeof userEvent.setup>, number: string) {
  await user.click(await screen.findByRole("button", { name: `Rechnung ${number} öffnen` }));
  return screen.findByRole("heading", { level: 1, name: `Rechnung ${number}` });
}

describe("Rechnungsliste (4.1)", () => {
  it("zeigt die Statusfilter mit Zahlen und die offenen Rechnungen nach Fälligkeit", async () => {
    setup();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Rechnungen" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: "Offen (11)" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Alle (14)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Entwurf (1)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Überfällig (9)" })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Offene Rechnungen" });
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]!).getByText("R-2026-0344")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("(63 Tage)")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("CHF 550.00")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("3 · 2. Mahnung")).toBeInTheDocument();
    expect(screen.getByText("11 von 14")).toBeInTheDocument();
  });

  it("filtert nach Tab und Suche und zeigt aktive Filter", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("tab", { name: "Entwurf (1)" }));
    expect(screen.getByRole("table", { name: "Entwürfe" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Offen (11)" }));
    await user.type(
      screen.getByRole("textbox", { name: "Nr., Name oder Referenz suchen" }),
      "Vorlage",
    );
    expect(screen.getByText("1 von 14")).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Nr., Name oder Referenz suchen" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Mahnstufe" }), "1");
    expect(screen.getByText("Aktive Filter")).toBeInTheDocument();
    expect(screen.getAllByText("Mahnstufe: 1 · Zahlungserinnerung")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Alle zurücksetzen" }));
    expect(screen.queryByText("Aktive Filter")).not.toBeInTheDocument();
  });

  it("zeigt bei Auswahl die Sammelaktionen", async () => {
    const { user } = setup();
    await screen.findByRole("table", { name: "Offene Rechnungen" });
    const boxes = screen.getAllByRole("checkbox", { name: "Zeile auswählen" });
    await user.click(boxes[1]!);
    await user.click(boxes[2]!);
    const bar = screen.getByText("2 ausgewählt").closest("[role=status]") as HTMLElement;
    expect(within(bar).getByText("2 ausgewählt")).toBeInTheDocument();
    await user.click(within(bar).getByRole("button", { name: "Auswahl aufheben" }));
    expect(screen.queryByText("2 ausgewählt")).not.toBeInTheDocument();
  });

  it("meldet nicht angebundene Funktionen ehrlich", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Als .xlsx exportieren" }));
    expect(await screen.findByText("Noch nicht verfügbar")).toBeInTheDocument();
  });

  it("öffnet die Rechnung in einem Tab und ist barrierefrei", async () => {
    const { user, container } = setup();
    await screen.findByRole("table", { name: "Offene Rechnungen" });
    expect(await axe(container)).toHaveNoViolations();
    await openInvoice(user, "R-2026-0366");
    expect(screen.getByRole("tab", { name: /Rechnung R-2026-0366/ })).toBeInTheDocument();
  });
});

describe("Rechnungsdetail (4.12, 4.7, 4.8)", () => {
  it("zeigt Zahlung und Verlauf einer gemahnten Rechnung", async () => {
    const { user } = setup();
    await openInvoice(user, "R-2026-0366");
    expect(await screen.findByText("28 Tagen")).toBeInTheDocument();
    expect(screen.getAllByText("1 · Zahlungserinnerung").length).toBeGreaterThan(0);
    expect(screen.getByText("28 Tagen")).toBeInTheDocument();
    expect(screen.getByText("Total inkl. MwSt")).toBeInTheDocument();
    const history = screen.getByRole("list", { name: "Verlauf" });
    expect(within(history).getByText("Entwurf erstellt")).toBeInTheDocument();
    expect(within(history).getByText(/ist fällig \(28 Tage über Fälligkeit\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1. Mahnung erzeugen" })).toBeInTheDocument();
  });

  it("storniert nach Rückfrage", async () => {
    const { user, service } = setup();
    await openInvoice(user, "R-2026-0424");
    await user.click(await screen.findByRole("button", { name: "Rechnung stornieren" }));
    const dialog = await screen.findByRole("dialog", { name: "Rechnung R-2026-0424 stornieren?" });
    expect(within(dialog).getByText("Offen, noch nicht bezahlt")).toBeInTheDocument();
    expect(within(dialog).getByText(/Gegenbuchung über CHF 648.60/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Abbrechen" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Rechnung stornieren" }));
    expect(await screen.findByText("Rechnung storniert.")).toBeInTheDocument();
    expect(service.state.invoices.find((i) => i.number === "R-2026-0424")?.status).toBe(
      "cancelled",
    );
  });

  it("schreibt gut und zeigt den neuen offenen Betrag", async () => {
    const { user, service } = setup();
    await openInvoice(user, "R-2026-0421");
    await user.click(await screen.findByRole("button", { name: "Gutschrift erstellen" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Gutschrift zu Rechnung R-2026-0421 erstellen?",
    });
    await user.type(within(dialog).getByLabelText(/Gutschriftsbetrag in CHF/), "250.00");
    expect(within(dialog).getByText("Neuer offener Betrag: CHF 1'000.00.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Gutschrift erstellen" }));
    expect(await within(dialog).findByText("Bitte geben Sie einen Grund an.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Grund/), "Beitrag anteilig erlassen");
    await user.click(within(dialog).getByRole("button", { name: "Gutschrift erstellen" }));
    expect(await screen.findByText("Gutschrift erstellt.")).toBeInTheDocument();
    expect(service.state.invoices.find((i) => i.number === "R-2026-0421")?.openCents).toBe(100000);
  });

  it("verlangt einen Betrag innerhalb des Rechnungsbetrags", async () => {
    const { user } = setup();
    await openInvoice(user, "R-2026-0421");
    await user.click(await screen.findByRole("button", { name: "Gutschrift erstellen" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Gutschriftsbetrag in CHF/), "9999.00");
    await user.type(within(dialog).getByLabelText(/Grund/), "x");
    await user.click(within(dialog).getByRole("button", { name: "Gutschrift erstellen" }));
    expect(
      await within(dialog).findByText(/Bitte geben Sie einen Betrag bis höchstens CHF 1'250.00 an/),
    ).toBeInTheDocument();
  });
});

describe("Entwurf, Papier und Versand (4.2, 4.3, 4.4)", () => {
  it("legt eine Rechnung an, markiert den Tab und speichert den Entwurf", async () => {
    const { user, service } = setup();
    await user.click(await screen.findByRole("button", { name: "Rechnung erstellen" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Rechnung erstellen" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Als Entwurf speichern" }));
    expect(await screen.findByText("Bitte wählen Sie einen Empfänger.")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: /Empfänger/ }));
    await user.click(await screen.findByRole("option", { name: "Beispiel Treuhand AG" }));
    await user.type(screen.getByRole("textbox", { name: "Beschreibung Position 1" }), "Inserat");
    await user.clear(screen.getByRole("textbox", { name: "Menge Position 1" }));
    await user.type(screen.getByRole("textbox", { name: "Menge Position 1" }), "2");
    await user.type(screen.getByRole("textbox", { name: "Preis CHF Position 1" }), "250");
    expect(screen.getByText("Ungespeichert")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Ungespeichert/ })).toBeInTheDocument();
    expect(screen.getByText("Wird beim Versenden erzeugt")).toBeInTheDocument();
    const sum = screen.getByRole("region", { name: "Summe" });
    expect(within(sum).getByText("CHF 500.00")).toBeInTheDocument();
    expect(within(sum).getByText("MwSt 8.1 %")).toBeInTheDocument();
    expect(within(sum).getByText("CHF 540.50")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Als Entwurf speichern" }));
    expect(await screen.findByText("Entwurf gespeichert.")).toBeInTheDocument();
    expect(
      service.state.invoices.some((i) => i.subject === "" && i.lines[0]?.description === "Inserat"),
    ).toBe(true);
    await waitFor(() => expect(screen.queryByText("Ungespeichert")).not.toBeInTheDocument());
  });

  it("speichert und öffnet den Versanddialog", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Rechnung erstellen" }));
    await user.click(screen.getByRole("combobox", { name: /Empfänger/ }));
    await user.click(await screen.findByRole("option", { name: "Muster GmbH" }));
    await user.type(screen.getByRole("textbox", { name: "Beschreibung Position 1" }), "Inserat");
    await user.type(screen.getByRole("textbox", { name: "Preis CHF Position 1" }), "600");
    await user.click(screen.getByRole("button", { name: "Rechnung speichern und versenden" }));
    const dialog = await screen.findByRole("dialog", { name: "Rechnung versenden?" });
    expect(within(dialog).getByLabelText(/^An/)).toHaveValue("kasse@muster-gmbh.example.ch");
  });

  it("ist barrierefrei", async () => {
    const { user, container } = setup();
    await user.click(await screen.findByRole("button", { name: "Rechnung erstellen" }));
    await screen.findByRole("heading", { level: 1, name: "Rechnung erstellen" });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("zeigt den Entwurf als Papier mit Zahlteil und versendet ihn", async () => {
    const { user, service } = setup();
    await user.click(await screen.findByRole("tab", { name: "Entwurf (1)" }));
    expect(await openInvoice(user, "Entwurf")).toBeInTheDocument();
    expect(screen.getByText("Noch keine Buchung.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Papier ansehen" }));
    const paper = await screen.findByRole("article", { name: "Papieransicht Entwurf" });
    expect(within(paper).getByText("Empfangsschein")).toBeInTheDocument();
    expect(within(paper).getByText("Zahlteil")).toBeInTheDocument();
    expect(within(paper).getByText("Annahmestelle")).toBeInTheDocument();
    expect(within(paper).getByText("Zwischentotal")).toBeInTheDocument();
    expect(screen.getByText("Vorschau des Entwurfs.")).toBeInTheDocument();
    expect(await axe(paper)).toHaveNoViolations();

    await user.click(screen.getByRole("button", { name: "Rechnung versenden" }));
    const dialog = await screen.findByRole("dialog", { name: "Rechnung versenden?" });
    expect(within(dialog).getByRole("radio", { name: "Per E-Mail versenden" })).toBeChecked();
    expect(within(dialog).getByText("Nach dem Versand nicht mehr änderbar.")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText(/^An/));
    await user.click(within(dialog).getByRole("button", { name: "Rechnung versenden" }));
    expect(
      await within(dialog).findByText("Bitte geben Sie eine gültige E-Mail-Adresse an."),
    ).toBeInTheDocument();
    await user.type(
      within(dialog).getByLabelText(/^An/),
      "buchhaltung@beispiel-treuhand.example.ch",
    );
    await user.click(within(dialog).getByRole("button", { name: "Rechnung versenden" }));
    expect(await screen.findByText("Rechnung versendet.")).toBeInTheDocument();
    expect(service.state.sent).toEqual(["email:buchhaltung@beispiel-treuhand.example.ch"]);
  });

  it("meldet ehrlich, wenn nur gebucht und nicht gemailt wurde", async () => {
    const memory = createMemoryRechnungenService();
    const service: RechnungenService = {
      ...memory,
      sendInvoice: async (id, o) => ({ ...(await memory.sendInvoice(id, o)), delivered: false }),
    };
    const { user } = setup(service);
    await user.click(await screen.findByRole("tab", { name: "Entwurf (1)" }));
    await user.click(await screen.findByRole("button", { name: /Rechnung .* öffnen/ }));
    await user.click(await screen.findByRole("button", { name: "Rechnung versenden" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Rechnung versenden" }),
    );
    expect(
      await screen.findByText("Rechnung gebucht, E-Mail nicht versendet."),
    ).toBeInTheDocument();
  });
});

describe("Mahnwesen (4.5, 4.6)", () => {
  it("zeigt die Übersicht nach Mahnstufe und erzeugt Mahnungen", async () => {
    const { user, service } = setup(createMemoryRechnungenService(), "mahnwesen");
    expect(await screen.findByRole("heading", { level: 1, name: "Mahnwesen" })).toBeInTheDocument();
    expect(screen.getByText("Stand 02.11.2026")).toBeInTheDocument();
    const stages = screen.getByRole("table", { name: "Überfällige Rechnungen nach Mahnstufe" });
    expect(
      within(stages).getByText("Zahlungserinnerung ab Tag 10, Gebühr CHF 0.00"),
    ).toBeInTheDocument();
    expect(within(stages).getByText("1. Mahnung ab Tag 20, Gebühr CHF 10.00")).toBeInTheDocument();
    expect(within(stages).getByText("Total überfällig")).toBeInTheDocument();
    expect(screen.getByText("9 von 9 überfälligen Rechnungen")).toBeInTheDocument();

    const table = screen.getByRole("table", { name: "Überfällige Rechnungen" });
    expect(within(table).getAllByText("Jetzt fällig")).toHaveLength(4);
    const row = (n: string) => within(table).getByText(n).closest("tr")!;
    await user.click(within(row("R-2026-0352")).getByRole("checkbox"));
    await user.click(within(row("R-2026-0366")).getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "2 Mahnungen erzeugen" }));
    expect(await screen.findByText("2 Mahnungen erzeugt.")).toBeInTheDocument();
    expect(service.state.reminders.filter((r) => r.id.startsWith("rem-new"))).toHaveLength(2);
  });

  it("ist barrierefrei", async () => {
    const { container } = setup(createMemoryRechnungenService(), "mahnwesen");
    await screen.findByRole("heading", { level: 1, name: "Mahnwesen" });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("zeigt die Mahnung auf Papier mit Gebühr und erzeugt sie", async () => {
    const { user, service } = setup();
    await openInvoice(user, "R-2026-0366");
    await user.click(await screen.findByRole("button", { name: "1. Mahnung erzeugen" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "1. Mahnung R-2026-0366" }),
    ).toBeInTheDocument();
    const paper = screen.getByRole("article", { name: "Papieransicht 1. Mahnung" });
    expect(within(paper).getByText("Mahngebühr 1. Mahnung")).toBeInTheDocument();
    expect(within(paper).getByText("CHF 390.00")).toBeInTheDocument();
    expect(
      within(paper).getByText(/Unsere Zahlungserinnerung vom 15.10.2026 blieb ohne Antwort./),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Als PDF speichern" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Mahnung versenden" }));
    expect(await screen.findByText("Mahnung erzeugt.")).toBeInTheDocument();
    expect(
      service.state.reminders.some((r) => r.invoiceId === "inv-R-2026-0366" && r.level === 2),
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Mahnung versenden" })).not.toBeInTheDocument();
  });
});

describe("Sammelrechnung (4.9, 4.10, 4.11)", () => {
  async function toPreview(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: "Weiter zur Vorschau" }));
    return screen.findByRole("heading", { level: 1, name: "Sammelrechnung: Vorschau" });
  }

  it("konfiguriert den Lauf und rechnet die Zusammenfassung", async () => {
    setup(createMemoryRechnungenService(), "sammelrechnung");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Sammelrechnung: Lauf konfigurieren" }),
    ).toBeInTheDocument();
    const summary = screen.getByRole("region", { name: "Zusammenfassung" });
    expect(within(summary).getByText("1'284")).toBeInTheDocument();
    expect(within(summary).getByText("1'158")).toBeInTheDocument();
    expect(within(summary).getByText("CHF 97'580.00")).toBeInTheDocument();
    expect(within(summary).getByText("126 Personen")).toBeInTheDocument();
    expect(
      await screen.findByRole("tab", { name: /Ungespeichert:.*Sammelrechnung 2027/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Schritte" })).toBeInTheDocument();
  });

  it("prüft das Datum vor der Vorschau", async () => {
    const { user } = setup(createMemoryRechnungenService(), "sammelrechnung");
    const date = await screen.findByLabelText(/Rechnungsdatum/);
    await user.clear(date);
    await user.type(date, "31.02.2026");
    await user.click(screen.getByRole("button", { name: "Weiter zur Vorschau" }));
    expect(await screen.findByText(/Bitte geben Sie ein gültiges Datum ein/)).toBeInTheDocument();
  });

  it("zeigt die Vorschau mit Prüfung und Seiten", async () => {
    const { user, container } = setup(createMemoryRechnungenService(), "sammelrechnung");
    await toPreview(user);
    expect(
      screen.getByText(/1'158 Rechnungen aus 5 Gruppen, Gesamtbetrag CHF 97'580.00./),
    ).toBeInTheDocument();
    expect(screen.getByText(/1'151 gehen per E-Mail./)).toBeInTheDocument();
    expect(screen.getByText(/7 Personen ohne E-Mail-Adresse./)).toBeInTheDocument();
    expect(screen.getByText("Seite 1 von 97")).toBeInTheDocument();
    expect(screen.getByText("12 von 1'158")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Vorschau der Rechnungen" });
    expect(within(table).getByText("Daniel Test")).toBeInTheDocument();
    expect(within(table).getByText("Keine E-Mail-Adresse")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole("button", { name: "Nächste Seite" }));
    expect(screen.getByText("Seite 2 von 97")).toBeInTheDocument();
  });

  it("verlangt die getippte Anzahl und erstellt den Lauf", async () => {
    const { user } = setup(createMemoryRechnungenService(), "sammelrechnung");
    await toPreview(user);
    await user.click(screen.getByRole("button", { name: "Weiter zur Bestätigung" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Sammelrechnung 2027 erstellen und 1'158 Rechnungen versenden?",
    });
    expect(within(dialog).getByText("1'151 per E-Mail, 7 zum Ausdrucken")).toBeInTheDocument();
    expect(within(dialog).getByText("Nicht rückgängig zu machen.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Zurück zur Vorschau" })).toHaveFocus();
    await user.type(within(dialog).getByLabelText(/Anzahl der Rechnungen zur Bestätigung/), "1157");
    await user.click(
      within(dialog).getByRole("button", { name: "1'158 Rechnungen erstellen und versenden" }),
    );
    expect(await within(dialog).findByText("Die Anzahl stimmt nicht überein.")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText(/Anzahl der Rechnungen zur Bestätigung/));
    await user.paste("1158");
    await user.click(
      within(dialog).getByRole("button", { name: "1'158 Rechnungen erstellen und versenden" }),
    );
    expect(await screen.findByText("1'158 Rechnungen erstellt.")).toBeInTheDocument();
  });
});

describe("Anbindung an die API", () => {
  const invoice = {
    id: "00000000-0000-4000-8000-000000000001",
    kind: "invoice",
    status: "draft",
    number: null,
    customerId: null,
    debtor: { name: "A", postalCode: "8000", town: "Z", country: "CH" },
    currency: "CHF",
    issueDate: "2026-11-02",
    dueDate: "2026-12-02",
    vatMode: "none",
    roundTo5: false,
    subject: "",
    notes: "",
    lines: [],
    totals: {
      netCents: 0,
      vatBuckets: [],
      vatCents: 0,
      grossCents: 0,
      roundingCents: 0,
      totalCents: 0,
    },
    reference: null,
    creditNoteOf: null,
    payments: [],
    sentAt: null,
    createdAt: "2026-11-02T10:00:00.000Z",
    version: 1,
    paidCents: 0,
    creditedCents: 0,
    openCents: 0,
  };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("lädt alle Seiten und schickt bei Schreibzugriffen das CSRF-Token", async () => {
    const calls: { url: string; method: string; csrf: string | null }[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, method: init?.method ?? "GET", csrf: headers.get("X-CSRF-Token") });
      if (url === "/auth/me") return json({ csrfToken: "tok" });
      if (url.startsWith("/invoices?kind=invoice&limit=200&offset=0"))
        return json({ items: [invoice], total: 201, limit: 200, offset: 0 });
      if (url.startsWith("/invoices?kind=invoice&limit=200&offset=200"))
        return json({ items: [{ ...invoice, id: "2" }], total: 201, limit: 200, offset: 200 });
      if (url.endsWith("/send"))
        return json({ ...invoice, status: "sent", number: "RE-2026-0001" });
      return json({ error: { code: "NOT_FOUND", message: "Beleg nicht gefunden." } }, 404);
    });
    const service = createHttpRechnungenService(fetchFn as unknown as typeof fetch);
    const rows = await service.listInvoices();
    expect(rows).toHaveLength(2);
    expect(calls.every((c) => c.csrf === null)).toBe(true);

    const sent = await service.sendInvoice(invoice.id, {
      mode: "email",
      to: "a@b.ch",
      subject: "s",
      message: "",
    });
    expect(sent.invoice.number).toBe("RE-2026-0001");
    expect(sent.delivered).toBe(false);
    expect(calls.at(-1)).toMatchObject({ method: "POST", csrf: "tok" });

    await expect(service.getInvoice("x")).rejects.toThrow("Beleg nicht gefunden.");
  });

  it("meldet für die Sammelrechnung eine fehlende Schnittstelle", async () => {
    const service = createHttpRechnungenService(vi.fn() as unknown as typeof fetch);
    await expect(service.collectiveSetup()).rejects.toThrow("Nicht angebunden");
  });
});

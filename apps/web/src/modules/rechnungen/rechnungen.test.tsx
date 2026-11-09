import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { describe, expect, it, vi } from "vitest";
import { TabBar } from "../../shell/TabBar";
import { TabPanels } from "../../shell/TabPanels";
import { TabsProvider } from "../../shell/tabs";
import { renderWithProviders } from "../../test-utils";
import { BulkResendDialog } from "./BulkResendDialog";
import { MODULE_IDS, type ModuleDefinition } from "../types";
import { rechnungenModule } from "./index";
import { createHttpRechnungenService } from "./httpRechnungenService";
import { createMemoryRechnungenService } from "./memoryRechnungenService";
import { NotSetUpError, RechnungenServiceProvider, type RechnungenService } from "./service";

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

describe("Rechnung erstellen ohne Einrichtung", () => {
  it("zeigt statt der Fehlerseite den Weg zu den Einstellungen", async () => {
    const service = createMemoryRechnungenService();
    service.getSettings = () => Promise.reject(new NotSetUpError());
    const settings: ModuleDefinition = {
      id: MODULE_IDS.settings,
      nav: { labelKey: "module.settings.nav", icon: "gear", order: 100, tabType: "settings" },
      titleKey: "module.settings.title",
      tabTypes: [
        {
          id: "settings",
          titleKey: "module.settings.title",
          component: () => <p>Einstellungen offen</p>,
        },
      ],
    };
    const view = renderWithProviders(
      <RechnungenServiceProvider service={service}>
        <TabsProvider modules={[rechnungenModule, settings]} initialType="rechnung-neu">
          <TabBar />
          <TabPanels />
        </TabsProvider>
      </RechnungenServiceProvider>,
    );
    expect(
      await screen.findByText("Zuerst Organisation und Bankverbindung erfassen"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Fehlernummer/)).not.toBeInTheDocument();
    expect(await axe(view.container)).toHaveNoViolations();
    await userEvent.click(screen.getByRole("button", { name: "Einstellungen öffnen" }));
    expect(await screen.findByText("Einstellungen offen")).toBeInTheDocument();
  });
});

describe("Rechnungsliste (4.1)", () => {
  it("lädt neu, wenn der Tab wieder aktiv wird", async () => {
    const service = createMemoryRechnungenService();
    const list = vi.spyOn(service, "listInvoices");
    const { user } = setup(service);
    await screen.findByRole("tab", { name: "Offen (11)" });
    expect(list).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Rechnung erstellen" }));
    await screen.findByRole("heading", { level: 1, name: "Rechnung erstellen" });
    expect(list).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("tab", { name: "Rechnungen" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

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
    expect(screen.getByText(/^11 Rechnungen, Summe/)).toBeInTheDocument();
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
    expect(screen.getByText(/^1 Rechnung, Summe/)).toBeInTheDocument();
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

  it("exportiert die gefilterte Liste und die Auswahl als Excel-Datei", async () => {
    const { user, service } = setup();
    await user.click(await screen.findByRole("button", { name: "Als Excel-Datei exportieren" }));
    expect(await screen.findByText("Rechnungsliste exportiert.")).toBeInTheDocument();
    expect(service.state.exported[0]).toHaveLength(11); // alle Rechnungen im Tab «Offen»

    const boxes = screen.getAllByRole("checkbox", { name: "Zeile auswählen" });
    await user.click(boxes[1]!);
    await user.click(boxes[2]!);
    await user.click(screen.getByRole("button", { name: "Auswahl als Excel-Datei exportieren" }));
    await waitFor(() => expect(service.state.exported).toHaveLength(2));
    expect(service.state.exported[1]).toHaveLength(2);
  });

  it("sendet markierte Rechnungen erneut und zeigt das Ergebnis je Rechnung", async () => {
    const { user, service } = setup();
    const table = await screen.findByRole("table", { name: "Offene Rechnungen" });
    const pick = (n: string) =>
      user.click(within(within(table).getByText(n).closest("tr")!).getByRole("checkbox"));
    await pick("R-2026-0366"); // Person mit E-Mail-Adresse
    await pick("R-2026-0344"); // ohne Adresse
    await user.click(screen.getByRole("button", { name: "Rechnungen erneut senden" }));
    const confirm = await screen.findByRole("dialog", {
      name: "2 Rechnungen erneut per E-Mail senden?",
    });
    expect(service.state.sent).toEqual([]); // erst nach der Bestätigung
    expect(await axe(confirm)).toHaveNoViolations();
    await user.click(within(confirm).getByRole("button", { name: "Jetzt senden" }));

    const result = await screen.findByRole("dialog", { name: "Ergebnis des Versands" });
    expect(
      within(result).getByText("1 gesendet, 1 übersprungen, 0 fehlgeschlagen."),
    ).toBeInTheDocument();
    const rows = within(within(result).getByRole("table", { name: "Ergebnis je Rechnung" }))
      .getAllByRole("row")
      .slice(1)
      .map((r) =>
        within(r)
          .getAllByRole("cell")
          .map((c) => c.textContent),
      );
    expect(rows).toEqual([
      ["R-2026-0344", "Übersprungen", "Keine E-Mail-Adresse hinterlegt"],
      ["R-2026-0366", "Gesendet", ""],
    ]);
    expect(service.state.sent).toEqual(["bulk:buchhaltung@demo-handels.example.ch"]);
    expect(await axe(result)).toHaveNoViolations();
    await user.click(within(result).getByRole("button", { name: "Schliessen" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("meldet Fehler der Sammelaktion ohne Ergebnis und erlaubt einen neuen Versuch", async () => {
    const memory = createMemoryRechnungenService();
    let calls = 0;
    const { user } = setup({
      ...memory,
      resendInvoices: (ids) =>
        ++calls === 1
          ? Promise.reject(new Error("Der E-Mail-Versand ist nicht eingerichtet."))
          : memory.resendInvoices(ids),
    });
    await screen.findByRole("table", { name: "Offene Rechnungen" });
    await user.click(screen.getAllByRole("checkbox", { name: "Zeile auswählen" })[1]!);
    await user.click(screen.getByRole("button", { name: "Rechnungen erneut senden" }));
    const dialog = await screen.findByRole("dialog", {
      name: "1 Rechnung erneut per E-Mail senden?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Jetzt senden" }));
    expect(
      await within(dialog).findByText("Der E-Mail-Versand ist nicht eingerichtet."),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Jetzt senden" }));
    expect(
      await screen.findByRole("dialog", { name: "Ergebnis des Versands" }),
    ).toBeInTheDocument();
  });

  it("lässt über 200 Rechnungen nicht zu", async () => {
    const memory = createMemoryRechnungenService();
    const send = vi.spyOn(memory, "resendInvoices");
    renderWithProviders(
      <RechnungenServiceProvider service={memory}>
        <BulkResendDialog
          ids={Array.from({ length: 201 }, (_, i) => `inv-${i}`)}
          onClose={() => undefined}
        />
      </RechnungenServiceProvider>,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "201 Rechnungen erneut per E-Mail senden?",
    });
    expect(within(dialog).getByText(/Höchstens 200 Rechnungen pro Versand/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Jetzt senden" })).toBeDisabled();
    expect(send).not.toHaveBeenCalled();
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

  it("benachrichtigt beim Storno den Kunden, wenn es gewählt ist", async () => {
    const { user, service } = setup();
    await openInvoice(user, "R-2026-0366");
    await user.click(await screen.findByRole("button", { name: "Rechnung stornieren" }));
    const dialog = await screen.findByRole("dialog", { name: "Rechnung R-2026-0366 stornieren?" });
    const box = within(dialog).getByRole("checkbox", {
      name: "Storno-Bestätigung per E-Mail an buchhaltung@demo-handels.example.ch senden",
    });
    expect(box).toBeChecked(); // vorgewählt, weil die Person eine Adresse hat
    await user.click(within(dialog).getByRole("button", { name: "Rechnung stornieren" }));
    expect(await screen.findByText("Rechnung storniert.")).toBeInTheDocument();
    expect(screen.getByText(/Gutschrift ist in der Versandwarteschlange/)).toBeInTheDocument();
    expect(service.state.sent).toEqual(["cancel:buchhaltung@demo-handels.example.ch"]);
  });

  it("storniert ohne Mail, wenn die Benachrichtigung abgewählt ist; ohne Adresse gibt es keine Wahl", async () => {
    const { user, service } = setup();
    await openInvoice(user, "R-2026-0366");
    await user.click(await screen.findByRole("button", { name: "Rechnung stornieren" }));
    const dialog = await screen.findByRole("dialog", { name: "Rechnung R-2026-0366 stornieren?" });
    await user.click(within(dialog).getByRole("checkbox", { name: /Storno-Bestätigung/ }));
    await user.click(within(dialog).getByRole("button", { name: "Rechnung stornieren" }));
    expect(await screen.findByText("Rechnung storniert.")).toBeInTheDocument();
    expect(service.state.sent).toEqual([]);
  });

  it("zeigt nach einem Mailfehler, dass das Storno besteht", async () => {
    const memory = createMemoryRechnungenService();
    const { user } = setup({
      ...memory,
      cancelInvoice: async (id, input) => ({
        ...(await memory.cancelInvoice(id, input)),
        notification: "failed" as const,
      }),
    });
    await openInvoice(user, "R-2026-0366");
    await user.click(await screen.findByRole("button", { name: "Rechnung stornieren" }));
    const dialog = await screen.findByRole("dialog", { name: "Rechnung R-2026-0366 stornieren?" });
    await user.click(within(dialog).getByRole("button", { name: "Rechnung stornieren" }));
    expect(await screen.findByText("Rechnung storniert.")).toBeInTheDocument();
    expect(screen.getByText(/Die Bestätigung konnte nicht gesendet werden/)).toBeInTheDocument();
  });

  it("zeigt die Mitgliedsnummer beim Empfänger und auf dem Papier", async () => {
    const { user } = setup();
    await openInvoice(user, "R-2026-0366");
    expect(await screen.findByText("Demo Handels AG (M-1048)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Papier ansehen" }));
    const paper = await screen.findByRole("article", { name: "Papieransicht R-2026-0366" });
    expect(within(paper).getByText(/Mitgliedsnummer M-1048 · Zahlbar bis/)).toBeInTheDocument();
  });

  it("lässt die Mitgliedsnummer weg, wenn die Rechnung keine hat", async () => {
    const { user } = setup();
    await openInvoice(user, "R-2026-0424");
    expect(await screen.findByText("Total inkl. MwSt")).toBeInTheDocument();
    expect(screen.queryByText(/\(M-\d+\)/)).not.toBeInTheDocument();
  });

  it("sendet die letzte Mahnung einer Rechnung per E-Mail nach Bestätigung", async () => {
    const { user, service } = setup();
    await openInvoice(user, "R-2026-0366");
    await user.click(await screen.findByRole("button", { name: "Mahnung per E-Mail senden" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Zahlungserinnerung zu Rechnung R-2026-0366 per E-Mail senden?",
    });
    expect(within(dialog).getByLabelText(/^An/)).toHaveValue("buchhaltung@demo-handels.example.ch");
    expect(within(dialog).getByLabelText(/^Betreff/)).toHaveValue(
      "Zahlungserinnerung zur Rechnung R-2026-0366",
    );
    const text = within(dialog).getByLabelText("Vorschau der Nachricht") as HTMLTextAreaElement;
    expect(text.value).toContain("Guten Tag");
    expect(text.value).toContain("Zur Rechnung R-2026-0366 vom 05.09.2026");
    expect(text.value).toContain("Verein Beispiel");
    expect(service.state.sent).toEqual([]); // erst nach der Bestätigung
    expect(await axe(dialog)).toHaveNoViolations();
    await user.click(within(dialog).getByRole("button", { name: "Jetzt senden" }));
    expect(
      await screen.findByText("Mahnung in die Versandwarteschlange gestellt."),
    ).toBeInTheDocument();
    expect(service.state.sent).toEqual(["reminder-1:buchhaltung@demo-handels.example.ch"]);
  });

  it("prüft die Adresse der Mahnung und zeigt Fehler des Versands ohne Interna", async () => {
    const memory = createMemoryRechnungenService();
    const { user } = setup({
      ...memory,
      emailReminder: () => Promise.reject(new Error("Prüfen Sie das Mailkonto.")),
    });
    await openInvoice(user, "R-2026-0366");
    await user.click(await screen.findByRole("button", { name: "Mahnung per E-Mail senden" }));
    const dialog = await screen.findByRole("dialog");
    await user.clear(within(dialog).getByLabelText(/^An/));
    await user.click(within(dialog).getByRole("button", { name: "Jetzt senden" }));
    expect(await within(dialog).findByText("Gültige E-Mail-Adresse eingeben.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/^An/), "kasse@example.test");
    await user.click(within(dialog).getByRole("button", { name: "Jetzt senden" }));
    expect(await within(dialog).findByText("Prüfen Sie das Mailkonto.")).toBeInTheDocument();
  });

  it("sendet eine gebuchte Rechnung erneut per E-Mail", async () => {
    const { user, service } = setup();
    await openInvoice(user, "R-2026-0366");
    await user.click(await screen.findByRole("button", { name: "Rechnung erneut senden" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Rechnung R-2026-0366 erneut senden?",
    });
    await user.clear(within(dialog).getByLabelText(/^An/));
    await user.click(within(dialog).getByRole("button", { name: "Erneut senden" }));
    expect(await within(dialog).findByText("Gültige E-Mail-Adresse eingeben.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/^An/), "kasse@beispiel.example.ch");
    await user.click(within(dialog).getByRole("button", { name: "Erneut senden" }));
    expect(await screen.findByText("Rechnung erneut versendet.")).toBeInTheDocument();
    expect(service.state.sent).toEqual(["resend:kasse@beispiel.example.ch"]);
  });

  it("zeigt die Buchungen der Rechnung", async () => {
    const { user } = setup();
    await openInvoice(user, "R-2026-0366");
    await user.click(await screen.findByRole("button", { name: "Buchungen ansehen" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Buchungen zu Rechnung R-2026-0366",
    });
    expect(
      await within(dialog).findByText(/Beleg \d+ · .* · Rechnung R-2026-0366/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("1100 Debitoren")).toBeInTheDocument();
    expect(await axe(dialog)).toHaveNoViolations();
  });

  it("meldet, wenn die Buchungen nicht geladen werden konnten", async () => {
    const memory = createMemoryRechnungenService();
    const { user } = setup({
      ...memory,
      bookings: () => Promise.reject(new Error("Beleg nicht gefunden.")),
    });
    await openInvoice(user, "R-2026-0366");
    await user.click(await screen.findByRole("button", { name: "Buchungen ansehen" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Buchungen zu Rechnung R-2026-0366",
    });
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
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
    expect(await within(dialog).findByText("Grund eingeben.")).toBeInTheDocument();
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
      await within(dialog).findByText(/Betrag bis höchstens CHF 1'250.00 eingeben/),
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
    expect(await screen.findByText("Empfänger wählen.")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: /Empfänger/ }));
    await user.click(await screen.findByRole("option", { name: "Beispiel Treuhand AG" }));
    await user.type(screen.getByRole("textbox", { name: "Beschreibung Position 1" }), "Inserat");
    await user.clear(screen.getByRole("textbox", { name: "Menge Position 1" }));
    await user.type(screen.getByRole("textbox", { name: "Menge Position 1" }), "2");
    await user.type(screen.getByRole("textbox", { name: "Preis CHF Position 1" }), "250");
    expect(screen.getByText("Ungespeichert")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Ungespeichert/ })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Beim Versenden")).toBeInTheDocument();
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
    expect(await axe(paper)).toHaveNoViolations();

    await user.click(screen.getByRole("button", { name: "Rechnung versenden" }));
    const dialog = await screen.findByRole("dialog", { name: "Rechnung versenden?" });
    expect(within(dialog).getByRole("radio", { name: "Per E-Mail versenden" })).toBeChecked();
    expect(within(dialog).getByText("Nach dem Versand nicht mehr änderbar.")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText(/^An/));
    await user.click(within(dialog).getByRole("button", { name: "Rechnung versenden" }));
    expect(await within(dialog).findByText("Gültige E-Mail-Adresse eingeben.")).toBeInTheDocument();
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

  it("speichert die Mahnstufen", async () => {
    const { user, service } = setup(createMemoryRechnungenService(), "mahnwesen");
    await user.click(await screen.findByRole("button", { name: "Mahnstufen einstellen" }));
    const dialog = await screen.findByRole("dialog", { name: "Mahnstufen einstellen" });
    const titles = within(dialog).getAllByLabelText(/Bezeichnung/);
    expect(titles).toHaveLength(3);
    await user.clear(titles[0]!);
    await user.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(
      await within(dialog).findAllByText(/Bezeichnung mit höchstens 60 Zeichen eingeben/),
    ).toHaveLength(1);
    expect(service.state.settings.dunning.levels[0]?.title).toBe("Zahlungserinnerung");

    await user.type(titles[0]!, "Erinnerung");
    const fee = within(dialog).getAllByLabelText(/Gebühr in CHF/)[1]!;
    await user.clear(fee);
    await user.type(fee, "15.00");
    expect(await axe(dialog)).toHaveNoViolations();
    await user.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(await screen.findByText("Mahnstufen gespeichert.")).toBeInTheDocument();
    expect(service.state.settings.dunning.levels.map((l) => [l.title, l.feeCents])).toEqual([
      ["Erinnerung", 0],
      ["1. Mahnung", 1500],
      ["2. Mahnung", 2000],
    ]);
  });

  it("prüft die Mahnstufen vor dem Speichern und entfernt die letzte Stufe", async () => {
    const { user, service } = setup(createMemoryRechnungenService(), "mahnwesen");
    await user.click(await screen.findByRole("button", { name: "Mahnstufen einstellen" }));
    const dialog = await screen.findByRole("dialog", { name: "Mahnstufen einstellen" });
    const grace = within(dialog).getAllByLabelText(/Zahlungsfrist in Tagen/)[0]!;
    await user.clear(grace);
    await user.type(grace, "0");
    await user.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(await within(dialog).findByText("1 bis 365 Tage eingeben.")).toBeInTheDocument();
    expect(service.state.settings.dunning.levels[0]?.graceDays).toBe(10);
    await user.click(within(dialog).getByRole("button", { name: "Stufe 3 entfernen" }));
    expect(within(dialog).getAllByLabelText(/Bezeichnung/)).toHaveLength(2);
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
    expect(
      within(paper).getByText(/Rechnung R-2026-0366 vom 05.09.2026 · Mitgliedsnummer M-1048/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Als PDF speichern" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Per E-Mail senden" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Mahnung versenden" }));
    expect(await screen.findByText("Mahnung erzeugt.")).toBeInTheDocument();
    // Erzeugt: jetzt lässt sich die Mahnung per E-Mail senden (nach Vorschau und Bestätigung)
    await user.click(screen.getByRole("button", { name: "Per E-Mail senden" }));
    const mailDialog = await screen.findByRole("dialog", {
      name: "1. Mahnung zu Rechnung R-2026-0366 per E-Mail senden?",
    });
    await user.click(within(mailDialog).getByRole("button", { name: "Jetzt senden" }));
    expect(
      await screen.findByText("Mahnung in die Versandwarteschlange gestellt."),
    ).toBeInTheDocument();
    expect(service.state.sent).toEqual(["reminder-2:buchhaltung@demo-handels.example.ch"]);
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

  it("speichert den Beitrag einer Gruppe und rechnet die Zusammenfassung neu", async () => {
    const { user, service } = setup(createMemoryRechnungenService(), "sammelrechnung");
    const fee = await screen.findByRole("textbox", { name: "Beitrag Jugend in CHF" });
    expect(fee).toHaveValue("40.00");
    await user.clear(fee);
    await user.type(fee, "50.00");
    await user.tab();
    const summary = screen.getByRole("region", { name: "Zusammenfassung" });
    expect(await within(summary).findByText("CHF 98'540.00")).toBeInTheDocument();
    expect(service.state.groups.find((g) => g.id === "g-jugend")?.feeCents).toBe(5000);

    await user.type(screen.getByRole("textbox", { name: "Beitrag Vorstand in CHF" }), "abc");
    await user.tab();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Beitrag von CHF 0.01 bis/);
    expect(service.state.groups.find((g) => g.id === "g-vorstand")?.feeCents).toBeNull();
  });

  it("prüft das Datum vor der Vorschau", async () => {
    const { user } = setup(createMemoryRechnungenService(), "sammelrechnung");
    const date = await screen.findByLabelText(/Rechnungsdatum/);
    await user.clear(date);
    await user.type(date, "31.02.2026");
    await user.click(screen.getByRole("button", { name: "Weiter zur Vorschau" }));
    expect(await screen.findByText(/Datum im Format TT.MM.JJJJ eingeben/)).toBeInTheDocument();
  });

  it("zeigt die Vorschau mit Prüfung und Seiten", async () => {
    const { user, container } = setup(createMemoryRechnungenService(), "sammelrechnung");
    await toPreview(user);
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

  /** Antworten je `METHODE Pfad`; alles andere ist 404. Hält die Aufrufe mit Body fest. */
  function api(routes: Record<string, () => Response>) {
    const calls: { key: string; body: unknown; csrf: string | null }[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${String(input)}`;
      calls.push({
        key,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        csrf: new Headers(init?.headers).get("X-CSRF-Token"),
      });
      if (String(input) === "/auth/me") return json({ csrfToken: "tok" });
      return (
        routes[key]?.() ?? json({ error: { code: "NOT_FOUND", message: "Nicht gefunden." } }, 404)
      );
    });
    return { calls, service: createHttpRechnungenService(fetchFn as unknown as typeof fetch) };
  }
  const ID = invoice.id;
  const mail = { to: "a@b.ch", subject: "Rechnung", message: "Guten Tag" };
  const booked = () => json({ ...invoice, status: "sent", number: "RE-1" });

  it("meldet fehlende Rechnungseinstellungen (404) als eigenen Fehler", async () => {
    const { service } = api({});
    await expect(service.getSettings()).rejects.toBeInstanceOf(NotSetUpError);
    const broken = createHttpRechnungenService((async () =>
      json({ error: { code: "INTERNAL" } }, 500)) as unknown as typeof fetch);
    await expect(broken.getSettings()).rejects.not.toBeInstanceOf(NotSetUpError);
  });

  it("bucht und mailt beim Versenden; scheitert nur die Mail, bleibt die Rechnung gebucht", async () => {
    const ok = api({
      [`POST /invoices/${ID}/send`]: booked,
      [`POST /invoices/${ID}/email`]: () => json({ queued: true }, 202),
    });
    const sent = await ok.service.sendInvoice(ID, { mode: "email", ...mail });
    expect(sent).toMatchObject({ delivered: true, invoice: { number: "RE-1" } });
    expect(ok.calls.find((c) => c.key.endsWith("/email"))).toMatchObject({
      body: mail,
      csrf: "tok",
    });

    const failing = api({
      [`POST /invoices/${ID}/send`]: booked,
      [`POST /invoices/${ID}/email`]: () =>
        json({ error: { code: "UNPROCESSABLE", message: "Nicht gesendet." } }, 422),
    });
    expect(await failing.service.sendInvoice(ID, { mode: "email", ...mail })).toMatchObject({
      delivered: false,
      invoice: { number: "RE-1" },
    });

    // «Nur PDF»: gebucht, keine Mail
    const pdf = api({ [`POST /invoices/${ID}/send`]: booked });
    await pdf.service.sendInvoice(ID, { mode: "pdf", ...mail });
    expect(pdf.calls.some((c) => c.key.endsWith("/email"))).toBe(false);
  });

  it("sendet erneut und gibt den Fehltext des Servers weiter", async () => {
    const { service, calls } = api({
      [`POST /invoices/${ID}/email`]: () =>
        json({ error: { code: "UNPROCESSABLE", message: "Prüfen Sie das Mailkonto." } }, 422),
    });
    await expect(service.resendInvoice(ID, mail)).rejects.toThrow("Prüfen Sie das Mailkonto.");
    expect(calls.at(-1)).toMatchObject({ key: `POST /invoices/${ID}/email`, body: mail });
  });

  it("storniert mit Grund und Bemerkung", async () => {
    const { service, calls } = api({
      [`POST /invoices/${ID}/cancel`]: () => json({ ...invoice, status: "cancelled" }),
    });
    const result = await service.cancelInvoice(ID, {
      reason: "Falscher Betrag",
      remark: "intern",
      notify: false,
    });
    expect(calls.at(-1)?.body).toEqual({
      reason: "Falscher Betrag",
      remark: "intern",
      notify: false,
    });
    expect(result).toMatchObject({ notification: "none", invoice: { status: "cancelled" } });
  });

  it("storniert mit Benachrichtigung und gibt deren Ausgang weiter", async () => {
    const { service, calls } = api({
      [`POST /invoices/${ID}/cancel`]: () =>
        json({ ...invoice, status: "cancelled", notification: "no-address" }),
    });
    const result = await service.cancelInvoice(ID, { reason: "x", remark: "", notify: true });
    expect(calls.at(-1)).toMatchObject({
      body: { reason: "x", remark: "", notify: true },
      csrf: "tok",
    });
    expect(result.notification).toBe("no-address");
    expect(result.invoice).not.toHaveProperty("notification");
  });

  it("sendet eine Mahnung per E-Mail an die Route der Stufe", async () => {
    const { service, calls } = api({
      [`POST /invoices/${ID}/reminders/2/email`]: () => json({ queued: true }, 202),
    });
    await service.emailReminder(ID, 2, mail);
    expect(calls.at(-1)).toMatchObject({ body: mail, csrf: "tok" });
    const failing = api({
      [`POST /invoices/${ID}/reminders/2/email`]: () =>
        json({ error: { code: "UNPROCESSABLE", message: "Prüfen Sie das Mailkonto." } }, 422),
    });
    await expect(failing.service.emailReminder(ID, 2, mail)).rejects.toThrow(
      "Prüfen Sie das Mailkonto.",
    );
  });

  it("sendet Rechnungen als Sammelaktion und gibt das Ergebnis je Rechnung zurück", async () => {
    const items = [
      { id: ID, number: "RE-1", outcome: "sent" },
      { id: "x", number: null, outcome: "failed", reason: "not-found" },
    ];
    const { service, calls } = api({ "POST /invoices/email-batch": () => json({ items }) });
    expect(await service.resendInvoices([ID, "x"])).toEqual(items);
    expect(calls.at(-1)).toMatchObject({ body: { ids: [ID, "x"] }, csrf: "tok" });
  });

  const collectiveConfig = {
    year: 2027,
    issueDate: "2026-12-01",
    termDays: 30,
    text: "Beitrag",
    delivery: "email" as const,
    skipLeft: true,
    skipNoFee: true,
    groupIds: ["g1"],
  };

  it("macht den Sammellauf paketweise mit derselben Lauf-ID und zählt frühere Versuche mit", async () => {
    const steps = [
      { created: 100, mailed: 99, notMailed: 1, skipped: 40, remaining: 160 },
      { created: 100, mailed: 100, notMailed: 0, skipped: 140, remaining: 60 },
      { created: 60, mailed: 60, notMailed: 0, skipped: 240, remaining: 0 },
    ];
    let n = 0;
    const { service, calls } = api({
      "GET /invoices/settings": () => json({ creditor: { name: "Musterverein" } }),
      "POST /invoices/collective/run": () => json(steps[n++], 201),
    });
    const progress: number[] = [];
    const result = await service.runCollective(collectiveConfig, {
      runId: "11111111-1111-4111-8111-111111111111",
      testMailTo: "ich@example.test",
      onProgress: (c) => progress.push(c),
    });
    // 40 früher angelegt, dazu 100, 100 und 60
    expect(result).toEqual({ created: 300, notMailed: 1 });
    expect(progress).toEqual([140, 240, 300]);
    const runs = calls.filter((c) => c.key === "POST /invoices/collective/run");
    expect(runs).toHaveLength(3);
    const bodies = runs.map((c) => c.body as { runId: string; testMailTo?: string });
    expect(new Set(bodies.map((b) => b.runId))).toEqual(
      new Set(["11111111-1111-4111-8111-111111111111"]),
    );
    expect(bodies.map((b) => b.testMailTo)).toEqual(["ich@example.test", undefined, undefined]);
  });

  it("meldet einen Abbruch mitten im Lauf mit der Zahl der erstellten Rechnungen", async () => {
    let n = 0;
    const { service } = api({
      "GET /invoices/settings": () => json({ creditor: { name: "Musterverein" } }),
      "POST /invoices/collective/run": () =>
        n++ === 1
          ? json({ error: { code: "UNPROCESSABLE", message: "Interner Text." } }, 500)
          : json({ created: 100, mailed: 100, notMailed: 0, skipped: 0, remaining: 50 }, 201),
    });
    const error: unknown = await service.runCollective(collectiveConfig, {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("100 Rechnungen sind bereits erstellt");
    expect(message).not.toContain("Interner Text");
  });

  it("gibt den Fehler der ersten Anfrage unverändert weiter (es ist nichts entstanden)", async () => {
    const { service } = api({
      "GET /invoices/settings": () => json({ creditor: { name: "Musterverein" } }),
      "POST /invoices/collective/run": () =>
        json({ error: { code: "UNPROCESSABLE", message: "Es gibt nichts zu verrechnen." } }, 422),
    });
    await expect(service.runCollective(collectiveConfig, {})).rejects.toThrow(
      "Es gibt nichts zu verrechnen.",
    );
  });

  it("lädt Buchungen, speichert Mahnstufen und Beitrag", async () => {
    const levels = [{ level: 1, title: "Erinnerung", waitDays: 5, graceDays: 7, feeCents: 0 }];
    const { service, calls } = api({
      [`GET /invoices/${ID}/bookings`]: () => json({ items: [{ id: "b1", number: 4 }] }),
      "PUT /invoices/settings/dunning": () => json({ dunning: { levels } }),
      "PUT /invoices/collective/groups/g1/fee": () => json({ id: "g1", feeCents: 5000 }),
    });
    expect(await service.bookings(ID)).toEqual([{ id: "b1", number: 4 }]);
    expect(await service.saveDunningLevels(levels)).toEqual(levels);
    expect(calls.at(-1)?.body).toEqual({ levels });
    await service.setGroupFee("g1", 5000);
    expect(calls.at(-1)).toMatchObject({ body: { feeCents: 5000 }, csrf: "tok" });
  });

  it("exportiert die Liste per POST und speichert die Datei", async () => {
    const created = vi.fn(() => "blob:x");
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      const { service, calls } = api({
        "POST /invoices/export": () =>
          new Response("PK", {
            status: 200,
            headers: { "Content-Disposition": 'attachment; filename="rechnungen.xlsx"' },
          }),
      });
      await service.exportInvoices([ID]);
      expect(calls.at(-1)).toMatchObject({ body: { ids: [ID] }, csrf: "tok" });
      expect(created).toHaveBeenCalled();
      expect(click).toHaveBeenCalled();
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("holt Gruppen und Vorschau und führt den Lauf mit der Mailvorlage aus", async () => {
    const config = {
      year: 2027,
      issueDate: "2026-12-01",
      termDays: 30,
      text: "Mitgliederbeitrag 2027",
      delivery: "email-or-print" as const,
      skipLeft: true,
      skipNoFee: true,
      groupIds: ["g1"],
    };
    const { service, calls } = api({
      "GET /invoices/collective/setup": () => json({ groups: [], defaults: {}, totalPersons: 0 }),
      "POST /invoices/collective/preview": () => json({ count: 1, noAddress: 2, rows: [] }),
      "GET /invoices/settings": () => json({ creditor: { name: "Musterverein" } }),
      "POST /invoices/collective/run": () =>
        json({ created: 3, mailed: 2, notMailed: 1, skipped: 0 }, 201),
    });
    expect(await service.collectiveSetup()).toMatchObject({ totalPersons: 0 });
    expect(await service.collectivePreview(config)).toMatchObject({ count: 1, noAddress: 2 });
    expect(calls.at(-1)?.body).toEqual(config);

    const result = await service.runCollective(config, { testMailTo: "ich@example.test" });
    expect(result).toEqual({ created: 3, notMailed: 1 });
    const run = calls.at(-1)?.body as {
      runId: string;
      testMailTo: string;
      mail: { subject: string; message: string };
    };
    expect(run.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.testMailTo).toBe("ich@example.test");
    expect(run.mail.subject).toBe("Rechnung {number} vom 01.12.2026");
    expect(run.mail.message).toContain("Rechnung {number} über {amount}, zahlbar bis 31.12.2026");
    expect(run.mail.message).toContain("Musterverein");
  });
});

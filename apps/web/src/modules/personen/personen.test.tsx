import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { axe } from "vitest-axe";
import { describe, expect, it, vi } from "vitest";
import { CurrentTabContext, TabsProvider, useTabs, type CurrentTab } from "../../shell/tabs";
import { renderWithProviders } from "../../test-utils";
import type { ModuleDefinition } from "../types";
import { TabPanels } from "../../shell/TabPanels";
import { DuplikatePage } from "./DuplikatePage";
import { FirmaDetailPage } from "./FirmaDetailPage";
import { FirmaFormPage } from "./FirmaFormPage";
import { FirmenregisterPage } from "./FirmenregisterPage";
import { FreigabenPage } from "./FreigabenPage";
import { GruppenPage } from "./GruppenPage";
import { ImportPage } from "./ImportPage";
import { personenModule } from "./index";
import { FieldErrors } from "./model";
import { createMemoryPersonenService, designSeed } from "./memoryPersonenService";
import { PersonDetailPage } from "./PersonDetailPage";
import { PersonFormPage } from "./PersonFormPage";
import { PersonenListPage, sortRows } from "./PersonenListPage";
import { PersonenProvider, type PersonenService } from "./service";
import { ZusammenfuehrenPage } from "./ZusammenfuehrenPage";

/** Zeigt die offenen Tabs, damit Tests prüfen können, was eine Aktion öffnet. */
function Probe() {
  const { tabs } = useTabs();
  return (
    <ul aria-label="Offene Tabs (Test)">
      {tabs.map((x) => (
        <li key={x.id} data-params={JSON.stringify(x.params)}>{`${x.type}:${x.title ?? ""}`}</li>
      ))}
    </ul>
  );
}

/** Platzhalter für ein anderes Modul: nur Kennung und Tab-Typen, die Personen öffnen können. */
const otherModule = (id: string, types: string[]): ModuleDefinition => ({
  id,
  titleKey: "module.mail.title",
  nav: { labelKey: "module.mail.nav", icon: "mail", order: 90, tabType: types[0]! },
  tabTypes: types.map((type) => ({
    id: type,
    titleKey: "module.mail.title",
    component: () => null,
  })),
});
const linkedModules = [
  otherModule("mail", ["mail", "mail-compose", "mail-list"]),
  otherModule("invoices", ["rechnungen", "rechnung-neu"]),
  otherModule("accounting", ["accounting", "accounting-debitor"]),
];

const paramsOf = (type: string) =>
  JSON.parse(
    screen.getByText(new RegExp(`^${type}:`)).getAttribute("data-params") ?? "{}",
  ) as Record<string, string>;

function setup(
  Page: ComponentType<{ tabId: string }>,
  params: Record<string, string> = {},
  service: PersonenService = createMemoryPersonenService(),
  others: ModuleDefinition[] = [],
) {
  const tab: CurrentTab = {
    id: "t1",
    params,
    setDirty: vi.fn(),
    setTitle: vi.fn(),
    setPage: vi.fn(),
    registerSave: vi.fn(() => () => {}),
    close: vi.fn(),
  };
  const view = renderWithProviders(
    <PersonenProvider service={service}>
      <TabsProvider modules={[personenModule, ...others]} initialType="personen">
        <CurrentTabContext.Provider value={tab}>
          <Page tabId="t1" />
        </CurrentTabContext.Provider>
        <Probe />
      </TabsProvider>
    </PersonenProvider>,
  );
  return { ...view, tab, service };
}

const noViolations = async (container: HTMLElement) =>
  expect(await axe(container)).toHaveNoViolations();

describe("Mitgliederliste (3.1)", () => {
  it("zeigt Titel, Tabelle, Anzahl und Sortierung", async () => {
    const { container } = setup(PersonenListPage);
    expect(screen.getByRole("heading", { name: "Personen" })).toBeInTheDocument();
    expect(await screen.findByText("Anna Beispiel")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Personen" });
    expect(within(table).getByText("M-1001")).toBeInTheDocument();
    expect(within(table).getAllByText("Aktiv").length).toBeGreaterThan(0);
    expect(screen.getByText("16 Personen")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await noViolations(container);
  });

  it("filtert nach Typ", async () => {
    setup(PersonenListPage);
    await screen.findByText("Anna Beispiel");
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Typ" }),
      "Typ: Firmenmitglied",
    );
    await waitFor(() => expect(screen.queryByText("Anna Beispiel")).not.toBeInTheDocument());
    expect(screen.getByText("Beispiel Treuhand AG")).toBeInTheDocument();
  });

  it("Auswahl zeigt Sammelaktionen und weist eine Gruppe zu", async () => {
    const { container } = setup(PersonenListPage);
    await screen.findByText("Beat Demo");
    const boxes = screen.getAllByRole("checkbox", { name: "Zeile auswählen" });
    await userEvent.click(boxes[1]!);
    await userEvent.click(boxes[2]!);
    expect(screen.getByRole("heading", { name: "2 ausgewählt" })).toBeInTheDocument();
    expect(screen.getByText("Gabi Beispiel und Maria Beispiel")).toBeInTheDocument();
    await noViolations(container);

    await userEvent.click(screen.getByRole("button", { name: "Gruppe zuweisen" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Die bisherige Gruppe wird ersetzt.")).toBeInTheDocument();
    await userEvent.selectOptions(within(dialog).getByLabelText("Gruppe"), "Jugend");
    await userEvent.click(within(dialog).getByRole("button", { name: "Gruppe zuweisen" }));
    expect(await screen.findByText("2 Personen zugewiesen.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "2 ausgewählt" })).not.toBeInTheDocument();
  });

  it("«Auswahl aufheben» leert die Auswahl; ohne die Module Mail und Rechnungen fehlen deren Schaltflächen", async () => {
    setup(PersonenListPage);
    await screen.findByText("Beat Demo");
    await userEvent.click(screen.getAllByRole("checkbox", { name: "Zeile auswählen" })[0]!);
    expect(screen.queryByRole("button", { name: "E-Mail schreiben" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Zu Adressliste hinzufügen" }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Auswahl aufheben" }));
    expect(screen.queryByRole("heading", { name: "1 ausgewählt" })).not.toBeInTheDocument();
  });

  it("«Person anlegen» öffnet das Formular in einem Tab", async () => {
    setup(PersonenListPage);
    await userEvent.click(screen.getByRole("button", { name: "Person anlegen" }));
    expect(screen.getByText(/^person-form:/)).toBeInTheDocument();
  });

  it("zeigt einen Fehlerzustand mit «Erneut laden»", async () => {
    const service = {
      ...createMemoryPersonenService(),
      listPersonen: vi.fn().mockRejectedValue(new Error("x")),
    };
    setup(PersonenListPage, {}, service);
    expect(await screen.findByText("Die Daten konnten nicht geladen werden")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Erneut laden" })).toBeInTheDocument();
  });
});

describe("Detail (3.2, 3.3)", () => {
  it("Einzelmitglied: Stammdaten, Kontakt, Gruppe, Konto und Rechnungen", async () => {
    const { container } = setup(PersonDetailPage, { id: "p-1001" });
    expect(await screen.findByRole("heading", { name: "Anna Beispiel" })).toBeInTheDocument();
    expect(screen.getByText("Personen / M-1001")).toBeInTheDocument();
    expect(screen.getByText("14.03.1985")).toBeInTheDocument();
    expect(screen.getByText("8000 Musterhausen")).toBeInTheDocument();
    expect(screen.getByText("seit 01.01.2019")).toBeInTheDocument();
    const konto = screen.getByRole("heading", { name: "Debitorenkonto" }).closest("section")!;
    expect(within(konto).getByText("CHF 120.00")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Letzte Rechnungen" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Rechnungen (4)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Mails (6)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Person bearbeiten" })).toHaveClass("btn--primary");
    await noViolations(container);
  });

  it("Firmenmitglied: Firma aus dem Register und Kontaktperson", async () => {
    setup(PersonDetailPage, { id: "p-1042" });
    expect(await screen.findByRole("heading", { name: /^Firma/ })).toBeInTheDocument();
    expect(await screen.findByText("CHE-123.456.789")).toBeInTheDocument();
    expect(screen.getByText("CHE-123.456.789 MWST")).toBeInTheDocument();
    expect(screen.getByText("Beat Muster")).toBeInTheDocument();
    expect(screen.getAllByText("CHF 1'250.00").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Firma im Register öffnen" }));
    expect(screen.getByText(/^firma:Beispiel Treuhand AG/)).toBeInTheDocument();
  });

  it("Gruppe ändern", async () => {
    const { service } = setup(PersonDetailPage, { id: "p-1001" });
    await screen.findByRole("heading", { name: "Anna Beispiel" });
    await userEvent.click(screen.getByRole("button", { name: "Gruppe ändern" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.selectOptions(within(dialog).getByLabelText("Gruppe"), "Vorstand");
    await userEvent.click(within(dialog).getByRole("button", { name: "Gruppe ändern" }));
    await waitFor(async () =>
      expect((await service.getPerson("p-1001")).gruppeName).toBe("Vorstand"),
    );
  });

  it("blendet Finanzen aus, wenn der Dienst sie nicht liefert", async () => {
    const base = createMemoryPersonenService();
    const service = {
      ...base,
      features: { ...base.features, finanzen: false, personExtras: false },
    };
    setup(PersonDetailPage, { id: "p-1001" }, service);
    await screen.findByRole("heading", { name: "Anna Beispiel" });
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByText("Debitorenkonto")).not.toBeInTheDocument();
    expect(screen.queryByText("Geburtsdatum")).not.toBeInTheDocument();
  });
});

describe("Person anlegen (3.4)", () => {
  async function fill(label: string, value: string) {
    const input = screen.getByLabelText(new RegExp(`^${label}`));
    await userEvent.clear(input);
    if (value) await userEvent.type(input, value);
  }

  it("zeigt Pflichtfelder, meldet Fehler wie im Board und markiert den Tab als ungespeichert", async () => {
    const { container, tab } = setup(PersonFormPage);
    expect(screen.getByRole("heading", { name: "Person anlegen" })).toBeInTheDocument();
    expect(screen.getByLabelText("Mitgliedsnr.")).toHaveValue("Wird beim Speichern vergeben");
    expect(screen.getByRole("group", { name: "Mitgliedsart" })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(/^Anrede/), "Herr");
    await fill("Vorname", "Daniel");
    await fill("Nachname", "Probe");
    await fill("Strasse und Nr.", "Testplatz 9");
    await fill("PLZ", "8003");
    await fill("Ort", "Musterhausen");
    await fill("Geburtsdatum", "22.7.90");
    await fill("E-Mail-Adresse", "daniel.probe@example");
    expect(screen.getByText("Ungespeichert")).toBeInTheDocument();
    expect(tab.setDirty).toHaveBeenLastCalledWith(true);

    await userEvent.click(screen.getByRole("button", { name: "Person speichern" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("2 Angaben prüfen.");
    expect(
      within(alert)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Geburtsdatum", "E-Mail-Adresse"]);
    expect(screen.getByText("Geben Sie das Datum als TT.MM.JJJJ ein.")).toBeInTheDocument();
    expect(
      screen.getByText("Geben Sie die Adresse vollständig ein, zum Beispiel name@example.ch."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^Geburtsdatum/)).toHaveAttribute("aria-invalid", "true");
    await noViolations(container);

    await userEvent.click(within(alert).getByRole("link", { name: "Geburtsdatum" }));
    expect(screen.getByLabelText(/^Geburtsdatum/)).toHaveFocus();
  });

  it("speichert eine gültige Person, öffnet das Detail und schliesst den Tab", async () => {
    const { service, tab } = setup(PersonFormPage);
    await userEvent.selectOptions(screen.getByLabelText(/^Anrede/), "Herr");
    await fill("Vorname", "Daniel");
    await fill("Nachname", "Probe");
    await fill("Strasse und Nr.", "Testplatz 9");
    await fill("PLZ", "8003");
    await fill("Ort", "Musterhausen");
    await fill("E-Mail-Adresse", "daniel.probe@example.ch");
    await userEvent.click(screen.getByRole("button", { name: "Person speichern" }));
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(await screen.findByText(/^person:Daniel Probe/)).toBeInTheDocument();
    const list = await service.listPersonen({ q: "Daniel Probe" });
    expect(list.items).toHaveLength(1);
  });

  it("«Änderungen verwerfen» erscheint nur mit Änderungen, setzt zurück und meldet es", async () => {
    setup(PersonFormPage, { id: "p-1001" });
    await screen.findByRole("heading", { name: "Person bearbeiten" });
    expect(screen.queryByRole("button", { name: "Änderungen verwerfen" })).not.toBeInTheDocument();
    await fill("Vorname", "Daniel");
    await userEvent.click(screen.getByRole("button", { name: "Änderungen verwerfen" }));
    expect(screen.getByLabelText(/^Vorname/)).toHaveValue("Anna");
    expect(screen.queryByText("Ungespeichert")).not.toBeInTheDocument();
    expect(await screen.findByText("Änderungen verworfen.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Änderungen verwerfen" })).not.toBeInTheDocument();
  });

  it("neue Person: «Abbrechen» schliesst den Tab, die Mitgliedsart ist keine Änderung", async () => {
    const { tab } = setup(PersonFormPage);
    await userEvent.click(screen.getByRole("radio", { name: "Firmenmitglied" }));
    expect(screen.queryByText("Ungespeichert")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(tab.close).toHaveBeenCalled();
  });

  it("meldet ein ungültiges Telefon am Feld und setzt den Fokus", async () => {
    const { service } = setup(PersonFormPage);
    const save = vi.spyOn(service, "savePerson");
    await userEvent.selectOptions(screen.getByLabelText(/^Anrede/), "Herr");
    await fill("Vorname", "Daniel");
    await fill("Nachname", "Probe");
    await fill("Strasse und Nr.", "Testplatz 9");
    await fill("PLZ", "8003");
    await fill("Ort", "Musterhausen");
    await fill("E-Mail-Adresse", "daniel.probe@example.ch");
    await fill("Telefon", "123");
    await userEvent.click(screen.getByRole("button", { name: "Person speichern" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("1 Angabe prüfen.");
    expect(
      screen.getByText("Geben Sie eine gültige Telefonnummer ein, zum Beispiel +41 79 123 45 67."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^Telefon/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/^Telefon/)).toHaveFocus();
    expect(save).not.toHaveBeenCalled();
  });

  it("bildet Feldfehler der API auf die Felder ab", async () => {
    const service = createMemoryPersonenService();
    vi.spyOn(service, "savePerson").mockRejectedValue(
      new FieldErrors({ telefon: "Geben Sie eine gültige Telefonnummer ein." }),
    );
    setup(PersonFormPage, {}, service);
    await userEvent.selectOptions(screen.getByLabelText(/^Anrede/), "Herr");
    await fill("Vorname", "Daniel");
    await fill("Nachname", "Probe");
    await fill("Strasse und Nr.", "Testplatz 9");
    await fill("PLZ", "8003");
    await fill("Ort", "Musterhausen");
    await fill("E-Mail-Adresse", "daniel.probe@example.ch");
    await userEvent.click(screen.getByRole("button", { name: "Person speichern" }));
    expect(
      await screen.findByText("Geben Sie eine gültige Telefonnummer ein."),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^Telefon/)).toHaveFocus());
  });

  it("Firmenmitglied ohne Firma im Register: Link «Firma erfassen»", async () => {
    const service = createMemoryPersonenService();
    vi.spyOn(service, "listFirmen").mockResolvedValue({ items: [], next: null, total: 0 });
    setup(PersonFormPage, {}, service);
    await userEvent.click(screen.getByRole("radio", { name: "Firmenmitglied" }));
    expect(await screen.findByText(/Es ist noch keine Firma erfasst/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Firma erfassen" }));
    expect(screen.getByText(/^firma-form:/)).toBeInTheDocument();
  });

  it("Firmenmitglied wählt die Firma aus dem Register", async () => {
    setup(PersonFormPage);
    await userEvent.click(screen.getByRole("radio", { name: "Firmenmitglied" }));
    expect(await screen.findByLabelText(/^Firma/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Strasse und Nr\./)).not.toBeInTheDocument();
  });

  it("setzt den bevorzugten Kanal und gibt ihn mit dem Speichern weiter", async () => {
    const { service } = setup(PersonFormPage, { id: "p-1001" });
    const select = await screen.findByLabelText("Bevorzugter Kanal");
    expect(select).toHaveValue("email");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Keine Angabe", "E-Mail", "Post"]);
    const save = vi.spyOn(service, "savePerson");
    await userEvent.selectOptions(select, "post");
    await userEvent.click(screen.getByRole("button", { name: "Person speichern" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]?.[1]).toMatchObject({ kanal: "post" });
  });

  it("bearbeitet eine vorhandene Person", async () => {
    setup(PersonFormPage, { id: "p-1001" });
    expect(await screen.findByRole("heading", { name: "Person bearbeiten" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Vorname/)).toHaveValue("Anna");
    expect(screen.getByLabelText(/^Geburtsdatum/)).toHaveValue("14.03.1985");
    expect(screen.getByLabelText("Mitgliedsnr.")).toHaveValue("M-1001");
  });
});

describe("Leerzustand der Liste", () => {
  it("nennt den Suchbegriff und setzt Suche und Filter zurück; das Suchfeld hat einen Löschen-Knopf", async () => {
    setup(PersonenListPage);
    await screen.findByText("Anna Beispiel");
    const search = screen.getByRole("searchbox", { name: "Name, Nr. oder Ort suchen" });
    await userEvent.type(search, "Zzzzz");
    expect(await screen.findByText("Keine Person passt zu «Zzzzz».")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Filter zurücksetzen" }));
    expect(await screen.findByText("Anna Beispiel")).toBeInTheDocument();
    expect(search).toHaveValue("");
    await userEvent.type(search, "Anna");
    await userEvent.click(screen.getByRole("button", { name: "Suche löschen" }));
    expect(search).toHaveValue("");
  });
});

describe("Gruppen (3.5 bis 3.8)", () => {
  it("zeigt Liste, Hinweis, Summe und Seitenfenster", async () => {
    const { container } = setup(GruppenPage);
    expect(await screen.findByRole("table", { name: "Gruppen" })).toBeInTheDocument();
    expect(screen.getByText("11 Gruppen")).toBeInTheDocument();
    expect(screen.getByText("Personen ohne Gruppe")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Helferteam"));
    expect(await screen.findByRole("heading", { name: "Gruppe «Helferteam»" })).toBeInTheDocument();
    expect(screen.getByText("14.10.2026")).toBeInTheDocument();
    await noViolations(container);
  });

  it("legt eine Gruppe an und meldet doppelte Namen", async () => {
    setup(GruppenPage);
    await screen.findByRole("table", { name: "Gruppen" });
    await userEvent.click(screen.getByRole("button", { name: "Gruppe anlegen" }));
    const dialog = screen.getByRole("dialog", { name: "Neue Gruppe anlegen?" });
    expect(await axe(dialog)).toHaveNoViolations();
    const name = within(dialog).getByLabelText(/^Name der Gruppe/);
    await userEvent.type(name, "Vorstand");
    await userEvent.click(within(dialog).getByRole("button", { name: "Gruppe anlegen" }));
    expect(
      within(dialog).getByText("Eine Gruppe mit diesem Namen gibt es schon."),
    ).toBeInTheDocument();
    await userEvent.clear(name);
    await userEvent.type(name, "Sommerfest-Team");
    await userEvent.click(within(dialog).getByRole("button", { name: "Gruppe anlegen" }));
    expect(await screen.findByText("Gruppe angelegt.")).toBeInTheDocument();
    expect(await screen.findByText("Sommerfest-Team")).toBeInTheDocument();
  });

  it("benennt eine Gruppe um", async () => {
    setup(GruppenPage);
    await screen.findByRole("table", { name: "Gruppen" });
    await userEvent.click(screen.getByRole("button", { name: "Gruppe Helferteam umbenennen" }));
    const dialog = screen.getByRole("dialog", { name: "Gruppe «Helferteam» umbenennen?" });
    const name = within(dialog).getByLabelText(/^Neuer Name/);
    await userEvent.clear(name);
    await userEvent.type(name, "Helferteam Sommerfest");
    await userEvent.click(within(dialog).getByRole("button", { name: "Gruppe umbenennen" }));
    expect(await screen.findByText("Helferteam Sommerfest")).toBeInTheDocument();
  });

  it("löst eine Gruppe erst nach Eingabe des Namens auf", async () => {
    setup(GruppenPage);
    await screen.findByRole("table", { name: "Gruppen" });
    await userEvent.click(screen.getByText("Helferteam"));
    await userEvent.click(await screen.findByRole("button", { name: "Gruppe auflösen" }));
    const dialog = screen.getByRole("dialog", { name: "Gruppe «Helferteam» auflösen?" });
    expect(await axe(dialog)).toHaveNoViolations();
    expect(within(dialog).getByText("64 Personen verlieren ihre Gruppe.")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/aus den 2 Adresslisten «Sommerfest» und «Helferaufruf» entfernt/),
    ).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Gruppe auflösen" });
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Abbrechen" })).toHaveFocus();
    await userEvent.type(
      within(dialog).getByLabelText(/^Gruppenname zur Bestätigung/),
      "Helferteam",
    );
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(await screen.findByText("Gruppe aufgelöst.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Helferteam")).not.toBeInTheDocument());
  });
});

describe("Firmenregister (3.9 bis 3.11)", () => {
  it("Liste mit Seitenfenster und Freigaben-Zähler", async () => {
    const { container } = setup(FirmenregisterPage);
    expect(await screen.findByRole("table", { name: "Firmenregister" })).toBeInTheDocument();
    expect(screen.getByText("16 Firmen")).toBeInTheDocument();
    expect(screen.getAllByText("Selbst registriert").length).toBe(2);
    expect(screen.getByRole("heading", { name: "Beispiel AG" })).toBeInTheDocument();
    await userEvent.click(screen.getByText("Beispiel Treuhand AG"));
    const side = await screen.findByRole("heading", { name: "Beispiel Treuhand AG" });
    expect(within(side.closest("section")!).getByText("1 Firmenmitglied")).toBeInTheDocument();
    await noViolations(container);
  });

  it("Firma Detail mit Kontaktpersonen und Mitgliedern", async () => {
    const { container } = setup(FirmaDetailPage, { id: "f-treuhand" });
    expect(
      await screen.findByRole("heading", { name: "Beispiel Treuhand AG" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Personen / Firmenregister / CHE-123.456.789")).toBeInTheDocument();
    expect(screen.getByText("01.03.2020 von Sabine Muster")).toBeInTheDocument();
    const kontakte = await screen.findByRole("table", { name: "Kontaktpersonen" });
    // Die bei der Firma erfasste Kontaktperson steht in den Registerdaten und in der Tabelle.
    expect(within(kontakte).getByText("Beat Muster")).toBeInTheDocument();
    expect(screen.getAllByText("info@beispiel-treuhand.example.ch").length).toBeGreaterThan(1);
    expect(screen.getByText("+41 44 000 00 02")).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "Firmenmitglieder" })).toBeInTheDocument();
    expect(screen.getAllByText("Freigegeben").length).toBeGreaterThan(0);
    await noViolations(container);
  });

  it("Firma Detail zeigt die erfasste Kontaktperson, E-Mail und Telefon im Schweizer Format", async () => {
    const service = createMemoryPersonenService();
    const f = await service.saveFirma(null, {
      name: "Neue Probe AG",
      uid: "CHE-109.322.551",
      strasse: "Probegasse 1",
      plz: "8001",
      ort: "Zürich",
      email: "kontakt@probe.example.ch",
      telefon: "044 000 00 09",
      kontaktperson: "Claudia Test",
    });
    setup(FirmaDetailPage, { id: f.id }, service);
    const kontakte = await screen.findByRole("table", { name: "Kontaktpersonen" });
    expect(within(kontakte).getByText("Claudia Test")).toBeInTheDocument();
    expect(screen.getAllByText("kontakt@probe.example.ch").length).toBe(2);
    expect(screen.getByText("+41 44 000 00 09")).toBeInTheDocument();
  });

  it("Firma erfassen: UID mit falscher Prüfziffer und Telefon werden am Feld gemeldet", async () => {
    setup(FirmaFormPage);
    const type = async (label: string, value: string) =>
      userEvent.type(screen.getByLabelText(new RegExp(`^${label}`)), value);
    await type("Firmenname", "Beispiel Treuhand AG");
    await type("UID", "CHE-123.456.789");
    await type("Strasse und Nr.", "Probegasse 4");
    await type("PLZ", "8001");
    await type("Ort", "Musterhausen");
    await type("Kontaktperson", "Claudia Test");
    await type("E-Mail-Adresse", "info@test.example.ch");
    await type("Telefon", "123");
    await userEvent.click(screen.getByRole("button", { name: "Firma speichern" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("2 Angaben prüfen.");
    expect(screen.getByLabelText(/^UID/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/^Telefon/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/^UID/)).toHaveFocus();
  });

  it("Firma erfassen: prüft Pflichtfelder, zeigt Duplikate vor dem Anlegen", async () => {
    const { container, tab } = setup(FirmaFormPage);
    await noViolations(container);
    await userEvent.click(screen.getByRole("button", { name: "Firma speichern" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Angaben prüfen.");

    const type = async (label: string, value: string) =>
      userEvent.type(screen.getByLabelText(new RegExp(`^${label}`)), value);
    await type("Firmenname", "Beispiel Treuhand AG");
    await type("UID", "CHE-109.322.551");
    await type("Strasse und Nr.", "Probegasse 4");
    await type("PLZ", "8001");
    await type("Ort", "Musterhausen");
    await type("Kontaktperson", "Claudia Test");
    await type("E-Mail-Adresse", "info@test.example.ch");
    await userEvent.click(screen.getByRole("button", { name: "Firma speichern" }));
    const dialog = await screen.findByRole("dialog", { name: "Mögliche Duplikate gefunden" });
    expect(within(dialog).getByText("Beispiel Treuhand AG")).toBeInTheDocument();
    expect(tab.close).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Trotzdem speichern" }));
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
  });
});

describe("Freigaben (3.14)", () => {
  it("zeigt Registrierungen und gibt eine Firma frei", async () => {
    const { container } = setup(FreigabenPage);
    expect(await screen.findByRole("table", { name: "Registrierungen" })).toBeInTheDocument();
    expect(screen.getAllByText("02.11.2026 · 09:12").length).toBeGreaterThan(0);
    expect(screen.getByText("8 Registrierungen")).toBeInTheDocument();
    const side = (await screen.findByRole("heading", { name: "Muster Bäckerei GmbH" })).closest(
      "section",
    )!;
    expect(within(side).getByText("Musterweg 7, 8004 Musterhausen")).toBeInTheDocument();
    await noViolations(container);
    await userEvent.click(screen.getByRole("button", { name: "Firma freigeben" }));
    expect(await screen.findByText("Firma freigegeben.")).toBeInTheDocument();
  });

  it("zeigt Personen neben den Firmen und gibt eine Person frei", async () => {
    const { service } = setup(FreigabenPage);
    await userEvent.click(await screen.findByText("Hans Demo"));
    const side = (await screen.findByRole("heading", { name: "Hans Demo" })).closest("section")!;
    expect(within(side).getByRole("button", { name: "Person freigeben" })).toBeEnabled();
    expect(within(side).queryByRole("button", { name: "Firma freigeben" })).not.toBeInTheDocument();
    await userEvent.click(within(side).getByRole("button", { name: "Person freigeben" }));
    expect(await screen.findByText("Person freigegeben.")).toBeInTheDocument();
    expect((await service.getPerson("p-1050")).status).toBe("aktiv");
  });

  it("lehnt eine Person ab", async () => {
    const { service } = setup(FreigabenPage);
    await userEvent.click(await screen.findByText("Maria Beispiel"));
    await userEvent.click(await screen.findByRole("button", { name: "Person ablehnen" }));
    await waitFor(async () => expect((await service.getPerson("p-1085")).status).toBe("abgelehnt"));
  });

  it("lehnt eine Firma ab", async () => {
    const { service } = setup(FreigabenPage);
    await screen.findByRole("button", { name: "Firma ablehnen" });
    await userEvent.click(screen.getByRole("button", { name: "Firma ablehnen" }));
    await waitFor(async () =>
      expect((await service.getFirma("f-baeckerei2")).status).toBe("abgelehnt"),
    );
  });
});

describe("Duplikate (3.12, 3.13)", () => {
  it("Liste mit Treffern und markiert «Kein Duplikat»", async () => {
    const { container } = setup(DuplikatePage);
    expect(await screen.findByRole("table", { name: "Duplikate" })).toBeInTheDocument();
    expect(screen.getByText("8 Treffer")).toBeInTheDocument();
    expect(screen.getAllByText("100 %").length).toBe(2);
    const panel = screen.getByRole("heading", { name: "Ausgewählter Treffer" }).closest("section")!;
    expect(within(panel).getByText("UID, MwSt-Nr.")).toBeInTheDocument();
    await noViolations(container);
    await userEvent.click(within(panel).getByRole("button", { name: "Kein Duplikat markieren" }));
    expect(await screen.findByText("Als kein Duplikat markiert.")).toBeInTheDocument();
  });

  it("ohne Duplikatliste im Dienst erscheint ein Hinweis", async () => {
    const base = createMemoryPersonenService();
    setup(DuplikatePage, {}, { ...base, features: { ...base.features, duplikate: false } });
    expect(
      await screen.findByText("Die Duplikatliste ist noch nicht verfügbar"),
    ).toBeInTheDocument();
  });

  it("Zusammenführen: Werte wählen und Ergebnis", async () => {
    const { container, tab, service } = setup(ZusammenfuehrenPage, { id: "d1" });
    expect(
      await screen.findByRole("heading", { name: "Duplikate zusammenführen" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Personen / Duplikate / Muster Garage AG")).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Eintrag A · M-1141 · 3 Rechnungen" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Eintrag B · M-1218 · 1 Rechnung" }),
    ).toBeInTheDocument();
    expect(screen.getByText("4 (3 von A, 1 von B)")).toBeInTheDocument();
    expect(screen.getByText("M-1218 wird entfernt")).toBeInTheDocument();
    await noViolations(container);

    const b = screen.getByRole("radio", { name: "Telefon: Wert von Eintrag B, +41 44 000 00 15" });
    await userEvent.click(b);
    expect(b).toBeChecked();
    expect(
      screen.getByRole("radio", { name: "Telefon: Wert von Eintrag A, +41 44 000 00 05" }),
    ).not.toBeChecked();
    const merge = vi.spyOn(service, "merge");
    await userEvent.click(screen.getByRole("button", { name: "Einträge zusammenführen" }));
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(merge).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ werte: expect.objectContaining({ telefon: "+41 44 000 00 15" }) }),
    );
  });

  it("Zusammenführen ohne Rechnungsdaten zeigt Mitglieder statt erfundener Rechnungen", async () => {
    const base = createMemoryPersonenService();
    const seed = designSeed();
    const garage = seed.duplikate[0];
    if (!garage) throw new Error("Seed ohne Duplikat");
    garage.a = { ...garage.a, nr: null, rechnungen: null, mitglieder: 2 };
    garage.b = { ...garage.b, nr: null, rechnungen: null, mitglieder: 1 };
    const service = createMemoryPersonenService(seed, {
      ...base.features,
      finanzen: false,
      firmaFinanzen: false,
    });
    setup(ZusammenfuehrenPage, { id: "d1" }, service);
    expect(
      await screen.findByRole("columnheader", { name: "Eintrag A · 2 Mitglieder" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Eintrag B · 1 Mitglied" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("3 (2 von A, 1 von B) wechseln zur behaltenen Firma"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Rechnungen")).not.toBeInTheDocument();
    expect(screen.queryByText(/Buchungen/)).not.toBeInTheDocument();
  });
});

describe("Import (3.15)", () => {
  const csv =
    "Vorname;Nachname;Strasse;PLZ Ort;Mail;Gruppe\nAnna;Beispiel;Beispielstrasse 12;8000 Musterhausen;anna@example.ch;Aktivmitglieder\nBeat;;x;y;z;\n";

  async function upload(content: string, name = "mitglieder.csv") {
    const input = screen.getByLabelText("Datei für den Import wählen");
    await userEvent.upload(input, new File([content], name, { type: "text/csv" }));
  }

  it("beginnt mit der Dateiwahl", () => {
    setup(ImportPage);
    expect(screen.getByText("Keine Datei gewählt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import prüfen" })).toBeDisabled();
  });

  it("liest die Datei, schlägt Zuordnungen vor, prüft und meldet fehlerhafte Zeilen", async () => {
    const { container } = setup(ImportPage);
    await upload(csv);
    expect(await screen.findByText("mitglieder.csv")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Spalte «Vorname» zuordnen" })).toHaveValue(
      "vorname",
    );
    expect(screen.getByRole("combobox", { name: "Spalte «PLZ Ort» zuordnen" })).toHaveValue(
      "plzOrt",
    );
    expect(screen.getByRole("combobox", { name: "Spalte «Mail» zuordnen" })).toHaveValue("email");
    expect(screen.getByRole("list", { name: "Importschritte" })).toBeInTheDocument();
    expect(screen.getByText("Schritt 2: Spalten zuordnen").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
    await noViolations(container);

    await userEvent.click(screen.getByRole("button", { name: "Import prüfen" }));
    expect(await screen.findByText("Import nicht möglich.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import durchführen" })).toBeDisabled();
  });

  it("führt einen fehlerfreien Import aus", async () => {
    const { tab, service } = setup(ImportPage);
    await upload("Vorname;Nachname;Mail\nAnna;Neu;neu@example.ch\n");
    await screen.findByText("mitglieder.csv");
    await userEvent.click(screen.getByRole("button", { name: "Import prüfen" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Import durchführen" })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Import durchführen" }));
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect((await service.listPersonen({ q: "Anna Neu" })).items).toHaveLength(1);
  });

  it("verlangt Vorname und Nachname", async () => {
    setup(ImportPage);
    await upload("A;B\n1;2\n");
    await screen.findByText("mitglieder.csv");
    await userEvent.click(screen.getByRole("button", { name: "Import prüfen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Spalten prüfen.");
  });

  it("lehnt andere Dateitypen ab", async () => {
    setup(ImportPage);
    const input = screen.getByLabelText("Datei für den Import wählen");
    await userEvent.upload(input, new File(["x"], "bild.png", { type: "image/png" }), {
      applyAccept: false,
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Die Datei kann nicht gelesen werden.",
    );
  });
});

describe("Unternavigation und Liste", () => {
  it("zeigt die Reiter mit Freigaben-Zähler und öffnet den passenden Tab", async () => {
    const { container } = setup(GruppenPage);
    const nav = await screen.findByRole("navigation", { name: "Personenverwaltung" });
    expect(within(nav).getByRole("button", { name: "Gruppen" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // Zwei Firmen und drei Personen warten: der Zähler führt beide zusammen.
    expect(await within(nav).findByRole("button", { name: "Freigaben 5" })).toBeInTheDocument();
    await noViolations(container);
    await userEvent.click(within(nav).getByRole("button", { name: "Firmen" }));
    expect(screen.getByText(/^firmenregister:/)).toBeInTheDocument();
    await userEvent.click(within(nav).getByRole("button", { name: /^Freigaben/ }));
    await userEvent.click(within(nav).getByRole("button", { name: /^Freigaben/ }));
    expect(screen.getAllByText(/^firma-freigaben:/)).toHaveLength(1);
  });

  it("zeigt keinen Zähler bei Freigaben, wenn nichts wartet", async () => {
    const base = createMemoryPersonenService();
    const service: PersonenService = {
      ...base,
      listFirmen: async () => ({ items: [], next: null, total: 0 }),
      listPersonen: async () => ({ items: [], next: null, total: 0 }),
    };
    setup(GruppenPage, {}, service);
    const nav = await screen.findByRole("navigation", { name: "Personenverwaltung" });
    await waitFor(() =>
      expect(within(nav).getByRole("button", { name: "Freigaben" })).toBeVisible(),
    );
    expect(nav).not.toHaveTextContent(/\d/);
  });

  it("der Name ist eine Schaltfläche und öffnet die Person", async () => {
    setup(PersonenListPage);
    await userEvent.click(await screen.findByRole("button", { name: "Anna Beispiel" }));
    expect(screen.getByText(/^person:Anna Beispiel/)).toBeInTheDocument();
  });

  it("sortiert nach Spalten, wenn alle Zeilen geladen sind", async () => {
    setup(PersonenListPage);
    await screen.findByText("Anna Beispiel");
    await userEvent.click(screen.getByRole("button", { name: /^Ort/ }));
    expect(screen.getByRole("columnheader", { name: /^Ort/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    expect(screen.getByRole("columnheader", { name: /^Name/ })).not.toHaveAttribute("aria-sort");
    await userEvent.click(screen.getByRole("button", { name: /^Ort/ }));
    expect(screen.getByRole("columnheader", { name: /^Ort/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  });

  it("bietet keine Sortierung an, solange nicht alle Zeilen geladen sind", async () => {
    const base = createMemoryPersonenService();
    const service = {
      ...base,
      listPersonen: async (q: Parameters<typeof base.listPersonen>[0]) => ({
        ...(await base.listPersonen(q)),
        next: "weiter",
      }),
    };
    setup(PersonenListPage, {}, service);
    await screen.findByText("Anna Beispiel");
    expect(screen.queryByRole("button", { name: /^Ort/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Weitere laden" })).toBeInTheDocument();
  });

  it("sortRows sortiert die Spalte Name nach Nachname, dann Vorname", () => {
    const row = (name: string, sortName: string) =>
      ({
        id: name,
        nr: null,
        name,
        sortName,
        typ: "einzel",
        ort: null,
        gruppeId: null,
        gruppeName: null,
        status: "aktiv",
      }) as const;
    const rows = [
      row("Zoe Albrecht", "Albrecht Zoe"),
      row("Anna Zimmer", "Zimmer Anna"),
      row("Ben Albrecht", "Albrecht Ben"),
    ];
    expect(sortRows(rows, { key: "name", direction: "asc" }).map((r) => r.name)).toEqual([
      "Ben Albrecht",
      "Zoe Albrecht",
      "Anna Zimmer",
    ]);
  });

  it("sortRows stellt leere Werte ans Ende", () => {
    const row = (name: string, ort: string | null) =>
      ({
        id: name,
        nr: null,
        name,
        sortName: name,
        typ: "einzel",
        ort,
        gruppeId: null,
        gruppeName: null,
        status: "aktiv",
      }) as const;
    const rows = [row("A", null), row("B", "Zürich"), row("C", "Bern")];
    expect(sortRows(rows, { key: "ort", direction: "asc" }).map((r) => r.name)).toEqual([
      "C",
      "B",
      "A",
    ]);
    expect(sortRows(rows, { key: "ort", direction: "desc" }).map((r) => r.name)).toEqual([
      "B",
      "C",
      "A",
    ]);
  });

  it("lädt die Liste neu, wenn der Tab wieder aktiv wird", async () => {
    const service = createMemoryPersonenService();
    const list = vi.spyOn(service, "listPersonen");
    function Controls() {
      const tabs = useTabs();
      return (
        <>
          <button onClick={() => tabs.openTab("gruppen", { key: "gruppen" })}>zu Gruppen</button>
          <button onClick={() => tabs.activateIndex(0)}>zurück</button>
        </>
      );
    }
    renderWithProviders(
      <PersonenProvider service={service}>
        <TabsProvider modules={[personenModule]} initialType="personen">
          <TabPanels />
          <Controls />
        </TabsProvider>
      </PersonenProvider>,
    );
    await screen.findByText("Anna Beispiel");
    const plain = () => list.mock.calls.filter(([q]) => !q.status).length;
    const before = plain();
    await userEvent.click(screen.getByRole("button", { name: "zu Gruppen" }));
    await userEvent.click(screen.getByRole("button", { name: "zurück" }));
    await waitFor(() => expect(plain()).toBeGreaterThan(before));
  });
});

describe("Verknüpfungen zu anderen Modulen", () => {
  it("ohne die Module fehlen die Schaltflächen im Detail", async () => {
    setup(PersonDetailPage, { id: "p-1001" });
    await screen.findByRole("heading", { name: "Anna Beispiel" });
    for (const name of ["E-Mail schreiben", "Rechnung erstellen", "Debitorenkonto öffnen"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("öffnet Mail, Rechnung und Debitorenkonto mit der Person", async () => {
    const { service } = setup(PersonDetailPage, { id: "p-1001" }, undefined, linkedModules);
    await screen.findByRole("heading", { name: "Anna Beispiel" });
    const email = (await service.getPerson("p-1001")).email;
    await userEvent.click(screen.getByRole("button", { name: "E-Mail schreiben" }));
    expect(paramsOf("mail-compose")).toEqual({ to: email });
    await userEvent.click(screen.getByRole("button", { name: "Rechnung erstellen" }));
    expect(paramsOf("rechnung-neu")).toEqual({ personId: "p-1001", name: "Anna Beispiel" });
    await userEvent.click(await screen.findByRole("button", { name: "Debitorenkonto öffnen" }));
    expect(paramsOf("accounting-debitor")).toEqual({ personId: "p-1001", name: "Anna Beispiel" });
  });

  it("Mehrfachauswahl: eine Person schreibt eine Mail, mehrere gehen in eine Adressliste", async () => {
    const { service } = setup(PersonenListPage, {}, undefined, linkedModules);
    await screen.findByText("Beat Demo");
    const boxes = screen.getAllByRole("checkbox", { name: "Zeile auswählen" });
    await userEvent.click(boxes[0]!);
    await userEvent.click(screen.getByRole("button", { name: "E-Mail schreiben" }));
    await waitFor(() => expect(screen.getByText(/^mail-compose:/)).toBeInTheDocument());
    expect(paramsOf("mail-compose")).toEqual({ to: (await service.getPerson("p-1001")).email });

    await userEvent.click(boxes[1]!);
    expect(screen.queryByRole("button", { name: "E-Mail schreiben" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Zu Adressliste hinzufügen" }));
    await waitFor(() => expect(screen.getByText(/^mail-list:/)).toBeInTheDocument());
    const entries = JSON.parse(paramsOf("mail-list")["entries"] ?? "[]") as Array<{
      personId: string;
      name: string;
    }>;
    expect(entries.map((e) => e.name)).toEqual(["Anna Beispiel", "Gabi Beispiel"]);
    expect(entries[0]?.personId).toBe("p-1001");
  });
});

describe("Speichern schliesst den Tab ohne Rückfrage", () => {
  function Pending() {
    const { pendingClose } = useTabs();
    return <p>{pendingClose ? "Rückfrage offen" : "keine Rückfrage"}</p>;
  }
  const open = (type: string) =>
    renderWithProviders(
      <PersonenProvider service={createMemoryPersonenService()}>
        <TabsProvider modules={[personenModule]} initialType={type}>
          <TabPanels />
          <Probe />
          <Pending />
        </TabsProvider>
      </PersonenProvider>,
    );
  const type = async (label: string, value: string) =>
    userEvent.type(screen.getByLabelText(new RegExp(`^${label}`)), value);

  it("Person anlegen", async () => {
    open("person-form");
    await userEvent.selectOptions(screen.getByLabelText(/^Anrede/), "Herr");
    await type("Vorname", "Daniel");
    await type("Nachname", "Probe");
    await type("Strasse und Nr.", "Testplatz 9");
    await type("PLZ", "8003");
    await type("Ort", "Musterhausen");
    await type("E-Mail-Adresse", "daniel.probe@example.ch");
    await userEvent.click(screen.getByRole("button", { name: "Person speichern" }));
    expect(await screen.findByText(/^person:Daniel Probe/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/^person-form:/)).not.toBeInTheDocument());
    expect(screen.queryByText("Rückfrage offen")).not.toBeInTheDocument();
  });

  it("Firma erfassen", async () => {
    open("firma-form");
    await type("Firmenname", "Zürcher Backwaren AG");
    await type("UID", "CHE-987.654.326");
    await type("Strasse und Nr.", "Probegasse 4");
    await type("PLZ", "8001");
    await type("Ort", "Zürich");
    await type("Kontaktperson", "Claudia Test");
    await type("E-Mail-Adresse", "info@backwaren.example.ch");
    await userEvent.click(screen.getByRole("button", { name: "Firma speichern" }));
    expect(await screen.findByText(/^firma:Zürcher Backwaren AG/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/^firma-form:/)).not.toBeInTheDocument());
    expect(screen.queryByText("Rückfrage offen")).not.toBeInTheDocument();
  });
});

describe("Dialoge und Formular", () => {
  it("Dialoge haben genau eine Schaltfläche «Dialog schliessen»", async () => {
    setup(GruppenPage);
    await screen.findByRole("table", { name: "Gruppen" });
    await userEvent.click(screen.getByRole("button", { name: "Gruppe anlegen" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByRole("button", { name: "Dialog schliessen" })).toHaveLength(1);
  });

  it("«Mitgliedsart» steht einmal im Formular", () => {
    setup(PersonFormPage);
    expect(screen.getAllByText("Mitgliedsart")).toHaveLength(1);
  });

  it("Pflichtfelder tragen «*» und das Attribut required, optionale Felder keinen Zusatz", () => {
    setup(PersonFormPage);
    expect(screen.getByLabelText(/^Vorname/)).toBeRequired();
    expect(screen.getByText("Vorname", { selector: "label" }).textContent).toBe("Vorname *");
    expect(screen.getByLabelText("Telefon")).not.toBeRequired();
    expect(screen.queryByText(/\(optional\)|Pflichtfeld/)).not.toBeInTheDocument();
  });
});

describe("Modul", () => {
  it("trägt die Kennung people und eine Seitenleiste «Personen»", () => {
    expect(personenModule.id).toBe("people");
    expect(personenModule.nav.tabType).toBe("personen");
    expect(personenModule.newTabType).toBe("person-form");
    expect(personenModule.tabTypes.map((x) => x.id)).toContain("duplikate-merge");
  });
});

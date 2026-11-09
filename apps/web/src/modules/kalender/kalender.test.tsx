import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { axe } from "vitest-axe";
import { describe, expect, it } from "vitest";
import { TabPanels } from "../../shell/TabPanels";
import { TabsProvider, useTabs, type OpenOptions } from "../../shell/tabs";
import { renderWithProviders } from "../../test-utils";
import type { CalEvent, ParticipantRow } from "./calendarService";
import { createKalenderModule } from "./index";
import {
  createMemoryCalendarService,
  eventFromInput,
  type MemorySeed,
} from "./memoryCalendarService";
import { instantOf } from "./time";

/** Montag, 02.11.2026, 14:41 in Zürich (Winterzeit). */
const NOW = instantOf("2026-11-02T14:41");

const ev = (
  id: string,
  title: string,
  start: string,
  end: string,
  deadline: string | null,
  extra: Partial<CalEvent> = {},
): CalEvent => ({
  ...eventFromInput(id, {
    title,
    description: "",
    location: "",
    startsAtLocal: start,
    endsAtLocal: end,
    registrationDeadlineLocal: deadline,
    maxGuests: 0,
  }),
  ...extra,
});

const events: CalEvent[] = [
  ev("herbst", "Herbstanlass", "2026-11-01T16:00", "2026-11-01T17:30", "2026-10-30T23:59"),
  ev("gv", "Generalversammlung 2026", "2026-11-14T17:00", "2026-11-14T20:30", "2026-11-06T23:59", {
    location: "Gemeindesaal Musterhausen",
    description: "Ordentliche Generalversammlung mit Jahresbericht.",
    maxGuests: 2,
  }),
  ev("essen", "Helferessen", "2026-11-21T19:00", "2026-11-21T22:00", "2026-11-14T23:59"),
  ev("vorstand", "Vorstandssitzung", "2026-11-26T18:30", "2026-11-26T20:00", null),
  ev("advent", "Adventsanlass", "2026-12-05T16:00", "2026-12-05T18:00", "2026-11-28T23:59"),
];

const row = (
  n: number,
  status: ParticipantRow["status"],
  guests = 0,
  note = "",
): ParticipantRow => ({
  invitationId: `i${n}`,
  name: `Person ${String(n).padStart(2, "0")}`,
  email: `p${n}@example.ch`,
  status,
  guests,
  note,
  respondedAt: status === "pending" ? null : new Date(NOW - n * 60_000).toISOString(),
});

/** 20 Zusagen (davon 2 mit Begleitung), 3 Absagen, 5 ohne Rückmeldung. */
const gvRows: ParticipantRow[] = [
  ...Array.from({ length: 20 }, (_, i) =>
    row(i + 1, "accepted", i < 2 ? 1 : 0, i === 0 ? "Vegetarisch" : ""),
  ),
  ...[21, 22, 23].map((n) => row(n, "declined", 0, n === 21 ? "Bin im Ausland" : "")),
  ...[24, 25, 26, 27, 28].map((n) => row(n, "pending")),
];

function seed(extra: Partial<MemorySeed> = {}): MemorySeed {
  return {
    events,
    participants: {
      gv: gvRows,
      herbst: [row(1, "accepted", 1), row(2, "accepted"), row(3, "declined")],
    },
    groups: [
      {
        id: "g1",
        name: "GV 2026 Mitglieder",
        members: 2,
        recipients: [
          { email: "anna@example.ch", name: "Anna Beispiel" },
          { email: "beat@example.ch", name: "Beat Demo" },
        ],
      },
    ],
    ...extra,
  };
}

function Opener({ type, options }: { type: string; options: OpenOptions }) {
  const { openTab } = useTabs();
  useEffect(() => openTab(type, options), []);
  return null;
}

function setup(open?: { type: string; options: OpenOptions }, data: MemorySeed = seed()) {
  const service = createMemoryCalendarService(data);
  const view = renderWithProviders(
    <TabsProvider modules={[createKalenderModule(service, NOW)]} initialType="calendar">
      {open && <Opener type={open.type} options={open.options} />}
      <TabPanels />
    </TabsProvider>,
  );
  return { service, ...view };
}

const gv = { type: "calendar-event", options: { key: "event:gv", params: { eventId: "gv" } } };

describe("Monatsansicht (8.1)", () => {
  it("zeigt Monat, Wochentage, Einträge mit Symbol und Text und die Zahl der Events", async () => {
    setup();
    expect(await screen.findByRole("heading", { name: "Kalender" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "November 2026" })).toBeInTheDocument();
    expect(screen.getByText("4 Events im November")).toBeInTheDocument();
    const grid = screen.getByRole("grid", { name: "Monat November 2026" });
    expect(
      within(grid)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]);
    expect(within(grid).getAllByRole("row")).toHaveLength(7); // Kopf plus sechs Wochen
    expect(
      await screen.findByRole("button", { name: "17:00 Generalversammlung 2026" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Anmeldeschluss Helferessen" })).toBeVisible();
    expect(screen.getByRole("button", { name: "19:00 Helferessen" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Anmeldeschluss Adventsanlass" })).toBeVisible();
    expect(screen.getByRole("button", { name: "16:00 Adventsanlass" })).toBeVisible();
    // Beendeter Event: Hinweis steht im Text, nicht nur in der Farbe.
    expect(screen.getByRole("button", { name: "Herbstanlass, wird heute gelöscht" })).toBeVisible();
    // Heute ist markiert, auch für Screenreader.
    expect(screen.getByText("2", { selector: "[aria-current='date']" })).toBeVisible();
    expect(screen.getByText("Heute", { selector: "span.muted" })).toBeVisible();
  });

  it("hat keine Verstösse gegen die Zugänglichkeit", async () => {
    const { container } = setup();
    await screen.findByRole("button", { name: "17:00 Generalversammlung 2026" });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("blättert mit den Schaltflächen und springt mit «Heute» zurück", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Nächster Monat" }));
    expect(screen.getByRole("heading", { level: 2, name: "Dezember 2026" })).toBeInTheDocument();
    expect(screen.getByText("1 Event im Dezember")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Vorheriger Monat" }));
    await userEvent.click(screen.getByRole("button", { name: "Vorheriger Monat" }));
    expect(screen.getByRole("heading", { level: 2, name: "Oktober 2026" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Heute" }));
    expect(screen.getByRole("heading", { level: 2, name: "November 2026" })).toBeInTheDocument();
  });

  it("lässt sich mit den Pfeiltasten bedienen: ein Tab-Stopp, Fokus folgt", async () => {
    setup();
    await screen.findByRole("button", { name: "17:00 Generalversammlung 2026" });
    const grid = screen.getByRole("grid", { name: "Monat November 2026" });
    const stops = within(grid)
      .getAllByRole("gridcell")
      .filter((c) => c.getAttribute("tabindex") === "0");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveAttribute("data-day", "2026-11-02"); // heute

    stops[0]!.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toHaveAttribute("data-day", "2026-11-03");
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toHaveAttribute("data-day", "2026-11-10");
    await userEvent.keyboard("{ArrowLeft}{ArrowUp}");
    expect(document.activeElement).toHaveAttribute("data-day", "2026-11-02");
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toHaveAttribute("data-day", "2026-11-08");
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toHaveAttribute("data-day", "2026-11-02");
    // Ein Monat weiter: 2.12. steht noch im Raster des Novembers.
    await userEvent.keyboard("{PageDown}");
    expect(document.activeElement).toHaveAttribute("data-day", "2026-12-02");
    expect(screen.getByRole("heading", { level: 2, name: "November 2026" })).toBeInTheDocument();
    // Über den Rand hinaus wechselt der Monat, der Fokus folgt.
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("heading", { level: 2, name: "Dezember 2026" })).toBeInTheDocument();
    expect(document.activeElement).toHaveAttribute("data-day", "2026-12-09");
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(screen.getByRole("heading", { level: 2, name: "November 2026" })).toBeInTheDocument();
    expect(document.activeElement).toHaveAttribute("data-day", "2026-11-25");
  });

  it("öffnet einen Event aus dem Raster in einem Tab", async () => {
    setup();
    await userEvent.click(
      await screen.findByRole("button", { name: "17:00 Generalversammlung 2026" }),
    );
    expect(await screen.findByRole("heading", { name: "Event bearbeiten" })).toBeInTheDocument();
    expect(screen.getByLabelText("Titel (Pflicht)")).toHaveValue("Generalversammlung 2026");
  });

  it("meldet einen Ladefehler mit «Erneut laden»", async () => {
    const service = createMemoryCalendarService(seed());
    let fail = true;
    const original = service.listEvents;
    service.listEvents = (...args) => (fail ? Promise.reject(new Error("x")) : original(...args));
    renderWithProviders(
      <TabsProvider modules={[createKalenderModule(service, NOW)]} initialType="calendar">
        <TabPanels />
      </TabsProvider>,
    );
    expect(
      await screen.findByText("Die Kalenderdaten konnten nicht geladen werden."),
    ).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Erneut laden" }));
    expect(
      await screen.findByRole("button", { name: "17:00 Generalversammlung 2026" }),
    ).toBeVisible();
  });
});

describe("Wochenansicht (8.2)", () => {
  it("zeigt Fristen, Stundenraster und Event-Blöcke der Woche", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Woche" }));
    expect(screen.getByRole("button", { name: "Woche" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Monat" })).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("heading", { level: 2, name: "KW 45 · 02.11.–08.11.2026" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("1 Anmeldeschluss")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "23:59 Anmeldeschluss Generalversammlung 2026" }),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Nächste Woche" }));
    expect(
      screen.getByRole("heading", { level: 2, name: "KW 46 · 09.11.–15.11.2026" }),
    ).toBeInTheDocument();
    const block = await screen.findByRole("button", { name: /17:00–20:30/ });
    expect(block).toHaveTextContent("Generalversammlung 2026");
    expect(block).toHaveTextContent("Gemeindesaal Musterhausen");
    expect(await screen.findByText("20 Zusagen")).toBeInTheDocument();
    expect(screen.getByText("1 Event, 1 Anmeldeschluss")).toBeInTheDocument();
    // 17:00 liegt neun Stunden nach 08:00: 9 x 32 px
    expect(block.style.top).toBe("288px");
    expect(block.style.height).toBe("112px");
  });

  it("hat keine Verstösse gegen die Zugänglichkeit und lässt sich mit den Pfeiltasten bedienen", async () => {
    const { container } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Woche" }));
    await screen.findByText("1 Anmeldeschluss");
    expect(await axe(container)).toHaveNoViolations();
    const heads = screen.getAllByRole("group").filter((g) => g.hasAttribute("data-day"));
    expect(heads).toHaveLength(7);
    const stop = heads.find((h) => h.getAttribute("tabindex") === "0")!;
    expect(stop).toHaveAttribute("aria-label", "Montag, 02.11.2026");
    stop.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(document.activeElement).toHaveAttribute("aria-label", "Mittwoch, 04.11.2026");
    await userEvent.keyboard("{PageDown}");
    expect(
      screen.getByRole("heading", { level: 2, name: "KW 46 · 09.11.–15.11.2026" }),
    ).toBeInTheDocument();
    expect(document.activeElement).toHaveAttribute("aria-label", "Mittwoch, 11.11.2026");
  });
});

describe("Event anlegen und bearbeiten (8.3)", () => {
  it("zeigt den gespeicherten Event, die Löschfrist und den Stand", async () => {
    const { container } = setup(gv);
    expect(await screen.findByRole("heading", { name: "Event bearbeiten" })).toBeInTheDocument();
    expect(screen.getByLabelText("Datum (Pflicht)")).toHaveValue("14.11.2026");
    expect(screen.getByLabelText("Beginn (Pflicht)")).toHaveValue("17:00");
    expect(screen.getByLabelText("Ende (Pflicht)")).toHaveValue("20:30");
    expect(screen.getByLabelText("Ort (Pflicht)")).toHaveValue("Gemeindesaal Musterhausen");
    expect(screen.getByLabelText("Anmeldeschluss, Datum (Pflicht)")).toHaveValue("06.11.2026");
    expect(screen.getByLabelText("Anmeldeschluss, Zeit (Pflicht)")).toHaveValue("23:59");
    expect(screen.getByRole("checkbox", { name: "Begleitpersonen angeben" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Zusage und Absage" })).toBeDisabled();
    expect(
      screen.getByText(/gelöscht: am 15\.11\.2026 um 20:30\./, { selector: "div" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Anmeldung offen")).toBeInTheDocument();
    const stand = screen.getByRole("region", { name: "Stand" });
    expect(within(stand).getByText("Ohne Rückmeldung").nextElementSibling).toHaveTextContent("5");
    expect(within(stand).getByText("28 Eingeladene")).toBeInTheDocument();
    expect(screen.queryByText("Nicht gespeichert")).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("meldet Änderungen als ungespeichert und speichert sie", async () => {
    const { service } = setup(gv);
    const title = await screen.findByLabelText("Titel (Pflicht)");
    await userEvent.clear(title);
    await userEvent.type(title, "Generalversammlung 2027");
    expect(screen.getByText("Nicht gespeichert")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Event speichern" }));
    expect(await screen.findByText("Event gespeichert.")).toBeInTheDocument();
    expect(service.events.find((e) => e.id === "gv")!.title).toBe("Generalversammlung 2027");
    expect(service.events.find((e) => e.id === "gv")!.startsAtLocal).toBe("2026-11-14T17:00");
    expect(screen.queryByText("Nicht gespeichert")).not.toBeInTheDocument();
  });

  it("prüft die Eingaben und speichert nichts, solange ein Feld falsch ist", async () => {
    const { service } = setup(gv);
    const date = await screen.findByLabelText("Datum (Pflicht)");
    await userEvent.clear(date);
    await userEvent.type(date, "31.02.2026");
    const end = screen.getByLabelText("Ende (Pflicht)");
    await userEvent.clear(end);
    await userEvent.type(end, "16:00");
    await userEvent.click(screen.getByRole("button", { name: "Event speichern" }));
    expect(await screen.findByText("Bitte prüfen Sie die markierten Felder.")).toBeInTheDocument();
    expect(screen.getByText("Bitte geben Sie das Datum als TT.MM.JJJJ ein.")).toBeInTheDocument();
    expect(date).toHaveAttribute("aria-invalid", "true");
    expect(date).toHaveFocus();
    expect(service.events.find((e) => e.id === "gv")!.title).toBe("Generalversammlung 2026");

    await userEvent.clear(date);
    await userEvent.type(date, "14.11.2026");
    await userEvent.click(screen.getByRole("button", { name: "Event speichern" }));
    expect(await screen.findByText("Das Ende muss nach dem Beginn liegen.")).toBeInTheDocument();
  });

  it("legt einen neuen Event an und wechselt danach in die Bearbeitung", async () => {
    const { service } = setup({ type: "calendar-event", options: { key: "new" } });
    expect(await screen.findByRole("heading", { name: "Neuer Event" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Einladung erzeugen" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Titel (Pflicht)"), "Sommerfest");
    await userEvent.type(screen.getByLabelText("Datum (Pflicht)"), "04.07.2027");
    await userEvent.type(screen.getByLabelText("Beginn (Pflicht)"), "14:00");
    await userEvent.type(screen.getByLabelText("Ende (Pflicht)"), "22:00");
    await userEvent.type(screen.getByLabelText("Ort (Pflicht)"), "Festplatz");
    await userEvent.type(screen.getByLabelText("Anmeldeschluss, Datum (Pflicht)"), "20.06.2027");
    await userEvent.type(screen.getByLabelText("Anmeldeschluss, Zeit (Pflicht)"), "23:59");
    await userEvent.click(screen.getByRole("button", { name: "Event speichern" }));
    expect(await screen.findByRole("heading", { name: "Event bearbeiten" })).toBeInTheDocument();
    const created = service.events.find((e) => e.title === "Sommerfest")!;
    expect(created).toMatchObject({
      startsAtLocal: "2027-07-04T14:00",
      endsAtLocal: "2027-07-04T22:00",
      registrationDeadlineLocal: "2027-06-20T23:59",
      maxGuests: 10,
    });
    expect(screen.getByRole("button", { name: "Einladung erzeugen" })).toBeEnabled();
  });

  it("öffnet Einladung, Teilnehmerliste und Rückmeldungen als eigene Tabs", async () => {
    setup(gv);
    await userEvent.click(await screen.findByRole("button", { name: "Teilnehmerliste öffnen" }));
    expect(
      await screen.findByRole("heading", { name: "Teilnehmerliste Generalversammlung 2026" }),
    ).toBeInTheDocument();
  });
});

describe("Einladung erzeugen (8.4)", () => {
  const invite = {
    type: "calendar-invite",
    options: { key: "invite:gv", params: { eventId: "gv", groupId: "g1" } },
  };

  it("zeigt das Blatt mit den Angaben des Events und Platzhaltern", async () => {
    const { container } = setup(invite);
    expect(await screen.findByRole("heading", { name: "Einladung erzeugen" })).toBeInTheDocument();
    expect(screen.getByText("Vorschau", { selector: ".badge" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Einladung: Generalversammlung 2026" }),
    ).toBeInTheDocument();
    for (const pin of ["[Anrede]", "[Name]", "[Antwortlink]"])
      expect(screen.getByText(pin)).toBeInTheDocument();
    const paper = screen.getByText("Datum", { selector: "th" }).closest("table")!;
    expect(within(paper).getByText("Samstag, 14.11.2026")).toBeInTheDocument();
    expect(within(paper).getByText("17:00–20:30 Uhr")).toBeInTheDocument();
    expect(within(paper).getByText("Gemeindesaal Musterhausen")).toBeInTheDocument();
    expect(within(paper).getByText("06.11.2026, 23:59 Uhr")).toBeInTheDocument();
    expect(screen.getByText("Begleitpersonen sind willkommen.")).toBeInTheDocument();
    const side = screen.getByRole("region", { name: "Versand" });
    expect(within(side).getByText("Einladung Generalversammlung 2026")).toBeInTheDocument();
    expect(within(side).getByText("GV 2026 Mitglieder")).toBeInTheDocument();
    await waitFor(() =>
      expect(within(side).getByText("Empfänger").nextElementSibling).toHaveTextContent("2"),
    );
    expect(screen.getByText(/Sie werden am 15\.11\.2026 um 20:30 ungültig/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Testmail an mich senden" })).toBeDisabled();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("verlangt eine Bestätigung und versendet dann an alle Empfänger", async () => {
    const { service } = setup(invite);
    const send = await screen.findByRole("button", { name: "Einladung per Mail versenden" });
    await waitFor(() => expect(send).toBeEnabled());
    await userEvent.click(send);
    const dialog = await screen.findByRole("dialog", { name: "Einladung versenden?" });
    expect(within(dialog).getByText(/geht an 2 Personen/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    expect(service.sent).toHaveLength(0);

    await userEvent.click(send);
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Einladung per Mail versenden",
      }),
    );
    expect(await screen.findByText("Einladung an 2 Personen versendet.")).toBeInTheDocument();
    expect(service.sent.map((r) => r.email)).toEqual(["anna@example.ch", "beat@example.ch"]);
  });

  it("meldet einen fehlgeschlagenen Versand", async () => {
    const { service } = setup(invite);
    service.invite = () => Promise.reject(new Error("x"));
    const send = await screen.findByRole("button", { name: "Einladung per Mail versenden" });
    await waitFor(() => expect(send).toBeEnabled());
    await userEvent.click(send);
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Einladung per Mail versenden",
      }),
    );
    expect(await screen.findByText("Die Einladung wurde nicht versendet.")).toBeInTheDocument();
  });

  it("ohne Adressliste lässt sich eine wählen; erst dann ist der Versand möglich", async () => {
    setup({ type: "calendar-invite", options: { key: "invite:gv", params: { eventId: "gv" } } });
    const send = await screen.findByRole("button", { name: "Einladung per Mail versenden" });
    expect(send).toBeDisabled();
    await userEvent.selectOptions(await screen.findByLabelText("Adressliste"), "g1");
    await waitFor(() => expect(send).toBeEnabled());
  });
});

describe("Teilnehmerliste (8.5)", () => {
  const list = {
    type: "calendar-participants",
    options: { key: "participants:gv", params: { eventId: "gv" } },
  };

  it("zeigt Zusammenfassung, Zusagen und Seitenwahl", async () => {
    const { container } = setup(list);
    expect(
      await screen.findByRole("heading", { name: "Teilnehmerliste Generalversammlung 2026" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText(/^Stand \d\d\.\d\d\.\d{4} um \d\d:\d\d:\d\d$/)).toBeInTheDocument();
    const summary = screen.getByText("20 Zusagen").closest("p")!;
    expect(summary).toHaveAttribute("role", "status");
    expect(summary).toHaveTextContent(
      "20 Zusagen mit 2 Begleitungen: 22 Teilnehmende. 3 Absagen, 5 ohne Rückmeldung (28 Eingeladene).",
    );
    const table = screen.getByRole("table", { name: "Zusagen" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Name", "Mitglieds-Nr.", "Gruppe", "Begleitung", "Hinweis", "Rückmeldung"]);
    // 16 Zeilen pro Seite, neueste Rückmeldung zuerst
    expect(within(table).getAllByRole("row")).toHaveLength(17);
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Person 01");
    expect(within(table).getByText("Vegetarisch")).toBeInTheDocument();
    expect(
      screen.getByText("16 von 20 Zusagen · sortiert nach Rückmeldung, absteigend"),
    ).toBeInTheDocument();
    expect(screen.getByText("Seite 1 von 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Vorherige Seite" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Nächste Seite" }));
    expect(screen.getByText("Seite 2 von 2")).toBeInTheDocument();
    expect(within(table).getAllByRole("row")).toHaveLength(5);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("sucht, filtert nach Begleitung und kehrt die Sortierung um", async () => {
    setup(list);
    const search = await screen.findByRole("searchbox", { name: "Name oder Nr. suchen" });
    await userEvent.type(search, "person 0");
    expect(
      screen.getByText("9 von 9 Zusagen · sortiert nach Rückmeldung, absteigend"),
    ).toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Begleitung" }), "with");
    expect(
      screen.getByText("2 von 2 Zusagen · sortiert nach Rückmeldung, absteigend"),
    ).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Begleitung" }), "all");
    await userEvent.click(screen.getByRole("button", { name: "Rückmeldung" }));
    expect(screen.getByText(/aufsteigend/)).toBeInTheDocument();
    expect(
      within(screen.getByRole("table", { name: "Zusagen" })).getAllByRole("row")[1],
    ).toHaveTextContent("Person 20");
  });

  it("exportiert die Liste", async () => {
    const { service } = setup(list);
    await userEvent.click(
      await screen.findByRole("button", { name: "Teilnehmerliste als .xlsx exportieren" }),
    );
    expect(service.exported).toEqual(["gv"]);
  });

  it("ohne Zusagen zeigt sie den Leerzustand", async () => {
    setup(
      { type: "calendar-participants", options: { key: "p", params: { eventId: "vorstand" } } },
      seed(),
    );
    expect(await screen.findByText("Noch keine Zusagen.")).toBeInTheDocument();
  });
});

describe("Rückmeldungen (8.6)", () => {
  const answers = {
    type: "calendar-responses",
    options: { key: "responses:gv", params: { eventId: "gv" } },
  };

  it("zeigt Übersicht mit Zahlen, Filter und Antworten mit Symbol und Text", async () => {
    const { container } = setup(answers);
    expect(
      await screen.findByRole("heading", { name: "Rückmeldungen Generalversammlung 2026" }),
    ).toBeInTheDocument();
    expect(screen.getByText("23 Antworten")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "20 Zusagen, 3 Absagen, 5 ohne Rückmeldung" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Eingeladen: 28\. Antworten: 23 \(82\s%\)\.$/)).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Rückmeldungen" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Eingegangen", "Name", "Antwort", "Begleitung", "Hinweis"]);
    expect(screen.getByText("16 von 23 · sortiert nach Eingang, absteigend")).toBeInTheDocument();
    expect(screen.getByText("Seite 1 von 2")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Antwort" }), "declined");
    const rows = within(screen.getByRole("table", { name: "Rückmeldungen" })).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(within(rows[1]!).getByText("Absage")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Bin im Ausland")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Antwort" }), "all");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Mit Hinweis" }), "with");
    expect(screen.getByText("2 von 2 · sortiert nach Eingang, absteigend")).toBeInTheDocument();
  });

  it("lässt «erneut senden» deaktiviert, solange die API es nicht kann", async () => {
    setup(answers);
    const resend = await screen.findByRole("button", {
      name: "Antwortlink an 5 Personen erneut senden",
    });
    expect(resend).toBeDisabled();
  });

  it("sendet die Antwortlinks erneut, wenn der Dienst es kann", async () => {
    const service = createMemoryCalendarService(seed());
    service.resend = () => Promise.resolve({ sent: 5, skipped: 0, failed: 0 });
    renderWithProviders(
      <TabsProvider modules={[createKalenderModule(service, NOW)]} initialType="calendar">
        <Opener type={answers.type} options={answers.options} />
        <TabPanels />
      </TabsProvider>,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Antwortlink an 5 Personen erneut senden" }),
    );
    expect(await screen.findByText("Einladung an 5 Personen versendet.")).toBeInTheDocument();
  });
});

describe("Hinweis zur Löschung nach 24 Stunden (8.7)", () => {
  const ended = {
    type: "calendar-event",
    options: { key: "event:herbst", params: { eventId: "herbst" } },
  };

  it("zeigt Frist, Ablauf, letzten Stand und was gelöscht wird", async () => {
    const { container } = setup(ended);
    expect(await screen.findByRole("heading", { name: "Herbstanlass" })).toBeInTheDocument();
    expect(screen.getByText("Wird heute gelöscht", { selector: ".badge" })).toBeInTheDocument();
    expect(
      screen.getByText("Dieser Event und alle Zu- und Absagen werden heute um 17:30 Uhr gelöscht."),
    ).toBeInTheDocument();
    const flow = screen.getByRole("region", { name: "Ablauf" });
    expect(within(flow).getByText("01.11.2026 um 17:30")).toBeInTheDocument();
    expect(within(flow).getByText("02.11.2026 um 14:41")).toBeInTheDocument();
    expect(within(flow).getByText("02.11.2026 um 17:30")).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", {
        name: "Letzter Stand: 2 Zusagen, 1 Begleitungen, 1 Absagen",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Es werden 2 von 2 Zusagen angezeigt.")).toBeInTheDocument();
    expect(screen.getByText("Event-Eintrag «Herbstanlass»")).toBeInTheDocument();
    expect(screen.getByText("3 Rückmeldungen (2 Zusagen, 1 Absagen)")).toBeInTheDocument();
    for (const kept of ["Rechnungen", "Buchhaltung", "Personen und Gruppen"]) {
      expect(screen.getByText(kept)).toBeInTheDocument();
    }
    // Die Regel gilt für jeden Event: der nächste endende ist die Generalversammlung.
    expect(
      await screen.findByText("Auch Generalversammlung 2026 wird am 15.11.2026 um 20:30 gelöscht."),
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("exportiert die Teilnehmerliste vor der Löschung", async () => {
    const { service } = setup(ended);
    await userEvent.click(
      await screen.findByRole("button", { name: "Teilnehmerliste als .xlsx exportieren" }),
    );
    expect(service.exported).toEqual(["herbst"]);
  });

  it("sagt «morgen», wenn die Löschung erst am nächsten Tag ansteht", async () => {
    const data = seed({
      events: [ev("spaet", "Spätanlass", "2026-11-02T08:00", "2026-11-02T10:00", null)],
    });
    setup({ type: "calendar-event", options: { key: "s", params: { eventId: "spaet" } } }, data);
    expect(
      await screen.findByText("Wird morgen gelöscht", { selector: ".badge" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/werden morgen um 10:00 Uhr gelöscht/)).toBeInTheDocument();
  });
});

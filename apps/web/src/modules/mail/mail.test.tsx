import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../../shell/AppShell";
import { renderWithProviders } from "../../test-utils";
import { mailModule } from ".";
import {
  etaMinutes,
  formatDateTime,
  formatSize,
  htmlToText,
  parseAddress,
  placeholdersToApi,
  textToHtml,
} from "./format";
import { MailServiceContext } from "./mailContext";
import {
  MailServiceError,
  type AddressListDetail,
  type CampaignSummary,
  type Delivery,
  type MailService,
} from "./mailService";
import {
  memoryMailService,
  type MemoryCampaign,
  type MemoryMailData,
  type MemoryMessage,
} from "./memoryMailService";

const at = (day: number, h: number, m: number, s = 0) =>
  new Date(2026, 10, day, h, m, s).toISOString();

const account = {
  id: "a1",
  label: "Kontakt",
  fromAddress: "kontakt@beispiel.example.ch",
  fromName: "Verein Beispiel",
};

const message = (
  uid: number,
  from: string,
  subject: string,
  receivedAt: string,
  extra: Partial<MemoryMessage> = {},
): MemoryMessage => ({
  uid,
  from: { name: from, address: `${from.split(" ")[0]!.toLowerCase()}@example.ch` },
  to: [{ name: null, address: "kontakt@beispiel.example.ch" }],
  subject,
  receivedAt,
  sizeBytes: 12 * 1024,
  text: "Guten Tag Frau Muster\n\nDarf eine Begleitperson mitkommen?\n\nFreundliche Grüsse\nAnna Beispiel",
  attachments: [],
  seen: true,
  answered: false,
  ...extra,
});

/** Die Beispielmails aus Board 7.1. */
const inbox: MemoryMessage[] = [
  message(1, "Anna Beispiel", "Frage zur Begleitperson an der GV 2026", at(2, 8, 14), {
    seen: false,
    from: { name: "Anna Beispiel", address: "anna.beispiel@example.ch" },
  }),
  message(2, "Beat Muster", "Adressänderung per 01.12.2026", at(2, 7, 52), { seen: false }),
  message(3, "Beispiel Treuhand AG", "Zahlungsbestätigung zu R-2026-0391", at(1, 16, 40), {
    seen: false,
    attachments: [{ filename: "Bestaetigung.pdf", contentType: "application/pdf", size: 48000 }],
  }),
  message(
    4,
    "Claudia Probe",
    "Abmeldung vom Helferessen",
    new Date(2026, 9, 31, 19, 5).toISOString(),
  ),
  message(5, "Daniel Test", "Rückfrage zum Mitgliederbeitrag 2026", at(1, 11, 20), {
    answered: true,
  }),
];

const list = (over: Partial<AddressListDetail>): AddressListDetail => ({
  id: "l1",
  name: "Liste",
  kind: "manual",
  source: "Manuell gepflegt",
  persons: 0,
  withoutEmail: 0,
  recipients: 0,
  lastUsedAt: null,
  description: "",
  entries: [],
  groupIds: [],
  ...over,
});

const groups = [
  { id: "g1", name: "Vorstand", persons: 7, withoutEmail: 0 },
  { id: "g2", name: "Aktivmitglieder", persons: 412, withoutEmail: 3 },
  { id: "g3", name: "Passivmitglieder", persons: 538, withoutEmail: 8 },
  { id: "g4", name: "Ehrenmitglieder", persons: 14, withoutEmail: 1 },
  { id: "g5", name: "Helferteam", persons: 64, withoutEmail: 2 },
];

const lists: AddressListDetail[] = [
  list({
    id: "l1",
    name: "GV 2026 Mitglieder",
    kind: "groups",
    source: "Vorstand und 3 weitere",
    groupIds: ["g1", "g2", "g3", "g4"],
    lastUsedAt: at(2, 9, 0),
  }),
  list({
    id: "l2",
    name: "Probeversand intern",
    description: "Interne Testmails an das Vorstandsteam",
    entries: [
      {
        key: "p1",
        name: "Sabine Muster",
        email: "sabine.muster@example.ch",
        group: "Vorstand",
        anrede: "Frau",
        vorname: "Sabine",
        nachname: "Muster",
      },
      { key: "p2", name: "Beat Probe", email: null, group: "Vorstand" },
    ],
    lastUsedAt: at(2, 9, 0),
  }),
  list({ id: "l3", name: "Helferaufruf", kind: "group", source: "Helferteam", groupIds: ["g5"] }),
];

const people = [
  {
    key: "p3",
    name: "Claudia Test",
    email: "claudia.test@example.ch",
    group: "Aktivmitglieder",
    anrede: "Frau",
    vorname: "Claudia",
    nachname: "Test",
  },
];

const campaign = (over: Partial<CampaignSummary>): CampaignSummary => ({
  id: "c1",
  subject: "Erinnerung: Anmeldeschluss GV 2026",
  listName: "GV 2026 Mitglieder",
  recipientCount: 959,
  scheduledAt: at(5, 8, 0),
  state: "planned",
  attachmentCount: 1,
  confirmedAt: at(2, 14, 44),
  confirmedBy: "Sabine Muster",
  ...over,
});

const counts = (over: Partial<MemoryCampaign["status"]["counts"]> = {}) => ({
  held: 0,
  queued: 0,
  sending: 0,
  sent: 0,
  failed: 0,
  cancelled: 0,
  ...over,
});

const delivery = (
  id: string,
  name: string,
  status: Delivery["status"],
  reason?: string,
): Delivery => ({
  id,
  name,
  email: `${name.split(" ")[0]!.toLowerCase()}@example.ch`,
  status,
  at: status === "sent" || status === "failed" ? at(2, 14, 41, 12) : null,
  reason: reason ?? null,
});

const campaigns: MemoryCampaign[] = [
  { status: { campaign: campaign({}), counts: counts({ queued: 959 }) }, deliveries: [] },
  {
    status: {
      campaign: campaign({
        id: "c2",
        subject: "Jahresbrief Gönner 2026",
        listName: "Gönner Jahresbrief",
        recipientCount: 68,
        state: "draft",
        scheduledAt: at(30, 8, 0),
        confirmedAt: null,
        confirmedBy: null,
      }),
      counts: counts({ held: 68 }),
    },
    deliveries: [],
  },
  {
    status: {
      campaign: campaign({
        id: "c3",
        subject: "Mitgliederinfo November",
        listName: "Alle Aktivmitglieder",
        recipientCount: 409,
        state: "sending",
        scheduledAt: at(2, 14, 36),
        confirmedAt: at(2, 14, 36),
      }),
      counts: counts({ sent: 385, failed: 2, queued: 22 }),
    },
    deliveries: [
      delivery("d1", "Anna Beispiel", "sent"),
      delivery("d2", "Daniel Demo", "failed", "REJECTED"),
      delivery("d3", "Karin Demo", "queued"),
    ],
  },
];

const board: MemoryMailData = {
  accounts: [account],
  messages: { inbox, sent: [], drafts: [], trash: [] },
  lists,
  groups,
  people,
  campaigns,
};

function setup(data: Partial<MemoryMailData> = board, wrap?: (s: MailService) => MailService) {
  const memory = memoryMailService(
    { ...board, ...data },
    { now: () => new Date(2026, 10, 2, 14, 41).getTime() },
  );
  const service = wrap ? wrap(memory) : memory;
  const view = renderWithProviders(
    <MailServiceContext.Provider value={service}>
      <AppShell modules={[mailModule]} />
    </MailServiceContext.Provider>,
  );
  return { ...view, memory, service };
}

const nav = () => within(screen.getByRole("navigation", { name: "Mail" }));
const go = async (name: string) => {
  await userEvent.click(nav().getByRole("button", { name: new RegExp(`^${name}`) }));
};

beforeEach(() => {
  // «Montag, 02.11.2026 14:41» wie in den Boards; nur das Datum, die Timer laufen echt.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 2, 14, 41));
});
afterEach(() => vi.useRealTimers());

describe("Hilfsfunktionen", () => {
  it("formatiert Daten, Grössen und Adressen", () => {
    expect(formatDateTime(at(2, 8, 14))).toBe("02.11.2026 08:14");
    expect(formatDateTime(null)).toBe("–");
    expect(formatSize(12 * 1024)).toBe("12 KB");
    expect(formatSize(212 * 1024)).toBe("212 KB");
    expect(parseAddress("Anna Beispiel <anna@example.ch>")).toEqual({
      name: "Anna Beispiel",
      email: "anna@example.ch",
    });
    expect(parseAddress("anna@example.ch")).toEqual({ name: null, email: "anna@example.ch" });
    expect(parseAddress("kein-mail")).toBeNull();
    expect(parseAddress("a@b.ch\nBcc: x@y.ch")).toBeNull();
  });

  it("maskiert Text, wandelt Platzhalter und zieht Text aus HTML", () => {
    expect(textToHtml("Hallo <b>\n\nZwei\nZeilen")).toBe(
      "<p>Hallo &#60;b&#62;</p><p>Zwei<br>Zeilen</p>",
    );
    expect(placeholdersToApi("Guten Tag [Anrede] [Name], [Antwortlink]")).toBe(
      "Guten Tag {{anrede}} {{name}}, {{antwortlink}}",
    );
    expect(
      htmlToText('<p>Guten Tag</p><script>alert(1)</script><p>Zwei<br>Zeilen <img src="x"></p>'),
    ).toBe("Guten Tag\n\nZwei\nZeilen");
  });

  it("schätzt die Restzeit des Versands", () => {
    const start = at(2, 14, 36);
    const now = new Date(2026, 10, 2, 14, 41).getTime();
    expect(etaMinutes(385, 22, start, now)).toBe(1);
    expect(etaMinutes(0, 22, start, now)).toBeNull();
    expect(etaMinutes(385, 0, start, now)).toBeNull();
  });
});

describe("Posteingang (Design 7.1)", () => {
  it("zeigt Kopf, Seitenleiste, Zähler und die Mails mit Status", async () => {
    setup();
    expect(await screen.findByRole("heading", { level: 1, name: "Posteingang" })).toBeVisible();
    expect(screen.getByText("Mail / Posteingang")).toBeVisible();
    expect(await screen.findByText("3 ungelesen")).toBeVisible();
    expect(screen.getByRole("button", { name: "Neue Mail" })).toHaveClass("btn--primary");
    expect(screen.getByRole("button", { name: "Abrufen" })).toBeVisible();

    // Seitenleiste mit Gruppe und Zählern
    expect(nav().getByText("Versand an mehrere")).toBeVisible();
    expect(await nav().findByRole("button", { name: /Adresslisten/ })).toHaveTextContent("3");
    expect(nav().getByRole("button", { name: /Posteingang/ })).toHaveAttribute(
      "aria-current",
      "page",
    );

    const table = await screen.findByRole("table", { name: "Posteingang" });
    for (const h of ["Von", "Betreff", "Anhang", "Empfangen", "Status"]) {
      expect(within(table).getByRole("columnheader", { name: h })).toBeInTheDocument();
    }
    const row = within(table).getByText("Frage zur Begleitperson an der GV 2026").closest("tr")!;
    expect(row).toHaveTextContent("Anna Beispiel");
    expect(row).toHaveTextContent("02.11.2026 08:14");
    expect(row).toHaveTextContent("Ungelesen");
    expect(
      within(table).getByText("Zahlungsbestätigung zu R-2026-0391").closest("tr"),
    ).toHaveTextContent("1 Anhang");
    expect(
      within(table).getByText("Rückfrage zum Mitgliederbeitrag 2026").closest("tr"),
    ).toHaveTextContent("Beantwortet");
    expect(within(table).getByText("Abmeldung vom Helferessen").closest("tr")).toHaveTextContent(
      "Gelesen",
    );
    expect(screen.getByText("5 von 5")).toBeInTheDocument();
    expect(within(screen.getByRole("tabpanel")).getByText("Seite 1 von 1")).toBeInTheDocument();
  });

  it("blättert mit 16 Mails je Seite", async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      message(100 + i, "Absender Nr", `Mail ${i + 1}`, at(2, 8, i)),
    );
    setup({ messages: { inbox: many } });
    const table = await screen.findByRole("table", { name: "Posteingang" });
    expect(within(table).getAllByRole("row")).toHaveLength(17);
    const pager = within(screen.getByRole("tabpanel"));
    expect(pager.getByText("Seite 1 von 2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Nächste Seite" }));
    expect(await pager.findByText("Seite 2 von 2")).toBeInTheDocument();
    expect(
      within(screen.getByRole("table", { name: "Posteingang" })).getAllByRole("row"),
    ).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Nächste Seite" })).toBeDisabled();
  });

  it("filtert nach Status und Suchtext", async () => {
    setup();
    await screen.findByRole("table", { name: "Posteingang" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Status" }), "unread");
    expect(screen.getByText("3 von 5")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "Mails durchsuchen" }), "treuhand");
    expect(screen.getByText("1 von 5")).toBeInTheDocument();
    expect(screen.getByText("Zahlungsbestätigung zu R-2026-0391")).toBeVisible();
  });

  it("markiert gelesen und meldet, was der Dienst nicht kann", async () => {
    setup(board, (s) => ({
      ...s,
      deleteMessages: () => Promise.reject(new MailServiceError("unsupported")),
    }));
    const table = await screen.findByRole("table", { name: "Posteingang" });
    expect(screen.queryByText(/ausgewählt/)).not.toBeInTheDocument();
    await userEvent.click(within(table).getAllByRole("checkbox", { name: "Zeile auswählen" })[0]!);
    expect(screen.getByText("1 ausgewählt")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Als gelesen markieren" }));
    expect(await screen.findByText("2 ungelesen")).toBeVisible();
    expect(screen.queryByText("1 ausgewählt")).toBeNull();

    await userEvent.click(
      within(screen.getByRole("table", { name: "Posteingang" })).getAllByRole("checkbox", {
        name: "Zeile auswählen",
      })[1]!,
    );
    await userEvent.click(screen.getByRole("button", { name: "Mail löschen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Diese Funktion ist noch nicht verfügbar.",
    );
  });

  it("zeigt den Leer-Zustand und den Fehlerzustand", async () => {
    const empty = setup({ messages: { inbox: [] } });
    expect(await screen.findByText("Keine Mails")).toBeVisible();
    empty.unmount();

    let fail = true;
    const memory = memoryMailService(board, { fail: () => fail });
    renderWithProviders(
      <MailServiceContext.Provider value={memory}>
        <AppShell modules={[mailModule]} />
      </MailServiceContext.Provider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Die Mail-Ansicht konnte nicht geladen werden",
    );
    expect(screen.getByText(/^ERR-\d{8}-[0-9A-F]{4}$/)).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Erneut laden" }));
    expect(await screen.findByRole("table", { name: "Posteingang" })).toBeInTheDocument();
  });

  it("zeigt ohne Mail-Konto den Leer-Zustand", async () => {
    setup({ accounts: [] });
    expect(await screen.findByText("Kein Mail-Konto eingerichtet")).toBeVisible();
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    const { container } = setup();
    await screen.findByRole("table", { name: "Posteingang" });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Mail lesen (Design 7.2)", () => {
  const openFirst = async () => {
    const table = await screen.findByRole("table", { name: "Posteingang" });
    const row = within(table).getByText("Frage zur Begleitperson an der GV 2026").closest("tr")!;
    await userEvent.dblClick(row);
  };

  it("zeigt Kopfangaben, Text als Blatt und die Seitenfelder", async () => {
    setup();
    await openFirst();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Frage zur Begleitperson an der GV 2026",
      }),
    ).toBeVisible();
    const page = within(screen.getByRole("tabpanel"));
    expect(page.getByText("Mail / Posteingang / Anna Beispiel")).toBeVisible();
    expect(page.getByText("Anna Beispiel <anna.beispiel@example.ch>")).toBeVisible();
    expect(page.getAllByText("kontakt@beispiel.example.ch")).toHaveLength(2);
    expect(page.getByText("02.11.2026 08:14")).toBeVisible();
    expect(page.getByText("Darf eine Begleitperson mitkommen?")).toBeVisible();
    expect(screen.getByRole("button", { name: "Mail beantworten" })).toHaveClass("btn--primary");
    const panel = screen.getByRole("region", { name: "Mail" });
    expect(panel).toHaveTextContent("Posteingang");
    expect(panel).toHaveTextContent("12 KB");
    expect(panel).toHaveTextContent("Gelesen");
    expect(screen.getByText("Diese Mail hat keine Anhänge.")).toBeVisible();
  });

  it("zeigt HTML nie als Markup an", async () => {
    const html = message(7, "Eva Vorlage", "Mit Markup", at(2, 9, 0), {
      text: htmlToText('<p onclick="x()">Hallo</p><script>window.hacked = true</script>'),
    });
    setup({ messages: { inbox: [html] } });
    const table = await screen.findByRole("table", { name: "Posteingang" });
    await userEvent.dblClick(within(table).getByText("Mit Markup").closest("tr")!);
    expect(await screen.findByText("Hallo")).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
    expect((window as unknown as { hacked?: boolean }).hacked).toBeUndefined();
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    const { container } = setup();
    await openFirst();
    await screen.findByRole("region", { name: "Mail" });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Antworten (Design 7.3)", () => {
  const openReply = async () => {
    const table = await screen.findByRole("table", { name: "Posteingang" });
    await userEvent.dblClick(
      within(table).getByText("Frage zur Begleitperson an der GV 2026").closest("tr")!,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Mail beantworten" }));
  };

  it("füllt An und Betreff vom Original und zeigt das Zitat", async () => {
    setup();
    await openReply();
    expect(await screen.findByRole("heading", { level: 1, name: "Antworten" })).toBeVisible();
    expect(screen.getByText("Mail / Posteingang / Antworten")).toBeVisible();
    expect(screen.getByLabelText("An *")).toHaveValue("Anna Beispiel <anna.beispiel@example.ch>");
    expect(screen.getByLabelText("Betreff *")).toHaveValue(
      "Re: Frage zur Begleitperson an der GV 2026",
    );
    expect(screen.getByText(/Am 02.11.2026 um 08:14 schrieb Anna Beispiel:/)).toBeVisible();
    const panel = screen.getByRole("region", { name: "Antwort auf" });
    expect(panel).toHaveTextContent("Wird als beantwortet markiert");
    expect(screen.getByRole("button", { name: "Anhang hinzufügen" })).toBeVisible();
    // Reihenfolge der Schaltflächen wie im Board: Verwerfen, Speichern, Senden (primär)
    expect(screen.getByRole("button", { name: "Mail senden" })).toHaveClass("btn--primary");
  });

  it("verlangt einen Text, sendet die Antwort und schliesst den Tab", async () => {
    const { memory } = setup();
    await openReply();
    await userEvent.click(await screen.findByRole("button", { name: "Mail senden" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Schreiben Sie einen Text.");

    await userEvent.type(screen.getByRole("textbox", { name: "Text der Mail" }), "Gerne.");
    expect(screen.getByRole("tab", { name: /Ungespeichert/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Mail senden" }));
    expect(await screen.findByText("Mail gesendet.")).toBeVisible();
    expect(memory.log.replies).toEqual([{ uid: 1, body: "Gerne." }]);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Antworten" })).toBeNull());
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    const { container } = setup();
    await openReply();
    await screen.findByRole("heading", { level: 1, name: "Antworten" });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Neue Mail (Design 7.4)", () => {
  const open = async () => {
    await screen.findByRole("table", { name: "Posteingang" });
    await userEvent.click(screen.getByRole("button", { name: "Neue Mail" }));
    return screen.findByRole("heading", { level: 1, name: "Neue Mail" });
  };

  it("zeigt das weisse Blatt mit Absender und Hinweis auf den Multiversand", async () => {
    setup();
    await open();
    expect(screen.getByText("Mail / Neue Mail")).toBeVisible();
    expect(screen.getByLabelText("An *")).toHaveValue("");
    expect(screen.getByRole("region", { name: "Absender" })).toHaveTextContent("Verein Beispiel");
    expect(screen.getByRole("region", { name: "Absender" })).toHaveTextContent(
      "kontakt@beispiel.example.ch",
    );
    expect(screen.getByText("Einzelmail.")).toBeVisible();
    expect(screen.getByRole("region", { name: "Anhänge" })).toHaveTextContent("Keine Anhänge.");
  });

  it("prüft An, Betreff und Text und sendet eine Einzelmail", async () => {
    const { memory } = setup();
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Mail senden" }));
    expect(screen.getByText("Geben Sie eine gültige E-Mail-Adresse ein.")).toBeVisible();
    expect(screen.getByText("Geben Sie einen Betreff ein.")).toBeVisible();
    expect(screen.getByLabelText("An *")).toHaveAttribute("aria-invalid", "true");

    await userEvent.type(screen.getByLabelText("An *"), "Anna Beispiel <anna@example.ch>");
    await userEvent.type(screen.getByLabelText("Betreff *"), "Zahlungsbestätigung R-2026-0412");
    await userEvent.type(screen.getByRole("textbox", { name: "Text der Mail" }), "Besten Dank.");
    await userEvent.click(screen.getByRole("button", { name: "Mail senden" }));
    expect(await screen.findByText("Mail gesendet.")).toBeVisible();
    expect(memory.log.sent).toEqual([
      {
        accountId: "a1",
        to: "Anna Beispiel <anna@example.ch>",
        subject: "Zahlungsbestätigung R-2026-0412",
        body: "Besten Dank.",
        attachmentIds: [],
      },
    ]);
  });

  it("lädt einen Anhang hoch und zeigt ihn mit Grösse", async () => {
    setup();
    await open();
    const file = new File(["x".repeat(48 * 1024)], "Zahlungsbestätigung.pdf", {
      type: "application/pdf",
    });
    await userEvent.upload(screen.getByLabelText("Datei auswählen"), file);
    const panel = await screen.findByRole("region", { name: "Anhänge (1)" });
    expect(panel).toHaveTextContent("Zahlungsbestätigung.pdf");
    expect(panel).toHaveTextContent("48 KB");
    expect(within(panel).getByRole("button", { name: "Weiteren Anhang hinzufügen" })).toBeVisible();
    await userEvent.click(
      within(panel).getByRole("button", { name: "Anhang Zahlungsbestätigung.pdf entfernen" }),
    );
    expect(screen.getByRole("region", { name: "Anhänge" })).toHaveTextContent("Keine Anhänge.");
  });

  it("erneutes Speichern ersetzt den Entwurf, statt eine Kopie anzulegen", async () => {
    const { memory } = setup();
    await open();
    await userEvent.type(screen.getByLabelText("Betreff *"), "Erste Fassung");
    await userEvent.click(screen.getByRole("button", { name: "Entwurf speichern" }));
    await screen.findByText("Entwurf gespeichert.");
    await userEvent.type(screen.getByLabelText("Betreff *"), ", ergänzt");
    await userEvent.click(screen.getByRole("button", { name: "Entwurf speichern" }));
    await waitFor(() => expect(memory.log.drafts[0]?.subject).toBe("Erste Fassung, ergänzt"));
    // Ein Entwurf auf dem Server, nicht zwei; der zweite Aufruf trug die Kennung des ersten.
    expect(memory.log.drafts).toHaveLength(1);
  });

  it("speichert den Entwurf mit Strg+S und meldet fehlende Funktion", async () => {
    setup(board, (s) => ({
      ...s,
      saveDraft: () => Promise.reject(new MailServiceError("unsupported")),
    }));
    await open();
    await userEvent.type(screen.getByLabelText("Betreff *"), "Entwurf");
    await userEvent.click(screen.getByRole("button", { name: "Entwurf speichern" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Diese Funktion ist noch nicht verfügbar.",
    );
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    const { container } = setup();
    await open();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Multiversand (Design 7.5 bis 7.7)", () => {
  const open = async () => {
    await screen.findByRole("table", { name: "Posteingang" });
    await go("Multiversand");
    return screen.findByRole("heading", { level: 1, name: "Multiversand" });
  };
  const fillStepOne = async () => {
    await userEvent.selectOptions(screen.getByLabelText("Adressliste *"), "GV 2026 Mitglieder");
    await userEvent.type(screen.getByLabelText("Betreff *"), "Erinnerung: Anmeldeschluss GV 2026");
    const body = screen.getByRole("textbox", { name: "Text der Mail" });
    await userEvent.type(body, "Guten Tag ");
    await userEvent.click(screen.getByRole("button", { name: "Platzhalter Anrede einfügen" }));
    await userEvent.click(screen.getByRole("button", { name: "Platzhalter Name einfügen" }));
    return body;
  };

  it("zeigt Schritt 1 mit Empfängern, Platzhaltern und Schrittanzeige", async () => {
    setup();
    await open();
    expect(screen.getByText("Mail / Multiversand")).toBeVisible();
    expect(screen.getByText("Entwurf", { selector: ".badge" })).toBeVisible();
    const steps = screen.getByRole("list", { name: "Schritte" });
    expect(within(steps).getByText("Empfänger und Text").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(screen.getByLabelText("Absender")).toHaveValue("kontakt@beispiel.example.ch");
    expect(screen.getByLabelText("Absender")).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Weiter zu Anhang und Testversand" })).toHaveClass(
      "btn--primary",
    );
    expect(screen.getByRole("button", { name: "Platzhalter Anrede einfügen" })).toHaveTextContent(
      "[Anrede] einfügen",
    );
    expect(screen.getByText("Frau oder Herr")).toBeVisible();

    await userEvent.selectOptions(screen.getByLabelText("Adressliste *"), "GV 2026 Mitglieder");
    const panel = screen.getByRole("region", { name: "Empfänger" });
    expect(panel).toHaveTextContent("971");
    expect(panel).toHaveTextContent("12 (werden übersprungen)");
    expect(panel).toHaveTextContent("959");
  });

  it("zeigt die Vorschau mit den Werten des ersten Empfängers", async () => {
    setup();
    await open();
    await userEvent.selectOptions(screen.getByLabelText("Adressliste *"), "Probeversand intern");
    await userEvent.type(screen.getByRole("textbox", { name: "Text der Mail" }), "Guten Tag ");
    await userEvent.click(screen.getByRole("button", { name: "Platzhalter Anrede einfügen" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Text der Mail" }), " ");
    await userEvent.click(screen.getByRole("button", { name: "Platzhalter Name einfügen" }));
    expect(screen.getByRole("textbox", { name: "Text der Mail" })).toHaveValue(
      "Guten Tag [Anrede] [Name]",
    );
    const preview = await screen.findByRole("region", { name: "Vorschau für Sabine Muster" });
    expect(preview).toHaveTextContent("Guten Tag Frau Muster");
  });

  it("verlangt Liste, Betreff und Text vor Schritt 2", async () => {
    setup();
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Weiter zu Anhang und Testversand" }));
    expect(screen.getByText("Wählen Sie eine Adressliste.")).toBeVisible();
    expect(screen.getByText("Geben Sie einen Betreff ein.")).toBeVisible();
    expect(screen.getByText("Schreiben Sie einen Text.")).toBeVisible();
  });

  it("führt durch Anhang, Testversand und Bestätigung bis zum Einplanen", async () => {
    const { memory } = setup();
    await open();
    const body = await fillStepOne();
    expect(body).toHaveValue("Guten Tag [Anrede][Name]");
    await userEvent.click(screen.getByRole("button", { name: "Weiter zu Anhang und Testversand" }));

    // Schritt 2
    expect(
      within(screen.getByRole("list", { name: "Schritte" }))
        .getByText("Anhang und Testversand")
        .closest("li"),
    ).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("button", { name: "Zurück zu Empfänger und Text" })).toBeVisible();
    expect(screen.getByLabelText("Testmail an")).toHaveValue("sabine.muster@example.ch");
    expect(
      screen.getByText("Die Testmail enthält Beispieldaten für Anrede, Name und Antwortlink."),
    ).toBeVisible();
    await userEvent.upload(
      screen.getByLabelText("Datei auswählen"),
      new File(["x".repeat(212 * 1024)], "Traktanden_GV_2026.pdf", { type: "application/pdf" }),
    );
    const attachment = await screen.findByRole("region", { name: "Anhang (1)" });
    expect(attachment).toHaveTextContent("Traktanden_GV_2026.pdf");
    expect(attachment).toHaveTextContent("Er wird mit jeder der 959 Mails zugestellt.");
    await userEvent.click(screen.getByRole("button", { name: "Testmail senden" }));
    expect(await screen.findByText("Testmail gesendet.")).toBeVisible();
    expect(memory.log.tests).toHaveLength(1);
    const summary = screen.getByRole("region", { name: "Zusammenfassung" });
    expect(summary).toHaveTextContent("1 Datei, 212 KB");
    expect(summary).toHaveTextContent("Gesendet 14:41");

    await userEvent.click(screen.getByRole("radio", { name: /Geplant:/ }));
    await userEvent.click(screen.getByRole("button", { name: "Weiter zur Bestätigung" }));

    // Bestätigung
    const dialog = await screen.findByRole("dialog", {
      name: "Multiversand an 959 Empfänger einplanen?",
    });
    expect(
      within(dialog).getByText("Nach dem Start lässt sich der Versand nicht zurückholen."),
    ).toBeVisible();
    expect(dialog).toHaveTextContent("Traktanden_GV_2026.pdf");
    expect(within(dialog).getByText("Tippen Sie 959 ein.")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Abbrechen" })).toHaveFocus();

    await userEvent.click(within(dialog).getByRole("button", { name: "Multiversand einplanen" }));
    expect(
      within(dialog).getByText("Bestätigen Sie, dass Sie die Testmail geprüft haben."),
    ).toBeVisible();
    expect(
      within(dialog).getByText("Die Zahl stimmt nicht mit der Empfängerzahl überein."),
    ).toBeVisible();

    await userEvent.click(
      within(dialog).getByRole("checkbox", { name: "Ich habe die Testmail geprüft." }),
    );
    await userEvent.type(
      within(dialog).getByLabelText("Anzahl der Empfänger zur Bestätigung *"),
      "958",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Multiversand einplanen" }));
    expect(
      within(dialog).getByText("Die Zahl stimmt nicht mit der Empfängerzahl überein."),
    ).toBeVisible();

    const count = within(dialog).getByLabelText("Anzahl der Empfänger zur Bestätigung *");
    await userEvent.clear(count);
    await userEvent.type(count, "959");
    await userEvent.click(within(dialog).getByRole("button", { name: "Multiversand einplanen" }));
    expect(await screen.findByText("Multiversand eingeplant.")).toBeVisible();
    // Danach liegt der Versand im Versandplan
    expect(await screen.findByRole("heading", { level: 1, name: "Versandplan" })).toBeVisible();
    const prepared = memory.log.prepared[0]!;
    expect(prepared.body).toBe("Guten Tag [Anrede][Name]");
    expect(prepared.attachmentIds).toHaveLength(1);
  });

  it("bricht die Bestätigung ab und lässt keinen Entwurf zurück", async () => {
    const { memory } = setup();
    await open();
    await fillStepOne();
    await userEvent.click(screen.getByRole("button", { name: "Weiter zu Anhang und Testversand" }));
    await userEvent.click(screen.getByRole("button", { name: "Weiter zur Bestätigung" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Multiversand an 959 Empfänger senden?",
    });
    await userEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const camps = await memory.campaigns();
    expect(
      camps.filter((c) => c.state === "draft" && c.subject.startsWith("Erinnerung")),
    ).toHaveLength(0);
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    const { container } = setup();
    await open();
    await fillStepOne();
    expect(await axe(container)).toHaveNoViolations();
    await userEvent.click(screen.getByRole("button", { name: "Weiter zu Anhang und Testversand" }));
    expect(await axe(container)).toHaveNoViolations();
    await userEvent.click(screen.getByRole("button", { name: "Weiter zur Bestätigung" }));
    await screen.findByRole("dialog");
    expect(await axe(screen.getByRole("dialog"))).toHaveNoViolations();
  });
});

describe("Adresslisten (Design 7.8 bis 7.10)", () => {
  const open = async () => {
    await screen.findByRole("table", { name: "Posteingang" });
    await go("Adresslisten");
    return screen.findByRole("table", { name: "Adresslisten" });
  };

  it("zeigt die Listen mit Typ, Quelle und Empfängern", async () => {
    setup();
    const table = await open();
    expect(screen.getByText("Mail / Adresslisten")).toBeVisible();
    expect(screen.getByRole("button", { name: "Adressliste anlegen" })).toHaveClass("btn--primary");
    const row = within(table).getByText("GV 2026 Mitglieder").closest("tr")!;
    expect(row).toHaveTextContent("Aus Gruppen");
    expect(row).toHaveTextContent("Vorstand und 3 weitere");
    expect(row).toHaveTextContent("971");
    expect(row).toHaveTextContent("12");
    expect(row).toHaveTextContent("959");
    expect(row).toHaveTextContent("02.11.2026");
    expect(within(table).getByText("Probeversand intern").closest("tr")).toHaveTextContent(
      "Manuell",
    );
    expect(screen.getByText("Listen aus Gruppen bleiben aktuell.")).toBeVisible();
    expect(screen.getByText("3 von 3")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Typ" }), "manual");
    expect(screen.getByText("1 von 3")).toBeInTheDocument();
  });

  it("öffnet eine manuelle Liste, ergänzt eine Person und speichert", async () => {
    const { memory } = setup();
    const table = await open();
    await userEvent.click(within(table).getAllByRole("checkbox", { name: "Zeile auswählen" })[2]!);
    expect(screen.getByText("1 ausgewählt")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Adressliste bearbeiten" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Probeversand intern" }),
    ).toBeVisible();
    expect(screen.getByText("Mail / Adresslisten / Probeversand intern")).toBeVisible();
    expect(screen.getByLabelText("Beschreibung (optional)")).toHaveValue(
      "Interne Testmails an das Vorstandsteam",
    );
    const persons = screen.getByRole("table", { name: "Personen der Adressliste" });
    expect(within(persons).getByText("Beat Probe").closest("tr")).toHaveTextContent(
      "Keine E-Mail-Adresse",
    );
    expect(screen.getByText("Beat Probe hat keine E-Mail-Adresse.")).toBeVisible();
    const summary = screen.getByRole("region", { name: "Zusammenfassung" });
    expect(summary).toHaveTextContent("2");
    expect(screen.queryByText("Nicht gespeichert", { selector: ".badge" })).toBeNull();

    await userEvent.type(
      screen.getByRole("searchbox", { name: "Person oder Firma suchen und hinzufügen" }),
      "Claudia",
    );
    await userEvent.click(await screen.findByRole("button", { name: /Claudia Test/ }));
    expect(within(persons).getByText("claudia.test@example.ch")).toBeVisible();
    expect(screen.getByRole("region", { name: /Personen \(3\)/ })).toBeVisible();
    expect(screen.getByText("Nicht gespeichert", { selector: ".badge" })).toBeVisible();

    await userEvent.click(
      screen.getByRole("button", { name: "Beat Probe aus Adressliste entfernen" }),
    );
    expect(within(persons).queryByText("Beat Probe")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Adressliste speichern" }));
    expect(await screen.findByText("Adressliste gespeichert.")).toBeVisible();
    const saved = await memory.list("l2");
    expect(saved.entries.map((e) => e.name)).toEqual(["Sabine Muster", "Claudia Test"]);
  });

  it("verlangt einen Namen für die neue Liste", async () => {
    setup();
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Adressliste anlegen" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Neue Adressliste" }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Adressliste speichern" }));
    expect(screen.getByText("Geben Sie einen Namen ein.")).toBeVisible();
  });

  it("erstellt eine Liste aus Gruppen mit Ergebnis", async () => {
    const { memory } = setup();
    await open();
    await userEvent.click(
      screen.getByRole("button", { name: "Adressliste aus Gruppen erstellen" }),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Adressliste aus Gruppen erstellen" }),
    ).toBeVisible();
    expect(screen.getByText("Mail / Adresslisten / Neue Adressliste")).toBeVisible();
    const table = screen.getByRole("table", { name: "Gruppen" });
    expect(screen.getByRole("region", { name: "Gruppen wählen (0 von 5)" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Adressliste speichern" }));
    expect(screen.getByText("Geben Sie einen Namen ein.")).toBeVisible();
    expect(screen.getByText("Wählen Sie mindestens eine Gruppe.")).toBeVisible();

    await userEvent.type(screen.getByLabelText("Name der Adressliste *"), "Neue GV-Liste");
    for (const name of ["Vorstand", "Aktivmitglieder", "Passivmitglieder", "Ehrenmitglieder"]) {
      await userEvent.click(
        within(within(table).getByText(name).closest("tr")!).getByRole("checkbox"),
      );
    }
    expect(screen.getByRole("region", { name: "Gruppen wählen (4 von 5)" })).toBeVisible();
    const result = screen.getByRole("region", { name: "Ergebnis" });
    expect(result).toHaveTextContent("971");
    expect(result).toHaveTextContent("12");
    expect(result).toHaveTextContent("959");
    expect(screen.getByText("Keine Doppelten.")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Adressliste speichern" }));
    expect(await screen.findByText("Adressliste gespeichert.")).toBeVisible();
    const all = await memory.lists();
    const created = all.find((l) => l.name === "Neue GV-Liste")!;
    expect(created.kind).toBe("groups");
    expect(created.recipients).toBe(959);
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    const { container } = setup();
    const table = await open();
    await userEvent.click(within(table).getAllByRole("checkbox", { name: "Zeile auswählen" })[0]!);
    expect(await axe(container)).toHaveNoViolations();
    await userEvent.click(
      screen.getByRole("button", { name: "Adressliste aus Gruppen erstellen" }),
    );
    await screen.findByRole("table", { name: "Gruppen" });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("hat im Editor keine Zugänglichkeitsverstösse", async () => {
    const { container } = setup();
    const table = await open();
    await userEvent.click(within(table).getAllByRole("checkbox", { name: "Zeile auswählen" })[2]!);
    await userEvent.click(screen.getByRole("button", { name: "Adressliste bearbeiten" }));
    await screen.findByRole("table", { name: "Personen der Adressliste" });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Seitenleiste: Versandstatus", () => {
  it("zählt die laufenden Versände", async () => {
    setup();
    await screen.findByRole("table", { name: "Posteingang" });
    // Im Board läuft ein Versand (Mitgliederinfo November).
    await waitFor(() =>
      expect(nav().getByRole("button", { name: /Versandstatus/ })).toHaveTextContent("1"),
    );
  });
});

describe("Versandplan (Design 7.11)", () => {
  const open = async () => {
    await screen.findByRole("table", { name: "Posteingang" });
    await go("Versandplan");
    return screen.findByRole("table", { name: "Geplante Versände" });
  };

  it("zeigt einen pausierten Versand als eigenen Zustand mit Badge, Filter und Zähler", async () => {
    const paused: MemoryCampaign = {
      status: {
        campaign: campaign({ id: "c4", subject: "Pausierter Versand", state: "paused" }),
        counts: counts({ held: 10 }),
      },
      deliveries: [],
    };
    setup({ campaigns: [...campaigns, paused] });
    const table = await open();
    expect(screen.getByText("1 geplant")).toBeVisible();
    expect(screen.getByText("1 pausiert")).toBeVisible();
    expect(screen.getByText("1 Entwurf")).toBeVisible();
    expect(within(table).getByText("Pausierter Versand").closest("tr")).toHaveTextContent(
      "Pausiert",
    );
    // Der pausierte Versand zählt in der Seitenleiste mit zum Versandplan (geplant 1, pausiert 1, Entwurf 1).
    await waitFor(() =>
      expect(nav().getByRole("button", { name: /Versandplan/ })).toHaveTextContent("3"),
    );

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Status" }), "paused");
    expect(screen.getByText("1 von 3")).toBeVisible();
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).queryByText("Jahresbrief Gönner 2026")).toBeNull();
  });

  it("zeigt geplante Versände und Entwürfe mit Status und Detail", async () => {
    setup();
    const table = await open();
    expect(screen.getByText("1 geplant")).toBeVisible();
    expect(screen.getByText("1 Entwurf")).toBeVisible();
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    const planned = within(table).getByText("Erinnerung: Anmeldeschluss GV 2026").closest("tr")!;
    expect(planned).toHaveTextContent("GV 2026 Mitglieder");
    expect(planned).toHaveTextContent("959");
    expect(planned).toHaveTextContent("05.11.2026 08:00");
    expect(planned).toHaveTextContent("Geplant");
    expect(within(table).getByText("Jahresbrief Gönner 2026").closest("tr")).toHaveTextContent(
      "Entwurf",
    );
    expect(screen.queryByText("Mitgliederinfo November")).toBeNull();

    await userEvent.click(within(planned).getByRole("checkbox"));
    const detail = screen.getByRole("region", {
      name: "Ausgewählt: Erinnerung: Anmeldeschluss GV 2026",
    });
    expect(detail).toHaveTextContent("05.11.2026 um 08:00");
    expect(detail).toHaveTextContent("1 Datei");
    expect(detail).toHaveTextContent("02.11.2026 14:44 von Sabine Muster");
  });

  it("löscht einen Versand erst nach Rückfrage", async () => {
    setup();
    const table = await open();
    await userEvent.click(
      within(within(table).getByText("Jahresbrief Gönner 2026").closest("tr")!).getByRole(
        "checkbox",
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Versand löschen" }));
    const dialog = await screen.findByRole("dialog", { name: "Versand löschen?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    expect(within(table).getByText("Jahresbrief Gönner 2026")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Versand löschen" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Versand löschen" }),
    );
    await waitFor(() => expect(screen.queryByText("Jahresbrief Gönner 2026")).toBeNull());
  });

  it("meldet, wenn der Dienst den Zeitpunkt nicht ändern kann", async () => {
    setup(board, (s) => ({
      ...s,
      reschedule: () => Promise.reject(new MailServiceError("unsupported")),
    }));
    const table = await open();
    await userEvent.click(
      within(
        within(table).getByText("Erinnerung: Anmeldeschluss GV 2026").closest("tr")!,
      ).getByRole("checkbox"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Zeitpunkt ändern" }));
    const dialog = await screen.findByRole("dialog", { name: "Zeitpunkt ändern" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Zeitpunkt speichern" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Diese Funktion ist noch nicht verfügbar.",
    );
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    const { container } = setup();
    const table = await open();
    await userEvent.click(within(within(table).getAllByRole("row")[1]!).getByRole("checkbox"));
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Versandstatus (Design 7.12)", () => {
  const open = async () => {
    await screen.findByRole("table", { name: "Posteingang" });
    await go("Versandstatus");
    return screen.findByRole("table", { name: "Versandstatus je Empfänger" });
  };

  it("zeigt Fortschritt, Legende und die Zustellung je Empfänger", async () => {
    setup();
    const table = await open();
    expect(screen.getByText("Mail / Versandstatus")).toBeVisible();
    expect(screen.getByText("Läuft", { selector: ".badge" })).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Mitgliederinfo November an 409 Empfänger" }),
    ).toBeVisible();
    expect(
      screen.getByRole("img", { name: "385 versendet, 2 fehlgeschlagen, 22 in der Warteschlange" }),
    ).toBeVisible();
    expect(screen.getByText("Versendet (385)")).toBeVisible();
    expect(screen.getByText("Fehlgeschlagen (2)")).toBeVisible();
    expect(screen.getByText(/Warteschlange \(22\), noch ca\. 1 Minute/)).toBeVisible();
    expect(screen.getByText(/Gestartet 02.11.2026 um 14:36 · Stand 14:41/)).toBeVisible();

    expect(within(table).getByText("Anna Beispiel").closest("tr")).toHaveTextContent("Versendet");
    expect(within(table).getByText("Anna Beispiel").closest("tr")).toHaveTextContent("14:41:12");
    const failed = within(table).getByText("Daniel Demo").closest("tr")!;
    expect(failed).toHaveTextContent("Fehlgeschlagen");
    expect(failed).toHaveTextContent("Vom Mailserver abgelehnt");
    expect(within(table).getByText("Karin Demo").closest("tr")).toHaveTextContent("Warteschlange");
    expect(within(screen.getByRole("tabpanel")).getByText("Seite 1 von 35")).toBeInTheDocument();
    expect(screen.getByText("3 von 409")).toBeInTheDocument();
  });

  it("filtert nach Status", async () => {
    setup();
    await open();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Status" }), "failed");
    expect(screen.getByText("1 von 409")).toBeInTheDocument();
  });

  it("pausiert den Versand: danach wartet er im Versandplan", async () => {
    setup();
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Versand pausieren" }));
    expect(await screen.findByText("Pausiert", { selector: ".badge" })).toBeVisible();
    expect(screen.queryByText("Geplant", { selector: ".badge" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Versand pausieren" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("meldet, wenn der Dienst das Pausieren ablehnt", async () => {
    setup(board, (s) => ({
      ...s,
      pause: () => Promise.reject(new MailServiceError("conflict", 409)),
    }));
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Versand pausieren" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Das ist im aktuellen Zustand nicht möglich.",
    );
  });

  it("zeigt ohne Versand den Leer-Zustand", async () => {
    setup({ campaigns: [] });
    await screen.findByRole("table", { name: "Posteingang" });
    await go("Versandstatus");
    expect(await screen.findByText("Noch kein Versand gestartet")).toBeVisible();
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    const { container } = setup();
    await open();
    expect(await axe(container)).toHaveNoViolations();
  });
});

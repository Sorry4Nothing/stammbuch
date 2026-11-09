import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { describe, expect, it, vi } from "vitest";
import type { AuthService } from "../../auth/auth";
import { AppShell } from "../../shell/AppShell";
import { renderWithProviders, testSession } from "../../test-utils";
import { startModule } from "../start";
import { chefAdminModule } from ".";
import { ChefAdminFrame } from "./ChefAdminFrame";
import { daysUntil, formatDate, parseDate, today } from "./format";
import { memoryChefAdminService, type MemoryData } from "./memoryChefAdminService";
import {
  ApiError,
  ChefAdminServiceContext,
  CodeRejectedError,
  type ChefAdminService,
  type Customer,
} from "./model";

const chefSession = {
  ...testSession,
  name: "Chef",
  email: "admin@example.ch",
  role: "chief_admin" as const,
};

const plusDays = (n: number) =>
  new Date(Date.parse(`${today(Date.now())}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);

function customer(n: number, patch: Partial<Customer> = {}): Customer {
  const ref = `K-${String(n).padStart(4, "0")}`;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    ref,
    name: `Verein ${n}`,
    status: "active",
    licenceUntil: plusDays(200),
    licenceNumber: null,
    licenceStart: null,
    contact: `kontakt${n}@example.ch`,
    userCount: 0,
    modules: null,
    ...patch,
  };
}

function seed(extra: Partial<MemoryData> = {}): MemoryData {
  return {
    customers: [
      customer(42, {
        name: "Verein Beispiel",
        licenceUntil: plusDays(59),
        contact: "sabine.muster@example.ch",
      }),
      customer(41, { name: "Turnverein Muster" }),
      customer(35, { name: "Ruderclub Muster", status: "suspended" }),
      customer(31, { name: "Kulturverein Beispiel", licenceUntil: plusDays(-10) }),
    ],
    users: {
      [customer(42).id]: [
        {
          id: "u1",
          name: "Sabine Muster",
          email: "sabine.muster@example.ch",
          totp: "set",
          lastLogin: "2026-11-02T08:30:00Z",
        },
        {
          id: "u2",
          name: "Claudia Test",
          email: "claudia.test@example.ch",
          totp: "set",
          lastLogin: null,
        },
      ],
    },
    audit: [
      {
        id: "a1",
        at: "2026-01-12T07:30:00Z",
        actor: "Chef-Admin",
        action: "customer.create",
        target: "Verein Beispiel",
      },
      {
        id: "a2",
        at: "2026-02-12T07:30:00Z",
        actor: "Chef-Admin",
        action: "customer.suspend",
        target: "Ruderclub Muster",
      },
    ],
    account: {
      email: "admin@example.ch",
      displayName: "Chef",
      passwordChangedAt: "2026-09-14T08:00:00Z",
      totpSetUpAt: "2026-09-14T08:00:00Z",
      recoveryCodes: { unused: 9, total: 10 },
      sessions: [
        { id: "s1", device: "Windows, Firefox", since: "2026-11-02T07:12:00Z", current: true },
        {
          id: "s2",
          device: "Notebook · macOS, Safari",
          since: "2026-11-01T16:40:00Z",
          current: false,
        },
      ],
      logins: [
        { id: "l1", at: "2026-11-02T07:12:00Z", method: "totp", success: true },
        { id: "l2", at: "2026-10-30T08:03:00Z", method: "code_failed", success: false },
      ],
    },
    ...extra,
  };
}

function authService(overrides: Partial<AuthService> = {}): AuthService {
  return {
    signIn: vi.fn(),
    verifyCode: vi.fn(),
    verifyRecovery: vi.fn(),
    reauthenticate: vi.fn(),
    signOut: vi.fn().mockResolvedValue(undefined),
    redeemInvitation: vi.fn(),
    beginTotpSetup: vi.fn(),
    confirmTotpSetup: vi.fn(),
    requestPasswordReset: vi.fn(),
    resetPassword: vi.fn(),
    updateName: vi.fn(),
    ...overrides,
  };
}

function setup(service: ChefAdminService, auth: AuthService = authService()) {
  const user = userEvent.setup();
  const view = renderWithProviders(
    <ChefAdminServiceContext.Provider value={service}>
      <ChefAdminFrame />
    </ChefAdminServiceContext.Provider>,
    { service: auth, session: chefSession },
  );
  return { user, ...view };
}

async function openDetail(user: ReturnType<typeof userEvent.setup>, name = "Verein Beispiel") {
  await user.click(await screen.findByRole("link", { name }));
  await screen.findByRole("heading", { level: 1, name });
}

describe("Rahmen und Rollen", () => {
  it("zeigt dem Chef-Admin nur Kunden und Eigenes Konto, ohne Kundenmodule", async () => {
    const service = memoryChefAdminService(seed());
    renderWithProviders(
      <ChefAdminServiceContext.Provider value={service}>
        <AppShell modules={[startModule, chefAdminModule]} />
      </ChefAdminServiceContext.Provider>,
      { session: chefSession },
    );
    const nav = screen.getByRole("navigation", { name: "Anbieter" });
    expect(within(nav).getByRole("button", { name: "Kunden" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("button", { name: "Eigenes Konto" })).toBeInTheDocument();
    expect(
      screen.getByText("Anbieter-Verwaltung", { selector: ".brand__org" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Sie sehen nur Kundenstammdaten und Lizenzen/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    await screen.findByRole("link", { name: "Verein Beispiel" });
  });

  it("zeigt Kundenbenutzern das Chef-Admin-Modul nie", () => {
    renderWithProviders(<AppShell modules={[startModule, chefAdminModule]} />, {
      session: { ...testSession, role: "user" },
    });
    expect(screen.queryByRole("navigation", { name: "Anbieter" })).not.toBeInTheDocument();
    expect(screen.queryByText("Anbieter-Verwaltung")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Start" }).length).toBeGreaterThan(0);
  });

  it("wechselt zwischen Kunden und Eigenes Konto und meldet ab", async () => {
    const auth = authService();
    const { user } = setup(memoryChefAdminService(seed()), auth);
    await screen.findByRole("link", { name: "Verein Beispiel" });
    await user.click(screen.getByRole("button", { name: "Eigenes Konto" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Eigenes Konto und Sicherheit" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Abmelden" }));
    expect(auth.signOut).toHaveBeenCalled();
  });

  it("öffnet mit Strg+N das Formular und mit Strg+K die Suche", async () => {
    const { user } = setup(memoryChefAdminService(seed()));
    await screen.findByRole("link", { name: "Verein Beispiel" });
    await user.keyboard("{Control>}n{/Control}");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Kunde anlegen" }),
    ).toBeInTheDocument();
    await user.keyboard("{Control>}k{/Control}");
    const search = await screen.findByRole("searchbox", {
      name: "Kunden-ID oder Organisation suchen",
    });
    await waitFor(() => expect(search).toHaveFocus());
  });
});

describe("Kundenliste (10.1)", () => {
  it("zeigt Spalten, Status und Anzahl", async () => {
    setup(memoryChefAdminService(seed()));
    const table = await screen.findByRole("table", { name: "Kunden" });
    for (const h of [
      "Kunden-ID",
      "Organisation",
      "Kontakt",
      "Lizenz-Nr.",
      "Lizenz bis",
      "Status",
      "Benutzer",
      "Module",
    ]) {
      expect(within(table).getByRole("columnheader", { name: h })).toBeInTheDocument();
    }
    expect(within(table).getByRole("columnheader", { name: "Kunden-ID" })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[0]?.textContent)).toEqual([
      "K-0042",
      "K-0041",
      "K-0035",
      "K-0031",
    ]);
    expect(within(rows[0]!).getByText("Aktiv")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Gesperrt")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("Abgelaufen")).toBeInTheDocument();
    expect(within(rows[0]!).getAllByText("–").length).toBeGreaterThan(0);
    expect(screen.getByRole("status")).toHaveTextContent("4 von 4 Kunden");
    expect(screen.getByText("Seite 1 von 1")).toBeInTheDocument();
    expect(screen.getByText("16 Kunden pro Seite")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Vorherige Seite" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Nächste Seite" })).toBeDisabled();
  });

  it("filtert nach Status, Lizenz und Suchtext und sortiert", async () => {
    const { user } = setup(memoryChefAdminService(seed()));
    const table = await screen.findByRole("table", { name: "Kunden" });

    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "Status: Gesperrt");
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(2));
    expect(within(table).getByText("Ruderclub Muster")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "Status: Alle");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Lizenz bis" }),
      "Lizenz bis: Abgelaufen",
    );
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(2));
    expect(within(table).getByText("Kulturverein Beispiel")).toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Lizenz bis" }),
      "Lizenz bis: Alle",
    );
    await user.type(
      screen.getByRole("searchbox", { name: "Kunden-ID oder Organisation suchen" }),
      "turn",
    );
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(2));
    expect(screen.getByRole("status")).toHaveTextContent("1 von 1 Kunden");

    await user.clear(screen.getByRole("searchbox"));
    await user.click(within(table).getByRole("button", { name: "Organisation" }));
    await waitFor(() =>
      expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Kulturverein Beispiel"),
    );
  });

  it("zeigt den Leer-Zustand, wenn nichts passt", async () => {
    const { user } = setup(memoryChefAdminService(seed()));
    await screen.findByRole("table", { name: "Kunden" });
    await user.type(screen.getByRole("searchbox"), "zzz");
    expect(await screen.findByText("Keine Kunden gefunden.")).toBeInTheDocument();
  });

  it("zeigt bei 17 Kunden eine zweite Seite", async () => {
    const many = Array.from({ length: 17 }, (_, i) => customer(i + 1));
    const { user } = setup(memoryChefAdminService(seed({ customers: many })));
    await screen.findByRole("table", { name: "Kunden" });
    expect(screen.getByText("Seite 1 von 2")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("16 von 17 Kunden");
    await user.click(screen.getByRole("button", { name: "Nächste Seite" }));
    expect(screen.getByText("Seite 2 von 2")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 von 17 Kunden");
  });

  it("meldet einen Ladefehler und lädt erneut", async () => {
    let fail = true;
    const service = memoryChefAdminService(seed(), {
      beforeRequest: () => {
        if (fail) throw new ApiError(500);
      },
    });
    const { user } = setup(service);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Die Daten konnten nicht geladen werden.",
    );
    fail = false;
    await user.click(screen.getByRole("button", { name: "Erneut laden" }));
    expect(await screen.findByRole("link", { name: "Verein Beispiel" })).toBeInTheDocument();
  });

  it("hat keine Verstösse gegen die Zugänglichkeit", async () => {
    const { container } = setup(memoryChefAdminService(seed()));
    await screen.findByRole("table", { name: "Kunden" });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Kunde anlegen (10.2)", () => {
  async function fill(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText(/Name der Organisation/), "Gesangverein Muster");
    await user.type(screen.getByLabelText(/Vorname/), "Hans");
    await user.type(screen.getByLabelText(/Nachname/), "Vorlage");
    await user.type(screen.getByLabelText(/^E-Mail/), "hans.vorlage@example.ch");
  }

  it("zeigt Formular, Hinweise und die Einladungsvorschau", async () => {
    const { user } = setup(memoryChefAdminService(seed()));
    await user.click(await screen.findByRole("button", { name: "Kunde anlegen" }));
    expect(screen.getByRole("heading", { level: 1, name: "Kunde anlegen" })).toBeInTheDocument();
    expect(screen.queryByText("Nicht gespeichert")).not.toBeInTheDocument();
    expect(screen.getByText("Wird automatisch vergeben.")).toBeInTheDocument();
    expect(screen.getByText("An diese Adresse geht die Einladung.")).toBeInTheDocument();
    expect(screen.getAllByText("Format TT.MM.JJJJ")).toHaveLength(2);
    expect(screen.getByLabelText("Kunden-ID")).toHaveAttribute("readonly");
    expect(screen.getByRole("group", { name: "Module" })).toBeInTheDocument();
    for (const m of ["Sammelrechnung", "Mail", "Kalender und Events"]) {
      expect(screen.getByRole("checkbox", { name: m })).toBeChecked();
    }
    expect(
      screen.getByText(
        "Personen, Rechnungen, Buchhaltung und Auswertungen gehören zu jeder Lizenz.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Kein Zugriff auf Kundendaten.")).toBeInTheDocument();

    await fill(user);
    expect(screen.getByText("Nicht gespeichert")).toBeInTheDocument();
    expect(screen.getByDisplayValue("gesangverein-muster")).toBeInTheDocument();
    const preview = screen.getByRole("region", { name: "Einladungsvorschau" });
    expect(preview).toHaveTextContent("An: hans.vorlage@example.ch");
    expect(preview).toHaveTextContent("Betreff: Ihr Zugang zu Stammbuch");
    expect(preview).toHaveTextContent("Guten Tag Hans Vorlage");
    expect(preview).toHaveTextContent(
      "für Gesangverein Muster wurde ein Stammbuch-Zugang eingerichtet.",
    );
    expect(preview).toHaveTextContent("Der Link ist 7 Tage gültig:");
    // Das Token entsteht erst beim Versand: die Vorschau enthält nur einen Platzhalter.
    expect(preview).toHaveTextContent("/einladung#XXXX-XXXX");
  });

  it("prüft Pflichtfelder, Datum und E-Mail", async () => {
    const { user } = setup(memoryChefAdminService(seed()));
    await user.click(await screen.findByRole("button", { name: "Kunde anlegen" }));
    await user.click(screen.getByRole("button", { name: "Kunde anlegen und einladen" }));
    expect(screen.getByText("Bitte geben Sie den Namen der Organisation ein.")).toBeInTheDocument();
    expect(screen.getByText("Bitte geben Sie den Vornamen ein.")).toBeInTheDocument();
    expect(screen.getByText("Bitte geben Sie den Nachnamen ein.")).toBeInTheDocument();
    expect(
      screen.getByText("Bitte geben Sie eine gültige E-Mail-Adresse ein."),
    ).toBeInTheDocument();

    await fill(user);
    const end = screen.getByLabelText(/Ende/);
    await user.clear(end);
    await user.type(end, "31.02.2027");
    await user.click(screen.getByRole("button", { name: "Kunde anlegen und einladen" }));
    expect(
      screen.getByText("Bitte geben Sie ein Datum im Format TT.MM.JJJJ ein."),
    ).toBeInTheDocument();

    await user.clear(end);
    await user.type(end, "01.01.2000");
    await user.click(screen.getByRole("button", { name: "Kunde anlegen und einladen" }));
    expect(screen.getByText("Das Ende muss nach dem Beginn liegen.")).toBeInTheDocument();
  });

  it("legt den Kunden an und öffnet sein Detail", async () => {
    const service = memoryChefAdminService(seed());
    const create = vi.spyOn(service, "createCustomer");
    const { user } = setup(service);
    await user.click(await screen.findByRole("button", { name: "Kunde anlegen" }));
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Kunde anlegen und einladen" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Gesangverein Muster" }),
    ).toBeInTheDocument();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Gesangverein Muster",
        firstName: "Hans",
        lastName: "Vorlage",
        email: "hans.vorlage@example.ch",
        modules: ["sammelrechnung", "mail", "kalender"],
      }),
    );
    expect(
      await screen.findByText(/Die Einladung geht an hans.vorlage@example.ch/),
    ).toBeInTheDocument();
  });

  it("meldet einen doppelten Namen und speichert mit Strg+S", async () => {
    const service = memoryChefAdminService(seed());
    vi.spyOn(service, "createCustomer").mockRejectedValueOnce(new ApiError(409));
    const { user } = setup(service);
    await user.click(await screen.findByRole("button", { name: "Kunde anlegen" }));
    await fill(user);
    await user.keyboard("{Control>}s{/Control}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Zu diesem Namen gibt es schon einen Kunden.",
    );
    await user.click(screen.getByRole("button", { name: "Kunde anlegen und einladen" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Gesangverein Muster" }),
    ).toBeInTheDocument();
  });

  it("bricht ab und kehrt zur Liste zurück", async () => {
    const { user } = setup(memoryChefAdminService(seed()));
    await user.click(await screen.findByRole("button", { name: "Kunde anlegen" }));
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Kunden" })).toBeInTheDocument();
  });

  it("hat keine Verstösse gegen die Zugänglichkeit", async () => {
    const { user, container } = setup(memoryChefAdminService(seed()));
    await user.click(await screen.findByRole("button", { name: "Kunde anlegen" }));
    await fill(user);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Kunde-Detail (10.3)", () => {
  it("zeigt Lizenz, Benutzer, Protokoll, Aktionen und was verborgen bleibt", async () => {
    const { user } = setup(memoryChefAdminService(seed()));
    await openDetail(user);
    expect(screen.getByText("Anbieter-Verwaltung / Kunden / K-0042")).toBeInTheDocument();
    expect(screen.getByText("Aktiv", { selector: ".badge" })).toBeInTheDocument();
    const licence = screen.getByRole("region", { name: "Lizenz" });
    expect(
      within(licence).getByText(`${formatDate(plusDays(59))} (noch 59 Tage)`),
    ).toBeInTheDocument();
    expect(within(licence).getByText("sabine.muster@example.ch")).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "Benutzer" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Benutzer (2)" })).toBeInTheDocument();
    const audit = await screen.findByRole("table", { name: "Anbieter-Protokoll" });
    expect(within(audit).getByText("Kunde angelegt")).toBeInTheDocument();
    expect(within(audit).queryByText("Kunde gesperrt")).not.toBeInTheDocument(); // anderer Kunde
    expect(screen.getByRole("button", { name: "Lizenz verlängern" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Kunde sperren oder Vertrag beenden" }),
    ).toBeInTheDocument();
    const hidden = screen.getByRole("region", { name: "Für den Anbieter nicht sichtbar" });
    for (const text of [
      "Mitglieder und Gruppen",
      "Rechnungen und Buchhaltung",
      "Mails und Adresslisten",
      "Events und Rückmeldungen",
    ]) {
      expect(within(hidden).getByText(text)).toBeInTheDocument();
    }
  });

  it("lädt keine Vereinsdaten", async () => {
    const service = memoryChefAdminService(seed());
    const calls: string[] = [];
    for (const key of Object.keys(service) as (keyof ChefAdminService)[]) {
      const original = service[key] as (...args: unknown[]) => unknown;
      if (typeof original === "function") {
        (service as unknown as Record<string, unknown>)[key] = (...args: unknown[]) => {
          calls.push(key);
          return original(...args);
        };
      }
    }
    const { user } = setup(service);
    await openDetail(user);
    await screen.findByRole("table", { name: "Anbieter-Protokoll" });
    expect(new Set(calls)).toEqual(
      new Set(["listCustomers", "getCustomer", "customerUsers", "audit"]),
    );
  });

  it("zeigt einen Hinweis, wenn der Kunde noch keinen aktiven Benutzer hat", async () => {
    const { user } = setup(memoryChefAdminService(seed({ users: {} })));
    await openDetail(user, "Turnverein Muster");
    expect(
      await screen.findByText("Dieser Kunde hat noch keinen aktiven Benutzer."),
    ).toBeInTheDocument();
  });

  it("setzt die 2FA zurück, erst mit Grund und Rückruf (10.4)", async () => {
    const service = memoryChefAdminService(seed());
    const { user } = setup(service);
    await openDetail(user);
    await user.click(
      await screen.findByRole("button", { name: "2FA zurücksetzen für Claudia Test" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "2FA für «Claudia Test» zurücksetzen?",
    });
    expect(
      within(dialog).getByText("Der bisherige Einmalcode wird sofort ungültig."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/richtet beim nächsten Login einen neuen Einmalcode ein/),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Benutzer")).toHaveValue(
      "Claudia Test (claudia.test@example.ch)",
    );
    expect(
      within(dialog).getByText("Wird im Anbieter-Protokoll festgehalten."),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Abbrechen" })).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "Dialog schliessen" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "2FA zurücksetzen" }));
    expect(within(dialog).getByText("Bitte geben Sie einen Grund an.")).toBeInTheDocument();
    expect(within(dialog).getByText("Bitte bestätigen Sie den Rückruf.")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Bitte geben Sie den sechsstelligen Einmalcode ein."),
    ).toBeInTheDocument();
    expect(service.resets).toHaveLength(0);

    await user.type(within(dialog).getByLabelText(/Grund/), "Mobiltelefon ersetzt");
    await user.click(
      within(dialog).getByRole("checkbox", { name: /über einen bekannten Kanal zurückgerufen/ }),
    );
    await user.click(within(dialog).getByLabelText("Ziffer 1 von 6"));
    await user.keyboard("123456");
    await user.click(within(dialog).getByRole("button", { name: "2FA zurücksetzen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(service.resets).toEqual([
      { userId: "u2", reason: "Mobiltelefon ersetzt", calledBack: true, code: "123456" },
    ]);
    expect(await screen.findByText("2FA von Claudia Test zurückgesetzt.")).toBeInTheDocument();
  });

  it("bleibt im Dialog, wenn der Einmalcode abgelehnt wird oder zu viele Versuche vorliegen", async () => {
    const failures = [new CodeRejectedError(), new ApiError(429), new ApiError(500)];
    const service = memoryChefAdminService(seed(), {
      beforeRequest: (name) => {
        if (name === "resetTwoFactor" && failures.length > 0) throw failures.shift();
      },
    });
    const { user } = setup(service);
    await openDetail(user);
    await user.click(
      await screen.findByRole("button", { name: "2FA zurücksetzen für Claudia Test" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Grund/), "Mobiltelefon ersetzt");
    await user.click(within(dialog).getByRole("checkbox"));
    const submit = async () => {
      await user.click(within(dialog).getByLabelText("Ziffer 1 von 6"));
      await user.keyboard("123456");
      await user.click(within(dialog).getByRole("button", { name: "2FA zurücksetzen" }));
    };

    await submit();
    expect(await within(dialog).findByText("Der Einmalcode ist nicht gültig.")).toBeInTheDocument();
    await submit();
    expect(
      await within(dialog).findByText("Zu viele Versuche. Bitte warten Sie einige Minuten."),
    ).toBeInTheDocument();
    await submit();
    expect(
      await within(dialog).findByText("Die 2FA konnte nicht zurückgesetzt werden."),
    ).toBeInTheDocument();
    expect(service.resets).toHaveLength(0);
    // Nach einem Fehlschlag ist der Code leer; ein neuer Versuch gelingt.
    await submit();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(service.resets).toHaveLength(1);
  });

  it("sperrt den Kunden erst nach Eingabe der Kunden-ID (10.5)", async () => {
    const service = memoryChefAdminService(seed());
    const { user } = setup(service);
    await openDetail(user);
    await user.click(screen.getByRole("button", { name: "Kunde sperren oder Vertrag beenden" }));

    const dialog = await screen.findByRole("dialog", {
      name: "«Verein Beispiel» sperren oder Vertrag beenden?",
    });
    expect(within(dialog).getByRole("group", { name: "Aktion wählen" })).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /Kunde sperren/ })).toBeChecked();
    expect(
      within(dialog).getByText(/Sie können die Sperre jederzeit aufheben\./),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Rechnungen und Buchhaltung werden nie gelöscht."),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Tippen Sie K-0042 ein, um fortzufahren.")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Kunde sperren" }));
    expect(within(dialog).getByText("Die Kunden-ID stimmt nicht überein.")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText(/Zur Bestätigung Kunden-ID eintippen/), "K-0042");
    await user.click(within(dialog).getByRole("button", { name: "Kunde sperren" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Gesperrt", { selector: ".badge" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sperre aufheben" })).toBeInTheDocument();
  });

  it("beendet den Vertrag", async () => {
    const { user } = setup(memoryChefAdminService(seed()));
    await openDetail(user);
    await user.click(screen.getByRole("button", { name: "Kunde sperren oder Vertrag beenden" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: /Vertrag beenden/ }));
    expect(within(dialog).getByText(/Nur-Lesen-Modus/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Zur Bestätigung/), "K-0042");
    await user.click(within(dialog).getByRole("button", { name: "Vertrag beenden" }));
    expect(await screen.findByText("Vertrag beendet", { selector: ".badge" })).toBeInTheDocument();
  });

  it("hebt eine Sperre auf und verlängert die Lizenz", async () => {
    const { user } = setup(memoryChefAdminService(seed()));
    await openDetail(user, "Ruderclub Muster");
    await user.click(screen.getByRole("button", { name: "Sperre aufheben" }));
    const confirm = await screen.findByRole("dialog", {
      name: "Sperre von «Ruderclub Muster» aufheben?",
    });
    await user.click(within(confirm).getByRole("button", { name: "Sperre aufheben" }));
    expect(await screen.findByText("Aktiv", { selector: ".badge" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Lizenz verlängern" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Lizenz von «Ruderclub Muster» verlängern",
    });
    const field = within(dialog).getByLabelText(/Neues Ende/);
    await user.type(field, "01.01.2000");
    await user.click(within(dialog).getByRole("button", { name: "Lizenz verlängern" }));
    expect(
      within(dialog).getByText("Das neue Ende muss nach dem bisherigen liegen."),
    ).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, "31.12.2099");
    await user.click(within(dialog).getByRole("button", { name: "Lizenz verlängern" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("31.12.2099 (noch", { exact: false })).toBeInTheDocument();
  });

  it("hat keine Verstösse gegen die Zugänglichkeit (Seite und Dialoge)", async () => {
    const { user, container } = setup(memoryChefAdminService(seed()));
    await openDetail(user);
    await screen.findByRole("table", { name: "Benutzer" });
    expect(await axe(container)).toHaveNoViolations();

    await user.click(screen.getByRole("button", { name: "2FA zurücksetzen für Claudia Test" }));
    const reset = await screen.findByRole("dialog");
    expect(await axe(reset)).toHaveNoViolations();
    await user.click(within(reset).getByRole("button", { name: "Abbrechen" }));

    await user.click(screen.getByRole("button", { name: "Kunde sperren oder Vertrag beenden" }));
    const suspend = await screen.findByRole("dialog");
    expect(await axe(suspend)).toHaveNoViolations();
  });
});

describe("Eigenes Konto und Sicherheit (10.6)", () => {
  async function openAccount(service: ChefAdminService, auth?: AuthService) {
    const view = setup(service, auth);
    await view.user.click(await screen.findByRole("button", { name: "Eigenes Konto" }));
    await screen.findByRole("heading", { level: 1, name: "Eigenes Konto und Sicherheit" });
    return view;
  }

  it("zeigt Zugang, Sitzungen, Anmeldungen und Aktionen", async () => {
    await openAccount(memoryChefAdminService(seed()));
    expect(screen.getByText("Passwort und Einmalcode aktiv")).toBeInTheDocument();
    const access = screen.getByRole("region", { name: "Zugang" });
    expect(within(access).getByText("Chef-Admin · admin@example.ch")).toBeInTheDocument();
    expect(within(access).getByText("Zuletzt geändert am 14.09.2026")).toBeInTheDocument();
    expect(within(access).getByText("Eingerichtet am 14.09.2026")).toBeInTheDocument();
    expect(within(access).getByText("9 von 10 Codes unbenutzt")).toBeInTheDocument();
    expect(within(access).getByRole("button", { name: "2FA neu einrichten" })).toBeEnabled();

    const sessions = screen.getByRole("table", { name: "Aktive Sitzungen" });
    expect(screen.getByRole("region", { name: "Aktive Sitzungen (2)" })).toBeInTheDocument();
    expect(within(sessions).getByText("Aktuell")).toBeInTheDocument();
    expect(
      within(sessions).getByRole("button", {
        name: "Sitzung auf Notebook · macOS, Safari beenden",
      }),
    ).toBeInTheDocument();
    const logins = screen.getByRole("table", { name: "Letzte Anmeldungen" });
    expect(within(logins).getByText("Erfolgreich")).toBeInTheDocument();
    expect(within(logins).getByText("Fehlgeschlagen")).toBeInTheDocument();
    const mine = await screen.findByRole("table", { name: "Meine Aktionen" });
    expect(within(mine).getByText("Kunde angelegt")).toBeInTheDocument();
  });

  it("beendet eine andere Sitzung", async () => {
    const { user } = await openAccount(memoryChefAdminService(seed()));
    await user.click(
      screen.getByRole("button", { name: "Sitzung auf Notebook · macOS, Safari beenden" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Sitzung auf Notebook/ }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("region", { name: "Aktive Sitzungen (1)" })).toBeInTheDocument();
  });

  it("zeigt unbekannte Zeitpunkte als solche, Sitzungen ohne Gerät mit ihrem Beginn", async () => {
    const data = seed();
    data.account = {
      ...data.account,
      passwordChangedAt: null,
      sessions: [{ id: "s1", device: null, since: "2026-11-02T07:12:00Z", current: true }],
      logins: [],
    };
    await openAccount(memoryChefAdminService(data));
    expect(screen.getByText("Seit der Einrichtung nicht geändert")).toBeInTheDocument();
    expect(screen.queryByText(/Zuletzt geändert am/)).not.toBeInTheDocument();
    const sessions = screen.getByRole("table", { name: "Aktive Sitzungen" });
    expect(within(sessions).getByText(/^Sitzung vom 02\.11\.2026/)).toBeInTheDocument();
    expect(within(sessions).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Keine Anmeldungen im Protokoll.")).toBeInTheDocument();
  });

  it("ändert das Passwort über die Anmelde-API", async () => {
    const changePassword = vi.fn().mockResolvedValue({ status: "ok" });
    const { user } = await openAccount(
      memoryChefAdminService(seed()),
      authService({ changePassword }),
    );
    await user.click(screen.getByRole("button", { name: "Passwort ändern" }));
    const dialog = await screen.findByRole("dialog", { name: "Passwort ändern" });

    await user.click(within(dialog).getByRole("button", { name: "Passwort ändern" }));
    expect(
      within(dialog).getByText("Bitte geben Sie das aktuelle Passwort ein."),
    ).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText(/Aktuelles Passwort/), "altes-passwort-123");
    await user.type(within(dialog).getByLabelText(/^Neues Passwort \(/), "kurz");
    await user.click(within(dialog).getByRole("button", { name: "Passwort ändern" }));
    expect(within(dialog).getByText(/zu kurz/)).toBeInTheDocument();

    const next = within(dialog).getByLabelText(/^Neues Passwort \(/);
    await user.clear(next);
    await user.type(next, "ein-langes-neues-passwort");
    await user.type(within(dialog).getByLabelText(/wiederholen/), "ein-anderes");
    await user.click(within(dialog).getByRole("button", { name: "Passwort ändern" }));
    expect(within(dialog).getByText(/stimmen nicht überein/)).toBeInTheDocument();

    await user.clear(within(dialog).getByLabelText(/wiederholen/));
    await user.type(within(dialog).getByLabelText(/wiederholen/), "ein-langes-neues-passwort");
    await user.click(within(dialog).getByRole("button", { name: "Passwort ändern" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(changePassword).toHaveBeenCalledWith("altes-passwort-123", "ein-langes-neues-passwort");
  });

  it("meldet ein falsches aktuelles Passwort", async () => {
    const changePassword = vi.fn().mockResolvedValue({ status: "invalid" });
    const { user } = await openAccount(
      memoryChefAdminService(seed()),
      authService({ changePassword }),
    );
    await user.click(screen.getByRole("button", { name: "Passwort ändern" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Aktuelles Passwort/), "falsch");
    await user.type(
      within(dialog).getByLabelText(/^Neues Passwort \(/),
      "ein-langes-neues-passwort",
    );
    await user.type(within(dialog).getByLabelText(/wiederholen/), "ein-langes-neues-passwort");
    await user.click(within(dialog).getByRole("button", { name: "Passwort ändern" }));
    expect(
      await within(dialog).findByText("Das aktuelle Passwort stimmt nicht."),
    ).toBeInTheDocument();
  });

  it("erzeugt neue Wiederherstellungscodes und zeigt sie einmalig", async () => {
    const renewRecoveryCodes = vi
      .fn()
      .mockResolvedValueOnce({ status: "invalid" })
      .mockResolvedValueOnce({ status: "ok", recoveryCodes: ["AAAA-1111", "BBBB-2222"] });
    const { user } = await openAccount(
      memoryChefAdminService(seed()),
      authService({ renewRecoveryCodes }),
    );
    await user.click(screen.getByRole("button", { name: "Neue Wiederherstellungscodes erzeugen" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Neue Wiederherstellungscodes erzeugen",
    });

    await user.click(within(dialog).getByRole("button", { name: "Codes erzeugen" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Geben Sie alle 6 Ziffern ein.");

    await user.click(within(dialog).getAllByRole("textbox")[0]!);
    await user.keyboard("123456");
    await user.click(within(dialog).getByRole("button", { name: "Codes erzeugen" }));
    expect(await within(dialog).findByText("Der Code ist nicht gültig.")).toBeInTheDocument();

    const digits = within(dialog).getAllByRole("textbox");
    await user.click(digits[0]!);
    await user.keyboard("654321");
    await user.click(within(dialog).getByRole("button", { name: "Codes erzeugen" }));
    expect(await within(dialog).findByText("AAAA-1111")).toBeInTheDocument();
    expect(renewRecoveryCodes).toHaveBeenLastCalledWith("654321");
    const close = within(dialog).getByRole("button", { name: "Schliessen" });
    expect(close).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: /Codes sicher gespeichert/ }));
    await user.click(close);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("richtet den Einmalcode neu ein: erst bisheriger Code, dann der neue Schlüssel", async () => {
    const beginTotpRenewal = vi
      .fn()
      .mockResolvedValueOnce({ status: "invalid" })
      .mockResolvedValueOnce({
        status: "ok",
        secret: "ABCDEFGHIJKLMNOP",
        otpauthUri: "otpauth://totp/x?secret=ABCDEFGHIJKLMNOP",
      });
    const confirmTotpRenewal = vi.fn().mockResolvedValue({ status: "ok" });
    const { user } = await openAccount(
      memoryChefAdminService(seed()),
      authService({ beginTotpRenewal, confirmTotpRenewal }),
    );
    await user.click(screen.getByRole("button", { name: "2FA neu einrichten" }));
    const dialog = await screen.findByRole("dialog", { name: "Einmalcode (2FA) neu einrichten?" });

    await user.click(within(dialog).getAllByRole("textbox")[0]!);
    await user.keyboard("111111");
    await user.click(within(dialog).getByRole("button", { name: "Weiter" }));
    expect(await within(dialog).findByText("Der Code ist nicht gültig.")).toBeInTheDocument();
    expect(confirmTotpRenewal).not.toHaveBeenCalled();

    await user.click(within(dialog).getAllByRole("textbox")[0]!);
    await user.keyboard("222222");
    await user.click(within(dialog).getByRole("button", { name: "Weiter" }));
    expect(await within(dialog).findByText("ABCD-EFGH-IJKL-MNOP")).toBeInTheDocument();
    expect(beginTotpRenewal).toHaveBeenLastCalledWith("222222");

    await user.click(within(dialog).getAllByRole("textbox")[0]!);
    await user.keyboard("333333");
    await user.click(within(dialog).getByRole("button", { name: "Einmalcode aktivieren" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(confirmTotpRenewal).toHaveBeenLastCalledWith("333333");
  });

  it("hat keine Verstösse gegen die Zugänglichkeit", async () => {
    const { container } = await openAccount(memoryChefAdminService(seed()));
    await screen.findByRole("table", { name: "Meine Aktionen" });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Hilfsfunktionen", () => {
  it("wandelt Daten zwischen JJJJ-MM-TT und TT.MM.JJJJ", () => {
    expect(formatDate("2026-12-31")).toBe("31.12.2026");
    expect(formatDate(null)).toBe("–");
    expect(parseDate("31.12.2026")).toBe("2026-12-31");
    expect(parseDate("1.2.2027")).toBe("2027-02-01");
    expect(parseDate("30.02.2027")).toBeNull();
    expect(parseDate("2027-01-01")).toBeNull();
  });

  it("zählt Tage bis zum Lizenzende", () => {
    const now = Date.parse("2026-11-02T10:00:00Z");
    expect(daysUntil("2026-12-31", now)).toBe(59);
    expect(daysUntil("2026-11-02", now)).toBe(0);
    expect(daysUntil("2026-11-01", now)).toBe(-1);
  });
});

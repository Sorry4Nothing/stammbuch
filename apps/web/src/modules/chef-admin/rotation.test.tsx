import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, testSession } from "../../test-utils";
import { ChefAdminFrame } from "./ChefAdminFrame";
import { memoryChefAdminService } from "./memoryChefAdminService";
import { memoryRotationService, type MemoryRotationOptions } from "./memoryRotationService";
import { ApiError, ChefAdminServiceContext } from "./model";
import { RotationPage } from "./RotationPage";
import {
  RotationLimitError,
  RotationLockedError,
  RotationServiceContext,
  type RotationService,
  type RotationStatus,
} from "./rotationModel";

const chefSession = {
  ...testSession,
  name: "Chef",
  email: "admin@example.ch",
  role: "chief_admin" as const,
};

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const MAIL_ID = "11111111-1111-4111-8111-111111111111";
const MAIL_ID_2 = "22222222-2222-4222-8222-222222222222";
const TOTP_ID = "33333333-3333-4333-8333-333333333333";

function status(patch: Partial<RotationStatus> = {}): RotationStatus {
  return {
    mail: { configured: true, lastRunAt: ago(30), unreadable: [] },
    totp: { configured: true, lastRunAt: ago(30), unreadable: [] },
    ...patch,
  };
}

function setup(service: RotationService) {
  const user = userEvent.setup();
  const view = renderWithProviders(
    <RotationServiceContext.Provider value={service}>
      <RotationPage />
    </RotationServiceContext.Provider>,
    { session: chefSession },
  );
  return { user, ...view };
}

const memory = (initial: RotationStatus, options?: MemoryRotationOptions) =>
  memoryRotationService(initial, options);

async function ready() {
  await screen.findByRole("heading", { level: 1, name: "Schlüsselrotation" });
  await screen.findByRole("heading", { level: 2, name: /Mail-Zugangsdaten/ });
}

/** Öffnet die Bestätigung und gibt den Code ein. */
async function confirm(
  user: ReturnType<typeof userEvent.setup>,
  code = "123456",
  button = "Rotation starten",
) {
  await user.click(screen.getByRole("button", { name: button }));
  const dialog = await screen.findByRole("dialog", { name: "Rotation für alle Kunden starten?" });
  await user.click(within(dialog).getByLabelText("Ziffer 1 von 6"));
  await user.keyboard(code);
  await user.click(within(dialog).getByRole("button", { name: "Rotation starten" }));
}

/** Eine Anfrage, die erst auf Wunsch antwortet. */
function gate() {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Schlüsselrotation: Rahmen", () => {
  it("zeigt Schlüsselrotation in der Navigation zwischen Kunden und Eigenes Konto", async () => {
    const chef = memoryChefAdminService({
      customers: [],
      account: {
        email: "admin@example.ch",
        displayName: "Chef",
        passwordChangedAt: null,
        totpSetUpAt: null,
        recoveryCodes: { unused: 10, total: 10 },
        sessions: [],
        logins: [],
      },
    });
    const user = userEvent.setup();
    renderWithProviders(
      <ChefAdminServiceContext.Provider value={chef}>
        <RotationServiceContext.Provider value={memory(status())}>
          <ChefAdminFrame />
        </RotationServiceContext.Provider>
      </ChefAdminServiceContext.Provider>,
      { session: chefSession },
    );
    const nav = screen.getByRole("navigation", { name: "Anbieter" });
    expect(
      within(nav)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Kunden", "Schlüsselrotation", "Eigenes Konto"]);
    await user.click(within(nav).getByRole("button", { name: "Schlüsselrotation" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Schlüsselrotation" }),
    ).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Schlüsselrotation" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("Anbieter-Verwaltung / Schlüsselrotation")).toBeInTheDocument();
  });
});

describe("Schlüsselrotation: Normalzustand (10.7)", () => {
  it("zeigt beide Arten mit letztem Lauf, den Hinweisen und ohne Warnung", async () => {
    const { container } = setup(memory(status()));
    await ready();
    expect(screen.getByRole("heading", { level: 2, name: /Einmalcode-Geheimnisse/ })).toBeVisible();
    expect(screen.getByText("Zugangsdaten der Mailkonten aller Kunden.")).toBeInTheDocument();
    expect(
      screen.getByText("Schlüssel der Zwei-Faktor-Anmeldung aller Kunden."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Eingerichtet")).toHaveLength(2);
    expect(screen.getAllByText("Letzter Lauf")).toHaveLength(2);
    expect(screen.getAllByText("Keine unlesbaren Objekte")).toHaveLength(2);
    expect(screen.getByText("Was passiert bei einer Rotation?")).toBeInTheDocument();
    expect(screen.getByText(/höchstens 3 Läufe pro Minute möglich/)).toBeInTheDocument();
    expect(screen.getByText("Sie sehen nur Zahlen und Kennnummern.")).toBeInTheDocument();
    expect(screen.queryByText(/über 12 Monate/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rotation starten" })).toBeEnabled();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("warnt, wenn der letzte Lauf über 12 Monate zurückliegt", async () => {
    const { container } = setup(
      memory(status({ mail: { configured: true, lastRunAt: ago(430), unreadable: [] } })),
    );
    await ready();
    const warning = screen
      .getByText("Der letzte Lauf liegt über 12 Monate zurück.")
      .closest(".msg");
    expect(warning).toHaveAttribute("role", "status");
    expect(warning).toHaveTextContent("Starten Sie bald eine neue Rotation.");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("warnt nicht bei genau einem Jahr minus einem Tag oder ohne Lauf", async () => {
    setup(
      memory(
        status({
          mail: { configured: true, lastRunAt: ago(360), unreadable: [] },
          totp: { configured: true, lastRunAt: null, unreadable: [] },
        }),
      ),
    );
    await ready();
    expect(screen.queryByText(/über 12 Monate/)).not.toBeInTheDocument();
  });

  it("zeigt einen Ladefehler mit Wiederholen", async () => {
    const service = memory(status(), {
      beforeRequest: () => {
        throw new ApiError(500);
      },
    });
    const { user } = setup(service);
    expect(await screen.findByText("Die Daten konnten nicht geladen werden.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Erneut laden" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Erneut laden" }));
  });
});

describe("Schlüsselrotation: Art nicht eingerichtet (10.8)", () => {
  it("sperrt die fehlende Art, benennt den Grund und startet nur die andere", async () => {
    const { container, user } = setup(
      memory(
        status({
          mail: { configured: true, lastRunAt: ago(430), unreadable: [] },
          totp: { configured: false, lastRunAt: null, unreadable: [] },
        }),
      ),
    );
    await ready();
    expect(screen.getByText("Nicht eingerichtet")).toBeInTheDocument();
    expect(screen.getByText("Noch kein Lauf")).toBeInTheDocument();
    expect(screen.getByText("Noch nicht geprüft")).toBeInTheDocument();
    const blocked = screen.getByRole("button", { name: "Nicht möglich" });
    expect(blocked).toBeDisabled();
    const reason = screen
      .getByText("Für Einmalcode-Geheimnisse fehlt der Verschlüsselungsschlüssel des Betreibers.")
      .closest("[id]");
    expect(blocked).toHaveAttribute("aria-describedby", reason?.id);
    expect(reason).toHaveTextContent("Der Betreiber muss ihn zuerst auf dem Server einrichten.");
    expect(reason).toHaveTextContent("Bis dahin können Sie nur Mail-Zugangsdaten neu sichern.");
    expect(screen.queryByText("Sie sehen nur Zahlen und Kennnummern.")).not.toBeInTheDocument();
    expect(screen.getByText("Der letzte Lauf liegt über 12 Monate zurück.")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();

    await user.click(
      screen.getByRole("button", { name: "Rotation starten (nur Mail-Zugangsdaten)" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/^Mail-Zugangsdaten werden mit dem neuen/)).toBeInTheDocument();
  });

  it("sperrt den Start, wenn gar keine Art eingerichtet ist", async () => {
    setup(
      memory(
        status({
          mail: { configured: false, lastRunAt: null, unreadable: [] },
          totp: { configured: false, lastRunAt: null, unreadable: [] },
        }),
      ),
    );
    await ready();
    expect(screen.getByRole("button", { name: "Rotation starten" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Nicht möglich" })).toHaveLength(2);
  });
});

describe("Schlüsselrotation: Bestätigung (10.9)", () => {
  it("verlangt einen frischen Einmalcode, fokussiert Abbrechen und schliesst mit Esc", async () => {
    const service = memory(status());
    const { user } = setup(service);
    await ready();
    const start = screen.getByRole("button", { name: "Rotation starten" });
    await user.click(start);
    const dialog = await screen.findByRole("dialog", { name: "Rotation für alle Kunden starten?" });
    expect(within(dialog).getByRole("button", { name: "Abbrechen" })).toHaveFocus();
    expect(
      within(dialog).getByText(
        "Mail-Zugangsdaten und Einmalcode-Geheimnisse werden mit dem neuen Verschlüsselungsschlüssel des Betreibers neu gesichert.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "Alle Kunden sind betroffen, nicht nur ein Verein.",
      "Der Lauf dauert einige Minuten. Lassen Sie die Seite offen.",
      "Für Kunden ändert sich nichts: Anmeldung und Mailversand laufen weiter.",
    ]);
    expect(
      within(dialog).getByText("Starten Sie die Rotation nur, wenn sie nötig ist."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("group", { name: /Frischer Einmalcode des Chef-Admins/ }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        /Öffnen Sie Ihre Authenticator-App und geben Sie den aktuellen Code ein/,
      ),
    ).toBeInTheDocument();
    expect(await axe(dialog)).toHaveNoViolations();

    // Ohne Code startet nichts.
    await user.click(within(dialog).getByRole("button", { name: "Rotation starten" }));
    expect(
      within(dialog).getByText("Bitte geben Sie den sechsstelligen Einmalcode ein."),
    ).toBeInTheDocument();
    expect(service.runs).toEqual([]);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(start).toHaveFocus();
    expect(service.runs).toEqual([]);
  });

  it("öffnet den Dialog erneut mit Hinweis, wenn der Code abgelehnt wird", async () => {
    const service = memory(status());
    const { user } = setup(service);
    await ready();
    await confirm(user, "000000");
    const again = await screen.findByRole("dialog", { name: "Rotation für alle Kunden starten?" });
    expect(await within(again).findByText("Der Einmalcode ist nicht gültig.")).toBeInTheDocument();
    expect(service.runs).toEqual([]);
  });

  it("meldet die Sperre nach zu vielen falschen Codes im Dialog", async () => {
    const { user } = setup({
      status: async () => status(),
      run: async () => {
        throw new RotationLockedError();
      },
    });
    await ready();
    await confirm(user);
    const again = await screen.findByRole("dialog");
    expect(
      await within(again).findByText("Zu viele Versuche. Bitte warten Sie einige Minuten."),
    ).toBeInTheDocument();
  });
});

describe("Schlüsselrotation: Lauf läuft (10.10)", () => {
  it("sperrt die Schaltfläche, meldet den Lauf als Status und zeigt den Schritt", async () => {
    const g = gate();
    const service = memory(status(), {
      outcome: async (kind) => {
        if (kind === "totp") await g.wait;
        return { rotated: 1, failed: [], aborted: false };
      },
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user, container } = setup(service);
    await ready();
    await confirm(user);

    const run = await screen.findByText("Die Rotation läuft.");
    const message = run.closest(".msg");
    expect(message).toHaveAttribute("role", "status");
    expect(message).toHaveTextContent(
      "Schritt 1 von 2: Mail-Zugangsdaten werden mit dem neuen Schlüssel neu gesichert.",
    );
    expect(message).toHaveTextContent(
      "Bitte lassen Sie diese Seite offen. Das kann einige Minuten dauern.",
    );
    const button = screen.getByRole("button", { name: "Rotation läuft" });
    expect(button).toBeDisabled();
    expect(screen.getByText("Wartet")).toBeInTheDocument();
    expect(screen.getByText("Läuft")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Fortschritt der Rotation" });
    expect(bar).toHaveAttribute("aria-valuenow", "1");
    expect(bar).toHaveAttribute("aria-valuemax", "2");
    expect(bar).toHaveAttribute("aria-valuetext", "Schritt 1 von 2: Mail-Zugangsdaten");
    expect(screen.getAllByText(/^Schritt \d von 2$/)).toHaveLength(2);
    expect(message?.parentElement).toHaveFocus();
    expect(await axe(container)).toHaveNoViolations();

    // Sobald die Mail-Zugangsdaten fertig sind, meldet der Stand Schritt 2.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(
      await screen.findByText(/^Schritt 2 von 2: Einmalcode-Geheimnisse werden/),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
    expect(screen.getByText("Fertig")).toBeInTheDocument();

    g.open();
    expect(await screen.findByText("Die Rotation ist abgeschlossen.")).toBeInTheDocument();
  });
});

describe("Schlüsselrotation: Ergebnis erfolgreich (10.11)", () => {
  it("zeigt die Zahlen je Art, den Hinweis und startet danach wieder erlaubt", async () => {
    const service = memory(status(), {
      outcome: async (kind) => ({
        rotated: kind === "mail" ? 1248 : 386,
        failed: [],
        aborted: false,
      }),
    });
    const { user, container } = setup(service);
    await ready();
    await confirm(user);

    const done = await screen.findByText("Die Rotation ist abgeschlossen.");
    expect(done.closest(".msg")).toHaveAttribute("role", "status");
    expect(done.closest(".msg")).toHaveTextContent(
      "Alle Objekte sind mit dem neuen Schlüssel neu gesichert. Der Lauf steht im Anbieter-Protokoll.",
    );
    expect(screen.getAllByText("Erfolgreich")).toHaveLength(2);
    expect(screen.getByText("1’248 Objekte")).toBeInTheDocument();
    expect(screen.getByText("386 Objekte")).toBeInTheDocument();
    expect(screen.getAllByText("neu gesichert", { exact: false }).length).toBeGreaterThan(1);
    expect(screen.getAllByText("Zeitpunkt")).toHaveLength(2);
    expect(screen.getAllByText("Keine unlesbaren Objekte")).toHaveLength(2);
    expect(screen.getByText("Sie sehen nur Zahlen und Kennnummern.")).toBeInTheDocument();
    expect(screen.queryByText("Was passiert bei einer Rotation?")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rotation starten" })).toBeEnabled();
    expect(service.runs).toEqual(["123456"]);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("nennt ein einzelnes Objekt in der Einzahl", async () => {
    setup(memory(status(), { outcome: async () => ({ rotated: 1, failed: [], aborted: false }) }));
    await ready();
    await confirm(userEvent.setup());
    expect(await screen.findAllByText("1 Objekt")).toHaveLength(2);
  });
});

describe("Schlüsselrotation: Ergebnis mit Fehlern (10.12)", () => {
  it("zeigt Fehlerzahlen, nächste Schritte und die Kennnummern zum Kopieren", async () => {
    const service = memory(status(), {
      outcome: async (kind) =>
        kind === "mail"
          ? { rotated: 1245, failed: [MAIL_ID, MAIL_ID_2], aborted: false }
          : { rotated: 385, failed: [TOTP_ID], aborted: false },
    });
    const { user, container } = setup(service);
    await ready();
    await confirm(user);

    const lead = await screen.findByText("Die Rotation ist mit Fehlern beendet.");
    expect(lead.closest(".msg")).toHaveTextContent(
      "3 Objekte konnten nicht neu gesichert werden. Alle anderen sind mit dem neuen Schlüssel gesichert.",
    );
    expect(screen.getAllByText("Mit Fehlern")).toHaveLength(2);
    expect(screen.getByText("1’245 Objekte")).toBeInTheDocument();
    expect(screen.getByText("2 Objekte")).toBeInTheDocument();
    expect(screen.getByText("1 Objekt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rotation erneut starten" })).toBeEnabled();
    expect(
      screen.getByRole("heading", { level: 2, name: "Was Sie jetzt tun können" }),
    ).toBeVisible();
    const ids = screen.getByLabelText("Fehlgeschlagene Kennnummern");
    expect(ids).toHaveAttribute("readonly");
    expect(ids).toHaveValue(`${MAIL_ID}\n${MAIL_ID_2}\n${TOTP_ID}`);
    expect(screen.getByText("Es sind nur Kennnummern, keine Kundendaten.")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();

    await user.click(screen.getByRole("button", { name: "Kennnummern kopieren" }));
    expect(await navigator.clipboard.readText()).toBe(`${MAIL_ID}\n${MAIL_ID_2}\n${TOTP_ID}`);
    expect(await screen.findByText("Kennnummern kopiert.")).toBeInTheDocument();
  });
});

describe("Schlüsselrotation: Lauf abgebrochen (10.13)", () => {
  it("erklärt den Abbruch, zeigt nicht gestartete Arten und führt zurück zur Übersicht", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const service = memory(
      status({ totp: { configured: false, lastRunAt: null, unreadable: [] } }),
      {
        outcome: async () => {
          vi.setSystemTime(Date.now() + 4 * 60_000); // der Lauf dauerte vier Minuten
          return { rotated: 612, failed: [], aborted: true };
        },
      },
    );
    const { user, container } = setup(service);
    await ready();
    await confirm(user, "123456", "Rotation starten (nur Mail-Zugangsdaten)");

    const lead = await screen.findByText("Der Lauf wurde abgebrochen.");
    expect(lead.closest(".msg")).toHaveTextContent(
      "Er wurde nach 4 Minuten beendet, bevor alles neu gesichert war. Bereits neu gesicherte Objekte bleiben gültig, alle anderen bleiben unverändert. Es gehen keine Daten verloren.",
    );
    expect(screen.getByText("612 Objekte")).toBeInTheDocument();
    expect(screen.getAllByText("Abgebrochen").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Ja")).toBeInTheDocument();
    expect(screen.getAllByText("Nicht gestartet").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("0 Objekte")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "So geht es weiter" })).toBeVisible();
    expect(
      screen.getByText(/Bleibt der Lauf wieder stehen, nennen Sie dem Support die Zeit des Laufs/),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /Rotation .*starten/ }).map((b) => b.textContent),
    ).toEqual(["Rotation starten (nur Mail-Zugangsdaten)", "Rotation erneut starten"]);
    expect(await axe(container)).toHaveNoViolations();

    await user.click(screen.getByRole("button", { name: "Zur Übersicht" }));
    expect(await screen.findByText("Was passiert bei einer Rotation?")).toBeInTheDocument();
    expect(screen.queryByText("Der Lauf wurde abgebrochen.")).not.toBeInTheDocument();
  });
});

describe("Schlüsselrotation: Fehler und Limit erreicht (10.14)", () => {
  it("zeigt Wartezeit, Angaben für den Support und gibt Erneut laden erst danach frei", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user, container } = setup({
      status: async () => status(),
      run: async () => {
        throw new RotationLimitError(3);
      },
    });
    await ready();
    await confirm(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Die Rotation wurde nicht gestartet.");
    expect(alert).toHaveTextContent(
      "Sie haben in der letzten Minute schon 3 Läufe gestartet. Mehr sind nicht erlaubt. Warten Sie 3 Sekunden und laden Sie die Seite dann erneut. Besteht der Fehler weiter, nennen Sie dem Support die Fehlernummer.",
    );
    expect(screen.getByRole("button", { name: "Rotation starten" })).toBeDisabled();
    expect(
      screen.getByRole("heading", { level: 2, name: "Angaben für den Support" }),
    ).toBeVisible();
    expect(screen.getByText("Zu viele Aufrufe (429)")).toBeInTheDocument();
    expect(screen.getByText(/^ERR-\d{8}-[0-9A-F]{4}$/)).toBeInTheDocument();
    const reload = screen.getByRole("button", { name: "Erneut laden (in 3 s)" });
    expect(reload).toBeDisabled();
    expect(
      screen.getByText("Die Schaltfläche «Erneut laden» wird nach der Wartezeit frei."),
    ).toBeInTheDocument();
    expect(alert.parentElement).toHaveFocus();
    expect(await axe(container)).toHaveNoViolations();

    await user.click(screen.getByRole("button", { name: "Fehlernummer kopieren" }));
    expect(await navigator.clipboard.readText()).toMatch(/^ERR-\d{8}-[0-9A-F]{4}$/);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    const ready2 = await screen.findByRole("button", { name: "Erneut laden" });
    expect(ready2).toBeEnabled();
    expect(
      screen.queryByText("Die Schaltfläche «Erneut laden» wird nach der Wartezeit frei."),
    ).not.toBeInTheDocument();
    await user.click(ready2);
    expect(await screen.findByText("Was passiert bei einer Rotation?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rotation starten" })).toBeEnabled();
  });

  it("meldet andere Fehler ohne Interna und mit sofort freiem Neuladen", async () => {
    const { user } = setup({
      status: async () => status(),
      run: async () => {
        throw new ApiError(500);
      },
    });
    await ready();
    await confirm(user);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Die Rotation konnte nicht abgeschlossen werden.");
    expect(screen.getByText("Fehler der Anbieter-API (500)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Erneut laden" })).toBeEnabled();
  });

  it("meldet einen laufenden Lauf (409) und fehlende Verbindung", async () => {
    const failures = [new ApiError(409), new TypeError("Failed to fetch")];
    const { user } = setup({
      status: async () => status(),
      run: async () => {
        throw failures.shift();
      },
    });
    await ready();
    await confirm(user);
    expect(await screen.findByText("Eine Rotation läuft bereits (409)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Erneut laden" }));
    await screen.findByText("Was passiert bei einer Rotation?");
    await confirm(user, "654321");
    expect(await screen.findByText("Keine Verbindung zum Server")).toBeInTheDocument();
  });
});

describe("Schlüsselrotation: Unlesbare Objekte (10.15)", () => {
  const unreadable = status({
    mail: { configured: true, lastRunAt: ago(1), unreadable: [MAIL_ID, MAIL_ID_2] },
    totp: { configured: true, lastRunAt: ago(1), unreadable: [TOTP_ID] },
  });

  it("listet die Kennnummern mit Art und kopiert einzeln oder alle", async () => {
    const { user, container } = setup(memory(unreadable));
    await ready();
    expect(screen.getByText("2 unlesbar")).toBeInTheDocument();
    expect(screen.getByText("1 unlesbar")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: /Unlesbare Objekte aus dem letzten Lauf \(3\)/,
      }),
    ).toBeVisible();
    const table = screen.getByRole("table", { name: "Unlesbare Objekte aus dem letzten Lauf" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Kennnummer", "Art", "Aktion"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      `${MAIL_ID}Mail-ZugangsdatenKopieren`,
      `${MAIL_ID_2}Mail-ZugangsdatenKopieren`,
      `${TOTP_ID}Einmalcode-GeheimnisseKopieren`,
    ]);
    expect(screen.getByText("Was bedeutet «unlesbar»?")).toBeInTheDocument();
    expect(screen.queryByText("Sie sehen nur Zahlen und Kennnummern.")).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();

    await user.click(screen.getByRole("button", { name: `Kennnummer ${MAIL_ID_2} kopieren` }));
    expect(await navigator.clipboard.readText()).toBe(MAIL_ID_2);
    expect(await screen.findByText("Kennnummer kopiert.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Alle Kennnummern kopieren" }));
    expect(await navigator.clipboard.readText()).toBe(`${MAIL_ID}\n${MAIL_ID_2}\n${TOTP_ID}`);
  });
});

describe("Schlüsselrotation: Noch kein Lauf (10.16)", () => {
  it("zeigt den Leerzustand mit Schaltfläche statt einer Liste", async () => {
    const { user, container } = setup(
      memory(
        status({
          mail: { configured: true, lastRunAt: null, unreadable: [] },
          totp: { configured: true, lastRunAt: null, unreadable: [] },
        }),
      ),
    );
    await ready();
    expect(screen.getAllByText("Noch kein Lauf")).toHaveLength(2);
    expect(screen.getAllByText("Noch nicht geprüft")).toHaveLength(2);
    expect(screen.getByRole("table", { name: "Unlesbare Objekte, keine Einträge" })).toBeVisible();
    expect(
      screen.getByRole("heading", { level: 2, name: "Noch keine Rotation gestartet" }),
    ).toBeVisible();
    expect(
      screen.getByText(/Die Liste der unlesbaren Objekte bleibt bis dahin leer/),
    ).toBeInTheDocument();
    expect(screen.getByText("Was passiert bei einer Rotation?")).toBeInTheDocument();
    expect(screen.queryByText("Sie sehen nur Zahlen und Kennnummern.")).not.toBeInTheDocument();
    expect(screen.queryByText(/über 12 Monate/)).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();

    const starts = screen.getAllByRole("button", { name: "Rotation starten" });
    expect(starts).toHaveLength(2);
    await user.click(starts[1]!);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});

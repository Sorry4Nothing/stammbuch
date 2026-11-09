import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { AppShell } from "../../shell/AppShell";
import { renderWithProviders } from "../../test-utils";
import { settingsModule } from ".";
import { fiscalRange, stagesOf } from "./httpSettingsService";
import { allFeatures, memorySettingsService, type MemorySeed } from "./memorySettingsService";
import type { AuditEntry, OrgData, SettingsUser } from "./model";
import { SettingsProvider } from "./service";
import { checkLogo, currentFiscalYear, isQrIban, validateOrg } from "./validate";

/** Die Beispielwerte aus den Boards 9.1 bis 9.15. */
const org: OrgData = {
  name: "Verein Beispiel",
  legalForm: "verein",
  street: "Beispielstrasse 12",
  zip: "8000",
  city: "Musterhausen",
  phone: "+41 44 000 00 00",
  email: "kontakt@beispiel.example.ch",
  website: "www.verein-beispiel.example.ch",
  vatNumber: "CHE-000.000.000 MWST",
  uid: "CHE-000.000.000",
  senderName: "Verein Beispiel",
  replyTo: "kontakt@beispiel.example.ch",
  footer: "Verein Beispiel · Beispielstrasse 12 · 8000 Musterhausen",
  accountHolder: "Verein Beispiel",
  bankName: "Beispielbank AG",
  // Gültige QR-IBAN (Institut 30000)
  qrIban: "CH7430000001250000009",
  creditAccount: "1020",
  paymentDays: "30",
  fiscalStart: "01.01.",
  fiscalEnd: "31.12.",
  closing: "monthly",
  sammelrechnung: true,
  mail: true,
  kalender: true,
};

const users: SettingsUser[] = [
  {
    id: "u1",
    name: "Sabine Muster",
    email: "sabine.muster@example.ch",
    status: "active",
    lastLogin: "02.11.2026 09:30",
  },
  {
    id: "u2",
    name: "Beat Probe",
    email: "beat.probe@example.ch",
    status: "active",
    lastLogin: "02.11.2026 08:05",
  },
  {
    id: "u3",
    name: "Claudia Test",
    email: "claudia.test@example.ch",
    status: "active",
    lastLogin: "31.10.2026 16:59",
  },
];

const entry = (
  id: number,
  at: string,
  actor: string,
  action: string,
  target: string,
): AuditEntry => ({ id: String(id), at, actor, action, target, result: "ok" });

const audit: AuditEntry[] = [
  entry(3, "2026-11-02T13:52:00Z", "sabine.muster@example.ch", "organisation.update", "bank"),
  entry(2, "2026-11-02T12:58:00Z", "beat.probe@example.ch", "user.add", "daniel.demo@example.ch"),
  entry(1, "2026-10-31T15:59:00Z", "claudia.test@example.ch", "audit.export", ""),
];

const baseSeed: MemorySeed = {
  org,
  users,
  audit,
  auditTotal: 2418,
  mail: {
    stored: true,
    draft: {
      email: "kontakt@beispiel.example.ch",
      username: "kontakt@beispiel.example.ch",
      password: "",
      senderName: "Verein Beispiel",
      imapHost: "imap.example.ch",
      imapPort: "993",
      imapSecurity: "tls",
      smtpHost: "smtp.example.ch",
      smtpPort: "465",
      smtpSecurity: "tls",
    },
  },
  security: {
    passwordChangedAt: "2026-08-14",
    totpSince: "2026-01-12",
    recoveryLeft: 8,
    recoveryTotal: 10,
    device: "Firefox auf Windows",
  },
  recoveryCodes: [
    "XK7M2-QD94F",
    "P3W8N-6RT2H",
    "B5J9C-A7Z4L",
    "V2H6D-M8K3X",
    "T4Q7F-Y9N5S",
    "G8L2R-3WC6P",
    "Z6B4M-H5D8J",
    "N9X3K-7QF2V",
    "C7S5T-L4R8A",
    "D2Y6W-9HJ3M",
  ],
  licence: {
    state: "active",
    validUntil: "2026-12-31",
    licensee: "Verein Beispiel",
    customerId: "K-0042",
    licenceNo: "L-2026-0042",
    validFrom: "2026-01-01",
    users: 3,
    providerEmail: "support@anbieter.example.ch",
  },
};

function setup(seed: MemorySeed = {}) {
  const service = memorySettingsService({ ...baseSeed, ...seed });
  const view = renderWithProviders(
    <SettingsProvider service={service}>
      <AppShell modules={[settingsModule]} />
    </SettingsProvider>,
  );
  return { service, ...view };
}

async function goTo(name: string) {
  const nav = screen.getByRole("navigation", { name: "Einstellungen" });
  await userEvent.click(within(nav).getByRole("button", { name }));
}

beforeEach(() => {
  // «02.11.2026» wie in den Boards; nur das Datum, die Timer laufen echt.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 2, 15, 0));
});
afterEach(() => vi.useRealTimers());

describe("Prüfungen", () => {
  it("erkennt QR-IBAN, Geschäftsjahr und Logo-Dateien", async () => {
    expect(isQrIban(org.qrIban)).toBe(true);
    expect(isQrIban("CH93 0076 2011 6238 5295 7")).toBe(false);
    expect(fiscalRange(7)).toEqual({ start: "01.07.", end: "30.06." });
    expect(currentFiscalYear("01.01.", Date.now())).toBe("2026");
    expect(currentFiscalYear("01.07.", Date.now())).toBe("2026/27");
    expect(validateOrg(org, allFeatures)).toEqual({});
    expect(validateOrg({ ...org, fiscalEnd: "30.12." }, allFeatures).fiscalEnd).toMatch(/31\.12\./);
    expect(validateOrg({ ...org, fiscalStart: "05.01." }, allFeatures).fiscalStart).toMatch(/1\./);
    const svg = new File(["<svg onload=alert(1)>"], "logo.svg", { type: "image/svg+xml" });
    expect(await checkLogo(svg)).toBe("type");
    const big = new File([new Uint8Array(513 * 1024)], "logo.png", { type: "image/png" });
    expect(await checkLogo(big)).toBe("size");
  });

  it("verteilt das Ergebnis der API auf die sechs Stufen", () => {
    expect(stagesOf({ smtp: "ok", imap: "ok" }).failedAt).toBeUndefined();
    const auth = stagesOf({ smtp: "ok", imap: "AUTH" });
    expect(auth.failedAt).toBe(2);
    expect(auth.stages.map((s) => s.status)).toEqual([
      "ok",
      "ok",
      "failed",
      "skipped",
      "skipped",
      "skipped",
    ]);
    expect(stagesOf({ smtp: "AUTH", imap: "ok" }).failedAt).toBe(4);
    expect(stagesOf({ smtp: "CONNECT", imap: "TLS" }).failedAt).toBe(1);
  });
});

describe("Organisation: Stammdaten (Board 9.1)", () => {
  it("zeigt Kopf, Tabs und alle Felder mit den Texten des Boards", async () => {
    setup();
    expect(await screen.findByRole("heading", { level: 1, name: "Organisation" })).toBeVisible();
    expect(screen.getByText("Einstellungen / Organisation / Stammdaten")).toBeVisible();
    const tabs = await screen.findByRole("tablist", { name: "Organisation" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((x) => x.textContent),
    ).toEqual(["Stammdaten", "Logo und Absender", "Bank und Geschäftsjahr", "Module"]);
    expect(screen.getByText("Pflichtfelder sind mit * markiert.")).toBeVisible();
    for (const h of ["Verein", "Adresse", "Kontakt", "Steuern"]) {
      expect(screen.getByRole("heading", { name: h })).toBeVisible();
    }
    expect(screen.getByLabelText(/^Name/)).toHaveValue("Verein Beispiel");
    expect(screen.getByLabelText(/^Rechtsform/)).toHaveValue("verein");
    expect(
      within(screen.getByLabelText(/^Rechtsform/))
        .getAllByRole("option")
        .map((o) => o.getAttribute("value")),
    ).toEqual([
      "verein",
      "stiftung",
      "genossenschaft",
      "gmbh",
      "ag",
      "einzelunternehmen",
      "andere",
    ]);
    expect(screen.getByLabelText("Sprache der Dokumente")).toHaveAttribute("readonly");
    expect(screen.getByLabelText(/^PLZ/)).toHaveAttribute("maxlength", "4");
    expect(screen.getByLabelText(/^MwSt-Nr\./)).toHaveAccessibleDescription(
      "Erscheint auf Rechnungen und in der MwSt-Abrechnung.",
    );
    expect(screen.getByText("Mit Landesvorwahl.")).toBeVisible();
    expect(screen.getByText("Gleiche Oberfläche für alle.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Änderungen speichern" })).toHaveClass(
      "btn--primary",
    );
  });

  it("markiert ungespeicherte Eingaben und speichert", async () => {
    const { service } = setup();
    const name = await screen.findByLabelText(/^Name/);
    await userEvent.clear(name);
    await userEvent.type(name, "Verein Neu");
    expect(screen.getByText("Ungespeichert:")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));
    expect(await screen.findByText("Änderungen gespeichert.")).toBeVisible();
    expect(service.state.org.name).toBe("Verein Neu");
    await waitFor(() => expect(screen.queryByText("Ungespeichert:")).not.toBeInTheDocument());
  });

  it("springt bei Fehlern zum Feld und speichert nichts", async () => {
    const { service } = setup();
    const name = await screen.findByLabelText(/^Name/);
    await userEvent.clear(name);
    await userEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Bitte prüfen Sie 1 Feld.");
    expect(screen.getByLabelText(/^Name/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Bitte ausfüllen.")).toBeVisible();
    expect(service.state.org.name).toBe("Verein Beispiel");
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    const { container } = setup();
    await screen.findByRole("heading", { level: 1, name: "Organisation" });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Organisation: Logo und Absender (Board 9.2)", () => {
  async function open() {
    const view = setup();
    await userEvent.click(await screen.findByRole("tab", { name: "Logo und Absender" }));
    return view;
  }

  it("zeigt Logo, Absenderdaten, Vorschau und Hinweis", async () => {
    await open();
    expect(screen.getByText("Einstellungen / Organisation / Logo und Absender")).toBeVisible();
    for (const h of ["Logo", "Absenderdaten", "Vorschau Briefkopf"]) {
      expect(screen.getByRole("heading", { name: h })).toBeVisible();
    }
    expect(screen.getByLabelText(/^Absendername/)).toHaveValue("Verein Beispiel");
    expect(screen.getByLabelText(/^Antwortadresse/)).toHaveValue("kontakt@beispiel.example.ch");
    expect(screen.getByText(/^PNG oder JPEG, mindestens 16 × 16/)).toBeVisible();
    expect(screen.getByText("Rechnung R-2026-0430")).toBeVisible();
    expect(screen.getByText("Logo nur auf Dokumenten.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Logo entfernen" })).toBeDisabled();
  });

  it("nimmt PNG an, weist SVG im Browser ab und entfernt das Logo", async () => {
    const { service } = await open();
    const input = screen.getByLabelText("Logo hochladen", { selector: "input" });
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(input, new File(["x"], "logo.svg", { type: "image/svg+xml" }));
    expect(await screen.findByText("Nur PNG oder JPEG sind erlaubt.")).toBeVisible();
    expect(service.state.logoUploads).toEqual([]);

    await user.upload(input, new File(["x"], "logo.png", { type: "image/png" }));
    await waitFor(() => expect(service.state.logoUploads).toEqual(["logo.png"]));
    expect(screen.queryByText("Nur PNG oder JPEG sind erlaubt.")).not.toBeInTheDocument();
    expect(await screen.findAllByRole("img", { name: "Logo Verein Beispiel" })).not.toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Logo entfernen" }));
    await waitFor(() => expect(service.state.logo).toBeNull());
  });

  it("übernimmt Änderungen der Adresse in die Stammdaten", async () => {
    const { service } = await open();
    const street = screen.getByLabelText(/^Strasse und Nummer/);
    await userEvent.clear(street);
    await userEvent.type(street, "Neue Strasse 1");
    expect(screen.getByText(/Neue Strasse 1/, { selector: "span" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));
    await waitFor(() => expect(service.state.org.street).toBe("Neue Strasse 1"));
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    const { container } = await open();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Organisation: Bank und Geschäftsjahr (Board 9.3)", () => {
  async function open(seed: MemorySeed = {}) {
    const view = setup(seed);
    await userEvent.click(await screen.findByRole("tab", { name: "Bank und Geschäftsjahr" }));
    return view;
  }

  it("zeigt Bankverbindung und Geschäftsjahr", async () => {
    await open();
    expect(screen.getByLabelText(/^Kontoinhaber/)).toHaveValue("Verein Beispiel");
    expect(screen.getByLabelText(/^QR-IBAN/)).toHaveAccessibleDescription(
      "Für QR-Rechnung und automatische Zuordnung über die QR-Referenz.",
    );
    expect(screen.getByLabelText("Währung")).toHaveValue("CHF");
    expect(screen.getByLabelText(/^Gutschriften auf/)).toHaveDisplayValue(
      "1020 Bank Zahlungsverkehr",
    );
    expect(screen.getByLabelText(/^Zahlungsfrist in Tagen/)).toHaveValue("30");
    expect(screen.getByLabelText(/^Beginn/)).toHaveValue("01.01.");
    expect(screen.getByLabelText(/^Ende/)).toHaveValue("31.12.");
    expect(screen.getByLabelText("Aktuelles Geschäftsjahr")).toHaveValue("2026");
    expect(screen.getByLabelText(/^Periodenabschluss/)).toHaveDisplayValue("Monatlich");
    expect(screen.getByText("Zahlungsimport.")).toBeVisible();
  });

  it("meldet eine ungültige QR-IBAN am Feld", async () => {
    await open();
    const iban = screen.getByLabelText(/^QR-IBAN/);
    await userEvent.clear(iban);
    await userEvent.type(iban, "CH93 0076 2011 6238 5295 7");
    await userEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));
    expect(await screen.findByText(/Bitte geben Sie eine gültige QR-IBAN ein/)).toBeVisible();
    expect(screen.getByLabelText(/^QR-IBAN/)).toHaveAttribute("aria-invalid", "true");
  });

  it("blendet Felder aus, die das Backend nicht kennt", async () => {
    await open({
      features: {
        ...allFeatures,
        accountHolder: false,
        creditAccount: false,
        paymentDays: false,
        closing: false,
      },
    });
    expect(screen.queryByLabelText(/^Kontoinhaber/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Zahlungsfrist/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Periodenabschluss/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^QR-IBAN/)).toBeVisible();
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    const { container } = await open();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Organisation: Module (Board 9.4)", () => {
  async function open() {
    const view = setup();
    await userEvent.click(await screen.findByRole("tab", { name: "Module" }));
    return view;
  }

  it("zeigt immer aktive Module und drei Schalter", async () => {
    await open();
    const table = screen.getByRole("table", { name: "Module" });
    expect(within(table).getAllByText("Immer aktiv")).toHaveLength(4);
    for (const name of ["Sammelrechnung", "Mail", "Kalender und Events"]) {
      expect(within(table).getByRole("switch", { name: `Modul ${name}` })).toBeChecked();
    }
    expect(within(table).getAllByText("Ein")).toHaveLength(3);
    expect(screen.getByText("Ausschalten blendet aus.")).toBeVisible();
    expect(screen.getByText("Immer aktiv.")).toBeVisible();
  });

  it("schaltet ein Modul aus und speichert", async () => {
    const { service } = await open();
    await userEvent.click(screen.getByRole("switch", { name: "Modul Mail" }));
    expect(screen.getByRole("switch", { name: "Modul Mail" })).not.toBeChecked();
    expect(screen.getByText("Aus")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));
    await waitFor(() => expect(service.state.org.mail).toBe(false));
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    const { container } = await open();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Mailkonto (Boards 9.5 bis 9.8)", () => {
  async function open(seed: MemorySeed = {}) {
    const view = setup(seed);
    await goTo("Mailkonto");
    await screen.findByRole("heading", { level: 1, name: "Mailkonto" });
    return view;
  }

  it("zeigt das Formular, ohne das Passwort anzuzeigen (9.5)", async () => {
    await open();
    expect(screen.getByText("Einstellungen / Mailkonto")).toBeVisible();
    expect(screen.getByText("Nicht getestet")).toBeVisible();
    const password = screen.getByLabelText(/^Passwort oder App-Passwort/);
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveValue("");
    expect(password).toHaveAccessibleDescription("Kein OAuth: Passwort oder App-Passwort.");
    expect(screen.getByLabelText(/^IMAP-Server/)).toHaveValue("imap.example.ch");
    expect(screen.getAllByLabelText(/^Port/).map((x) => (x as HTMLInputElement).value)).toEqual([
      "993",
      "465",
    ]);
    expect(screen.getAllByLabelText(/^Verschlüsselung/)[0]).toHaveDisplayValue("SSL/TLS");
    const steps = screen.getByRole("heading", { name: "Verbindungstest" }).closest("section")!;
    expect(within(steps).getAllByRole("listitem")).toHaveLength(6);
    expect(within(steps).getByText("Testmail an Sie selbst")).toBeVisible();
    expect(
      screen.getByText("Testen Sie die Verbindung, bevor Sie speichern.", { exact: false }),
    ).toHaveTextContent("Die Testmail geht an sabine.muster@example.ch.");
    expect(screen.getByRole("button", { name: "Verbindung testen" })).toHaveClass("btn--primary");
  });

  it("verlangt das Passwort zum Speichern geänderter Angaben", async () => {
    const { service } = await open();
    const host = screen.getByLabelText(/^IMAP-Server/);
    await userEvent.clear(host);
    await userEvent.type(host, "imap.neu.example.ch");
    await userEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));
    expect(await screen.findByText(/Geben Sie das Passwort ein/)).toBeVisible();
    expect(service.state.mail.draft.imapHost).toBe("imap.example.ch");

    await userEvent.type(screen.getByLabelText(/^Passwort oder App-Passwort/), "geheim-12345");
    await userEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));
    await waitFor(() => expect(service.state.mail.draft.imapHost).toBe("imap.neu.example.ch"));
    // Nach dem Speichern ist das Feld wieder leer, das Passwort bleibt nie in der Oberfläche.
    await waitFor(() =>
      expect(screen.getByLabelText(/^Passwort oder App-Passwort/)).toHaveValue(""),
    );
    expect(service.state.mail.draft.password).toBe("");
  });

  it("zeigt den laufenden Test und bricht ihn ab (9.6)", async () => {
    await open({ mailTestHangs: true });
    await userEvent.click(screen.getByRole("button", { name: "Verbindung testen" }));
    expect(await screen.findByText("Test läuft: Stufe 1 von 6.")).toBeVisible();
    expect(screen.getByText("Test läuft")).toBeVisible();
    expect(screen.getByLabelText("IMAP-Server (Empfang)")).toHaveAttribute("readonly");
    expect(screen.getByRole("img", { name: /Stufe 1 läuft, 5 ausstehend/ })).toBeVisible();
    const table = screen.getByRole("table", { name: "Teststufen" });
    expect(within(table).getByText("Läuft")).toBeVisible();
    expect(within(table).getAllByText("Ausstehend")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Änderungen speichern" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Test abbrechen" }));
    expect(screen.getByText("Nicht getestet")).toBeVisible();
    expect(screen.queryByRole("table", { name: "Teststufen" })).not.toBeInTheDocument();
  });

  it("meldet einen fehlgeschlagenen Test an Stufe und Feld (9.7)", async () => {
    await open({ mailTest: { failAt: 2 } });
    await userEvent.click(screen.getByRole("button", { name: "Verbindung testen" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Test fehlgeschlagen bei Stufe 3: IMAP-Anmeldung.");
    expect(alert).toHaveTextContent("Die Stufen 4 bis 6 wurden nicht geprüft.");
    expect(screen.getByRole("button", { name: "Erneut testen" })).toHaveClass("btn--primary");
    const table = screen.getByRole("table", { name: "Teststufen" });
    expect(within(table).getByText("Fehlgeschlagen")).toBeVisible();
    expect(within(table).getAllByText("Nicht geprüft")).toHaveLength(3);
    const password = screen.getByLabelText(/^Passwort oder App-Passwort/);
    expect(password).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByText("Der Server hat die Anmeldung abgelehnt. Prüfen Sie das Passwort", {
        exact: false,
        selector: ".lbl__error span",
      }),
    ).toBeVisible();
  });

  it("zeigt den erfolgreichen Test mit Dauer und Testmail (9.8)", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Verbindung testen" }));
    expect(await screen.findByText("Mailkonto funktioniert.")).toBeVisible();
    expect(screen.getByText("Test erfolgreich")).toBeVisible();
    expect(
      screen.getByText(/Alle 6 Stufen sind erfolgreich. Die Testmail ist um 14:41 bei sabine/),
    ).toBeVisible();
    const table = screen.getByRole("table", { name: "Teststufen" });
    expect(within(table).getAllByText("Erfolgreich")).toHaveLength(6);
    expect(within(table).getByText("2.6 s")).toBeVisible();
    expect(screen.getByRole("button", { name: "Änderungen speichern" })).toHaveClass(
      "btn--primary",
    );
    expect(screen.getByRole("button", { name: "Erneut testen" })).not.toHaveClass("btn--primary");
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    const { container } = await open({ mailTest: { failAt: 2 } });
    await userEvent.click(screen.getByRole("button", { name: "Verbindung testen" }));
    await screen.findByRole("alert");
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Benutzer und Sicherheit (Boards 9.9 bis 9.12)", () => {
  async function open(seed: MemorySeed = {}) {
    const view = setup(seed);
    await goTo("Benutzer und Sicherheit");
    await screen.findByRole("table", { name: "Benutzer" });
    return view;
  }

  it("listet die Benutzer und die eigene Anmeldung (9.9)", async () => {
    await open();
    expect(screen.getByRole("heading", { name: "Benutzer (3)" })).toBeVisible();
    const table = screen.getByRole("table", { name: "Benutzer" });
    expect(within(table).getByText("(Sie)")).toBeVisible();
    expect(within(table).getAllByText("Aktiv")).toHaveLength(3);
    // Der eigene Eintrag lässt sich nicht entfernen.
    expect(within(table).getAllByRole("button", { name: /^Benutzer entfernen/ })).toHaveLength(2);
    expect(screen.getByText("Geändert am 14.08.2026")).toBeVisible();
    expect(screen.getByText("Aktiv seit 12.01.2026")).toBeVisible();
    expect(screen.getByText("8 von 10 unbenutzt")).toBeVisible();
    expect(screen.getByText("Gerät dieser Sitzung")).toBeVisible();
    expect(screen.getByText("Firefox auf Windows")).toBeVisible();
    expect(screen.getByText("Kein Rollenkonzept.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Benutzer hinzufügen" })).toHaveClass("btn--primary");
  });

  it("lädt einen Benutzer per E-Mail ein", async () => {
    const { service } = await open();
    await userEvent.click(screen.getByRole("button", { name: "Benutzer hinzufügen" }));
    const dialog = screen.getByRole("dialog", { name: "Neuen Benutzer hinzufügen?" });
    expect(within(dialog).getByText("Vollzugriff.")).toBeVisible();
    expect(within(dialog).getByLabelText(/^E-Mail-Adresse/)).toHaveAccessibleDescription(
      "An diese Adresse geht die Einladung.",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Einladung senden" }));
    expect(within(dialog).getAllByText("Bitte ausfüllen.")).toHaveLength(2);

    await userEvent.type(within(dialog).getByLabelText(/^Name/), "Daniel Demo");
    await userEvent.type(
      within(dialog).getByLabelText(/^E-Mail-Adresse/),
      "daniel.demo@example.ch",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Einladung senden" }));
    await waitFor(() =>
      expect(service.state.added).toEqual([
        { name: "Daniel Demo", email: "daniel.demo@example.ch" },
      ]),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Benutzer (4)" })).toBeVisible();
  });

  it("entfernt einen Benutzer erst nach Eingabe seiner Adresse (9.10)", async () => {
    const { service } = await open();
    await userEvent.click(screen.getByRole("button", { name: "Benutzer entfernen: Claudia Test" }));
    const dialog = screen.getByRole("dialog", { name: "Benutzer «Claudia Test» entfernen?" });
    expect(within(dialog).getByText("Claudia Test verliert sofort den Zugriff.")).toBeVisible();
    expect(within(dialog).getByText("31.10.2026 16:59")).toBeVisible();
    const remove = within(dialog).getByRole("button", { name: "Benutzer entfernen" });
    expect(remove).toBeDisabled();
    const confirm = within(dialog).getByLabelText(/^Zur Bestätigung E-Mail-Adresse eintippen/);
    expect(confirm).toHaveAccessibleDescription("Geben Sie «claudia.test@example.ch» ein.");
    await userEvent.type(confirm, "claudia.test@example.ch");
    expect(remove).toBeEnabled();
    await userEvent.click(remove);
    await waitFor(() => expect(service.state.removed).toEqual(["u3"]));
    expect(await screen.findByRole("heading", { name: "Benutzer (2)" })).toBeVisible();
  });

  it("richtet den Einmalcode neu ein, mit QR-Code und Schlüssel (9.11)", async () => {
    const { service } = await open();
    await userEvent.click(screen.getByRole("button", { name: "2FA neu einrichten" }));
    const dialog = await screen.findByRole("dialog", { name: "Einmalcode (2FA) neu einrichten?" });
    // Ohne frischen bisherigen Einmalcode gibt es weder QR-Code noch Schlüssel.
    expect(within(dialog).queryByRole("img", { name: /QR-Code/ })).not.toBeInTheDocument();
    const current = within(dialog).getByLabelText(/^Bisheriger Einmalcode/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Weiter" }));
    expect(await within(dialog).findByText("Geben Sie alle 6 Ziffern ein.")).toBeVisible();
    await userEvent.type(current, "111111");
    await userEvent.click(within(dialog).getByRole("button", { name: "Weiter" }));
    expect(await within(dialog).findByText("Der Code ist nicht gültig.")).toBeVisible();
    expect(within(dialog).queryByText("DEMO-5Q2K-7XM4-TEST")).not.toBeInTheDocument();
    await userEvent.clear(current);
    await userEvent.type(current, "482916");
    await userEvent.click(within(dialog).getByRole("button", { name: "Weiter" }));
    expect(await within(dialog).findByRole("img", { name: /QR-Code/ })).toBeVisible();
    expect(within(dialog).getByText("DEMO-5Q2K-7XM4-TEST")).toBeVisible();
    expect(within(dialog).getByText("Der bisherige Einmalcode wird ungültig.")).toBeVisible();
    const code = within(dialog).getByLabelText(/^2\. Einmalcode zur Bestätigung/);
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
    await userEvent.type(code, "111111");
    await userEvent.click(within(dialog).getByRole("button", { name: "Einmalcode aktivieren" }));
    expect(await within(dialog).findByText("Der Code ist nicht gültig.")).toBeVisible();
    await userEvent.clear(code);
    await userEvent.type(code, "482916");
    await userEvent.click(within(dialog).getByRole("button", { name: "Einmalcode aktivieren" }));
    await waitFor(() => expect(service.state.totpConfirmed).toBe(true));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("sperrt «2FA neu einrichten», wenn die API es nicht kann", async () => {
    await open({ features: { ...allFeatures, totpRenewal: false } });
    expect(screen.getByRole("button", { name: "2FA neu einrichten" })).toBeDisabled();
  });

  it("zeigt neue Wiederherstellungscodes erst nach dem Einmalcode, einmalig (9.12)", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Neue Wiederherstellungscodes" }));
    let dialog = screen.getByRole("dialog", { name: "Neue Wiederherstellungscodes" });
    expect(within(dialog).queryByText("XK7M2-QD94F")).not.toBeInTheDocument();
    await userEvent.type(
      within(dialog).getByLabelText(/^2\. Einmalcode zur Bestätigung/),
      "111111",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Neue Codes erzeugen" }));
    expect(await within(dialog).findByText("Der Code ist nicht gültig.")).toBeVisible();
    await userEvent.clear(within(dialog).getByLabelText(/^2\. Einmalcode zur Bestätigung/));
    await userEvent.type(
      within(dialog).getByLabelText(/^2\. Einmalcode zur Bestätigung/),
      "482916",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Neue Codes erzeugen" }));

    dialog = await screen.findByRole("dialog", { name: "Neue Wiederherstellungscodes" });
    expect(await within(dialog).findByText("Diese Codes sehen Sie nur jetzt.")).toBeVisible();
    const list = within(dialog).getByRole("list", { name: "Ihre Wiederherstellungscodes" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(10);
    expect(within(list).getByText("XK7M2-QD94F")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Codes kopieren" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Codes drucken" })).toBeVisible();
    const confirm = within(dialog).getByRole("button", { name: "Codes bestätigen" });
    expect(confirm).toBeDisabled();
    await userEvent.click(within(dialog).getByLabelText("Ich habe die Codes sicher gespeichert."));
    expect(confirm).toBeEnabled();
    expect(await axe(dialog)).toHaveNoViolations();
    await userEvent.click(confirm);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("XK7M2-QD94F")).not.toBeInTheDocument();
  });

  it("ändert das Passwort", async () => {
    const { service } = await open();
    await userEvent.click(screen.getByRole("button", { name: "Passwort ändern" }));
    const dialog = screen.getByRole("dialog", { name: "Passwort ändern" });
    await userEvent.type(within(dialog).getByLabelText(/^Aktuelles Passwort/), "falsch");
    await userEvent.type(
      within(dialog).getByLabelText(/^Neues Passwort \*$/),
      "ein-langes-Passwort-1",
    );
    await userEvent.type(
      within(dialog).getByLabelText(/^Neues Passwort wiederholen/),
      "ein-langes-Passwort-1",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Passwort ändern" }));
    expect(await within(dialog).findByText("Das aktuelle Passwort stimmt nicht.")).toBeVisible();
    const current = within(dialog).getByLabelText(/^Aktuelles Passwort/);
    await userEvent.clear(current);
    await userEvent.type(current, "Altes-Passwort-1234");
    await userEvent.click(within(dialog).getByRole("button", { name: "Passwort ändern" }));
    await waitFor(() => expect(service.state.password?.next).toBe("ein-langes-Passwort-1"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    const { container } = await open();
    expect(await axe(container)).toHaveNoViolations();
    await userEvent.click(screen.getByRole("button", { name: "Benutzer hinzufügen" }));
    expect(await axe(screen.getByRole("dialog"))).toHaveNoViolations();
  });
});

describe("Protokoll (Board 9.13)", () => {
  async function open(seed: MemorySeed = {}) {
    const view = setup(seed);
    await goTo("Protokoll");
    await screen.findByRole("table", { name: "Protokoll" });
    return view;
  }

  it("zeigt Einträge, Zähler, Seitenzahl und aktive Filter", async () => {
    await open();
    expect(screen.getByText("Nur lesbar")).toBeVisible();
    expect(screen.getByText("Einträge sind unveränderlich.")).toBeVisible();
    const table = screen.getByRole("table", { name: "Protokoll" });
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual([
      "Zeit",
      "Benutzer",
      "Aktion",
      "Objekt",
      "Ergebnis",
    ]);
    expect(headers[0]).toHaveAttribute("aria-sort", "descending");
    expect(within(table).getByText("02.11.2026 14:52")).toBeVisible();
    expect(within(table).getByText("Sabine Muster")).toBeVisible();
    expect(within(table).getByText("Organisation geändert")).toBeVisible();
    expect(within(table).getAllByText("Erfolgreich")).toHaveLength(3);
    expect(screen.getByText("3 von 2'418")).toBeVisible();
    expect(screen.getByText("Seite 1 von 173")).toBeVisible();
    expect(screen.getByText("Aktive Filter:")).toBeVisible();
    expect(screen.getByText("Zeitraum: Letzte 30 Tage", { selector: ".tag" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Vorherige Seite" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Nächste Seite" })).toBeEnabled();
    expect(screen.getByRole("searchbox", { name: "Protokoll durchsuchen" })).toHaveAttribute(
      "placeholder",
      "Objekt oder Aktion suchen",
    );
  });

  it("filtert nach Benutzer und setzt zurück", async () => {
    await open();
    await userEvent.selectOptions(screen.getByLabelText("Benutzer"), "Beat Probe");
    const table = screen.getByRole("table", { name: "Protokoll" });
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(2));
    expect(within(table).getByText("Benutzer hinzugefügt")).toBeVisible();
    expect(screen.getByText("Benutzer: Beat Probe", { selector: ".tag" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Filter Zeitraum entfernen" }));
    expect(screen.queryByText(/^Zeitraum:/, { selector: ".tag" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Alle zurücksetzen" }));
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(4));
    expect(screen.queryByText("Aktive Filter:")).not.toBeInTheDocument();
  });

  it("exportiert das Protokoll", async () => {
    const created = vi.fn(() => "blob:test");
    URL.createObjectURL = created;
    URL.revokeObjectURL = vi.fn();
    const { service } = await open();
    await userEvent.click(screen.getByRole("button", { name: "Protokoll exportieren (.xlsx)" }));
    await waitFor(() => expect(service.state.exported).toBe(1));
    expect(await screen.findByText("Protokoll exportiert.")).toBeVisible();
  });

  it("zeigt ohne Ergebnis-Spalte, wenn die API keines liefert, und beschriftet den Export ehrlich", async () => {
    await open({ features: { ...allFeatures, auditResult: false, auditXlsx: false } });
    const table = screen.getByRole("table", { name: "Protokoll" });
    expect(within(table).queryByRole("columnheader", { name: "Ergebnis" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Protokoll exportieren (.csv)" })).toBeVisible();
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    const { container } = await open();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Lizenz (Boards 9.14 und 9.15)", () => {
  async function open(seed: MemorySeed = {}) {
    const view = setup(seed);
    await goTo("Lizenz");
    await screen.findByRole("heading", { level: 1, name: "Lizenz" });
    await screen.findByText("Ihre Lizenz", { selector: "h2" });
    return view;
  }

  it("zeigt die aktive Lizenz mit Restdauer und Modulen (9.14)", async () => {
    await open();
    expect(screen.getAllByText("Aktiv").length).toBeGreaterThan(0);
    const kv = screen.getByRole("heading", { name: "Ihre Lizenz" }).closest("section")!;
    for (const text of ["Verein Beispiel", "K-0042", "L-2026-0042", "01.01.2026", "31.12.2026"]) {
      expect(within(kv).getByText(text)).toBeVisible();
    }
    expect(within(kv).getByText("Aktiv, noch 59 Tage")).toBeVisible();
    expect(within(kv).getByText("3")).toBeVisible();
    const always = screen.getByRole("heading", { name: "Immer enthalten" }).closest("section")!;
    expect(within(always).getAllByText(/./).length).toBeGreaterThanOrEqual(4);
    const optional = screen
      .getByRole("heading", { name: "Optionale Module, eingeschaltet" })
      .closest("section")!;
    expect(within(optional).getByText("Kalender und Events")).toBeVisible();
    expect(screen.getByText(/Nennen Sie die Kunden-ID/)).toHaveTextContent("K-0042");
    expect(screen.getByRole("link", { name: "Anbieter kontaktieren" })).toHaveAttribute(
      "href",
      "mailto:support@anbieter.example.ch",
    );
    expect(screen.getByText("Der Anbieter sieht keine Daten.")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("zeigt die abgelaufene Lizenz mit Nur-Lesen-Hinweis (9.15)", async () => {
    await open({
      licence: {
        state: "expired",
        validUntil: "2026-10-21",
        licensee: "Verein Beispiel",
        customerId: "K-0042",
        licenceNo: "L-2025-0042",
        validFrom: "2025-10-22",
        users: 3,
        providerEmail: "support@anbieter.example.ch",
      },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Die Lizenz ist abgelaufen. Stammbuch ist im Nur-Lesen-Modus.",
    );
    expect(screen.getByText("Abgelaufen seit 12 Tagen")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Weiterhin möglich" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Gesperrt" })).toBeVisible();
    expect(screen.getByText("Rechnungen erstellen, versenden und mahnen")).toBeVisible();
    expect(screen.getByRole("link", { name: "Anbieter kontaktieren" })).toHaveClass("btn--primary");
    expect(screen.getByText("Daten bleiben erhalten.")).toBeVisible();
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    const { container } = await open();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("zeigt bei einem Fehler die Angaben für den Support", async () => {
    setup({ licence: undefined });
    await goTo("Lizenz");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Die Einstellungen konnten nicht geladen werden.",
    );
    expect(screen.getByRole("heading", { name: "Angaben für den Support" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Erneut laden" })).toBeVisible();
  });
});

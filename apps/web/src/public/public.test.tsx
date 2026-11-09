import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { axe } from "vitest-axe";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test-utils";
import { ConfirmPage } from "./ConfirmPage";
import { RegisterPage, validate } from "./RegisterPage";
import { ResponsePage } from "./ResponsePage";
import {
  createHttpInvitationService,
  createHttpRegistrationService,
  type InvitationService,
  type InvitationView,
  type RegistrationService,
} from "./publicService";

function registration(overrides: Partial<RegistrationService> = {}): RegistrationService {
  return {
    begin: vi.fn().mockResolvedValue("token-1"),
    submit: vi.fn().mockResolvedValue({ status: "accepted" }),
    confirm: vi.fn().mockResolvedValue("confirmed"),
    ...overrides,
  };
}

function renderRegister(service: RegistrationService) {
  return renderWithProviders(
    <Routes>
      <Route path="/registrierung/:kunde" element={<RegisterPage service={service} />} />
    </Routes>,
    { path: "/registrierung/verein-beispiel", session: null },
  );
}

async function fillPerson() {
  await userEvent.type(screen.getByLabelText(/^Vorname/), "Anna");
  await userEvent.type(screen.getByLabelText(/^Nachname/), "Beispiel");
  await userEvent.type(screen.getByLabelText(/^Strasse und Nr\./), "Beispielstrasse 12");
  await userEvent.type(screen.getByLabelText(/^PLZ/), "8000");
  await userEvent.type(screen.getByLabelText(/^Ort/), "Musterhausen");
  await userEvent.type(screen.getByLabelText(/^E-Mail-Adresse/), "anna.beispiel@example.ch");
  await userEvent.click(screen.getByRole("checkbox"));
}

describe("Registrierung Person (1.7)", () => {
  it("zeigt Titel, Auswahl, Pflichtfelder mit Stern, Platzhalter und Schaltflächen", async () => {
    const { container } = renderRegister(registration());
    expect(
      screen.getByRole("heading", { level: 1, name: "Registrierung als Person" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Person" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Firma" })).not.toBeChecked();
    expect(screen.queryByText(/sind Pflicht/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^PLZ/)).toHaveAttribute("placeholder", "0000");
    expect(screen.getByLabelText(/^PLZ/)).toBeRequired();
    expect(screen.getByLabelText("Geburtsdatum")).toHaveAttribute("placeholder", "TT.MM.JJJJ");
    expect(screen.getByLabelText("Geburtsdatum")).not.toBeRequired();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("link", { name: "Zum Inhalt springen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Person registrieren" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abbrechen" })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("meldet fehlende Pflichtfelder mit Anzahl und sendet nichts", async () => {
    const service = registration();
    const { container } = renderRegister(service);
    await userEvent.click(screen.getByRole("button", { name: "Person registrieren" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Prüfen Sie 7 Felder.");
    expect(screen.getByLabelText(/^Vorname/)).toBeInvalid();
    expect(screen.getByText("Die PLZ besteht aus 4 Ziffern.")).toBeInTheDocument();
    expect(screen.getByText(/Datenschutzerklärung gelesen haben/)).toBeInTheDocument();
    expect(service.submit).not.toHaveBeenCalled();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("sendet die Angaben und zeigt die Bestätigung (1.9)", async () => {
    const service = registration();
    const { container } = renderRegister(service);
    await fillPerson();
    await userEvent.click(screen.getByRole("button", { name: "Person registrieren" }));
    expect(service.submit).toHaveBeenCalledWith("verein-beispiel", "token-1", "", {
      kind: "person",
      firstName: "Anna",
      lastName: "Beispiel",
      street: "Beispielstrasse 12",
      zip: "8000",
      city: "Musterhausen",
      email: "anna.beispiel@example.ch",
      birthDate: "",
    });
    const heading = await screen.findByRole("heading", { name: "Registrierung eingegangen" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Vielen Dank. Wir haben eine Bestätigung an anna.beispiel@example.ch gesendet.",
    );
    const list = screen.getByText("Eingegangen").closest("dl")!;
    expect(within(list).getByText("Anna Beispiel")).toBeInTheDocument();
    expect(screen.queryByText("Referenz")).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("zeigt die Referenz, wenn die API eine liefert", async () => {
    renderRegister(
      registration({
        submit: vi.fn().mockResolvedValue({ status: "accepted", reference: "REG-2026-00418" }),
      }),
    );
    await fillPerson();
    await userEvent.click(screen.getByRole("button", { name: "Person registrieren" }));
    expect(await screen.findByText("REG-2026-00418")).toBeInTheDocument();
    expect(screen.getByText(/Nennen Sie bei Rückfragen die Referenz/)).toBeInTheDocument();
  });

  it("holt nach einer Ablehnung ein neues Formular-Token", async () => {
    const begin = vi.fn().mockResolvedValueOnce("token-1").mockResolvedValueOnce("token-2");
    const submit = vi
      .fn()
      .mockResolvedValueOnce({ status: "rejected" })
      .mockResolvedValueOnce({ status: "accepted" });
    renderRegister(registration({ begin, submit }));
    await fillPerson();
    await userEvent.click(screen.getByRole("button", { name: "Person registrieren" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Das Formular ist abgelaufen.");
    await userEvent.click(screen.getByRole("button", { name: "Person registrieren" }));
    expect(submit).toHaveBeenLastCalledWith(
      "verein-beispiel",
      "token-2",
      "",
      expect.objectContaining({ kind: "person" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Registrierung eingegangen" }),
    ).toBeInTheDocument();
  });

  it("meldet einen nicht erreichbaren Dienst, statt zu schweigen", async () => {
    renderRegister(registration({ submit: vi.fn().mockRejectedValue(new Error("offline")) }));
    await fillPerson();
    await userEvent.click(screen.getByRole("button", { name: "Person registrieren" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Der Dienst ist nicht erreichbar.");
  });

  it("zeigt bei unbekanntem Verein einen Fehler statt des Formulars", async () => {
    renderRegister(registration({ begin: vi.fn().mockResolvedValue(null) }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Die Registrierung ist unter dieser Adresse nicht möglich.",
    );
    expect(screen.queryByLabelText(/^Vorname/)).not.toBeInTheDocument();
  });

  it("«Abbrechen» leert das Formular", async () => {
    renderRegister(registration());
    await userEvent.type(screen.getByLabelText(/^Vorname/), "Anna");
    await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(screen.getByLabelText(/^Vorname/)).toHaveValue("");
  });

  it("hat ein verstecktes Feld gegen Bots, das für Hilfstechnik nicht erscheint", () => {
    renderRegister(registration());
    const trap = document.querySelector<HTMLInputElement>('input[name="website"]')!;
    expect(trap).toHaveAttribute("tabindex", "-1");
    expect(trap.closest("[aria-hidden='true']")).not.toBeNull();
  });
});

describe("Registrierung Firma (1.8)", () => {
  it("wechselt zur Firma: Hinweis, Felder, Pflicht-UID und Senden", async () => {
    const service = registration();
    const { container } = renderRegister(service);
    await userEvent.click(screen.getByRole("radio", { name: "Firma" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "Registrierung als Firma" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^UID/)).toHaveAttribute("placeholder", "CHE-000.000.000");
    expect(screen.getByLabelText("MwSt-Nr.")).toHaveAccessibleDescription("Nur bei MwSt-Pflicht");
    expect(screen.getByLabelText("Telefon")).toHaveAttribute("placeholder", "+41 44 000 00 00");
    expect(await axe(container)).toHaveNoViolations();

    await userEvent.type(screen.getByLabelText(/^Firmenname/), "Beispiel Treuhand AG");
    await userEvent.type(screen.getByLabelText(/^UID/), "CHE-123.456.789");
    await userEvent.type(screen.getByLabelText(/^Strasse und Nr\./), "Probegasse 4");
    await userEvent.type(screen.getByLabelText(/^PLZ/), "8001");
    await userEvent.type(screen.getByLabelText(/^Ort/), "Musterhausen");
    await userEvent.type(screen.getByLabelText(/^Kontaktperson/), "Beat Muster");
    await userEvent.type(screen.getByLabelText(/^E-Mail-Adresse/), "info@beispiel.example.ch");
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Firma registrieren" }));
    expect(service.submit).toHaveBeenCalledWith(
      "verein-beispiel",
      "token-1",
      "",
      expect.objectContaining({
        kind: "firma",
        name: "Beispiel Treuhand AG",
        uid: "CHE-123.456.789",
      }),
    );
    expect(await screen.findByText("Beispiel Treuhand AG")).toBeInTheDocument();
  });

  it("prüft UID, MwSt-Nr. und Telefon auf die Form", () => {
    const base = {
      firstName: "",
      lastName: "",
      street: "Probegasse 4",
      zip: "8001",
      city: "Musterhausen",
      email: "a@b.ch",
      birth: "",
      company: "X AG",
      uid: "123",
      mwst: "CHE-123.456.789",
      contact: "Beat Muster",
      phone: "abc",
    };
    const e = validate("firma", base, true);
    expect(Object.keys(e).sort()).toEqual(["mwst", "phone", "uid"]);
    expect(
      validate(
        "firma",
        {
          ...base,
          uid: "CHE-123.456.789",
          mwst: "CHE-123.456.789 MWST",
          phone: "+41 44 000 00 00",
        },
        true,
      ),
    ).toEqual({});
  });
});

const view: InvitationView = {
  event: {
    title: "Generalversammlung 2026",
    location: "Gemeindesaal Musterhausen, Probegasse 4",
    startsAt: "2026-11-14T16:00:00.000Z",
    endsAt: "2026-11-14T19:00:00.000Z",
    registrationDeadline: "2026-11-06T22:59:00.000Z",
    maxGuests: 3,
  },
  open: true,
  invitee: "Anna Beispiel",
  response: null,
};

function invitation(overrides: Partial<InvitationService> = {}): InvitationService {
  return {
    load: vi.fn().mockResolvedValue(view),
    respond: vi.fn(),
    ...overrides,
  };
}

function renderResponse(service: InvitationService) {
  return renderWithProviders(
    <Routes>
      <Route path="/antwort/:token" element={<ResponsePage service={service} />} />
    </Routes>,
    { path: "/antwort/abc", session: null },
  );
}

describe("Registrierung bestätigen", () => {
  function renderConfirm(service: RegistrationService, hash = "#tok-123") {
    return renderWithProviders(
      <Routes>
        <Route
          path="/registrierung/:kunde/bestaetigen"
          element={<ConfirmPage service={service} />}
        />
      </Routes>,
      { path: `/registrierung/verein-beispiel/bestaetigen${hash}`, session: null },
    );
  }

  it("löst das Token erst auf Knopfdruck ein und zeigt danach die Bestätigung", async () => {
    const service = registration();
    const { container } = renderConfirm(service);
    expect(service.confirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Registrierung bestätigen" }));
    expect(service.confirm).toHaveBeenCalledWith("verein-beispiel", "tok-123");
    expect(await screen.findByText("Registrierung bestätigt")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each([
    ["invalid", "Der Link ist ungültig oder abgelaufen."],
    ["unknown", "Die Registrierung ist unter dieser Adresse nicht möglich."],
    ["tooMany", "Zu viele Versuche."],
  ] as const)("zeigt bei %s eine Fehlermeldung", async (outcome, title) => {
    renderConfirm(registration({ confirm: vi.fn().mockResolvedValue(outcome) }));
    await userEvent.click(screen.getByRole("button", { name: "Registrierung bestätigen" }));
    expect(await screen.findByText(title)).toBeInTheDocument();
  });

  it("meldet einen nicht erreichbaren Dienst und lässt es erneut zu", async () => {
    renderConfirm(registration({ confirm: vi.fn().mockRejectedValue(new Error("down")) }));
    await userEvent.click(screen.getByRole("button", { name: "Registrierung bestätigen" }));
    expect(await screen.findByText("Der Dienst ist nicht erreichbar.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Registrierung bestätigen" })).toBeEnabled();
  });

  it("ohne Token im Link gibt es nur die Fehlermeldung", () => {
    const service = registration();
    renderConfirm(service, "");
    expect(screen.getByText("Der Link ist ungültig oder abgelaufen.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(service.confirm).not.toHaveBeenCalled();
  });
});

describe("Einladungs-Antwort (1.10)", () => {
  it("zeigt Veranstaltung, Frist, Eingeladene und die Felder", async () => {
    const { container } = renderResponse(invitation());
    expect(
      await screen.findByRole("heading", { level: 1, name: "Einladung: Generalversammlung 2026" }),
    ).toBeInTheDocument();
    const list = screen.getByText("Datum").closest("dl")!;
    expect(within(list).getByText("Samstag, 14.11.2026 · 17:00–20:00")).toBeInTheDocument();
    expect(within(list).getByText("Gemeindesaal Musterhausen, Probegasse 4")).toBeInTheDocument();
    expect(within(list).getByText("06.11.2026 · 23:59")).toBeInTheDocument();
    expect(within(list).getByText("Anna Beispiel")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Ich sage zu" })).not.toBeChecked();
    expect(screen.getByLabelText("Anzahl Begleitpersonen")).toHaveAccessibleDescription(
      "Ohne Sie selbst.",
    );
    expect(screen.getByLabelText("Hinweis an den Verein")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("verlangt eine Rückmeldung und prüft die Zahl der Begleitpersonen", async () => {
    const service = invitation();
    renderResponse(service);
    await userEvent.click(await screen.findByRole("button", { name: "Rückmeldung senden" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Prüfen Sie 1 Feld.");
    expect(screen.getByText("Wählen Sie Ihre Rückmeldung.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Ich sage zu" }));
    await userEvent.type(screen.getByLabelText("Anzahl Begleitpersonen"), "5");
    await userEvent.click(screen.getByRole("button", { name: "Rückmeldung senden" }));
    expect(screen.getByText("Zulässig sind 0 bis 3 Begleitpersonen.")).toBeInTheDocument();
    expect(service.respond).not.toHaveBeenCalled();
  });

  it("sendet die Zusage und zeigt danach Danke (1.12) mit Antwort ändern", async () => {
    const answered: InvitationView = {
      ...view,
      response: { status: "accepted", guests: 1, note: "Platz ohne Treppen" },
    };
    const service = invitation({
      respond: vi.fn().mockResolvedValue({ status: "ok", view: answered }),
    });
    const { container } = renderResponse(service);
    await userEvent.click(await screen.findByRole("radio", { name: "Ich sage zu" }));
    await userEvent.type(screen.getByLabelText("Anzahl Begleitpersonen"), "1");
    await userEvent.type(screen.getByLabelText("Hinweis an den Verein"), "Platz ohne Treppen");
    await userEvent.click(screen.getByRole("button", { name: "Rückmeldung senden" }));
    expect(service.respond).toHaveBeenCalledWith("abc", {
      status: "accepted",
      guests: 1,
      note: "Platz ohne Treppen",
    });
    expect(
      await screen.findByRole("heading", { name: "Danke für Ihre Rückmeldung" }),
    ).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Ihre Zusage ist gespeichert.");
    expect(
      screen.getByText("Sie können Ihre Antwort bis 06.11.2026 · 23:59 ändern."),
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();

    await userEvent.click(screen.getByRole("button", { name: "Antwort ändern" }));
    expect(screen.getByRole("radio", { name: "Ich sage zu" })).toBeChecked();
    expect(screen.getByLabelText("Anzahl Begleitpersonen")).toHaveValue("1");
  });

  it("sendet bei einer Absage keine Begleitpersonen", async () => {
    const service = invitation({
      respond: vi.fn().mockResolvedValue({
        status: "ok",
        view: { ...view, response: { status: "declined", guests: 0, note: "" } },
      }),
    });
    renderResponse(service);
    await userEvent.click(await screen.findByRole("radio", { name: "Ich sage ab" }));
    await userEvent.click(screen.getByRole("button", { name: "Rückmeldung senden" }));
    expect(service.respond).toHaveBeenCalledWith("abc", {
      status: "declined",
      guests: 0,
      note: "",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Ihre Absage ist gespeichert.");
    expect(screen.queryByText("Begleitpersonen")).not.toBeInTheDocument();
  });

  it("blendet die Begleitpersonen aus, wenn keine erlaubt sind", async () => {
    renderResponse(
      invitation({
        load: vi.fn().mockResolvedValue({ ...view, event: { ...view.event, maxGuests: 0 } }),
      }),
    );
    await screen.findByRole("radio", { name: "Ich sage zu" });
    expect(screen.queryByLabelText("Anzahl Begleitpersonen")).not.toBeInTheDocument();
  });
});

describe("Einladung: Anmeldeschluss vorbei (1.11)", () => {
  it("zeigt die letzte Rückmeldung als gültig und sperrt das Formular", async () => {
    const { container } = renderResponse(
      invitation({
        load: vi.fn().mockResolvedValue({
          ...view,
          open: false,
          response: { status: "accepted", guests: 1, note: "" },
        }),
      }),
    );
    const heading = await screen.findByRole("heading", { name: "Anmeldeschluss vorbei" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText("Generalversammlung 2026")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Die Anmeldefrist ist abgelaufen. Ihre letzte Rückmeldung bleibt gültig: Zusage mit 1 Begleitperson.",
    );
    expect(screen.getByText(/Eine Rückmeldung ist nicht mehr möglich/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rückmeldung senden" })).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("nennt ohne frühere Rückmeldung, dass keine vorliegt", async () => {
    renderResponse(invitation({ load: vi.fn().mockResolvedValue({ ...view, open: false }) }));
    expect(await screen.findByText(/Sie haben keine Rückmeldung gesendet/)).toBeInTheDocument();
  });

  it("lädt den Stand neu, wenn der Anmeldeschluss beim Senden verstrichen ist", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(view)
      .mockResolvedValueOnce({ ...view, open: false });
    renderResponse(invitation({ load, respond: vi.fn().mockResolvedValue({ status: "closed" }) }));
    await userEvent.click(await screen.findByRole("radio", { name: "Ich sage ab" }));
    await userEvent.click(screen.getByRole("button", { name: "Rückmeldung senden" }));
    expect(
      await screen.findByRole("heading", { name: "Anmeldeschluss vorbei" }),
    ).toBeInTheDocument();
  });
});

describe("Einladung: ungültiger Link", () => {
  it("zeigt bei unbekanntem Token dieselbe Meldung wie bei abgelaufenem", async () => {
    renderResponse(invitation({ load: vi.fn().mockResolvedValue(null) }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Der Link ist ungültig oder abgelaufen.",
    );
  });

  it("meldet einen nicht erreichbaren Dienst", async () => {
    renderResponse(invitation({ load: vi.fn().mockRejectedValue(new Error("offline")) }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Der Dienst ist nicht erreichbar.");
  });
});

describe("HTTP-Dienste", () => {
  const json = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  it("holt Formular-Token und sendet die Person ohne Cookies samt Geburtsdatum, die Referenz kommt zurück", async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(() => json(200, { formToken: "t.1" }))
      .mockImplementationOnce(() =>
        json(202, { status: "bestaetigung_gesendet", referenz: "ABCD-2345" }),
      );
    const service = createHttpRegistrationService(fetchFn);
    expect(await service.begin("verein-beispiel")).toBe("t.1");
    expect(fetchFn.mock.calls[0]?.[0]).toBe("/public/verein-beispiel/registrierung/formular");
    const outcome = await service.submit("verein-beispiel", "t.1", "", {
      kind: "person",
      firstName: " Anna ",
      lastName: "Beispiel",
      street: "Beispielstrasse 12",
      zip: "8000",
      city: "Musterhausen",
      email: "anna@example.ch",
      birthDate: "14.03.1985",
    });
    expect(outcome).toEqual({ status: "accepted", reference: "ABCD-2345" });
    const [path, init] = fetchFn.mock.calls[1] as [string, RequestInit];
    expect(path).toBe("/public/verein-beispiel/registrierung/person");
    expect(init.credentials).toBe("omit");
    expect(JSON.parse(String(init.body))).toEqual({
      website: "",
      formToken: "t.1",
      mitglied: {
        typ: "einzel",
        vorname: "Anna",
        nachname: "Beispiel",
        email: "anna@example.ch",
        adresse: { strasse: "Beispielstrasse 12", plz: "8000", ort: "Musterhausen", land: "CH" },
        geburtsdatum: "1985-03-14",
      },
    });
  });

  it("sendet bei der Firma die Kontaktperson", async () => {
    const fetchFn = vi
      .fn()
      .mockImplementation(() => json(202, { status: "bestaetigung_gesendet" }));
    const outcome = await createHttpRegistrationService(fetchFn).submit("v", "t", "", {
      kind: "firma",
      name: "X AG",
      uid: "CHE-123.456.789",
      street: "a",
      zip: "8000",
      city: "b",
      contact: " Beat Muster ",
      email: "a@b.ch",
    });
    expect(outcome).toEqual({ status: "accepted" });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).firma.kontaktperson).toBe("Beat Muster");
  });

  it("löst den Bestätigungslink ein und ordnet Statuscodes zu", async () => {
    const fetchFn = vi.fn().mockImplementation(() => json(200, { status: "bestaetigt" }));
    const service = createHttpRegistrationService(fetchFn);
    expect(await service.confirm("verein-beispiel", "tok")).toBe("confirmed");
    const [path, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/public/verein-beispiel/registrierung/bestaetigen");
    expect(init.credentials).toBe("omit");
    expect(JSON.parse(String(init.body))).toEqual({ token: "tok" });
    const outcome = (status: number) =>
      createHttpRegistrationService(() => json(status, {})).confirm("v", "t");
    expect(await outcome(400)).toBe("invalid");
    expect(await outcome(404)).toBe("unknown");
    expect(await outcome(429)).toBe("tooMany");
    await expect(outcome(500)).rejects.toThrow();
  });

  it("ordnet Statuscodes der Registrierung zu", async () => {
    const outcome = async (status: number) =>
      createHttpRegistrationService(() => json(status, {})).submit("v", "t", "", {
        kind: "firma",
        name: "X AG",
        uid: "CHE-123.456.789",
        street: "a",
        zip: "8000",
        city: "b",
        contact: "c",
        email: "a@b.ch",
      });
    expect(await outcome(400)).toEqual({ status: "rejected" });
    expect(await outcome(404)).toEqual({ status: "unknown" });
    expect(await outcome(429)).toEqual({ status: "tooMany" });
    await expect(outcome(500)).rejects.toThrow();
  });

  it("liest die Einladung und ordnet 404 und 409 zu", async () => {
    const body = {
      event: { ...view.event, id: "e1" },
      open: true,
      invitee: { name: "Anna Beispiel" },
      response: { status: "accepted", guests: 2, note: "x" },
    };
    const ok = createHttpInvitationService(() => json(200, body));
    expect(await ok.load("a/b")).toEqual({
      ...view,
      response: { status: "accepted", guests: 2, note: "x" },
    });
    expect(await createHttpInvitationService(() => json(404, {})).load("a")).toBeNull();
    const respond = (status: number) =>
      createHttpInvitationService(() => json(status, body)).respond("a", {
        status: "declined",
        guests: 0,
        note: "",
      });
    expect(await respond(409)).toEqual({ status: "closed" });
    expect(await respond(404)).toEqual({ status: "invalid" });
    expect(await respond(400)).toEqual({ status: "rejected" });
  });

  it("kodiert das Token im Pfad", async () => {
    const fetchFn = vi.fn().mockImplementation(() => json(404, {}));
    await createHttpInvitationService(fetchFn).load("a/b?c");
    expect(fetchFn.mock.calls[0]?.[0]).toBe("/calendar/public/responses/a%2Fb%3Fc");
  });
});

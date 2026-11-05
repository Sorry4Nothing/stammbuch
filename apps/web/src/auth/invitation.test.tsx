import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import { axe } from "vitest-axe";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, testSession } from "../test-utils";
import type { AuthService } from "./auth";
import { InvitationPage } from "./InvitationPage";
import { TotpSetupPage } from "./TotpSetupPage";

function Where() {
  const { pathname, hash } = useLocation();
  return <span data-testid="where">{pathname + hash}</span>;
}

function makeService(overrides: Partial<AuthService> = {}): AuthService {
  return {
    signIn: vi.fn(),
    verifyCode: vi.fn(),
    verifyRecovery: vi.fn(),
    reauthenticate: vi.fn(),
    signOut: vi.fn().mockResolvedValue(undefined),
    redeemInvitation: vi.fn().mockResolvedValue({ status: "ok" }),
    beginTotpSetup: vi.fn().mockResolvedValue({
      secret: "JBSWY3DPEHPK3PXP",
      otpauthUri: "otpauth://totp/Stammbuch:a@b.ch?secret=JBSWY3DPEHPK3PXP",
    }),
    confirmTotpSetup: vi.fn().mockResolvedValue({
      status: "ok",
      session: testSession,
      recoveryCodes: ["AAAA-BBBB-CCCC-DDDD", "EEEE-FFFF-GGGG-HHHH"],
    }),
    ...overrides,
  };
}

function flow(service: AuthService, path = "/einladung#das-token") {
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/einladung" element={<InvitationPage />} />
        <Route path="/einladung/zwei-faktor" element={<TotpSetupPage />} />
        <Route path="/anmelden" element={<h1>Anmelden</h1>} />
        <Route path="/" element={<h1>Rahmen</h1>} />
      </Routes>
      <Where />
    </>,
    { path, service, session: null },
  );
}

const PASSWORD = "ein-langes-passwort-42";

async function fill(password = PASSWORD, repeat = password) {
  await userEvent.type(screen.getByLabelText("Passwort"), password);
  await userEvent.type(screen.getByLabelText("Passwort wiederholen"), repeat);
}

describe("Einladung annehmen", () => {
  it("zeigt Titel, Felder und Hinweis, ohne Verstösse gegen die Barrierefreiheit", async () => {
    const { container } = flow(makeService());
    expect(
      screen.getByRole("heading", { level: 1, name: "Einladung annehmen" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Passwort")).toHaveFocus();
    expect(screen.getByLabelText("Passwort")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Passwort")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText("Passwort")).toHaveAccessibleDescription(/Mindestens 12 Zeichen/);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("nimmt das Token aus dem Fragment, entfernt es aus der Adresse und geht zum zweiten Faktor", async () => {
    const service = makeService();
    flow(service);
    // Das Token bleibt nicht in der Adresszeile stehen.
    await vi.waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/einladung$/));
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Weiter zum zweiten Faktor" }));
    expect(service.redeemInvitation).toHaveBeenCalledWith("das-token", PASSWORD);
    expect(
      await screen.findByRole("heading", { name: "Zweiten Faktor einrichten" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/einladung/zwei-faktor");
  });

  it("prüft Länge und Wiederholung, bevor etwas gesendet wird", async () => {
    const service = makeService();
    flow(service);
    const submit = () =>
      userEvent.click(screen.getByRole("button", { name: "Weiter zum zweiten Faktor" }));

    await submit();
    expect(screen.getByRole("alert")).toHaveTextContent("Bitte prüfen Sie 1 Feld.");
    expect(screen.getByLabelText("Passwort")).toBeInvalid();

    await userEvent.type(screen.getByLabelText("Passwort"), "kurz");
    await submit();
    expect(screen.getByText(/mindestens 12 Zeichen/)).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText("Passwort"));
    await fill(PASSWORD, "etwas-anderes-123");
    await submit();
    expect(screen.getByText("Die beiden Passwörter stimmen nicht überein.")).toBeInTheDocument();
    expect(screen.getByLabelText("Passwort wiederholen")).toBeInvalid();
    expect(service.redeemInvitation).not.toHaveBeenCalled();
  });

  it("zeigt für ungültig, abgelaufen und benutzt denselben Text", async () => {
    flow(makeService({ redeemInvitation: vi.fn().mockResolvedValue({ status: "invalid" }) }));
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Weiter zum zweiten Faktor" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Die Einladung ist ungültig oder abgelaufen.");
    expect(screen.queryByLabelText("Passwort")).not.toBeInTheDocument();
  });

  it("ohne Token im Link erscheint derselbe Text, ohne dass etwas gesendet wird", async () => {
    const service = makeService();
    const { container } = flow(service, "/einladung");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Die Einladung ist ungültig oder abgelaufen.",
    );
    expect(await axe(container)).toHaveNoViolations();
    await userEvent.click(screen.getByRole("button", { name: "Zur Anmeldung" }));
    expect(screen.getByRole("heading", { name: "Anmelden" })).toBeInTheDocument();
    expect(service.redeemInvitation).not.toHaveBeenCalled();
  });

  it("zeigt die Erklärung des Servers bei einem schwachen Passwort und leert die Felder", async () => {
    flow(
      makeService({
        redeemInvitation: vi.fn().mockResolvedValue({
          status: "weak",
          message: "Dieses Passwort ist zu einfach oder bekannt.",
        }),
      }),
    );
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Weiter zum zweiten Faktor" }));
    expect(
      await screen.findAllByText("Dieses Passwort ist zu einfach oder bekannt."),
    ).not.toHaveLength(0);
    expect(screen.getByLabelText("Passwort")).toBeInvalid();
    expect(screen.getByLabelText("Passwort")).toHaveValue("");
  });

  it("meldet einen nicht erreichbaren Dienst, statt zu schweigen", async () => {
    flow(makeService({ redeemInvitation: vi.fn().mockRejectedValue(new Error("offline")) }));
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Weiter zum zweiten Faktor" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Der Anmeldedienst ist nicht erreichbar.",
    );
  });
});

describe("Zweiten Faktor einrichten (nach der Einladung)", () => {
  const start = (service = makeService()) => flow(service, "/einladung/zwei-faktor");

  it("fordert den Schlüssel genau einmal an und zeigt ihn in Gruppen", async () => {
    const service = makeService();
    const { container } = start(service);
    expect(await screen.findByText("JBSW Y3DP EHPK 3PXP")).toBeInTheDocument();
    expect(service.beginTotpSetup).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "In der Authenticator-App öffnen" })).toHaveAttribute(
      "href",
      expect.stringMatching(/^otpauth:\/\/totp\//),
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("bestätigt den Code, zeigt die Wiederherstellungscodes einmal und geht erst nach Bestätigung weiter", async () => {
    const service = makeService();
    const { container } = start(service);
    await screen.findByText("JBSW Y3DP EHPK 3PXP");
    await userEvent.click(screen.getAllByRole("textbox")[0]!);
    await userEvent.keyboard("123456");
    await userEvent.click(screen.getByRole("button", { name: "Einrichten und weiter" }));
    expect(service.confirmTotpSetup).toHaveBeenCalledWith("123456");

    expect(
      await screen.findByRole("heading", { name: "Wiederherstellungscodes" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Ihre Wiederherstellungscodes" })).toHaveTextContent(
      "AAAA-BBBB-CCCC-DDDD",
    );
    expect(await axe(container)).toHaveNoViolations();
    const next = screen.getByRole("button", { name: "Zur Anwendung" });
    expect(next).toBeDisabled();
    await userEvent.click(screen.getByLabelText("Ich habe die Codes sicher gespeichert."));
    await userEvent.click(next);
    expect(screen.getByRole("heading", { name: "Rahmen" })).toBeInTheDocument();
  });

  it("meldet einen falschen Code mit den Restversuchen", async () => {
    start(
      makeService({
        confirmTotpSetup: vi.fn().mockResolvedValue({ status: "invalid", remainingAttempts: 3 }),
      }),
    );
    await screen.findByText("JBSW Y3DP EHPK 3PXP");
    await userEvent.click(screen.getAllByRole("textbox")[0]!);
    await userEvent.keyboard("000000");
    await userEvent.click(screen.getByRole("button", { name: "Einrichten und weiter" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Der Code ist nicht gültig.");
    expect(alert).toHaveTextContent("Noch 3 Versuche.");
  });

  it("verlangt alle sechs Ziffern", async () => {
    const service = makeService();
    start(service);
    await screen.findByText("JBSW Y3DP EHPK 3PXP");
    await userEvent.click(screen.getByRole("button", { name: "Einrichten und weiter" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Geben Sie alle 6 Ziffern ein.");
    expect(service.confirmTotpSetup).not.toHaveBeenCalled();
  });

  it("meldet, wenn die Einrichtung nicht gestartet werden kann (keine Zwischen-Sitzung)", async () => {
    start(makeService({ beginTotpSetup: vi.fn().mockRejectedValue(new Error("401")) }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Der Anmeldedienst ist nicht erreichbar.",
    );
    expect(screen.queryByRole("button", { name: "Einrichten und weiter" })).not.toBeInTheDocument();
  });
});

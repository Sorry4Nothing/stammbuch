import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { Route, Routes, useLocation } from "react-router";
import { axe } from "vitest-axe";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, testSession } from "../test-utils";
import type { AuthService, LockInfo } from "./auth";
import { CodePage } from "./CodePage";
import { LockedPage } from "./LockedPage";
import { LoginPage } from "./LoginPage";
import { normalizeRecoveryCode, RecoveryPage } from "./RecoveryPage";
import { useAuth } from "./auth";

function Where() {
  const { pathname } = useLocation();
  return <span data-testid="where">{pathname}</span>;
}

function makeService(overrides: Partial<AuthService> = {}): AuthService {
  return {
    signIn: vi.fn().mockResolvedValue({ status: "otp_required" }),
    verifyCode: vi.fn().mockResolvedValue({ status: "ok", session: testSession }),
    verifyRecovery: vi.fn().mockResolvedValue({ status: "ok", session: testSession }),
    reauthenticate: vi.fn(),
    signOut: vi.fn().mockResolvedValue(undefined),
    redeemInvitation: vi.fn().mockResolvedValue({ status: "ok" }),
    beginTotpSetup: vi.fn(),
    confirmTotpSetup: vi.fn(),
    requestPasswordReset: vi.fn().mockResolvedValue(undefined),
    resetPassword: vi.fn().mockResolvedValue({ status: "ok" }),
    updateName: vi.fn().mockResolvedValue("Neuer Name"),
    ...overrides,
  };
}

/** Setzt die E-Mail-Adresse des ersten Schritts, wie nach erfolgreichem Passwort. */
function Primed({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  useEffect(() => auth.setPendingEmail(testSession.email), [auth.setPendingEmail]);
  return auth.pendingEmail ? <>{children}</> : null;
}

function flow(service: AuthService, path = "/anmelden") {
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/anmelden" element={<LoginPage />} />
        <Route path="/anmelden/code" element={<CodePage />} />
        <Route path="/anmelden/wiederherstellung" element={<RecoveryPage />} />
        <Route path="/anmelden/gesperrt" element={<LockedPage />} />
        <Route path="/passwort-vergessen" element={<h1>Zurücksetzen</h1>} />
        <Route path="/" element={<h1>Rahmen</h1>} />
      </Routes>
      <Where />
    </>,
    { path, service, session: null },
  );
}

const lock: LockInfo = {
  email: "sabine.muster@example.ch",
  since: new Date(2026, 10, 2, 14, 30).getTime(),
  until: new Date(2026, 10, 2, 14, 45).getTime(),
  failedAttempts: 5,
  cause: "password",
};

describe("Anmeldung (1.1, 1.4)", () => {
  it("zeigt Titel, Felder, Hinweis und Fusszeile", async () => {
    const { container } = flow(makeService());
    expect(screen.getByRole("heading", { level: 1, name: "Anmelden" })).toBeInTheDocument();
    expect(screen.getByLabelText("E-Mail-Adresse")).toHaveFocus();
    expect(screen.getByLabelText("Passwort")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Passwort")).toHaveAccessibleDescription("Mindestens 12 Zeichen.");
    expect(screen.getByText(/Mitglieder melden sich hier nicht an/)).toBeInTheDocument();
    expect(screen.getByText("Impressum")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("prüft leere Felder und meldet die Anzahl als Fehlermeldung", async () => {
    const service = makeService();
    flow(service);
    await userEvent.click(screen.getByRole("button", { name: "Weiter zum Einmalcode" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Bitte prüfen Sie 2 Felder.");
    expect(screen.getByLabelText("E-Mail-Adresse")).toBeInvalid();
    expect(screen.getByLabelText("Passwort")).toBeInvalid();
    expect(service.signIn).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText("E-Mail-Adresse"), "a@b.ch");
    await userEvent.click(screen.getByRole("button", { name: "Weiter zum Einmalcode" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Bitte prüfen Sie 1 Feld.");
  });

  it("leitet nach richtigem Passwort zum Einmalcode weiter (Enter sendet ab)", async () => {
    const service = makeService();
    flow(service);
    await userEvent.type(screen.getByLabelText("E-Mail-Adresse"), "sabine.muster@example.ch");
    await userEvent.type(screen.getByLabelText("Passwort"), "ein-langes-passwort{Enter}");
    expect(service.signIn).toHaveBeenCalledWith("sabine.muster@example.ch", "ein-langes-passwort");
    expect(await screen.findByRole("heading", { name: "Einmalcode eingeben" })).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/anmelden/code");
  });

  it("zeigt bei falschem Passwort Fehler am Feld und Restversuche", async () => {
    const service = makeService({
      signIn: vi.fn().mockResolvedValue({ status: "invalid", remainingAttempts: 3 }),
    });
    const { container } = flow(service);
    await userEvent.type(screen.getByLabelText("E-Mail-Adresse"), "sabine.muster@example.ch");
    await userEvent.type(screen.getByLabelText("Passwort"), "falsch-falsch-1{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Anmeldung nicht möglich.");
    expect(alert).toHaveTextContent(
      "Noch 3 Versuche, danach wird das Konto für 15 Minuten gesperrt.",
    );
    expect(screen.getByText("Passwort stimmt nicht.")).toBeInTheDocument();
    expect(screen.getByLabelText("Passwort")).toBeInvalid();
    expect(screen.getByLabelText("Passwort")).toHaveValue("");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("Einzahl bei einem verbleibenden Versuch", async () => {
    flow(
      makeService({
        signIn: vi.fn().mockResolvedValue({ status: "invalid", remainingAttempts: 1 }),
      }),
    );
    await userEvent.type(screen.getByLabelText("E-Mail-Adresse"), "a@b.ch");
    await userEvent.type(screen.getByLabelText("Passwort"), "x{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Noch 1 Versuch, danach");
  });

  it("leitet bei Sperre auf die Seite «Konto gesperrt» weiter", async () => {
    flow(makeService({ signIn: vi.fn().mockResolvedValue({ status: "locked", lock }) }));
    await userEvent.type(screen.getByLabelText("E-Mail-Adresse"), "sabine.muster@example.ch");
    await userEvent.type(screen.getByLabelText("Passwort"), "x{Enter}");
    expect(await screen.findByRole("heading", { name: "Konto gesperrt" })).toBeInTheDocument();
  });

  it("meldet einen nicht erreichbaren Dienst, statt zu schweigen", async () => {
    flow(makeService({ signIn: vi.fn().mockRejectedValue(new Error("offline")) }));
    await userEvent.type(screen.getByLabelText("E-Mail-Adresse"), "a@b.ch");
    await userEvent.type(screen.getByLabelText("Passwort"), "x{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Der Anmeldedienst ist nicht erreichbar.",
    );
  });

  it("«Passwort vergessen?» führt zur Seite zum Zurücksetzen", async () => {
    flow(makeService());
    await userEvent.click(screen.getByRole("button", { name: "Passwort vergessen?" }));
    expect(screen.getByRole("heading", { name: "Zurücksetzen" })).toBeInTheDocument();
  });
});

describe("Einmalcode (1.2, 1.5)", () => {
  function code(service: AuthService) {
    return renderWithProviders(
      <>
        <Routes>
          <Route
            path="/anmelden/code"
            element={
              <Primed>
                <CodePage />
              </Primed>
            }
          />
          <Route path="/anmelden" element={<h1>Anmeldung</h1>} />
          <Route path="/anmelden/wiederherstellung" element={<h1>Wiederherstellung</h1>} />
          <Route path="/anmelden/gesperrt" element={<LockedPage />} />
          <Route path="/" element={<h1>Rahmen</h1>} />
        </Routes>
        <Where />
      </>,
      { path: "/anmelden/code", service, session: null },
    );
  }

  it("zeigt den Zweiten Faktor und sechs Ziffernfelder", async () => {
    const { container } = code(makeService());
    expect(screen.getByRole("status")).toHaveTextContent("Zweiter Faktor.");
    expect(screen.getAllByRole("textbox")).toHaveLength(6);
    expect(screen.getByLabelText("Ziffer 1 von 6")).toHaveFocus();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("meldet mit richtigem Code an und führt in den Rahmen", async () => {
    const service = makeService();
    code(service);
    await userEvent.keyboard("482916");
    await userEvent.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(service.verifyCode).toHaveBeenCalledWith("482916");
    expect(await screen.findByRole("heading", { name: "Rahmen" })).toBeInTheDocument();
  });

  it("verlangt alle 6 Ziffern", async () => {
    const service = makeService();
    code(service);
    await userEvent.keyboard("48");
    await userEvent.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Der Code ist unvollständig.");
    expect(service.verifyCode).not.toHaveBeenCalled();
  });

  it("zeigt bei falschem Code Fehler an allen Ziffern und die Restversuche", async () => {
    const { container } = code(
      makeService({
        verifyCode: vi.fn().mockResolvedValue({ status: "invalid", remainingAttempts: 2 }),
      }),
    );
    await userEvent.keyboard("482916");
    await userEvent.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Der Code ist nicht gültig.");
    expect(screen.getByRole("alert")).toHaveTextContent("Noch 2 Versuche.");
    for (const d of screen.getAllByRole("textbox")) expect(d).toBeInvalid();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("führt zu Wiederherstellungscode und zurück", async () => {
    code(makeService());
    await userEvent.click(screen.getByRole("button", { name: "Wiederherstellungscode verwenden" }));
    expect(screen.getByRole("heading", { name: "Wiederherstellung" })).toBeInTheDocument();
  });

  it("ohne Passwortschritt geht es zurück zur Anmeldung", () => {
    renderWithProviders(
      <Routes>
        <Route path="/anmelden/code" element={<CodePage />} />
        <Route path="/anmelden" element={<h1>Anmeldung</h1>} />
      </Routes>,
      { path: "/anmelden/code", session: null },
    );
    expect(screen.getByRole("heading", { name: "Anmeldung" })).toBeInTheDocument();
  });
});

describe("Wiederherstellungscode (1.3)", () => {
  function recovery(service: AuthService) {
    return renderWithProviders(
      <Routes>
        <Route
          path="/anmelden/wiederherstellung"
          element={
            <Primed>
              <RecoveryPage />
            </Primed>
          }
        />
        <Route path="/anmelden/code" element={<h1>Einmalcode</h1>} />
        <Route path="/" element={<h1>Rahmen</h1>} />
      </Routes>,
      { path: "/anmelden/wiederherstellung", service, session: null },
    );
  }

  it("normalisiert Eingaben auf vier Blöcke", () => {
    expect(normalizeRecoveryCode("k7qm 4tzd-9xpb 1234")).toBe("K7QM-4TZD-9XPB-1234");
    expect(normalizeRecoveryCode("K7QM-4TZD-9XPB")).toBeNull();
    expect(normalizeRecoveryCode("K7QM-4TZD-9XPB-12!4")).toBeNull();
  });

  it("zeigt Hinweis, prüft das Format und meldet an", async () => {
    const service = makeService();
    const { container } = recovery(service);
    expect(screen.getByRole("status")).toHaveTextContent("Jeder Code gilt nur einmal.");
    expect(await axe(container)).toHaveNoViolations();

    await userEvent.type(screen.getByLabelText("Wiederherstellungscode"), "K7QM-4TZD");
    await userEvent.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(screen.getByText(/Das Format stimmt nicht/)).toBeInTheDocument();
    expect(service.verifyRecovery).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByLabelText("Wiederherstellungscode"));
    await userEvent.type(
      screen.getByLabelText("Wiederherstellungscode"),
      "k7qm-4tzd-9xpb-1234{Enter}",
    );
    expect(service.verifyRecovery).toHaveBeenCalledWith("K7QM-4TZD-9XPB-1234");
    expect(await screen.findByRole("heading", { name: "Rahmen" })).toBeInTheDocument();
  });

  it("zeigt bei ungültigem Code Fehler am Feld", async () => {
    recovery(
      makeService({
        verifyRecovery: vi.fn().mockResolvedValue({ status: "invalid", remainingAttempts: 4 }),
      }),
    );
    await userEvent.type(
      screen.getByLabelText("Wiederherstellungscode"),
      "K7QM4TZD9XPB1234{Enter}",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Noch 4 Versuche.");
    expect(screen.getByLabelText("Wiederherstellungscode")).toBeInvalid();
  });
});

describe("Konto gesperrt (1.6)", () => {
  it("zeigt Sperrzeit, Grund und Hilfe", async () => {
    function Seed() {
      const auth = useAuth();
      useEffect(() => auth.setLock(lock), [auth.setLock]);
      return auth.lock ? <LockedPage /> : null;
    }
    const { container } = renderWithProviders(
      <Routes>
        <Route path="/anmelden/gesperrt" element={<Seed />} />
        <Route path="/anmelden" element={<h1>Anmeldung</h1>} />
      </Routes>,
      { path: "/anmelden/gesperrt", session: null },
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Zu viele Fehlversuche.");
    expect(alert).toHaveTextContent("Das Konto sabine.muster@example.ch ist bis 14:45 gesperrt.");
    const list = screen.getByText("Gesperrt seit").closest("dl")!;
    expect(within(list).getByText("14:30 · 02.11.2026")).toBeInTheDocument();
    expect(within(list).getByText("14:45 · 02.11.2026")).toBeInTheDocument();
    expect(within(list).getByText("5 falsche Passwörter in Folge")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Konto gesperrt" })).toHaveFocus();
    expect(await axe(container)).toHaveNoViolations();
    await userEvent.click(screen.getByRole("button", { name: "Zur Anmeldung" }));
    expect(screen.getByRole("heading", { name: "Anmeldung" })).toBeInTheDocument();
  });

  it("ohne Sperrinfo geht es zur Anmeldung", () => {
    renderWithProviders(
      <Routes>
        <Route path="/anmelden/gesperrt" element={<LockedPage />} />
        <Route path="/anmelden" element={<h1>Anmeldung</h1>} />
      </Routes>,
      { path: "/anmelden/gesperrt", session: null },
    );
    expect(screen.getByRole("heading", { name: "Anmeldung" })).toBeInTheDocument();
  });
});

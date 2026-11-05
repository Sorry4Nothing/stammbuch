import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import { axe } from "vitest-axe";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "../shell/AppShell";
import { startModule } from "../modules/start";
import { renderWithProviders, testSession } from "../test-utils";
import { unavailableAuthService, type AuthService } from "./auth";
import { ForgotPasswordPage } from "./ForgotPasswordPage";
import { ResetPasswordPage } from "./ResetPasswordPage";

function Where() {
  const { pathname, hash } = useLocation();
  return <span data-testid="where">{pathname + hash}</span>;
}

function makeService(overrides: Partial<AuthService> = {}): AuthService {
  return {
    ...unavailableAuthService,
    requestPasswordReset: vi.fn().mockResolvedValue(undefined),
    resetPassword: vi.fn().mockResolvedValue({ status: "ok" }),
    updateName: vi.fn().mockResolvedValue("Sabine Neu"),
    ...overrides,
  };
}

function flow(service: AuthService, path: string) {
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/passwort-vergessen" element={<ForgotPasswordPage />} />
        <Route path="/passwort-zuruecksetzen" element={<ResetPasswordPage />} />
        <Route path="/anmelden" element={<h1>Anmelden</h1>} />
      </Routes>
      <Where />
    </>,
    { path, service, session: null },
  );
}

describe("Passwort vergessen", () => {
  const open = (service = makeService()) => flow(service, "/passwort-vergessen");
  const submit = () => userEvent.click(screen.getByRole("button", { name: "Link senden" }));

  it("zeigt Titel und Feld, ohne Verstösse gegen die Barrierefreiheit", async () => {
    const { container } = open();
    expect(
      screen.getByRole("heading", { level: 1, name: "Passwort vergessen" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("E-Mail-Adresse")).toHaveFocus();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("prüft die Adresse, bevor etwas gesendet wird", async () => {
    const service = makeService();
    open(service);
    await submit();
    expect(screen.getByRole("alert")).toHaveTextContent("Bitte prüfen Sie 1 Feld.");
    expect(screen.getByLabelText("E-Mail-Adresse")).toBeInvalid();
    await userEvent.type(screen.getByLabelText("E-Mail-Adresse"), "keine-adresse");
    await submit();
    expect(
      screen.getByText("Bitte geben Sie eine gültige E-Mail-Adresse ein."),
    ).toBeInTheDocument();
    expect(service.requestPasswordReset).not.toHaveBeenCalled();
  });

  it("zeigt nach dem Senden immer denselben Text, ohne zu verraten, ob es das Konto gibt", async () => {
    const service = makeService();
    const { container } = open(service);
    await userEvent.type(screen.getByLabelText("E-Mail-Adresse"), " anna@verein.ch ");
    await submit();
    expect(service.requestPasswordReset).toHaveBeenCalledWith("anna@verein.ch");
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Wenn zu dieser Adresse ein Konto besteht");
    expect(status).not.toHaveTextContent("anna@verein.ch");
    expect(await axe(container)).toHaveNoViolations();
    await userEvent.click(screen.getByRole("button", { name: "Zurück zur Anmeldung" }));
    expect(screen.getByRole("heading", { name: "Anmelden" })).toBeInTheDocument();
  });

  it("meldet einen nicht erreichbaren Dienst, statt zu schweigen", async () => {
    open(makeService({ requestPasswordReset: vi.fn().mockRejectedValue(new Error("offline")) }));
    await userEvent.type(screen.getByLabelText("E-Mail-Adresse"), "anna@verein.ch");
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Der Anmeldedienst ist nicht erreichbar.",
    );
  });
});

describe("Neues Passwort festlegen", () => {
  const PASSWORD = "ein-langes-passwort-42";
  const open = (service = makeService(), path = "/passwort-zuruecksetzen#das-token") =>
    flow(service, path);
  const submit = () => userEvent.click(screen.getByRole("button", { name: "Passwort ändern" }));
  async function fill(code = "123456", password = PASSWORD, repeat = password) {
    await userEvent.type(screen.getByLabelText("Neues Passwort"), password);
    await userEvent.type(screen.getByLabelText("Neues Passwort wiederholen"), repeat);
    if (code) await userEvent.type(screen.getByLabelText("Code oder Wiederherstellungscode"), code);
  }

  it("zeigt Titel und Felder, ohne Verstösse gegen die Barrierefreiheit", async () => {
    const { container } = open();
    expect(
      screen.getByRole("heading", { level: 1, name: "Neues Passwort festlegen" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Neues Passwort")).toHaveFocus();
    expect(screen.getByLabelText("Neues Passwort")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText("Code oder Wiederherstellungscode")).toHaveAttribute(
      "autocomplete",
      "one-time-code",
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("nimmt das Token aus dem Fragment, entfernt es aus der Adresse und meldet den Erfolg", async () => {
    const service = makeService();
    const { container } = open(service);
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent(/^\/passwort-zuruecksetzen$/),
    );
    await fill();
    await submit();
    expect(service.resetPassword).toHaveBeenCalledWith("das-token", PASSWORD, "123456");
    const done = await screen.findByRole("status");
    expect(done).toHaveTextContent("Passwort geändert.");
    expect(await axe(container)).toHaveNoViolations();
    await userEvent.click(screen.getByRole("button", { name: "Zur Anmeldung" }));
    expect(screen.getByRole("heading", { name: "Anmelden" })).toBeInTheDocument();
  });

  it("der Code darf leer bleiben (zweiter Faktor noch nicht eingerichtet)", async () => {
    const service = makeService();
    open(service);
    await fill("");
    await submit();
    expect(service.resetPassword).toHaveBeenCalledWith("das-token", PASSWORD, "");
  });

  it("prüft Länge und Wiederholung, bevor etwas gesendet wird", async () => {
    const service = makeService();
    open(service);
    await submit();
    expect(screen.getByRole("alert")).toHaveTextContent("Bitte prüfen Sie 1 Feld.");
    await userEvent.type(screen.getByLabelText("Neues Passwort"), "kurz");
    await submit();
    expect(screen.getByText(/mindestens 12 Zeichen/)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Neues Passwort"));
    await fill("", PASSWORD, "etwas-anderes-123");
    await submit();
    expect(screen.getByText("Die beiden Passwörter stimmen nicht überein.")).toBeInTheDocument();
    expect(service.resetPassword).not.toHaveBeenCalled();
  });

  it("ein ungültiger Link oder Code zeigt eine einzige Meldung, leert den Code und lässt es erneut zu", async () => {
    open(makeService({ resetPassword: vi.fn().mockResolvedValue({ status: "invalid" }) }));
    await fill();
    await submit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Der Link oder der Code ist ungültig oder abgelaufen.");
    expect(screen.getByLabelText("Code oder Wiederherstellungscode")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Passwort ändern" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Neuen Link anfordern" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/passwort-vergessen");
  });

  it("zeigt zu viele Versuche und die Erklärung des Servers bei einem schwachen Passwort", async () => {
    const resetPassword = vi
      .fn()
      .mockResolvedValueOnce({ status: "locked" })
      .mockResolvedValueOnce({ status: "weak", message: "Dieses Passwort ist zu einfach." });
    open(makeService({ resetPassword }));
    await fill();
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Zu viele Versuche.");
    await submit();
    await waitFor(() =>
      expect(screen.getAllByText("Dieses Passwort ist zu einfach.").length).toBeGreaterThan(0),
    );
    expect(screen.getByLabelText("Neues Passwort")).toBeInvalid();
    expect(screen.getByLabelText("Neues Passwort")).toHaveValue("");
  });

  it("ohne Token im Link erscheint ein Hinweis, ohne dass etwas gesendet wird", async () => {
    const service = makeService();
    const { container } = open(service, "/passwort-zuruecksetzen");
    expect(screen.getByRole("alert")).toHaveTextContent("Der Link ist ungültig oder abgelaufen.");
    expect(await axe(container)).toHaveNoViolations();
    await userEvent.click(screen.getByRole("button", { name: "Neuen Link anfordern" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/passwort-vergessen");
    expect(service.resetPassword).not.toHaveBeenCalled();
  });

  it("meldet einen nicht erreichbaren Dienst, statt zu schweigen", async () => {
    open(makeService({ resetPassword: vi.fn().mockRejectedValue(new Error("offline")) }));
    await fill();
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Der Anmeldedienst ist nicht erreichbar.",
    );
  });
});

describe("Name ändern", () => {
  const shell = (service = makeService()) =>
    renderWithProviders(
      <Routes>
        <Route path="/" element={<AppShell modules={[startModule]} />} />
      </Routes>,
      { service, session: { ...testSession, startedAt: Date.now() } },
    );
  const openDialog = () => userEvent.click(screen.getByRole("button", { name: "Name ändern" }));

  it("öffnet einen Dialog ohne Verstösse gegen die Barrierefreiheit, Fokus im Feld", async () => {
    shell();
    await openDialog();
    const dialog = screen.getByRole("dialog", { name: "Name ändern" });
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Sabine Muster");
    expect(within(dialog).getByLabelText("Name")).toHaveFocus();
    expect(await axe(dialog)).toHaveNoViolations();
  });

  it("speichert den Namen und zeigt ihn sofort in der Seitenleiste", async () => {
    const service = makeService();
    shell(service);
    await openDialog();
    const dialog = screen.getByRole("dialog", { name: "Name ändern" });
    await userEvent.clear(within(dialog).getByLabelText("Name"));
    await userEvent.type(within(dialog).getByLabelText("Name"), "Sabine Neu{Enter}");
    expect(service.updateName).toHaveBeenCalledWith("Sabine Neu");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("Sabine Neu")).toBeInTheDocument();
  });

  it("verlangt einen Namen und meldet einen Fehler des Servers", async () => {
    const service = makeService({ updateName: vi.fn().mockRejectedValue(new Error("500")) });
    shell(service);
    await openDialog();
    const dialog = screen.getByRole("dialog", { name: "Name ändern" });
    await userEvent.clear(within(dialog).getByLabelText("Name"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(within(dialog).getByText("Bitte geben Sie einen Namen ein.")).toBeInTheDocument();
    expect(service.updateName).not.toHaveBeenCalled();

    await userEvent.type(within(dialog).getByLabelText("Name"), "X");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Der Name konnte nicht gespeichert werden.",
    );
    expect(screen.getByText("Sabine Muster")).toBeInTheDocument();
  });
});

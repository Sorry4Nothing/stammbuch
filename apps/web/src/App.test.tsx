import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { unavailableAuthService } from "./auth/auth";
import { t, tp } from "./i18n";
import { renderWithProviders, testSession } from "./test-utils";

describe("App", () => {
  it("zeigt auf / den Rahmen mit der Startseite aus der Sprachdatei", () => {
    renderWithProviders(<App />, { path: "/" });
    expect(screen.getByRole("heading", { level: 1, name: t("start.title") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("module.start.nav") })).toBeInTheDocument();
  });

  it("leitet ohne Sitzung von / zur Anmeldung", () => {
    renderWithProviders(<App />, { path: "/", session: null });
    expect(
      screen.getByRole("heading", { level: 1, name: t("auth.login.title") }),
    ).toBeInTheDocument();
  });

  it("wartet beim Start auf die Sitzungsprüfung und zeigt dann den Rahmen", async () => {
    const service = {
      ...unavailableAuthService,
      restoreSession: () => Promise.resolve(testSession),
    };
    renderWithProviders(<App />, { path: "/", session: null, service });
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { level: 1, name: t("start.title") }),
    ).toBeInTheDocument();
  });

  it("zeigt bei unbekannter URL den Hinweis mit Link zurück", () => {
    renderWithProviders(<App />, { path: "/gibt-es-nicht" });
    expect(screen.getByText(t("error.notFound"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("error.notFound.back") })).toHaveAttribute(
      "href",
      "/",
    );
  });

  it("zeigt die Anmeldeseite unter /anmelden", () => {
    renderWithProviders(<App />, { path: "/anmelden", session: null });
    expect(
      screen.getByRole("heading", { level: 1, name: t("auth.login.title") }),
    ).toBeInTheDocument();
  });
});

describe("t und tp", () => {
  it("lässt Text ohne Platzhalter unverändert", () => {
    expect(t("app.title", { x: 1 })).toBe("Stammbuch");
  });

  it("ersetzt Platzhalter und lässt unbekannte stehen", () => {
    expect(t("shell.tabs.close", { title: "Start" })).toBe("Tab Start schliessen");
    expect(t("shell.tabs.close", {})).toBe("Tab {title} schliessen");
  });

  it("wählt die Einzahl bei n = 1", () => {
    expect(tp("search.count", 1)).toBe("1 Treffer");
    expect(tp("search.count", 0)).toBe("0 Treffer");
    expect(tp("search.count", 7)).toBe("7 Treffer");
  });
});

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { t } from "./i18n";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("App", () => {
  it("zeigt auf / die Startseite aus der Sprachdatei", () => {
    renderAt("/");
    expect(screen.getByRole("heading", { name: t("module.start.welcome") })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("module.start.nav") })).toBeInTheDocument();
  });

  it("zeigt bei unbekannter URL den Hinweis", () => {
    renderAt("/gibt-es-nicht");
    expect(screen.getByText(t("error.notFound"))).toBeInTheDocument();
  });
});

describe("t", () => {
  it("lässt Text ohne Platzhalter unverändert", () => {
    expect(t("app.title", { x: 1 })).toBe("Stammbuch");
  });
});

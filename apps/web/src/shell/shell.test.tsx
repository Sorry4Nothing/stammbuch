import { act, createEvent, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { Route, Routes } from "react-router";
import { axe } from "vitest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthService } from "../auth/auth";
import { AppShell } from "./AppShell";
import { useCurrentTab } from "./tabs";
import { SEARCH_DEBOUNCE_MS } from "./GlobalSearch";
import { NavCountersContext, type NavCounts } from "./navCounters";
import { renderWithProviders, testSession } from "../test-utils";
import type { ModuleDefinition, SearchHit } from "../modules/types";
import { startModule } from "../modules/start";
import { THEME_STORAGE_KEY } from "../theme/ThemeProvider";

/** Formular-Tab: meldet ungespeicherte Eingaben und kann speichern. */
function FormTab() {
  const tab = useCurrentTab();
  const [name, setName] = useState("");
  useEffect(
    () =>
      tab.registerSave(() => {
        tab.setDirty(false);
      }),
    [tab],
  );
  return (
    <form>
      <label>
        Vorname
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            tab.setDirty(true, "Daniel Probe");
          }}
        />
      </label>
    </form>
  );
}

function ListTab() {
  return <h1>Personenliste</h1>;
}

function BrokenTab(): never {
  throw new Error("kaputt");
}

const searchSpy = vi.fn(async (q: string): Promise<SearchHit[]> =>
  q.toLowerCase().startsWith("an")
    ? [
        {
          id: "p1",
          title: "Anna Beispiel",
          subtitle: "M-1001",
          kind: "Person",
          icon: "user" as const,
          open: { tabType: "person-form", title: "Anna Beispiel" },
        },
        {
          id: "p2",
          title: "Andreas Muster",
          kind: "Person",
          icon: "user" as const,
          open: { tabType: "person-form" },
        },
      ]
    : [],
);

const people: ModuleDefinition = {
  id: "people",
  titleKey: "shortcuts.general", // Titel nur für die Tests
  nav: { labelKey: "shortcuts.tabs", icon: "people", order: 1, tabType: "people-list" },
  newTabType: "person-form",
  tabTypes: [
    { id: "people-list", titleKey: "shortcuts.lists", component: ListTab },
    { id: "person-form", titleKey: "shortcuts.new", component: FormTab },
    { id: "broken", titleKey: "shortcuts.dialogs", component: BrokenTab },
  ],
  search: [{ id: "people", groupKey: "shortcuts.lists", search: searchSpy }],
};

const mods = [startModule, people];

function setup(options: Parameters<typeof renderWithProviders>[1] = {}) {
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<AppShell modules={mods} />} />
      <Route path="/anmelden" element={<h1>Anmeldeseite</h1>} />
    </Routes>,
    options,
  );
}

/** Wechselt ins Modul «Personen» (Test) und legt mit Alt+N einen neuen Formular-Tab an. */
async function newForm() {
  await userEvent.click(screen.getByRole("button", { name: "Tabs" }));
  await userEvent.keyboard("{Alt>}n{/Alt}");
}

const tabNames = () => screen.getAllByRole("tab").map((t) => t.textContent);

describe("App-Rahmen", () => {
  it("zeigt Seitenleiste, Tab-Leiste, Startseite und Fusszeile", () => {
    setup();
    const nav = screen.getByRole("navigation", { name: "Module" });
    expect(within(nav).getByRole("button", { name: "Start" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("button", { name: "Tabs" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Offene Tabs" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Startseite" })).toBeInTheDocument();
    expect(screen.queryByText(/^Seite \d+ von/)).not.toBeInTheDocument();
    expect(screen.getByText("Sabine Muster")).toBeInTheDocument();
    expect(screen.getByText("Sitzung 7 h 42 min")).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    const { container } = setup();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("Skip-Link ist das erste Element im Fokus", async () => {
    setup();
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Zum Inhalt springen" })).toHaveFocus();
  });

  it("hat die Landmarks laut Board 11.8: Tab-Leiste als header, Seitenleiste, genau ein main mit einer h1, footer", () => {
    setup();
    const banner = screen.getByRole("banner");
    expect(within(banner).getByRole("tablist", { name: "Offene Tabs" })).toBeInTheDocument();
    expect(screen.getByRole("complementary")).toContainElement(
      screen.getByRole("navigation", { name: "Module" }),
    );
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(within(screen.getByRole("main")).getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("contentinfo")).not.toHaveTextContent("Seite 1 von 1");
  });

  it("Fokusreihenfolge: Skip-Link, Seitenleiste, Tab-Leiste, Arbeitsfläche, Fusszeile", async () => {
    setup();
    const order: HTMLElement[] = [];
    for (let i = 0; i < 20 && order.length < 5; i += 1) {
      await userEvent.tab();
      const area = (document.activeElement as HTMLElement).closest(
        "a.skip, aside, header, main, footer",
      ) as HTMLElement | null;
      if (area && order[order.length - 1] !== area) order.push(area);
    }
    expect(order.map((el) => el.tagName)).toEqual(["A", "ASIDE", "HEADER", "MAIN", "FOOTER"]);
  });

  it("zeigt in der Fusszeile genau die Hinweise des Boards 2.1", () => {
    setup();
    const foot = screen.getByRole("contentinfo");
    expect(foot).toHaveTextContent(
      "Strg+K SucheAlt+N NeuStrg+S SpeichernAlt+Bild ↓ Tab wechselnAlt+W Tab schliessen",
    );
  });

  it("Seitenleiste zeigt Marke, Verein und Benutzer wie im Board", () => {
    setup();
    const side = screen.getByRole("complementary");
    expect(within(side).getByText("Stammbuch")).toBeInTheDocument();
    expect(within(side).getByText("Verein Beispiel")).toBeInTheDocument();
    expect(within(side).getByText("sabine.muster@example.ch")).toBeInTheDocument();
  });
});

describe("Zähler in der Seitenleiste", () => {
  const withCounts = (counts: NavCounts | "fail") =>
    renderWithProviders(
      <NavCountersContext.Provider
        value={{
          load: () =>
            counts === "fail" ? Promise.reject(new Error("x")) : Promise.resolve(counts),
        }}
      >
        <Routes>
          <Route path="/" element={<AppShell modules={mods} />} />
        </Routes>
      </NavCountersContext.Provider>,
    );

  it("zeigt den Zähler am Eintrag, mit Text für Screenreader, und nichts bei 0", async () => {
    withCounts({
      start: { count: 3, label: "3 fällige Aufgaben" },
      people: { count: 0, label: "0 Personen" },
    });
    const nav = screen.getByRole("navigation", { name: "Module" });
    const start = await within(nav).findByRole("button", { name: /Start/ });
    expect(start).toHaveAccessibleName(/^Start\s*3 fällige Aufgaben$/);
    expect(within(nav).getByRole("button", { name: "Tabs" })).toHaveAccessibleName("Tabs");
  });

  it("lädt trotz Tabwechseln höchstens einmal pro Minute", async () => {
    const load = vi.fn().mockResolvedValue({});
    renderWithProviders(
      <NavCountersContext.Provider value={{ load }}>
        <Routes>
          <Route path="/" element={<AppShell modules={mods} />} />
        </Routes>
      </NavCountersContext.Provider>,
    );
    const nav = screen.getByRole("navigation", { name: "Module" });
    await userEvent.click(within(nav).getByRole("button", { name: "Tabs" }));
    await userEvent.click(within(nav).getByRole("button", { name: "Start" }));
    await userEvent.click(within(nav).getByRole("button", { name: "Tabs" }));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("ein ausgefallener Zähler lässt die Seitenleiste ohne Zahl", async () => {
    withCounts("fail");
    const nav = screen.getByRole("navigation", { name: "Module" });
    await Promise.resolve();
    expect(within(nav).getByRole("button", { name: "Start" })).toBeInTheDocument();
  });
});

describe("Theme", () => {
  it("schaltet zwischen Hell und Dunkel um und merkt sich die Wahl", async () => {
    const { unmount } = setup();
    expect(document.documentElement.dataset.theme).toBe("light");
    await userEvent.click(screen.getByRole("button", { name: "Dunkles Design" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(screen.getByRole("button", { name: "Helles Design" })).toBeInTheDocument();
    unmount();

    // Neu laden: gespeicherte Wahl gilt.
    setup();
    expect(document.documentElement.dataset.theme).toBe("dark");
    await userEvent.click(screen.getByRole("button", { name: "Helles Design" }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

describe("Tabs", () => {
  it("öffnet pro Modul einen Tab, aktiviert ihn bei erneutem Klick statt zu duplizieren", async () => {
    setup();
    const nav = screen.getByRole("navigation", { name: "Module" });
    await userEvent.click(within(nav).getByRole("button", { name: "Tabs" }));
    expect(tabNames()).toEqual(["Start", "Listen"]);
    expect(screen.getByRole("heading", { name: "Personenliste" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Listen" })).toHaveAttribute("aria-selected", "true");

    await userEvent.click(within(nav).getByRole("button", { name: "Start" }));
    await userEvent.click(within(nav).getByRole("button", { name: "Tabs" }));
    expect(tabNames()).toEqual(["Start", "Listen"]);
  });

  it("ungespeicherte Eingaben bleiben beim Tabwechsel erhalten, Punkt markiert den Tab", async () => {
    setup();
    await newForm();
    const input = screen.getByLabelText("Vorname");
    await userEvent.type(input, "Daniel");
    // Punkt ist dekorativ, der Text «Ungespeichert:» trägt die Information (Design 2.8).
    expect(screen.getByRole("tab", { name: /^Ungespeichert:\s+Neu anlegen$/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Start" }));
    expect(input).not.toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: /Neu anlegen/ }));
    expect(screen.getByLabelText("Vorname")).toHaveValue("Daniel");
  });

  it("Schliessen mit Eingaben fragt nach: Abbrechen lässt den Tab offen", async () => {
    setup();
    await newForm();
    await userEvent.type(screen.getByLabelText("Vorname"), "D");
    await userEvent.click(screen.getByTitle(/Neu anlegen.* schliessen$/));
    const dialog = screen.getByRole("dialog", { name: /^Tab «Neu anlegen» schliessen$/ });
    expect(within(dialog).getByText(/gehen beim Schliessen verloren/)).toBeInTheDocument();
    // Angaben benannt, Warnung als Status; kein zusätzlicher Tastenhinweis.
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Ungespeicherte Eingaben. Die Angaben zu Daniel Probe sind noch nicht gespeichert und gehen beim Schliessen verloren.",
    );
    expect(dialog).not.toHaveTextContent("brechen Sie ab");
    expect(within(dialog).getByRole("button", { name: "Verwerfen und schliessen" })).toHaveClass(
      "btn--danger",
    );
    expect(within(dialog).getByRole("button", { name: "Speichern und schliessen" })).toHaveClass(
      "btn--primary",
    );
    expect(within(dialog).getByRole("button", { name: "Abbrechen" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(tabNames()).toHaveLength(3);
  });

  it("Verwerfen und schliessen entfernt den Tab, ohne Punkt schliesst er direkt", async () => {
    setup();
    await newForm();
    await userEvent.type(screen.getByLabelText("Vorname"), "D");
    await userEvent.keyboard("{Alt>}w{/Alt}");
    await userEvent.click(screen.getByRole("button", { name: "Verwerfen und schliessen" }));
    expect(tabNames()).toEqual(["Start", "Listen"]);

    // Sauberer Tab: kein Dialog.
    await newForm();
    await userEvent.keyboard("{Alt>}w{/Alt}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(tabNames()).toEqual(["Start", "Listen"]);
  });

  it("Speichern und schliessen ruft den Speicher-Handler des Tabs auf", async () => {
    setup();
    await newForm();
    await userEvent.type(screen.getByLabelText("Vorname"), "D");
    await userEvent.keyboard("{Alt>}w{/Alt}");
    await userEvent.click(screen.getByRole("button", { name: "Speichern und schliessen" }));
    expect(tabNames()).toEqual(["Start", "Listen"]);
  });

  it("Strg+S speichert den aktiven Tab und nimmt den Punkt weg", async () => {
    setup();
    await newForm();
    await userEvent.type(screen.getByLabelText("Vorname"), "D");
    expect(screen.getByRole("tab", { name: /Ungespeichert:/ })).toBeInTheDocument();
    await userEvent.keyboard("{Control>}s{/Control}");
    expect(screen.queryByRole("tab", { name: /Ungespeichert:/ })).not.toBeInTheDocument();
  });

  it("Alt+Ziffer, Alt+Bild ab und Alt+Bild auf wechseln den Tab", async () => {
    setup();
    await newForm();
    expect(screen.getByRole("tab", { name: /Neu anlegen/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.keyboard("{Alt>}1{/Alt}");
    expect(screen.getByRole("tab", { name: "Start" })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Alt>}{PageDown}{/Alt}");
    expect(screen.getByRole("tab", { name: "Listen" })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Alt>}{PageUp}{/Alt}");
    expect(screen.getByRole("tab", { name: "Start" })).toHaveAttribute("aria-selected", "true");
  });

  it("Pfeiltasten in der Tab-Leiste wechseln den Tab", async () => {
    setup();
    await newForm();
    screen.getByRole("tab", { name: /Neu anlegen/ }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Listen" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Listen" })).toHaveAttribute("aria-selected", "true");
  });

  it("Strg+Umschalt+Pfeil verschiebt den Tab, behält den Fokus und sagt die neue Stelle an", async () => {
    setup();
    await newForm();
    expect(tabNames()).toEqual(["Start", "Listen", "Neu anlegen"]);
    screen.getByRole("tab", { name: /Neu anlegen/ }).focus();
    await userEvent.keyboard("{Control>}{Shift>}{ArrowLeft}{/Shift}{/Control}");
    expect(tabNames()).toEqual(["Start", "Neu anlegen", "Listen"]);
    expect(screen.getByRole("tab", { name: /Neu anlegen/ })).toHaveFocus();
    expect(screen.getByText("Tab Neu anlegen an Position 2 von 3.")).toBeInTheDocument();
    // Am rechten Ende geht es nicht weiter.
    screen.getByRole("tab", { name: "Listen" }).focus();
    await userEvent.keyboard("{Control>}{Shift>}{ArrowRight}{/Shift}{/Control}");
    expect(tabNames()).toEqual(["Start", "Neu anlegen", "Listen"]);
  });

  it("zieht einen Tab mit der Maus an eine neue Stelle, Einfügemarke zeigt das Ziel", () => {
    setup();
    return newForm().then(() => {
      const box = (name: string | RegExp) => screen.getByRole("tab", { name }).parentElement!;
      const dataTransfer = { setData: () => undefined, effectAllowed: "", dropEffect: "" };
      /** jsdom kennt kein DragEvent und reicht `clientX` nicht durch: nachtragen. */
      const dragAt = (kind: "dragOver" | "drop", el: HTMLElement, clientX: number) => {
        const event = createEvent[kind](el, { dataTransfer });
        Object.defineProperty(event, "clientX", { value: clientX });
        fireEvent(el, event);
      };
      fireEvent.dragStart(box("Start"), { dataTransfer });
      expect(box("Start")).toHaveClass("is-dragging");
      dragAt("dragOver", box(/Neu anlegen/), 100);
      expect(box(/Neu anlegen/)).toHaveClass("drop-after");
      dragAt("dragOver", box(/Neu anlegen/), -1);
      expect(box(/Neu anlegen/)).toHaveClass("drop-before");
      dragAt("dragOver", box(/Neu anlegen/), 100);
      dragAt("drop", box(/Neu anlegen/), 100);
      expect(tabNames()).toEqual(["Listen", "Neu anlegen", "Start"]);
      expect(box("Start")).not.toHaveClass("is-dragging");
    });
  });

  it("ignoriert fremde Ziehvorgänge (Dateien, Text) in der Tab-Leiste", () => {
    setup();
    return newForm().then(() => {
      const dataTransfer = { setData: () => undefined, effectAllowed: "", dropEffect: "" };
      const target = screen.getByRole("tab", { name: "Listen" }).parentElement!;
      fireEvent.dragOver(target, { dataTransfer, clientX: 100 });
      fireEvent.drop(target, { dataTransfer, clientX: 100 });
      expect(tabNames()).toEqual(["Start", "Listen", "Neu anlegen"]);
      expect(target).not.toHaveClass("drop-after");
    });
  });

  it("Entf auf dem Tab schliesst ihn (Tastatur-Ersatz für die Schliessen-Schaltfläche)", async () => {
    setup();
    await newForm();
    screen.getByRole("tab", { name: "Listen" }).focus();
    await userEvent.keyboard("{Delete}");
    expect(tabNames()).toEqual(["Start", "Neu anlegen"]);
  });

  it("der letzte geschlossene Tab öffnet wieder die Startseite", async () => {
    setup();
    await userEvent.click(screen.getByTitle("Tab Start schliessen"));
    expect(tabNames()).toEqual(["Start"]);
    expect(screen.getByRole("heading", { name: "Startseite" })).toBeVisible();
  });

  it("ein Darstellungsfehler bleibt auf den Tab begrenzt (Fehlerzustand mit Nummer)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: ModuleDefinition = {
      ...people,
      id: "broken-mod",
      nav: { ...people.nav, tabType: "broken", order: 2 },
    };
    renderWithProviders(<AppShell modules={[startModule, broken]} />);
    await userEvent.click(screen.getByRole("button", { name: "Tabs" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Die Ansicht «Dialoge» konnte nicht geladen werden.",
    );
    expect(screen.getByRole("heading", { name: "Angaben für den Support" })).toBeInTheDocument();
    expect(screen.getByText(/^ERR-\d{8}-[0-9A-F]{4}$/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Erneut laden" })).toBeInTheDocument();
    // Startseite im anderen Tab bleibt intakt.
    await userEvent.click(screen.getByRole("tab", { name: "Start" }));
    expect(screen.getByRole("heading", { name: "Startseite" })).toBeVisible();
    spy.mockRestore();
  });
});

describe("Globale Suche", () => {
  beforeEach(() => {
    searchSpy.mockClear();
  });

  it("öffnet mit Strg+K, findet, wählt per Pfeil und öffnet mit Enter im neuen Tab", async () => {
    setup();
    await userEvent.keyboard("{Control>}k{/Control}");
    const dialog = screen.getByRole("dialog", { name: "Suche" });
    const input = within(dialog).getByRole("combobox");
    expect(input).toHaveFocus();
    await userEvent.type(input, "an");
    expect(await within(dialog).findByText("Anna Beispiel")).toBeInTheDocument();
    expect(within(dialog).getByText("Listen")).toBeInTheDocument();
    expect(within(dialog).getByRole("status")).toHaveTextContent("2 Treffer");
    expect(within(dialog).getByText("Im neuen Tab öffnen")).toBeInTheDocument();
    const options = within(dialog).getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", options[0]!.id);

    await userEvent.keyboard("{ArrowDown}");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowUp}{Enter}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Anna Beispiel" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("zeigt «Keine Treffer» mit Hilfe und 0 Treffern", async () => {
    setup();
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.type(screen.getByRole("combobox"), "Zzyxq");
    expect(await screen.findByText("Keine Treffer für «Zzyxq»")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("0 Treffer");
    expect(screen.getByText("Prüfen Sie die Schreibweise.")).toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("«Eingabe löschen» leert das Feld, «Person anlegen» öffnet das Formular des Moduls", async () => {
    setup();
    await userEvent.keyboard("{Control>}k{/Control}");
    const input = screen.getByRole("combobox");
    await userEvent.type(input, "Zzyxq");
    await userEvent.click(await screen.findByRole("button", { name: "Eingabe löschen" }));
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();

    await userEvent.type(input, "Zzyxq");
    await screen.findByText("Keine Treffer für «Zzyxq»");
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Person anlegen" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Neu anlegen" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("zeigt Gruppen mit Zähler und Status-Badge statt der Art, Schliessen-Schaltfläche «Suche schliessen»", async () => {
    searchSpy.mockResolvedValueOnce([
      {
        id: "r1",
        title: "R-2026-0391",
        subtitle: "Beispiel AG · CHF 1'250.00",
        kind: "Rechnung",
        status: { label: "Überfällig", tone: "error" as const },
        icon: "user" as const,
        open: { tabType: "person-form" },
      },
    ]);
    setup();
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.type(screen.getByRole("combobox"), "R-2026");
    const dialog = screen.getByRole("dialog", { name: "Suche" });
    expect(await within(dialog).findByText("Überfällig")).toHaveClass("badge--error");
    expect(within(dialog).queryByText("Rechnung")).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Suche schliessen" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Esc schliesst und gibt den Fokus zurück, Strg+K öffnet auch aus der Fusszeile", async () => {
    setup();
    const footerButton = screen.getByRole("button", { name: /Strg\+K Suche/ });
    await userEvent.click(footerButton);
    expect(screen.getByRole("dialog", { name: "Suche" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(footerButton).toHaveFocus();
  });

  it("wartet kurz, bevor es sucht (Entprellen)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setup();
      await userEvent.keyboard("{Control>}k{/Control}");
      await userEvent.type(screen.getByRole("combobox"), "ann");
      expect(searchSpy).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
      });
      expect(searchSpy).toHaveBeenCalledTimes(1);
      expect(searchSpy.mock.calls[0]![0]).toBe("ann");
    } finally {
      vi.useRealTimers();
    }
  });

  it("meldet, wenn eine Suchquelle ausfällt", async () => {
    const failing: ModuleDefinition = {
      ...people,
      search: [
        {
          id: "x",
          groupKey: "shortcuts.lists",
          search: () => Promise.reject(new Error("offline")),
        },
      ],
    };
    renderWithProviders(<AppShell modules={[startModule, failing]} />);
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.type(screen.getByRole("combobox"), "an");
    expect(await screen.findByText(/Ein Teil der Suche ist fehlgeschlagen/)).toBeInTheDocument();
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    setup();
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.type(screen.getByRole("combobox"), "an");
    await screen.findByText("Anna Beispiel");
    expect(await axe(screen.getByRole("dialog"))).toHaveNoViolations();
  });
});

describe("Tastaturkürzel-Übersicht", () => {
  it("öffnet mit Strg+/ , listet alle Gruppen und schliesst mit Esc", async () => {
    setup();
    await userEvent.keyboard("{Control>}/{/Control}");
    const dialog = screen.getByRole("dialog", { name: "Tastaturkürzel" });
    for (const group of ["Allgemein", "Tabs", "Listen", "Dialoge"]) {
      expect(within(dialog).getByRole("table", { name: `Kürzel: ${group}` })).toBeInTheDocument();
    }
    expect(within(dialog).getByText("Alt+Bild ↑")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("rowheader", { name: "Übersicht anzeigen" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Übersicht schliessen" })).toHaveFocus();
    expect(await axe(dialog)).toHaveNoViolations();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("schliesst auch über die Schaltfläche oben rechts", async () => {
    setup();
    await userEvent.keyboard("{Control>}/{/Control}");
    await userEvent.click(screen.getByRole("button", { name: "Dialog schliessen" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Kürzel greifen nicht, solange ein Dialog offen ist", async () => {
    setup();
    await userEvent.keyboard("{Control>}/{/Control}");
    await userEvent.keyboard("{Control>}k{/Control}");
    expect(screen.queryByRole("dialog", { name: "Suche" })).not.toBeInTheDocument();
  });
});

describe("Sitzung", () => {
  it("zeigt «Sitzung abgelaufen» über den Tabs und meldet erneut an", async () => {
    const service: AuthService = {
      signIn: vi.fn(),
      verifyCode: vi.fn(),
      verifyRecovery: vi.fn(),
      reauthenticate: vi.fn().mockResolvedValue({
        status: "ok",
        session: { ...testSession, startedAt: Date.now() },
      }),
      signOut: vi.fn().mockResolvedValue(undefined),
      redeemInvitation: vi.fn(),
      beginTotpSetup: vi.fn(),
      confirmTotpSetup: vi.fn(),
      requestPasswordReset: vi.fn().mockResolvedValue(undefined),
      resetPassword: vi.fn().mockResolvedValue({ status: "ok" }),
      updateName: vi.fn().mockResolvedValue("Neuer Name"),
    };
    // Sitzung begann vor mehr als 8 Stunden.
    setup({ service, session: { ...testSession, startedAt: Date.now() - 9 * 3_600_000 } });
    const dialog = await screen.findByRole("dialog", { name: "Sitzung abgelaufen" });
    expect(within(dialog).getByLabelText("E-Mail-Adresse")).toHaveValue(testSession.email);
    expect(within(dialog).getByLabelText("E-Mail-Adresse")).toHaveAttribute("readonly");
    // Esc schliesst nicht.
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Sitzung abgelaufen" })).toBeInTheDocument();

    // Leere Eingabe: Fehler pro Feld.
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Sie wurden aus Sicherheitsgründen abgemeldet.",
    );
    expect(within(dialog).getByRole("button", { name: "Sitzung beenden" })).toBeInTheDocument();
    // Ohne Anmeldung gibt es keinen Weg aus dem Dialog (Abweichung von Board 2.7).
    expect(
      within(dialog).queryByRole("button", { name: "Dialog schliessen" }),
    ).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Sitzung erneuern" }));
    expect(within(dialog).getByText("Geben Sie Ihr Passwort ein.")).toBeInTheDocument();
    expect(within(dialog).getByText("Der Code besteht aus 6 Ziffern.")).toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText("Passwort"), "geheim-geheim-1");
    await userEvent.type(within(dialog).getByLabelText("Einmalcode"), "482916{Enter}");
    expect(service.reauthenticate).toHaveBeenCalledWith("geheim-geheim-1", "482916");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Abmelden führt zur Anmeldeseite", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    expect(await screen.findByRole("heading", { name: "Anmeldeseite" })).toBeInTheDocument();
  });
});

describe("Tab-Leiste bei vielen Tabs", () => {
  const scrollIntoView = vi.fn();
  beforeEach(() => {
    scrollIntoView.mockClear();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  async function openMany() {
    setup();
    await userEvent.click(
      within(screen.getByRole("navigation", { name: "Module" })).getByRole("button", {
        name: "Tabs",
      }),
    );
    for (let i = 0; i < 12; i++) await userEvent.keyboard("{Alt>}n{/Alt}");
    expect(screen.getAllByRole("tab")).toHaveLength(14);
  }

  it("lässt den aktiven Tab in den Sichtbereich scrollen, auch beim Öffnen", async () => {
    await openMany();
    expect(scrollIntoView).toHaveBeenCalledWith({ inline: "nearest", block: "nearest" });
    scrollIntoView.mockClear();
    await userEvent.click(screen.getAllByRole("tab")[0]!);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("zeigt den Randverlauf nur bei Überlauf und nutzt keine native Scrollleiste", async () => {
    await openMany();
    const list = screen.getByRole("tablist", { name: "Offene Tabs" });
    // jsdom hat kein Layout: Überlauf vorgeben (Inhalt 2000 px in 600 px).
    Object.defineProperty(list, "scrollWidth", { value: 2000, configurable: true });
    Object.defineProperty(list, "clientWidth", { value: 600, configurable: true });
    fireEvent.scroll(list);
    expect(list).toHaveAttribute("data-overflow-end");
    expect(list).not.toHaveAttribute("data-overflow-start");

    list.scrollLeft = 300;
    fireEvent.scroll(list);
    expect(list).toHaveAttribute("data-overflow-start");
    expect(list).toHaveAttribute("data-overflow-end");

    list.scrollLeft = 1400;
    fireEvent.scroll(list);
    expect(list).toHaveAttribute("data-overflow-start");
    expect(list).not.toHaveAttribute("data-overflow-end");

    // Passt alles hinein, steht die Leiste wieder am Anfang.
    Object.defineProperty(list, "scrollWidth", { value: 600, configurable: true });
    list.scrollLeft = 0;
    fireEvent.scroll(list);
    expect(list).not.toHaveAttribute("data-overflow-start");
    expect(list).not.toHaveAttribute("data-overflow-end");
  });

  it("bietet bei Überlauf die Liste «Alle Tabs» und aktiviert den gewählten Tab", async () => {
    await openMany();
    expect(screen.queryByRole("button", { name: "Alle Tabs" })).not.toBeInTheDocument();
    const list = screen.getByRole("tablist", { name: "Offene Tabs" });
    Object.defineProperty(list, "scrollWidth", { value: 2000, configurable: true });
    Object.defineProperty(list, "clientWidth", { value: 600, configurable: true });
    fireEvent.scroll(list);
    await userEvent.click(screen.getByRole("button", { name: "Alle Tabs" }));
    const items = within(document.getElementById("tabs-all-menu")!).getAllByRole("button");
    expect(items).toHaveLength(14);
    await userEvent.click(items[0]!);
    expect(screen.getByRole("tab", { name: "Start" })).toHaveAttribute("aria-selected", "true");
    expect(document.getElementById("tabs-all-menu")).toBeNull();
  });

  it("Tabs tragen ihren vollen Titel als Tooltip", async () => {
    await openMany();
    expect(screen.getAllByRole("tab")[1]).toHaveAttribute("title", "Listen");
  });

  it("Umsortieren per Tastatur und Alt-Kürzel funktionieren weiter", async () => {
    await openMany();
    const first = screen.getAllByRole("tab")[1]!;
    first.focus();
    const name = first.textContent;
    await userEvent.keyboard("{Control>}{Shift>}{ArrowRight}{/Shift}{/Control}");
    expect(screen.getAllByRole("tab")[2]!.textContent).toBe(name);
    await userEvent.keyboard("{Alt>}w{/Alt}");
    expect(screen.getAllByRole("tab")).toHaveLength(13);
  });
});

describe("Tabs nach dem Neuladen", () => {
  const navButton = (name: string) =>
    within(screen.getByRole("navigation", { name: "Module" })).getByRole("button", { name });

  it("stellt offene Tabs, Reihenfolge und den aktiven Tab wieder her", async () => {
    const first = setup();
    await userEvent.click(navButton("Tabs"));
    await userEvent.keyboard("{Alt>}n{/Alt}");
    await userEvent.click(screen.getByRole("tab", { name: "Listen" }));
    first.unmount();

    setup();
    expect(tabNames()).toEqual(["Start", "Listen", "Neu anlegen"]);
    expect(screen.getByRole("tab", { name: "Listen" })).toHaveAttribute("aria-selected", "true");
    // Eingaben gehen nicht mit: der Tab ist wieder leer und nicht «ungespeichert».
    expect(screen.queryByText("Ungespeichert:")).not.toBeInTheDocument();
  });

  it("verwirft unbekannte Tab-Typen, Adressen und zu lange Werte; ohne Rest startet die App normal", async () => {
    sessionStorage.setItem(
      "stammbuch.tabs",
      JSON.stringify({
        tabs: [
          { type: "gibt-es-nicht", params: {} },
          { type: "people-list", params: { to: "anna@example.ch" } },
          { type: "people-list", params: { id: "x".repeat(300) } },
        ],
        active: 0,
      }),
    );
    setup();
    expect(tabNames()).toEqual(["Start"]);
    sessionStorage.setItem("stammbuch.tabs", "{kaputt");
    setup();
    expect(screen.getAllByRole("tab", { name: "Start" }).length).toBeGreaterThan(0);
  });

  it("speichert nur Typ, Schlüssel, Parameter und Titel", async () => {
    setup();
    await userEvent.click(navButton("Tabs"));
    const stored = JSON.parse(sessionStorage.getItem("stammbuch.tabs") ?? "null");
    expect(stored).toEqual({
      tabs: [
        { type: "start", params: {}, key: "start" },
        { type: "people-list", params: {}, key: "people-list" },
      ],
      active: 1,
    });
  });

  it("Abmelden löscht die gemerkten Tabs", async () => {
    setup();
    expect(sessionStorage.getItem("stammbuch.tabs")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    await screen.findByRole("heading", { name: "Anmeldeseite" });
    expect(sessionStorage.getItem("stammbuch.tabs")).toBeNull();
  });

  it("Browser-Zurück verlässt die App nicht, sondern wechselt zum vorherigen Tab", async () => {
    setup();
    await userEvent.click(navButton("Tabs"));
    const before = window.history.length;
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("tab", { name: "Start" })).toHaveAttribute("aria-selected", "true");
    expect(window.history.length).toBe(before + 1);
  });
});

describe("Alt+N und Fusszeile", () => {
  it("legt auf der Startseite eine Person an", async () => {
    setup();
    await userEvent.keyboard("{Alt>}n{/Alt}");
    expect(screen.getByRole("tab", { name: "Neu anlegen" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("zeigt «Neu» nicht, wo Alt+N nichts anlegt", async () => {
    const plain: ModuleDefinition = {
      id: "plain",
      titleKey: "shortcuts.general",
      nav: { labelKey: "shortcuts.dialogs", icon: "gear", order: 5, tabType: "plain-tab" },
      tabTypes: [{ id: "plain-tab", titleKey: "shortcuts.dialogs", component: ListTab }],
    };
    renderWithProviders(<AppShell modules={[startModule, people, plain]} />);
    const foot = screen.getByRole("contentinfo");
    expect(foot).toHaveTextContent("Alt+N Neu");
    await userEvent.click(
      within(screen.getByRole("navigation", { name: "Module" })).getByRole("button", {
        name: "Dialoge",
      }),
    );
    expect(foot).not.toHaveTextContent("Alt+N");
    await userEvent.keyboard("{Alt>}n{/Alt}");
    expect(tabNames()).toEqual(["Start", "Dialoge"]);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

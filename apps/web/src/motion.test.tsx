import { act, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./shell/AppShell";
import { PANEL_ENTER_MS } from "./shell/TabPanels";
import { startModule } from "./modules/start";
import { renderWithProviders } from "./test-utils";
import { THEME_ANIM_CLASS, THEME_ANIM_MS, ThemeProvider, useTheme } from "./theme/ThemeProvider";

// jsdom kennt kein CSS: Hier stehen die Regeln, die sich im Quelltext prüfen lassen, und das, was in JS liegt.
const read = (file: string) => readFileSync(resolve(__dirname, file), "utf8");
const motion = read("styles/motion.css");
const tokens = read("styles/tokens.css");

const blocks = (css: string, at: string) =>
  [...css.matchAll(new RegExp(`${at}[^{]*\\{`, "g"))].map((m) => {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === "{") depth += 1;
      if (css[i] === "}") depth -= 1;
    }
    return css.slice(start, i - 1);
  });

describe("motion.css", () => {
  it("wird nach shell.css eingebunden", () => {
    const main = read("main.tsx");
    expect(main.indexOf("styles/motion.css")).toBeGreaterThan(main.indexOf("styles/shell.css"));
  });

  it("nutzt die Tokens aus tokens.css", () => {
    for (const name of ["--dur-fast: 120ms", "--dur-base: 200ms", "--dur-slow: 320ms"]) {
      expect(tokens).toContain(name);
    }
    expect(tokens).toContain("--ease-out: cubic-bezier(0.2, 0, 0, 1)");
    expect(tokens).toContain("--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1)");
    // Keine festen Dauern ausser dem Lade-Puls
    const fixed = [...motion.matchAll(/(?:animation|transition)[^;]*?(\d+(?:\.\d+)?m?s)/g)];
    expect(fixed.map((m) => m[1])).toEqual(["1.4s"]);
  });

  it("animiert in Keyframes nur transform und opacity, mit Wegen aus Tokens", () => {
    const frames = blocks(motion, "@keyframes");
    expect(frames.length).toBeGreaterThan(0);
    for (const body of frames) {
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      expect(props.filter((p) => !["opacity", "transform"].includes(p!))).toEqual([]);
    }
    for (const body of frames) {
      for (const m of body.matchAll(/(translate[XY]?|scale)\(([^)]*(?:\([^)]*\))?[^)]*)\)/g)) {
        if (m[0] === "translateX(-50%)") continue; // Mitte des Dialogs
        expect(m[0]).toMatch(/var\(--motion-/);
      }
    }
  });

  it("schaltet bei reduzierter Bewegung Wege, Skalierung, Staffelung und Puls ab", () => {
    const [reduce] = blocks(motion, "@media \\(prefers-reduced-motion: reduce\\)");
    expect(reduce).toMatch(/--motion-shift:\s*0px/);
    expect(reduce).toMatch(/--motion-scale:\s*1;/);
    expect(reduce).toMatch(/--motion-pop:\s*1;/);
    expect(reduce).toMatch(/--stagger:\s*0ms/);
    expect(reduce).toMatch(/--dur-fast:\s*0ms/);
    // Reines Einblenden bleibt, höchstens 120 ms
    expect(reduce).toMatch(/--dur-base:\s*120ms/);
    expect(reduce).toMatch(/--dur-slow:\s*120ms/);
    expect(reduce).toMatch(/\.is-loading\s*\{\s*animation:\s*none/);
  });

  it("staffelt den Seitenaufbau in höchstens 6 Stufen und 400 ms", () => {
    const steps = [
      ...motion.matchAll(
        /tabpanel--fresh[^{]*:nth-child\([^)]*\)\s*\{\s*animation-delay: calc\(var\(--stagger\) \* (\d+)\)/g,
      ),
    ];
    const max = Math.max(...steps.map((m) => Number(m[1])));
    expect(max).toBeLessThanOrEqual(5);
    expect(max * 40 + 200).toBeLessThanOrEqual(400); // --stagger 40 ms, --dur-base 200 ms
    expect(tokens).toContain("--stagger: 40ms");
  });

  it("zeigt den Fokus-Ring ohne Übergang", () => {
    expect(motion).not.toMatch(/outline/);
  });
});

function Toggle() {
  const { toggle } = useTheme();
  return <button onClick={toggle}>Umschalten</button>;
}

const mockReduced = (reduced: boolean) =>
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduced && query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );

describe("Theme-Wechsel", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.documentElement.classList.remove(THEME_ANIM_CLASS);
  });

  const html = () => document.documentElement;

  it("blendet nur beim Umschalten kurz die Farben über, nicht beim Seitenaufbau", () => {
    mockReduced(false);
    render(
      <ThemeProvider>
        <Toggle />
      </ThemeProvider>,
    );
    expect(html()).not.toHaveClass(THEME_ANIM_CLASS);
    act(() => screen.getByRole("button", { name: "Umschalten" }).click());
    expect(html()).toHaveClass(THEME_ANIM_CLASS);
    expect(html().dataset.theme).toBe("dark");
    act(() => {
      vi.advanceTimersByTime(THEME_ANIM_MS);
    });
    expect(html()).not.toHaveClass(THEME_ANIM_CLASS);
  });

  it("setzt bei reduzierter Bewegung keine Klasse", () => {
    mockReduced(true);
    render(
      <ThemeProvider>
        <Toggle />
      </ThemeProvider>,
    );
    act(() => screen.getByRole("button", { name: "Umschalten" }).click());
    expect(html().dataset.theme).toBe("dark");
    expect(html()).not.toHaveClass(THEME_ANIM_CLASS);
  });
});

describe("Seitenaufbau im Tab-Bereich", () => {
  it("staffelt nur beim ersten Öffnen: die Klasse fällt danach weg, der Inhalt bleibt", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/" element={<AppShell modules={[startModule]} />} />
      </Routes>,
    );
    const panel = screen.getAllByRole("tabpanel", { hidden: true })[0]!;
    expect(panel).toHaveClass("tabpanel", "tabpanel--fresh");
    const heading = screen.getByRole("heading", { level: 1, name: "Startseite" });
    await waitFor(() => expect(panel).not.toHaveClass("tabpanel--fresh"), {
      timeout: PANEL_ENTER_MS + 1500,
    });
    expect(panel).toHaveClass("tabpanel");
    expect(screen.getByRole("heading", { level: 1, name: "Startseite" })).toBe(heading);
  });
});

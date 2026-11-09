import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ModuleDefinition } from "../modules/types";
import { TabPanels } from "./TabPanels";
import { TabsProvider, useTabs } from "./tabs";
import { useOnTabActivate } from "./useOnTabActivate";

const reload = vi.fn();

function Watching() {
  useOnTabActivate(reload);
  return <p>Liste</p>;
}

function Other() {
  return <p>Anderer Tab</p>;
}

function Switch() {
  const { tabs, activateTab, openTab } = useTabs();
  return (
    <>
      <button type="button" onClick={() => openTab("other", { key: "other" })}>
        Anderer Tab öffnen
      </button>
      <button type="button" onClick={() => activateTab(tabs[0]!.id)}>
        Zur Liste
      </button>
    </>
  );
}

const module_: ModuleDefinition = {
  id: "test",
  titleKey: "module.tasks.title",
  nav: { labelKey: "module.tasks.nav", icon: "check", order: 1, tabType: "watching" },
  tabTypes: [
    { id: "watching", titleKey: "module.tasks.title", component: Watching },
    { id: "other", titleKey: "module.tasks.title", component: Other },
  ],
};

describe("useOnTabActivate", () => {
  it("ruft nur beim erneuten Aktivieren des Tabs, nicht beim ersten Anzeigen", async () => {
    reload.mockClear();
    render(
      <TabsProvider modules={[module_]} initialType="watching">
        <Switch />
        <TabPanels />
      </TabsProvider>,
    );
    expect(reload).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Anderer Tab öffnen" }));
    expect(reload).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Zur Liste" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("ruft nicht beim ersten Anzeigen eines nach dem Neuladen wiederhergestellten Tabs", async () => {
    reload.mockClear();
    sessionStorage.setItem(
      "stammbuch.tabs",
      JSON.stringify({
        tabs: [
          { type: "watching", params: {} },
          { type: "other", params: {} },
        ],
        active: 1,
      }),
    );
    render(
      <TabsProvider modules={[module_]} persist>
        <Switch />
        <TabPanels />
      </TabsProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Zur Liste" }));
    expect(reload).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Anderer Tab öffnen" }));
    await userEvent.click(screen.getByRole("button", { name: "Zur Liste" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

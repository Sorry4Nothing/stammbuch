import { screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { TabPanels } from "../../shell/TabPanels";
import { TabsProvider, useTabs } from "../../shell/tabs";
import { renderWithProviders } from "../../test-utils";
import { settingsModule } from ".";
import { memorySettingsService } from "./memorySettingsService";
import { SettingsProvider } from "./service";

/** Setzt den Parameter `section` auf den offenen Einstellungen-Tab, wie «Mailkonto einrichten» im Mail-Modul. */
function Jump({ section }: { section: string }) {
  const { activeId, update } = useTabs();
  useEffect(() => update(activeId, { params: { section } }), [activeId, section, update]);
  return null;
}

describe("Einstellungen: Bereich per Tab-Parameter", () => {
  it("öffnet den gewünschten Bereich, auch wenn der Tab schon offen ist", async () => {
    renderWithProviders(
      <SettingsProvider service={memorySettingsService({})}>
        <TabsProvider modules={[settingsModule]} initialType="settings">
          <Jump section="mail" />
          <TabPanels />
        </TabsProvider>
      </SettingsProvider>,
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Mailkonto" })).toBeVisible();
  });
});

import { screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";
import { CurrentTabContext, TabsProvider, type CurrentTab } from "../../shell/tabs";
import { renderWithProviders } from "../../test-utils";
import { ComposePage } from "../mail/ComposePage";
import { ListEditPage } from "../mail/ListEditPage";
import { MailServiceContext } from "../mail/mailContext";
import { memoryMailService } from "../mail/memoryMailService";
import { createMemoryRechnungenService } from "../rechnungen/memoryRechnungenService";
import { RechnungenServiceProvider } from "../rechnungen/service";
import { RechnungFormPage } from "../rechnungen/RechnungFormPage";
import { mailModule } from "../mail";
import { rechnungenModule } from "../rechnungen";

/** Seiten anderer Module, die Personen mit Parametern öffnet: sie übernehmen die Vorgaben. */
function show(Page: ComponentType<{ tabId: string }>, params: Record<string, string>) {
  const tab: CurrentTab = {
    id: "t1",
    params,
    setDirty: vi.fn(),
    setTitle: vi.fn(),
    setPage: vi.fn(),
    registerSave: vi.fn(() => () => {}),
    close: vi.fn(),
  };
  const mail = memoryMailService({
    accounts: [{ id: "a1", label: "Kontakt", fromAddress: "k@example.ch", fromName: "Verein" }],
    messages: { inbox: [], sent: [], drafts: [], trash: [] },
    lists: [],
    groups: [],
    people: [],
    campaigns: [],
  });
  renderWithProviders(
    <MailServiceContext.Provider value={mail}>
      <RechnungenServiceProvider service={createMemoryRechnungenService()}>
        <TabsProvider modules={[mailModule, rechnungenModule]} initialType="mail">
          <CurrentTabContext.Provider value={tab}>
            <Page tabId="t1" />
          </CurrentTabContext.Provider>
        </TabsProvider>
      </RechnungenServiceProvider>
    </MailServiceContext.Provider>,
  );
  return tab;
}

describe("Zielseiten für Personen", () => {
  it("Mail verfassen übernimmt den Empfänger und gilt dann nicht als geändert", async () => {
    const tab = show(ComposePage, { to: "anna@example.ch" });
    expect(await screen.findByLabelText(/^An( |$)/)).toHaveValue("anna@example.ch");
    expect(tab.setDirty).not.toHaveBeenCalledWith(true);
  });

  it("neue Adressliste übernimmt die Personen", async () => {
    const entries = [
      { key: "p-1", personId: "p-1", name: "Anna Beispiel", email: "anna@example.ch", group: null },
      { key: "p-2", personId: "p-2", name: "Beat Demo", email: null, group: null },
    ];
    show(ListEditPage, { entries: JSON.stringify(entries) });
    expect(await screen.findByText("Anna Beispiel")).toBeInTheDocument();
    expect(screen.getByText("Beat Demo")).toBeInTheDocument();
  });

  it("neue Adressliste ignoriert unlesbare Angaben", async () => {
    show(ListEditPage, { entries: "kein json" });
    expect(await screen.findByRole("table", { name: /Personen|Adressliste/ })).toBeInTheDocument();
  });

  it("neue Rechnung wählt den Empfänger vor", async () => {
    show(RechnungFormPage, { personId: "m-1042", name: "Beispiel Treuhand" });
    expect(await screen.findByRole("combobox", { name: /^Empfänger/ })).toHaveValue(
      "Beispiel Treuhand AG",
    );
  });
});

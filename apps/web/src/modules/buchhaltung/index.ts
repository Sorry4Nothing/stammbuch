import type { ModuleDefinition } from "../types";
import "./buchhaltung.css";
import { BuchungenPage } from "./BuchungenPage";
import { DebitorPage } from "./DebitorPage";
import { HubPage } from "./HubPage";
import { ImportPage } from "./ImportPage";
import { KontenplanPage } from "./KontenplanPage";
import { OffenePostenPage } from "./OffenePostenPage";
import { TAB } from "./tabs";
import { ZuordnungPage } from "./ZuordnungPage";

/** Buchhaltung (Design-Gruppe 5). Die Kennung `accounting` erwarten Startseite und Suche. */
export const accountingModule: ModuleDefinition = {
  id: "accounting",
  titleKey: "module.accounting.title",
  nav: { labelKey: "module.accounting.nav", icon: "book", order: 3, tabType: TAB.hub },
  tabTypes: [
    { id: TAB.hub, titleKey: "bh.tab.hub", component: HubPage },
    { id: TAB.kontenplan, titleKey: "bh.tab.kontenplan", component: KontenplanPage },
    { id: TAB.buchungen, titleKey: "bh.tab.buchungen", component: BuchungenPage },
    { id: TAB.offene, titleKey: "bh.tab.offene", component: OffenePostenPage },
    { id: TAB.zuordnung, titleKey: "bh.tab.zuordnung", component: ZuordnungPage },
    { id: TAB.import, titleKey: "bh.tab.import", component: ImportPage },
    { id: TAB.debitor, titleKey: "bh.tab.debitor", component: DebitorPage },
  ],
};

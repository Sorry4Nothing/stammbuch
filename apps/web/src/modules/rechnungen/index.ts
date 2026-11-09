import type { ModuleDefinition } from "../types";
import { createHttpRechnungenService } from "./httpRechnungenService";
import { MahnungPage } from "./MahnungPage";
import { MahnwesenPage } from "./MahnwesenPage";
import { RechnungDetailPage } from "./RechnungDetailPage";
import { RechnungenListPage } from "./RechnungenListPage";
import { RechnungFormPage } from "./RechnungFormPage";
import { SammelrechnungPage } from "./SammelrechnungPage";
import { rechnungenSearch } from "./search";
import { setDefaultService } from "./service";

setDefaultService(createHttpRechnungenService());

export const rechnungenModule: ModuleDefinition = {
  // Kennung wie `MODULE_IDS.invoices` (Startseite und Suche schalten Schaltflächen darüber frei).
  id: "invoices",
  titleKey: "module.rechnungen.title",
  nav: { labelKey: "module.rechnungen.nav", icon: "invoice", order: 20, tabType: "rechnungen" },
  newTabType: "rechnung-neu",
  tabTypes: [
    { id: "rechnungen", titleKey: "module.rechnungen.title", component: RechnungenListPage },
    { id: "rechnung-neu", titleKey: "rechnungen.form.title", component: RechnungFormPage },
    { id: "rechnung", titleKey: "rechnungen.detail.what", component: RechnungDetailPage },
    { id: "mahnwesen", titleKey: "rechnungen.dunning.title", component: MahnwesenPage },
    { id: "mahnung", titleKey: "rechnungen.reminder.what", component: MahnungPage },
    { id: "sammelrechnung", titleKey: "rechnungen.collective.what", component: SammelrechnungPage },
  ],
  search: [rechnungenSearch],
};

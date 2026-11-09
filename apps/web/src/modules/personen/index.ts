import type { TextKey } from "../../i18n";
import type { IconName } from "../../ui";
import type { ModuleDefinition, SearchHit, SearchProvider } from "../types";
import { DuplikatePage } from "./DuplikatePage";
import { FirmaDetailPage } from "./FirmaDetailPage";
import { FirmaFormPage } from "./FirmaFormPage";
import { FirmenregisterPage } from "./FirmenregisterPage";
import { FreigabenPage } from "./FreigabenPage";
import { GruppenPage } from "./GruppenPage";
import { createHttpPersonenService } from "./httpPersonenService";
import { ImportPage } from "./ImportPage";
import { PersonDetailPage } from "./PersonDetailPage";
import { PersonFormPage } from "./PersonFormPage";
import { PersonenListPage } from "./PersonenListPage";
import { ZusammenfuehrenPage } from "./ZusammenfuehrenPage";
import { t } from "../../i18n";

/** Ansichten des Moduls, die nicht in der Seitenleiste stehen: Auffindbar über die Suche (Strg+K). */
const views: Array<{ tabType: string; labelKey: TextKey; icon: IconName }> = [
  { tabType: "gruppen", labelKey: "personen.tab.gruppen", icon: "people" },
  { tabType: "firmenregister", labelKey: "personen.tab.firmenregister", icon: "building" },
  { tabType: "duplikate", labelKey: "personen.tab.duplikate", icon: "copy" },
  { tabType: "firma-freigaben", labelKey: "personen.tab.freigaben", icon: "check" },
  { tabType: "personen-import", labelKey: "personen.tab.import", icon: "upload" },
];

/** Suche nur lesend: kein CSRF-Token nötig, und eine abgelaufene Sitzung meldet die Seite selbst. */
const searchService = createHttpPersonenService({
  csrfToken: () => null,
  onUnauthorized: () => {},
});

const personenSearch: SearchProvider = {
  id: "personen",
  groupKey: "personen.search.group",
  async search(query) {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const navigation: SearchHit[] = views
      .filter((v) => t(v.labelKey).toLowerCase().includes(needle))
      .map((v) => ({
        id: v.tabType,
        title: t(v.labelKey),
        kind: t("personen.search.view"),
        icon: v.icon,
        open: { tabType: v.tabType, key: v.tabType },
      }));
    const people = await searchService.listPersonen({ q: needle }).catch(() => undefined);
    const hits: SearchHit[] = (people?.items ?? []).slice(0, 8).map((p) => ({
      id: p.id,
      title: p.name,
      subtitle: [p.nr, p.ort].filter(Boolean).join(" · ") || undefined,
      kind: t("personen.search.person"),
      icon: p.typ === "firma" ? "building" : "user",
      open: { tabType: "person", key: p.id, params: { id: p.id }, title: p.name },
    }));
    return [...navigation, ...hits];
  },
};

export const personenModule: ModuleDefinition = {
  // Kennung `people`: Startseite und Suche (Branch 81, MODULE_IDS.people) schalten ihre Schaltflächen darüber frei.
  id: "people",
  titleKey: "module.personen.title",
  nav: { labelKey: "module.personen.nav", icon: "people", order: 1, tabType: "personen" },
  newTabType: "person-form",
  tabTypes: [
    { id: "personen", titleKey: "personen.tab.list", component: PersonenListPage },
    { id: "person", titleKey: "personen.tab.person", component: PersonDetailPage },
    { id: "person-form", titleKey: "personen.tab.personForm", component: PersonFormPage },
    { id: "gruppen", titleKey: "personen.tab.gruppen", component: GruppenPage },
    {
      id: "firmenregister",
      titleKey: "personen.tab.firmenregister",
      component: FirmenregisterPage,
    },
    { id: "firma", titleKey: "personen.tab.firma", component: FirmaDetailPage },
    { id: "firma-form", titleKey: "personen.tab.firmaForm", component: FirmaFormPage },
    { id: "duplikate", titleKey: "personen.tab.duplikate", component: DuplikatePage },
    { id: "duplikate-merge", titleKey: "personen.tab.merge", component: ZusammenfuehrenPage },
    { id: "firma-freigaben", titleKey: "personen.tab.freigaben", component: FreigabenPage },
    { id: "personen-import", titleKey: "personen.tab.import", component: ImportPage },
  ],
  search: [personenSearch],
};

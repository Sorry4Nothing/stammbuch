import type { ModuleDefinition } from "../types";
import { DebtorsPage } from "./DebtorsPage";
import { OpenItemsPage } from "./OpenItemsPage";
import { PeriodClosingPage } from "./PeriodClosingPage";
import { ReportsHome } from "./ReportsHome";
import { StatementsPage } from "./StatementsPage";
import { REPORT_TABS } from "./tabs";
import { TrialBalancePage } from "./TrialBalancePage";
import { VatPage } from "./VatPage";

export const reportsModule: ModuleDefinition = {
  id: "reports",
  titleKey: "module.reports.title",
  nav: { labelKey: "module.reports.nav", icon: "chart", order: 40, tabType: REPORT_TABS.home },
  tabTypes: [
    { id: REPORT_TABS.home, titleKey: "module.reports.title", component: ReportsHome },
    { id: REPORT_TABS.openItems, titleKey: "reports.tab.openItems", component: OpenItemsPage },
    { id: REPORT_TABS.debtors, titleKey: "reports.tab.debtors", component: DebtorsPage },
    {
      id: REPORT_TABS.trialBalance,
      titleKey: "reports.tab.trialBalance",
      component: TrialBalancePage,
    },
    { id: REPORT_TABS.statements, titleKey: "reports.tab.statements", component: StatementsPage },
    { id: REPORT_TABS.vat, titleKey: "reports.tab.vat", component: VatPage },
    { id: REPORT_TABS.closing, titleKey: "reports.tab.closing", component: PeriodClosingPage },
  ],
};

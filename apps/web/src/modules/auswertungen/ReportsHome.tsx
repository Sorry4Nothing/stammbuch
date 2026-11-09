import { t } from "../../i18n";
import { useTabs } from "../../shell/tabs";
import { Button, PageHeader } from "../../ui";
import { REPORT_TABS } from "./tabs";
import "./auswertungen.css";

const ENTRIES = [
  [REPORT_TABS.openItems, "reports.tab.openItems"],
  [REPORT_TABS.debtors, "reports.tab.debtors"],
  [REPORT_TABS.trialBalance, "reports.tab.trialBalance"],
  [REPORT_TABS.statements, "reports.tab.statements"],
  [REPORT_TABS.vat, "reports.tab.vat"],
  [REPORT_TABS.closing, "reports.tab.closing"],
] as const;

/**
 * Einstieg des Moduls. Die Boards zeigen nur die Auswertungen selbst; diese Liste öffnet sie
 * als Tabs (Abweichung vom Design, nötig für die Navigation).
 */
export function ReportsHome() {
  const { openTab } = useTabs();
  return (
    <div className="page">
      <PageHeader title={t("reports.home.title")} />
      <nav className="rep-home" aria-label={t("reports.home.title")}>
        {ENTRIES.map(([tab, key]) => (
          <Button key={tab} icon="chart" onClick={() => openTab(tab, { key: tab })}>
            {t(key)}
          </Button>
        ))}
      </nav>
    </div>
  );
}

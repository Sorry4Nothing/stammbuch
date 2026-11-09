import { useState } from "react";
import { t } from "../../i18n";
import { useTabs } from "../../shell/tabs";
import { Button, PageHeader, Panel } from "../../ui";
import { Dashboard } from "./Dashboard";
import { fiscalRanges, type FiscalRange } from "./fiscal";
import { LoadState, useLoad, useToday } from "./parts";
import { useReports } from "./service";
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
 * Einstieg des Moduls als Dashboard (Kennzahlen und Grafiken). Die Boards zeigen nur die Auswertungen
 * selbst; Dashboard und Liste der Auswertungen sind eine Abweichung vom Design auf Wunsch des Nutzers.
 */
export function ReportsHome() {
  const svc = useReports();
  const today = useToday();
  const { openTab } = useTabs();
  const settings = useLoad(() => svc.settings(), [svc]);
  const [range, setRange] = useState<FiscalRange["key"]>("current");

  return (
    <div className="page">
      <PageHeader title={t("reports.home.title")} />
      <LoadState load={settings}>
        {(s) => (
          <div className="rep__stack">
            <Dashboard
              ranges={fiscalRanges(today, s.fiscalYearStartMonth)}
              range={range}
              onRange={setRange}
            >
              <Panel title={t("dash.nav.title")}>
                <nav className="dash__links" aria-label={t("dash.nav.title")}>
                  {ENTRIES.map(([tab, key]) => (
                    <Button key={tab} icon="chart" onClick={() => openTab(tab, { key: tab })}>
                      {t(key)}
                    </Button>
                  ))}
                </nav>
              </Panel>
            </Dashboard>
          </div>
        )}
      </LoadState>
    </div>
  );
}

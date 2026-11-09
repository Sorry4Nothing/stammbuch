import { t, type TextKey } from "../../i18n";
import { useTabs } from "../../shell/tabs";
import { Button, PageHeader, Panel, type IconName } from "../../ui";
import { TAB } from "./tabs";

const areas: { tab: string; label: TextKey; icon: IconName }[] = [
  { tab: TAB.kontenplan, label: "bh.tab.kontenplan", icon: "book" },
  { tab: TAB.buchungen, label: "bh.tab.buchungen", icon: "list" },
  { tab: TAB.offene, label: "bh.tab.offene", icon: "clock" },
  { tab: TAB.zuordnung, label: "bh.tab.zuordnung", icon: "link" },
  { tab: TAB.import, label: "bh.tab.import", icon: "upload" },
];

/** Einstieg des Moduls: öffnet die Bereiche als Tabs. */
export function HubPage() {
  const { openTab } = useTabs();
  return (
    <div className="page">
      <PageHeader title={t("bh.tab.hub")} />
      <div className="page__body">
        <Panel title={t("bh.hub.areas")}>
          <div className="bh-areas">
            {areas.map((a) => (
              <Button key={a.tab} icon={a.icon} onClick={() => openTab(a.tab, { key: a.tab })}>
                {t(a.label)}
              </Button>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

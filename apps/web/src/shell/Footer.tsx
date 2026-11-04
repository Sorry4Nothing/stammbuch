import { t } from "../i18n";
import { Kbd } from "../ui";
import { useTabs } from "./tabs";

interface FooterProps {
  onSearch: () => void;
  onOverview: () => void;
}

/** Fusszeile (Design 2.1): Tastaturhinweise und Seitenzähler des aktiven Tabs. */
export function Footer({ onSearch, onOverview }: FooterProps) {
  const { active } = useTabs();
  const page = active?.page ?? { current: 1, total: 1 };
  return (
    <footer className="foot">
      <button type="button" className="foot__btn" onClick={onSearch}>
        <Kbd>{t("shortcuts.search.keys")}</Kbd> {t("shell.footer.search")}
      </button>
      <span>
        <Kbd>{t("shortcuts.new.keys")}</Kbd> {t("shell.footer.new")}
      </span>
      <span>
        <Kbd>{t("shortcuts.save.keys")}</Kbd> {t("shell.footer.save")}
      </span>
      <span>
        <Kbd>{t("shortcuts.tabNext.keys")}</Kbd> {t("shell.footer.tabSwitch")}
      </span>
      <span>
        <Kbd>{t("shortcuts.tabClose.keys")}</Kbd> {t("shell.footer.tabClose")}
      </span>
      <button type="button" className="foot__btn" onClick={onOverview}>
        <Kbd>{t("shortcuts.overview.keys")}</Kbd> {t("shell.footer.overview")}
      </button>
      <span className="foot__spacer" />
      <span>{t("shell.footer.page", { current: page.current, total: page.total })}</span>
    </footer>
  );
}

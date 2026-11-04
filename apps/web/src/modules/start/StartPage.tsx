import { t } from "../../i18n";

export function StartPage() {
  return (
    <section>
      <h1>{t("module.start.welcome")}</h1>
      <p>{t("module.start.intro")}</p>
    </section>
  );
}

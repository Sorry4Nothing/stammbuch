import { t } from "../../i18n";
import { useTabs } from "../../shell/tabs";
import { useOnTabActivate } from "../../shell/useOnTabActivate";
import { Badge } from "../../ui";
import { useAsync, useOnChange } from "./components";
import { usePersonen } from "./service";

const VIEWS = [
  { type: "personen", label: "personen.nav.personen" },
  { type: "gruppen", label: "personen.nav.gruppen" },
  { type: "firmenregister", label: "personen.nav.firmen" },
  { type: "firma-freigaben", label: "personen.nav.freigaben" },
  { type: "duplikate", label: "personen.nav.duplikate" },
] as const;

export type PersonenView = (typeof VIEWS)[number]["type"];

/** Unternavigation des Moduls: jeder Eintrag öffnet oder aktiviert den passenden Tab. */
export function PersonenNav({ current }: { current: PersonenView }) {
  const svc = usePersonen();
  const tabs = useTabs();
  // Die Freigaben-Seite führt Firmen und Personen zusammen: der Zähler auch.
  const waiting = useAsync(async () => {
    const [firmen, personen] = await Promise.all([
      svc.listFirmen({ status: "ausstehend" }),
      svc.features.statusAusstehend
        ? svc.listPersonen({ status: "ausstehend" })
        : Promise.resolve(undefined),
    ]);
    return firmen.items.length + (personen?.total ?? 0);
  }, [svc]);
  useOnChange(waiting.reload);
  useOnTabActivate(waiting.reload);
  const n = waiting.data ?? 0;

  return (
    <nav className="ptabs" aria-label={t("personen.nav.label")}>
      {VIEWS.map((v) => (
        <button
          key={v.type}
          type="button"
          className="pt"
          aria-current={v.type === current ? "page" : undefined}
          onClick={() => tabs.openTab(v.type, { key: v.type })}
        >
          {t(v.label)}
          {v.type === "firma-freigaben" && n > 0 && (
            <>
              {" "}
              <Badge tone="warning">{n}</Badge>
            </>
          )}
        </button>
      ))}
    </nav>
  );
}

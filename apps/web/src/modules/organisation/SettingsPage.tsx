import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { useCurrentTab } from "../../shell/tabs";
import { Icon, type IconName } from "../../ui";
import { AuditPage } from "./AuditPage";
import { LicencePage } from "./LicencePage";
import { MailPage } from "./MailPage";
import { OrganisationPage } from "./OrganisationPage";
import { UsersPage } from "./UsersPage";
import "./settings.css";

type Section = "organisation" | "mail" | "users" | "audit" | "licence";
type Save = () => Promise<boolean>;

const SECTIONS: { id: Section; icon: IconName }[] = [
  { id: "organisation", icon: "building" },
  { id: "mail", icon: "mail" },
  { id: "users", icon: "shield" },
  { id: "audit", icon: "list" },
  { id: "licence", icon: "key" },
];

/**
 * Einstellungen (Boards 9.1 bis 9.15): links die fünf Bereiche, rechts der gewählte. Organisation und
 * Mailkonto bleiben beim Wechsel eingehängt, damit ungespeicherte Eingaben nicht verloren gehen;
 * die übrigen Bereiche laden bei jedem Öffnen neu.
 */
export function SettingsPage() {
  const tab = useCurrentTab();
  const [section, setSection] = useState<Section>("organisation");
  const [visited, setVisited] = useState<Set<Section>>(new Set(["organisation"]));
  const [dirty, setDirty] = useState({ organisation: false, mail: false });
  const saves = useRef<{ organisation?: Save | undefined; mail?: Save | undefined }>({});
  const current = useRef(section);
  current.current = section;

  const open = (next: Section) => {
    setSection(next);
    setVisited((v) => new Set(v).add(next));
  };

  const { setDirty: setTabDirty, registerSave } = tab;
  useEffect(() => {
    const labels = [
      dirty.organisation && t("settings.nav.organisation"),
      dirty.mail && t("settings.nav.mail"),
    ].filter(Boolean);
    setTabDirty(labels.length > 0, labels.join(", "));
  }, [dirty, setTabDirty]);

  useEffect(
    () =>
      registerSave(async () => {
        const save =
          current.current === "organisation"
            ? saves.current.organisation
            : current.current === "mail"
              ? saves.current.mail
              : undefined;
        return save ? await save() : true;
      }),
    [registerSave],
  );

  const orgDirty = useCallback((d: boolean) => setDirty((s) => ({ ...s, organisation: d })), []);
  const mailDirty = useCallback((d: boolean) => setDirty((s) => ({ ...s, mail: d })), []);
  const orgSave = useCallback(
    (fn: Save | null) => void (saves.current.organisation = fn ?? undefined),
    [],
  );
  const mailSave = useCallback(
    (fn: Save | null) => void (saves.current.mail = fn ?? undefined),
    [],
  );

  return (
    <div className="set">
      <nav className="nav set__nav" aria-label={t("settings.title")}>
        {SECTIONS.map((s) => {
          const on = section === s.id;
          return (
            <button
              key={s.id}
              type="button"
              className={on ? "nav__item is-active" : "nav__item"}
              aria-current={on ? "page" : undefined}
              onClick={() => open(s.id)}
            >
              <Icon name={s.icon} size={18} />
              <span>{t(`settings.nav.${s.id}`)}</span>
            </button>
          );
        })}
      </nav>
      <div className="set__main">
        {visited.has("organisation") && (
          <div className="set__section" hidden={section !== "organisation"}>
            <OrganisationPage onDirtyChange={orgDirty} registerSave={orgSave} />
          </div>
        )}
        {visited.has("mail") && (
          <div className="set__section" hidden={section !== "mail"}>
            <MailPage onDirtyChange={mailDirty} registerSave={mailSave} />
          </div>
        )}
        {section === "users" && <UsersPage />}
        {section === "audit" && <AuditPage />}
        {section === "licence" && <LicencePage />}
      </div>
    </div>
  );
}

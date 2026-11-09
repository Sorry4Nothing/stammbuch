import { t } from "../i18n";
import { Button, Dialog, Kbd } from "../ui";
import { shortcutColumns } from "./shortcuts";

/** Tastaturkürzel-Übersicht (Design 2.4, Strg+/): vier Gruppen in zwei Spalten, je eine Tabelle mit Zeilenköpfen. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title={t("shortcuts.title")}
      width={820}
      top={90}
      onClose={onClose}
      footer={
        <Button variant="primary" icon="close" data-autofocus onClick={onClose}>
          {t("shortcuts.close")}
        </Button>
      }
    >
      <div className="shortcuts">
        {shortcutColumns.map((groups, i) => (
          <div key={i} className="shortcuts__col">
            {groups.map((g) => (
              <section key={g.titleKey}>
                <h3>{t(g.titleKey)}</h3>
                <table className="tbl" aria-label={t("shortcuts.table", { group: t(g.titleKey) })}>
                  <colgroup>
                    <col />
                    <col style={{ width: "184px" }} />
                  </colgroup>
                  <tbody>
                    {g.rows.map((r) => (
                      <tr key={r.labelKey}>
                        <th scope="row">{t(r.labelKey)}</th>
                        <td>
                          <Kbd>{t(r.keys)}</Kbd>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ))}
          </div>
        ))}
      </div>
    </Dialog>
  );
}

import { t } from "../i18n";
import { Button, DataTable, Dialog, Kbd, Panel } from "../ui";
import { shortcutColumns, type ShortcutRow } from "./shortcuts";

const columns = [
  { key: "label", header: t("shortcuts.col.function"), cell: (r: ShortcutRow) => t(r.labelKey) },
  {
    key: "keys",
    header: t("shortcuts.col.keys"),
    width: "150px",
    cell: (r: ShortcutRow) => <Kbd>{t(r.keys)}</Kbd>,
  },
];

/** Tastaturkürzel-Übersicht (Design 2.4, Strg+/). */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title={t("shortcuts.title")}
      width={820}
      onClose={onClose}
      footer={
        <Button variant="primary" icon="close" data-autofocus onClick={onClose}>
          {t("ui.close")}
        </Button>
      }
    >
      <span className="muted">{t("shortcuts.intro")}</span>
      <div className="shortcuts">
        {shortcutColumns.map((groups, i) => (
          <div key={i} className="shortcuts__col">
            {groups.map((g) => (
              <Panel key={g.titleKey} title={t(g.titleKey)} flush>
                <DataTable
                  label={t(g.titleKey)}
                  hideHeader
                  columns={columns}
                  rows={g.rows}
                  rowKey={(r) => r.labelKey}
                />
              </Panel>
            ))}
          </div>
        ))}
      </div>
    </Dialog>
  );
}

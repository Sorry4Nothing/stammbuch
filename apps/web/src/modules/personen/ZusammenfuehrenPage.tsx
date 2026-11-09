import { useEffect, useMemo, useState } from "react";
import { t, tp } from "../../i18n";
import { useCurrentTab } from "../../shell/tabs";
import { Button, Message, PageHeader, Panel, useToast } from "../../ui";
import { Kv, LoadError, Loading, notifyChange, useAsync } from "./components";
import { usePersonen } from "./service";

/** Reihenfolge und Beschriftung der Felder, soweit der Eintrag sie kennt. */
const FIELDS = [
  ["name", "personen.field.firmenname"],
  ["vorname", "personen.field.vorname"],
  ["nachname", "personen.field.nachname"],
  ["uid", "personen.field.uid"],
  ["mwstNr", "personen.field.mwst"],
  ["strasse", "personen.field.strasse"],
  ["plzOrt", "personen.detail.plzOrt"],
  ["email", "personen.field.email"],
  ["telefon", "personen.field.telefon"],
  ["eintritt", "personen.field.eintritt"],
] as const;

type Side = "a" | "b";

/** Duplikate zusammenführen: Werte je Feld wählen (Design 3.13). */
export function ZusammenfuehrenPage() {
  const svc = usePersonen();
  const tab = useCurrentTab();
  const toast = useToast();
  const id = tab.params["id"] ?? "";
  const dup = useAsync(() => svc.getDuplikat(id), [svc, id]);
  const [choice, setChoice] = useState<Record<string, Side>>({});
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const d = dup.data;
  const fields = useMemo(
    () => (d ? FIELDS.filter(([key]) => key in d.a.felder || key in d.b.felder) : []),
    [d],
  );
  useEffect(() => {
    if (!d) return;
    // Voreinstellung: Eintrag A, ausser A hat keinen Wert.
    setChoice(Object.fromEntries(fields.map(([key]) => [key, d.a.felder[key] ? "a" : "b"])));
  }, [d, fields]);

  if (dup.error) return <LoadError onRetry={dup.reload} />;
  if (!d) return <Loading />;

  const merge = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await svc.merge(d.id, {
        behaltenId: d.a.id,
        entfernenId: d.b.id,
        werte: Object.fromEntries(
          fields.map(([key]) => [key, (choice[key] === "b" ? d.b : d.a).felder[key] ?? ""]),
        ),
      });
      notifyChange();
      toast.show({ tone: "ok", title: t("personen.merge.done") });
      tab.close();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  const head = (e: typeof d.a, side: string) =>
    [`${side}`, e.nr, tp("personen.merge.rechnungen", e.rechnungen)].filter(Boolean).join(" · ");

  return (
    <div className="page">
      <PageHeader
        crumb={t("personen.merge.crumb", { name: d.a.name })}
        title={t("personen.merge.title")}
        actions={
          <>
            <Button onClick={() => tab.close()}>{t("personen.merge.cancel")}</Button>
            <Button variant="primary" icon="merge" disabled={busy} onClick={() => void merge()}>
              {t("personen.merge.confirm")}
            </Button>
          </>
        }
      />
      <div className="pad-form">
        {failed && <Message tone="error" title={t("personen.merge.failed")} />}
        <Panel title={t("personen.merge.pick")} flush>
          <table className="tbl" aria-label={t("personen.merge.pick")}>
            <colgroup>
              <col className="col-field" />
              <col />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">{t("personen.merge.field")}</th>
                <th scope="col">{head(d.a, t("personen.duplikate.col.a"))}</th>
                <th scope="col">{head(d.b, t("personen.duplikate.col.b"))}</th>
              </tr>
            </thead>
            <tbody>
              {fields.map(([key, label]) => (
                <tr key={key}>
                  <th scope="row">{t(label)}</th>
                  {(["a", "b"] as const).map((side) => {
                    const value = d[side].felder[key] ?? "–";
                    return (
                      <td key={side}>
                        <label className="opt pick">
                          <input
                            type="radio"
                            className="chk-input"
                            name={`wert-${key}`}
                            checked={choice[key] === side}
                            onChange={() => setChoice((c) => ({ ...c, [key]: side }))}
                            aria-label={t("personen.merge.radio", {
                              field: t(label),
                              side: t(
                                side === "a"
                                  ? "personen.duplikate.col.a"
                                  : "personen.duplikate.col.b",
                              ),
                              value,
                            })}
                          />
                          <span className="rad" aria-hidden="true" />
                          <span>{value}</span>
                        </label>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title={t("personen.merge.result")}>
          <Kv
            rows={[
              [
                t("personen.merge.result.kept"),
                t("personen.merge.result.keptValue", {
                  name: t("personen.duplikate.col.a"),
                  nr: d.a.nr ?? d.a.name,
                }),
              ],
              [
                t("personen.merge.result.rechnungen"),
                t("personen.merge.result.rechnungenValue", {
                  n: d.a.rechnungen + d.b.rechnungen,
                  a: d.a.rechnungen,
                  b: d.b.rechnungen,
                }),
              ],
              [t("personen.merge.result.buchungen"), t("personen.merge.result.buchungenValue")],
              [
                t("personen.duplikate.col.b"),
                t("personen.merge.result.removed", { nr: d.b.nr ?? d.b.name }),
              ],
            ]}
          />
          <div className="mt-3">
            <Message tone="warning" title={t("personen.merge.final.title")}>
              {t("personen.merge.final.text")}
            </Message>
          </div>
        </Panel>
      </div>
    </div>
  );
}

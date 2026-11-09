import { useState } from "react";
import { t } from "../../i18n";
import { Button, Dialog, Message, TextField } from "../../ui";
import { amount, parseAmount, type DunningLevel } from "./model";
import { errorText } from "./parts";
import { useRechnungen } from "./service";
import "./rechnungen.css";

const MAX_LEVELS = 5;
const MAX_FEE_CENTS = 100_000;

/** Eingabe einer Stufe als Text, damit halbfertige Eingaben nicht zu Zahlen gezwungen werden. */
interface Draft {
  title: string;
  waitDays: string;
  graceDays: string;
  fee: string;
}

const toDraft = (l: DunningLevel): Draft => ({
  title: l.title,
  waitDays: String(l.waitDays),
  graceDays: String(l.graceDays),
  fee: amount(l.feeCents),
});

const days = (text: string, min: number): number | null => {
  const n = /^\d{1,3}$/.test(text.trim()) ? Number(text.trim()) : NaN;
  return Number.isInteger(n) && n >= min && n <= 365 ? n : null;
};

/** Stufen prüfen: `null` je Feld = gültig, sonst der Fehlertext. */
function check(d: Draft) {
  const fee = parseAmount(d.fee);
  return {
    title:
      d.title.trim() === "" || d.title.trim().length > 60
        ? t("rechnungen.dunning.err.title")
        : null,
    waitDays: days(d.waitDays, 0) === null ? t("rechnungen.dunning.err.wait") : null,
    graceDays: days(d.graceDays, 1) === null ? t("rechnungen.dunning.err.grace") : null,
    fee: fee === null || fee > MAX_FEE_CENTS ? t("rechnungen.dunning.err.fee") : null,
  };
}

/** Mahnstufen einstellen: Bezeichnung, Wartezeit, Zahlungsfrist und Gebühr je Stufe. */
export function DunningSettingsDialog({
  levels,
  onClose,
  onSaved,
}: {
  levels: readonly DunningLevel[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const service = useRechnungen();
  const [drafts, setDrafts] = useState<Draft[]>(levels.map(toDraft));
  const [shown, setShown] = useState(false);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);

  const set = (i: number, patch: Partial<Draft>) =>
    setDrafts((all) => all.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  const submit = async () => {
    setShown(true);
    if (drafts.some((d) => Object.values(check(d)).some(Boolean))) return;
    setBusy(true);
    setFailure("");
    try {
      await service.saveDunningLevels(
        drafts.map((d, i) => ({
          level: i + 1,
          title: d.title.trim(),
          waitDays: days(d.waitDays, 0) ?? 0,
          graceDays: days(d.graceDays, 1) ?? 1,
          feeCents: parseAmount(d.fee) ?? 0,
        })),
      );
      onSaved();
    } catch (e) {
      setFailure(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("rechnungen.dunning.settingsTitle")}
      width={640}
      closeLabel={t("rechnungen.dialog.close")}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button data-autofocus onClick={onClose}>
            {t("ui.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {t("rechnungen.dunning.settingsSave")}
          </Button>
        </>
      }
    >
      {drafts.map((d, i) => {
        const e = shown ? check(d) : { title: null, waitDays: null, graceDays: null, fee: null };
        return (
          <fieldset key={i} className="rg-level">
            <legend>{t("rechnungen.dunning.stage", { n: i + 1 })}</legend>
            <TextField
              label={t("rechnungen.dunning.field.title")}
              required
              value={d.title}
              error={e.title ?? undefined}
              onChange={(ev) => set(i, { title: ev.target.value })}
            />
            <TextField
              label={t("rechnungen.dunning.field.wait")}
              required
              inputMode="numeric"
              hint={t(
                i === 0 ? "rechnungen.dunning.hint.waitFirst" : "rechnungen.dunning.hint.wait",
              )}
              value={d.waitDays}
              error={e.waitDays ?? undefined}
              onChange={(ev) => set(i, { waitDays: ev.target.value })}
            />
            <TextField
              label={t("rechnungen.dunning.field.grace")}
              required
              inputMode="numeric"
              value={d.graceDays}
              error={e.graceDays ?? undefined}
              onChange={(ev) => set(i, { graceDays: ev.target.value })}
            />
            <TextField
              label={t("rechnungen.dunning.field.fee")}
              required
              inputMode="decimal"
              value={d.fee}
              error={e.fee ?? undefined}
              onChange={(ev) => set(i, { fee: ev.target.value })}
            />
          </fieldset>
        );
      })}
      <div className="rg-flex">
        <Button
          icon="plus"
          disabled={drafts.length >= MAX_LEVELS}
          onClick={() =>
            setDrafts((all) => [...all, { title: "", waitDays: "0", graceDays: "10", fee: "0.00" }])
          }
        >
          {t("rechnungen.dunning.addStage")}
        </Button>
        <Button
          variant="ghost"
          icon="close"
          disabled={drafts.length <= 1}
          onClick={() => setDrafts((all) => all.slice(0, -1))}
        >
          {t("rechnungen.dunning.removeStage", { n: drafts.length })}
        </Button>
      </div>
      {failure && <Message tone="error">{failure}</Message>}
    </Dialog>
  );
}

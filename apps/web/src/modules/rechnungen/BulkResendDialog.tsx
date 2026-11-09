import { useState } from "react";
import { t, tp, type TextKey } from "../../i18n";
import { Badge, Button, Dialog, Message, type Tone } from "../../ui";
import { errorText } from "./parts";
import { RESEND_BATCH_MAX, useRechnungen, type ResendResult } from "./service";
import "./rechnungen.css";

const TONE: Record<ResendResult["outcome"], Tone> = {
  sent: "ok",
  skipped: "warning",
  failed: "error",
};

/**
 * Sammelaktion «Rechnungen erneut senden» (Liste, mehrere markierte Rechnungen): erst Bestätigung, dann ein Ergebnis je
 * Rechnung. Adresse und Text setzt der Server; Personen ohne E-Mail-Adresse werden übersprungen, Fehler einzelner
 * Rechnungen stoppen die übrigen nicht.
 */
export function BulkResendDialog({
  ids,
  onClose,
}: {
  ids: readonly string[];
  onClose: () => void;
}) {
  const service = useRechnungen();
  const [results, setResults] = useState<ResendResult[] | null>(null);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const tooMany = ids.length > RESEND_BATCH_MAX;

  const submit = async () => {
    setBusy(true);
    setFailure("");
    try {
      const done = await service.resendInvoices(ids);
      setResults(done);
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (results) {
    const count = (outcome: ResendResult["outcome"]) =>
      results.filter((r) => r.outcome === outcome).length;
    return (
      <Dialog
        title={t("rechnungen.bulkResend.resultTitle")}
        width={680}
        closeLabel={t("rechnungen.dialog.close")}
        onClose={onClose}
        footer={
          <Button data-autofocus variant="primary" onClick={onClose}>
            {t("rechnungen.bulkResend.close")}
          </Button>
        }
      >
        <Message tone={count("failed") > 0 ? "error" : count("skipped") > 0 ? "warning" : "ok"}>
          {t("rechnungen.bulkResend.summary", {
            sent: count("sent"),
            skipped: count("skipped"),
            failed: count("failed"),
          })}
        </Message>
        <table className="tbl" aria-label={t("rechnungen.bulkResend.table")}>
          <thead>
            <tr>
              <th scope="col">{t("rechnungen.bulkResend.col.invoice")}</th>
              <th scope="col">{t("rechnungen.bulkResend.col.result")}</th>
              <th scope="col">{t("rechnungen.bulkResend.col.note")}</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.id}>
                <td>
                  <b>{r.number ?? t("rechnungen.draftName")}</b>
                </td>
                <td>
                  <Badge tone={TONE[r.outcome]}>
                    {t(`rechnungen.bulkResend.outcome.${r.outcome}` as TextKey)}
                  </Badge>
                </td>
                <td>{r.reason ? t(`rechnungen.bulkResend.reason.${r.reason}` as TextKey) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={tp("rechnungen.bulkResend.title", ids.length)}
      width={580}
      closeLabel={t("rechnungen.dialog.close")}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button data-autofocus onClick={onClose}>
            {t("ui.cancel")}
          </Button>
          <Button type="submit" variant="primary" icon="send" disabled={busy || tooMany}>
            {t("rechnungen.bulkResend.submit")}
          </Button>
        </>
      }
    >
      <p>{t("rechnungen.bulkResend.intro")}</p>
      {tooMany && (
        <Message tone="error">
          {t("rechnungen.bulkResend.limit", { max: RESEND_BATCH_MAX })}
        </Message>
      )}
      {busy && <Message>{t("rechnungen.bulkResend.running")}</Message>}
      {failure && <Message tone="error">{failure}</Message>}
    </Dialog>
  );
}

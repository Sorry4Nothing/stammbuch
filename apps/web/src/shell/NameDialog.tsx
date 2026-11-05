import { useState } from "react";
import { useAuth } from "../auth/auth";
import { t } from "../i18n";
import { Button, Dialog, Message, TextField, useToast } from "../ui";

/** Eigenen Anzeigenamen ändern. Gespeichert wird serverseitig für den angemeldeten Benutzer (SR-13). */
export function NameDialog({ onClose }: { onClose: () => void }) {
  const auth = useAuth();
  const toast = useToast();
  const [name, setName] = useState(auth.session?.name ?? "");
  const [error, setError] = useState<string | undefined>();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const value = name.trim();
    if (!value) {
      setError(t("shell.name.required"));
      return;
    }
    setError(undefined);
    setFailed(false);
    setBusy(true);
    try {
      const saved = await auth.service.updateName(value);
      if (auth.session) auth.setSession({ ...auth.session, name: saved });
      toast.show({ tone: "ok", title: t("shell.name.saved") });
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("shell.name.title")}
      onClose={onClose}
      onSubmit={() => void save()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("shell.name.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {t("shell.name.save")}
          </Button>
        </>
      }
    >
      {failed && <Message tone="error">{t("shell.name.failed")}</Message>}
      <TextField
        label={t("shell.name.label")}
        name="name"
        autoComplete="name"
        maxLength={120}
        data-autofocus
        value={name}
        error={error}
        onChange={(e) => setName(e.target.value)}
      />
    </Dialog>
  );
}

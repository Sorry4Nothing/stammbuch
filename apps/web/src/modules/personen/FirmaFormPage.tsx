import { useEffect, useMemo, useRef, useState } from "react";
import { t, tp } from "../../i18n";
import { useCurrentTab, useTabs } from "../../shell/tabs";
import { Badge, Button, Message, PageHeader, Panel, useToast } from "../../ui";
import {
  ErrorSummary,
  FormInput,
  FormTextArea,
  LoadError,
  Loading,
  PDialog,
  focusField,
  useCloseWhen,
  notifyChange,
  useAsync,
} from "./components";
import { isEmail } from "./format";
import { FieldErrors, type Firma, type FirmaDuplikat, type FirmaInput } from "./model";
import { usePersonen } from "./service";

interface Values {
  name: string;
  uid: string;
  mwstNr: string;
  strasse: string;
  plz: string;
  ort: string;
  kontaktperson: string;
  email: string;
  telefon: string;
  rechnungsEmail: string;
  notiz: string;
}

const empty: Values = {
  name: "",
  uid: "",
  mwstNr: "",
  strasse: "",
  plz: "",
  ort: "",
  kontaktperson: "",
  email: "",
  telefon: "",
  rechnungsEmail: "",
  notiz: "",
};

const fromFirma = (f: Firma): Values => ({
  name: f.name,
  uid: f.uid ?? "",
  mwstNr: f.mwstNr ?? "",
  strasse: f.strasse,
  plz: f.plz,
  ort: f.ort,
  kontaktperson: f.kontaktperson ?? "",
  email: f.email ?? "",
  telefon: f.telefon ?? "",
  rechnungsEmail: f.rechnungsEmail ?? "",
  notiz: f.notiz ?? "",
});

const UID = /^CHE[-\s]?\d{3}\.?\d{3}\.?\d{3}$/i;
const MWST = /^CHE[-\s]?\d{3}\.?\d{3}\.?\d{3}\s*(MWST|TVA|IVA)$/i;

const ID: Record<string, string> = {
  name: "fx1",
  uid: "fx2",
  mwstNr: "fx3",
  strasse: "fx4",
  plz: "fx5",
  ort: "fx6",
  kontaktperson: "fx7",
  email: "fx8",
  rechnungsEmail: "fx10",
};

const LABEL: Record<string, string> = {
  name: t("personen.field.firmenname"),
  uid: t("personen.field.uid"),
  mwstNr: t("personen.field.mwst"),
  strasse: t("personen.field.strasseNr"),
  plz: t("personen.field.plz"),
  ort: t("personen.field.ort"),
  kontaktperson: t("personen.field.kontaktperson"),
  email: t("personen.field.emailAdresse"),
  rechnungsEmail: t("personen.field.rechnungsEmail"),
};

/** Firma erfassen oder bearbeiten (Design 3.11). */
export function FirmaFormPage() {
  const svc = usePersonen();
  const tab = useCurrentTab();
  const id = tab.params["id"] ?? null;
  const loaded = useAsync(
    async () => (id ? fromFirma(await svc.getFirma(id)) : undefined),
    [svc, id],
  );
  if (loaded.error) return <LoadError onRetry={loaded.reload} />;
  if (id && !loaded.data) return <Loading />;
  return <Form key={id ?? "neu"} id={id} initial={loaded.data ?? empty} />;
}

function Form({ id, initial }: { id: string | null; initial: Values }) {
  const svc = usePersonen();
  const tabs = useTabs();
  const tab = useCurrentTab();
  const toast = useToast();
  const x = svc.features.firmaExtras;
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [duplicates, setDuplicates] = useState<FirmaDuplikat[] | null>(null);

  const dirty = useMemo(
    () => JSON.stringify(values) !== JSON.stringify(initial),
    [values, initial],
  );
  useEffect(() => tab.setDirty(dirty && !saved), [tab, dirty, saved]);
  useCloseWhen(saved);

  const set = (key: keyof Values, value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => {
      if (!(key in e)) return e;
      return Object.fromEntries(Object.entries(e).filter(([k]) => k !== key));
    });
  };

  const validate = (v: Values): Record<string, string> => {
    const e: Record<string, string> = {};
    const need = (k: keyof Values) => {
      if (!v[k].trim()) e[k] = t("personen.error.required");
    };
    need("name");
    need("strasse");
    need("plz");
    need("ort");
    need("email");
    if (x) need("kontaktperson");
    if (!v.uid.trim()) e["uid"] = t("personen.error.required");
    else if (!UID.test(v.uid.trim())) e["uid"] = t("personen.error.uid");
    if (v.mwstNr.trim() && !MWST.test(v.mwstNr.trim())) e["mwstNr"] = t("personen.error.mwst");
    if (v.plz.trim() && !/^\d{4}$/.test(v.plz.trim())) e["plz"] = t("personen.error.plz");
    if (v.email.trim() && !isEmail(v.email)) e["email"] = t("personen.error.email");
    if (x && v.rechnungsEmail.trim() && !isEmail(v.rechnungsEmail)) {
      e["rechnungsEmail"] = t("personen.error.email");
    }
    return e;
  };

  const toInput = (v: Values): FirmaInput => {
    const opt = (s: string) => s.trim() || undefined;
    return {
      name: v.name.trim(),
      uid: opt(v.uid),
      mwstNr: opt(v.mwstNr),
      strasse: v.strasse.trim(),
      plz: v.plz.trim(),
      ort: v.ort.trim(),
      email: opt(v.email),
      telefon: opt(v.telefon),
      kontaktperson: x ? opt(v.kontaktperson) : undefined,
      rechnungsEmail: x ? opt(v.rechnungsEmail) : undefined,
      notiz: x ? opt(v.notiz) : undefined,
    };
  };

  const store = async (): Promise<boolean> => {
    setBusy(true);
    try {
      const f = await svc.saveFirma(id, toInput(values));
      notifyChange();
      toast.show({ tone: "ok", title: t("personen.firmen.form.saved") });
      if (!id) tabs.openTab("firma", { key: f.id, params: { id: f.id }, title: f.name });
      setDuplicates(null);
      setSaved(true);
      return true;
    } catch (e) {
      if (e instanceof FieldErrors) setErrors(e.fields);
      else setFailed(true);
      setBusy(false);
      setDuplicates(null);
      return false;
    }
  };

  const save = async (): Promise<boolean> => {
    const found = validate(values);
    setErrors(found);
    setFailed(false);
    const first = Object.keys(ID).find((k) => k in found);
    if (first) {
      focusField(ID[first] ?? "");
      return false;
    }
    // «Prüfung beim Speichern»: mögliche Duplikate zeigen, bevor die Firma angelegt wird.
    try {
      const hits = await svc.firmaDuplikate(toInput(values), id ?? undefined);
      if (hits.length > 0) {
        setDuplicates(hits);
        return false;
      }
    } catch {
      setFailed(true);
      return false;
    }
    return store();
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => tab.registerSave(() => saveRef.current()), [tab]);

  const field = (
    key: keyof Values,
    label: string,
    options: { required?: boolean; hint?: string; placeholder?: string } = {},
  ) => (
    <FormInput
      id={ID[key]}
      label={label}
      required={options.required}
      hint={options.hint}
      placeholder={options.placeholder}
      value={values[key]}
      error={errors[key]}
      onChange={(e) => set(key, e.target.value)}
    />
  );

  return (
    <div className="page">
      <PageHeader
        crumb={t("personen.firmen.form.crumb", {
          end: id ? initial.name : t("personen.form.crumb.neu"),
        })}
        title={id ? t("personen.firmen.form.titleEdit") : t("personen.firmen.form.title")}
        status={
          dirty && !saved ? <Badge tone="warning">{t("personen.form.unsaved")}</Badge> : undefined
        }
        actions={
          <>
            <Button onClick={() => tab.close()}>{t("personen.firmen.form.cancel")}</Button>
            <Button variant="primary" icon="save" disabled={busy} onClick={() => void save()}>
              {t("personen.firmen.form.save")}
            </Button>
          </>
        }
      />
      <div className="pad-form">
        <ErrorSummary
          items={Object.keys(ID)
            .filter((k) => k in errors)
            .map((k) => ({ id: ID[k] ?? k, label: LABEL[k] ?? k }))}
        />
        {failed && <Message tone="error" title={t("personen.firmen.form.failed")} />}
      </div>
      <div className="form-cols">
        <div className="form-col">
          <Panel title={t("personen.firmen.form.panel.firma")}>
            <div className="stack stack--lg">
              {field("name", t("personen.field.firmenname"), { required: true })}
              {field("uid", t("personen.field.uid"), {
                required: true,
                placeholder: t("personen.placeholder.uid"),
              })}
              {field("mwstNr", t("personen.field.mwst"), {
                placeholder: t("personen.placeholder.mwst"),
              })}
              {field("strasse", t("personen.field.strasseNr"), { required: true })}
              <div className="form-grid">
                {field("plz", t("personen.field.plz"), { required: true })}
                {field("ort", t("personen.field.ort"), { required: true })}
              </div>
            </div>
          </Panel>
        </div>
        <div className="form-col">
          <Panel title={t("personen.detail.kontakt")}>
            <div className="stack stack--lg">
              {x && field("kontaktperson", t("personen.field.kontaktperson"), { required: true })}
              {field("email", t("personen.field.emailAdresse"), { required: true })}
              {field("telefon", t("personen.field.telefon"))}
              {x &&
                field("rechnungsEmail", t("personen.field.rechnungsEmail"), {
                  hint: t("personen.hint.rechnungsEmail"),
                })}
              {x && (
                <FormTextArea
                  label={t("personen.detail.bemerkung")}
                  value={values.notiz}
                  onChange={(e) => set("notiz", e.target.value)}
                />
              )}
            </div>
          </Panel>
        </div>
      </div>

      {duplicates && (
        <PDialog
          title={t("personen.firmen.form.dup.title")}
          width={620}
          onClose={() => setDuplicates(null)}
          footer={
            <>
              <Button data-autofocus onClick={() => setDuplicates(null)}>
                {t("personen.firmen.form.dup.back")}
              </Button>
              <Button variant="primary" icon="save" disabled={busy} onClick={() => void store()}>
                {t("personen.firmen.form.dup.save")}
              </Button>
            </>
          }
        >
          <Message
            tone="warning"
            title={tp("personen.firmen.form.dup.warning", duplicates.length)}
          />
          <ul className="stack stack--sm">
            {duplicates.map((d) => (
              <li key={d.firma.id}>
                <b>{d.firma.name}</b>
                {" · "}
                {[d.firma.uid, `${d.firma.plz} ${d.firma.ort}`].filter(Boolean).join(" · ")}
                {" · "}
                {t("personen.firmen.form.dup.score", { n: Math.round(d.score * 100) })}
              </li>
            ))}
          </ul>
        </PDialog>
      )}
    </div>
  );
}

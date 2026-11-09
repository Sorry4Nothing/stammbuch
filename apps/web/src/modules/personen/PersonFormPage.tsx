import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n";
import { useCurrentTab, useTabs } from "../../shell/tabs";
import {
  Badge,
  Button,
  Message,
  PageHeader,
  Panel,
  RadioGroup,
  dateError,
  formatPhone,
  normalizePhone,
  useToast,
} from "../../ui";
import {
  ErrorSummary,
  FormInput,
  FormSelect,
  FormTextArea,
  LoadError,
  Loading,
  focusField,
  useCloseWhen,
  notifyChange,
  useAsync,
  useOnChange,
} from "./components";
import { formatDate, isEmail, parseDate, todayIso } from "./format";
import { FieldErrors, type Anrede, type Kanal, type PersonDetail, type PersonInput } from "./model";
import { usePersonen } from "./service";

interface Values {
  /** Mitgliedsnr., nur zur Anzeige. */
  nr: string;
  typ: "einzel" | "firma";
  anrede: string;
  vorname: string;
  nachname: string;
  strasse: string;
  plz: string;
  ort: string;
  geburtsdatum: string;
  email: string;
  telefon: string;
  eintritt: string;
  kanal: string;
  gruppeId: string;
  notiz: string;
  firmaId: string;
  funktion: string;
}

const empty = (typ: Values["typ"], firmaId = ""): Values => ({
  nr: "",
  typ,
  anrede: "",
  vorname: "",
  nachname: "",
  strasse: "",
  plz: "",
  ort: "",
  geburtsdatum: "",
  email: "",
  telefon: "",
  eintritt: formatDate(todayIso()),
  kanal: "",
  gruppeId: "",
  notiz: "",
  firmaId,
  funktion: "",
});

const fromPerson = (p: PersonDetail): Values => ({
  nr: p.nr ?? "",
  typ: p.typ,
  anrede: p.anrede ?? "",
  vorname: p.vorname,
  nachname: p.nachname,
  strasse: p.strasse ?? "",
  plz: p.plz ?? "",
  ort: p.ortAdresse ?? "",
  geburtsdatum: p.geburtsdatum ? formatDate(p.geburtsdatum) : "",
  email: p.email ?? "",
  telefon: formatPhone(p.telefon),
  eintritt: p.eintritt ? formatDate(p.eintritt) : "",
  kanal: p.kanal ?? "",
  gruppeId: p.gruppeId ?? "",
  notiz: p.notiz ?? "",
  firmaId: p.firmaId ?? "",
  funktion: p.funktion ?? "",
});

/** Feld-IDs, zugleich Ziel der Sprunglinks in der Fehlerzusammenfassung. */
const ID: Record<string, string> = {
  anrede: "pa",
  vorname: "pv",
  nachname: "pn",
  strasse: "ps",
  plz: "pp",
  ort: "po",
  geburtsdatum: "pg",
  email: "pe",
  telefon: "pt",
  eintritt: "pi",
  firmaId: "pf",
};

/** Reihenfolge und Beschriftung in der Zusammenfassung. */
const ORDER = [
  "firmaId",
  "anrede",
  "vorname",
  "nachname",
  "strasse",
  "plz",
  "ort",
  "geburtsdatum",
  "email",
  "telefon",
  "eintritt",
] as const;

const summaryLabel: Record<(typeof ORDER)[number], ReturnType<typeof t>> = {
  firmaId: t("personen.field.firma"),
  anrede: t("personen.field.anrede"),
  vorname: t("personen.field.vorname"),
  nachname: t("personen.field.nachname"),
  strasse: t("personen.field.strasseNr"),
  plz: t("personen.field.plz"),
  ort: t("personen.field.ort"),
  geburtsdatum: t("personen.field.geburtsdatum"),
  email: t("personen.field.emailAdresse"),
  telefon: t("personen.field.telefon"),
  eintritt: t("personen.field.eintritt"),
};

/** Person anlegen oder bearbeiten, mit ungespeicherten Eingaben (Design 3.4). */
export function PersonFormPage() {
  const svc = usePersonen();
  const tabs = useTabs();
  const tab = useCurrentTab();
  const toast = useToast();
  const id = tab.params["id"] ?? null;
  const loaded = useAsync(
    async () => (id ? fromPerson(await svc.getPerson(id)) : undefined),
    [svc, id],
  );
  if (loaded.error) return <LoadError onRetry={loaded.reload} />;
  if (id && !loaded.data) return <Loading />;
  const initial =
    loaded.data ?? empty(tab.params["typ"] === "firma" ? "firma" : "einzel", tab.params["firmaId"]);
  return (
    <Form
      key={id ?? "neu"}
      id={id}
      initial={initial}
      svc={svc}
      tab={tab}
      tabs={tabs}
      toast={toast}
    />
  );
}

function Form({
  id,
  initial,
  svc,
  tab,
  tabs,
  toast,
}: {
  id: string | null;
  initial: Values;
  svc: ReturnType<typeof usePersonen>;
  tab: ReturnType<typeof useCurrentTab>;
  tabs: ReturnType<typeof useTabs>;
  toast: ReturnType<typeof useToast>;
}) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const x = svc.features.personExtras;
  const isFirma = values.typ === "firma";

  const gruppen = useAsync(() => svc.listGruppen(), [svc]);
  const firmen = useAsync(
    () => (isFirma ? svc.listFirmen({}) : Promise.resolve(undefined)),
    [svc, isFirma],
  );
  useOnChange(firmen.reload);

  // Die Mitgliedsart umzuschalten ist noch keine Änderung der Angaben.
  const dirty = useMemo(
    () => JSON.stringify({ ...values, typ: "" }) !== JSON.stringify({ ...initial, typ: "" }),
    [values, initial],
  );
  useEffect(() => tab.setDirty(dirty && !saved), [tab, dirty, saved]);
  useCloseWhen(saved);

  const set = <K extends keyof Values>(key: K, value: Values[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => {
      if (!(key in e)) return e;
      return Object.fromEntries(Object.entries(e).filter(([k]) => k !== key));
    });
  };

  const validate = (v: Values): Record<string, string> => {
    const e: Record<string, string> = {};
    const need = (key: keyof Values & keyof typeof ID) => {
      if (!v[key].trim()) e[key] = t(`personen.err.${key}` as "personen.err.vorname");
    };
    if (v.typ === "firma") need("firmaId");
    else {
      need("anrede");
      need("strasse");
      need("plz");
      need("ort");
    }
    need("vorname");
    need("nachname");
    if (v.plz.trim() && !/^\d{4}$/.test(v.plz.trim())) e["plz"] = t("personen.error.plz");
    const birth = x ? dateError(v.geburtsdatum) : undefined;
    if (birth) e["geburtsdatum"] = birth;
    if (!v.email.trim()) e["email"] = t("personen.err.email");
    else if (!isEmail(v.email)) e["email"] = t("personen.error.email");
    if (v.telefon.trim() && !normalizePhone(v.telefon)) e["telefon"] = t("ui.phone.invalid");
    if (x && !v.eintritt.trim()) e["eintritt"] = t("personen.err.eintritt");
    else if (x) {
      const entry = dateError(v.eintritt, { shortYear: true });
      if (entry) e["eintritt"] = entry;
    }
    return e;
  };

  const toInput = (v: Values): PersonInput => {
    const opt = (s: string) => s.trim() || undefined;
    return {
      typ: v.typ,
      anrede: (opt(v.anrede) as Anrede | undefined) ?? undefined,
      vorname: v.vorname.trim(),
      nachname: v.nachname.trim(),
      email: opt(v.email),
      telefon: opt(v.telefon),
      strasse: v.typ === "einzel" ? opt(v.strasse) : undefined,
      plz: v.typ === "einzel" ? opt(v.plz) : undefined,
      ort: v.typ === "einzel" ? opt(v.ort) : undefined,
      geburtsdatum:
        x && v.typ === "einzel" && v.geburtsdatum.trim()
          ? (parseDate(v.geburtsdatum) ?? undefined)
          : undefined,
      eintritt: x ? (parseDate(v.eintritt) ?? undefined) : undefined,
      kanal: x ? ((opt(v.kanal) as Kanal | undefined) ?? undefined) : undefined,
      gruppeId: opt(v.gruppeId),
      notiz: opt(v.notiz),
      firmaId: v.typ === "firma" ? opt(v.firmaId) : undefined,
      funktion: v.typ === "firma" ? opt(v.funktion) : undefined,
    };
  };

  const save = async (): Promise<boolean> => {
    const found = validate(values);
    setErrors(found);
    setFailed(false);
    if (Object.keys(found).length > 0) {
      const first = ORDER.find((k) => k in found);
      if (first) focusField(ID[first] ?? "");
      return false;
    }
    if (submitting.current) return false;
    submitting.current = true;
    setBusy(true);
    try {
      const p = await svc.savePerson(id, toInput(values));
      notifyChange();
      toast.show({ tone: "ok", title: t("personen.form.saved") });
      if (!id) tabs.openTab("person", { key: p.id, params: { id: p.id }, title: p.name });
      setSaved(true);
      return true;
    } catch (e) {
      if (e instanceof FieldErrors) {
        setErrors(e.fields);
        const first = ORDER.find((k) => k in e.fields);
        if (first) focusField(ID[first] ?? "");
      } else setFailed(true);
      submitting.current = false;
      setBusy(false);
      return false;
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => tab.registerSave(() => saveRef.current()), [tab]);

  const listed = ORDER.filter((k) => k in errors);
  const reset = () => {
    setValues(initial);
    setErrors({});
    setFailed(false);
    toast.show({ tone: "ok", title: t("personen.form.discarded") });
  };

  const crumbEnd = id
    ? initial.vorname
      ? `${initial.vorname} ${initial.nachname}`
      : id
    : t("personen.form.crumb.neu");

  return (
    <div className="page">
      <PageHeader
        crumb={t("personen.form.crumb", { end: crumbEnd })}
        title={id ? t("personen.form.titleEdit") : t("personen.form.title")}
        status={
          dirty && !saved ? <Badge tone="warning">{t("personen.form.unsaved")}</Badge> : undefined
        }
        actions={
          <>
            {!id ? (
              <Button onClick={() => tab.close()}>{t("ui.cancel")}</Button>
            ) : (
              dirty && (
                <Button icon="undo" onClick={reset}>
                  {t("personen.form.discard")}
                </Button>
              )
            )}
            <Button variant="primary" icon="save" disabled={busy} onClick={() => void save()}>
              {t("personen.form.save")}
            </Button>
          </>
        }
      />
      <div className="pad-form">
        <ErrorSummary items={listed.map((k) => ({ id: ID[k] ?? k, label: summaryLabel[k] }))} />
        {failed && <Message tone="error" title={t("personen.form.saveFailed")} />}
        {!id && (
          <RadioGroup
            legend={t("personen.form.art")}
            name="mitgliedsart"
            inline
            value={values.typ}
            onChange={(v) => set("typ", v as Values["typ"])}
            options={[
              { value: "einzel", label: t("personen.typ.einzel") },
              { value: "firma", label: t("personen.typ.firma") },
            ]}
          />
        )}
      </div>
      <div className="form-cols">
        <div className="form-col">
          <Panel title={t("personen.form.panel.person")}>
            <div className="stack stack--lg">
              {isFirma && (
                <FormSelect
                  id={ID["firmaId"]}
                  label={t("personen.field.firma")}
                  required
                  value={values.firmaId}
                  error={errors["firmaId"]}
                  onChange={(e) => set("firmaId", e.target.value)}
                  options={[
                    { value: "", label: t("personen.form.choose") },
                    ...(firmen.data?.items ?? []).map((f) => ({ value: f.id, label: f.name })),
                  ]}
                />
              )}
              <FormSelect
                id={ID["anrede"]}
                label={t("personen.field.anrede")}
                required={!isFirma}
                value={values.anrede}
                error={errors["anrede"]}
                onChange={(e) => set("anrede", e.target.value)}
                options={[
                  { value: "", label: t("personen.form.choose") },
                  { value: "frau", label: t("personen.anrede.frau") },
                  { value: "herr", label: t("personen.anrede.herr") },
                  { value: "divers", label: t("personen.anrede.divers") },
                ]}
              />
              {isFirma && firmen.data && firmen.data.items.length === 0 && (
                <p className="muted">
                  {t("personen.form.firma.none")}{" "}
                  <button type="button" className="lk" onClick={() => tabs.openTab("firma-form")}>
                    {t("personen.firmen.new")}
                  </button>
                </p>
              )}
              <FormInput
                id={ID["vorname"]}
                label={t("personen.field.vorname")}
                required
                value={values.vorname}
                error={errors["vorname"]}
                onChange={(e) => set("vorname", e.target.value)}
              />
              <FormInput
                id={ID["nachname"]}
                label={t("personen.field.nachname")}
                required
                value={values.nachname}
                error={errors["nachname"]}
                onChange={(e) => set("nachname", e.target.value)}
              />
              {isFirma ? (
                <FormInput
                  label={t("personen.field.funktion")}
                  value={values.funktion}
                  onChange={(e) => set("funktion", e.target.value)}
                />
              ) : (
                <>
                  <FormInput
                    id={ID["strasse"]}
                    label={t("personen.field.strasseNr")}
                    required
                    value={values.strasse}
                    error={errors["strasse"]}
                    onChange={(e) => set("strasse", e.target.value)}
                  />
                  <div className="form-grid">
                    <FormInput
                      id={ID["plz"]}
                      label={t("personen.field.plz")}
                      required
                      inputMode="numeric"
                      value={values.plz}
                      error={errors["plz"]}
                      onChange={(e) => set("plz", e.target.value)}
                    />
                    <FormInput
                      id={ID["ort"]}
                      label={t("personen.field.ort")}
                      required
                      value={values.ort}
                      error={errors["ort"]}
                      onChange={(e) => set("ort", e.target.value)}
                    />
                  </div>
                  {x && (
                    <FormInput
                      id={ID["geburtsdatum"]}
                      label={t("personen.field.geburtsdatum")}
                      value={values.geburtsdatum}
                      placeholder={t("personen.placeholder.datum")}
                      error={errors["geburtsdatum"]}
                      onChange={(e) => set("geburtsdatum", e.target.value)}
                    />
                  )}
                </>
              )}
            </div>
          </Panel>
        </div>
        <div className="form-col">
          <Panel title={t("personen.form.panel.kontakt")}>
            <div className="stack stack--lg">
              <FormInput
                id={ID["email"]}
                label={t("personen.field.emailAdresse")}
                required
                type="email"
                value={values.email}
                error={errors["email"]}
                onChange={(e) => set("email", e.target.value)}
              />
              <FormInput
                id={ID["telefon"]}
                label={t("personen.field.telefon")}
                type="tel"
                value={values.telefon}
                error={errors["telefon"]}
                onChange={(e) => set("telefon", e.target.value)}
              />
              {x && (
                <FormInput
                  id={ID["eintritt"]}
                  label={t("personen.field.eintritt")}
                  required
                  value={values.eintritt}
                  placeholder={t("personen.placeholder.datum")}
                  error={errors["eintritt"]}
                  onChange={(e) => set("eintritt", e.target.value)}
                />
              )}
              {x && (
                <FormSelect
                  label={t("personen.field.kanal")}
                  value={values.kanal}
                  onChange={(e) => set("kanal", e.target.value)}
                  options={[
                    { value: "", label: t("personen.kanal.keine") },
                    { value: "email", label: t("personen.kanal.email") },
                    { value: "post", label: t("personen.kanal.post") },
                  ]}
                />
              )}
              <FormSelect
                label={t("personen.col.gruppe")}
                value={values.gruppeId}
                onChange={(e) => set("gruppeId", e.target.value)}
                options={[
                  { value: "", label: t("personen.form.gruppe.keine") },
                  ...(gruppen.data ?? []).map((g) => ({ value: g.id, label: g.name })),
                ]}
              />
              {x && (
                <FormInput
                  label={t("personen.field.nr")}
                  readOnly
                  value={values.nr || t("personen.form.nr.new")}
                />
              )}
              <FormTextArea
                label={t("personen.detail.bemerkung")}
                value={values.notiz}
                onChange={(e) => set("notiz", e.target.value)}
              />
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

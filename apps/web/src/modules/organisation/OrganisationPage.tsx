import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../../auth/auth";
import { t, type TextKey } from "../../i18n";
import {
  Button,
  DataTable,
  ErrorSummary,
  Message,
  PageHeader,
  PageTabs,
  Panel,
  Select,
  Switch,
  TextField,
  focusField,
  useToast,
  type Column,
} from "../../ui";
import { IconBadge, LoadError, req, useLoad } from "./common";
import {
  ApiError,
  OrgFieldErrors,
  type Closing,
  type Features,
  type LogoInfo,
  type OrgData,
  type OrgErrors,
  type OrgState,
} from "./model";
import { useSettings, type SettingsService } from "./service";
import { checkLogo, currentFiscalYear, LOGO_MAX_BYTES, validateOrg } from "./validate";

type Update = (patch: Partial<OrgData>) => void;

interface TabProps {
  form: OrgData;
  errors: OrgErrors;
  update: Update;
  features: Features;
}

/** Tab, in dem ein Feld steht (springt beim Speichern zum ersten Fehler). */
const TAB_OF: Record<keyof OrgData, string> = {
  name: "master",
  legalForm: "master",
  street: "master",
  zip: "master",
  city: "master",
  phone: "master",
  email: "master",
  website: "master",
  vatNumber: "master",
  uid: "master",
  senderName: "logo",
  replyTo: "logo",
  footer: "logo",
  accountHolder: "bank",
  bankName: "bank",
  qrIban: "bank",
  creditAccount: "bank",
  paymentDays: "bank",
  fiscalStart: "bank",
  fiscalEnd: "bank",
  closing: "bank",
  sammelrechnung: "modules",
  mail: "modules",
  kalender: "modules",
};

/** Beschriftung der Felder in der Fehlerzusammenfassung. */
const FIELD_LABEL: Partial<Record<keyof OrgData, TextKey>> = {
  name: "settings.org.name",
  legalForm: "settings.org.legalForm",
  street: "settings.org.street",
  zip: "settings.org.zip",
  city: "settings.org.city",
  phone: "settings.org.phone",
  email: "settings.org.email",
  website: "settings.org.website",
  vatNumber: "settings.org.vat",
  uid: "settings.org.uid",
  senderName: "settings.sender.name",
  replyTo: "settings.sender.replyTo",
  footer: "settings.sender.footer",
  accountHolder: "settings.bank.holder",
  bankName: "settings.bank.bank",
  qrIban: "settings.bank.qrIban",
  creditAccount: "settings.bank.credit",
  paymentDays: "settings.bank.days",
  fiscalStart: "settings.fiscal.start",
  fiscalEnd: "settings.fiscal.end",
};

const fieldId = (key: keyof OrgData) => `org-${key}`;

/** Reihenfolge in der Zusammenfassung, wie die Felder in den Tabs stehen. */
const ERROR_ORDER = Object.keys(FIELD_LABEL) as (keyof OrgData)[];

const CLOSINGS: { value: Closing; label: string }[] = [
  { value: "monthly", label: t("settings.org.closing.monthly") },
  { value: "quarterly", label: t("settings.org.closing.quarterly") },
  { value: "yearly", label: t("settings.org.closing.yearly") },
];
/** Feste Auswahl der API (`LEGAL_FORMS` in `@stammbuch/shared`). */
const LEGAL_FORMS = [
  { value: "verein", label: t("settings.org.legalForm.verein") },
  { value: "stiftung", label: t("settings.org.legalForm.stiftung") },
  { value: "genossenschaft", label: t("settings.org.legalForm.genossenschaft") },
  { value: "gmbh", label: t("settings.org.legalForm.gmbh") },
  { value: "ag", label: t("settings.org.legalForm.ag") },
  { value: "einzelunternehmen", label: t("settings.org.legalForm.einzelunternehmen") },
  { value: "andere", label: t("settings.org.legalForm.andere") },
];

/** Solange nichts gewählt ist, steht «Bitte wählen» vorn: sonst zeigte die Auswahl einen Wert, den es nicht gibt. */
const withChoose = (value: string, options: { value: string; label: string }[]) =>
  value ? options : [{ value: "", label: t("settings.org.choose") }, ...options];

function Cols({ children }: { children: ReactNode }) {
  return <div className="set__cols">{children}</div>;
}

function Stack({ children }: { children: ReactNode }) {
  return <div className="set__stack">{children}</div>;
}

/** PLZ und Ort nebeneinander (Board: 120 px und Rest). */
function ZipCity({ form, errors, update, ids }: TabProps & { ids: [string, string] }) {
  return (
    <div className="set__pair">
      <TextField
        id={ids[0]}
        label={req(t("settings.org.zip"))}
        value={form.zip}
        error={errors.zip}
        inputMode="numeric"
        maxLength={4}
        autoComplete="postal-code"
        aria-required="true"
        onChange={(e) => update({ zip: e.target.value })}
      />
      <TextField
        id={ids[1]}
        label={req(t("settings.org.city"))}
        value={form.city}
        error={errors.city}
        aria-required="true"
        onChange={(e) => update({ city: e.target.value })}
      />
    </div>
  );
}

function MasterTab(props: TabProps) {
  const { form, errors, update, features } = props;
  return (
    <>
      <Cols>
        <div className="set__col">
          <Panel title={t("settings.org.club")}>
            <Stack>
              <TextField
                id="org-name"
                label={req(t("settings.org.name"))}
                value={form.name}
                error={errors.name}
                aria-required="true"
                onChange={(e) => update({ name: e.target.value })}
              />
              {features.legalForm && (
                <Select
                  id="org-legalForm"
                  label={req(t("settings.org.legalForm"))}
                  value={form.legalForm}
                  options={withChoose(form.legalForm, LEGAL_FORMS)}
                  error={errors.legalForm}
                  aria-required="true"
                  onChange={(e) => update({ legalForm: e.target.value })}
                />
              )}
            </Stack>
          </Panel>
          <Panel title={t("settings.org.address")}>
            <Stack>
              <TextField
                id="org-street"
                label={req(t("settings.org.street"))}
                value={form.street}
                error={errors.street}
                autoComplete="address-line1"
                aria-required="true"
                onChange={(e) => update({ street: e.target.value })}
              />
              <ZipCity {...props} ids={["org-zip", "org-city"]} />
            </Stack>
          </Panel>
        </div>
        <div className="set__col">
          <Panel title={t("settings.org.contact")}>
            <Stack>
              <TextField
                id="org-phone"
                label={t("settings.org.phone")}
                placeholder={t("settings.org.phoneHint")}
                value={form.phone}
                error={errors.phone}
                onChange={(e) => update({ phone: e.target.value })}
              />
              <TextField
                id="org-email"
                label={req(t("settings.org.email"))}
                value={form.email}
                error={errors.email}
                autoComplete="email"
                aria-required="true"
                onChange={(e) => update({ email: e.target.value })}
              />
              <TextField
                id="org-website"
                label={t("settings.org.website")}
                value={form.website}
                error={errors.website}
                onChange={(e) => update({ website: e.target.value })}
              />
            </Stack>
          </Panel>
          <Panel title={t("settings.org.taxes")}>
            <Stack>
              <TextField
                id="org-vatNumber"
                label={req(t("settings.org.vat"))}
                placeholder={t("settings.org.vatHint")}
                value={form.vatNumber}
                error={errors.vatNumber}
                aria-required="true"
                onChange={(e) => update({ vatNumber: e.target.value })}
              />
              <TextField
                id="org-uid"
                label={t("settings.org.uid")}
                placeholder={t("settings.org.uidPlaceholder")}
                value={form.uid}
                error={errors.uid}
                onChange={(e) => update({ uid: e.target.value })}
              />
            </Stack>
          </Panel>
        </div>
      </Cols>
    </>
  );
}

function LogoTab(
  props: TabProps & {
    service: SettingsService;
    logo: LogoInfo | null;
    onLogo: (logo: LogoInfo | null) => void;
  },
) {
  const { form, errors, update, service, logo, onLogo } = props;
  const file = useRef<HTMLInputElement>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (picked: File | undefined) => {
    if (!picked) return;
    setLogoError(null);
    const problem = await checkLogo(picked);
    if (problem) {
      setLogoError(t(`settings.logo.error.${problem}`));
      return;
    }
    setBusy(true);
    try {
      await service.uploadLogo(picked);
      onLogo({ mime: picked.type, size: picked.size, updatedAt: String(Date.now()) });
    } catch {
      setLogoError(t("settings.logo.error.failed"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setLogoError(null);
    setBusy(true);
    try {
      await service.removeLogo();
      onLogo(null);
    } catch {
      setLogoError(t("settings.logo.error.failed"));
    } finally {
      setBusy(false);
    }
  };

  const logoImg = logo && (
    <img
      className="set__logo"
      src={service.logoUrl(logo.updatedAt)}
      alt={t("settings.logo.alt", { name: form.name })}
    />
  );
  const address = [form.street, [form.zip, form.city].filter(Boolean).join(" ")].filter(Boolean);

  return (
    <>
      <Cols>
        <div className="set__col">
          <Panel title={t("settings.logo.title")}>
            <div className="set__logorow">
              <div className="set__paper set__logobox">
                {logoImg}
                <b>{form.name}</b>
              </div>
              <div className="set__stack">
                <input
                  name="file"
                  ref={file}
                  type="file"
                  className="visually-hidden"
                  tabIndex={-1}
                  aria-label={t("settings.logo.upload")}
                  accept="image/png,image/jpeg"
                  onChange={(e) => {
                    void upload(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <Button icon="upload" disabled={busy} onClick={() => file.current?.click()}>
                  {t("settings.logo.upload")}
                </Button>
                <Button icon="trash" disabled={busy || !logo} onClick={() => void remove()}>
                  {t("settings.logo.remove")}
                </Button>
              </div>
            </div>
            <span className="muted set__logohint">
              {t("settings.logo.hint", { max: LOGO_MAX_BYTES / 1024 })}
            </span>
            {logoError && (
              <div className="set__logoerr">
                <Message tone="error">{logoError}</Message>
              </div>
            )}
          </Panel>
          <Panel title={t("settings.sender.title")}>
            <Stack>
              <TextField
                id="org-senderName"
                label={req(t("settings.sender.name"))}
                value={form.senderName}
                error={errors.senderName}
                aria-required="true"
                onChange={(e) => update({ senderName: e.target.value })}
              />
              <TextField
                id="org-replyTo"
                label={req(t("settings.sender.replyTo"))}
                value={form.replyTo}
                error={errors.replyTo}
                autoComplete="email"
                aria-required="true"
                onChange={(e) => update({ replyTo: e.target.value })}
              />
              <TextField
                id="sender-street"
                label={req(t("settings.org.street"))}
                value={form.street}
                error={errors.street}
                aria-required="true"
                onChange={(e) => update({ street: e.target.value })}
              />
              <ZipCity {...props} ids={["sender-zip", "sender-city"]} />
              <TextField
                id="org-footer"
                label={t("settings.sender.footer")}
                value={form.footer}
                error={errors.footer}
                onChange={(e) => update({ footer: e.target.value })}
              />
            </Stack>
          </Panel>
        </div>
        <div className="set__col">
          <section className="set__preview" aria-labelledby="set-preview">
            <h2 id="set-preview">{t("settings.preview.title")}</h2>
            <div className="set__desk">
              <div className="set__paper set__letter">
                <div className="set__letterhead">
                  {logoImg ?? <span />}
                  <div className="set__sender set__mut">
                    {[form.senderName, ...address].map((line, i) => (
                      <span key={i}>
                        {i > 0 && <br />}
                        {line}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="set__rule" />
                <div className="set__invno set__mut">{t("settings.preview.invoice")}</div>
                <div className="set__recipient">
                  {t("settings.preview.name")}
                  <br />
                  {t("settings.preview.street")}
                  <br />
                  {t("settings.preview.city")}
                </div>
                <div className="set__letterfoot set__mut">{form.footer}</div>
              </div>
            </div>
          </section>
        </div>
      </Cols>
    </>
  );
}

function BankTab({
  form,
  errors,
  update,
  features,
  creditAccounts,
  now,
}: TabProps & {
  creditAccounts: OrgState["creditAccounts"];
  now: number;
}) {
  return (
    <>
      <Cols>
        <div className="set__col">
          <Panel title={t("settings.bank.title")}>
            <Stack>
              {features.accountHolder && (
                <TextField
                  id="org-accountHolder"
                  label={req(t("settings.bank.holder"))}
                  value={form.accountHolder}
                  error={errors.accountHolder}
                  aria-required="true"
                  onChange={(e) => update({ accountHolder: e.target.value })}
                />
              )}
              <TextField
                id="org-bankName"
                label={req(t("settings.bank.bank"))}
                value={form.bankName}
                error={errors.bankName}
                aria-required="true"
                onChange={(e) => update({ bankName: e.target.value })}
              />
              <TextField
                mono
                id="org-qrIban"
                label={req(t("settings.bank.qrIban"))}
                placeholder={t("settings.bank.qrIbanPlaceholder")}
                value={form.qrIban}
                error={errors.qrIban}
                aria-required="true"
                onChange={(e) => update({ qrIban: e.target.value })}
              />
              {features.creditAccount && (
                <Select
                  id="org-creditAccount"
                  label={req(t("settings.bank.credit"))}
                  value={form.creditAccount}
                  options={withChoose(form.creditAccount, creditAccounts)}
                  error={errors.creditAccount}
                  aria-required="true"
                  onChange={(e) => update({ creditAccount: e.target.value })}
                />
              )}
              {features.paymentDays && (
                <TextField
                  mono
                  id="org-paymentDays"
                  label={req(t("settings.bank.days"))}
                  value={form.paymentDays}
                  error={errors.paymentDays}
                  inputMode="numeric"
                  aria-required="true"
                  onChange={(e) => update({ paymentDays: e.target.value })}
                />
              )}
            </Stack>
          </Panel>
        </div>
        <div className="set__col">
          <Panel title={t("settings.fiscal.title")}>
            <Stack>
              <div className="set__pair2">
                <TextField
                  id="org-fiscalStart"
                  label={req(t("settings.fiscal.start"))}
                  placeholder={t("settings.fiscal.format")}
                  value={form.fiscalStart}
                  error={errors.fiscalStart}
                  aria-required="true"
                  onChange={(e) => update({ fiscalStart: e.target.value })}
                />
                <TextField
                  id="org-fiscalEnd"
                  label={req(t("settings.fiscal.end"))}
                  placeholder={t("settings.fiscal.format")}
                  value={form.fiscalEnd}
                  error={errors.fiscalEnd}
                  aria-required="true"
                  onChange={(e) => update({ fiscalEnd: e.target.value })}
                />
              </div>
              <TextField
                label={t("settings.fiscal.current")}
                value={currentFiscalYear(form.fiscalStart, now)}
                readOnly
              />
              {features.closing && (
                <Select
                  label={req(t("settings.fiscal.closing"))}
                  value={form.closing}
                  options={CLOSINGS}
                  aria-required="true"
                  onChange={(e) => update({ closing: e.target.value as Closing })}
                />
              )}
            </Stack>
          </Panel>
        </div>
      </Cols>
    </>
  );
}

interface ModuleRow {
  key: "sammelrechnung" | "mail" | "kalender" | null;
  name: string;
  content: string;
}

const MODULE_ROWS: ModuleRow[] = [
  { key: null, name: t("settings.modules.people"), content: t("settings.modules.peopleText") },
  { key: null, name: t("settings.modules.invoices"), content: t("settings.modules.invoicesText") },
  {
    key: null,
    name: t("settings.modules.accounting"),
    content: t("settings.modules.accountingText"),
  },
  { key: null, name: t("settings.modules.reports"), content: t("settings.modules.reportsText") },
  {
    key: "sammelrechnung",
    name: t("settings.modules.bulk"),
    content: t("settings.modules.bulkText"),
  },
  { key: "mail", name: t("settings.modules.mail"), content: t("settings.modules.mailText") },
  {
    key: "kalender",
    name: t("settings.modules.calendar"),
    content: t("settings.modules.calendarText"),
  },
];

function ModulesTab({ form, update }: TabProps) {
  const columns: Column<ModuleRow>[] = [
    {
      key: "name",
      header: t("settings.modules.col.module"),
      width: "195px",
      nowrap: true,
      cell: (r) => <b>{r.name}</b>,
    },
    { key: "content", header: t("settings.modules.col.content"), cell: (r) => r.content },
    {
      key: "status",
      header: t("settings.modules.col.status"),
      width: "140px",
      nowrap: true,
      cell: (r) =>
        r.key === null ? (
          <IconBadge tone="neutral" icon="lock">
            {t("settings.modules.always")}
          </IconBadge>
        ) : (
          <Switch
            label={t("settings.modules.switch", { name: r.name })}
            checked={form[r.key]}
            text={form[r.key] ? t("settings.modules.on") : t("settings.modules.off")}
            onChange={(on) => update({ [r.key!]: on })}
          />
        ),
    },
  ];
  return (
    <>
      <div className="set__block">
        <Panel title={t("settings.modules.title")} flush>
          <DataTable
            label={t("settings.modules.label")}
            columns={columns}
            rows={MODULE_ROWS}
            rowKey={(r) => r.name}
          />
        </Panel>
      </div>
    </>
  );
}

interface OrganisationPageProps {
  onDirtyChange: (dirty: boolean) => void;
  /** Gibt dem Rahmen die Speicherfunktion (Strg+S, «Speichern und schliessen»). */
  registerSave: (save: (() => Promise<boolean>) | null) => void;
}

/** Einstellungen / Organisation (Boards 9.1 bis 9.4): vier Tabs, ein gemeinsames Formular. */
export function OrganisationPage({ onDirtyChange, registerSave }: OrganisationPageProps) {
  const service = useSettings();
  const { now } = useAuth();
  const toast = useToast();
  const [state, reload, setLoaded] = useLoad(service.loadOrganisation.bind(service), [service]);
  const [form, setForm] = useState<OrgData | null>(null);
  const [base, setBase] = useState<OrgData | null>(null);
  const [logo, setLogo] = useState<LogoInfo | null>(null);
  const [errors, setErrors] = useState<OrgErrors>({});
  const [failure, setFailure] = useState<{ title: string; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState("master");

  useEffect(() => {
    if (state.status !== "ready") return;
    const d = state.data.data;
    // Absendername und Antwortadresse stammen aus den Stammdaten, solange nichts anderes gespeichert ist.
    const prefilled = { ...d, senderName: d.senderName || d.name, replyTo: d.replyTo || d.email };
    setForm(prefilled);
    setBase(prefilled);
    setLogo(state.data.logo);
  }, [state]);

  const dirty = Boolean(form && base && JSON.stringify(form) !== JSON.stringify(base));
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const formRef = useRef(form);
  formRef.current = form;
  const busy = useRef(false);

  /** Springt zum ersten fehlerhaften Feld, auch in einem anderen Tab. `true`, wenn es Fehler gibt. */
  const showErrors = (found: OrgErrors): boolean => {
    const first = ERROR_ORDER.find((k) => found[k]);
    if (!first) return false;
    setTab(TAB_OF[first]);
    setTimeout(() => focusField(fieldId(first)), 0);
    return true;
  };

  const save = async (): Promise<boolean> => {
    const current = formRef.current;
    if (!current || busy.current) return false;
    const found = validateOrg(current, service.features);
    setErrors(found);
    setFailure(null);
    if (showErrors(found)) return false;
    busy.current = true;
    setSaving(true);
    setFailure(null);
    try {
      await service.saveOrganisation(current);
      setBase(current);
      toast.show({ tone: "ok", title: t("settings.saved") });
      return true;
    } catch (e) {
      if (e instanceof OrgFieldErrors) {
        setErrors(e.errors);
        showErrors(e.errors);
        return false;
      }
      const licence = e instanceof ApiError && e.code === "LICENCE_READ_ONLY";
      setFailure({
        title: t("settings.saveFailedTitle"),
        text: t(licence ? "settings.saveFailedLicence" : "settings.saveFailedText"),
      });
      return false;
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    registerSave(() => saveRef.current());
    return () => registerSave(null);
  }, [registerSave]);

  const tabs = useMemo(() => {
    if (!form) return [];
    const common: TabProps = {
      form,
      errors,
      features: service.features,
      update: (patch) => {
        setForm((f) => {
          if (!f) return f;
          const next = { ...f, ...patch };
          // Solange der Absender den Stammdaten entspricht, folgt er ihren Änderungen.
          if (patch.name && f.senderName === f.name) next.senderName = patch.name;
          if (patch.email && f.replyTo === f.email) next.replyTo = patch.email;
          return next;
        });
        setErrors((e) => {
          const next = { ...e };
          for (const k of Object.keys(patch)) delete next[k as keyof OrgData];
          return next;
        });
      },
    };
    return [
      { id: "master", label: t("settings.org.tab.master"), content: <MasterTab {...common} /> },
      {
        id: "logo",
        label: t("settings.org.tab.logo"),
        content: (
          <LogoTab
            {...common}
            service={service}
            logo={logo}
            onLogo={(next) => {
              setLogo(next);
              if (state.status === "ready") setLoaded({ ...state.data, logo: next });
            }}
          />
        ),
      },
      {
        id: "bank",
        label: t("settings.org.tab.bank"),
        content: (
          <BankTab
            {...common}
            now={now}
            creditAccounts={state.status === "ready" ? state.data.creditAccounts : []}
          />
        ),
      },
      { id: "modules", label: t("settings.org.tab.modules"), content: <ModulesTab {...common} /> },
    ];
  }, [form, errors, service, logo, now, state, setLoaded]);

  const summary = ERROR_ORDER.filter((k) => errors[k]).map((k) => ({
    id: fieldId(k),
    label: t(FIELD_LABEL[k]!),
    onSelect: () => setTab(TAB_OF[k]),
  }));

  const tabLabel = t(`settings.org.tab.${tab as "master" | "logo" | "bank" | "modules"}`);

  return (
    <div className="page">
      <PageHeader
        crumb={`${t("settings.title")} / ${t("settings.nav.organisation")} / ${tabLabel}`}
        title={t("settings.nav.organisation")}
        actions={
          <Button
            variant="primary"
            icon="save"
            disabled={saving || !form}
            onClick={() => void save()}
          >
            {t("settings.save")}
          </Button>
        }
      />
      {state.status === "error" ? (
        <LoadError state={state} onRetry={reload} />
      ) : !form ? (
        <p className="set__sub muted">{t("settings.loading")}</p>
      ) : (
        <>
          {failure && (
            <div className="set__alert">
              <Message tone="error" title={failure.title}>
                {failure.text}
              </Message>
            </div>
          )}
          {summary.length > 0 && (
            <div className="set__alert">
              <ErrorSummary items={summary} />
            </div>
          )}
          <PageTabs
            label={t("settings.nav.organisation")}
            tabs={tabs}
            value={tab}
            onChange={setTab}
          />
        </>
      )}
    </div>
  );
}

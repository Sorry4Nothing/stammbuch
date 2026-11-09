import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useAuth } from "../../auth/auth";
import { t } from "../../i18n";
import {
  Badge,
  Button,
  Checkbox,
  Icon,
  Message,
  PageHeader,
  Panel,
  TextField,
  useToast,
} from "../../ui";
import { useChefAdminService, useChefNav, useRegisterSave } from "./context";
import { formatDate, parseDate, refPreview, today } from "./format";
import { ApiError, LICENCE_MODULES, type LicenceModule } from "./model";
import { req } from "./shared";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const YEAR_DAYS = 365;

interface Form {
  name: string;
  first: string;
  last: string;
  email: string;
  start: string;
  end: string;
  modules: LicenceModule[];
}

type Errors = Partial<Record<"name" | "first" | "last" | "email" | "start" | "end", string>>;

/** Standard: Lizenz ab heute für ein Jahr, alle Module an. */
function initial(now: number): Form {
  const start = today(now);
  const end = new Date(Date.parse(`${start}T00:00:00Z`) + (YEAR_DAYS - 1) * 86_400_000);
  return {
    name: "",
    first: "",
    last: "",
    email: "",
    start: formatDate(start),
    end: formatDate(end.toISOString().slice(0, 10)),
    modules: [...LICENCE_MODULES],
  };
}

/** Kunde anlegen mit Einladungsvorschau (Design 10.2). Das Token der Einladung sieht der Anbieter nie. */
export function CustomerCreatePage() {
  const service = useChefAdminService();
  const { go } = useChefNav();
  const { session, now } = useAuth();
  const toast = useToast();
  const start = useMemo(() => initial(now), []); // nur der Anfangswert
  const [form, setForm] = useState<Form>(start);
  const [errors, setErrors] = useState<Errors>({});
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const dirty = JSON.stringify(form) !== JSON.stringify(start);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  // Ungespeicherte Eingaben: der Browser warnt beim Neuladen oder Schliessen.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const next: Errors = {};
    const name = form.name.trim();
    const first = form.first.trim();
    const last = form.last.trim();
    const email = form.email.trim();
    const from = parseDate(form.start);
    const until = parseDate(form.end);
    if (!name) next.name = t("chef.create.err.name");
    if (!first) next.first = t("chef.create.err.first");
    if (!last) next.last = t("chef.create.err.last");
    if (!EMAIL.test(email)) next.email = t("chef.create.err.email");
    if (!from) next.start = t("chef.create.err.date");
    if (!until) next.end = t("chef.create.err.date");
    else if (from && until <= from) next.end = t("chef.create.err.range");
    setErrors(next);
    setAlert(null);
    if (Object.keys(next).length > 0 || !from || !until) return;

    setBusy(true);
    try {
      const customer = await service.createCustomer({
        name,
        firstName: first,
        lastName: last,
        email,
        licenceStart: from,
        licenceUntil: until,
        modules: form.modules,
      });
      toast.show({ tone: "ok", title: t("chef.create.saved", { name: customer.name, email }) });
      go({ name: "customer", id: customer.id });
    } catch (err) {
      setAlert(
        err instanceof ApiError && err.status === 409
          ? t("chef.create.conflict")
          : t("chef.create.failedText"),
      );
      setBusy(false);
    }
  };
  useRegisterSave(() => void submit());

  const fullName = `${form.first} ${form.last}`.trim();
  const ref = refPreview(form.name);

  return (
    <form onSubmit={submit} noValidate>
      <PageHeader
        crumb={`${t("chef.crumb.root")} / ${t("chef.crumb.customers")} / ${t("chef.crumb.new")}`}
        title={t("chef.create.title")}
        status={
          dirty ? (
            <Badge tone="warning">
              <Icon name="edit" size={12} />
              {t("chef.create.dirty")}
            </Badge>
          ) : undefined
        }
        actions={
          <>
            <Button onClick={() => go({ name: "customers" })}>{t("ui.cancel")}</Button>
            <Button type="submit" variant="primary" icon="send" disabled={busy}>
              {t("chef.create.submit")}
            </Button>
          </>
        }
      />
      <div className="ca-split">
        <div className="ca-split__main">
          {alert && (
            <Message tone="error" title={t("chef.create.failedTitle")}>
              {alert}
            </Message>
          )}
          <Panel title={t("chef.create.org")}>
            <div className="grid ca-grid2">
              <TextField
                label={req(t("chef.create.name"))}
                aria-required="true"
                value={form.name}
                error={errors.name}
                maxLength={120}
                onChange={(e) => set("name", e.target.value)}
              />
              <TextField label={t("chef.create.ref")} readOnly value={ref} />
            </div>
          </Panel>
          <Panel title={t("chef.create.user")}>
            <div className="ca-stack">
              <div className="grid ca-grid2">
                <TextField
                  label={req(t("chef.create.first"))}
                  aria-required="true"
                  autoComplete="off"
                  value={form.first}
                  error={errors.first}
                  maxLength={120}
                  onChange={(e) => set("first", e.target.value)}
                />
                <TextField
                  label={req(t("chef.create.last"))}
                  aria-required="true"
                  autoComplete="off"
                  value={form.last}
                  error={errors.last}
                  maxLength={120}
                  onChange={(e) => set("last", e.target.value)}
                />
              </div>
              <TextField
                label={req(t("chef.create.email"))}
                aria-required="true"
                type="email"
                autoComplete="off"
                value={form.email}
                error={errors.email}
                maxLength={254}
                onChange={(e) => set("email", e.target.value)}
              />
            </div>
          </Panel>
          <Panel title={t("chef.create.licence")}>
            <div className="ca-stack">
              <div className="grid ca-grid2">
                <TextField
                  label={req(t("chef.create.start"))}
                  aria-required="true"
                  inputMode="numeric"
                  value={form.start}
                  error={errors.start}
                  placeholder={t("chef.create.datePlaceholder")}
                  onChange={(e) => set("start", e.target.value)}
                />
                <TextField
                  label={req(t("chef.create.end"))}
                  aria-required="true"
                  inputMode="numeric"
                  value={form.end}
                  error={errors.end}
                  placeholder={t("chef.create.datePlaceholder")}
                  onChange={(e) => set("end", e.target.value)}
                />
              </div>
              <fieldset className="ca-fieldset ca-stack ca-stack--tight">
                <legend>{t("chef.create.modules")}</legend>
                <div className="ca-modules">
                  {LICENCE_MODULES.map((m) => (
                    <Checkbox
                      key={m}
                      label={t(`chef.module.${m}`)}
                      checked={form.modules.includes(m)}
                      onChange={(e) =>
                        set(
                          "modules",
                          LICENCE_MODULES.filter((x) =>
                            x === m ? e.target.checked : form.modules.includes(x),
                          ),
                        )
                      }
                    />
                  ))}
                </div>
                <span className="ca-note">{t("chef.create.modulesNote")}</span>
              </fieldset>
            </div>
          </Panel>
        </div>
        <div className="ca-split__side ca-side--500">
          <Panel title={t("chef.preview.title")} flush>
            <div className="ca-desk">
              <div className="ca-paper">
                <div className="ca-paper__head">
                  {t("chef.preview.from", { from: session?.email ?? "" })}
                  <br />
                  {t("chef.preview.to", { to: form.email.trim() })}
                  <br />
                  <b>{t("chef.preview.subject")}</b>
                </div>
                <div className="ca-paper__rule" />
                <p>{t("chef.preview.greeting", { name: fullName })}</p>
                <p>{t("chef.preview.body1", { org: form.name.trim(), ref })}</p>
                <p>{t("chef.preview.body2")}</p>
                <p>
                  {/* Das echte Token entsteht erst beim Versand und bleibt dem Anbieter verborgen. */}
                  <span className="ca-paper__link">{`${window.location.origin}/einladung#XXXX-XXXX`}</span>
                </p>
                <p>
                  {t("chef.preview.closing")}
                  <br />
                  {t("chef.preview.sender")}
                </p>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </form>
  );
}

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { AuthLayout } from "../auth/AuthLayout";
import { orgName, privacyUrl } from "../config";
import { t, tp, type TextKey } from "../i18n";
import { Button, Checkbox, Icon, Message, RadioGroup, TextField } from "../ui";
import { formatStamp } from "./format";
import {
  createHttpRegistrationService,
  type RegistrationInput,
  type RegistrationService,
} from "./publicService";

type Kind = "person" | "firma";
type Values = Record<
  | "firstName"
  | "lastName"
  | "street"
  | "zip"
  | "city"
  | "email"
  | "birth"
  | "company"
  | "uid"
  | "mwst"
  | "contact"
  | "phone",
  string
>;
type Errors = Partial<Record<keyof Values | "privacy", string>>;

const empty: Values = {
  firstName: "",
  lastName: "",
  street: "",
  zip: "",
  city: "",
  email: "",
  birth: "",
  company: "",
  uid: "",
  mwst: "",
  contact: "",
  phone: "",
};

const defaultService = createHttpRegistrationService();

const filled = (v: string) => v.trim() !== "";

function validDate(v: string): boolean {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(v.trim());
  if (!m) return false;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
}

/** Prüft nur Form und Pflicht; die Prüfziffern und alles Weitere entscheidet der Server (SR-20). */
export function validate(kind: Kind, v: Values, privacy: boolean): Errors {
  const e: Errors = {};
  const need = (key: keyof Values, msg: TextKey) => {
    if (!filled(v[key])) e[key] = t(msg);
  };
  if (kind === "person") {
    need("firstName", "public.register.firstNameRequired");
    need("lastName", "public.register.lastNameRequired");
  } else {
    need("company", "public.register.companyRequired");
    if (!/^CHE[-\s]?\d{3}[.\s]?\d{3}[.\s]?\d{3}$/i.test(v.uid.trim())) {
      e.uid = t("public.register.uidInvalid");
    }
    if (
      filled(v.mwst) &&
      !/^CHE[-\s]?\d{3}[.\s]?\d{3}[.\s]?\d{3}\s*(MWST|TVA|IVA)$/i.test(v.mwst.trim())
    ) {
      e.mwst = t("public.register.mwstInvalid");
    }
    need("contact", "public.register.contactRequired");
    if (filled(v.phone) && !/^(?=(?:\D*\d){8,})[+\d\s().\-/]{8,40}$/.test(v.phone.trim())) {
      e.phone = t("public.register.phoneInvalid");
    }
  }
  need("street", "public.register.streetRequired");
  if (!/^[1-9]\d{3}$/.test(v.zip.trim())) e.zip = t("public.register.zipInvalid");
  need("city", "public.register.cityRequired");
  if (!filled(v.email)) e.email = t("public.register.emailRequired");
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) {
    e.email = t("public.register.emailFormat");
  }
  if (kind === "person" && filled(v.birth) && !validDate(v.birth)) {
    e.birth = t("public.register.birthFormat");
  }
  if (!privacy) e.privacy = t("public.register.privacyRequired");
  return e;
}

interface Receipt {
  name: string;
  email: string;
  at: Date;
  reference?: string;
}

/**
 * Öffentliche Registrierung (Design 1.7 Person, 1.8 Firma, 1.9 Bestätigung) unter `/registrierung/:kunde`.
 * Person und Firma wechseln im selben Formular. Gemeinsame Felder behalten ihren Wert.
 */
export function RegisterPage({ service = defaultService }: { service?: RegistrationService }) {
  const { kunde = "" } = useParams();
  const [kind, setKind] = useState<Kind>("person");
  const [values, setValues] = useState<Values>(empty);
  const [privacy, setPrivacy] = useState(false);
  const [website, setWebsite] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [alert, setAlert] = useState<{ title: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [unknown, setUnknown] = useState(false);
  const formToken = useRef<string | null>(null);

  const unavailable = () => ({
    title: t("public.unavailableTitle"),
    text: t("public.unavailableText"),
  });

  const loadToken = useCallback(
    () =>
      service.begin(kunde).then(
        (token) => {
          formToken.current = token;
          if (token === null) setUnknown(true);
        },
        () => {
          formToken.current = null;
          setAlert({
            title: t("public.unavailableTitle"),
            text: t("public.unavailableText"),
          });
        },
      ),
    [service, kunde],
  );

  useEffect(() => {
    void loadToken();
  }, [loadToken]);

  const set = (key: keyof Values) => (e: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found = validate(kind, values, privacy);
    setErrors(found);
    const count = Object.keys(found).length;
    if (count > 0) {
      setAlert({
        title: tp("auth.fieldsInvalid", count),
        text: t("public.fieldsInvalidText"),
      });
      return;
    }
    if (formToken.current === null) {
      await loadToken();
      if (formToken.current === null) return;
    }
    const v = values;
    const input: RegistrationInput =
      kind === "person"
        ? {
            kind,
            firstName: v.firstName,
            lastName: v.lastName,
            street: v.street,
            zip: v.zip,
            city: v.city,
            email: v.email,
            birthDate: v.birth,
          }
        : {
            kind,
            name: v.company,
            uid: v.uid,
            mwst: v.mwst,
            street: v.street,
            zip: v.zip,
            city: v.city,
            contact: v.contact,
            email: v.email,
            phone: v.phone,
          };
    setAlert(null);
    setBusy(true);
    try {
      const result = await service.submit(kunde, formToken.current, website, input);
      if (result.status === "accepted") {
        setReceipt({
          name: kind === "person" ? `${v.firstName.trim()} ${v.lastName.trim()}` : v.company.trim(),
          email: v.email.trim(),
          at: new Date(),
          reference: result.reference,
        });
      } else if (result.status === "unknown") {
        setUnknown(true);
      } else if (result.status === "tooMany") {
        setAlert({ title: t("public.tooManyTitle"), text: t("public.tooManyText") });
      } else {
        // Das Token gilt nur einmal und nur eine Weile: ein neues holen, dann darf erneut gesendet werden.
        setAlert({
          title: t("public.register.expiredTitle"),
          text: t("public.register.expiredText"),
        });
        await loadToken();
      }
    } catch {
      setAlert(unavailable());
    } finally {
      setBusy(false);
    }
  };

  const title = t(kind === "person" ? "public.register.titlePerson" : "public.register.titleFirma");

  if (unknown) {
    return (
      <AuthLayout title={title} subtitle={orgName || undefined} focusTitle>
        <Message tone="error" title={t("public.register.unknownTitle")}>
          {t("public.register.unknownText")}
        </Message>
      </AuthLayout>
    );
  }

  if (receipt) {
    return (
      <AuthLayout title={t("public.registered.title")} focusTitle>
        <Message tone="ok" title={t("public.registered.thanks")}>
          {t("public.registered.sent", { email: receipt.email })}
        </Message>
        <dl className="kv">
          <dt>{t("public.registered.name")}</dt>
          <dd>{receipt.name}</dd>
          <dt>{t("public.registered.email")}</dt>
          <dd>{receipt.email}</dd>
          <dt>{t("public.registered.at")}</dt>
          <dd>{formatStamp(receipt.at)}</dd>
          {receipt.reference && (
            <>
              <dt>{t("public.registered.reference")}</dt>
              <dd className="num">{receipt.reference}</dd>
            </>
          )}
        </dl>
        <span className="muted">
          {orgName
            ? t("public.registered.next", { org: orgName })
            : t("public.registered.nextPlain")}
          {receipt.reference ? ` ${t("public.registered.askReference")}` : ""}
        </span>
      </AuthLayout>
    );
  }

  const person = kind === "person";
  const common = (key: keyof Values, label: TextKey, extra: object = {}) => ({
    label: t(label),
    value: values[key],
    error: errors[key],
    onChange: set(key),
    "aria-required": true as const,
    ...extra,
  });

  return (
    <AuthLayout title={title} subtitle={orgName || undefined} wide>
      <form className="auth__form" onSubmit={submit} noValidate>
        <div className="auth__block">
          <RadioGroup
            legend={t("public.register.kind")}
            name="kind"
            inline
            value={kind}
            onChange={(next) => {
              setKind(next as Kind);
              setErrors({});
              setAlert(null);
            }}
            options={[
              { value: "person", label: t("public.register.kindPerson") },
              { value: "firma", label: t("public.register.kindFirma") },
            ]}
          />
          <span className="muted">{t("public.requiredNote")}</span>
        </div>
        {alert && (
          <Message tone="error" title={alert.title}>
            {alert.text}
          </Message>
        )}
        {!person && (
          <Message tone="neutral" title={t("public.register.firmaNoteTitle")}>
            {t("public.register.firmaNoteText")}
          </Message>
        )}
        <div className="auth__fields">
          {person ? (
            <div className="auth__row">
              <TextField
                {...common("firstName", "public.register.firstName")}
                autoComplete="given-name"
              />
              <TextField
                {...common("lastName", "public.register.lastName")}
                autoComplete="family-name"
              />
            </div>
          ) : (
            <>
              <TextField
                {...common("company", "public.register.company")}
                autoComplete="organization"
              />
              <div className="auth__row">
                <TextField
                  mono
                  {...common("uid", "public.register.uid", { hint: t("public.register.uidHint") })}
                  autoComplete="off"
                />
                <TextField
                  mono
                  {...common("mwst", "public.register.mwst", {
                    hint: t("public.register.mwstHint"),
                  })}
                  aria-required={undefined}
                  autoComplete="off"
                />
              </div>
            </>
          )}
          <TextField
            {...common("street", "public.register.street")}
            autoComplete="street-address"
          />
          <div className="auth__row auth__row--plz">
            <TextField
              mono
              inputMode="numeric"
              {...common("zip", "public.register.zip", { hint: t("public.register.zipHint") })}
              autoComplete="postal-code"
            />
            <TextField {...common("city", "public.register.city")} autoComplete="address-level2" />
          </div>
          {!person && (
            <TextField {...common("contact", "public.register.contact")} autoComplete="name" />
          )}
          <TextField
            type="email"
            {...common("email", "public.register.email")}
            autoComplete="email"
          />
          {person ? (
            <TextField
              {...common("birth", "public.register.birth", {
                hint: t("public.register.birthHint"),
              })}
              aria-required={undefined}
              className="in--w160"
              autoComplete="bday"
            />
          ) : (
            <TextField
              type="tel"
              {...common("phone", "public.register.phone", {
                hint: t("public.register.phoneHint"),
              })}
              aria-required={undefined}
              className="in--w240"
              autoComplete="tel"
            />
          )}
        </div>
        <div className="auth__trap" aria-hidden="true">
          <label>
            {t("public.register.trap")}
            <input
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </label>
        </div>
        <div className="auth__fields">
          <div className="auth__check">
            <Checkbox
              aria-required
              checked={privacy}
              onChange={(e) => setPrivacy(e.target.checked)}
              label={
                <>
                  {t("public.register.privacyPre")}
                  {privacyUrl ? (
                    <a className="lk" href={privacyUrl} target="_blank" rel="noopener noreferrer">
                      {t("public.register.privacyLink")}
                    </a>
                  ) : (
                    t("public.register.privacyLink")
                  )}
                  {t("public.register.privacyPost")}
                </>
              }
            />
            {errors.privacy && (
              <span className="lbl__error">
                <Icon name="warning" size={12} />
                <span>{errors.privacy}</span>
              </span>
            )}
          </div>
          <div className="auth__actions">
            <Button
              type="submit"
              variant="primary"
              icon={person ? "check" : "building"}
              disabled={busy}
            >
              {t(person ? "public.register.submitPerson" : "public.register.submitFirma")}
            </Button>
            <Button
              onClick={() => {
                setValues(empty);
                setPrivacy(false);
                setErrors({});
                setAlert(null);
              }}
            >
              {t("ui.cancel")}
            </Button>
          </div>
        </div>
      </form>
    </AuthLayout>
  );
}

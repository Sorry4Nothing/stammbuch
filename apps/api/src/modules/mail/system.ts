import { createConnectionFactory, escapeHtml, headerSafe, MailError } from "@stammbuch/mail";
import type { ConnectionFactory } from "@stammbuch/mail";
import { z } from "zod";
import type { InvitationSender } from "../../platform/index.js";
import type { RegistrationMailer } from "../people/registration.js";
import type { MailPort, PasswordResetMessage } from "../auth/types.js";

/**
 * Systemmails (Einladung, Passwort zurücksetzen). Sie gehören keinem Kunden und keinem Benutzer: Der Empfänger ist
 * angemeldet noch gar nicht bekannt oder hat noch kein Postfach im Mail-Modul. Deshalb geht der Versand über ein
 * eigenes Postfach des Anbieters (Umgebungsvariablen `MAIL_SYSTEM_*`) und nicht über die Warteschlange der Kunden,
 * aber über dieselbe geprüfte Verbindung wie das Mail-Modul (TLS-Pflicht, SSRF-Schutz).
 */

const envSchema = z.object({
  MAIL_SYSTEM_HOST: z.string().min(1),
  MAIL_SYSTEM_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  MAIL_SYSTEM_SECURITY: z.enum(["tls", "starttls"]).default("starttls"),
  MAIL_SYSTEM_USER: z.string().min(1),
  MAIL_SYSTEM_PASSWORD: z.string().min(1),
  MAIL_SYSTEM_FROM: z.email(),
  MAIL_SYSTEM_FROM_NAME: z.string().min(1).default("Stammbuch"),
  // Wie im Mail-Modul: nur Entwicklung, in Produktion verboten.
  MAIL_ALLOW_PRIVATE_HOSTS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  NODE_ENV: z.string().optional(),
});

export interface SystemMail {
  to: string;
  subject: string;
  /** Reintext; die HTML-Fassung entsteht daraus (alles maskiert, https-Adressen werden Links). */
  text: string;
}
export interface SystemMailer {
  send(mail: SystemMail): Promise<void>;
}

/**
 * `null`, wenn `MAIL_SYSTEM_HOST` fehlt (Systemmails bleiben dann aus). Ist er gesetzt, aber die übrigen Angaben
 * fehlen oder sind ungültig, wirft die Funktion: der Start bricht ab statt Mails stillschweigend zu verlieren.
 */
export function loadSystemMailer(
  env: NodeJS.ProcessEnv = process.env,
  connections?: ConnectionFactory,
): SystemMailer | null {
  if (!env["MAIL_SYSTEM_HOST"]) return null;
  const e = envSchema.parse(env);
  if (e.MAIL_ALLOW_PRIVATE_HOSTS && e.NODE_ENV === "production") {
    throw new Error("MAIL_ALLOW_PRIVATE_HOSTS ist in Produktion nicht erlaubt");
  }
  const factory =
    connections ?? createConnectionFactory({ allowPrivateHosts: e.MAIL_ALLOW_PRIVATE_HOSTS });
  const account = {
    id: "system",
    tenantId: "system",
    ownerUserId: "system",
    label: "System",
    fromAddress: e.MAIL_SYSTEM_FROM,
    fromName: e.MAIL_SYSTEM_FROM_NAME,
    username: e.MAIL_SYSTEM_USER,
    secretEnc: "",
    smtp: { host: e.MAIL_SYSTEM_HOST, port: e.MAIL_SYSTEM_PORT, security: e.MAIL_SYSTEM_SECURITY },
    createdAt: new Date(0),
  };
  return {
    async send(mail) {
      const smtp = await factory.smtp(account, e.MAIL_SYSTEM_PASSWORD);
      try {
        await smtp.send({
          from: { name: account.fromName, address: account.fromAddress },
          to: [{ address: mail.to }],
          subject: headerSafe(mail.subject),
          text: mail.text,
          html: textToHtml(mail.text),
        });
      } finally {
        smtp.close();
      }
    },
  };
}

/** Mail-Inhalt ist immer helles Papier (Projektplan 3.6), unabhängig vom Programm des Empfängers. */
export function textToHtml(text: string): string {
  const body = escapeHtml(text)
    .replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`)
    .replace(/\n/g, "<br>");
  return `<div style="background:#ffffff;color:#111111;font-family:Arial,sans-serif;font-size:15px;line-height:1.5">${body}</div>`;
}

const when = (d: Date) =>
  new Intl.DateTimeFormat("de-CH", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Europe/Zurich",
  }).format(d);

/** Fehler im Log nur als fester Code: der Rohtext des Servers kann Adressen und Hosts enthalten (SR-50, SR-51). */
const codeOf = (err: unknown) => (err instanceof MailError ? err.code : "UNKNOWN");

type LogFn = (obj: object, msg: string) => void;

/**
 * Einladung per Mail mit dem Link `<APP_ORIGIN>/einladung#<token>` (Fragment: kein Eintrag in Zugriffsprotokollen).
 * Scheitert der Versand, bleibt die Einladung bestehen und lässt sich neu auslösen; die Anfrage der einladenden
 * Person schlägt deswegen nicht fehl. Der Fehler steht im Log, ohne Empfänger und ohne Token.
 */
export function mailerInvitationSender(
  mailer: SystemMailer,
  appOrigin: string,
  log: LogFn,
): InvitationSender {
  return {
    async send(message) {
      try {
        await mailer.send({
          to: message.to,
          subject: `Einladung zu Stammbuch: ${message.tenantName}`,
          text: [
            "Guten Tag",
            "",
            `Sie wurden zu Stammbuch eingeladen (${message.tenantName}). Legen Sie über diesen Link Ihr Passwort fest und richten Sie den zweiten Faktor ein:`,
            "",
            `${appOrigin}/einladung#${message.token}`,
            "",
            `Der Link gilt bis ${when(new Date(message.expiresAt))} und nur einmal. Wenn Sie die Einladung nicht erwartet haben, können Sie diese Mail ignorieren.`,
          ].join("\n"),
        });
      } catch (err) {
        log({ code: codeOf(err) }, "Einladungsmail konnte nicht versendet werden");
      }
    },
  };
}

/**
 * Mails des Auth-Moduls. Der Link zum Zurücksetzen geht per Mail raus; Sicherheitsmeldungen bleiben bis zur Anbindung
 * im Log (nur Art und Zeit, nie Empfänger oder Inhalte). Ohne Systemmailer wirft der Versand des Links: das Auth-Modul
 * protokolliert dann `notice_failed`, die Anfrage selbst antwortet unverändert (SR-05).
 */
export function systemAuthMail(mailer: SystemMailer | null, log: LogFn): MailPort {
  return {
    sendSecurityNotice(notice) {
      log(
        { kind: notice.kind, at: notice.at },
        "Sicherheitsmeldung, Mailversand noch nicht angebunden",
      );
      return Promise.resolve();
    },
    async sendPasswordReset(message: PasswordResetMessage) {
      if (!mailer) throw new Error("Systemmailer nicht konfiguriert");
      try {
        await mailer.send({
          to: message.to,
          subject: "Stammbuch: Passwort zurücksetzen",
          text: [
            "Guten Tag",
            "",
            "für Ihr Konto wurde ein neues Passwort angefordert. Über diesen Link legen Sie es fest. Dafür brauchen Sie den Code Ihrer Authenticator-App oder einen Wiederherstellungscode:",
            "",
            message.link,
            "",
            `Der Link gilt bis ${when(message.expiresAt)} und nur einmal. Wenn Sie das nicht angefordert haben, ignorieren Sie diese Mail: Ihr Passwort bleibt unverändert.`,
          ].join("\n"),
        });
      } catch (err) {
        log({ code: codeOf(err) }, "Mail zum Zurücksetzen konnte nicht versendet werden");
        throw err;
      }
    },
  };
}

/**
 * Mails der öffentlichen Selbstregistrierung. Der Link steht mit dem Token im Fragment
 * (`<APP_ORIGIN>/registrierung/<kunde>/bestaetigen#<token>`): Er landet nicht in Zugriffsprotokollen.
 * Die Registrierungsroute antwortet unabhängig vom Ergebnis gleich (SR-05); deshalb wirft der Versand nie,
 * sondern protokolliert nur den Fehlercode, ohne Empfänger und ohne Token. Ohne Systemmailer (`null`) bleibt
 * die Mail aus und der Eintrag unbestätigt.
 */
export function mailerRegistrationSender(
  mailer: SystemMailer | null,
  appOrigin: string,
  log: LogFn,
): RegistrationMailer {
  const closing = (referenz: string) => `Referenz für Rückfragen: ${referenz}`;
  return {
    async send(msg) {
      if (!mailer) {
        log({}, "Registrierungsmail nicht versendet: Systemmailer nicht konfiguriert");
        return;
      }
      const firma = msg.art === "firma";
      const lines =
        msg.vorlage === "registrierung_bestaetigen"
          ? [
              "Guten Tag",
              "",
              `Sie haben sich über das Formular Ihres Vereins ${firma ? "als Firma " : ""}registriert. Bestätigen Sie Ihre E-Mail-Adresse über diesen Link, damit die Registrierung abgeschlossen wird:`,
              "",
              `${appOrigin}/registrierung/${msg.kunde}/bestaetigen#${msg.token ?? ""}`,
              "",
              `Der Link gilt bis ${msg.gueltigBis ? when(msg.gueltigBis) : "zum Ablauf"} und nur einmal. Wenn Sie sich nicht registriert haben, ignorieren Sie diese Mail: Es wird nichts gespeichert.`,
              "",
              closing(msg.referenz),
            ]
          : msg.vorlage === "registrierung_bekannt"
            ? [
                "Guten Tag",
                "",
                "für diese E-Mail-Adresse besteht bereits eine Registrierung. Es wurde nichts geändert. Wenn Sie sich nicht erneut registrieren wollten, ignorieren Sie diese Mail.",
                "",
                closing(msg.referenz),
              ]
            : [
                "Guten Tag",
                "",
                firma
                  ? "Ihre Registrierung ist bestätigt und eingegangen. Der Verein prüft Ihre Firma und meldet sich bei Ihnen."
                  : "Ihre Registrierung ist bestätigt und eingegangen. Vielen Dank.",
                "",
                closing(msg.referenz),
              ];
      const subject = {
        registrierung_bestaetigen: "Stammbuch: Registrierung bestätigen",
        registrierung_bekannt: "Stammbuch: Registrierung",
        registrierung_eingegangen: "Stammbuch: Registrierung eingegangen",
      }[msg.vorlage];
      try {
        await mailer.send({ to: msg.an, subject, text: lines.join("\n") });
      } catch (err) {
        log({ code: codeOf(err) }, "Registrierungsmail konnte nicht versendet werden");
      }
    },
  };
}

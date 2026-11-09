/**
 * Texte der Registrierungsmails an einer Stelle. Sachlich, Sie-Form, mit dem Vereinsnamen aus den
 * Organisations-Einstellungen. Wer die Texte anpassen will, ändert nur diese Datei.
 */

export type RegistrationTemplate =
  "registrierung_bestaetigen" | "registrierung_bekannt" | "registrierung_eingegangen";

export interface RegistrationMailData {
  /** Name des Vereins aus den Einstellungen der Organisation. */
  club: string;
  /** Registrierung einer Firma statt einer Person. */
  firma: boolean;
  /** Referenz für Rückfragen (XXXX-XXXX). */
  reference: string;
  /** Nur «bestätigen»: Link zur Bestätigung und Ende seiner Gültigkeit (fertig formatiert). */
  link?: string;
  validUntil?: string;
}

const closing = (d: RegistrationMailData) => [
  `Referenz für Rückfragen: ${d.reference}`,
  "",
  "Freundliche Grüsse",
  d.club,
];

export function registrationMail(
  template: RegistrationTemplate,
  d: RegistrationMailData,
): { subject: string; lines: string[] } {
  switch (template) {
    case "registrierung_bestaetigen":
      return {
        subject: `${d.club}: Registrierung bestätigen`,
        lines: [
          "Guten Tag",
          "",
          `Sie haben sich bei ${d.club} ${d.firma ? "als Firma " : ""}registriert. Bestätigen Sie Ihre E-Mail-Adresse über diesen Link, damit die Registrierung abgeschlossen wird:`,
          "",
          d.link ?? "",
          "",
          `Der Link gilt bis ${d.validUntil ?? "zum Ablauf"} und nur einmal. Wenn Sie sich nicht registriert haben, ignorieren Sie diese Mail: Es wird nichts gespeichert.`,
          "",
          ...closing(d),
        ],
      };
    case "registrierung_bekannt":
      return {
        subject: `${d.club}: Registrierung`,
        lines: [
          "Guten Tag",
          "",
          `für diese E-Mail-Adresse besteht bei ${d.club} bereits eine Registrierung. Es wurde nichts geändert. Wenn Sie sich nicht erneut registrieren wollten, ignorieren Sie diese Mail.`,
          "",
          ...closing(d),
        ],
      };
    case "registrierung_eingegangen":
      return {
        subject: `${d.club}: Registrierung eingegangen`,
        lines: [
          "Guten Tag",
          "",
          d.firma
            ? `Ihre Registrierung bei ${d.club} ist bestätigt und eingegangen. Der Verein prüft Ihre Firma und meldet sich bei Ihnen.`
            : `Ihre Registrierung bei ${d.club} ist bestätigt und eingegangen. Vielen Dank.`,
          "",
          ...closing(d),
        ],
      };
  }
}

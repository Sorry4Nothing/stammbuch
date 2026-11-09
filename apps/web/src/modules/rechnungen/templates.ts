/**
 * Mailtext der Mahnung (Vorlage im Dialog «Mahnung per E-Mail senden»). Er steht hier an einer Stelle, damit er leicht
 * anzupassen ist: sachlich, Sie-Form, Vereinsname aus den Rechnungseinstellungen, Rechnungsnummer im Betreff. Der
 * Benutzer sieht den Text vor dem Versand und kann ihn ändern. Platzhalter in geschweiften Klammern; die Texte der
 * Storno-Mail und des Sammelversands setzt der Server (`apps/api/src/modules/invoices/templates.ts`).
 */
export const REMINDER_MAIL = {
  subject: "{title} zur Rechnung {invoice}",
  message: [
    "Guten Tag",
    "",
    "Zur Rechnung {invoice} vom {issueDate} haben wir bis heute keinen Zahlungseingang festgestellt. Im Anhang erhalten Sie die {title} über {total}. Bitte begleichen Sie den Betrag bis zum {dueOn}.",
    "",
    "Haben Sie bereits bezahlt, betrachten Sie diese Nachricht als gegenstandslos.",
    "",
    "Freundliche Grüsse",
    "{org}",
  ].join("\n"),
};

export interface ReminderMailValues {
  title: string;
  invoice: string;
  issueDate: string;
  total: string;
  dueOn: string;
  org: string;
}

/** Setzt die Werte in die Vorlage ein; nur diese Platzhalter werden ersetzt. */
export function reminderMail(values: ReminderMailValues): { subject: string; message: string } {
  const fill = (s: string) =>
    s.replace(/\{(\w+)\}/g, (match, key: string) =>
      key in values ? values[key as keyof ReminderMailValues] : match,
    );
  return { subject: fill(REMINDER_MAIL.subject), message: fill(REMINDER_MAIL.message) };
}

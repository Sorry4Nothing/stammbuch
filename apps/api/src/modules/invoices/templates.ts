/**
 * Mailtexte, die der Server selbst setzt (Storno-Benachrichtigung, Sammelversand). Alle Texte stehen hier an einer
 * Stelle, damit sie leicht anzupassen sind: sachlich, Sie-Form, Vereinsname aus den Rechnungseinstellungen.
 * Platzhalter in geschweiften Klammern; unbekannte bleiben leer. Der Text der Mahnung steht in der Oberfläche
 * (`apps/web/src/modules/rechnungen/templates.ts`), weil der Benutzer ihn vor dem Versand sieht und anpassen kann.
 */
export interface MailTemplate {
  subject: string;
  text: string;
}

export const CANCEL_MAIL: MailTemplate = {
  subject: "Storno der Rechnung {invoice}",
  text: [
    "Guten Tag",
    "",
    "Wir haben die Rechnung {invoice} vom {issueDate} über {amount} storniert. Die Gutschrift {creditNote} erhalten Sie im Anhang.",
    "Bitte überweisen Sie für diese Rechnung nichts mehr.",
    "",
    "Freundliche Grüsse",
    "{org}",
  ].join("\n"),
};

export const INVOICE_MAIL: MailTemplate = {
  subject: "Rechnung {invoice} vom {issueDate}",
  text: [
    "Guten Tag",
    "",
    "Im Anhang erhalten Sie die Rechnung {invoice} über {amount}, zahlbar bis {dueDate}.",
    "",
    "Freundliche Grüsse",
    "{org}",
  ].join("\n"),
};

/** Setzt die Platzhalter ein. Werte kommen aus der Datenbank und können beliebige Zeichen enthalten: sie werden nur eingesetzt, nie ausgewertet. */
export function renderTemplate(
  template: MailTemplate,
  values: Record<string, string>,
): { subject: string; text: string } {
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
  return { subject: fill(template.subject), text: fill(template.text) };
}

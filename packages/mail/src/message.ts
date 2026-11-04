import { displayName } from "./headers.js";
import { htmlToText, sanitizeMailHtml } from "./sanitize.js";
import { headerSafe, renderTemplate } from "./template.js";
import type { MailAccount, OutgoingMail, Recipient } from "./types.js";

/** Werte für die Platzhalter eines Empfängers. Fehlende Werte sind leer, nie der Platzhaltername. */
export function recipientValues(r: Recipient): Record<string, string> {
  const name = r.name ?? [r.vorname, r.nachname].filter(Boolean).join(" ");
  return {
    anrede: r.anrede ?? (name ? `Guten Tag ${name}` : "Guten Tag"),
    name,
    vorname: r.vorname ?? "",
    nachname: r.nachname ?? "",
    email: r.email,
    antwortlink: r.antwortlink ?? "",
  };
}

// Mail-Inhalt ist immer helles Papier, unabhängig vom Theme (Projektplan 3.6).
const PAPER = "margin:0;padding:16px;background-color:#ffffff;color:#1a1a1a;";

export function wrapPaper(innerHtml: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="color-scheme" content="light only"></head>' +
    `<body style="${PAPER}">${innerHtml}</body></html>`
  );
}

export interface MessageTemplate {
  subject: string;
  bodyHtml: string;
}

/**
 * Baut die fertige Mail für einen Empfänger: Platzhalter einsetzen (maskiert), danach
 * sanitisieren (zweite Verteidigungslinie, z.B. gegen `javascript:` in einem Linkwert).
 */
export function buildOutgoing(
  account: Pick<MailAccount, "fromAddress" | "fromName">,
  template: MessageTemplate,
  recipient: Recipient,
  attachments: { filename: string; contentType: string; content: Buffer }[],
  subjectPrefix = "",
): OutgoingMail {
  const values = recipientValues(recipient);
  const html = sanitizeMailHtml(renderTemplate(template.bodyHtml, values, "html"), {
    allowRemoteImages: true,
  });
  const recipientName = displayName(values["name"]);
  return {
    from: { name: displayName(account.fromName), address: account.fromAddress },
    to: [{ name: recipientName, address: recipient.email }],
    subject: headerSafe(subjectPrefix + renderTemplate(template.subject, values, "header"), 200),
    html: wrapPaper(html),
    text: htmlToText(html),
    attachments,
  };
}

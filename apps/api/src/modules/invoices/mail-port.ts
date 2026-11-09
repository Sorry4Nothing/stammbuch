import type { MailContext, MailService } from "@stammbuch/mail";
import { noPlaceholders, textToHtml } from "../calendar/mail-port.js";

/** Wer sendet: Mandant und angemeldeter Benutzer, gesendet wird über dessen Mailkonto. */
export interface Sender {
  tenantId: string;
  userId: string;
}

export interface InvoiceMail {
  to: string;
  subject: string;
  /** Reintext; wird maskiert in HTML umgesetzt. */
  text: string;
  /** Das PDF des Belegs. */
  attachment: { filename: string; bytes: Uint8Array };
}

/**
 * Versand von Rechnungen und Mahnungen über das Mail-Modul (#10): eine Einzelmail mit PDF-Anhang in die Queue des
 * Mailkontos des Benutzers, der Worker versendet. Wirft, wenn die Mail nicht in die Queue kommt (kein Mailkonto,
 * Anhang abgelehnt).
 */
export interface InvoiceMailPort {
  send(from: Sender, mail: InvoiceMail): Promise<void>;
}

export function mailServicePort(
  service: Pick<MailService, "addAttachment" | "sendTransactional">,
  contextFor: (from: Sender) => Promise<MailContext | null>,
): InvoiceMailPort {
  return {
    async send(from, mail) {
      const ctx = await contextFor(from);
      if (!ctx) throw new Error("Mail-Kontext nicht verfügbar");
      const file = await service.addAttachment(
        ctx,
        mail.attachment.filename,
        Buffer.from(mail.attachment.bytes),
      );
      await service.sendTransactional(ctx, {
        to: { email: mail.to },
        subject: noPlaceholders(mail.subject),
        bodyHtml: textToHtml(mail.text),
        attachmentIds: [file.id],
      });
    },
  };
}

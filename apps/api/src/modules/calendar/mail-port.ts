import { escapeHtml } from "@stammbuch/mail";
import type { MailContext, MailService } from "@stammbuch/mail";
import type { MailPort, Principal } from "./ports.js";

/**
 * `{{` bekommt ein unsichtbares Zeichen dazwischen: Eventtitel und Namen sind Nutzereingaben und dürfen vom
 * Mail-Modul (Betreff und Inhalt) nicht als Platzhalter gelesen werden.
 */
const noPlaceholders = (text: string) => text.replace(/\{\{/g, "{​{");

/** Reintext der Einladung als HTML für das Mail-Modul. Alles wird maskiert; https-Adressen werden zu Links. */
export function textToHtml(text: string): string {
  const html = noPlaceholders(escapeHtml(text))
    .replace(/https:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`)
    .replace(/\n/g, "<br>");
  return `<p>${html}</p>`;
}

/**
 * Einladungsmails über das Mail-Modul: eine Einzelmail über das Mailkonto der einladenden Person, die der Worker
 * versendet. Ohne Kontext (unbekannter Benutzer) oder ohne Mailkonto wirft der Versand (fail secure).
 */
export function mailServicePort(
  service: Pick<MailService, "sendTransactional">,
  contextFor: (who: Principal) => Promise<MailContext | null>,
): MailPort {
  return {
    async send(who, message) {
      const ctx = await contextFor(who);
      if (!ctx) throw new Error("Mail-Kontext nicht verfügbar");
      await service.sendTransactional(ctx, {
        to: { email: message.to.email, name: message.to.name },
        subject: noPlaceholders(message.subject),
        bodyHtml: textToHtml(message.text),
      });
    },
  };
}

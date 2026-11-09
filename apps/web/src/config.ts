/**
 * Anzeigename der Organisation auf den Zugangsseiten (vor der Anmeldung ist sie noch nicht bekannt).
 * Optional über `VITE_ORG_NAME` beim Build. Ohne Angabe bleibt die Zeile weg.
 */
export const orgName: string = String(import.meta.env.VITE_ORG_NAME ?? "").trim();

/** E-Mail-Adresse des Anbieters für «Anbieter kontaktieren» (Lizenz). Optional über `VITE_SUPPORT_EMAIL`. */
export const supportEmail: string = String(import.meta.env.VITE_SUPPORT_EMAIL ?? "").trim();

/** Nur absolute http(s)-Adressen oder Pfade; alles andere (z. B. `javascript:`) wird verworfen. */
const safeUrl = (v: unknown): string => {
  const s = String(v ?? "").trim();
  return /^(https?:\/\/|\/(?!\/))/i.test(s) ? s : "";
};

/** Adresse der Datenschutzerklärung (`VITE_PRIVACY_URL`). Ohne Angabe erscheint der Text ohne Link. */
export const privacyUrl: string = safeUrl(import.meta.env.VITE_PRIVACY_URL);

/** Kontaktadresse des Vereins auf öffentlichen Seiten (`VITE_CONTACT_EMAIL`). Ohne Angabe bleibt die Zeile weg. */
const contact = String(import.meta.env.VITE_CONTACT_EMAIL ?? "").trim();
export const contactEmail: string = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) ? contact : "";

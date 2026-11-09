/**
 * Anzeigename der Organisation auf den Zugangsseiten (vor der Anmeldung ist sie noch nicht bekannt).
 * Optional über `VITE_ORG_NAME` beim Build. Ohne Angabe bleibt die Zeile weg.
 */
export const orgName: string = String(import.meta.env.VITE_ORG_NAME ?? "").trim();

/** E-Mail-Adresse des Anbieters für «Anbieter kontaktieren» (Lizenz). Optional über `VITE_SUPPORT_EMAIL`. */
export const supportEmail: string = String(import.meta.env.VITE_SUPPORT_EMAIL ?? "").trim();

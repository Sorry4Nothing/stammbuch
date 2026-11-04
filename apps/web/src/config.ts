/**
 * Anzeigename der Organisation auf den Zugangsseiten (vor der Anmeldung ist sie noch nicht bekannt).
 * Optional über `VITE_ORG_NAME` beim Build. Ohne Angabe bleibt die Zeile weg.
 */
export const orgName: string = String(import.meta.env.VITE_ORG_NAME ?? "").trim();

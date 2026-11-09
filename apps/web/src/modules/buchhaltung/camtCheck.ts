/** Obergrenze wie in der API (SR-23). Die API prüft sie erneut; hier nur für eine frühe Rückmeldung. */
export const MAX_CAMT_BYTES = 5 * 1024 * 1024;

export interface CamtInfo {
  kind: "camt.053" | "camt.054";
  count: number;
  from?: string;
  to?: string;
  iban?: string;
}

/**
 * Schnelle Vorprüfung im Browser, damit die Seite vor dem Import sagt, was die Datei enthält.
 * Massgebend ist allein die Prüfung der API. DTD und Entitäten werden nie geparst (SR-25).
 */
export function inspectCamt(text: string): CamtInfo | null {
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(text)) return null;
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  const ns = doc.documentElement.namespaceURI ?? "";
  const kind = ns.includes("camt.053") ? "camt.053" : ns.includes("camt.054") ? "camt.054" : null;
  if (!kind) return null;
  const first = (name: string) => doc.getElementsByTagNameNS("*", name)[0]?.textContent?.trim();
  const from = first("FrDtTm")?.slice(0, 10);
  const to = first("ToDtTm")?.slice(0, 10);
  const iban = first("IBAN");
  return {
    kind,
    count: doc.getElementsByTagNameNS("*", "TxDtls").length,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(iban ? { iban } : {}),
  };
}

/** Erste 16 Hexzeichen der SHA-256-Prüfsumme (Anzeige im Importprotokoll). */
export async function checksum(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

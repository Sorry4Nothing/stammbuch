const MOD10_TABLE = [0, 9, 4, 6, 8, 2, 7, 1, 3, 5];

/** Leerzeichen entfernen, Grossbuchstaben: so wird eine Referenz verglichen und gespeichert. */
export function normalizeReference(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/** QR-Referenz (Typ QRR): 27 Ziffern, letzte Stelle = Modulo-10-Prüfziffer (rekursiv). */
export function isValidQrReference(ref: string): boolean {
  if (!/^\d{27}$/.test(ref)) return false;
  let carry = 0;
  for (let i = 0; i < 26; i++) carry = MOD10_TABLE[(carry + Number(ref[i])) % 10] ?? 0;
  return (10 - carry) % 10 === Number(ref[26]);
}

/** Creditor Reference (Typ SCOR, ISO 11649): "RF" + 2 Prüfziffern + bis 21 alphanumerische Zeichen. */
export function isValidScorReference(ref: string): boolean {
  if (!/^RF\d{2}[A-Z0-9]{1,21}$/.test(ref)) return false;
  const rearranged = ref.slice(4) + ref.slice(0, 4);
  const digits = [...rearranged].map((c) => (c >= "A" ? String(c.charCodeAt(0) - 55) : c)).join("");
  return BigInt(digits) % 97n === 1n;
}

export type ReferenceType = "QRR" | "SCOR";

export function isValidReference(type: ReferenceType, ref: string): boolean {
  return type === "QRR" ? isValidQrReference(ref) : isValidScorReference(ref);
}

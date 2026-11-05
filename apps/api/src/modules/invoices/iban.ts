/** Rest einer Ziffern-/Buchstabenfolge mod 97 (Buchstaben A=10 ... Z=35), ohne BigInt-Überlauf. */
export function mod97(input: string): number {
  let rest = 0;
  for (const ch of input) {
    const v = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of v) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest;
}

export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, "").toUpperCase();
}

export function isValidIban(iban: string): boolean {
  const s = normalizeIban(iban);
  return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s) && mod97(s.slice(4) + s.slice(0, 4)) === 1;
}

/** Für die QR-Rechnung zulässig: CH oder LI, 21 Zeichen, gültige Prüfziffer. */
export function isSwissOrLiIban(iban: string): boolean {
  const s = normalizeIban(iban);
  return /^(CH|LI)\d{19}$/.test(s) && isValidIban(s);
}

/** QR-IBAN: Swiss/LI-IBAN mit Instituts-ID (Stellen 5-9) im Bereich 30000-31999. */
export function isQrIban(iban: string): boolean {
  if (!isSwissOrLiIban(iban)) return false;
  const iid = Number(normalizeIban(iban).slice(4, 9));
  return iid >= 30000 && iid <= 31999;
}

/** "CH44 3199 9123 0008 8901 2" */
export function formatIban(iban: string): string {
  return normalizeIban(iban).replace(/(.{4})(?=.)/g, "$1 ");
}

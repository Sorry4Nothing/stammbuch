import { parseUid } from "@stammbuch/shared";
import type { Address } from "@stammbuch/shared";

/** Vergleichsform: ohne Akzente, klein, nur Buchstaben/Ziffern, einfache Leerzeichen. */
export function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const LEGAL_FORMS = new Set([
  "ag",
  "gmbh",
  "sa",
  "sarl",
  "sagl",
  "kg",
  "ltd",
  "inc",
  "co",
  "kollektivgesellschaft",
  "genossenschaft",
  "stiftung",
  "verein",
  "einzelfirma",
]);

export function normalizeCompanyName(name: string): string {
  return fold(name)
    .split(" ")
    .filter((t) => t !== "" && !LEGAL_FORMS.has(t))
    .join(" ");
}

export function normalizeAddress(a: Address): string {
  const street = fold(a.strasse)
    .replace(/\bstr\b/g, "strasse")
    .replace(/ strasse\b/g, "strasse");
  return `${street}|${fold(a.hausnr ?? "")}|${fold(a.plz)}`;
}

/** Dice-Koeffizient über Bigramme: 1 = identisch, 0 = nichts gemeinsam. */
export function similarity(a: string, b: string): number {
  if (a === b) return a === "" ? 0 : 1;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++)
      m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let common = 0;
  for (const [g, n] of ga) common += Math.min(n, gb.get(g) ?? 0);
  const total = Math.max(a.length - 1, 0) + Math.max(b.length - 1, 0);
  return total === 0 ? 0 : (2 * common) / total;
}

/** UID-Ziffern aus UID- oder MwSt-Feld (beide enthalten dieselbe Nummer). */
export function uidDigits(f: { uid: string | null; mwstNr: string | null }): string[] {
  return [f.uid, f.mwstNr].flatMap((v) => {
    const p = v ? parseUid(v) : null;
    return p ? [p.digits] : [];
  });
}

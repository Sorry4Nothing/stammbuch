import type { DuplicateCandidate } from "@stammbuch/shared";
import type { Firma } from "./domain.js";
import { normalizeAddress, normalizeCompanyName, similarity, uidDigits } from "./normalize.js";

export type DuplicateReason = DuplicateCandidate["gruende"][number];
export interface DuplicateMatch {
  firma: Firma;
  score: number;
  gruende: DuplicateReason[];
}

export interface DuplicatePair {
  a: Firma;
  b: Firma;
  score: number;
  gruende: DuplicateReason[];
}

type Probe = Pick<Firma, "name" | "uid" | "mwstNr" | "adresse">;

const THRESHOLD = 0.75;
const MAX_RESULTS = 10;
/** Paarweiser Vergleich ist quadratisch: ab dieser Grösse braucht es einen Index statt einer Schleife. */
export const PAIR_SCAN_MAX = 2000;

interface Prepared<T extends Probe> {
  firma: T;
  uids: string[];
  name: string;
  addr: string;
}

const prepare = <T extends Probe>(firma: T): Prepared<T> => ({
  firma,
  uids: uidDigits(firma),
  name: normalizeCompanyName(firma.name),
  addr: normalizeAddress(firma.adresse),
});

/**
 * Bewertet, wie wahrscheinlich `probe` dieselbe Firma wie `other` ist. Gleiche UID gilt als sicher;
 * sonst zählen normalisierter Name (ohne Rechtsform, Akzente, Satzzeichen), Namensähnlichkeit
 * (Bigramm-Dice) und gleiche Adresse. `undefined` unter der Schwelle.
 */
function compare(
  probe: Prepared<Probe>,
  other: Prepared<Probe>,
): { score: number; gruende: DuplicateReason[] } | undefined {
  const gruende: DuplicateReason[] = [];
  let score = 0;

  if (other.uids.some((d) => probe.uids.includes(d))) {
    gruende.push("uid");
    if (probe.firma.mwstNr && probe.firma.mwstNr === other.firma.mwstNr) gruende.push("mwst");
    score = 1;
  }

  const sameAddr = other.addr === probe.addr;
  const sim = similarity(probe.name, other.name);
  if (probe.name !== "" && probe.name === other.name) {
    gruende.push("name");
    score = Math.max(score, sameAddr ? 1 : 0.95);
  } else if (sim >= 0.85) {
    gruende.push("name_aehnlich");
    score = Math.max(score, sim * 0.9 + (sameAddr ? 0.1 : 0));
  }
  if (sameAddr && gruende.length > 0) gruende.push("adresse");

  return score >= THRESHOLD ? { score: Math.min(score, 1), gruende } : undefined;
}

export function findDuplicates(
  probe: Probe,
  candidates: Firma[],
  exceptId?: string,
): DuplicateMatch[] {
  const p = prepare(probe);
  const matches: DuplicateMatch[] = [];
  for (const firma of candidates) {
    if (firma.id === exceptId) continue;
    const hit = compare(p, prepare(firma));
    if (hit) matches.push({ firma, ...hit });
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS);
}

/**
 * Alle Paare im Register, die sich ähneln. Jedes Paar einmal, `a.id` < `b.id` (die Kennung des
 * Paars ist damit unabhängig von der Reihenfolge der Eingabe).
 */
export function findDuplicatePairs(firmen: Firma[]): DuplicatePair[] {
  const list = [...firmen].sort((x, y) => (x.id < y.id ? -1 : 1)).map(prepare);
  const pairs: DuplicatePair[] = [];
  for (const [i, x] of list.entries()) {
    for (const y of list.slice(i + 1)) {
      const hit = compare(x, y);
      if (hit) pairs.push({ a: x.firma, b: y.firma, ...hit });
    }
  }
  return pairs.sort((p, q) => q.score - p.score);
}

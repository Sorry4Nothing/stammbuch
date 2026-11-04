import type { DuplicateCandidate } from "@stammbuch/shared";
import type { Firma } from "./domain.js";
import { normalizeAddress, normalizeCompanyName, similarity, uidDigits } from "./normalize.js";

export type DuplicateReason = DuplicateCandidate["gruende"][number];
export interface DuplicateMatch {
  firma: Firma;
  score: number;
  gruende: DuplicateReason[];
}

type Probe = Pick<Firma, "name" | "uid" | "mwstNr" | "adresse">;

const THRESHOLD = 0.75;
const MAX_RESULTS = 10;

/**
 * Bewertet, wie wahrscheinlich `probe` dieselbe Firma wie ein Eintrag aus `candidates` ist.
 * Gleiche UID gilt als sicher; sonst zählen normalisierter Name (ohne Rechtsform, Akzente,
 * Satzzeichen), Namensähnlichkeit (Bigramm-Dice) und gleiche Adresse.
 */
export function findDuplicates(
  probe: Probe,
  candidates: Firma[],
  exceptId?: string,
): DuplicateMatch[] {
  const probeUids = uidDigits(probe);
  const probeName = normalizeCompanyName(probe.name);
  const probeAddr = normalizeAddress(probe.adresse);

  const matches: DuplicateMatch[] = [];
  for (const firma of candidates) {
    if (firma.id === exceptId) continue;
    const gruende: DuplicateReason[] = [];
    let score = 0;

    const sameUid = uidDigits(firma).some((d) => probeUids.includes(d));
    if (sameUid) {
      gruende.push("uid");
      if (probe.mwstNr && probe.mwstNr === firma.mwstNr) gruende.push("mwst");
      score = 1;
    }

    const name = normalizeCompanyName(firma.name);
    const sameAddr = normalizeAddress(firma.adresse) === probeAddr;
    const sim = similarity(probeName, name);
    if (probeName !== "" && probeName === name) {
      gruende.push("name");
      score = Math.max(score, sameAddr ? 1 : 0.95);
    } else if (sim >= 0.85) {
      gruende.push("name_aehnlich");
      score = Math.max(score, sim * 0.9 + (sameAddr ? 0.1 : 0));
    }
    if (sameAddr && gruende.length > 0) gruende.push("adresse");

    if (score >= THRESHOLD) matches.push({ firma, score: Math.min(score, 1), gruende });
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS);
}

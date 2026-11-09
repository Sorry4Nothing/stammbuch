import type { PeopleStore } from "../people/repository.js";
import type { Address } from "./domain.js";
import type { Cents } from "./money.js";
import { addressSchema } from "./schemas.js";

/** Person, die ein Sammelrechnungslauf anschreiben kann (Auszug aus dem Personenmodul). */
export interface CollectiveMember {
  id: string;
  name: string;
  email: string | null;
  address: Address | null;
}

export interface CollectiveGroup {
  id: string;
  name: string;
  /** `null` = Gruppe ohne Beitrag. */
  feeCents: Cents | null;
}

/**
 * Quelle der Sammelrechnung: Gruppen und Mitglieder aus dem Personenmodul (nur lesend) samt Beitrag je Gruppe.
 * Alle Methoden sind auf den Mandanten begrenzt (SR-11).
 */
export interface CollectiveSource {
  groups(tenantId: string): Promise<CollectiveGroup[]>;
  /** Aktive Mitglieder der Gruppe, mit `includeLeft` auch die archivierten (Ausgetretene). */
  members(tenantId: string, groupId: string, includeLeft: boolean): Promise<CollectiveMember[]>;
  /** Zahl der aktiven Personen ohne Gruppe. */
  ungrouped(tenantId: string): Promise<number>;
  /** Setzt oder (`null`) entfernt den Beitrag; `false`, wenn die Gruppe im Mandanten nicht existiert. */
  setFee(tenantId: string, groupId: string, feeCents: Cents | null): Promise<boolean>;
}

/** Ablage der Beiträge (Postgres: `rechnung_gruppenbeitrag`). */
export interface GroupFeeStore {
  list(tenantId: string): Promise<Map<string, Cents>>;
  set(tenantId: string, groupId: string, feeCents: Cents | null): Promise<void>;
}

export class MemoryGroupFeeStore implements GroupFeeStore {
  private readonly rows = new Map<string, Map<string, Cents>>();
  async list(tenantId: string) {
    return new Map(this.rows.get(tenantId));
  }
  async set(tenantId: string, groupId: string, feeCents: Cents | null) {
    const fees = this.rows.get(tenantId) ?? new Map<string, Cents>();
    if (feeCents === null) fees.delete(groupId);
    else fees.set(groupId, feeCents);
    this.rows.set(tenantId, fees);
  }
}

const PAGE = 200;

export function createCollectiveSource(people: PeopleStore, fees: GroupFeeStore): CollectiveSource {
  async function* pages(tenantId: string, query: Parameters<PeopleStore["members"]["list"]>[1]) {
    let after: string | undefined;
    do {
      const page = await people.members.list(tenantId, { ...query, ...(after ? { after } : {}) });
      yield* page.items;
      after = page.next ?? undefined;
    } while (after);
  }

  return {
    async groups(tenantId) {
      const [groups, prices] = await Promise.all([
        people.gruppen.list(tenantId),
        fees.list(tenantId),
      ]);
      return groups
        .map((g) => ({ id: g.id, name: g.name, feeCents: prices.get(g.id) ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name, "de-CH"));
    },

    async members(tenantId, groupId, includeLeft) {
      const out: CollectiveMember[] = [];
      for (const status of includeLeft
        ? (["aktiv", "archiviert"] as const)
        : (["aktiv"] as const)) {
        for await (const m of pages(tenantId, { limit: PAGE, status, gruppeId: groupId })) {
          out.push({
            id: m.id,
            name: `${m.vorname} ${m.nachname}`.trim(),
            email: m.email,
            address: m.adresse
              ? {
                  name: `${m.vorname} ${m.nachname}`.trim(),
                  street: m.adresse.strasse,
                  ...(m.adresse.hausnr ? { buildingNumber: m.adresse.hausnr } : {}),
                  postalCode: m.adresse.plz,
                  town: m.adresse.ort,
                  country: m.adresse.land,
                }
              : null,
          });
        }
      }
      return out;
    },

    async ungrouped(tenantId) {
      const ids: string[] = [];
      for await (const m of pages(tenantId, { limit: PAGE, status: "aktiv", ohneGruppe: true }))
        ids.push(m.id);
      return ids.length;
    },

    async setFee(tenantId, groupId, feeCents) {
      if (!(await people.gruppen.get(tenantId, groupId))) return false;
      await fees.set(tenantId, groupId, feeCents);
      return true;
    },
  };
}

// --- Planung ---------------------------------------------------------------------------------

export interface CollectiveConfig {
  year: number;
  issueDate: string;
  termDays: number;
  text: string;
  delivery: "email-or-print" | "email" | "print";
  skipLeft: boolean;
  skipNoFee: boolean;
  groupIds: string[];
}

export interface PlannedInvoice {
  memberId: string;
  recipient: string;
  groupName: string;
  feeCents: Cents;
  address: Address;
  email: string | null;
  delivery: "email" | "print";
  /** `no-email`: es sollte per E-Mail gehen, die Person hat aber keine Adresse; die Rechnung wird zum Ausdrucken bereitgestellt. */
  check: "ready" | "no-email";
}

export interface CollectivePlan {
  items: PlannedInvoice[];
  groupCount: number;
  /** Personen ohne vollständige Postadresse: sie bekommen keine Rechnung (die QR-Rechnung braucht den Schuldner). */
  noAddress: number;
}

/**
 * Wer bekommt welche Rechnung: eine je Person der gewählten Gruppen mit Beitrag, sortiert nach Gruppe und Name.
 * Gruppen ohne Beitrag haben nichts zu verrechnen und fallen immer weg (`skipNoFee` ändert daran nichts, es gibt
 * keinen Betrag, den man stattdessen einsetzen könnte). Jede Rechnung wird erstellt, auch bei Zustellung «nur E-Mail»
 * ohne Adresse: sie ist dann als «Keine E-Mail-Adresse» markiert und liegt zum Ausdrucken bereit.
 */
export async function planCollective(
  source: CollectiveSource,
  tenantId: string,
  config: CollectiveConfig,
): Promise<CollectivePlan> {
  const wanted = new Set(config.groupIds);
  const groups = (await source.groups(tenantId)).filter(
    (g) => wanted.has(g.id) && g.feeCents !== null,
  );
  const items: PlannedInvoice[] = [];
  let noAddress = 0;
  for (const g of groups) {
    const members = await source.members(tenantId, g.id, !config.skipLeft);
    members.sort((a, b) => a.name.localeCompare(b.name, "de-CH") || a.id.localeCompare(b.id));
    for (const m of members) {
      // Die QR-Rechnung braucht eine vollständige, lesbare Adresse; unvollständige zählen als «ohne Adresse».
      const address = addressSchema.safeParse(m.address);
      if (!address.success || g.feeCents === null) {
        noAddress++;
        continue;
      }
      const viaEmail = config.delivery !== "print" && m.email !== null;
      items.push({
        memberId: m.id,
        recipient: m.name,
        groupName: g.name,
        feeCents: g.feeCents,
        address: address.data,
        email: m.email,
        delivery: viaEmail ? "email" : "print",
        check: config.delivery !== "print" && m.email === null ? "no-email" : "ready",
      });
    }
  }
  return { items, groupCount: groups.length, noAddress };
}

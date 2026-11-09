import type { PeopleStore } from "../people/repository.js";

/** Was die Rechnungen von einer Person oder Firma wissen müssen: Mitgliedsnummer und Adresse für Mails. */
export interface PersonInfo {
  /** Nummer des Mitglieds (Format `M-1001`); Firmen haben keine. */
  memberNumber: string | null;
  /** Rechnungs-E-Mail der Person bzw. der Firma. */
  email: string | null;
}

/** Nur lesend und auf den Mandanten begrenzt (SR-11). */
export interface PersonDirectory {
  find(tenantId: string, id: string): Promise<PersonInfo | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Auskunft aus dem Personenmodul. `customerId` einer Rechnung ist frei erfassbar: was keine UUID ist, kann keine
 * Person sein und wird gar nicht erst nachgeschlagen.
 */
export function createPersonDirectory(people: PeopleStore): PersonDirectory {
  return {
    async find(tenantId, id) {
      if (!UUID.test(id)) return null;
      const member = await people.members.get(tenantId, id);
      if (member) return { memberNumber: member.mitgliedsnr || null, email: member.email };
      const firma = await people.firmen.get(tenantId, id);
      if (firma) return { memberNumber: null, email: firma.rechnungsEmail ?? firma.email };
      return null;
    },
  };
}

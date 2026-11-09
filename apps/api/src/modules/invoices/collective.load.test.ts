import { describe, expect, it } from "vitest";
import { createMemoryStore as createLedger } from "../accounting/repository.js";
import { AccountingService } from "../accounting/service.js";
import type { Member } from "../people/domain.js";
import { createMemoryStore as createPeople } from "../people/memory.js";
import { createAccountingPort } from "./accounting-port.js";
import { MemoryGroupFeeStore, createCollectiveSource } from "./collective.js";
import { createPersonDirectory } from "./directory.js";
import type { InvoiceMail, InvoiceMailPort } from "./mail-port.js";
import {
  MemoryInvoiceRepository,
  MemoryReminderRepository,
  MemorySettingsRepository,
} from "./memory.js";
import { COLLECTIVE_BATCH, InvoiceService } from "./service.js";
import { TENANT, settingsInput } from "./test-fixtures.js";

// Last des Sammelrechnungslaufs (#132): über 1000 Rechnungen gegen die In-Memory-Ablage. Geprüft wird, dass die Pakete
// den Lauf vollständig und ohne Doppelte abarbeiten und jede Anfrage begrenzt bleibt. Zustellung «nur Ausdruck»: mit
// E-Mail kostet jede Rechnung ein PDF (etwa 60 ms), das ist hier nicht Gegenstand. Postgres: collective.pg.test.ts.
const USER = "u1";
const NOW = new Date("2026-11-04T10:00:00Z");
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PERSONS = 1200;

async function prepare(delivery: "email" | "print") {
  const ledger = new AccountingService(createLedger(), () => NOW);
  const people = createPeople();
  const fees = new MemoryGroupFeeStore();
  const sent: InvoiceMail[] = [];
  const mail: InvoiceMailPort = {
    send: async (_f, m) => {
      sent.push(m);
    },
  };
  let n = 100_000;
  const service = new InvoiceService({
    invoices: new MemoryInvoiceRepository(),
    reminders: new MemoryReminderRepository(),
    settings: new MemorySettingsRepository(),
    accounting: createAccountingPort(ledger, { tenantId: TENANT, userId: USER }),
    collective: createCollectiveSource(people, fees),
    people: createPersonDirectory(people),
    mail,
    now: () => NOW,
    newId: () => ID(++n),
  });
  await service.saveSettings(TENANT, settingsInput());
  await service.setFeatures(TENANT, { collectiveInvoicing: true });
  await people.gruppen.insert({
    id: ID(1),
    kundeId: TENANT,
    name: "Aktive",
    beschreibung: null,
    erstelltAm: NOW,
    geaendertAm: NOW,
  });
  for (let i = 1; i <= PERSONS; i++) {
    const m: Member = {
      id: ID(1000 + i),
      kundeId: TENANT,
      typ: "einzel",
      status: "aktiv",
      quelle: "manuell",
      zusammengefuehrtMit: null,
      anrede: null,
      vorname: `Vor${i}`,
      nachname: `Nach${String(i).padStart(4, "0")}`,
      email: `m${i}@example.test`,
      telefon: null,
      mobil: null,
      adresse: { strasse: "Dorfstrasse", hausnr: "3", plz: "3000", ort: "Bern", land: "CH" },
      notiz: null,
      mitgliedsnr: "",
      geburtsdatum: null,
      eintritt: null,
      kanal: null,
      gruppeSeit: null,
      funktion: null,
      firmaId: null,
      gruppeId: null,
      erstelltAm: NOW,
      geaendertAm: NOW,
    };
    await people.members.insert(m);
    await people.gruppen.assign(TENANT, m.id, ID(1));
  }
  await fees.set(TENANT, ID(1), 12000);
  const input = {
    runId: ID(50),
    config: {
      year: 2027,
      issueDate: "2026-12-01",
      termDays: 30,
      text: "Beitrag",
      delivery,
      skipLeft: true,
      skipNoFee: true,
      groupIds: [ID(1)],
    },
    mail: { subject: "Rechnung {number}", message: "Betrag {amount}" },
  };
  return { service, input, sent };
}

describe("Sammelrechnungslauf mit über 1000 Rechnungen", () => {
  it("arbeitet 1200 Personen in Paketen ab: vollständig, ohne Doppelte, jede Anfrage begrenzt", async () => {
    const { service, input } = await prepare("print");
    const calls: Awaited<ReturnType<typeof service.runCollectiveByGroups>>[] = [];
    const durations: number[] = [];
    do {
      const t0 = performance.now();
      calls.push(await service.runCollectiveByGroups(TENANT, input, USER));
      durations.push(performance.now() - t0);
    } while (calls.at(-1)!.remaining > 0 && calls.length < 50);

    expect(calls).toHaveLength(Math.ceil(PERSONS / COLLECTIVE_BATCH));
    expect(calls.every((c) => c.created <= COLLECTIVE_BATCH)).toBe(true);
    expect(calls.reduce((s, c) => s + c.created, 0)).toBe(PERSONS);
    expect(calls.at(-1)?.remaining).toBe(0);

    const all = await service.list(TENANT, { kind: "invoice", limit: 200, offset: 0 });
    expect(all.total).toBe(PERSONS);
    // Lückenlose, eindeutige Nummern über alle Pakete
    const numbers: string[] = [];
    for (let offset = 0; offset < PERSONS; offset += 200)
      numbers.push(
        ...(await service.list(TENANT, { kind: "invoice", limit: 200, offset })).items.map(
          (i) => i.invoice.number ?? "",
        ),
      );
    expect(new Set(numbers).size).toBe(PERSONS);
    expect(numbers.sort().at(-1)).toBe("RE-2026-" + String(PERSONS).padStart(4, "0"));
    // Wiederholung nach Abschluss ändert nichts
    const again = await service.runCollectiveByGroups(TENANT, input, USER);
    expect([again.created, again.skipped, again.remaining]).toEqual([0, PERSONS, 0]);
    // Schranke grosszügig, damit langsame Läufer nicht flackern; sie sichert nur, dass kein Paket ausufert.
    expect(Math.max(...durations)).toBeLessThan(30_000);
  }, 300_000);
});

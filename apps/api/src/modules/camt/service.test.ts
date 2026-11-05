import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InMemoryCamtRepository } from "./repository.js";
import { CamtImportService } from "./service.js";
import type { OpenItem, OpenItemLookup } from "./service.js";
import { CamtError } from "./types.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const R1 = "000000021000000000000100009";
const R2 = "000000021000000000000200004";
const R3 = "000000021000000000000300008";

function setup(items: OpenItem[]) {
  const repo = new InMemoryCamtRepository();
  const lookups: string[][] = [];
  const lookup: OpenItemLookup = {
    findByReferences: (refs) => {
      lookups.push(refs);
      return Promise.resolve(items.filter((i) => refs.includes(i.reference)));
    },
  };
  return { repo, lookups, service: new CamtImportService(repo, lookup) };
}
const item = (id: string, reference: string, amountRappen: number): OpenItem => ({
  id,
  reference,
  amountRappen,
  currency: "CHF",
});

describe("Zuordnung über QR-Referenz", () => {
  it("ordnet exakte Treffer zu und lässt den Rest als Restposten", async () => {
    const { service, repo, lookups } = setup([
      item("inv-1", R1, 12000),
      item("inv-2", R2, 9000), // Betrag weicht ab (80.50 gezahlt)
    ]);
    const r = await service.importFile(fixture("camt053-v04.xml"));

    expect(r.import.counts).toEqual({ total: 5, matched: 1, rest: 3, duplicates: 0, ignored: 2 });
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]).toMatchObject({ openItemId: "inv-1", status: "MATCHED" });

    const reasons = Object.fromEntries(
      r.rest.map((p) => [p.transaction.bankReference, [p.restReason, p.openItemId]]),
    );
    expect(reasons).toEqual({
      "REF-0002": ["AMOUNT_MISMATCH", "inv-2"],
      "REF-0003": ["NO_REFERENCE", undefined],
      "REF-0004": ["REVERSAL", undefined],
    });
    expect((await repo.listRestPayments({ limit: 10 })).items).toHaveLength(3);
    // Nur Gutschriften mit gültiger Referenz werden nachgeschlagen.
    expect(lookups).toEqual([[R1, R2]]);
  });

  it("lässt Zahlungen ohne offenen Posten und mit ungültiger Prüfziffer im Rest", async () => {
    const { service } = setup([]);
    const r = await service.importFile(fixture("camt054-v08.xml"));
    expect(r.rest.map((p) => p.restReason)).toEqual([
      "NO_OPEN_ITEM",
      "NO_OPEN_ITEM",
      "INVALID_REFERENCE",
    ]);
  });

  it("bucht SCOR und QR-Referenz aus einer Sammelbuchung", async () => {
    const { service } = setup([item("a", R3, 20000), item("b", "RF18539007547034", 10000)]);
    const r = await service.importFile(fixture("camt054-v08.xml"));
    expect(r.matched.map((p) => p.openItemId)).toEqual(["a", "b"]);
    expect(r.import.counts).toMatchObject({ matched: 2, rest: 1 });
  });

  it("verweigert Auto-Zuordnung bei Währungsabweichung, mehrdeutiger Referenz und Doppelzahlung", async () => {
    const chf = item("a", R1, 12000);
    const { service } = setup([{ ...chf, currency: "EUR" }]);
    expect((await service.importFile(fixture("camt053-v04.xml"))).rest[0]?.restReason).toBe(
      "AMOUNT_MISMATCH",
    );

    const amb = setup([chf, { ...chf, id: "b" }]);
    expect((await amb.service.importFile(fixture("camt053-v04.xml"))).rest[0]?.restReason).toBe(
      "AMBIGUOUS_OPEN_ITEM",
    );

    // Zwei Zahlungen auf dieselbe Referenz: nur die erste bucht den Posten.
    const twice = fixture("camt053-v04.xml")
      .toString()
      .replace("<NtryRef>2</NtryRef>", "<NtryRef>2</NtryRef>")
      .replace("000000021000000000000200004", R1)
      .replace('Ccy="CHF">80.50', 'Ccy="CHF">120.00');
    const dbl = setup([chf]);
    const r = await dbl.service.importFile(Buffer.from(twice));
    expect(r.matched).toHaveLength(1);
    expect(r.rest.find((p) => p.transaction.bankReference === "REF-0002")).toMatchObject({
      restReason: "OPEN_ITEM_ALREADY_PAID",
    });
  });

  it("bucht nie automatisch, wenn der Lookup nichts liefert", async () => {
    const { service } = setup([]);
    const r = await service.importFile(fixture("camt053-v04.xml"));
    expect(r.matched).toEqual([]);
  });
});

describe("Duplikaterkennung", () => {
  it("weist dieselbe Datei ab und nennt den früheren Import", async () => {
    const { service } = setup([]);
    const first = await service.importFile(fixture("camt053-v04.xml"));
    const err = await service.importFile(fixture("camt053-v04.xml")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CamtError);
    expect(err).toMatchObject({ code: "DUPLICATE_FILE", details: { importId: first.import.id } });
  });

  it("erkennt dieselbe Buchung in einer anderen Datei", async () => {
    const { service } = setup([]);
    await service.importFile(fixture("camt053-v04.xml"));
    // Anderer Kopf (andere Datei), gleiche Buchungen plus eine neue.
    const changed = fixture("camt053-v04.xml")
      .toString()
      .replace("MSG-053-0001", "MSG-053-0002")
      .replace(
        "</Stmt>",
        `<Ntry><Amt Ccy="CHF">5.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-10-31</Dt></BookgDt><AcctSvcrRef>REF-0099</AcctSvcrRef></Ntry></Stmt>`,
      );
    const r = await service.importFile(Buffer.from(changed));
    expect(r.import.counts).toMatchObject({ total: 6, duplicates: 4, rest: 1 });
    expect(r.duplicates).toHaveLength(4);
  });

  it("unterscheidet identische Buchungen innerhalb einer Datei", async () => {
    const { service } = setup([]);
    const one = `<Ntry><Amt Ccy="CHF">5.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-10-31</Dt></BookgDt></Ntry>`;
    const xml = fixture("camt054-v08.xml")
      .toString()
      .replace("</Ntfctn>", one + one + "</Ntfctn>");
    const r = await service.importFile(Buffer.from(xml));
    expect(r.import.counts.duplicates).toBe(0);
    expect(r.import.counts.total).toBe(5);
  });
});

describe("Ablehnung", () => {
  it("speichert bei Fehlern nichts", async () => {
    const { service, repo } = setup([]);
    await expect(
      service.importFile(Buffer.from("<?xml version='1.0'?><Document/>")),
    ).rejects.toThrow(CamtError);
    expect((await repo.listRestPayments({ limit: 10 })).items).toEqual([]);
    expect(await repo.findImportByFileHash("x")).toBeUndefined();
  });

  it("scheitert, wenn der Lookup ausfällt (kein Teilimport)", async () => {
    const repo = new InMemoryCamtRepository();
    const service = new CamtImportService(repo, {
      findByReferences: () => Promise.reject(new Error("db down")),
    });
    await expect(service.importFile(fixture("camt053-v04.xml"))).rejects.toThrow("db down");
    expect((await repo.listRestPayments({ limit: 10 })).items).toEqual([]);
  });
});

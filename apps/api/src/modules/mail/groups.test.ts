import { describe, expect, it } from "vitest";
import type { Member } from "../people/domain.js";
import { createMemoryStore } from "../people/memory.js";
import { peopleGroupLookup } from "./index.js";

const KUNDE = "11111111-1111-4111-8111-111111111111";
const ANDERER = "22222222-2222-4222-8222-222222222222";
const GRUPPE = "33333333-3333-4333-8333-333333333333";

const member = (id: string, kundeId: string, over: Partial<Member>): Member => ({
  id,
  kundeId,
  typ: "einzel",
  status: "aktiv",
  quelle: "manuell",
  zusammengefuehrtMit: null,
  anrede: null,
  vorname: "Vera",
  nachname: "Muster",
  email: `${id}@example.test`,
  telefon: null,
  mobil: null,
  adresse: null,
  notiz: null,
  funktion: null,
  geburtsdatum: null,
  firmaId: null,
  gruppeId: null,
  erstelltAm: new Date(),
  geaendertAm: new Date(),
  mitgliedsnr: "",
  eintritt: null,
  kanal: null,
  gruppeSeit: null,
  ...over,
});

describe("Gruppenquelle des Mail-Moduls (Personenmodul)", () => {
  it("liefert aktive Mitglieder der Gruppe mit E-Mail, nur des eigenen Mandanten", async () => {
    const store = createMemoryStore();
    await store.gruppen.insert({
      id: GRUPPE,
      kundeId: KUNDE,
      name: "Vorstand",
      beschreibung: null,
      erstelltAm: new Date(),
      geaendertAm: new Date(),
    });
    for (const m of [
      member("a", KUNDE, {}),
      member("b", KUNDE, { email: null }),
      member("c", KUNDE, { status: "archiviert" }),
      member("d", KUNDE, {}),
    ]) {
      await store.members.insert(m);
      if (m.id !== "d") await store.gruppen.assign(KUNDE, m.id, GRUPPE);
    }
    const lookup = peopleGroupLookup(store);
    const ctx = { tenantId: KUNDE, userId: "u", email: "u@example.test" };
    const rs = await lookup.membersOf(ctx, [GRUPPE]);
    expect(rs.map((r) => r.email)).toEqual(["a@example.test"]);
    expect(await lookup.membersOf({ ...ctx, tenantId: ANDERER }, [GRUPPE])).toEqual([]);
  });

  it("zählt je Gruppe aktive Personen und solche ohne E-Mail", async () => {
    const store = createMemoryStore();
    await store.gruppen.insert({
      id: GRUPPE,
      kundeId: KUNDE,
      name: "Vorstand",
      beschreibung: null,
      erstelltAm: new Date(),
      geaendertAm: new Date(),
    });
    for (const m of [
      member("a", KUNDE, {}),
      member("b", KUNDE, { email: null }),
      member("c", KUNDE, { status: "archiviert", email: null }),
    ]) {
      await store.members.insert(m);
      await store.gruppen.assign(KUNDE, m.id, GRUPPE);
    }
    const lookup = peopleGroupLookup(store);
    const ctx = { tenantId: KUNDE, userId: "u", email: "u@example.test" };
    expect(await lookup.groups(ctx)).toEqual([
      { id: GRUPPE, name: "Vorstand", persons: 2, withoutEmail: 1 },
    ]);
    expect(await lookup.groups({ ...ctx, tenantId: ANDERER })).toEqual([]);
  });

  it("löst Personen-IDs auf: nur aktive Personen des eigenen Mandanten, Unbekanntes fehlt", async () => {
    const store = createMemoryStore();
    await store.gruppen.insert({
      id: GRUPPE,
      kundeId: KUNDE,
      name: "Vorstand",
      beschreibung: null,
      erstelltAm: new Date(),
      geaendertAm: new Date(),
    });
    const eigene = "44444444-4444-4444-8444-444444444444";
    const archiviert = "55555555-5555-4555-8555-555555555555";
    const fremde = "66666666-6666-4666-8666-666666666666";
    await store.members.insert(
      member(eigene, KUNDE, { anrede: "frau", vorname: "Eva", nachname: "Muster", gruppeId: null }),
    );
    await store.gruppen.assign(KUNDE, eigene, GRUPPE);
    await store.members.insert(member(archiviert, KUNDE, { status: "archiviert" }));
    await store.members.insert(member(fremde, ANDERER, {}));
    const lookup = peopleGroupLookup(store);
    const ctx = { tenantId: KUNDE, userId: "u", email: "u@example.test" };
    const found = await lookup.people(ctx, [eigene, archiviert, fremde, "kein-uuid"]);
    expect(found).toEqual([
      {
        id: eigene,
        name: "Eva Muster",
        email: `${eigene}@example.test`,
        anrede: "Frau",
        vorname: "Eva",
        nachname: "Muster",
        group: "Vorstand",
      },
    ]);
  });
});

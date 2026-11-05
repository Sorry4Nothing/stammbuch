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
  anrede: null,
  vorname: "Vera",
  nachname: "Muster",
  email: `${id}@example.test`,
  telefon: null,
  mobil: null,
  adresse: null,
  notiz: null,
  funktion: null,
  firmaId: null,
  gruppeId: null,
  erstelltAm: new Date(),
  geaendertAm: new Date(),
  ...over,
});

describe("Gruppenquelle des Mail-Moduls (Personenmodul)", () => {
  it("liefert aktive Mitglieder der Gruppe mit E-Mail, nur des eigenen Mandanten", async () => {
    const store = createMemoryStore();
    await store.gruppen.insert({ id: GRUPPE, kundeId: KUNDE, name: "Vorstand" });
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
});

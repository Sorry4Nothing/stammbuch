import { afterAll, describe, expect, it } from "vitest";
import { createPostgresStore } from "./postgres-store.js";
import { KUNDE_A, KUNDE_B, closeAll, createDatabase } from "./postgres.test-support.js";
import { AccountingService } from "./service.js";

afterAll(closeAll);

const USER_A = "aaaaaaaa-0000-4000-8000-000000000001";
const USER_B = "bbbbbbbb-0000-4000-8000-000000000001";
const PERSON_A = "cccccccc-0000-4000-8000-000000000001";

// Erfundene Namen (SR-41).
describe("Namen aus Benutzer, Mitglied und Firma (PostgreSQL)", () => {
  it("löst Erfasser und Person mandantengetrennt auf und gibt fremde Namen nie heraus", async () => {
    const { db, owner } = await createDatabase();
    await owner.query(
      `INSERT INTO benutzer (id, kunde_id, email, name, passwort_hash) VALUES
        ($1, $3, 'a@example.test', 'Erika Muster', 'x'), ($2, $4, 'b@example.test', 'Bruno Beispiel', 'x')`,
      [USER_A, USER_B, KUNDE_A, KUNDE_B],
    );
    await owner.query(
      `INSERT INTO mitglied (kunde_id, id, typ, vorname, nachname) VALUES ($1, $2, 'einzel', 'Hanna', 'Probe')`,
      [KUNDE_A, PERSON_A],
    );
    const svc = new AccountingService(
      createPostgresStore(db),
      () => new Date("2026-06-15T10:00:00Z"),
    );
    const A = { tenantId: KUNDE_A, userId: USER_A };
    const B = { tenantId: KUNDE_B, userId: USER_B };
    const post = (ctx: typeof A) =>
      svc.postReceivable(ctx, {
        idempotencyKey: `key-${ctx.userId.slice(0, 8)}-1`,
        kind: "invoice",
        personId: PERSON_A,
        reference: "R-1",
        bookingDate: "2026-06-01",
        dueDate: "2026-07-01",
        counterLines: [{ accountCode: "3000", amount: 10_000 }],
      });
    await post(A);
    await post(B);

    const page = { offset: 0, limit: 10 };
    expect((await svc.listEntries(A, {}, page)).map((e) => e.createdByName)).toEqual([
      "Erika Muster",
    ]);
    expect((await svc.listEntries(B, {}, page)).map((e) => e.createdByName)).toEqual([
      "Bruno Beispiel",
    ]);

    // Kunde B kennt die Person nicht: kein Name, nur die Kennung.
    expect((await svc.personStatement(A, PERSON_A)).name).toBe("Hanna Probe");
    expect((await svc.personStatement(B, PERSON_A)).name).toBe(PERSON_A);
  });

  it("zählt und benennt über die Datenbank: Buchungszahl je Konto und Gesamtzahl", async () => {
    const { db } = await createDatabase();
    const svc = new AccountingService(createPostgresStore(db), () => new Date("2026-06-15"));
    const A = { tenantId: KUNDE_A, userId: USER_A };
    for (const n of [1, 2]) {
      await svc.postReceivable(A, {
        idempotencyKey: `key-zaehlen-${n}`,
        kind: "invoice",
        personId: "p1",
        reference: `R-${n}`,
        bookingDate: "2026-06-01",
        dueDate: "2026-07-01",
        // Zwei Zeilen auf demselben Erlöskonto: die Buchung zählt dort trotzdem einmal.
        counterLines: [
          { accountCode: "3000", amount: 6_000 },
          { accountCode: "3000", amount: 4_000 },
        ],
      });
    }
    const rows = (await svc.trialBalance(A, {})).rows;
    expect(rows.find((r) => r.code === "3000")?.entryCount).toBe(2);
    expect(rows.find((r) => r.code === "1100")?.entryCount).toBe(2);
    expect(await svc.countEntries(A, { accountCode: "3000" })).toEqual({ total: 2 });
  });
});

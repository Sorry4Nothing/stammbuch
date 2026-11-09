import type { Datenbank } from "@stammbuch/db";
import { createPostgresStore } from "../people/postgres.js";
import { type CollectiveSource, type GroupFeeStore, createCollectiveSource } from "./collective.js";

/** Beiträge je Gruppe in `rechnung_gruppenbeitrag`; Zeilensicherheit (RLS) und `kunde_id`-Bedingung trennen die Kunden. */
export function createPgGroupFeeStore(db: Datenbank): GroupFeeStore {
  return {
    async list(tenantId) {
      const rows = await db.withKunde(tenantId, (trx) =>
        trx
          .selectFrom("rechnung_gruppenbeitrag")
          .select(["gruppe_id", "beitrag_rappen"])
          .where("kunde_id", "=", tenantId)
          .execute(),
      );
      return new Map(rows.map((r) => [r.gruppe_id, Number(r.beitrag_rappen)]));
    },

    async set(tenantId, groupId, feeCents) {
      await db.withKunde(tenantId, async (trx) => {
        if (feeCents === null) {
          await trx
            .deleteFrom("rechnung_gruppenbeitrag")
            .where("kunde_id", "=", tenantId)
            .where("gruppe_id", "=", groupId)
            .execute();
          return;
        }
        await trx
          .insertInto("rechnung_gruppenbeitrag")
          .values({ kunde_id: tenantId, gruppe_id: groupId, beitrag_rappen: feeCents })
          .onConflict((oc) =>
            oc.columns(["kunde_id", "gruppe_id"]).doUpdateSet({
              beitrag_rappen: feeCents,
              geaendert_am: new Date(),
            }),
          )
          .execute();
      });
    },
  };
}

export const createPgCollectiveSource = (db: Datenbank): CollectiveSource =>
  createCollectiveSource(createPostgresStore(db), createPgGroupFeeStore(db));

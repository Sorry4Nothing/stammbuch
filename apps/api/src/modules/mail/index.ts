import { createMailRuntime, MailService, noGroups } from "@stammbuch/mail";
import type { GroupLookup, Recipient } from "@stammbuch/mail";
import type { Datenbank } from "@stammbuch/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { errorHandler } from "../../lib/errors.js";
import { createPostgresStore } from "../people/postgres.js";
import type { PeopleStore } from "../people/repository.js";
import { registerMailRoutes, type ContextResolver } from "./routes.js";

export const name = "mail";

declare module "fastify" {
  interface FastifyInstance {
    /** Überschreibt die Anmeldung des Mail-Moduls (Tests). Standard: `sessionContext` über `app.authenticateRequest`. */
    resolveMailContext?: ContextResolver;
    /** Überschreibt die Gruppenquelle (Tests). Standard: Gruppen des Personenmoduls (#6), sonst keine Empfänger. */
    mailGroupLookup?: GroupLookup;
  }
}

/**
 * Mandant und Benutzer aus der Sitzung (#4, nur Rolle user: der Chef-Admin sieht keine Kundendaten), dazu die
 * eigene Adresse aus `benutzer`. Ohne Anmeldung oder Datenbank `null` (fail closed).
 */
export function sessionContext(app: FastifyInstance): ContextResolver {
  return async (req) => {
    const auth = await app.authenticateRequest(req);
    if (auth?.rolle !== "user" || !app.db) return null;
    const row = await app.db.withKunde(auth.tenantId, (trx) =>
      trx.selectFrom("benutzer").select("email").where("id", "=", auth.userId).executeTakeFirst(),
    );
    return row ? { tenantId: auth.tenantId, userId: auth.userId, email: row.email } : null;
  };
}

/** Empfänger einer Gruppe: aktive Personen des Mandanten mit E-Mail-Adresse (Personenmodul, #6). */
export function peopleGroupLookup(store: PeopleStore): GroupLookup {
  return {
    async membersOf(ctx, groupIds) {
      const out: Recipient[] = [];
      for (const gruppeId of groupIds) {
        let after: string | undefined;
        do {
          const page = await store.members.list(ctx.tenantId, {
            limit: 200,
            status: "aktiv",
            gruppeId,
            ...(after ? { after } : {}),
          });
          for (const m of page.items) {
            if (m.email) {
              out.push({
                email: m.email,
                anrede: m.anrede ?? undefined,
                vorname: m.vorname,
                nachname: m.nachname,
              });
            }
          }
          after = page.next ?? undefined;
        } while (after);
      }
      return out;
    },
  };
}

export async function register(app: FastifyInstance) {
  const db: Datenbank | undefined = app.db;
  const runtime = createMailRuntime();
  if (!runtime) {
    app.log.warn("Mail-Modul aus: MAIL_ENCRYPTION_KEYS ist nicht gesetzt");
    return;
  }
  const groups = db ? peopleGroupLookup(createPostgresStore(db)) : noGroups;
  const sessionResolver = sessionContext(app);
  const service = new MailService({
    repos: runtime.repos,
    box: runtime.box,
    connections: runtime.connections,
    // Lazy: die Gruppenquelle (#3) darf nach diesem Modul registriert werden.
    groups: {
      membersOf: (ctx, ids) => (app.mailGroupLookup ?? groups).membersOf(ctx, ids),
    },
    config: runtime.service,
  });
  await registerMailRoutes(app, {
    service,
    resolveContext: (req: FastifyRequest) => (app.resolveMailContext ?? sessionResolver)(req),
    onError: errorHandler,
  });
}

export { registerMailRoutes } from "./routes.js";
export type { ContextResolver, MailRouteDeps } from "./routes.js";
export type { MailPort } from "@stammbuch/mail";

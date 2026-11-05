import {
  createMailRuntime,
  createPostgresMailRepositories,
  MailService,
  noGroups,
} from "@stammbuch/mail";
import type { GroupLookup, MailContext, Recipient } from "@stammbuch/mail";
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

/** Mail-Kontext eines Benutzers: Mandant, Benutzer und dessen eigene Adresse aus `benutzer`. */
export async function mailContextFor(
  db: Datenbank,
  tenantId: string,
  userId: string,
): Promise<MailContext | null> {
  const row = await db.withKunde(tenantId, (trx) =>
    trx.selectFrom("benutzer").select("email").where("id", "=", userId).executeTakeFirst(),
  );
  return row ? { tenantId, userId, email: row.email } : null;
}

/**
 * Mandant und Benutzer aus der Sitzung (#4, nur Rolle user: der Chef-Admin sieht keine Kundendaten), dazu die
 * eigene Adresse aus `benutzer`. Ohne Anmeldung oder Datenbank `null` (fail closed).
 */
export function sessionContext(app: FastifyInstance): ContextResolver {
  return async (req) => {
    const auth = await app.authenticateRequest(req);
    if (auth?.rolle !== "user" || !app.db) return null;
    return mailContextFor(app.db, auth.tenantId, auth.userId);
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

/**
 * Baut den Mail-Dienst aus der Umgebung. Mit Datenbank liegt der Stand in PostgreSQL (derselbe wie im Worker,
 * deshalb dürfen mehrere Instanzen nebeneinander laufen, etwa im Kalender); ohne Datenbank flüchtig im Speicher
 * (nur Entwicklung und Tests). `null`, wenn kein Schlüssel konfiguriert ist: Mail bleibt dann aus.
 */
export function createMailService(
  db: Datenbank | undefined,
  groups: GroupLookup = noGroups,
): MailService | null {
  const runtime = createMailRuntime(
    process.env,
    db ? createPostgresMailRepositories(db) : undefined,
  );
  if (!runtime) return null;
  return new MailService({
    repos: runtime.repos,
    box: runtime.box,
    connections: runtime.connections,
    groups,
    config: runtime.service,
  });
}

export async function register(app: FastifyInstance) {
  const db: Datenbank | undefined = app.db;
  const groups = db ? peopleGroupLookup(createPostgresStore(db)) : noGroups;
  const sessionResolver = sessionContext(app);
  const service = createMailService(db, {
    // Lazy: die Gruppenquelle (#3) darf nach diesem Modul registriert werden.
    membersOf: (ctx, ids) => (app.mailGroupLookup ?? groups).membersOf(ctx, ids),
  });
  if (!service) {
    app.log.warn("Mail-Modul aus: MAIL_ENCRYPTION_KEYS ist nicht gesetzt");
    return;
  }
  await registerMailRoutes(app, {
    service,
    resolveContext: (req: FastifyRequest) => (app.resolveMailContext ?? sessionResolver)(req),
    onError: errorHandler,
  });
}

export { registerMailRoutes } from "./routes.js";
export type { ContextResolver, MailRouteDeps } from "./routes.js";
export type { MailPort } from "@stammbuch/mail";

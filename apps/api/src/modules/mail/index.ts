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
import { record } from "../../platform/helpers.js";
import { createPostgresStore } from "../people/postgres.js";
import type { PeopleStore } from "../people/repository.js";
import type { Platform } from "../../platform/index.js";
import { registerMailRoutes, type ContextResolver, type MailAudit } from "./routes.js";

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
    trx
      .selectFrom("benutzer")
      .select(["email", "name"])
      .where("id", "=", userId)
      .executeTakeFirst(),
  );
  return row ? { tenantId, userId, email: row.email, name: row.name } : null;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANREDE = { frau: "Frau", herr: "Herr" } as const;
/** Gleichzeitige Abfragen beim Auflösen von Personen-IDs. */
const RESOLVE_PARALLEL = 20;

/** Aktive Personen einer Gruppe, seitenweise (Personenmodul, #6). */
async function* activeMembers(store: PeopleStore, tenantId: string, gruppeId: string) {
  let after: string | undefined;
  do {
    const page = await store.members.list(tenantId, {
      limit: 200,
      status: "aktiv",
      gruppeId,
      ...(after ? { after } : {}),
    });
    yield* page.items;
    after = page.next ?? undefined;
  } while (after);
}

/**
 * Quelle der Gruppen und Personen für Adresslisten: aktive Personen des Mandanten (Personenmodul, #6).
 * shortcut: Personen werden einzeln gelesen (`members.get`), Gruppenzahlen durch Blättern gezählt; bei sehr grossen
 * Beständen auf eine Sammelabfrage im Personenmodul umstellen.
 */
export function peopleGroupLookup(store: PeopleStore): GroupLookup {
  return {
    async groups(ctx) {
      const out = [];
      for (const g of await store.gruppen.list(ctx.tenantId)) {
        let persons = 0;
        let withoutEmail = 0;
        for await (const m of activeMembers(store, ctx.tenantId, g.id)) {
          persons++;
          if (!m.email) withoutEmail++;
        }
        out.push({ id: g.id, name: g.name, persons, withoutEmail });
      }
      return out;
    },

    async people(ctx, ids) {
      const groupNames = new Map<string, string | null>();
      const groupName = async (id: string | null) => {
        if (!id) return null;
        if (!groupNames.has(id)) {
          groupNames.set(id, (await store.gruppen.get(ctx.tenantId, id))?.name ?? null);
        }
        return groupNames.get(id) ?? null;
      };
      // Was keine UUID ist, existiert nicht (statt eines Datenbankfehlers).
      const valid = ids.filter((id) => UUID.test(id));
      const out = [];
      for (let i = 0; i < valid.length; i += RESOLVE_PARALLEL) {
        const found = await Promise.all(
          valid.slice(i, i + RESOLVE_PARALLEL).map((id) => store.members.get(ctx.tenantId, id)),
        );
        for (const m of found) {
          if (m?.status !== "aktiv") continue;
          const anrede = m.anrede ? ANREDE[m.anrede as keyof typeof ANREDE] : undefined;
          out.push({
            id: m.id,
            name: `${m.vorname} ${m.nachname}`.trim(),
            email: m.email,
            anrede,
            vorname: m.vorname,
            nachname: m.nachname,
            group: await groupName(m.gruppeId),
          });
        }
      }
      return out;
    },

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

/** Kundenprotokoll (wie die Einstellungen): wer, was, woran. Das Ziel ist eine ID oder ein Ordner, nie Inhalt oder Adresse. */
export function mailAudit(platform: Pick<Platform, "audit" | "clock">): MailAudit {
  return (ctx, action, target) =>
    record(
      platform.audit,
      platform.clock,
      ctx.tenantId,
      {
        kind: "customer",
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        email: ctx.email,
        role: "user",
      },
      action,
      target,
    );
}

export async function register(app: FastifyInstance) {
  const db: Datenbank | undefined = app.db;
  const groups = db ? peopleGroupLookup(createPostgresStore(db)) : noGroups;
  const sessionResolver = sessionContext(app);
  const service = createMailService(db, {
    // Lazy: die Gruppenquelle (#3) darf nach diesem Modul registriert werden.
    membersOf: (ctx, ids) => (app.mailGroupLookup ?? groups).membersOf(ctx, ids),
    groups: (ctx) => (app.mailGroupLookup ?? groups).groups(ctx),
    people: (ctx, ids) => (app.mailGroupLookup ?? groups).people(ctx, ids),
  });
  if (!service) {
    app.log.warn("Mail-Modul aus: MAIL_ENCRYPTION_KEYS ist nicht gesetzt");
    return;
  }
  await registerMailRoutes(app, {
    service,
    resolveContext: (req: FastifyRequest) => (app.resolveMailContext ?? sessionResolver)(req),
    audit: mailAudit(app.platform),
    onError: errorHandler,
  });
}

export { registerMailRoutes } from "./routes.js";
export type { ContextResolver, MailAudit, MailRouteDeps } from "./routes.js";
export type { MailPort } from "@stammbuch/mail";

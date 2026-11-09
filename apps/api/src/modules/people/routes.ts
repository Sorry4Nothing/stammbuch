import {
  bulkActionSchema,
  firmaCreateSchema,
  firmaListQuerySchema,
  firmaMergeSchema,
  firmaUpdateSchema,
  gruppeInputSchema,
  memberCreateSchema,
  memberListQuerySchema,
  memberUpdateSchema,
  publicFirmaRegistrationSchema,
  publicFirmaSearchSchema,
  publicPersonRegistrationSchema,
  registrationConfirmSchema,
} from "@stammbuch/shared";
import type {
  BulkResult,
  DuplicateCandidate,
  FirmaDto,
  GruppeDto,
  MemberDto,
} from "@stammbuch/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { validate } from "../../lib/validate.js";
import type { ApiModule } from "../types.js";
import { CSV_MAX_BYTES, exportMembersCsv, importMembersCsv } from "./csv.js";
import type { Clock, Ctx, Firma, Member } from "./domain.js";
import type { DuplicateMatch } from "./duplicates.js";
import { RegistrationService } from "./registration.js";
import type { RegistrationMailer } from "./registration.js";
import type { PeopleStore } from "./repository.js";
import { PeopleService } from "./service.js";

export interface PeopleDeps {
  store: PeopleStore;
  /**
   * Löst den Mandanten aus der serverseitigen Session auf (SR-13). Gibt `undefined` zurück,
   * wenn niemand angemeldet ist. Der Auth-Baustein liefert die echte Implementierung.
   */
  resolveContext(req: FastifyRequest): Promise<Ctx | undefined>;
  /** Mandanten-Kennung aus der öffentlichen URL -> kundeId. */
  resolveTenant(slug: string): Promise<string | undefined>;
  mailer: RegistrationMailer;
  /** Geheimnis für Formular-Tokens (SR-30). */
  formSecret: Buffer;
  now?: Clock;
}

const idParam = z.object({ id: z.uuid() });
const slugParam = z.object({ kunde: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/) });
const importQuery = z.object({
  dryRun: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

const iso = (d: Date) => d.toISOString();
const encodeCursor = (key: string | null) =>
  key === null ? null : Buffer.from(key, "utf8").toString("base64url");
const decodeCursor = (c: string | undefined) =>
  c === undefined ? undefined : Buffer.from(c, "base64url").toString("utf8");

// Explizite DTOs statt ganzer Entities (SR-74): kundeId und Interna verlassen den Server nie.
function memberDto(m: Member, firmaName: string | null): MemberDto {
  return {
    id: m.id,
    typ: m.typ,
    status: m.status,
    anrede: m.anrede,
    vorname: m.vorname,
    nachname: m.nachname,
    email: m.email,
    telefon: m.telefon,
    mobil: m.mobil,
    adresse: m.adresse,
    notiz: m.notiz,
    funktion: m.funktion,
    geburtsdatum: m.geburtsdatum,
    firmaId: m.firmaId,
    firmaName,
    gruppeId: m.gruppeId,
    erstelltAm: iso(m.erstelltAm),
    geaendertAm: iso(m.geaendertAm),
  };
}

function firmaDto(f: Firma): FirmaDto {
  return {
    id: f.id,
    name: f.name,
    uid: f.uid,
    mwstNr: f.mwstNr,
    adresse: f.adresse,
    email: f.email,
    telefon: f.telefon,
    kontaktperson: f.kontaktperson,
    status: f.status,
    zusammengefuehrtMit: f.zusammengefuehrtMit,
    erstelltAm: iso(f.erstelltAm),
  };
}

const duplicateDto = (d: DuplicateMatch): DuplicateCandidate => ({
  firma: firmaDto(d.firma),
  score: Math.round(d.score * 100) / 100,
  gruende: d.gruende,
});

export function createPeopleModule(deps: PeopleDeps): ApiModule {
  const people = new PeopleService(deps.store, deps.now);
  const registration = new RegistrationService(
    people,
    deps.mailer,
    { secret: deps.formSecret },
    deps.now,
  );
  const contexts = new WeakMap<FastifyRequest, Ctx>();
  const ctxOf = (req: FastifyRequest): Ctx => {
    const ctx = contexts.get(req);
    if (!ctx) throw new AppError(401); // Deny by default (SR-12, SR-54)
    return ctx;
  };

  const firmaNames = async (kundeId: string, members: Member[]) => {
    const ids = [...new Set(members.flatMap((m) => (m.firmaId ? [m.firmaId] : [])))];
    return new Map((await deps.store.firmen.getMany(kundeId, ids)).map((f) => [f.id, f.name]));
  };
  const toMemberDto = async (kundeId: string, m: Member) =>
    memberDto(m, (await firmaNames(kundeId, [m])).get(m.firmaId ?? "") ?? null);

  /** Admin-Aktionen protokollieren (SR-52): nur IDs, keine Personendaten (SR-50). */
  const audit = (req: FastifyRequest, aktion: string, objektId?: string) =>
    req.log.info(
      {
        audit: { aktion, kundeId: ctxOf(req).kundeId, benutzerId: ctxOf(req).benutzerId, objektId },
      },
      "Audit",
    );

  return {
    name: "people",
    register(app: FastifyInstance) {
      // Geschützter Bereich: jede Route darin verlangt eine Anmeldung. Kein Handler läuft ohne Kontext.
      app.register(async (admin) => {
        admin.addHook("onRequest", async (req) => {
          const ctx = await deps.resolveContext(req);
          if (!ctx) throw new AppError(401);
          contexts.set(req, ctx);
        });
        admin.addContentTypeParser(
          "text/csv",
          { parseAs: "string", bodyLimit: CSV_MAX_BYTES },
          (_req, body, done) => done(null, body),
        );

        // Mitglieder

        admin.get("/api/mitglieder", async (req) => {
          const { kundeId } = ctxOf(req);
          const q = validate(memberListQuerySchema, req.query);
          const page = await deps.store.members.list(kundeId, {
            ...q,
            after: decodeCursor(q.cursor),
          });
          const names = await firmaNames(kundeId, page.items);
          return {
            items: page.items.map((m) => memberDto(m, names.get(m.firmaId ?? "") ?? null)),
            nextCursor: encodeCursor(page.next),
          };
        });

        admin.post("/api/mitglieder", async (req, reply) => {
          const ctx = ctxOf(req);
          const m = await people.createMember(ctx.kundeId, validate(memberCreateSchema, req.body));
          audit(req, "mitglied.anlegen", m.id);
          return reply.status(201).send(await toMemberDto(ctx.kundeId, m));
        });

        admin.get("/api/mitglieder/export.csv", async (req, reply) => {
          const ctx = ctxOf(req);
          const filter = validate(memberListQuerySchema, req.query);
          audit(req, "mitglied.export");
          return reply
            .header("content-type", "text/csv; charset=utf-8")
            .header("content-disposition", 'attachment; filename="mitglieder.csv"')
            .header("cache-control", "no-store")
            .send(await exportMembersCsv(people, ctx, filter));
        });

        admin.post("/api/mitglieder/import", { bodyLimit: CSV_MAX_BYTES }, async (req) => {
          const ctx = ctxOf(req);
          const { dryRun } = validate(importQuery, req.query);
          const csv = validate(z.string().min(1), req.body);
          const report = await importMembersCsv(people, ctx, csv, dryRun);
          if (!dryRun) audit(req, "mitglied.import");
          return report;
        });

        admin.post("/api/mitglieder/sammelaktion", async (req): Promise<BulkResult> => {
          const result = await people.bulk(ctxOf(req), validate(bulkActionSchema, req.body));
          audit(req, "mitglied.sammelaktion");
          return result;
        });

        admin.get("/api/mitglieder/:id", async (req) => {
          const ctx = ctxOf(req);
          const { id } = validate(idParam, req.params);
          return toMemberDto(ctx.kundeId, await people.getMember(ctx, id));
        });

        admin.patch("/api/mitglieder/:id", async (req) => {
          const ctx = ctxOf(req);
          const { id } = validate(idParam, req.params);
          const m = await people.updateMember(ctx, id, validate(memberUpdateSchema, req.body));
          audit(req, "mitglied.aendern", id);
          return toMemberDto(ctx.kundeId, m);
        });

        admin.put("/api/mitglieder/:id/gruppe", async (req, reply) => {
          const { id } = validate(idParam, req.params);
          const { gruppeId } = validate(z.object({ gruppeId: z.uuid() }), req.body);
          await people.assignToGruppe(ctxOf(req), id, gruppeId);
          audit(req, "gruppe.zuweisen", id);
          return reply.status(204).send();
        });

        admin.delete("/api/mitglieder/:id/gruppe", async (req, reply) => {
          const { id } = validate(idParam, req.params);
          await people.removeFromGruppe(ctxOf(req), id);
          audit(req, "gruppe.entfernen", id);
          return reply.status(204).send();
        });

        // Gruppen

        admin.get("/api/gruppen", async (req): Promise<{ items: GruppeDto[] }> => {
          const list = await deps.store.gruppen.list(ctxOf(req).kundeId);
          return { items: list.map((g) => ({ id: g.id, name: g.name, mitglieder: g.mitglieder })) };
        });

        admin.post("/api/gruppen", async (req, reply) => {
          const { name } = validate(gruppeInputSchema, req.body);
          const g = await people.createGruppe(ctxOf(req), name);
          audit(req, "gruppe.anlegen", g.id);
          return reply.status(201).send({ id: g.id, name: g.name, mitglieder: 0 });
        });

        admin.patch("/api/gruppen/:id", async (req, reply) => {
          const { id } = validate(idParam, req.params);
          const { name } = validate(gruppeInputSchema, req.body);
          await people.renameGruppe(ctxOf(req), id, name);
          audit(req, "gruppe.umbenennen", id);
          return reply.status(204).send();
        });

        admin.delete("/api/gruppen/:id", async (req, reply) => {
          const { id } = validate(idParam, req.params);
          await people.dissolveGruppe(ctxOf(req), id);
          audit(req, "gruppe.aufloesen", id);
          return reply.status(204).send();
        });

        // Firmenregister

        admin.get("/api/firmen", async (req) => {
          const q = validate(firmaListQuerySchema, req.query);
          const page = await deps.store.firmen.list(ctxOf(req).kundeId, {
            ...q,
            after: decodeCursor(q.cursor),
          });
          return { items: page.items.map(firmaDto), nextCursor: encodeCursor(page.next) };
        });

        admin.post("/api/firmen", async (req, reply) => {
          const f = await people.createFirma(
            ctxOf(req).kundeId,
            validate(firmaCreateSchema, req.body),
          );
          audit(req, "firma.anlegen", f.id);
          return reply.status(201).send(firmaDto(f));
        });

        // Vorab-Prüfung vor dem Anlegen: liefert mögliche Duplikate, speichert nichts.
        admin.post("/api/firmen/duplikate", async (req) => {
          const input = validate(firmaCreateSchema, req.body);
          const found = await people.duplicatesFor(ctxOf(req), {
            name: input.name,
            uid: input.uid ?? null,
            mwstNr: input.mwstNr ?? null,
            adresse: input.adresse,
          });
          return { items: found.map(duplicateDto) };
        });

        admin.get("/api/firmen/:id", async (req) => {
          const { id } = validate(idParam, req.params);
          return firmaDto(await people.getFirma(ctxOf(req), id));
        });

        admin.patch("/api/firmen/:id", async (req) => {
          const { id } = validate(idParam, req.params);
          const f = await people.updateFirma(ctxOf(req), id, validate(firmaUpdateSchema, req.body));
          audit(req, "firma.aendern", id);
          return firmaDto(f);
        });

        admin.get("/api/firmen/:id/duplikate", async (req) => {
          const ctx = ctxOf(req);
          const { id } = validate(idParam, req.params);
          const f = await people.getFirma(ctx, id);
          return { items: (await people.duplicatesFor(ctx, f, id)).map(duplicateDto) };
        });

        admin.post("/api/firmen/:id/zusammenfuehren", async (req) => {
          const { id } = validate(idParam, req.params);
          const { quelleId } = validate(firmaMergeSchema, req.body);
          const f = await people.mergeFirmen(ctxOf(req), id, quelleId);
          audit(req, "firma.zusammenfuehren", id);
          return firmaDto(f);
        });

        for (const [pfad, freigeben] of [
          ["freigeben", true],
          ["ablehnen", false],
        ] as const) {
          admin.post(`/api/firmen/:id/${pfad}`, async (req) => {
            const { id } = validate(idParam, req.params);
            const f = await people.setFirmaFreigabe(ctxOf(req), id, freigeben);
            audit(req, `firma.${pfad}`, id);
            return firmaDto(f);
          });
        }
      });

      // Öffentlicher Bereich (ohne Login): eng limitiert (SR-71), Mandant aus der URL.
      app.register(async (pub) => {
        const tenant = async (req: FastifyRequest) => {
          const { kunde } = validate(slugParam, req.params);
          const kundeId = await deps.resolveTenant(kunde);
          if (!kundeId) throw new AppError(404);
          return { kundeId, kunde };
        };
        const limit = (max: number, timeWindow: string) => ({
          config: { rateLimit: { max, timeWindow } },
        });

        pub.get(
          "/public/:kunde/registrierung/formular",
          limit(30, "1 hour"),
          async (req, reply) => {
            const formToken = registration.issueFormToken((await tenant(req)).kundeId);
            return reply.header("cache-control", "no-store").send({ formToken });
          },
        );

        pub.get("/public/:kunde/firmen", limit(30, "1 minute"), async (req) => {
          const { kundeId } = await tenant(req);
          const { q } = validate(publicFirmaSearchSchema, req.query);
          const page = await deps.store.firmen.list(kundeId, {
            limit: 20,
            q,
            status: "freigegeben",
          });
          return { items: page.items.map((f) => ({ id: f.id, name: f.name, ort: f.adresse.ort })) };
        });

        pub.post("/public/:kunde/registrierung/person", limit(5, "1 hour"), async (req, reply) => {
          const { kundeId, kunde } = await tenant(req);
          const body = validate(publicPersonRegistrationSchema, req.body);
          return reply.status(202).send(await registration.registerPerson(kundeId, kunde, body));
        });

        pub.post("/public/:kunde/registrierung/firma", limit(5, "1 hour"), async (req, reply) => {
          const { kundeId, kunde } = await tenant(req);
          const body = validate(publicFirmaRegistrationSchema, req.body);
          return reply.status(202).send(await registration.registerFirma(kundeId, kunde, body));
        });

        pub.post("/public/:kunde/registrierung/bestaetigen", limit(20, "1 hour"), async (req) => {
          const { kundeId, kunde } = await tenant(req);
          const { token } = validate(registrationConfirmSchema, req.body);
          await registration.confirm(kundeId, kunde, token);
          return { status: "bestaetigt" as const };
        });
      });
    },
  };
}

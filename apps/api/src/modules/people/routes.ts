import {
  bulkActionSchema,
  duplikatIdSchema,
  duplikatMergeSchema,
  firmaCreateSchema,
  firmaListQuerySchema,
  firmaMergeSchema,
  firmaUpdateSchema,
  gruppeInputSchema,
  gruppeUpdateSchema,
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
  DuplikatDto,
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
import type { Clock, Ctx, Firma, Gruppe, Member } from "./domain.js";
import type { DuplicateMatch } from "./duplicates.js";
import { RegistrationService } from "./registration.js";
import type { RegistrationMailer } from "./registration.js";
import type { PeopleStore } from "./repository.js";
import { PeopleService } from "./service.js";
import type { DuplikatPaar } from "./service.js";

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
const bool = (fallback: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(fallback)
    .transform((v) => v === "true");
const importQuery = z.object({
  dryRun: bool("true"),
  aktualisieren: bool("false"),
  duplikate: z.enum(["fehler", "ueberspringen"]).default("fehler"),
  gruppeId: z.uuid().optional(),
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
    mitgliedsnr: m.mitgliedsnr,
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
    geburtsdatum: m.geburtsdatum,
    eintritt: m.eintritt,
    kanal: m.kanal,
    funktion: m.funktion,
    firmaId: m.firmaId,
    firmaName,
    gruppeId: m.gruppeId,
    gruppeSeit: m.gruppeSeit && iso(m.gruppeSeit),
    erstelltAm: iso(m.erstelltAm),
    geaendertAm: iso(m.geaendertAm),
  };
}

function gruppeDto(g: Gruppe, mitglieder: number, adresslisten: string[]): GruppeDto {
  return {
    id: g.id,
    name: g.name,
    mitglieder,
    beschreibung: g.beschreibung,
    erstelltAm: iso(g.erstelltAm),
    geaendertAm: iso(g.geaendertAm),
    adresslisten,
  };
}

function firmaDto(f: Firma, mitglieder: number): FirmaDto {
  return {
    id: f.id,
    name: f.name,
    uid: f.uid,
    mwstNr: f.mwstNr,
    adresse: f.adresse,
    email: f.email,
    telefon: f.telefon,
    status: f.status,
    zusammengefuehrtMit: f.zusammengefuehrtMit,
    erstelltAm: iso(f.erstelltAm),
    kontaktperson: f.kontaktperson,
    rechnungsEmail: f.rechnungsEmail,
    notiz: f.notiz,
    quelle: f.quelle,
    mitglieder,
  };
}

/** Felder, die beim Zusammenführen zur Wahl stehen; nur gesetzte Werte erscheinen. */
function duplikatFelder(f: Firma): DuplikatDto["a"]["felder"] {
  const a = f.adresse;
  const felder = {
    name: f.name,
    uid: f.uid,
    mwstNr: f.mwstNr,
    strasse: [a.strasse, a.hausnr].filter(Boolean).join(" "),
    plzOrt: `${a.plz} ${a.ort}`,
    email: f.email,
    telefon: f.telefon,
  };
  return Object.fromEntries(Object.entries(felder).filter(([, v]) => v));
}

const TREFFER = { uid: "uid", mwst: "mwst", name: "name", name_aehnlich: "name" } as const;

function duplikatDto(p: DuplikatPaar, counts: Map<string, number>): DuplikatDto {
  const eintrag = (f: Firma) => ({
    id: f.id,
    name: f.name,
    mitglieder: counts.get(f.id) ?? 0,
    felder: duplikatFelder(f),
  });
  return {
    id: p.id,
    art: "firma",
    a: eintrag(p.a),
    b: eintrag(p.b),
    trefferBei: [...new Set(p.gruende.flatMap((g) => (g === "adresse" ? [] : [TREFFER[g]])))],
    aehnlichkeit: Math.round(p.score * 100),
    status: p.status,
  };
}

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
  const firmaDtos = async (kundeId: string, list: Firma[]): Promise<FirmaDto[]> => {
    const counts = await deps.store.firmen.countMitglieder(
      kundeId,
      list.map((f) => f.id),
    );
    return list.map((f) => firmaDto(f, counts.get(f.id) ?? 0));
  };
  const toFirmaDto = async (kundeId: string, f: Firma) =>
    (await firmaDtos(kundeId, [f]))[0] as FirmaDto;
  const duplicateDtos = async (
    kundeId: string,
    found: DuplicateMatch[],
  ): Promise<DuplicateCandidate[]> => {
    const dtos = await firmaDtos(
      kundeId,
      found.map((d) => d.firma),
    );
    return found.map((d, i) => ({
      firma: dtos[i] as FirmaDto,
      score: Math.round(d.score * 100) / 100,
      gruende: d.gruende,
    }));
  };

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
            total: page.total,
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
          const { dryRun, ...options } = validate(importQuery, req.query);
          const csv = validate(z.string().min(1), req.body);
          const report = await importMembersCsv(people, ctx, csv, dryRun, options);
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
          return { items: list.map((g) => gruppeDto(g, g.mitglieder, g.adresslisten)) };
        });

        admin.post("/api/gruppen", async (req, reply) => {
          const { name, beschreibung } = validate(gruppeInputSchema, req.body);
          const g = await people.createGruppe(ctxOf(req), name, beschreibung);
          audit(req, "gruppe.anlegen", g.id);
          return reply.status(201).send(gruppeDto(g, 0, []));
        });

        // Teiländerung: nur genannte Felder ändern sich; ohne Feld ist die Anfrage ungültig.
        admin.patch("/api/gruppen/:id", async (req, reply) => {
          const { id } = validate(idParam, req.params);
          const patch = validate(gruppeUpdateSchema, req.body);
          await people.updateGruppe(ctxOf(req), id, patch);
          audit(req, "gruppe.aendern", id);
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
          return {
            items: await firmaDtos(ctxOf(req).kundeId, page.items),
            nextCursor: encodeCursor(page.next),
            total: page.total,
          };
        });

        admin.post("/api/firmen", async (req, reply) => {
          const { kundeId } = ctxOf(req);
          const f = await people.createFirma(kundeId, validate(firmaCreateSchema, req.body));
          audit(req, "firma.anlegen", f.id);
          return reply.status(201).send(await toFirmaDto(kundeId, f));
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
          return { items: await duplicateDtos(ctxOf(req).kundeId, found) };
        });

        admin.get("/api/firmen/:id", async (req) => {
          const ctx = ctxOf(req);
          const { id } = validate(idParam, req.params);
          return toFirmaDto(ctx.kundeId, await people.getFirma(ctx, id));
        });

        admin.patch("/api/firmen/:id", async (req) => {
          const ctx = ctxOf(req);
          const { id } = validate(idParam, req.params);
          const f = await people.updateFirma(ctx, id, validate(firmaUpdateSchema, req.body));
          audit(req, "firma.aendern", id);
          return toFirmaDto(ctx.kundeId, f);
        });

        admin.get("/api/firmen/:id/duplikate", async (req) => {
          const ctx = ctxOf(req);
          const { id } = validate(idParam, req.params);
          const f = await people.getFirma(ctx, id);
          return {
            items: await duplicateDtos(ctx.kundeId, await people.duplicatesFor(ctx, f, id)),
          };
        });

        admin.post("/api/firmen/:id/zusammenfuehren", async (req) => {
          const ctx = ctxOf(req);
          const { id } = validate(idParam, req.params);
          const { quelleId } = validate(firmaMergeSchema, req.body);
          const f = await people.mergeFirmen(ctx, id, quelleId);
          audit(req, "firma.zusammenfuehren", id);
          return toFirmaDto(ctx.kundeId, f);
        });

        // Duplikate über das ganze Register (Paare, Kennung `<idA>_<idB>`).

        const duplikatDtos = async (kundeId: string, paare: DuplikatPaar[]) => {
          const counts = await deps.store.firmen.countMitglieder(
            kundeId,
            paare.flatMap((p) => [p.a.id, p.b.id]),
          );
          return paare.map((p) => duplikatDto(p, counts));
        };
        const duplikatParam = z.object({ id: duplikatIdSchema });

        admin.get("/api/duplikate", async (req) => {
          const ctx = ctxOf(req);
          return { items: await duplikatDtos(ctx.kundeId, await people.listDuplikate(ctx)) };
        });

        admin.get("/api/duplikate/:id", async (req) => {
          const ctx = ctxOf(req);
          const { id } = validate(duplikatParam, req.params);
          return (await duplikatDtos(ctx.kundeId, [await people.getDuplikat(ctx, id)]))[0];
        });

        admin.post("/api/duplikate/:id/kein-duplikat", async (req, reply) => {
          const { id } = validate(duplikatParam, req.params);
          await people.markKeinDuplikat(ctxOf(req), id);
          audit(req, "firma.kein_duplikat", id);
          return reply.status(204).send();
        });

        admin.post("/api/duplikate/:id/zusammenfuehren", async (req) => {
          const ctx = ctxOf(req);
          const { id } = validate(duplikatParam, req.params);
          const f = await people.mergeDuplikat(ctx, id, validate(duplikatMergeSchema, req.body));
          audit(req, "firma.zusammenfuehren", f.id);
          return toFirmaDto(ctx.kundeId, f);
        });

        for (const [pfad, freigeben] of [
          ["freigeben", true],
          ["ablehnen", false],
        ] as const) {
          admin.post(`/api/firmen/:id/${pfad}`, async (req) => {
            const { id } = validate(idParam, req.params);
            const f = await people.setFirmaFreigabe(ctxOf(req), id, freigeben);
            audit(req, `firma.${pfad}`, id);
            return toFirmaDto(ctxOf(req).kundeId, f);
          });
        }
      });

      // Öffentlicher Bereich (ohne Login): eng limitiert (SR-71), Mandant aus der URL.
      app.register(async (pub) => {
        const tenant = async (req: FastifyRequest) => {
          const { kunde } = validate(slugParam, req.params);
          const kundeId = await deps.resolveTenant(kunde);
          if (!kundeId) throw new AppError(404);
          return kundeId;
        };
        const limit = (max: number, timeWindow: string) => ({
          config: { rateLimit: { max, timeWindow } },
        });

        pub.get(
          "/public/:kunde/registrierung/formular",
          limit(30, "1 hour"),
          async (req, reply) => {
            const formToken = registration.issueFormToken(await tenant(req));
            return reply.header("cache-control", "no-store").send({ formToken });
          },
        );

        pub.get("/public/:kunde/firmen", limit(30, "1 minute"), async (req) => {
          const kundeId = await tenant(req);
          const { q } = validate(publicFirmaSearchSchema, req.query);
          const page = await deps.store.firmen.list(kundeId, {
            limit: 20,
            q,
            status: "freigegeben",
          });
          return { items: page.items.map((f) => ({ id: f.id, name: f.name, ort: f.adresse.ort })) };
        });

        pub.post("/public/:kunde/registrierung/person", limit(5, "1 hour"), async (req, reply) => {
          const kundeId = await tenant(req);
          const body = validate(publicPersonRegistrationSchema, req.body);
          return reply.status(202).send(await registration.registerPerson(kundeId, body));
        });

        pub.post("/public/:kunde/registrierung/firma", limit(5, "1 hour"), async (req, reply) => {
          const kundeId = await tenant(req);
          const body = validate(publicFirmaRegistrationSchema, req.body);
          return reply.status(202).send(await registration.registerFirma(kundeId, body));
        });

        pub.post("/public/:kunde/registrierung/bestaetigen", limit(20, "1 hour"), async (req) => {
          const kundeId = await tenant(req);
          await registration.confirm(kundeId, validate(registrationConfirmSchema, req.body).token);
          return { status: "bestaetigt" as const };
        });
      });
    },
  };
}

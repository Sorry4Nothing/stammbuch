import type { FastifyInstance } from "fastify";
import {
  organisationResponseSchema,
  organisationSectionParamSchema,
  organisationSectionSchemas,
} from "@stammbuch/shared";
import { HttpError, notFound } from "../../lib/http-error.js";
import { respond, validate } from "../../lib/validate.js";
import { customerOf, record } from "../../platform/index.js";
import type { Organisation, Platform } from "../../platform/index.js";
import { syncBillingSettings } from "../invoices/org-sync.js";
import type { SettingsRepository } from "../invoices/repository.js";
import { LOGO_MAX_BYTES, LOGO_MIMES, inspectLogo } from "./logo.js";

/** Startwerte, solange der Kunde noch nichts erfasst hat. */
function defaults(tenantName: string): Organisation {
  return {
    master: {
      name: tenantName,
      legalForm: "",
      street: "",
      zip: "",
      city: "",
      country: "CH",
      uid: "",
      vatNumber: "",
      email: "",
      phone: "",
      website: "",
    },
    sender: { name: "", email: "", replyTo: "", footer: "" },
    bank: { accountHolder: "", bankName: "", iban: "", creditAccount: "", qrIban: "", bic: "" },
    "fiscal-year": { startMonth: 1, closing: "monthly" },
    // Sammelrechnung ist ein optionales Modul (Projektplan Abschnitt 8), Mail und Kalender sind Standard.
    modules: { sammelrechnung: false, mail: true, kalender: true },
  };
}

async function load(platform: Platform, tenantId: string): Promise<Organisation> {
  const tenant = await platform.tenants.get(tenantId);
  if (!tenant) throw notFound();
  return (await platform.organisations.get(tenantId)) ?? defaults(tenant.name);
}

// Logo-Upload und Export sind teuer bzw. missbrauchbar: engeres Limit als global (SR-71).
const tight = { rateLimit: { max: 10, timeWindow: "1 minute" } } as const;

/** Kontonummern der aktiven Bestandskonten im Kontenplan des Mandanten. */
export type AssetAccounts = (tenantId: string, userId: string) => Promise<string[]>;

export function registerOrganisation(
  app: FastifyInstance,
  assetAccounts: AssetAccounts,
  billing: SettingsRepository,
) {
  // Das Logo kommt als rohe Bilddaten (PNG oder JPEG). Jeder andere Typ endet in 415, zu gross in 413.
  app.addContentTypeParser(
    [...LOGO_MIMES],
    { parseAs: "buffer", bodyLimit: LOGO_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.get("/settings/organisation", { config: { access: "customer" } }, async (request) => {
    const { tenantId } = await customerOf(request);
    const { platform } = app;
    const logo = await platform.logos.get(tenantId);
    const org = await load(platform, tenantId);
    return respond(organisationResponseSchema, {
      ...org,
      logo: logo ? { mime: logo.mime, size: logo.size, updatedAt: logo.updatedAt } : null,
    });
  });

  app.put(
    "/settings/organisation/:section",
    { config: { access: "customer-admin" } },
    async (request) => {
      const principal = await customerOf(request);
      const { platform } = app;
      const { section } = validate(organisationSectionParamSchema, request.params);
      // Nur Felder des Schemas werden übernommen (SR-72).
      const body = validate<unknown>(organisationSectionSchemas[section], request.body);
      // «Gutschriften auf» muss ein Konto aus dem Kontenplan dieses Mandanten sein (nie aus einem fremden).
      if (section === "bank") {
        const { creditAccount } = body as Organisation["bank"];
        if (
          creditAccount &&
          !(await assetAccounts(principal.tenantId, principal.userId)).includes(creditAccount)
        ) {
          throw new HttpError(422, "UNPROCESSABLE", "Das Konto ist im Kontenplan nicht vorhanden.");
        }
      }
      const org = await load(platform, principal.tenantId);
      const saved = { ...org, [section]: body } as Organisation;
      await platform.organisations.save(principal.tenantId, saved);
      // Adresse und Bankverbindung speisen die Rechnungseinstellungen; ohne sie kann kein Verein Rechnungen erstellen.
      // Der Abgleich ist Folgearbeit: scheitert er, bleibt die gespeicherte Organisation gültig.
      if (section === "master" || section === "bank") {
        await syncBillingSettings(billing, principal.tenantId, saved).catch((error: unknown) =>
          request.log.warn({ err: error }, "Rechnungseinstellungen nicht abgeglichen"),
        );
      }
      // Ins Protokoll kommt nur der Bereich, nie der Inhalt (SR-50).
      await record(
        platform.audit,
        platform.clock,
        principal.tenantId,
        principal,
        "organisation.update",
        section,
      );
      return { [section]: body };
    },
  );

  app.put(
    "/settings/organisation/logo",
    { config: { access: "customer-admin", rateLimit: tight.rateLimit }, bodyLimit: LOGO_MAX_BYTES },
    async (request, reply) => {
      const principal = await customerOf(request);
      const { platform } = app;
      const mime = request.headers["content-type"]?.split(";")[0]?.trim() ?? "";
      if (!Buffer.isBuffer(request.body))
        throw new HttpError(415, "UNSUPPORTED_MEDIA", "Dateityp nicht erlaubt.");
      const image = inspectLogo(request.body, mime);
      if (!image) throw new HttpError(400, "VALIDATION", "Ungültige Anfrage.");
      await platform.logos.put(
        principal.tenantId,
        { bytes: request.body, mime: image.mime },
        platform.clock(),
      );
      await record(
        platform.audit,
        platform.clock,
        principal.tenantId,
        principal,
        "organisation.logo.set",
      );
      return reply.status(204).send();
    },
  );

  app.delete(
    "/settings/organisation/logo",
    { config: { access: "customer-admin" } },
    async (request, reply) => {
      const principal = await customerOf(request);
      const { platform } = app;
      if (!(await platform.logos.remove(principal.tenantId))) throw notFound();
      await record(
        platform.audit,
        platform.clock,
        principal.tenantId,
        principal,
        "organisation.logo.remove",
      );
      return reply.status(204).send();
    },
  );

  app.get(
    "/settings/organisation/logo",
    { config: { access: "customer" } },
    async (request, reply) => {
      const { tenantId } = await customerOf(request);
      const logo = await app.platform.logos.get(tenantId);
      if (!logo) throw notFound();
      // Fester Typ aus der Prüfung beim Upload; nosniff und CSP kommen von Helmet.
      return reply
        .header("content-type", logo.mime)
        .header("content-disposition", "inline")
        .send(logo.bytes);
    },
  );
}

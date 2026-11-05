import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  firmaCreateSchema,
  memberCreateSchema,
  publicFirmaRegistrationSchema,
  publicPersonRegistrationSchema,
} from "@stammbuch/shared";
import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import type { Clock } from "./domain.js";
import type { PeopleService } from "./service.js";

/** Versand der Bestätigungsmails. Die echte Implementierung kommt mit dem Mail-Modul. */
export interface RegistrationMailer {
  send(msg: {
    kundeId: string;
    an: string;
    vorlage: "registrierung_bestaetigen" | "registrierung_bekannt";
    /** Nur bei `registrierung_bestaetigen`: Klartext-Token für den Link. */
    token?: string;
  }): Promise<void>;
}

export interface RegistrationOptions {
  /** Geheimnis für das Formular-Token (HMAC). Muss in jeder Instanz gleich sein. */
  secret: Buffer;
  /** Mindestwartezeit zwischen Formularabruf und Absenden (Bot-Schutz). */
  minFillMs?: number;
  formMaxAgeMs?: number;
  tokenTtlMs?: number;
  /** Wird bei Mailfehlern aufgerufen (nur loggen, nie an den Client weitergeben). */
  onMailError?: (e: unknown) => void;
}

const ACCEPTED = { status: "bestaetigung_gesendet" as const };
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Öffentliche Selbstregistrierung (SR-04, SR-05, SR-71):
 * - gleiche Antwort, egal ob die E-Mail schon bekannt ist (keine Nutzer-Enumeration),
 * - Honeypot-Feld und Mindestwartezeit gegen Bots,
 * - Double-Opt-in: erst nach Klick auf den Link entsteht der Datensatz; das Token ist zufällig,
 *   einmalig, befristet und wird nur als Hash gespeichert.
 */
export class RegistrationService {
  private readonly minFillMs: number;
  private readonly formMaxAgeMs: number;
  private readonly tokenTtlMs: number;

  constructor(
    private readonly people: PeopleService,
    private readonly mailer: RegistrationMailer,
    private readonly opts: RegistrationOptions,
    private readonly now: Clock = () => new Date(),
  ) {
    this.minFillMs = opts.minFillMs ?? 3_000;
    this.formMaxAgeMs = opts.formMaxAgeMs ?? 2 * 60 * 60_000;
    this.tokenTtlMs = opts.tokenTtlMs ?? 24 * 60 * 60_000;
  }

  issueFormToken(kundeId: string): string {
    const iat = String(this.now().getTime());
    return `${iat}.${this.mac(kundeId, iat)}`;
  }

  /** false bei gefälschtem Token; wirft 400 bei zu schnellem oder zu altem Absenden. */
  private checkFormToken(kundeId: string, token: string): boolean {
    const [iat, mac] = token.split(".");
    if (!iat || !mac || !/^\d{1,15}$/.test(iat)) return false;
    const expected = Buffer.from(this.mac(kundeId, iat));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
    const age = this.now().getTime() - Number(iat);
    if (age < this.minFillMs || age > this.formMaxAgeMs) {
      throw new AppError(400, "Bitte das Formular neu laden und erneut senden.");
    }
    return true;
  }

  private mac(kundeId: string, iat: string): string {
    return createHmac("sha256", this.opts.secret).update(`${kundeId}|${iat}`).digest("base64url");
  }

  /** Person (Einzel- oder Firmenmitglied). */
  async registerPerson(kundeId: string, body: z.infer<typeof publicPersonRegistrationSchema>) {
    if (!this.passesBotChecks(kundeId, body)) return ACCEPTED;
    const mitglied = body.mitglied;
    if (mitglied.typ === "firma") {
      // Nur freigegebene Firmen sind wählbar (dieselbe Liste wie im Formular).
      const firma = await this.people.store.firmen.get(kundeId, mitglied.firmaId);
      if (firma?.status !== "freigegeben")
        throw new AppError(400, "Die Firma ist nicht verfügbar.");
    }
    const known = await this.people.store.members.findByEmail(kundeId, mitglied.email);
    await this.notify(
      kundeId,
      mitglied.email,
      known ? undefined : { art: "person", daten: mitglied },
    );
    return ACCEPTED;
  }

  /** Firma: landet nach Bestätigung als `ausstehend` im Register und braucht Freigabe. */
  async registerFirma(kundeId: string, body: z.infer<typeof publicFirmaRegistrationSchema>) {
    if (!this.passesBotChecks(kundeId, body)) return ACCEPTED;
    await this.notify(kundeId, body.firma.email, { art: "firma", daten: body.firma });
    return ACCEPTED;
  }

  /** Löst das Token ein und legt den Datensatz an. Jeder Fehler ist dieselbe generische 400. */
  async confirm(kundeId: string, token: string): Promise<void> {
    const invalid = new AppError(400, "Der Link ist ungültig oder abgelaufen.");
    const p = await this.people.store.registrations.take(sha256(token));
    if (p?.kundeId !== kundeId || p.ablaufAm.getTime() < this.now().getTime()) throw invalid;
    if (p.art === "firma") {
      await this.people.createFirma(kundeId, firmaCreateSchema.parse(p.daten), "ausstehend");
      return;
    }
    try {
      await this.people.createMember(kundeId, memberCreateSchema.parse(p.daten));
    } catch (e) {
      // E-Mail inzwischen vergeben oder Firma nicht mehr freigegeben: ohne Details abweisen.
      if (e instanceof AppError) throw invalid;
      throw e;
    }
  }

  /** Honeypot gefüllt oder gefälschtes Token: stillschweigend "angenommen", nichts speichern. */
  private passesBotChecks(kundeId: string, body: { website?: string; formToken: string }): boolean {
    const tokenOk = this.checkFormToken(kundeId, body.formToken);
    return tokenOk && !body.website;
  }

  private async notify(
    kundeId: string,
    an: string,
    pending?: { art: "person" | "firma"; daten: unknown },
  ): Promise<void> {
    let token: string | undefined;
    if (pending) {
      token = randomBytes(32).toString("base64url");
      await this.people.store.registrations.put({
        tokenHash: sha256(token),
        kundeId,
        art: pending.art,
        daten: pending.daten,
        ablaufAm: new Date(this.now().getTime() + this.tokenTtlMs),
      });
    }
    // Mailfehler dürfen die Antwort nicht verändern, sonst wäre der Unterschied beobachtbar.
    await this.mailer
      .send({
        kundeId,
        an,
        vorlage: token ? "registrierung_bestaetigen" : "registrierung_bekannt",
        token,
      })
      .catch((e: unknown) => this.opts.onMailError?.(e));
  }
}

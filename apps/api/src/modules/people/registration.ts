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

/**
 * Versand der Registrierungsmails (`mailerRegistrationSender` im Mail-Modul).
 * - `registrierung_bestaetigen`: Double-Opt-in-Link,
 * - `registrierung_bekannt`: die E-Mail ist schon registriert (kein Link, keine Neuanlage),
 * - `registrierung_eingegangen`: Eingangsbestätigung nach dem Klick auf den Link.
 */
export interface RegistrationMailer {
  send(msg: {
    kundeId: string;
    /** Öffentliche Kennung des Vereins, Teil des Bestätigungslinks. */
    kunde: string;
    an: string;
    vorlage: "registrierung_bestaetigen" | "registrierung_bekannt" | "registrierung_eingegangen";
    art: "person" | "firma";
    /** Dieselbe Referenz wie in der Antwort an das Formular. */
    referenz: string;
    /** Nur bei `registrierung_bestaetigen`: Klartext-Token für den Link und Ablauf des Links. */
    token?: string;
    gueltigBis?: Date;
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
  /** Erzeugt das Token; nur für Tests (Kollision der Referenz). */
  newToken?: () => string;
}

const accepted = (referenz: string) => ({ status: "bestaetigung_gesendet" as const, referenz });
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// 32 Zeichen ohne I, O, 0, 1: gut lesbar am Telefon, und `byte & 31` bleibt gleichverteilt.
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Referenz für Rückfragen, `XXXX-XXXX`. Sie folgt aus dem Hash des Tokens: Das Formular, die Bestätigungsmail
 * und die Eingangsbestätigung zeigen dieselbe Nummer, ohne dass sie gespeichert werden muss. Aus 40 Bit
 * eines SHA-256 lässt sich das Token nicht zurückrechnen.
 */
export function referenceOf(tokenHash: string): string {
  const chars = Buffer.from(tokenHash.slice(0, 16), "hex").map((b) =>
    REF_ALPHABET.charCodeAt(b & 31),
  );
  const s = Buffer.from(chars).toString("ascii");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
const randomToken = () => randomBytes(32).toString("base64url");
/** Versuche, eine im Mandanten noch freie Referenz zu finden (bei 40 Bit praktisch nie mehr als einer). */
const REFERENCE_TRIES = 5;

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
  private readonly newToken: () => string;

  constructor(
    private readonly people: PeopleService,
    private readonly mailer: RegistrationMailer,
    private readonly opts: RegistrationOptions,
    private readonly now: Clock = () => new Date(),
  ) {
    this.minFillMs = opts.minFillMs ?? 3_000;
    this.formMaxAgeMs = opts.formMaxAgeMs ?? 2 * 60 * 60_000;
    this.tokenTtlMs = opts.tokenTtlMs ?? 24 * 60 * 60_000;
    this.newToken = opts.newToken ?? randomToken;
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

  /** Person (Einzel- oder Firmenmitglied). `kunde`: öffentliche Kennung aus der URL (für den Link in der Mail). */
  async registerPerson(
    kundeId: string,
    kunde: string,
    body: z.infer<typeof publicPersonRegistrationSchema>,
  ) {
    if (!this.passesBotChecks(kundeId, body)) return accepted(referenceOf(sha256(randomToken())));
    const mitglied = body.mitglied;
    if (mitglied.typ === "firma") {
      // Nur freigegebene Firmen sind wählbar (dieselbe Liste wie im Formular).
      const firma = await this.people.store.firmen.get(kundeId, mitglied.firmaId);
      if (firma?.status !== "freigegeben")
        throw new AppError(400, "Die Firma ist nicht verfügbar.");
    }
    const known = await this.people.store.members.findByEmail(kundeId, mitglied.email);
    return accepted(
      await this.notify(
        { kundeId, kunde, an: mitglied.email, art: "person" },
        known ? undefined : mitglied,
      ),
    );
  }

  /** Firma: landet nach Bestätigung als `ausstehend` im Register und braucht Freigabe. */
  async registerFirma(
    kundeId: string,
    kunde: string,
    body: z.infer<typeof publicFirmaRegistrationSchema>,
  ) {
    if (!this.passesBotChecks(kundeId, body)) return accepted(referenceOf(sha256(randomToken())));
    return accepted(
      await this.notify({ kundeId, kunde, an: body.firma.email, art: "firma" }, body.firma),
    );
  }

  /** Löst das Token ein und legt den Datensatz an. Jeder Fehler ist dieselbe generische 400. */
  async confirm(kundeId: string, kunde: string, token: string): Promise<void> {
    const invalid = new AppError(400, "Der Link ist ungültig oder abgelaufen.");
    const tokenHash = sha256(token);
    const p = await this.people.store.registrations.take(tokenHash);
    if (p?.kundeId !== kundeId || p.ablaufAm.getTime() < this.now().getTime()) throw invalid;
    let an: string | null;
    if (p.art === "firma") {
      an = (
        await this.people.createFirma(
          kundeId,
          firmaCreateSchema.parse(p.daten),
          "ausstehend",
          referenceOf(tokenHash),
        )
      ).email;
    } else {
      try {
        an = (
          await this.people.createMember(
            kundeId,
            memberCreateSchema.parse(p.daten),
            referenceOf(tokenHash),
          )
        ).email;
      } catch (e) {
        // E-Mail inzwischen vergeben oder Firma nicht mehr freigegeben: ohne Details abweisen.
        if (e instanceof AppError) throw invalid;
        throw e;
      }
    }
    // Der Datensatz steht bereits: ein Mailfehler macht die Bestätigung nicht rückgängig.
    if (an) {
      await this.send({
        kundeId,
        kunde,
        an,
        art: p.art,
        vorlage: "registrierung_eingegangen",
        referenz: referenceOf(tokenHash),
      });
    }
  }

  /** Honeypot gefüllt oder gefälschtes Token: stillschweigend "angenommen", nichts speichern. */
  private passesBotChecks(kundeId: string, body: { website?: string; formToken: string }): boolean {
    const tokenOk = this.checkFormToken(kundeId, body.formToken);
    return tokenOk && !body.website;
  }

  /** Gibt die Referenz zurück. Ohne `pending` (E-Mail schon bekannt) gibt es Referenz und Mail, aber keinen Eintrag. */
  private async notify(
    to: { kundeId: string; kunde: string; an: string; art: "person" | "firma" },
    pending?: unknown,
  ): Promise<string> {
    let token = this.newToken();
    // Die Referenz steht später am Datensatz und ist je Mandant eindeutig: eine schon vergebene gibt es nicht aus.
    for (let i = 1; pending && i < REFERENCE_TRIES; i++) {
      if (
        !(await this.people.store.registrations.referenceUsed(
          to.kundeId,
          referenceOf(sha256(token)),
        ))
      )
        break;
      token = this.newToken();
    }
    const tokenHash = sha256(token);
    const gueltigBis = new Date(this.now().getTime() + this.tokenTtlMs);
    if (pending) {
      await this.people.store.registrations.put({
        tokenHash,
        kundeId: to.kundeId,
        art: to.art,
        daten: pending,
        ablaufAm: gueltigBis,
      });
    }
    const referenz = referenceOf(tokenHash);
    await this.send({
      ...to,
      referenz,
      vorlage: pending ? "registrierung_bestaetigen" : "registrierung_bekannt",
      ...(pending ? { token, gueltigBis } : {}),
    });
    return referenz;
  }

  /** Mailfehler dürfen die Antwort nicht verändern, sonst wäre der Unterschied beobachtbar. */
  private send(msg: Parameters<RegistrationMailer["send"]>[0]): Promise<void> {
    return this.mailer.send(msg).catch((e: unknown) => this.opts.onMailError?.(e));
  }
}

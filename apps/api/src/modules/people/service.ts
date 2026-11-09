import { randomUUID } from "node:crypto";
import type {
  Address,
  BulkAction,
  BulkResult,
  DuplikatMerge,
  FirmaCreate,
  FirmaUpdate,
  MemberCreate,
  MemberUpdate,
} from "@stammbuch/shared";
import { verlaufArten } from "@stammbuch/shared";
import { AppError } from "../../lib/errors.js";
import {
  PAIR_SCAN_MAX,
  comparePersonPair,
  findDuplicatePairs,
  findDuplicates,
  findPersonPairs,
} from "./duplicates.js";
import type { Clock, Ctx, Firma, Gruppe, Member, MemberEreignisArt } from "./domain.js";
import type { DuplicateMatch, DuplicateReason, PersonDuplicateReason } from "./duplicates.js";
import { noFinance } from "./finance.js";
import type { PersonFinance } from "./finance.js";
import type { PeopleStore } from "./repository.js";

/** Ein Paar ähnlicher Firmen bzw. Personen. Die Kennung ist `<idA>_<idB>` mit idA < idB. */
export type DuplikatPaar = { id: string; score: number; status: "offen" | "kein_duplikat" } & (
  | { art: "firma"; a: Firma; b: Firma; gruende: DuplicateReason[] }
  | { art: "person"; a: Member; b: Member; gruende: PersonDuplicateReason[] }
);

export interface PersonFinanzen {
  rechnungen: Array<{
    id: string;
    nr: string;
    datum: string;
    betrag: number;
    offen: number;
    status: "offen" | "bezahlt";
  }>;
  konto: { offen: number; bezahltJahr: number; mahnstufe: number; letzteZahlung: string | null };
  mails: number;
  verlauf: Array<{
    datum: string;
    art: VerlaufArt;
    detail: string | null;
    betrag: number | null;
  }>;
}

export type VerlaufArt = (typeof verlaufArten)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Zerlegt eine Paar-Kennung. Alles andere ist für den Aufrufer «nicht gefunden». */
function parsePaar(id: string): [string, string] {
  const [a, b, rest] = id.split("_");
  if (!a || !b || rest !== undefined || !UUID.test(a) || !UUID.test(b) || a >= b) {
    throw new AppError(404);
  }
  return [a, b];
}

/** Status, in denen eine Person archiviert, wiederhergestellt und in Gruppen geführt wird. */
const GEFUEHRT = new Set<Member["status"]>(["aktiv", "archiviert"]);

/** Personen, die im Duplikatvergleich mitzählen: noch gültig, auch ausgetretene (Wiedereintritt). */
const PERSON_GUELTIG = new Set<Member["status"]>(["aktiv", "archiviert", "ausstehend"]);
const VERLAUF_MAX = 100;

/** Strasse und Ort getrennt wählbar: `entfernen` nimmt den Wert der Quelle. */
function mergeAdresse(ziel: Address, quelle: Address, werte: DuplikatMerge["werte"]): Address {
  const strasse = werte.strasse === "entfernen" ? quelle : ziel;
  const plzOrt = werte.plzOrt === "entfernen" ? quelle : ziel;
  return {
    strasse: strasse.strasse,
    ...(strasse.hausnr !== undefined && { hausnr: strasse.hausnr }),
    ...(strasse.zusatz !== undefined && { zusatz: strasse.zusatz }),
    plz: plzOrt.plz,
    ort: plzOrt.ort,
    land: plzOrt.land,
  };
}

const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/**
 * Geschäftsregeln für Mitglieder, Gruppen und Firmenregister. Jede Methode bekommt den
 * Mandantenkontext und reicht `kundeId` an jede Repository-Abfrage weiter.
 */
export class PeopleService {
  constructor(
    readonly store: PeopleStore,
    private readonly now: Clock = () => new Date(),
    /** Port zum Rechnungsmodul; ohne Angabe gibt es keine Rechnungen zu einer Person. */
    private readonly finance: PersonFinance = noFinance,
  ) {}

  // Mitglieder

  /**
   * `referenz`: nur die Selbstregistrierung gibt eine mit (XXXX-XXXX); sie legt die Person als `ausstehend` an,
   * bis ein Admin freigibt, und sie steht bis dahin in keiner Mail- und Rechnungsliste. Der Admin legt `aktiv` an.
   */
  async createMember(
    kundeId: string,
    input: MemberCreate,
    referenz?: string,
    status: "aktiv" | "ausstehend" = referenz === undefined ? "aktiv" : "ausstehend",
  ): Promise<Member> {
    if (input.typ === "firma") await this.requireFreigegebeneFirma(kundeId, input.firmaId);
    return this.store.members.insert(this.newMember(kundeId, input, referenz, status));
  }

  private newMember(
    kundeId: string,
    input: MemberCreate,
    referenz?: string,
    status: "aktiv" | "ausstehend" = "aktiv",
  ): Member {
    const firmaId = input.typ === "firma" ? input.firmaId : null;
    const now = this.now();
    return {
      id: randomUUID(),
      kundeId,
      typ: input.typ,
      status,
      // Ausstehend heisst: kommt aus der Selbstregistrierung. Der Admin legt aktiv an.
      quelle: status === "ausstehend" ? "selbst" : "manuell",
      zusammengefuehrtMit: null,
      anrede: input.anrede ?? null,
      vorname: input.vorname,
      nachname: input.nachname,
      email: input.email ?? null,
      telefon: input.telefon ?? null,
      mobil: input.mobil ?? null,
      adresse: input.adresse ?? null,
      notiz: input.notiz ?? null,
      geburtsdatum: input.geburtsdatum ?? null,
      eintritt: input.eintritt ?? null,
      kanal: input.kanal ?? null,
      funktion: input.typ === "firma" ? (input.funktion ?? null) : null,
      firmaId,
      gruppeId: null,
      gruppeSeit: null,
      registrierungReferenz: referenz ?? null,
      mitgliedsnr: "",
      erstelltAm: now,
      geaendertAm: now,
    };
  }

  /**
   * Import in einer Transaktion: neue Mitglieder anlegen, bestehende ändern, Gruppen zuweisen
   * (eine bisherige Gruppe wird ersetzt). Ein Fehler lässt den Bestand unverändert.
   */
  async importMembers(
    kundeId: string,
    neu: Array<{ input: MemberCreate; gruppeId?: string | undefined }>,
    geaendert: Array<{ member: Member; patch: MemberUpdate; gruppeId?: string | undefined }>,
  ): Promise<Member[]> {
    const firmaIds = new Set(
      neu.flatMap((n) => (n.input.typ === "firma" ? [n.input.firmaId] : [])),
    );
    for (const id of firmaIds) await this.requireFreigegebeneFirma(kundeId, id);
    const created = neu.map((n) => ({ m: this.newMember(kundeId, n.input), gruppeId: n.gruppeId }));
    const changed = geaendert.map((g) => ({
      m: { ...g.member, ...defined(g.patch), geaendertAm: this.now() } as Member,
      gruppeId: g.gruppeId,
    }));
    return this.store.members.importieren(kundeId, {
      neu: created.map((c) => c.m),
      geaendert: changed.map((c) => c.m),
      gruppen: [...created, ...changed].flatMap((c) =>
        c.gruppeId ? [[c.m.id, c.gruppeId] as [string, string]] : [],
      ),
    });
  }

  async getMember(ctx: Ctx, id: string): Promise<Member> {
    const m = await this.store.members.get(ctx.kundeId, id);
    if (!m) throw new AppError(404);
    return m;
  }

  async updateMember(ctx: Ctx, id: string, patch: MemberUpdate): Promise<Member> {
    const m = await this.getMember(ctx, id);
    if (m.status === "zusammengefuehrt")
      throw new AppError(409, "Die Person wurde zusammengeführt.");
    const changes = defined(patch);
    if (m.typ === "einzel" && (changes.firmaId || changes.funktion)) {
      throw new AppError(400, "Firma und Funktion gibt es nur bei Firmenmitgliedern.");
    }
    if (changes.firmaId) await this.requireFreigegebeneFirma(ctx.kundeId, changes.firmaId);
    const next: Member = { ...m, ...changes, geaendertAm: this.now() };
    await this.store.members.save(next);
    return next;
  }

  /** Sammelaktion. Fehler einzelner Einträge brechen den Rest nicht ab. */
  async bulk(ctx: Ctx, action: BulkAction): Promise<BulkResult> {
    const gruppe =
      action.aktion === "gruppe_zuweisen"
        ? await this.requireGruppe(ctx.kundeId, action.gruppeId as string)
        : undefined;
    const result: BulkResult = { ok: 0, fehler: [] };
    for (const id of new Set(action.ids)) {
      try {
        const m = await this.store.members.get(ctx.kundeId, id);
        if (!m) {
          result.fehler.push({ id, grund: "NICHT_GEFUNDEN" });
          continue;
        }
        // Ausstehende, abgelehnte und zusammengeführte Personen ändert nur die Freigabe bzw. gar nichts.
        if (!GEFUEHRT.has(m.status)) {
          result.fehler.push({ id, grund: "KONFLIKT" });
          continue;
        }
        if (action.aktion === "archivieren" || action.aktion === "wiederherstellen") {
          const status = action.aktion === "archivieren" ? "archiviert" : "aktiv";
          await this.store.members.save({ ...m, status, geaendertAm: this.now() });
        } else if (action.aktion === "gruppe_zuweisen" && gruppe) {
          await this.assignToGruppe(ctx, id, gruppe.id);
        } else {
          await this.unassign(ctx.kundeId, m);
        }
        result.ok++;
      } catch (e) {
        if (!(e instanceof AppError) || e.statusCode !== 409) throw e;
        result.fehler.push({ id, grund: "KONFLIKT" });
      }
    }
    return result;
  }

  // Gruppen

  async createGruppe(ctx: Ctx, name: string, beschreibung?: string | null): Promise<Gruppe> {
    const now = this.now();
    const g: Gruppe = {
      id: randomUUID(),
      kundeId: ctx.kundeId,
      name,
      beschreibung: beschreibung ?? null,
      erstelltAm: now,
      geaendertAm: now,
    };
    await this.store.gruppen.insert(g);
    return g;
  }

  /** Name und/oder Beschreibung ändern; nicht genannte Felder bleiben unverändert. */
  async updateGruppe(
    ctx: Ctx,
    id: string,
    patch: { name?: string; beschreibung?: string | null },
  ): Promise<void> {
    const ok = await this.store.gruppen.update(ctx.kundeId, id, defined(patch), this.now());
    if (!ok) throw new AppError(404);
  }

  async dissolveGruppe(ctx: Ctx, id: string): Promise<void> {
    if (!(await this.store.gruppen.dissolve(ctx.kundeId, id))) throw new AppError(404);
  }

  /**
   * Invariante "höchstens eine Gruppe pro Person": Die Prüfung im Domänencode liefert die klare
   * Fehlermeldung; der UNIQUE-Constraint (Repository/Datenbank) fängt Rennen zwischen Anfragen ab.
   */
  async assignToGruppe(ctx: Ctx, memberId: string, gruppeId: string): Promise<void> {
    const m = await this.getMember(ctx, memberId);
    const g = await this.requireGruppe(ctx.kundeId, gruppeId);
    if (!GEFUEHRT.has(m.status)) {
      throw new AppError(409, "Die Person ist nicht freigegeben.");
    }
    if (m.gruppeId !== null && m.gruppeId !== gruppeId) {
      throw new AppError(409, "Die Person ist bereits in einer anderen Gruppe.");
    }
    await this.store.gruppen.assign(ctx.kundeId, memberId, gruppeId);
    if (m.gruppeId !== gruppeId)
      await this.ereignis(ctx.kundeId, memberId, "gruppe_zugewiesen", g.name);
  }

  async removeFromGruppe(ctx: Ctx, memberId: string): Promise<void> {
    await this.unassign(ctx.kundeId, await this.getMember(ctx, memberId));
  }

  private async unassign(kundeId: string, m: Member): Promise<void> {
    await this.store.gruppen.unassign(kundeId, m.id);
    if (m.gruppeId) {
      const g = await this.store.gruppen.get(kundeId, m.gruppeId);
      await this.ereignis(kundeId, m.id, "gruppe_entfernt", g?.name ?? null);
    }
  }

  private ereignis(
    kundeId: string,
    memberId: string,
    art: MemberEreignisArt,
    detail: string | null,
  ) {
    return this.store.members.addEreignis(kundeId, { memberId, art, detail, am: this.now() });
  }

  /** Freigabe einer selbst registrierten Person: `aktiv` bzw. `abgelehnt`. */
  async setMemberFreigabe(ctx: Ctx, id: string, freigeben: boolean): Promise<Member> {
    const m = await this.getMember(ctx, id);
    if (m.status !== "ausstehend") {
      throw new AppError(409, "Nur ausstehende Personen sind freigabepflichtig.");
    }
    const next: Member = {
      ...m,
      status: freigeben ? "aktiv" : "abgelehnt",
      geaendertAm: this.now(),
    };
    await this.store.members.save(next);
    await this.ereignis(ctx.kundeId, id, freigeben ? "freigegeben" : "abgelehnt", null);
    return next;
  }

  // Firmenregister

  /** Admin legt an: sofort freigegeben. Selbstregistrierung: `ausstehend`. */
  async createFirma(
    kundeId: string,
    input: FirmaCreate,
    status: "freigegeben" | "ausstehend" = "freigegeben",
    referenz?: string,
    /** Benutzer, der die Firma anlegt; bei Selbstregistrierung leer. */
    erfasstVonId: string | null = null,
  ): Promise<Firma> {
    const f: Firma = {
      id: randomUUID(),
      kundeId,
      name: input.name,
      uid: input.uid ?? null,
      mwstNr: input.mwstNr ?? null,
      adresse: input.adresse,
      email: input.email ?? null,
      telefon: input.telefon ?? null,
      kontaktperson: input.kontaktperson ?? null,
      status,
      zusammengefuehrtMit: null,
      erstelltAm: this.now(),
      rechnungsEmail: input.rechnungsEmail ?? null,
      notiz: input.notiz ?? null,
      // Ausstehend heisst: kommt aus der Selbstregistrierung. Der Admin legt freigegeben an.
      quelle: status === "ausstehend" ? "selbst" : "manuell",
      erfasstVonId,
      registrierungReferenz: referenz ?? null,
    };
    await this.store.firmen.insert(f);
    return f;
  }

  async getFirma(ctx: Ctx, id: string): Promise<Firma> {
    const f = await this.store.firmen.get(ctx.kundeId, id);
    if (!f) throw new AppError(404);
    return f;
  }

  async updateFirma(ctx: Ctx, id: string, patch: FirmaUpdate): Promise<Firma> {
    const f = await this.getFirma(ctx, id);
    if (f.status === "zusammengefuehrt") throw new AppError(409, "Firma wurde zusammengeführt.");
    const next: Firma = { ...f, ...defined(patch) };
    await this.store.firmen.save(next);
    return next;
  }

  async setFirmaFreigabe(ctx: Ctx, id: string, freigeben: boolean): Promise<Firma> {
    const f = await this.getFirma(ctx, id);
    if (f.status !== "ausstehend")
      throw new AppError(409, "Nur ausstehende Firmen sind freigabepflichtig.");
    const next: Firma = { ...f, status: freigeben ? "freigegeben" : "abgelehnt" };
    await this.store.firmen.save(next);
    return next;
  }

  async duplicatesFor(
    ctx: Ctx,
    probe: Pick<Firma, "name" | "uid" | "mwstNr" | "adresse">,
    exceptId?: string,
  ): Promise<DuplicateMatch[]> {
    return findDuplicates(probe, await this.store.firmen.listCandidates(ctx.kundeId), exceptId);
  }

  /**
   * Führt `quelleId` in `zielId` zusammen: Mitglieder wandern, leere Felder werden ergänzt.
   * Mit `werte` gilt für die genannten Felder `entfernen` = Wert der Quelle statt des Ziels. Hat die
   * gewählte Seite keinen Wert, bleibt der der anderen: Zusammenführen löscht keine Angaben.
   */
  async mergeFirmen(
    ctx: Ctx,
    zielId: string,
    quelleId: string,
    werte: DuplikatMerge["werte"] = {},
  ): Promise<Firma> {
    if (zielId === quelleId) throw new AppError(400, "Quelle und Ziel sind identisch.");
    const [ziel, quelle] = await Promise.all([
      this.getFirma(ctx, zielId),
      this.getFirma(ctx, quelleId),
    ]);
    if (ziel.status !== "freigegeben") {
      throw new AppError(409, "Das Ziel muss eine freigegebene Firma sein.");
    }
    if (quelle.status === "zusammengefuehrt") {
      throw new AppError(409, "Die Quelle wurde bereits zusammengeführt.");
    }
    // Gewählte Seite zuerst, die andere füllt Lücken.
    const pick = <T>(feld: keyof NonNullable<typeof werte>, z: T | null, q: T | null): T | null =>
      werte[feld] === "entfernen" ? (q ?? z) : (z ?? q);
    const adresse = mergeAdresse(ziel.adresse, quelle.adresse, werte);
    const target: Firma = {
      ...ziel,
      name: werte.name === "entfernen" ? quelle.name : ziel.name,
      uid: pick("uid", ziel.uid, quelle.uid),
      mwstNr: pick("mwstNr", ziel.mwstNr, quelle.mwstNr),
      adresse,
      email: pick("email", ziel.email, quelle.email),
      telefon: pick("telefon", ziel.telefon, quelle.telefon),
      kontaktperson: ziel.kontaktperson ?? quelle.kontaktperson,
      rechnungsEmail: ziel.rechnungsEmail ?? quelle.rechnungsEmail,
      notiz: ziel.notiz ?? quelle.notiz,
    };
    await this.store.firmen.merge(ctx.kundeId, target, quelleId, this.now());
    return target;
  }

  // Duplikate im ganzen Register (Firmen und Personen)

  /** Alle ähnlichen Paare, beste zuerst. Als «kein Duplikat» bestätigte stehen mit diesem Status drin. */
  async listDuplikate(ctx: Ctx): Promise<DuplikatPaar[]> {
    const firmen = await this.store.firmen.listCandidates(ctx.kundeId);
    if (firmen.length > PAIR_SCAN_MAX) {
      throw new AppError(409, "Das Register ist für die Duplikatsuche zu gross.");
    }
    const [fa, pa, personen] = await Promise.all([
      this.store.firmen.duplikatAusnahmen(ctx.kundeId),
      this.store.members.duplikatAusnahmen(ctx.kundeId),
      this.store.members.listCandidates(ctx.kundeId),
    ]);
    const status = (ausnahmen: Set<string>, id: string) =>
      ausnahmen.has(id) ? ("kein_duplikat" as const) : ("offen" as const);
    return [
      ...findDuplicatePairs(firmen).map((p): DuplikatPaar => {
        const id = `${p.a.id}_${p.b.id}`;
        return { ...p, art: "firma", id, status: status(fa, id) };
      }),
      ...findPersonPairs(personen).map((p): DuplikatPaar => {
        const id = `${p.a.id}_${p.b.id}`;
        return { ...p, art: "person", id, status: status(pa, id) };
      }),
    ].sort((p, q) => q.score - p.score);
  }

  /** Firma oder Person? Die IDs stammen aus verschiedenen Tabellen und kollidieren nie. 404, wenn beides fehlt. */
  private async paarArt(kundeId: string, a: string, b: string): Promise<"firma" | "person"> {
    if ((await this.store.firmen.getMany(kundeId, [a, b])).length === 2) return "firma";
    const [ma, mb] = await Promise.all([
      this.store.members.get(kundeId, a),
      this.store.members.get(kundeId, b),
    ]);
    if (ma && mb) return "person";
    throw new AppError(404);
  }

  /** Ein Paar. 404, wenn eine Seite fehlt, nicht mehr gültig ist oder sich die beiden nicht mehr ähneln. */
  async getDuplikat(ctx: Ctx, id: string): Promise<DuplikatPaar> {
    const [aId, bId] = parsePaar(id);
    if ((await this.paarArt(ctx.kundeId, aId, bId)) === "firma") {
      const [a, b] = await Promise.all([this.getFirma(ctx, aId), this.getFirma(ctx, bId)]);
      const gueltig = (f: Firma) => f.status === "ausstehend" || f.status === "freigegeben";
      const hit = gueltig(a) && gueltig(b) ? findDuplicates(a, [b])[0] : undefined;
      if (!hit) throw new AppError(404);
      const ausnahmen = await this.store.firmen.duplikatAusnahmen(ctx.kundeId);
      return {
        art: "firma",
        id,
        a,
        b,
        score: hit.score,
        gruende: hit.gruende,
        status: ausnahmen.has(id) ? "kein_duplikat" : "offen",
      };
    }
    const [a, b] = await Promise.all([this.getMember(ctx, aId), this.getMember(ctx, bId)]);
    const gueltig = (m: Member) => m.typ === "einzel" && PERSON_GUELTIG.has(m.status);
    const hit = gueltig(a) && gueltig(b) ? comparePersonPair(a, b) : undefined;
    if (!hit) throw new AppError(404);
    const ausnahmen = await this.store.members.duplikatAusnahmen(ctx.kundeId);
    return {
      art: "person",
      id,
      a,
      b,
      score: hit.score,
      gruende: hit.gruende,
      status: ausnahmen.has(id) ? "kein_duplikat" : "offen",
    };
  }

  async markKeinDuplikat(ctx: Ctx, id: string): Promise<void> {
    const [a, b] = parsePaar(id);
    const art = await this.paarArt(ctx.kundeId, a, b);
    await (art === "firma" ? this.store.firmen : this.store.members).addDuplikatAusnahme(
      ctx.kundeId,
      a,
      b,
    );
  }

  /** `behaltenId` muss eine der beiden Seiten sein; die andere geht in sie auf. */
  async mergeDuplikat(
    ctx: Ctx,
    id: string,
    input: DuplikatMerge,
  ): Promise<{ art: "firma"; firma: Firma } | { art: "person"; person: Member }> {
    const [a, b] = parsePaar(id);
    if (input.behaltenId !== a && input.behaltenId !== b) {
      throw new AppError(400, "Die behaltene Seite gehört nicht zum Paar.");
    }
    const quelleId = input.behaltenId === a ? b : a;
    if ((await this.paarArt(ctx.kundeId, a, b)) === "firma") {
      return {
        art: "firma",
        firma: await this.mergeFirmen(ctx, input.behaltenId, quelleId, input.werte),
      };
    }
    return {
      art: "person",
      person: await this.mergePersonen(ctx, input.behaltenId, quelleId, input.werte),
    };
  }

  /**
   * Führt `quelleId` in `zielId` zusammen. Sicherheitsregeln:
   * - Beide müssen Einzelpersonen sein, das Ziel `aktiv`; die Quelle darf nicht abgelehnt oder schon zusammengeführt sein.
   * - Hat die Quelle offene Rechnungen oder Entwürfe, wird nicht zusammengeführt: versendete Belege sind
   *   unveränderlich und zeigen auf die Quelle. Erst bezahlen oder stornieren.
   * - Sind beide in verschiedenen Gruppen, wird nicht zusammengeführt (es gibt höchstens eine Gruppe je Person).
   * - Sonst wandern Gruppe und Kalendereinladungen (mit ihren Antworten) zum Ziel; bezahlte Rechnungen bleiben unter
   *   der Quelle und erscheinen bei den Finanzen des Ziels. Die Quelle verliert ihre E-Mail-Adresse (eindeutig je Verein).
   */
  async mergePersonen(
    ctx: Ctx,
    zielId: string,
    quelleId: string,
    werte: DuplikatMerge["werte"] = {},
  ): Promise<Member> {
    if (zielId === quelleId) throw new AppError(400, "Quelle und Ziel sind identisch.");
    const [ziel, quelle] = await Promise.all([
      this.getMember(ctx, zielId),
      this.getMember(ctx, quelleId),
    ]);
    if (ziel.typ !== "einzel" || quelle.typ !== "einzel") {
      throw new AppError(400, "Nur Einzelpersonen lassen sich zusammenführen.");
    }
    if (ziel.status !== "aktiv") throw new AppError(409, "Das Ziel muss eine aktive Person sein.");
    if (quelle.status === "zusammengefuehrt" || quelle.status === "abgelehnt") {
      throw new AppError(409, "Die Quelle kann nicht zusammengeführt werden.");
    }
    if (ziel.gruppeId && quelle.gruppeId && ziel.gruppeId !== quelle.gruppeId) {
      throw new AppError(
        409,
        "Die Personen sind in verschiedenen Gruppen. Bitte zuerst bei einer die Gruppe entfernen.",
      );
    }
    const counts = await this.finance.counts(ctx.kundeId, [quelle.id, quelle.mitgliedsnr]);
    if ([...counts.values()].some((c) => c.offen > 0)) {
      throw new AppError(
        409,
        "Die Quelle hat offene Rechnungen oder Entwürfe. Bitte zuerst bezahlen oder stornieren.",
      );
    }
    const pick = <T>(feld: keyof NonNullable<typeof werte>, z: T | null, q: T | null): T | null =>
      werte[feld] === "entfernen" ? (q ?? z) : (z ?? q);
    const target: Member = {
      ...ziel,
      vorname: werte.vorname === "entfernen" ? quelle.vorname : ziel.vorname,
      nachname: werte.nachname === "entfernen" ? quelle.nachname : ziel.nachname,
      email: pick("email", ziel.email, quelle.email),
      telefon: pick("telefon", ziel.telefon, quelle.telefon),
      mobil: ziel.mobil ?? quelle.mobil,
      adresse:
        ziel.adresse && quelle.adresse
          ? mergeAdresse(ziel.adresse, quelle.adresse, werte)
          : (ziel.adresse ?? quelle.adresse),
      anrede: ziel.anrede ?? quelle.anrede,
      notiz: ziel.notiz ?? quelle.notiz,
      geburtsdatum: pick("geburtsdatum", ziel.geburtsdatum, quelle.geburtsdatum),
      eintritt: pick("eintritt", ziel.eintritt, quelle.eintritt),
      kanal: ziel.kanal ?? quelle.kanal,
      geaendertAm: this.now(),
    };
    await this.store.members.merge(ctx.kundeId, target, quelleId, this.now());
    await this.ereignis(ctx.kundeId, zielId, "zusammengefuehrt", quelle.mitgliedsnr);
    await this.ereignis(ctx.kundeId, quelleId, "zusammengefuehrt", ziel.mitgliedsnr);
    return (await this.store.members.get(ctx.kundeId, zielId)) ?? target;
  }

  /** Rechnungen je Person samt Verlauf; umfasst `id` selbst und die in sie aufgegangenen Personen. */
  async getFinanzen(ctx: Ctx, id: string): Promise<PersonFinanzen> {
    const m = await this.getMember(ctx, id);
    const mergedIds = await this.store.members.mergedInto(ctx.kundeId, id);
    const merged = await Promise.all(mergedIds.map((i) => this.store.members.get(ctx.kundeId, i)));
    const all = [m, ...merged.flatMap((x) => x ?? [])];
    const data = await this.finance.forPerson(
      ctx.kundeId,
      all.flatMap((x) => [x.id, x.mitgliedsnr]),
      m.email,
    );
    const events = await this.store.members.ereignisse(
      ctx.kundeId,
      all.map((x) => x.id),
    );

    const rechnungen = data.rechnungen.map((r) => ({
      id: r.id,
      nr: r.nr,
      datum: r.datum,
      betrag: r.betrag,
      offen: Math.max(r.offen, 0),
      status: r.offen > 0 ? ("offen" as const) : ("bezahlt" as const),
    }));
    const offenIds = new Set(rechnungen.filter((r) => r.status === "offen").map((r) => r.id));
    const jahr = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Zurich",
      year: "numeric",
    }).format(this.now());
    const eingegangen = data.zahlungen.filter((z) => z.betrag > 0).map((z) => z.datum);
    const konto = {
      offen: rechnungen.reduce((sum, r) => sum + r.offen, 0),
      bezahltJahr: Math.max(
        data.zahlungen
          .filter((z) => z.datum.startsWith(jahr))
          .reduce((sum, z) => sum + z.betrag, 0),
        0,
      ),
      mahnstufe: Math.max(
        0,
        ...data.mahnungen.filter((x) => offenIds.has(x.rechnungId)).map((x) => x.stufe),
      ),
      letzteZahlung: eingegangen.length > 0 ? eingegangen.reduce((a, b) => (a > b ? a : b)) : null,
    };

    // Ein Datum ohne Uhrzeit (Rechnungs- und Zahlungsdatum) gilt als Mittag UTC: fällt in der Schweiz auf denselben Tag.
    const tag = (d: string) => `${d}T12:00:00.000Z`;
    const verlauf: PersonFinanzen["verlauf"] = [
      {
        datum: m.erstelltAm.toISOString(),
        art: m.quelle === "selbst" ? "selbst_registriert" : "angelegt",
        detail: null,
        betrag: null,
      },
      ...(m.geaendertAm.getTime() - m.erstelltAm.getTime() > 60_000
        ? [
            {
              datum: m.geaendertAm.toISOString(),
              art: "geaendert" as const,
              detail: null,
              betrag: null,
            },
          ]
        : []),
      ...events.map((e) => ({
        datum: e.am.toISOString(),
        art: e.art,
        detail: e.detail,
        betrag: null,
      })),
      ...data.rechnungen.map((r) => ({
        datum: r.versendetAm.toISOString(),
        art: "rechnung_versendet" as const,
        detail: r.nr,
        betrag: r.betrag,
      })),
      ...data.zahlungen.map((z) => ({
        datum: tag(z.datum),
        art: "zahlung" as const,
        detail: z.rechnungNr,
        betrag: z.betrag,
      })),
      ...data.mahnungen.map((x) => ({
        datum: tag(x.datum),
        art: "mahnung" as const,
        detail: x.rechnungNr,
        betrag: null,
      })),
    ];
    // Bestand von vor dem Verlauf: die aktuelle Gruppe steht nur an der Mitgliedschaft.
    const gezeigt = events.some((e) => e.art === "gruppe_zugewiesen" && e.memberId === id);
    if (m.gruppeId && m.gruppeSeit && !gezeigt) {
      const g = await this.store.gruppen.get(ctx.kundeId, m.gruppeId);
      verlauf.push({
        datum: m.gruppeSeit.toISOString(),
        art: "gruppe_zugewiesen",
        detail: g?.name ?? null,
        betrag: null,
      });
    }
    verlauf.sort((a, b) => b.datum.localeCompare(a.datum));
    return { rechnungen, konto, mails: data.mails, verlauf: verlauf.slice(0, VERLAUF_MAX) };
  }

  /** Rechnungen je Person (für die Duplikatansicht): Mitglied-ID und Mitgliedsnummer zählen zusammen. */
  async countRechnungen(kundeId: string, members: Member[]): Promise<Map<string, number>> {
    const counts = await this.finance.counts(
      kundeId,
      members.flatMap((m) => [m.id, m.mitgliedsnr]),
    );
    return new Map(
      members.map((m) => [
        m.id,
        (counts.get(m.id)?.gesamt ?? 0) + (counts.get(m.mitgliedsnr)?.gesamt ?? 0),
      ]),
    );
  }

  private async requireGruppe(kundeId: string, id: string): Promise<Gruppe> {
    const g = await this.store.gruppen.get(kundeId, id);
    if (!g) throw new AppError(404);
    return g;
  }

  private async requireFreigegebeneFirma(kundeId: string, id: string): Promise<void> {
    const f = await this.store.firmen.get(kundeId, id);
    if (f?.status !== "freigegeben") throw new AppError(400, "Die Firma ist nicht verfügbar.");
  }
}

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
import { AppError } from "../../lib/errors.js";
import { PAIR_SCAN_MAX, findDuplicatePairs, findDuplicates } from "./duplicates.js";
import type { Clock, Ctx, Firma, Gruppe, Member } from "./domain.js";
import type { DuplicateMatch, DuplicateReason } from "./duplicates.js";
import type { PeopleStore } from "./repository.js";

/** Ein Paar ähnlicher Firmen. Die Kennung ist `<idA>_<idB>` mit idA < idB. */
export interface DuplikatPaar {
  id: string;
  a: Firma;
  b: Firma;
  score: number;
  gruende: DuplicateReason[];
  status: "offen" | "kein_duplikat";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Zerlegt eine Paar-Kennung. Alles andere ist für den Aufrufer «nicht gefunden». */
function parsePaar(id: string): [string, string] {
  const [a, b, rest] = id.split("_");
  if (!a || !b || rest !== undefined || !UUID.test(a) || !UUID.test(b) || a >= b) {
    throw new AppError(404);
  }
  return [a, b];
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
  ) {}

  // Mitglieder

  /** `referenz`: nur die Selbstregistrierung gibt eine mit (XXXX-XXXX). */
  async createMember(kundeId: string, input: MemberCreate, referenz?: string): Promise<Member> {
    if (input.typ === "firma") await this.requireFreigegebeneFirma(kundeId, input.firmaId);
    return this.store.members.insert(this.newMember(kundeId, input, referenz));
  }

  private newMember(kundeId: string, input: MemberCreate, referenz?: string): Member {
    const firmaId = input.typ === "firma" ? input.firmaId : null;
    const now = this.now();
    return {
      id: randomUUID(),
      kundeId,
      typ: input.typ,
      status: "aktiv",
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
        if (action.aktion === "archivieren" || action.aktion === "wiederherstellen") {
          const status = action.aktion === "archivieren" ? "archiviert" : "aktiv";
          await this.store.members.save({ ...m, status, geaendertAm: this.now() });
        } else if (action.aktion === "gruppe_zuweisen" && gruppe) {
          await this.assignToGruppe(ctx, id, gruppe.id);
        } else {
          await this.store.gruppen.unassign(ctx.kundeId, id);
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
    await this.requireGruppe(ctx.kundeId, gruppeId);
    if (m.gruppeId !== null && m.gruppeId !== gruppeId) {
      throw new AppError(409, "Die Person ist bereits in einer anderen Gruppe.");
    }
    await this.store.gruppen.assign(ctx.kundeId, memberId, gruppeId);
  }

  async removeFromGruppe(ctx: Ctx, memberId: string): Promise<void> {
    await this.getMember(ctx, memberId);
    await this.store.gruppen.unassign(ctx.kundeId, memberId);
  }

  // Firmenregister

  /** Admin legt an: sofort freigegeben. Selbstregistrierung: `ausstehend`. */
  async createFirma(
    kundeId: string,
    input: FirmaCreate,
    status: "freigegeben" | "ausstehend" = "freigegeben",
    referenz?: string,
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
    const strasse = werte.strasse === "entfernen" ? quelle.adresse : ziel.adresse;
    const plzOrt = werte.plzOrt === "entfernen" ? quelle.adresse : ziel.adresse;
    const adresse: Address = {
      strasse: strasse.strasse,
      ...(strasse.hausnr !== undefined && { hausnr: strasse.hausnr }),
      ...(strasse.zusatz !== undefined && { zusatz: strasse.zusatz }),
      plz: plzOrt.plz,
      ort: plzOrt.ort,
      land: plzOrt.land,
    };
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

  // Duplikate im ganzen Firmenregister

  /** Alle ähnlichen Paare, beste zuerst. Als «kein Duplikat» bestätigte stehen mit diesem Status drin. */
  async listDuplikate(ctx: Ctx): Promise<DuplikatPaar[]> {
    const firmen = await this.store.firmen.listCandidates(ctx.kundeId);
    if (firmen.length > PAIR_SCAN_MAX) {
      throw new AppError(409, "Das Register ist für die Duplikatsuche zu gross.");
    }
    const ausnahmen = await this.store.firmen.duplikatAusnahmen(ctx.kundeId);
    return findDuplicatePairs(firmen).map((p) => {
      const id = `${p.a.id}_${p.b.id}`;
      return { ...p, id, status: ausnahmen.has(id) ? "kein_duplikat" : "offen" };
    });
  }

  /** Ein Paar. 404, wenn eine Firma fehlt, nicht mehr gültig ist oder sich die beiden nicht mehr ähneln. */
  async getDuplikat(ctx: Ctx, id: string): Promise<DuplikatPaar> {
    const [aId, bId] = parsePaar(id);
    const [a, b] = await Promise.all([this.getFirma(ctx, aId), this.getFirma(ctx, bId)]);
    const gueltig = (f: Firma) => f.status === "ausstehend" || f.status === "freigegeben";
    const hit = gueltig(a) && gueltig(b) ? findDuplicates(a, [b])[0] : undefined;
    if (!hit) throw new AppError(404);
    const ausnahmen = await this.store.firmen.duplikatAusnahmen(ctx.kundeId);
    return {
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
    await this.store.firmen.addDuplikatAusnahme(ctx.kundeId, a, b);
  }

  /** `behaltenId` muss eine der beiden Firmen sein; die andere geht in sie auf. */
  async mergeDuplikat(ctx: Ctx, id: string, input: DuplikatMerge): Promise<Firma> {
    const [a, b] = parsePaar(id);
    if (input.behaltenId !== a && input.behaltenId !== b) {
      throw new AppError(400, "Die behaltene Firma gehört nicht zum Paar.");
    }
    return this.mergeFirmen(ctx, input.behaltenId, input.behaltenId === a ? b : a, input.werte);
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

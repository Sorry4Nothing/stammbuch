import { randomUUID } from "node:crypto";
import type {
  BulkAction,
  BulkResult,
  FirmaCreate,
  FirmaUpdate,
  MemberCreate,
  MemberUpdate,
} from "@stammbuch/shared";
import { AppError } from "../../lib/errors.js";
import { findDuplicates } from "./duplicates.js";
import type { Clock, Ctx, Firma, Gruppe, Member } from "./domain.js";
import type { DuplicateMatch } from "./duplicates.js";
import type { PeopleStore } from "./repository.js";

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

  async createMember(kundeId: string, input: MemberCreate): Promise<Member> {
    const firmaId = input.typ === "firma" ? input.firmaId : null;
    if (firmaId) await this.requireFreigegebeneFirma(kundeId, firmaId);
    const now = this.now();
    const member: Member = {
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
      funktion: input.typ === "firma" ? (input.funktion ?? null) : null,
      firmaId,
      gruppeId: null,
      erstelltAm: now,
      geaendertAm: now,
    };
    await this.store.members.insert(member);
    return member;
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

  async createGruppe(ctx: Ctx, name: string): Promise<Gruppe> {
    const g: Gruppe = { id: randomUUID(), kundeId: ctx.kundeId, name };
    await this.store.gruppen.insert(g);
    return g;
  }

  async renameGruppe(ctx: Ctx, id: string, name: string): Promise<void> {
    if (!(await this.store.gruppen.rename(ctx.kundeId, id, name))) throw new AppError(404);
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
      status,
      zusammengefuehrtMit: null,
      erstelltAm: this.now(),
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

  /** Führt `quelleId` in `zielId` zusammen: Mitglieder wandern, leere Felder werden ergänzt. */
  async mergeFirmen(ctx: Ctx, zielId: string, quelleId: string): Promise<Firma> {
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
    const target: Firma = {
      ...ziel,
      uid: ziel.uid ?? quelle.uid,
      mwstNr: ziel.mwstNr ?? quelle.mwstNr,
      email: ziel.email ?? quelle.email,
      telefon: ziel.telefon ?? quelle.telefon,
    };
    await this.store.firmen.merge(ctx.kundeId, target, quelleId, this.now());
    return target;
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

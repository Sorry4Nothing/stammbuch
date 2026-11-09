import { AppError } from "../../lib/errors.js";
import type { Firma, Gruppe, Member, MemberEreignis, PendingRegistration } from "./domain.js";
import { fold } from "./normalize.js";
import type { FirmaQuery, MemberQuery, Page, PeopleStore } from "./repository.js";

const memberKey = (m: Pick<Member, "nachname" | "vorname" | "id">) =>
  `${fold(m.nachname)}\u0000${fold(m.vorname)}\u0000${m.id}`;

function paginate<T>(rows: T[], key: (t: T) => string, limit: number, after?: string): Page<T> {
  const sorted = rows.map((r) => [key(r), r] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const rest = after === undefined ? sorted : sorted.filter(([k]) => k > after);
  const slice = rest.slice(0, limit);
  const last = slice.at(-1);
  return {
    items: slice.map(([, r]) => r),
    next: rest.length > limit && last ? last[0] : null,
    total: rows.length,
  };
}

function matches(haystack: string, q?: string): boolean {
  const tokens = fold(q ?? "")
    .split(" ")
    .filter(Boolean);
  const h = fold(haystack);
  return tokens.every((t) => h.includes(t));
}

const DUP_GROUP = "Eine Gruppe mit diesem Namen existiert bereits.";
const DUP_EMAIL = "E-Mail-Adresse ist bereits vergeben.";

/** Benutzer für «erfasst von»: ID zu Mandant und Name (die Benutzerverwaltung liegt nicht in diesem Speicher). */
export type MemoryBenutzer = Map<string, { kundeId: string; name: string }>;

/** In-Memory-Implementierung für Tests und Entwicklung. Verhält sich wie die SQL-Constraints. */
export function createMemoryStore(benutzer: MemoryBenutzer = new Map()): PeopleStore {
  const members = new Map<string, Member>();
  const gruppen = new Map<string, Gruppe>();
  const firmen = new Map<string, Firma>();
  /** UNIQUE (kunde_id, mitglied_id): Schlüssel ist das Mitglied, nicht die Gruppe. */
  const memberships = new Map<string, { gruppeId: string; seit: Date }>();
  const ausnahmen = new Map<string, Set<string>>();
  const personenAusnahmen = new Map<string, Set<string>>();
  const ereignisse: Array<MemberEreignis & { kundeId: string }> = [];
  const nummern = new Map<string, number>();
  const pending = new Map<string, PendingRegistration>();

  const own = <T extends { kundeId: string }>(row: T | undefined, kundeId: string) =>
    row?.kundeId === kundeId ? row : undefined;
  const withGroup = (m: Member): Member => {
    const g = memberships.get(m.id);
    return { ...m, gruppeId: g?.gruppeId ?? null, gruppeSeit: g?.seit ?? null };
  };
  /** Wie der Trigger der Datenbank: Nummern vergibt nur der Speicher, sie ändern sich nie. */
  const numbered = (m: Member): Member => {
    const n = (nummern.get(m.kundeId) ?? 1000) + 1;
    nummern.set(m.kundeId, n);
    return { ...m, mitgliedsnr: `M-${n}`, gruppeId: null, gruppeSeit: null };
  };
  const assignGroup = (memberId: string, gruppeId: string, seit: Date) => {
    if (memberships.get(memberId)?.gruppeId !== gruppeId) {
      memberships.set(memberId, { gruppeId, seit });
    }
  };
  const emailTaken = (m: Member) =>
    m.email !== null &&
    [...members.values()].some(
      (o) => o.kundeId === m.kundeId && o.id !== m.id && o.email === m.email,
    );
  const nameTaken = (kundeId: string, name: string, exceptId?: string) =>
    [...gruppen.values()].some(
      (o) => o.kundeId === kundeId && o.id !== exceptId && fold(o.name) === fold(name),
    );

  return {
    members: {
      async insert(m) {
        if (emailTaken(m)) throw new AppError(409, DUP_EMAIL);
        const stored = numbered(m);
        members.set(m.id, stored);
        return stored;
      },
      async insertMany(kundeId, list) {
        const seen = new Set<string>();
        for (const m of list) {
          if (emailTaken(m) || (m.email !== null && seen.has(m.email))) {
            throw new AppError(409, DUP_EMAIL);
          }
          if (m.email !== null) seen.add(m.email);
        }
        return list.map((m) => {
          const stored = numbered({ ...m, kundeId });
          members.set(m.id, stored);
          return stored;
        });
      },
      async importieren(kundeId, batch) {
        // Alles prüfen, bevor etwas geschrieben wird: alles oder nichts.
        const changedIds = new Set(batch.geaendert.map((m) => m.id));
        for (const m of batch.geaendert) {
          if (!own(members.get(m.id), kundeId)) throw new AppError(404);
        }
        const known = new Set([...batch.neu, ...batch.geaendert].map((m) => m.id));
        for (const [memberId, gruppeId] of batch.gruppen) {
          if (!known.has(memberId) || !own(gruppen.get(gruppeId), kundeId)) {
            throw new AppError(404);
          }
        }
        const mails = [...batch.neu, ...batch.geaendert].flatMap((m) =>
          m.email === null ? [] : [m.email],
        );
        const fremd = [...members.values()].some(
          (o) =>
            o.kundeId === kundeId &&
            !changedIds.has(o.id) &&
            o.email !== null &&
            mails.includes(o.email),
        );
        if (fremd || new Set(mails).size !== mails.length) throw new AppError(409, DUP_EMAIL);

        const created = batch.neu.map((m) => {
          const stored = numbered({ ...m, kundeId });
          members.set(m.id, stored);
          return stored;
        });
        for (const m of batch.geaendert) {
          const old = members.get(m.id) as Member;
          members.set(m.id, {
            ...m,
            mitgliedsnr: old.mitgliedsnr,
            gruppeId: null,
            gruppeSeit: null,
          });
        }
        const seit = new Date();
        for (const [memberId, gruppeId] of batch.gruppen) {
          memberships.delete(memberId);
          assignGroup(memberId, gruppeId, seit);
        }
        return created.map(withGroup);
      },
      async get(kundeId, id) {
        const m = own(members.get(id), kundeId);
        return m && withGroup(m);
      },
      async save(m) {
        const old = own(members.get(m.id), m.kundeId);
        if (!old) throw new AppError(404);
        if (emailTaken(m)) throw new AppError(409, DUP_EMAIL);
        members.set(m.id, { ...m, mitgliedsnr: old.mitgliedsnr, gruppeId: null, gruppeSeit: null });
      },
      async findByEmail(kundeId, email) {
        const m = [...members.values()].find((o) => o.kundeId === kundeId && o.email === email);
        return m && withGroup(m);
      },
      async existingByEmail(kundeId, emails) {
        const wanted = new Set(emails);
        return new Map(
          [...members.values()]
            .filter((m) => m.kundeId === kundeId && m.email !== null && wanted.has(m.email))
            .map((m) => [m.email as string, withGroup(m)]),
        );
      },
      async list(kundeId, q: MemberQuery) {
        const rows = [...members.values()]
          .filter(
            (m) =>
              m.kundeId === kundeId &&
              (q.status === "alle" ? m.status !== "zusammengefuehrt" : m.status === q.status) &&
              (!q.quelle || m.quelle === q.quelle),
          )
          .map(withGroup)
          .filter(
            (m) =>
              (!q.typ || m.typ === q.typ) &&
              (!q.gruppeId || m.gruppeId === q.gruppeId) &&
              (!q.firmaId || m.firmaId === q.firmaId) &&
              (!q.ohneGruppe || m.gruppeId === null) &&
              matches(
                [
                  m.vorname,
                  m.nachname,
                  m.email,
                  m.telefon,
                  m.mobil,
                  m.adresse?.ort,
                  m.adresse?.plz,
                  m.firmaId && firmen.get(m.firmaId)?.name,
                ].join(" "),
                q.q,
              ),
          );
        return paginate(rows, memberKey, q.limit, q.after);
      },
      async listCandidates(kundeId) {
        return [...members.values()]
          .filter(
            (m) =>
              m.kundeId === kundeId &&
              m.typ === "einzel" &&
              (m.status === "aktiv" || m.status === "ausstehend" || m.status === "archiviert"),
          )
          .map(withGroup);
      },
      async duplikatAusnahmen(kundeId) {
        return new Set(personenAusnahmen.get(kundeId));
      },
      async addDuplikatAusnahme(kundeId, a, b) {
        if (!own(members.get(a), kundeId) || !own(members.get(b), kundeId)) {
          throw new AppError(404);
        }
        personenAusnahmen.set(
          kundeId,
          (personenAusnahmen.get(kundeId) ?? new Set()).add(`${a}_${b}`),
        );
      },
      async merge(kundeId, target, sourceId, now) {
        const source = own(members.get(sourceId), kundeId);
        const ziel = own(members.get(target.id), kundeId);
        if (!source || !ziel) throw new AppError(404);
        if (
          ziel.status !== "aktiv" ||
          source.status === "zusammengefuehrt" ||
          source.status === "abgelehnt"
        ) {
          throw new AppError(409, "Die Personen wurden inzwischen geändert.");
        }
        const von = memberships.get(sourceId);
        const nach = memberships.get(target.id);
        if (von && nach && von.gruppeId !== nach.gruppeId) {
          throw new AppError(409, "Die Personen sind in verschiedenen Gruppen.");
        }
        if (von && !nach) memberships.set(target.id, von);
        memberships.delete(sourceId);
        members.set(sourceId, {
          ...source,
          status: "zusammengefuehrt",
          zusammengefuehrtMit: target.id,
          email: null,
          geaendertAm: now,
        });
        members.set(target.id, {
          ...target,
          mitgliedsnr: ziel.mitgliedsnr,
          gruppeId: null,
          gruppeSeit: null,
        });
      },
      async mergedInto(kundeId, id) {
        return [...members.values()]
          .filter((m) => m.kundeId === kundeId && m.zusammengefuehrtMit === id)
          .map((m) => m.id);
      },
      async addEreignis(kundeId, e) {
        if (!own(members.get(e.memberId), kundeId)) throw new AppError(404);
        ereignisse.push({ ...e, kundeId });
      },
      async ereignisse(kundeId, memberIds) {
        return ereignisse
          .filter((e) => e.kundeId === kundeId && memberIds.includes(e.memberId))
          .map((e) => ({ memberId: e.memberId, art: e.art, detail: e.detail, am: e.am }))
          .sort((a, b) => a.am.getTime() - b.am.getTime());
      },
    },
    gruppen: {
      async insert(g) {
        if (nameTaken(g.kundeId, g.name)) throw new AppError(409, DUP_GROUP);
        gruppen.set(g.id, g);
      },
      async get(kundeId, id) {
        return own(gruppen.get(id), kundeId);
      },
      async list(kundeId) {
        // Adresslisten gehören zum Mail-Modul und liegen nicht in diesem Speicher.
        return [...gruppen.values()]
          .filter((g) => g.kundeId === kundeId)
          .map((g) => ({
            ...g,
            mitglieder: [...memberships.values()].filter((m) => m.gruppeId === g.id).length,
            adresslisten: [],
          }))
          .sort((a, b) => fold(a.name).localeCompare(fold(b.name)));
      },
      async update(kundeId, id, patch, now) {
        const g = own(gruppen.get(id), kundeId);
        if (!g) return false;
        if (patch.name !== undefined && nameTaken(kundeId, patch.name, id)) {
          throw new AppError(409, DUP_GROUP);
        }
        gruppen.set(id, {
          ...g,
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.beschreibung !== undefined && { beschreibung: patch.beschreibung }),
          geaendertAm: now,
        });
        return true;
      },
      async dissolve(kundeId, id) {
        if (!own(gruppen.get(id), kundeId)) return false;
        gruppen.delete(id);
        for (const [mid, m] of memberships) if (m.gruppeId === id) memberships.delete(mid);
        return true;
      },
      async assign(kundeId, memberId, gruppeId) {
        if (!own(members.get(memberId), kundeId) || !own(gruppen.get(gruppeId), kundeId)) {
          throw new AppError(404);
        }
        const current = memberships.get(memberId);
        if (current !== undefined && current.gruppeId !== gruppeId) {
          throw new AppError(409, "Die Person ist bereits in einer anderen Gruppe.");
        }
        assignGroup(memberId, gruppeId, new Date());
      },
      async unassign(kundeId, memberId) {
        if (own(members.get(memberId), kundeId)) memberships.delete(memberId);
      },
    },
    firmen: {
      async insert(f) {
        firmen.set(f.id, f);
      },
      async get(kundeId, id) {
        return own(firmen.get(id), kundeId);
      },
      async getMany(kundeId, ids) {
        return ids.flatMap((id) => own(firmen.get(id), kundeId) ?? []);
      },
      async countMitglieder(kundeId, ids) {
        const counts = new Map(ids.map((id) => [id, 0]));
        for (const m of members.values()) {
          if (m.kundeId === kundeId && m.status === "aktiv" && m.firmaId && counts.has(m.firmaId)) {
            counts.set(m.firmaId, (counts.get(m.firmaId) ?? 0) + 1);
          }
        }
        return counts;
      },
      async save(f) {
        if (!own(firmen.get(f.id), f.kundeId)) throw new AppError(404);
        firmen.set(f.id, f);
      },
      async list(kundeId, q: FirmaQuery) {
        const rows = [...firmen.values()].filter(
          (f) =>
            f.kundeId === kundeId &&
            (!q.status || f.status === q.status) &&
            (!q.quelle || f.quelle === q.quelle) &&
            matches([f.name, f.uid, f.adresse.ort].join(" "), q.q),
        );
        return paginate(rows, (f) => `${fold(f.name)}\u0000${f.id}`, q.limit, q.after);
      },
      async listCandidates(kundeId) {
        return [...firmen.values()].filter(
          (f) => f.kundeId === kundeId && (f.status === "ausstehend" || f.status === "freigegeben"),
        );
      },
      async merge(kundeId, target, sourceId, now) {
        const source = own(firmen.get(sourceId), kundeId);
        if (!source || !own(firmen.get(target.id), kundeId)) throw new AppError(404);
        for (const m of members.values()) {
          if (m.kundeId === kundeId && m.firmaId === sourceId) {
            members.set(m.id, { ...m, firmaId: target.id, geaendertAm: now });
          }
        }
        firmen.set(target.id, target);
        firmen.set(sourceId, {
          ...source,
          status: "zusammengefuehrt",
          zusammengefuehrtMit: target.id,
        });
      },
      async duplikatAusnahmen(kundeId) {
        return new Set(ausnahmen.get(kundeId));
      },
      async addDuplikatAusnahme(kundeId, a, b) {
        if (!own(firmen.get(a), kundeId) || !own(firmen.get(b), kundeId)) throw new AppError(404);
        ausnahmen.set(kundeId, (ausnahmen.get(kundeId) ?? new Set()).add(`${a}_${b}`));
      },
    },
    benutzer: {
      async names(kundeId, ids) {
        return new Map(
          ids.flatMap((id) => {
            const b = benutzer.get(id);
            return b?.kundeId === kundeId ? [[id, b.name] as [string, string]] : [];
          }),
        );
      },
    },
    registrations: {
      async put(p) {
        pending.set(p.tokenHash, p);
      },
      async take(tokenHash) {
        const p = pending.get(tokenHash);
        pending.delete(tokenHash);
        return p;
      },
    },
  };
}

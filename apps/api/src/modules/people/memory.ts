import { AppError } from "../../lib/errors.js";
import type { Firma, Gruppe, Member, PendingRegistration } from "./domain.js";
import { fold } from "./normalize.js";
import type { FirmaQuery, MemberQuery, Page, PeopleStore } from "./repository.js";

const memberKey = (m: Pick<Member, "nachname" | "vorname" | "id">) =>
  `${fold(m.nachname)}\u0000${fold(m.vorname)}\u0000${m.id}`;

function paginate<T>(rows: T[], key: (t: T) => string, limit: number, after?: string): Page<T> {
  const sorted = rows.map((r) => [key(r), r] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const rest = after === undefined ? sorted : sorted.filter(([k]) => k > after);
  const slice = rest.slice(0, limit);
  const last = slice.at(-1);
  return { items: slice.map(([, r]) => r), next: rest.length > limit && last ? last[0] : null };
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

/** In-Memory-Implementierung für Tests und Entwicklung. Verhält sich wie die SQL-Constraints. */
export function createMemoryStore(): PeopleStore {
  const members = new Map<string, Member>();
  const gruppen = new Map<string, Gruppe>();
  const firmen = new Map<string, Firma>();
  /** UNIQUE (kunde_id, mitglied_id): Schlüssel ist das Mitglied, nicht die Gruppe. */
  const memberships = new Map<string, string>();
  const pending = new Map<string, PendingRegistration>();

  const own = <T extends { kundeId: string }>(row: T | undefined, kundeId: string) =>
    row?.kundeId === kundeId ? row : undefined;
  const withGroup = (m: Member): Member => ({ ...m, gruppeId: memberships.get(m.id) ?? null });
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
        members.set(m.id, { ...m, gruppeId: null });
      },
      async get(kundeId, id) {
        const m = own(members.get(id), kundeId);
        return m && withGroup(m);
      },
      async save(m) {
        if (!own(members.get(m.id), m.kundeId)) throw new AppError(404);
        if (emailTaken(m)) throw new AppError(409, DUP_EMAIL);
        members.set(m.id, { ...m, gruppeId: null });
      },
      async findByEmail(kundeId, email) {
        const m = [...members.values()].find((o) => o.kundeId === kundeId && o.email === email);
        return m && withGroup(m);
      },
      async list(kundeId, q: MemberQuery) {
        const rows = [...members.values()]
          .filter((m) => m.kundeId === kundeId && m.status === q.status)
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
        return [...gruppen.values()]
          .filter((g) => g.kundeId === kundeId)
          .map((g) => ({
            ...g,
            mitglieder: [...memberships.values()].filter((gid) => gid === g.id).length,
          }))
          .sort((a, b) => fold(a.name).localeCompare(fold(b.name)));
      },
      async rename(kundeId, id, name) {
        const g = own(gruppen.get(id), kundeId);
        if (!g) return false;
        if (nameTaken(kundeId, name, id)) throw new AppError(409, DUP_GROUP);
        gruppen.set(id, { ...g, name });
        return true;
      },
      async dissolve(kundeId, id) {
        if (!own(gruppen.get(id), kundeId)) return false;
        gruppen.delete(id);
        for (const [mid, gid] of memberships) if (gid === id) memberships.delete(mid);
        return true;
      },
      async assign(kundeId, memberId, gruppeId) {
        if (!own(members.get(memberId), kundeId) || !own(gruppen.get(gruppeId), kundeId)) {
          throw new AppError(404);
        }
        const current = memberships.get(memberId);
        if (current !== undefined && current !== gruppeId) {
          throw new AppError(409, "Die Person ist bereits in einer anderen Gruppe.");
        }
        memberships.set(memberId, gruppeId);
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
      async save(f) {
        if (!own(firmen.get(f.id), f.kundeId)) throw new AppError(404);
        firmen.set(f.id, f);
      },
      async list(kundeId, q: FirmaQuery) {
        const rows = [...firmen.values()].filter(
          (f) =>
            f.kundeId === kundeId &&
            (!q.status || f.status === q.status) &&
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

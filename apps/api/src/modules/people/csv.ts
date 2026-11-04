import { memberCreateSchema } from "@stammbuch/shared";
import type { MemberCreate, MemberListQuery } from "@stammbuch/shared";
import { AppError } from "../../lib/errors.js";
import type { Ctx, Firma } from "./domain.js";
import { fold, normalizeCompanyName } from "./normalize.js";
import type { PeopleService } from "./service.js";

export const CSV_MAX_BYTES = 2 * 1024 * 1024;
export const CSV_MAX_ROWS = 5_000;
const EXPORT_MAX_ROWS = 50_000;

/**
 * CSV-Injection: Zellen, die mit = + - @ oder Tab/CR beginnen, werden von Excel & Co. als Formel
 * gelesen. Wir stellen ein ' voran (OWASP). Reine internationale Telefonnummern sind ausgenommen.
 */
export function neutralizeCell(value: string): string {
  if (/^\+\d{8,15}$/.test(value)) return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** Gegenstück beim Import: entfernt das ' wieder, das `neutralizeCell` vorangestellt hat. */
export function restoreCell(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

const quote = (v: string) => (/[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCsv(rows: string[][]): string {
  // Semikolon als Trenner, weil Schweizer Excel-Installationen das erwarten. BOM für Umlaute.
  return (
    "\uFEFF" +
    rows.map((r) => r.map((c) => quote(neutralizeCell(c))).join(";")).join("\r\n") +
    "\r\n"
  );
}

/** RFC-4180-Parser mit automatischem Trenner (; , oder Tab). */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delim = [";", ",", "\t"].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') inQuotes = false;
      else cell += c;
    } else if (c === '"' && cell === "") inQuotes = true;
    else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
      if (rows.length > CSV_MAX_ROWS + 1) throw new AppError(400, "Die Datei hat zu viele Zeilen.");
    } else cell += c;
  }
  if (inQuotes) throw new AppError(400, "Die CSV-Datei ist fehlerhaft.");
  row.push(cell);
  if (row.some((v) => v !== "")) rows.push(row);
  return rows;
}

const HEADER = [
  "Typ",
  "Vorname",
  "Nachname",
  "Firma",
  "E-Mail",
  "Telefon",
  "Mobil",
  "Strasse",
  "Hausnr",
  "PLZ",
  "Ort",
  "Land",
  "Gruppe",
];

export async function exportMembersCsv(
  people: PeopleService,
  ctx: Ctx,
  filter: MemberListQuery,
): Promise<string> {
  const gruppen = new Map(
    (await people.store.gruppen.list(ctx.kundeId)).map((g) => [g.id, g.name]),
  );
  const rows: string[][] = [HEADER];
  let after: string | undefined;
  do {
    const { q, typ, status, gruppeId, firmaId, ohneGruppe } = filter;
    const page = await people.store.members.list(ctx.kundeId, {
      ...{ q, typ, status, gruppeId, firmaId, ohneGruppe },
      limit: 200,
      after,
    });
    const firmen = new Map(
      (
        await people.store.firmen.getMany(
          ctx.kundeId,
          page.items.flatMap((m) => (m.firmaId ? [m.firmaId] : [])),
        )
      ).map((f) => [f.id, f.name]),
    );
    for (const m of page.items) {
      rows.push([
        m.typ,
        m.vorname,
        m.nachname,
        (m.firmaId && firmen.get(m.firmaId)) || "",
        m.email ?? "",
        m.telefon ?? "",
        m.mobil ?? "",
        m.adresse?.strasse ?? "",
        m.adresse?.hausnr ?? "",
        m.adresse?.plz ?? "",
        m.adresse?.ort ?? "",
        m.adresse?.land ?? "",
        (m.gruppeId && gruppen.get(m.gruppeId)) || "",
      ]);
    }
    after = page.next ?? undefined;
    if (rows.length > EXPORT_MAX_ROWS)
      throw new AppError(409, "Zu viele Einträge für einen Export.");
  } while (after);
  return toCsv(rows);
}

export interface ImportReport {
  zeilen: number;
  importiert: number;
  /** Nur Zeilennummer und Feldnamen, keine Werte (SR-50). Zeile 1 ist die Kopfzeile. */
  fehler: Array<{
    zeile: number;
    grund: "UNGUELTIG" | "FIRMA_UNBEKANNT" | "E_MAIL_DOPPELT";
    felder: string[];
  }>;
}

const COLUMN_KEYS: Record<string, string> = {
  typ: "typ",
  vorname: "vorname",
  nachname: "nachname",
  firma: "firma",
  "e mail": "email",
  email: "email",
  telefon: "telefon",
  mobil: "mobil",
  strasse: "strasse",
  hausnr: "hausnr",
  plz: "plz",
  ort: "ort",
  land: "land",
};

/**
 * Grundfunktion: feste Spalten (siehe Export). Mit `dryRun` wird nur geprüft. Importiert wird
 * alles oder nichts: sobald eine Zeile fehlerhaft ist, bleibt der Bestand unverändert.
 */
export async function importMembersCsv(
  people: PeopleService,
  ctx: Ctx,
  csv: string,
  dryRun: boolean,
): Promise<ImportReport> {
  const [head, ...data] = parseCsv(csv);
  const cols = (head ?? []).map((h) => COLUMN_KEYS[fold(h)]);
  for (const need of ["vorname", "nachname"]) {
    if (!cols.includes(need)) throw new AppError(400, "Pflichtspalten fehlen (Vorname, Nachname).");
  }

  const freigegeben = await people.store.firmen.list(ctx.kundeId, {
    limit: 200,
    status: "freigegeben",
  });
  const byName = new Map<string, Firma[]>();
  for (let page = freigegeben; ;) {
    for (const f of page.items) {
      const k = normalizeCompanyName(f.name);
      byName.set(k, [...(byName.get(k) ?? []), f]);
    }
    if (!page.next) break;
    page = await people.store.firmen.list(ctx.kundeId, {
      limit: 200,
      status: "freigegeben",
      after: page.next,
    });
  }

  const report: ImportReport = { zeilen: data.length, importiert: 0, fehler: [] };
  const valid: MemberCreate[] = [];
  const seen = new Set<string>();

  for (const [i, cells] of data.entries()) {
    const zeile = i + 2;
    const r: Record<string, string> = {};
    cols.forEach((key, idx) => {
      const v = restoreCell((cells[idx] ?? "").trim());
      if (key && v !== "") r[key] = v;
    });

    let firmaId: string | undefined;
    if (r.firma) {
      const hits = byName.get(normalizeCompanyName(r.firma)) ?? [];
      if (hits.length !== 1) {
        report.fehler.push({ zeile, grund: "FIRMA_UNBEKANNT", felder: ["firma"] });
        continue;
      }
      firmaId = hits[0]?.id;
    }
    const hasAddress = r.strasse || r.plz || r.ort;
    const parsed = memberCreateSchema.safeParse({
      typ: r.typ ?? (firmaId ? "firma" : "einzel"),
      firmaId,
      vorname: r.vorname,
      nachname: r.nachname,
      email: r.email,
      telefon: r.telefon,
      mobil: r.mobil,
      adresse: hasAddress
        ? { strasse: r.strasse, hausnr: r.hausnr, plz: r.plz, ort: r.ort, land: r.land }
        : undefined,
    });
    if (!parsed.success) {
      const felder = [...new Set(parsed.error.issues.map((x) => String(x.path[0] ?? "zeile")))];
      report.fehler.push({ zeile, grund: "UNGUELTIG", felder });
      continue;
    }
    const email = parsed.data.email;
    if (
      email &&
      (seen.has(email) || (await people.store.members.findByEmail(ctx.kundeId, email)))
    ) {
      report.fehler.push({ zeile, grund: "E_MAIL_DOPPELT", felder: ["email"] });
      continue;
    }
    if (email) seen.add(email);
    valid.push(parsed.data);
  }

  if (!dryRun && report.fehler.length === 0) {
    for (const m of valid) await people.createMember(ctx.kundeId, m);
    report.importiert = valid.length;
  }
  return report;
}

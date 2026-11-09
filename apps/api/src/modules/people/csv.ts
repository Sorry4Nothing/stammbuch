import { memberCreateSchema } from "@stammbuch/shared";
import type { MemberCreate, MemberListQuery } from "@stammbuch/shared";
import type { MemberUpdate } from "@stammbuch/shared";
import { AppError } from "../../lib/errors.js";
import type { Ctx, Firma, Member } from "./domain.js";
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

export interface ImportOptions {
  /** Bekannte E-Mail-Adresse: Mitglied ändern statt Fehler (`duplikate` gilt dann nicht). */
  aktualisieren: boolean;
  /** Bekannte E-Mail-Adresse ohne `aktualisieren`: Zeile auslassen oder als Fehler melden. */
  duplikate: "fehler" | "ueberspringen";
  /** Gruppe für alle Zeilen ohne eigene Gruppenspalte. */
  gruppeId?: string | undefined;
}

export interface ImportReport {
  zeilen: number;
  importiert: number;
  /** Bestehende Mitglieder, die geändert werden (bzw. wurden). */
  aktualisiert: number;
  /** Zeilen mit bekannter E-Mail-Adresse, die ausgelassen werden (bzw. wurden). */
  uebersprungen: number;
  /** Nur Zeilennummer und Feldnamen, keine Werte (SR-50). Zeile 1 ist die Kopfzeile. */
  fehler: Array<{
    zeile: number;
    grund: "UNGUELTIG" | "FIRMA_UNBEKANNT" | "GRUPPE_UNBEKANNT" | "E_MAIL_DOPPELT";
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
  gruppe: "gruppe",
};

const DEFAULT_OPTIONS: ImportOptions = { aktualisieren: false, duplikate: "fehler" };

/**
 * Grundfunktion: feste Spalten (siehe Export). Mit `dryRun` wird nur geprüft. Importiert wird
 * alles oder nichts: sobald eine Zeile fehlerhaft ist, bleibt der Bestand unverändert.
 */
export async function importMembersCsv(
  people: PeopleService,
  ctx: Ctx,
  csv: string,
  dryRun: boolean,
  options: ImportOptions = DEFAULT_OPTIONS,
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

  if (options.gruppeId && !(await people.store.gruppen.get(ctx.kundeId, options.gruppeId))) {
    throw new AppError(400, "Die Gruppe ist nicht verfügbar.");
  }
  const gruppenByName = new Map(
    (await people.store.gruppen.list(ctx.kundeId)).map((g) => [fold(g.name), g.id]),
  );

  // Vergebene E-Mail-Adressen in einer Abfrage statt einer je Zeile.
  const emailCol = cols.indexOf("email");
  const taken = await people.store.members.existingByEmail(
    ctx.kundeId,
    emailCol < 0
      ? []
      : data.flatMap((r) => (r[emailCol]?.trim() ? [r[emailCol].trim().toLowerCase()] : [])),
  );

  const report: ImportReport = {
    zeilen: data.length,
    importiert: 0,
    aktualisiert: 0,
    uebersprungen: 0,
    fehler: [],
  };
  const neu: Array<{ input: MemberCreate; gruppeId: string | undefined }> = [];
  const geaendert: Array<{ member: Member; patch: MemberUpdate; gruppeId: string | undefined }> =
    [];
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
    let gruppeId = options.gruppeId;
    if (r.gruppe) {
      gruppeId = gruppenByName.get(fold(r.gruppe));
      if (!gruppeId) {
        report.fehler.push({ zeile, grund: "GRUPPE_UNBEKANNT", felder: ["gruppe"] });
        continue;
      }
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
    const existing = email ? taken.get(email) : undefined;
    if (email && seen.has(email)) {
      report.fehler.push({ zeile, grund: "E_MAIL_DOPPELT", felder: ["email"] });
      continue;
    }
    if (email) seen.add(email);
    if (existing && options.aktualisieren) {
      // Nur Angaben der Zeile überschreiben; Typ, Firma, E-Mail und Notiz bleiben.
      const { vorname, nachname, telefon, mobil, adresse } = parsed.data;
      geaendert.push({
        member: existing,
        patch: { vorname, nachname, telefon, mobil, adresse },
        gruppeId,
      });
    } else if (existing && options.duplikate === "ueberspringen") {
      report.uebersprungen++;
    } else if (existing) {
      report.fehler.push({ zeile, grund: "E_MAIL_DOPPELT", felder: ["email"] });
    } else {
      neu.push({ input: parsed.data, gruppeId });
    }
  }
  report.aktualisiert = geaendert.length;

  if (!dryRun && report.fehler.length === 0) {
    // Eine Transaktion: schlägt etwas fehl (z. B. parallel vergebene E-Mail), bleibt nichts zurück.
    await people.importMembers(ctx.kundeId, neu, geaendert);
    report.importiert = neu.length;
  }
  return report;
}

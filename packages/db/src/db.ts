import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";

const DATE_OID = 1082;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verbindung der Anwendung. `connectionString` gehört der Rolle stammbuch_app (DATABASE_URL),
 * nie dem Eigentümer: nur so greift Row-Level-Security (SR-10, SR-11).
 */
export class Datenbank {
  /**
   * Nur für kundenunabhängige Funktionen (Anmeldung, Sitzung). Tabellen immer über `withKunde` lesen
   * und schreiben: ohne Mandant liefern alle Tabellen keine Zeilen (fail secure, SR-54).
   */
  readonly kysely: Kysely<Database>;

  constructor(connectionString: string, options: { max?: number } = {}) {
    // Zertifikats- und Verschlüsselungsoptionen kommen über `sslmode` in der URL (SR-40).
    const pool = new pg.Pool({
      connectionString,
      max: options.max ?? 10,
      connectionTimeoutMillis: 5_000,
      // date (ohne Zeitzone) bleibt der String 'YYYY-MM-DD'. Ein JS-Date würde es in die lokale Zeitzone schieben.
      types: {
        getTypeParser: ((oid: number, format?: "text" | "binary") =>
          oid === DATE_OID
            ? (v: string) => v
            : pg.types.getTypeParser(oid, format as "text")) as typeof pg.types.getTypeParser,
      },
    });
    this.kysely = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  }

  /**
   * Führt `fn` in einer Transaktion für genau einen Kunden aus. Der Mandant gilt nur bis zum Ende der
   * Transaktion (set_config mit is_local), kann also nie über die Pool-Verbindung zu einer
   * anderen Anfrage durchsickern. `kundeId` kommt aus der serverseitig aufgelösten Sitzung (SR-13).
   */
  withKunde<T>(kundeId: string, fn: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
    if (!uuidPattern.test(kundeId)) throw new Error("Ungültige Kunden-ID");
    return this.kysely.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.kunde_id', ${kundeId}, true)`.execute(trx);
      return fn(trx);
    });
  }

  /** Schlüssel zur Anmeldung: Benutzer per E-Mail finden, noch ohne Mandant. Höchstens eine Zeile. */
  async findeBenutzerFuerAnmeldung(email: string) {
    const { rows } = await sql<{
      id: string;
      kunde_id: string;
      passwort_hash: string;
      aktiv: boolean;
    }>`SELECT * FROM benutzer_fuer_anmeldung(${email})`.execute(this.kysely);
    return rows[0];
  }

  /** Gültige Sitzung zu einem Token-Hash (SHA-256, 32 Bytes) auflösen, noch ohne Mandant. */
  async loeseSitzungAuf(tokenHash: Buffer) {
    const { rows } = await sql<{
      id: string;
      kunde_id: string;
      benutzer_id: string;
      laeuft_ab_am: Date;
    }>`SELECT * FROM sitzung_aufloesen(${tokenHash})`.execute(this.kysely);
    return rows[0];
  }

  close(): Promise<void> {
    return this.kysely.destroy();
  }
}

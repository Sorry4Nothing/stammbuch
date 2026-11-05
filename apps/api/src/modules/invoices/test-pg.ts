import { randomBytes } from "node:crypto";
import { Datenbank, migrate, setAppRolePassword } from "@stammbuch/db";
import { startTestContainer } from "@stammbuch/db/testing";
import pg from "pg";
import { createPgRepositories } from "./pg-repository.js";
import { InvoiceService } from "./service.js";
import { OTHER_TENANT, TENANT, type TestContext } from "./test-fixtures.js";

/**
 * Testumgebung mit echter PostgreSQL-Datenbank. Startet einen eigenen, flüchtigen Container
 * (postgres:18-alpine, nur Loopback, zufälliger Port und Passwort, tmpfs) und migriert eine Vorlage-Datenbank;
 * jeder Test bekommt per CREATE DATABASE ... TEMPLATE eine frische Kopie. Bestehende Container und Datenbanken
 * bleiben unberührt. Alternativ TEST_DATABASE_URL auf einen Cluster (Rolle mit CREATEDB und CREATEROLE).
 */
const rand = () => randomBytes(6).toString("hex");

function withDatabase(url: string, database: string, user?: string, password?: string) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

export interface TestDatabase {
  /** Verbindung als Eigentümer (für Fixtures und Prüfungen an RLS vorbei). */
  ownerUrl: string;
  /** Verbindung als Anwendungsrolle stammbuch_app. */
  appUrl: string;
}

export class PgTestServer {
  private readonly cleanups: (() => Promise<void>)[] = [];

  private constructor(
    private readonly adminUrl: string,
    private readonly template: string,
    private readonly appPassword: string,
    private readonly stopContainer: (() => void) | undefined,
  ) {}

  static async start(): Promise<PgTestServer> {
    const external = process.env.TEST_DATABASE_URL;
    let adminUrl = external;
    let stop: (() => void) | undefined;
    if (!adminUrl) {
      const container = await startTestContainer("api", ["-c", "max_connections=200"]);
      adminUrl = container.url;
      stop = container.stop;
    }
    const template = `stammbuch_tpl_${rand()}`;
    const appPassword = randomBytes(16).toString("hex");
    try {
      const admin = new pg.Client({ connectionString: adminUrl });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${template}`);
      await admin.end();
      await migrate(withDatabase(adminUrl, template));
      await setAppRolePassword(withDatabase(adminUrl, template), appPassword);
    } catch (err) {
      stop?.();
      throw err;
    }
    return new PgTestServer(adminUrl, template, appPassword, stop);
  }

  /** Frische Datenbank aus der migrierten Vorlage mit den beiden Test-Kunden TENANT und OTHER_TENANT. */
  async newDatabase(): Promise<TestDatabase> {
    const name = `stammbuch_test_${rand()}`;
    const admin = new pg.Client({ connectionString: this.adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${this.template}`);
    await admin.end();
    this.cleanups.push(async () => {
      const c = new pg.Client({ connectionString: this.adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    });
    const ownerUrl = withDatabase(this.adminUrl, name);
    const owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    await owner.query("INSERT INTO kunde (id, name) VALUES ($1, 'Kunde A'), ($2, 'Kunde B')", [
      TENANT,
      OTHER_TENANT,
    ]);
    await owner.end();
    return { ownerUrl, appUrl: withDatabase(ownerUrl, name, "stammbuch_app", this.appPassword) };
  }

  /** Service gegen PostgreSQL (wie in der Produktivverdrahtung, mit Transaktionen). Räumt `stop()` auf. */
  async newContext(
    today = "2026-11-04T10:00:00Z",
    options: { max?: number } = {},
  ): Promise<TestContext & { db: Datenbank; database: TestDatabase }> {
    const database = await this.newDatabase();
    const db = new Datenbank(database.appUrl, options);
    this.cleanups.unshift(() => db.close());
    const clock = { now: new Date(today) };
    let n = 0;
    const { transaction, ...repos } = createPgRepositories(db);
    const service = new InvoiceService({
      ...repos,
      transaction,
      now: () => clock.now,
      newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    });
    return { service, repos, clock, db, database };
  }

  async stop() {
    for (const fn of this.cleanups.splice(0)) await fn().catch(() => {});
    if (this.stopContainer) {
      this.stopContainer();
      return;
    }
    const c = new pg.Client({ connectionString: this.adminUrl });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${this.template} WITH (FORCE)`);
    await c.end();
  }
}

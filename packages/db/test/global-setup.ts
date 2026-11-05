import { randomBytes } from "node:crypto";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { migrate, setAppRolePassword } from "../src/migrate.js";
import { startTestContainer } from "./container.js";
import { withDatabaseName } from "./helpers.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** Eigentümer-Verbindung (Superuser des Test-Clusters). */
    adminUrl: string;
    /** Name der bereits migrierten Vorlagen-Datenbank. */
    templateDb: string;
    /** Passwort der Rolle stammbuch_app im Test-Cluster. */
    appPassword: string;
    /** Passwort der Rolle stammbuch_worker im Test-Cluster. */
    workerPassword: string;
  }
}

const rand = () => randomBytes(6).toString("hex");

export default async function setup(project: TestProject) {
  // TEST_DATABASE_URL: bestehender Cluster (CI-Service); Rolle braucht CREATEDB und CREATEROLE.
  // Ohne die Variable startet der Lauf einen eigenen Docker-Container und räumt ihn danach auf.
  const external = process.env.TEST_DATABASE_URL;
  const container = external ? undefined : await startTestContainer("db");
  const adminUrl = external ?? container!.url;

  const templateDb = `stammbuch_tpl_${rand()}`;
  const appPassword = randomBytes(16).toString("hex");
  const workerPassword = randomBytes(16).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${templateDb}`);
    await migrate(withDatabaseName(adminUrl, templateDb));
    await setAppRolePassword(withDatabaseName(adminUrl, templateDb), appPassword);
    await setAppRolePassword(
      withDatabaseName(adminUrl, templateDb),
      workerPassword,
      "stammbuch_worker",
    );
  } finally {
    await admin.end();
  }

  project.provide("adminUrl", adminUrl);
  project.provide("templateDb", templateDb);
  project.provide("appPassword", appPassword);
  project.provide("workerPassword", workerPassword);

  return async () => {
    if (container) {
      container.stop();
      return;
    }
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${templateDb} WITH (FORCE)`);
    await cleanup.end();
  };
}

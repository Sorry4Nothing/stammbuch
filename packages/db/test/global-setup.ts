import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { migrate, setAppRolePassword } from "../src/migrate.js";
import { withDatabaseName } from "./helpers.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** Eigentümer-Verbindung (Superuser des Test-Clusters). */
    adminUrl: string;
    /** Name der bereits migrierten Vorlagen-Datenbank. */
    templateDb: string;
    /** Passwort der Rolle stammbuch_app im Test-Cluster. */
    appPassword: string;
  }
}

const rand = () => randomBytes(6).toString("hex");

/** Startet einen eigenen, flüchtigen Postgres-18-Container (tmpfs, nur Loopback, zufälliger Port und Passwort). */
async function startContainer() {
  const name = `stammbuch-test-db-${rand()}`;
  const password = randomBytes(16).toString("hex");
  execFileSync("docker", [
    "run", "-d", "--rm", "--name", name,
    "-e", `POSTGRES_PASSWORD=${password}`,
    "--tmpfs", "/var/lib/postgresql",
    "-p", "127.0.0.1::5432",
    "postgres:18-alpine", "-c", "fsync=off",
  ], { stdio: "pipe" }); // prettier-ignore
  const port = execFileSync("docker", ["port", name, "5432/tcp"], { encoding: "utf8" })
    .trim()
    .split("\n")[0]!
    .split(":")
    .pop();
  const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  const stop = () => execFileSync("docker", ["rm", "-f", name], { stdio: "pipe" });
  try {
    for (let i = 0; ; i++) {
      const client = new pg.Client({ connectionString: url });
      try {
        await client.connect();
        await client.query("SELECT 1");
        await client.end();
        break;
      } catch (err) {
        await client.end().catch(() => {});
        if (i >= 60) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } catch (err) {
    stop();
    throw err;
  }
  return { url, stop };
}

export default async function setup(project: TestProject) {
  // TEST_DATABASE_URL: bestehender Cluster (CI-Service); Rolle braucht CREATEDB und CREATEROLE.
  // Ohne die Variable startet der Lauf einen eigenen Docker-Container und räumt ihn danach auf.
  const external = process.env.TEST_DATABASE_URL;
  const container = external ? undefined : await startContainer();
  const adminUrl = external ?? container!.url;

  const templateDb = `stammbuch_tpl_${rand()}`;
  const appPassword = randomBytes(16).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${templateDb}`);
    await migrate(withDatabaseName(adminUrl, templateDb));
    await setAppRolePassword(withDatabaseName(adminUrl, templateDb), appPassword);
  } finally {
    await admin.end();
  }

  project.provide("adminUrl", adminUrl);
  project.provide("templateDb", templateDb);
  project.provide("appPassword", appPassword);

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

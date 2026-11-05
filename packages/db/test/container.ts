import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";

/**
 * Flüchtiger Postgres-18-Container für Tests (tmpfs, nur Loopback, zufälliger Port und Passwort).
 * Gemeinsame Quelle für alle Test-Harnesses, damit Start, Warten und Aufräumen überall gleich robust sind:
 * - Jeder Container trägt die Labels `stammbuch-test` und `stammbuch-test.owner=<pid>`.
 * - Vor dem Start werden Container entfernt, deren Besitzerprozess nicht mehr läuft (Lauf mit
 *   Strg+C, SIGKILL/Exit 137 oder Absturz beendet, ohne dass das Teardown lief). Container fremder,
 *   noch laufender Testläufe bleiben unberührt.
 * - Beim Prozessende wird der eigene Container synchron entfernt, auch wenn kein Teardown läuft.
 */
const LABEL = "stammbuch-test";
const OWNER_LABEL = "stammbuch-test.owner";

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: "pipe" }).trim();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Entfernt Test-Container, deren Besitzerprozess tot ist. Gibt die Namen der entfernten zurück. */
export function removeOrphanedContainers(): string[] {
  const removed: string[] = [];
  const rows = docker([
    "ps", "-a", "--filter", `label=${LABEL}`,
    "--format", `{{.Names}} {{.Label "${OWNER_LABEL}"}}`,
  ]); // prettier-ignore
  for (const row of rows.split("\n").filter(Boolean)) {
    const [name, owner] = row.split(" ");
    if (!name || Number(owner) === process.pid || isAlive(Number(owner))) continue;
    try {
      docker(["rm", "-f", name]);
      removed.push(name);
    } catch {
      // Ein anderer Lauf war schneller; das Ziel (Container weg) ist erreicht.
    }
  }
  return removed;
}

function runWithRetry(args: string[]): void {
  for (let i = 1; ; i++) {
    try {
      docker(args);
      return;
    } catch (err) {
      // Docker Desktop meldet beim gleichzeitigen Start mehrerer Container sporadisch
      // Portbindungs- oder Daemon-Fehler; ein erneuter Versuch genügt.
      if (i >= 3) throw err;
    }
  }
}

function isRunning(name: string): boolean {
  try {
    return docker(["inspect", "-f", "{{.State.Running}}", name]) === "true";
  } catch {
    return false;
  }
}

async function waitForPostgres(name: string, url: string): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 120; i++) {
    // Container weg oder beendet: sofort mit dessen Log scheitern statt 60 s auf den Port zu warten.
    if (!isRunning(name)) {
      let log = "";
      try {
        log = docker(["logs", "--tail", "40", name]);
      } catch {
        // Container ist wegen --rm schon entfernt.
      }
      throw new Error(`Postgres-Container ${name} wurde beendet.\n${log}`);
    }
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (err) {
      last = err;
      await client.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw last;
}

export interface TestContainer {
  /** Superuser-Verbindung auf die Datenbank `postgres`. */
  url: string;
  /** Entfernt den Container; mehrfach aufrufbar. */
  stop(): void;
}

export async function startTestContainer(
  prefix: string,
  postgresArgs: string[] = [],
): Promise<TestContainer> {
  removeOrphanedContainers();
  const name = `stammbuch-test-${prefix}-${randomBytes(6).toString("hex")}`;
  const password = randomBytes(16).toString("hex");
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    process.off("exit", stop);
    try {
      docker(["rm", "-f", name]);
    } catch {
      // Schon entfernt (--rm) oder Docker nicht erreichbar; nichts weiter zu tun.
    }
  };
  // Vor dem Start registrieren: ein Abbruch zwischen `docker run` und dem Warten hinterlässt sonst einen Rest.
  process.on("exit", stop);
  try {
    runWithRetry([
      "run", "-d", "--rm", "--name", name,
      "--label", LABEL, "--label", `${OWNER_LABEL}=${process.pid}`,
      "-e", `POSTGRES_PASSWORD=${password}`,
      "--tmpfs", "/var/lib/postgresql",
      "--shm-size=256m",
      "-p", "127.0.0.1::5432",
      "postgres:18-alpine", "-c", "fsync=off", ...postgresArgs,
    ]); // prettier-ignore
    const port = docker(["port", name, "5432/tcp"]).split("\n")[0]!.split(":").pop();
    const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
    await waitForPostgres(name, url);
    return { url, stop };
  } catch (err) {
    stop();
    throw err;
  }
}

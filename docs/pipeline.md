# Pipeline, lokale Entwicklung und Konventionen

## Lokaler Start

1. Node 24 (`.nvmrc`) und pnpm 12 installieren (`corepack enable` nimmt die Version aus `package.json`).
2. `pnpm install`
3. `cp .env.example .env` und `POSTGRES_PASSWORD` lokal setzen. `.env` steht in `.gitignore`, es kommen nie echte Zugangsdaten ins Repository (SR-30, SR-31).
4. Datenbank starten: `docker compose up -d stammbuch-db`. PostgreSQL 18 lauscht auf `127.0.0.1:55432` (nicht 5432, dort läuft möglicherweise ein anderer Container).
5. Dienste: `pnpm dev:api`, `pnpm dev:web`, `pnpm dev:worker`.

Skripte im Wurzelverzeichnis: `lint`, `format`, `format:check`, `typecheck`, `test`, `build`.

Hinweis: `@stammbuch/shared` wird für Laufzeit-Importe aus `dist` geladen (Typen aus `src`). `pnpm test` und `pnpm build` bauen es zuerst. Beim ersten `pnpm dev:*` einmal `pnpm --filter @stammbuch/shared run build` ausführen.

## Module

Fachfunktionen kommen als Module. Jedes Modul hat einen eigenen Ordner, die einzige gemeinsame Datei ist die Liste in `modules/index.ts` (eine Zeile pro Modul). So kollidieren parallele Branches kaum.

**API** (`apps/api/src/modules/<name>/index.ts`): exportiert `name` und `register(app: FastifyInstance)`. Eintragen in `apps/api/src/modules/index.ts`. Beispiel: `health`. Jede Route braucht Authentifizierung und Berechtigung (SR-10, SR-12), Eingaben gehen durch `validate(schema, input)` (`src/lib/validate.ts`, SR-20).

**Web** (`apps/web/src/modules/<id>/index.ts`): exportiert eine `ModuleDefinition` (`id`, `titleKey`, `nav`, `routes`, `tabTypes`, siehe `modules/types.ts`). Eintragen in `apps/web/src/modules/index.ts`. Beispiel: `start`. Alle UI-Texte stehen in `src/i18n/de.json` und werden mit `t("schlüssel")` geholt, nie direkt im Code.

**Migrationen** (`packages/db/migrations/<YYYYMMDDHHmm>_<modul>_<name>.sql`): Konvention und Regeln in `packages/db/README.md`.

## CI (`.github/workflows/ci.yml`)

Läuft bei jedem Pull Request und bei Push auf `develop` und `main`. Rechte: nur `contents: read`.

| Job      | Inhalt                                                                         |
| -------- | ------------------------------------------------------------------------------ |
| `check`  | `pnpm install --frozen-lockfile`, lint, format:check, typecheck, test, build   |
| `docker` | Baut die Images web, api und worker (kein Push, kein Login)                    |
| `audit`  | `pnpm audit --audit-level high`, schlägt bei hohen oder kritischen Funden fehl |

Actions sind auf Commit-SHA festgelegt (SR-63). Dependabot (`.github/dependabot.yml`) schlägt wöchentlich Updates für npm, GitHub Actions, Dockerfiles und docker-compose vor.

`deploy.yml` ist eine Vorlage ohne Ziel (nur `workflow_dispatch`). Anleitung zum Einrichten steht im Kopf der Datei.

## Container

`apps/<dienst>/Dockerfile`, Build-Kontext ist das Repo-Wurzelverzeichnis: `docker build -f apps/api/Dockerfile -t stammbuch-api .`

Alle Images sind mehrstufig und laufen als Nicht-Root-Benutzer. API und Worker werden mit `pnpm deploy --prod` auf die Produktions-Abhängigkeiten reduziert. Die Web-Oberfläche wird von nginx (unprivileged, Port 8080) mit Sicherheits-Headern ausgeliefert (`apps/web/nginx/security-headers.conf`). Die API setzt ihre Header über Helmet.

## Repo-Einstellungen (von Hand auf GitHub, nicht im Code)

- **Secret Scanning und Push Protection** aktivieren: Settings, Code security, Secret scanning.
- Dependabot alerts und Dependabot security updates aktivieren.
- Branch-Schutz für `develop` und `main`: Pull Request verpflichtend, Status-Checks `check`, `docker` und `audit` müssen grün sein, kein direkter Push.
- Für `deploy.yml` später GitHub Environments mit Freigabe für `production` anlegen.

## Branch- und PR-Regeln

- Ein Branch und ein Pull Request pro Issue. Der Branch wird aus dem Issue erzeugt (`gh issue develop <nr> --name feature/<nr>-<kurzname> --base develop`), Bugs als `fix/<nr>-<kurzname>`.
- Nie direkt auf `develop` oder `main` committen oder pushen. Jede Änderung geht als Pull Request, den die verantwortliche Person auf GitHub merged.
- Der PR geht zurück nach `develop`, die Beschreibung enthält `Closes #<nr>`. Labels und Milestone vom Issue übernehmen.
- Vor dem PR die Security-Checkliste für den Änderungstyp durchgehen. Abweichungen von einer SR-Anforderung im PR nennen und begründen.
- CI muss grün sein, bevor gemerged wird.

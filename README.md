# Stammbuch

Verbands- und Mitgliederverwaltung mit Debitorenbuchhaltung. Konzept und Reihenfolge: [projektplan.md](projektplan.md).

## Aufbau

| Pfad              | Inhalt                                             |
| ----------------- | -------------------------------------------------- |
| `apps/web`        | Oberfläche (Vite, React 19, TypeScript)            |
| `apps/api`        | API (Fastify 5, TypeScript)                        |
| `apps/worker`     | Hintergrundprozess (Node, TypeScript)              |
| `packages/shared` | Gemeinsame Typen und zod-Schemas                   |
| `packages/db`     | Migrationen (SQL), Kysely, Mandantentrennung (RLS) |

## Schnellstart

Voraussetzungen: Node 24 (`.nvmrc`), pnpm 12 (`corepack enable`), Docker für die Datenbank.

```sh
pnpm install
cp .env.example .env          # Passwort in .env setzen
docker compose up -d stammbuch-db
pnpm dev:api                  # http://127.0.0.1:3000/health
pnpm dev:web
```

Qualitätsprüfungen (laufen auch in der CI): `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

Details zu Pipeline, Modul-Konvention und Branch-Regeln: [docs/pipeline.md](docs/pipeline.md).

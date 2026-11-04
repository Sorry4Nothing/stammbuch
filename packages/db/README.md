# @stammbuch/db

Datenbankfundament: SQL-Migrationen, Migrationsrunner, Verbindungsschicht (Kysely) und Mandantentrennung per Row-Level-Security.

## Mandantenmodell

- Eine Datenbank, ein Schema. Jede Tabelle (ausser `schema_migrations`) trägt `kunde_id`, Ausnahme `kunde` selbst (dort `id`). Der Test `test/rls.test.ts` prüft das für alle Tabellen, auch für künftige.
- Jede Tabelle hat aktive RLS-Richtlinien. Die Anwendung verbindet sich als Rolle `stammbuch_app` (kein Superuser, kein `BYPASSRLS`, kein `CREATE`), nie als Eigentümer der Tabellen.
- Der Mandant kommt aus der serverseitig aufgelösten Sitzung, nie aus dem Request (SR-13). Pro Transaktion setzt `Datenbank.withKunde(kundeId, fn)` den Mandanten (`set_config('app.kunde_id', …, true)`, nur bis Transaktionsende). Ohne Mandant liefert jede Tabelle null Zeilen.
- Fremdschlüssel auf `benutzer` sind zusammengesetzt `(benutzer_id, kunde_id)`: Fremdschlüsselprüfungen laufen an RLS vorbei und würden sonst Verweise über Mandanten hinweg erlauben.
- Neue Tabelle: `kunde_id uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE`, `ENABLE ROW LEVEL SECURITY`, Richtlinie `kunde_id = (SELECT app_kunde_id())` mit `USING` und `WITH CHECK`, `GRANT` nur der nötigen Rechte an `stammbuch_app`, Typ in `src/schema.ts`.
- Geldbeträge nur als ganzzahlige Rappen (`bigint`) oder `NUMERIC`, nie als Fliesskomma. Der Test schlägt bei `real`, `double precision` und `money` fehl.

### Tabellen

| Tabelle                         | Inhalt                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `kunde`                         | Mandant. Anwendungsrolle: lesen (nur eigene Zeile), Name ändern. Anlegen/Löschen: Verwaltung.                                |
| `benutzer`                      | Anmelde-Benutzer eines Kunden. E-Mail global eindeutig (Kleinbuchstaben), `passwort_hash`.                                   |
| `sitzung`                       | Serverseitige Sitzung: `token_hash` (SHA-256, 32 Byte), `laeuft_ab_am`, `widerrufen_am`.                                     |
| `audit_log`                     | Nur anhängen (kein UPDATE/DELETE für die Anwendungsrolle). `aktion`, `objekt_*`, `details`.                                  |
| `rechnung`, `rechnung_position` | Rechnungen/Gutschriften. Ab `versendet` unveränderlich (Trigger, auch für den Eigentümer); gelöscht werden nur Entwürfe.     |
| `rechnung_zahlung`, `mahnung`   | Nur anhängend (Trigger). Mahnung: eindeutig je Rechnung und Stufe.                                                           |
| `nummernkreis`                  | Lückenloser Zähler je Kunde, Belegart, Jahr. Vergabe per `INSERT … ON CONFLICT DO UPDATE` in der Transaktion des Versendens. |
| `rechnung_einstellung`          | Rechnungssteller, Präfixe, Mahnstufen und Feature-Flags je Kunde.                                                            |

### Wege an RLS vorbei

Nur zwei `SECURITY DEFINER`-Funktionen, beide für die Zeit, in der der Mandant noch nicht bekannt ist:

- `benutzer_fuer_anmeldung(email)`: `id, kunde_id, passwort_hash, aktiv` (Methode `findeBenutzerFuerAnmeldung`).
- `sitzung_aufloesen(token_hash)`: gültige (nicht abgelaufene, nicht widerrufene) Sitzung eines aktiven Benutzers (Methode `loeseSitzungAuf`).

Danach immer `withKunde(kunde_id, …)`.

### Grenzen

- Die Anwendungsrolle könnte `app.kunde_id` selbst setzen. Schutz davor ist der Code (parametrisierte Queries, SR-21, und `withKunde` nur mit Mandant aus der Sitzung), nicht die Datenbank. Postgres kann den Mandanten nicht gegen eine kompromittierte Anwendung verteidigen.
- `audit_log` hat keine Hash-Kette. Sie kann nachgerüstet werden, wenn die GeBüV-Klärung (projektplan.md, Abschnitt 8) es verlangt.

## Betrieb

Zwei Verbindungen, zwei Rollen:

| Variable             | Rolle                                             | Verwendung                         |
| -------------------- | ------------------------------------------------- | ---------------------------------- |
| `DATABASE_ADMIN_URL` | Eigentümer (darf Rollen und Tabellen anlegen)     | nur Migrationen (`pnpm … migrate`) |
| `DATABASE_URL`       | `stammbuch_app` (wird von der Migration angelegt) | API und Worker                     |

```sh
# .env: DATABASE_ADMIN_URL, DATABASE_URL, APP_DB_PASSWORD setzen (siehe .env.example)
pnpm --filter @stammbuch/db run build
pnpm --filter @stammbuch/db run migrate
```

`migrate` wendet neue Migrationen an und setzt, falls `APP_DB_PASSWORD` gesetzt ist, das Passwort von `stammbuch_app` (die Rolle ist sonst `NOLOGIN`). Bei einem verwalteten Anbieter muss der Eigentümer `CREATEROLE` haben. Verbindungen in Produktion mit `sslmode=verify-full` (SR-40).

## Migrationen

Migrationen sind reines SQL und liegen in `migrations/`. Dateiname:

```
<YYYYMMDDHHmm>_<modul>_<name>.sql
```

- `YYYYMMDDHHmm`: Zeitstempel (UTC) der Erstellung. Er bestimmt die Reihenfolge.
- `<modul>`: Fachmodul, dem die Änderung gehört (z. B. `mitglieder`, `buchhaltung`).
- `<name>`: kurze Beschreibung in Kleinbuchstaben, Wörter mit `_` getrennt.

Beispiel: `202611041530_mitglieder_create_person.sql`

Regeln:

- Bereits gemergte Migrationen werden nie geändert. Der Runner speichert eine Prüfsumme und bricht bei einer Änderung ab. Korrekturen sind eine neue Migration.
- Der Zeitstempel verhindert Namenskollisionen, wenn mehrere Branches parallel Migrationen anlegen. Fehlende ältere Migrationen werden nachgeholt.
- Jede Migration läuft in einer Transaktion. Schlägt sie fehl, bleibt nichts zurück. Ein Advisory-Lock verhindert parallele Läufe.
- Zerstörende Änderungen (DROP, Datenlöschung) brauchen einen ausdrücklichen Hinweis im PR und ein Backup.

## Tests

`pnpm --filter @stammbuch/db run test` startet einen eigenen, flüchtigen Container `postgres:18-alpine` (Loopback, zufälliger Port und Passwort, tmpfs), legt eine migrierte Vorlage-Datenbank an und entfernt den Container danach. Voraussetzung: laufendes Docker. Bestehende Container und Datenbanken bleiben unberührt.

Alternativ `TEST_DATABASE_URL` auf einen Cluster setzen (Rolle mit `CREATEDB` und `CREATEROLE`); die Tests legen dort nur eigene `stammbuch_tpl_*` und `stammbuch_test_*` Datenbanken an und löschen sie wieder. Hinweis: Die Rolle `stammbuch_app` ist clusterweit, ihr Passwort wird dabei neu gesetzt.

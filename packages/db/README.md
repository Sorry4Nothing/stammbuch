# @stammbuch/db

Datenbankfundament: SQL-Migrationen, Migrationsrunner, Verbindungsschicht (Kysely) und Mandantentrennung per Row-Level-Security.

## Mandantenmodell

- Eine Datenbank, ein Schema. Jede Tabelle (ausser `schema_migrations`) trägt `kunde_id`, Ausnahme `kunde` selbst (dort `id`) und die drei begründeten Ausnahmen `auth_sperre`, `auth_ereignis` und `plattform_protokoll` (siehe unten). Der Test `test/rls.test.ts` prüft das für alle Tabellen, auch für künftige.
- Jede Tabelle hat aktive RLS-Richtlinien. Die Anwendung verbindet sich als Rolle `stammbuch_app` (kein Superuser, kein `BYPASSRLS`, kein `CREATE`), nie als Eigentümer der Tabellen.
- Der Mandant kommt aus der serverseitig aufgelösten Sitzung, nie aus dem Request (SR-13). Pro Transaktion setzt `Datenbank.withKunde(kundeId, fn)` den Mandanten (`set_config('app.kunde_id', …, true)`, nur bis Transaktionsende). Ohne Mandant liefert jede Tabelle null Zeilen.
- Fremdschlüssel auf `benutzer` sind zusammengesetzt `(benutzer_id, kunde_id)`: Fremdschlüsselprüfungen laufen an RLS vorbei und würden sonst Verweise über Mandanten hinweg erlauben.
- Neue Tabelle: `kunde_id uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE`, `ENABLE ROW LEVEL SECURITY`, Richtlinie `kunde_id = (SELECT app_kunde_id())` mit `USING` und `WITH CHECK`, `GRANT` nur der nötigen Rechte an `stammbuch_app`, Typ in `src/schema.ts`.
- Datumsspalten (`date`) liefert `Datenbank` als String `YYYY-MM-DD` (kein JS-`Date`, keine Zeitzonen-Verschiebung); `bigint` kommt als String und wird in der Anwendung gewandelt.
- Geldbeträge nur als ganzzahlige Rappen (`bigint`) oder `NUMERIC`, nie als Fliesskomma. Der Test schlägt bei `real`, `double precision` und `money` fehl.

### Tabellen

| Tabelle                         | Inhalt                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kunde`                         | Mandant. Anwendungsrolle: lesen (nur eigene Zeile), Name ändern. Anlegen/Löschen: Verwaltung.                                                                                                     |
| `benutzer`                      | Anmelde-Benutzer eines Kunden. E-Mail global eindeutig (Kleinbuchstaben), `passwort_hash`.                                                                                                        |
| `sitzung`                       | Serverseitige Sitzung: `token_hash` (SHA-256, 32 Byte), `laeuft_ab_am`, `widerrufen_am`, `phase` (`pending` nach dem Passwort, `full` nach dem zweiten Faktor), `csrf_token`, `mfa_fehlversuche`. |
| `audit_log`                     | Nur anhängen (kein UPDATE/DELETE für die Anwendungsrolle). `aktion`, `objekt_*`, `details`.                                                                                                       |
| `wiederherstellungscode`        | Einmalige Wiederherstellungscodes, nur als HMAC. Verbrauchen = Zeile löschen.                                                                                                                     |
| `auth_sperre` (ohne Mandant)    | Fehlversuchszähler pro Konto-Schlüssel (HMAC der E-Mail), auch für unbekannte Konten.                                                                                                             |
| `auth_ereignis` (ohne Mandant)  | Sicherheitsereignisse, deren Mandant unbekannt ist (siehe unten).                                                                                                                                 |
| `rechnung`, `rechnung_position` | Rechnungen/Gutschriften. Ab `versendet` unveränderlich (Trigger, auch für den Eigentümer); gelöscht werden nur Entwürfe.                                                                          |
| `rechnung_zahlung`, `mahnung`   | Nur anhängend (Trigger). Mahnung: eindeutig je Rechnung und Stufe.                                                                                                                                |
| `nummernkreis`                  | Lückenloser Zähler je Kunde, Belegart, Jahr. Vergabe per `INSERT … ON CONFLICT DO UPDATE` in der Transaktion des Versendens.                                                                      |
| `rechnung_einstellung`          | Rechnungssteller, Präfixe, Mahnstufen und Feature-Flags je Kunde.                                                                                                                                 |
| `kalender_event`                | Kalendereintrag. Löschen nur über die Aufräumfunktion (24 h nach Ende).                                                                                                                           |
| `kalender_einladung`            | Einladung pro Empfänger, nur `token_hash` (SHA-256). Eindeutig je (Event, E-Mail).                                                                                                                |
| `kalender_antwort`              | Zu-/Absage, eine pro Einladung. Fremdschlüssel erzwingen denselben Kunden und Event.                                                                                                              |
| `mail_konto`                    | SMTP/IMAP-Konto eines Benutzers. Passwort nur als AES-256-GCM-Chiffretext (`geheimnis_enc`), die ID ist Kontext der Verschlüsselung. Anwendungsrolle ändert weder Mandant noch Eigentümer.        |
| `mail_anhang`                   | Mailanhang (Metadaten und Bytes). Unveränderlich: nur SELECT/INSERT.                                                                                                                              |
| `mail_adressliste`              | Empfängerliste eines Benutzers: Empfänger als JSON, Gruppen-IDs als Text.                                                                                                                         |
| `mail_kampagne`                 | Versandauftrag (Kampagne oder Einzelmail), nur der Hash des Bestätigungs-Tokens. Kein DELETE; die Anwendung ändert nur den Bestätigungszustand.                                                   |
| `mail_zustellung`               | Versandqueue: eine Zeile pro Empfänger. Die API legt an und setzt `status` (bestätigen/abbrechen); übernehmen und abschliessen nur der Worker über Funktionen.                                    |
| `einladung`                     | Einladung zu einem Kunden. Nur `token_hash` (SHA-256), Rolle, Ablauf. Anwendungsrolle: lesen, anlegen; Einlösen nur über `einladung_einloesen`.                                                   |
| `organisation`                  | Organisationsdaten (Stammdaten, Absender, Bank, Geschäftsjahr, Module) als ein JSON-Dokument je Kunde.                                                                                            |
| `logo`                          | Logo des Kunden (PNG oder JPEG, höchstens 512 KiB), eine Zeile je Kunde.                                                                                                                          |
| `camt_import`                   | Importierte CAMT-Datei. Unveränderlich, `UNIQUE (kunde_id, datei_hash)` gegen Doppelimport.                                                                                                       |
| `camt_zahlung`                  | Einzelbuchung mit Status `MATCHED`/`REST`/`MANUAL`. `UNIQUE (kunde_id, buchungsschluessel)`; Anwendungsrolle ändert nur die Zuordnung, löscht nie.                                                |

Platform (Issue #39, Migrationen `platform_*`): `kunde` trägt Vertragsdaten (`status`, `lizenz_gueltig_bis`, `beendet_am`), die die Anwendungsrolle nur liest. `benutzer` trägt die Kundenrolle `kunden_rolle` (`admin` oder `user`, unabhängig von `rolle`) und `status` (`invited` oder `active`; Eingeladene sind nie `aktiv`). `audit_log.benutzer_id` wird beim Entfernen des Benutzers auf NULL gesetzt statt mitgelöscht. `plattform_protokoll` (Chef-Admin) hat kein `kunde_id`, siehe unten.

`benutzer` trägt zusätzlich `rolle` (`user` oder `chief_admin`) und die TOTP-Daten (`totp_secret_enc` verschlüsselt, `totp_letzter_zaehler` als Replay-Schutz, `totp_eingerichtet_am` als Einrichtungsstatus). Die Anwendungsrolle hat auf `benutzer` nur Spaltenrechte: sie kann weder `rolle` noch `kunde_id` setzen. `chief_admin` vergibt der Eigentümer (Verwaltungswerkzeug).

### Tabellen ohne Mandantenbezug (begründete Ausnahmen)

`plattform_protokoll` gehört keinem Kunden: Es enthält die Vorgänge des Chef-Admins (Kunden anlegen, sperren, beenden). Gleicher Schutz wie unten (RLS ohne Richtlinie, kein GRANT); Schreiben nur über `plattform_protokoll_anhaengen`, das den Akteur als aktiven `chief_admin` prüft, Lesen über `plattform_protokoll_lesen`. Es gibt keine Funktion zum Ändern oder Löschen.

`auth_sperre` und `auth_ereignis` werden gebraucht, bevor ein Mandant feststeht: die Sperre zählt Versuche gegen E-Mails, die es nicht gibt (sonst verriete sie, welche Konten existieren, SR-05), und Ereignisse wie "Anmeldung für unbekanntes Konto" oder "Sperre ausgelöst" haben keinen Kunden. Damit ist der frühere offene Punkt `audit_log.kunde_id NOT NULL` gelöst: Ereignisse mit Mandant stehen in `audit_log`, alle anderen in `auth_ereignis`.

Schutz: RLS ist aktiv, es gibt **keine Richtlinie und kein GRANT** für `stammbuch_app`. Die Anwendungsrolle erreicht die Tabellen nur über schmale `SECURITY DEFINER`-Funktionen (ein Schlüssel pro Aufruf, feste Spalten). Das ist enger als eine Tabelle mit `USING (true)`: nichts lässt sich auflisten oder frei umschreiben. Der Test `rls.test.ts` führt die Ausnahmen in einer Liste, prüft, dass sie wirklich gesperrt sind, und schlägt bei jeder weiteren Tabelle ohne `kunde_id` fehl. `auth_ereignis` enthält nie Klartext-E-Mails oder Geheimnisse (SR-50); Aufbewahrung 90 Tage (offen, abhängig von der GeBüV-Klärung).

Personen-Modul (Issue #6, Migrationen `personen_*`): `firma` (Firmenregister mit Freigabestatus), `gruppe`, `mitglied` (Einzel/Firma), `gruppe_mitgliedschaft` (`PRIMARY KEY (kunde_id, mitglied_id)` = höchstens eine Gruppe pro Person, auch parallel) und `registrierung_offen` (Double-Opt-in, nur Token-Hash). Verweise zwischen diesen Tabellen sind zusammengesetzte Fremdschlüssel `(kunde_id, id)`. Suche und Sortierung laufen über `suchtext_normalisieren()` (ohne Akzente, klein), generierte Sortierspalten und einen Trigramm-Index (`pg_trgm`).

Buchhaltung (Modul `buchhaltung`, Migrationen `2026110414xx`): `buchhaltung_konto`, `_buchung`, `_buchungszeile`, `_offener_posten`, `_guthaben`, `_zuordnung`, `_periodenereignis`, `_protokoll`, `_idempotenz`. Alle ausser dem Kontenplan sind nur anhängend: die Anwendungsrolle hat nur SELECT/INSERT, zusätzlich verweigern Trigger UPDATE, DELETE und TRUNCATE auch dem Eigentümer (Korrektur per Gegenbuchung). Die Datenbank erzwingt lückenlose Belegnummern und die Hash-Kette (Sperre `buchhaltung_sperre(kunde_id)`, je Kunde ein Advisory-Lock bis Transaktionsende), Soll = Haben beim Commit (aufgeschobener Constraint-Trigger), gesperrte Perioden und die Aufbewahrungsfrist (`aufbewahren_bis`). Fremdschlüssel auf `kunde` sind hier `RESTRICT`: ein Kunde mit Buchungen lässt sich nicht löschen (Art. 958f OR). Bereinigung nach Fristablauf ist ein eigenes Wartungsverfahren des Eigentümers, keine Anwendungsfunktion.

### Wege an RLS vorbei

Nur diese `SECURITY DEFINER`-Funktionen (der Test `rls.test.ts` prüft die Liste; eine neue braucht Begründung hier und in der Migration). Die ersten fünf gelten für die Zeit, in der der Mandant noch nicht bekannt ist:

- `benutzer_fuer_anmeldung(email)`: `id, kunde_id, passwort_hash, aktiv` (Methode `findeBenutzerFuerAnmeldung`).
- `sitzung_aufloesen(token_hash)`: gültige (nicht abgelaufene, nicht widerrufene) Sitzung eines aktiven Benutzers (Methode `loeseSitzungAuf`).
- `kunde_id_fuer_slug(slug)`: öffentliche Kennung (`kunde.slug`) -> Kunden-ID für die Selbstregistrierung.
- `registrierung_einloesen(token_hash)`: löscht und liefert eine offene Registrierung in einem Statement (Token gilt nur einmal).
- `kalender_einladung_aufloesen(token_hash)`: Einladung zu einem Token der öffentlichen Antwortroute (Methode `loeseKalenderEinladungAuf`).

Danach immer `withKunde(kunde_id, …)`. Weitere, alle für die Anmeldung:

- `auth_sperre_lesen / _sichern / _setzen / _loeschen(schluessel, …)`: Sperrzähler pro Konto-Schlüssel. `_sichern` legt die Zeile an und sperrt sie bis Transaktionsende (Lesen-Ändern-Schreiben ohne Rennen).
- `auth_ereignis_anhaengen(…)`: Ereignis ohne Mandant anhängen.
- `benutzer_fuer_mfa_reset(akteur, ziel)`: Chef-Admin-Reset wirkt auf einen Benutzer eines anderen Kunden. Die Datenbank prüft, dass der Akteur ein aktiver `chief_admin` ist, und gibt nur `id, kunde_id` des Ziels zurück (Methode `findeBenutzerFuerMfaReset`). Alles Weitere läuft unter RLS im Mandanten des Ziels.
- `auth_aufraeumen(jetzt)`: Wartung für den Worker, kundenübergreifend: abgelaufene/widerrufene Sitzungen, verfallene Sperrzähler (24 h), Ereignisse ohne Mandant älter als 90 Tage (Methode `raeumeAuthAuf`).

Platform (Migration `202611041802`). Der Chef-Admin arbeitet über alle Kunden hinweg und sieht nur Vertragsdaten. Jede Funktion mit `p_akteur` prüft in der Datenbank, dass der Akteur ein aktiver `chief_admin` ist (Lesen ohne Chef-Admin: keine Zeilen, Schreiben: Fehler `42501`). Die Anwendung übergibt die Benutzer-ID aus der Sitzung:

- `chef_konto(akteur)` / `chef_konto_aendern(akteur, name)`: eigenes Konto des Chef-Admins (`id, email, name`); zugleich die Prüfung der anderen Funktionen.
- `kunden_auflisten(akteur, status, muster, limit, offset)`, `kunde_anlegen(akteur, …)`, `kunde_aendern(akteur, …)`: Vertragsdaten aller Kunden. Nur so lassen sich Status, Lizenz und Slug eines Kunden ändern (Migration `202611051000`: Slug wird beim Anlegen gesetzt, `kunde_aendern` korrigiert ihn, UNIQUE schützt vor Kollisionen).
- `plattform_protokoll_anhaengen(akteur, …)` / `plattform_protokoll_lesen(…)`: Plattformprotokoll. Lesen prüft den Akteur nicht (nur Vertragsvorgänge, die Route verlangt den Chef-Admin).
- `einladung_einloesen(token_hash, jetzt)`: löst eine Einladung atomar und genau einmal ein (das Token führt erst zum Kunden); abgelaufen oder benutzt: keine Zeile.

Mailversand (Worker, Migration `mail_funktionen`): die Rolle `stammbuch_worker` hat auch hier keine Tabellenrechte. Sie arbeitet die Versandqueue über sieben Funktionen ab, jede mit festen Spalten und einem Schlüssel: `mail_zustellungen_faellig(jetzt, limit)` (höchstens 1000), `mail_zustellung_uebernehmen(id, jetzt, lease_bis)` (atomar, genau ein Worker gewinnt; verwaiste Sperren werden nach Ablauf neu aufgenommen), `mail_zustellung_abschliessen(id, status, …)` (nur für übernommene Zustellungen), `mail_kampagne_fuer_worker(id)` (ohne Bestätigungs-Token), `mail_konto_fuer_worker(kunde_id, id)` (mit Chiffretext, Mandant und ID müssen beide stimmen), `mail_anhang_fuer_worker(kunde_id, id)` und `mail_gesendet_seit(kunde_id, seit)` (Zähler für das Limit pro Kunde und Minute). Die Anwendungsrolle kann sie nicht aufrufen. Adapter: `createPostgresMailRepositories` (API) und `createPostgresWorkerRepositories` (Worker) in `@stammbuch/mail`.

Mandantenübergreifendes Aufräumen (Lösch-Job des Workers) hat eine eigene Rolle `stammbuch_worker` ohne Tabellenrechte. Sie darf nur `kalender_abgelaufene_events(cutoff)` und `kalender_event_loeschen(event_id)` aufrufen. Letztere löscht ein Event und per `ON DELETE CASCADE` dessen Einladungen und Antworten, sonst nichts. Die Anwendungsrolle hat dafür weder Funktionen noch `DELETE` auf `kalender_event`.

### Grenzen

- Die Anwendungsrolle könnte `app.kunde_id` selbst setzen. Schutz davor ist der Code (parametrisierte Queries, SR-21, und `withKunde` nur mit Mandant aus der Sitzung), nicht die Datenbank. Postgres kann den Mandanten nicht gegen eine kompromittierte Anwendung verteidigen.
- `audit_log` hat keine Hash-Kette. Sie kann nachgerüstet werden, wenn die GeBüV-Klärung (projektplan.md, Abschnitt 8) es verlangt.

## Anmeldung für andere Module: `authenticateRequest`

Die Auth (Issue #4) steckt in `apps/api/src/modules/auth`; ihre PostgreSQL-Anbindung ist `createPgAuth(db)` (`pg.ts`), verdrahtet in `apps/api/src/services.ts`. Jedes Fachmodul (Kalender, Buchhaltung, CAMT, Auswertungen, …) authentifiziert so:

```ts
// apps/api/src/modules/<modul>/index.ts
export async function register(app: FastifyInstance) {
  app.get("/mitglieder", async (req, reply) => {
    const auth = await app.authenticateRequest(req); // { tenantId, userId, rolle } | null
    if (!auth)
      return reply
        .status(401)
        .send({ error: { code: "UNAUTHENTICATED", message: "Nicht angemeldet." } });
    return db.withKunde(auth.tenantId, (trx) => trx.selectFrom("mitglied").selectAll().execute());
  });
}
```

- `tenantId` ist die `kunde_id` und kommt aus der serverseitigen Sitzung, nie aus dem Request (SR-13). Immer damit `withKunde` aufrufen, nie einen Mandanten aus Pfad, Query oder Body.
- Gilt nur für volle Sitzungen (nach dem zweiten Faktor). Bei POST/PUT/PATCH/DELETE zusätzlich: falsche `Origin` oder fehlendes/falsches Header `x-csrf-token` ergibt `null` und einen Protokolleintrag (`csrf_rejected`). Das Cookie liest die Funktion selbst; im Modul muss kein Cookie-Plugin registriert sein.
- `rolle` ist `user` oder `chief_admin`. Berechtigung (`authorize`) prüft das Modul selbst: `if (auth.rolle !== "chief_admin") return 403`. Der Chef-Admin sieht keine Kundendaten (Projektplan Abschnitt 8): fachliche Routen gehören `user`.
- Ohne konfigurierte Auth-Dienste liefert die Funktion immer `null` (fail closed).
- Für Aktion plus Protokolleintrag in einer Transaktion: beides in `db.withKunde` und den Eintrag in `audit_log` im selben Callback schreiben.

Die API startet nur mit gültiger Auth-Konfiguration (`AUTH_*`, `APP_ORIGIN`), `DATABASE_URL` und einer Verbindung, deren Rolle weder Superuser noch `BYPASSRLS` hat. Der Worker bereinigt stündlich per `auth_aufraeumen`.

## Betrieb

Zwei Verbindungen, zwei Rollen:

| Variable              | Rolle                                               | Verwendung                         |
| --------------------- | --------------------------------------------------- | ---------------------------------- |
| `DATABASE_ADMIN_URL`  | Eigentümer (darf Rollen und Tabellen anlegen)       | nur Migrationen (`pnpm … migrate`) |
| `DATABASE_URL`        | `stammbuch_app` (wird von der Migration angelegt)   | API                                |
| `WORKER_DATABASE_URL` | `stammbuch_worker` (Passwort: `WORKER_DB_PASSWORD`) | Worker (Lösch-Job), nur Funktionen |

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

Andere Pakete nutzen dieselbe Test-Infrastruktur: `globalSetup` auf `packages/db/test/global-setup.ts` und Hilfsfunktionen aus `@stammbuch/db/testing` (Beispiel: `apps/api/vitest.config.ts`).

Alternativ `TEST_DATABASE_URL` auf einen Cluster setzen (Rolle mit `CREATEDB` und `CREATEROLE`); die Tests legen dort nur eigene `stammbuch_tpl_*` und `stammbuch_test_*` Datenbanken an und löschen sie wieder. Hinweis: Die Rolle `stammbuch_app` ist clusterweit, ihr Passwort wird dabei neu gesetzt.

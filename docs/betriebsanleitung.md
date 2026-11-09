# Betriebsanleitung

Für wen: Du als Anbieter und Betreiber (Chef-Admin). Diese Anleitung sagt, wie Stammbuch auf dem Server läuft, wie man es aktualisiert, überwacht und im Notfall wieder in Gang bringt. Kennzeichnung wie im Projektplan: **[Annahme]** heisst, es ist noch nicht entschieden oder nicht geprüft.

Verweise: `ops/` (Skripte und Vorlagen), [docs/modul-einstellungen-admin.md](modul-einstellungen-admin.md) (API für Kunden und Chef-Admin), [docs/pipeline.md](pipeline.md) (CI und Container).

## 1. Aufbau im Betrieb

| Teil            | Wo                                        | Aufgabe                                                     |
| --------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `proxy` (Caddy) | Container auf dem Cloud-Server (Schweiz)  | TLS, HSTS, leitet API-Pfade an `api`, alles andere an `web` |
| `web` (nginx)   | Container                                 | liefert die Oberfläche aus                                  |
| `api` (Fastify) | Container                                 | Geschäftslogik, Anmeldung, Einstellungen, Chef-Admin        |
| `worker`        | Container                                 | Hintergrundarbeit (Mailversand, Import, Löschung, Mahnlauf) |
| PostgreSQL      | verwalteter Dienst beim Datenbankanbieter | alle Daten aller Kunden, getrennt per Kunden-ID und RLS     |

Alle Kunden laufen auf einer gemeinsamen Installation. Die Trennung der Daten erzwingt die Datenbank (Row-Level-Security), nicht nur die Anwendung.

Dateien: `ops/compose.prod.yml` (Container), `ops/Caddyfile` (Proxy), `ops/prod.env.example` und `ops/api.env.example` (Vorlagen für die Konfiguration auf dem Server).

## 2. Voraussetzungen

**Server** (Linux, aktuelle LTS-Version, Standort Schweiz):

- Docker Engine mit Compose-Plugin. Kein anderer Dienst auf Port 80 und 443.
- Firewall: von aussen nur 22 (SSH, nur Schlüssel, kein Passwort), 80 und 443 offen. Port 3000 und 8080 sind nie veröffentlicht.
- Automatische Sicherheitsupdates des Betriebssystems (`unattended-upgrades` oder gleichwertig), Neustart-Fenster festlegen.
- Zeit per NTP (die Lizenzprüfung und das Protokoll hängen an der Uhr).
- Eigener Systembenutzer `stammbuch-backup` für die Sicherung.

**Datenbank** (verwalteter Dienst, **[Annahme]** Anbieter noch offen):

- Automatische Sicherung mit Point-in-Time-Recovery und Replikat, Standort Schweiz, Vertrag zur Auftragsbearbeitung abgeschlossen.
- Zugriff nur per TLS (`sslmode=verify-full`) und nur von der Adresse des Servers (IP-Freigabe).
- Mindestens drei Rollen: Besitzer/Migration (führt Migrationen aus), **Anwendung** (Login der API und des Workers, **kein** Besitzer, **ohne** `BYPASSRLS`, sonst umgeht sie die Mandantentrennung) und **Sicherung** (nur Lesen, `pg_read_all_data`). Genaue Rechte legt Issue #3 fest.

## 3. Konfiguration und Geheimnisse

Geheimnisse (Datenbankpasswörter, Schlüssel) stehen nur auf dem Server in Dateien mit Rechten 600, die dem Betriebsbenutzer gehören. Sie stehen nie im Repository, nie in GitHub-Secrets für Entwicklungszweige und nie auf Entwicklerrechnern (SR-30, SR-32). Produktion und Entwicklung haben getrennte Werte.

| Datei                       | Inhalt                                                  |
| --------------------------- | ------------------------------------------------------- |
| `ops/prod.env`              | `DOMAIN`, `IMAGE_PREFIX`, `IMAGE_TAG`                   |
| `ops/api.env`, `worker.env` | Umgebung der Dienste, siehe unten                       |
| `/etc/stammbuch/backup.env` | Sicherung, Vorlage `ops/backup/backup.env.example`      |
| `/etc/stammbuch/pgpass`     | Passwort der Sicherungsrolle (libpq-Format), Rechte 600 |

Umgebung der API (heute gültig, aus `apps/api/src/config.ts`; ungültige Werte verhindern den Start):

| Variable         | Standard    | Bedeutung                                                         |
| ---------------- | ----------- | ----------------------------------------------------------------- |
| `PORT`           | `3000`      | Port im Container                                                 |
| `HOST`           | `127.0.0.1` | im Image auf `0.0.0.0` gesetzt                                    |
| `LOG_LEVEL`      | `info`      | `fatal` bis `trace`, `silent`                                     |
| `RATE_LIMIT_MAX` | `300`       | Anfragen pro Minute und Client-IP                                 |
| `TRUST_PROXY`    | `false`     | in `compose.prod.yml` auf `true`: nur dann gilt `X-Forwarded-For` |

Folgt mit den Issues #3 und #4 (Namen legen diese fest): Datenbank-Verbindung, Schlüssel für Sitzungen, Schlüssel für die Verschlüsselung der Postfach-Zugangsdaten. **Rotation:** Jedes Geheimnis muss sich ohne Datenverlust austauschen lassen. Ablauf: neuen Wert in die Datei, `docker compose up -d` für die betroffenen Dienste, alten Wert beim Anbieter widerrufen. Bei Verdacht auf Abfluss sofort rotieren (Abschnitt 9). **Schlüsselringe** (Postfach-Zugangsdaten, TOTP-Geheimnisse): neuen Schlüssel mit neuer ID anhängen, Aktiv-ID umstellen, API und Worker neu starten. Der Worker verschlüsselt stündlich alles neu, der Chef-Admin kann das mit `POST /admin/rotation` sofort auslösen und liest mit `GET /admin/rotation`, welche Einträge unlesbar sind. Den alten Schlüssel erst entfernen, wenn dort nichts mehr steht. Nicht rotierbar ist `AUTH_TOTP_KEY`: er leitet die Schlüssel der Wiederherstellungscodes ab und bleibt gesetzt.

## 4. Erstinstallation

1. Server gemäss Abschnitt 2 einrichten. Repository nach `/opt/stammbuch` klonen (nur Release-Tags auschecken) oder nur den Ordner `ops/` dorthin kopieren.
2. DNS: `A`/`AAAA`-Eintrag der Domain auf den Server.
3. Konfiguration anlegen: `cp ops/prod.env.example ops/prod.env`, `cp ops/api.env.example ops/api.env`, `cp ops/api.env.example ops/worker.env`, Werte eintragen, `chmod 600 ops/*.env`.
4. Bei der Registry anmelden (`docker login`) mit einem Konto, das **nur Lesen** darf.
5. Datenbank: Rollen anlegen, Migrationen ausführen (Abschnitt 5, Schritt Migration).
6. Start: `cd /opt/stammbuch/ops && docker compose --env-file prod.env -f compose.prod.yml up -d`.
7. Prüfen: `curl -fsS https://<domain>/health` liefert `{"status":"ok"}`, `docker compose ... ps` zeigt alle Dienste `healthy`/`running`, im Browser ist das Zertifikat gültig.
8. Ersten Chef-Admin anlegen und ein zweites Chef-Admin-Konto als Notfallzugang (Abschnitt 9). Das Anlegen geschieht über das Einrichtungsverfahren der Anmeldung (Issue #4) **[Annahme: eigenes Skript, noch nicht gebaut]**.
9. Sicherung einrichten (Abschnitt 7) und den Restore-Test einmal durchführen, bevor der erste Kunde Daten erfasst.

## 5. Updates

Grundsatz: Wir aktualisieren auf feste Versionen (`IMAGE_TAG`), nie auf `latest`. Jedes Update beginnt mit einer frischen Sicherung.

1. **Vorher:** CI des Release-Tags ist grün (`check`, `docker`, `audit`). Release-Hinweise lesen: gibt es Migrationen oder neue Umgebungsvariablen?
2. **Sicherung:** `systemctl start stammbuch-backup.service`, danach `systemctl start stammbuch-backup-verify.service` muss erfolgreich enden. Bei einer Migration mit `DROP` oder Datenlöschung zusätzlich einen Punkt bei der Datenbank setzen (Snapshot).
3. **Migration:** Migrationen sind reines SQL in `packages/db/migrations` und laufen **vor** dem Start der neuen API. Sie werden mit der Besitzer-Rolle ausgeführt, nie mit der Anwendungs-Rolle. Das Werkzeug dafür liefert Issue #3 **[Annahme]**. Migrationen sind nur vorwärts; es gibt kein automatisches Zurück.
4. **Neue Version starten:** `IMAGE_TAG` in `prod.env` ändern, dann `docker compose --env-file prod.env -f compose.prod.yml pull && docker compose --env-file prod.env -f compose.prod.yml up -d`. Compose ersetzt die Container; der Proxy bleibt erreichbar, kurze Unterbrechung der API ist möglich.
5. **Prüfen:** `/health`, ein Test-Login, `docker compose ... logs --since 10m api worker` ohne Fehler.
6. **Zurück bei Problemen:** `IMAGE_TAG` auf die vorige Version setzen und `up -d`. Hat die neue Version eine Migration ausgeführt, die die alte nicht versteht, geht es nur über Wiederherstellung (Abschnitt 8). Darum Migrationen so schreiben, dass die vorige Version damit läuft (erst ergänzen, später entfernen).

Betriebssystem: Updates monatlich und bei Sicherheitsmeldungen einspielen. Docker-Basis-Images und Abhängigkeiten schlägt Dependabot wöchentlich vor; `pnpm audit` in der CI blockiert hohe Funde. Der Proxy-Container (`caddy:2-alpine`) wird mit `docker compose pull proxy` aktualisiert; vor dem Einsatz auf eine feste Version festlegen.

## 6. Kunden verwalten

Alles läuft über den Chef-Admin (Modul `admin`, siehe [modul-einstellungen-admin.md](modul-einstellungen-admin.md)). Du siehst dabei nur Vertragsdaten (Name, Status, Lizenz, Einladungsstatus) und nie Daten aus dem Betrieb des Kunden. Technisch ist das erzwungen und im Test `admin.test.ts` geprüft.

| Aufgabe                 | Ablauf                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Neuer Kunde             | Kunde anlegen mit Name, Mail der ersten Person, Lizenz-Enddatum. Die Person bekommt eine Einladung (7 Tage gültig) und wird Admin des Kunden. Ist sie abgelaufen: Einladung erneut senden.                                                                         |
| Lizenz verlängern       | Kunde bearbeiten, neues Enddatum setzen. Wirkt sofort.                                                                                                                                                                                                             |
| Lizenz läuft ab         | Ab dem Tag nach dem Enddatum (Zeitzone Schweiz) ist der Kunde im Modus **Nur-Lesen**: Er sieht und exportiert alles, kann aber nichts ändern. Das gilt für jede schreibende Route. Jeder abgewiesene Schreibversuch steht als Warnung im Server-Log (Abschnitt 9). |
| Kunde sperren           | Sperrt jeden Zugriff (auch Lesen), zum Beispiel bei Zahlungsverzug oder Missbrauch. Aufheben mit «reaktivieren».                                                                                                                                                   |
| Vertragsende            | Setzt den Kunden dauerhaft auf Nur-Lesen und merkt das Datum. Es gibt kein «reaktivieren» mehr; ein neuer Vertrag ist ein neuer Kunde (**[Annahme]**).                                                                                                             |
| Daten nach Vertragsende | Export und Löschung laufen über die Kunden-ID (Projektplan Abschnitt 7). Fristen: Aufbewahrung der Buchhaltung 10 Jahre (Art. 958f OR) beachten; was der Kunde selbst aufbewahrt, regelt der Vertrag. **Das Verfahren ist noch nicht gebaut** (Abschnitt 11).      |

Monatlich prüfen: Liste der Kunden, deren Lizenz in den nächsten 30 Tagen endet, und rechtzeitig mit ihnen sprechen. **[Annahme]** Eine Übersicht dafür fehlt noch; bis dahin Kundenliste nach Enddatum durchsehen.

## 7. Sicherung

Drei Schichten, jede für einen anderen Ausfall:

1. **Point-in-Time-Recovery des Datenbankanbieters.** Für «gestern 14:07 ging etwas kaputt». Wiederherstellung über den Anbieter, auf Minuten genau.
2. **Eigene verschlüsselte Sicherung** (`ops/backup`). Für «der Anbieter ist weg oder sein Konto ist gesperrt» und gegen versehentliches Löschen aller Sicherungen beim Anbieter. Nachts, Rotation 14 Tage, 8 Wochen, 12 Monate.
3. **Kopie ausserhalb des Servers** (`OFFSITE_REMOTE`, per rclone, zum Beispiel zu einem zweiten Schweizer Anbieter). Für «der Server ist weg». Pflicht im Produktivbetrieb.

**Ziele [Annahme]:** höchstens 24 Stunden Datenverlust bei Verlust der Datenbank und des Anbieters (eigene Sicherung), Minuten bei PITR. Wiederherstellung innerhalb eines Arbeitstags.

### Einrichtung

```sh
# age installieren (Paket «age»), dann Schlüsselpaar auf einem sicheren Rechner (nicht dem Server) erzeugen:
age-keygen -o stammbuch-backup-key.txt     # gibt «Public key: age1...» aus

# Server: Benutzer, Verzeichnis, Konfiguration
useradd --system --home /var/backups/stammbuch --shell /usr/sbin/nologin stammbuch-backup
install -d -m 700 -o stammbuch-backup /var/backups/stammbuch /etc/stammbuch
cp /opt/stammbuch/ops/backup/backup.env.example /etc/stammbuch/backup.env   # Werte eintragen, öffentlichen Schlüssel einsetzen
echo 'db.example.invalid:5432:stammbuch:stammbuch_backup:PASSWORT' > /etc/stammbuch/pgpass
chown stammbuch-backup /etc/stammbuch/backup.env /etc/stammbuch/pgpass && chmod 600 /etc/stammbuch/backup.env /etc/stammbuch/pgpass

# Timer einschalten
cp /opt/stammbuch/ops/systemd/stammbuch-backup* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now stammbuch-backup.timer stammbuch-backup-verify.timer
systemctl start stammbuch-backup.service && journalctl -u stammbuch-backup -n 20
```

`pg_dump` muss mindestens so neu sein wie der Datenbankserver (Paket `postgresql-client-18` oder neuer). Die Selbsttests der Skripte laufen mit `pnpm test:ops` (benötigt bash, keine Datenbank).

### Schlüsselverwaltung (wichtig)

- Auf dem Server liegt nur der **öffentliche** Schlüssel. Wer den Server übernimmt, kann Sicherungen verschlüsseln, aber nicht lesen (SR-42).
- Der **private** Schlüssel (`stammbuch-backup-key.txt`) liegt an zwei getrennten Orten: im Passwortmanager und ausgedruckt/auf USB im Tresor. Ohne ihn sind alle Sicherungen wertlos. Eine zweite vertrauenswürdige Person weiss, wo er liegt.
- Schlüsselwechsel: neues Paar erzeugen, `AGE_RECIPIENT` ändern. Alte Sicherungen bleiben mit dem alten Schlüssel lesbar, also den alten Schlüssel aufbewahren, solange alte Sicherungen existieren.
- Sicherungen enthalten Personendaten und unterliegen denselben Schutzpflichten wie die Datenbank (SR-42). Das Verzeichnis ist nur für `stammbuch-backup` lesbar. Gelöschte Kunden verschwinden aus Sicherungen erst, wenn diese ablaufen (höchstens 12 Monate); das gehört in den Vertrag zur Auftragsbearbeitung.
- Nicht in der Sicherung: Geheimnisse (`*.env`) und die Zertifikate des Proxys. Die Geheimnisse sind im Passwortmanager hinterlegt, Zertifikate stellt Caddy neu aus.
- Dateien ausserhalb der Datenbank (zum Beispiel hochgeladene Logos, sobald sie nicht mehr in der Datenbank liegen) müssen in die Sicherung aufgenommen werden. **[Offen]** bis zur Persistenz aus Issue #3.

### Restore-Test (alle 3 Monate und nach Änderungen am Verfahren)

Ein Backup, das nie zurückgespielt wurde, gilt als nicht vorhanden. Der Test läuft auf einem vertrauenswürdigen Rechner mit dem privaten Schlüssel und einem Test-PostgreSQL, nicht auf dem Produktionsserver.

1. Neueste Sicherung (und `.sha256`) vom Server oder aus der Offsite-Kopie holen.
2. Test-PostgreSQL bereit: lokal `docker compose up -d stammbuch-db` (Port 55432), Rollen der Anwendung dort anlegen.
3. Ausführen:
   ```sh
   export AGE_IDENTITY=~/stammbuch-backup-key.txt PGHOST=127.0.0.1 PGPORT=55432 PGUSER=stammbuch
   ops/backup/restore-test.sh stammbuch-<zeitstempel>.dump.age
   ```
   Das Skript prüft die Prüfsumme, spielt in eine Wegwerf-Datenbank zurück, zählt die Tabellen, führt optional eigene Prüfabfragen aus (`RESTORE_TEST_SQL`) und löscht die Datenbank wieder.
4. Ergebnis mit Datum und Dauer ins Betriebsjournal schreiben. Schlägt er fehl, ist das ein Vorfall (Abschnitt 9), keine Notiz.

## 8. Wiederherstellung im Ernstfall

Ziel: eine neue Datenbank mit dem Stand der Sicherung, geprüft, dann die Anwendung darauf umstellen. Es wird **nie** über die laufende Datenbank zurückgespielt.

1. Anwendung anhalten, damit keine neuen Daten entstehen: `docker compose ... stop api worker`. Kunden sehen die Wartungsmeldung des Proxys **[Annahme: noch keine Seite, später ergänzen]**.
2. Wenn der Fehler ein falscher Schritt war (Löschung, fehlerhaftes Update): zuerst PITR des Anbieters auf den Zeitpunkt davor versuchen. Sonst eigene Sicherung.
3. Neue Datenbank beim Anbieter oder auf einem Ersatzserver bereitstellen, Rollen anlegen.
4. Zurückspielen: `AGE_IDENTITY=... ops/backup/restore.sh <datei.dump.age> stammbuch_neu`. Das Skript verweigert eine bestehende Datenbank.
5. Prüfen: Tabellen, Anzahl Kunden und Benutzer, letzte Buchung und letztes Protokoll, bei einem Kunden stichprobenartig im Betrieb nachsehen.
6. Verbindung in `api.env` und `worker.env` auf `stammbuch_neu` setzen, `docker compose ... up -d`, `/health` und Test-Login.
7. Kunden informieren: bis zu welchem Zeitpunkt Daten wiederhergestellt sind und was neu erfasst werden muss.
8. Ursache klären, Vorfall im Journal festhalten, Verfahren verbessern.

## 9. Überwachung und Alarm

Ohne Alarm hilft das beste Protokoll nicht (SR-53). Mindestens einrichten:

| Was            | Wie                                                                                           | Alarm bei                                       |
| -------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Erreichbarkeit | externer Dienst ruft `https://<domain>/health` jede Minute auf                                | 2 Fehlschläge hintereinander                    |
| Zertifikat     | gleicher Dienst prüft das Ablaufdatum                                                         | weniger als 14 Tage                             |
| Container      | `docker compose ps`; `restart: unless-stopped` startet Abstürze neu                           | Container startet mehr als 3-mal pro Stunde neu |
| Sicherung      | `stammbuch-backup-verify.service` (täglich) und `HEALTHCHECK_URL` (Ping nach jeder Sicherung) | Dienst `failed` oder Ping bleibt aus            |
| Speicherplatz  | Plattenbelegung des Servers und des Sicherungsordners                                         | über 80 Prozent                                 |
| Datenbank      | Metriken des Anbieters: Verbindungen, Speicher, Replikat                                      | Schwellen beim Anbieter setzen                  |

**Logs.** Die API schreibt strukturierte JSON-Zeilen nach stdout (`docker compose logs api`). Passwörter, Tokens und Cookies sind geschwärzt (SR-50). Logs auf dem Server mit Rotation (Docker `max-size`/`max-file`) oder an einen zentralen Dienst; Aufbewahrung und Zugriff beschränken, sie enthalten Mail-Adressen von Benutzern.

**Wöchentliche Durchsicht (15 Minuten) auf Sicherheitsereignisse (SR-52, SR-53):**

- `Zugriff verweigert` (403) gehäuft von einer Adresse oder einem Konto: Rechte-Probing.
- Viele Zeilen `Anfrage abgelehnt` mit `status` 401 oder 429: Passwort-Raten oder Scan.
- `Schreibzugriff bei Nur-Lesen-Lizenz`: Kunde mit abgelaufener Lizenz arbeitet weiter, oder Fehlbedienung. Kunde ansprechen.
- 5xx und `Unbehandelter Fehler`: Fehler in der Anwendung, Issue anlegen.
- Chef-Admin-Aktionen: `GET /admin/audit` zeigt jede Aktion des Anbieters (Kunde angelegt, gesperrt, beendet, Konto geändert). Stimmt jede Aktion mit dem überein, was Du getan hast?
- Kunden-Protokolle prüfen nur die Kunden selbst; Du siehst sie nicht.

Beispiel für eine schnelle Auswertung: `docker compose logs --since 7d api | grep -c "Zugriff verweigert"`.

## 10. Notfälle

**Dienst nicht erreichbar.** `docker compose ps` und `logs --tail 200` für `proxy`, `api`. Häufige Ursachen: Datenbank nicht erreichbar (Anbieter-Status, IP-Freigabe, Passwort rotiert), Platte voll, Zertifikat nicht erneuerbar (Port 80 blockiert). Die API bricht bei ungültiger Konfiguration mit einer Meldung im Log ab, statt halb zu laufen. Bei Datenbankausfall liefern die Routen 500, sie lassen nie ohne Prüfung durch (fail secure, SR-54).

**Datenbank defekt oder Daten verloren.** Abschnitt 8.

**Verdacht auf Kompromittierung** (unerklärte Chef-Admin-Aktionen, fremde Anmeldungen, Server verhält sich fremd):

1. Zugang eingrenzen: Server vom Netz nehmen oder `docker compose stop proxy` (Wartungsmodus).
2. Beweise sichern: Logs und Protokolle kopieren, bevor etwas gelöscht wird.
3. Alles rotieren: Datenbankpasswörter, Sitzungs- und Verschlüsselungsschlüssel (alle Sitzungen werden damit ungültig), SSH-Schlüssel, Registry-Zugang, `HEALTHCHECK_URL`. Chef-Admin-Passwörter und deren zweiten Faktor neu setzen.
4. Neu aufsetzen aus bekannten Images, Daten aus einer Sicherung **vor** dem Vorfall prüfen.
5. Meldepflicht: Du bist Auftragsbearbeiter; Verletzungen der Datensicherheit meldest Du den betroffenen Kunden (Verantwortlichen) so rasch wie möglich (Art. 24 nDSG). Diese melden bei hohem Risiko an den EDÖB. Vertrag zur Auftragsbearbeitung nennt die Frist. Keine Rechtsberatung: im Zweifel eine Fachperson beiziehen.

**Chef-Admin ausgesperrt** (Passwort oder zweiter Faktor weg): Das zweite Chef-Admin-Konto setzt den zweiten Faktor zurück (Projektplan Abschnitt 7). Gibt es kein zweites Konto, dokumentiertes Notfallverfahren **[Offen: Verfahren mit Issue #4 festlegen, zum Beispiel Skript auf dem Server, das einen Chef-Admin-Zugang neu anlegt und protokolliert]**. Das zweite Konto ist darum Pflicht, bevor der erste Kunde startet.

**Kunde ausgesperrt** (Admin des Kunden weg): Chef-Admin sendet die Einladung für den Kunden erneut an eine neue Person (dann Admin des Kunden). Vorher die Identität über einen unabhängigen Weg bestätigen (Rückruf beim bekannten Vertragskontakt), nie nur per Mail-Anfrage.

**Fehlerhaftes Update.** Abschnitt 5, Schritt 6.

Kontakte (eintragen, wenn bekannt): Datenbankanbieter-Support, Serveranbieter-Support, Registry, Domain/DNS, Vertretung bei Abwesenheit, Rechtsberatung für Datenschutzvorfälle.

## 11. Offene Punkte

- Anbieter für Server und Datenbank sind noch nicht gewählt; Rollen und Verbindungsparameter folgen mit Issue #3.
- Einrichtungsverfahren für den ersten und den zweiten Chef-Admin sowie Notfallweg (Issue #4).
- Systemmails (Einladung, Link «Passwort vergessen», Registrierungsmails) gehen über ein eigenes Postfach des Anbieters: `MAIL_SYSTEM_HOST`, `_PORT`, `_SECURITY`, `_USER`, `_PASSWORD`, `_FROM`, `_FROM_NAME` (Vorlage in `ops/api.env.example`). Fehlt `MAIL_SYSTEM_HOST`, startet die API trotzdem, versendet aber keine dieser Mails (Hinweis im Log); in Produktion Pflicht. Sicherheitsmeldungen (zweiter Faktor, Passwort geändert) stehen weiterhin nur im Log.
- Verfahren für Datenexport und Löschung eines Kunden bei Vertragsende (nach Kunden-ID) ist noch nicht gebaut.
- Die API hat kein gemeinsames Pfad-Präfix; der Proxy leitet daher eine Pfadliste (`ops/Caddyfile`) weiter: `/health`, `/auth`, `/api`, `/public`, `/calendar`, `/settings`, `/admin`, `/invoices`, `/accounting`, `/camt`, `/reports`, `/mail`, `/tasks`. Jedes neue API-Modul dort eintragen, sonst landet es bei der Oberfläche. Mit einem Präfix (zum Beispiel `/api`) wird das einfacher.
- Wartungsseite des Proxys und Übersicht «Lizenz läuft in 30 Tagen ab» fehlen.
- `ops/compose.prod.yml` ist geprüft (`docker compose config`), aber noch nicht auf einem echten Server gestartet. Beim ersten Start besonders auf die Schreibrechte der Container mit `read_only: true` achten (nginx, Caddy).
- Protokoll-Unveränderbarkeit (GeBüV): die Schnittstelle erlaubt nur Anhängen, die Datenbank muss das mit Rechten (kein UPDATE/DELETE für die Anwendungs-Rolle) absichern (Issue #3). Fachliche Prüfung mit Treuhänder/Anwalt wie im Projektplan vermerkt.

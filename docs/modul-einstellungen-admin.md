# Modul Einstellungen und Chef-Admin

Issue #13. Code: `apps/api/src/modules/settings` (Kunde), `apps/api/src/modules/admin` (Chef-Admin), `apps/api/src/platform` (gemeinsame Grundlage), Schemas in `packages/shared/src/settings.ts` und `admin.ts`.

## Grundlage: `platform`

Alle Module bekommen über `app.platform` Persistenz, Identität und Uhr. Heute sind die Repositories In-Memory (`platform/memory.ts`, Daten weg beim Neustart). Die Datenbankschicht (Issue #3) liefert Implementierungen derselben Schnittstellen (`platform/types.ts`) und übergibt sie an `buildApp(config, logger, platform)`.

| Schnittstelle                              | Aufgabe                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `TenantRepository`                         | Kunden (Name, Status, Lizenz-Enddatum)                                     |
| `UserRepository`                           | Benutzer eines Kunden (E-Mail, Name, Rolle, Status)                        |
| `OrganisationRepository`, `LogoStore`      | Stammdaten, Absender, Bank, Geschäftsjahr, Module; Logo                    |
| `AuditRepository`                          | Protokoll, **nur anhängen und lesen**; getrennt für Kunden und `platform`  |
| `InvitationRepository`, `InvitationSender` | Einladungen (nur Token-Hash gespeichert), Versand                          |
| `ChefAccountRepository`                    | eigenes Konto des Chef-Admins                                              |
| `PrincipalResolver`                        | Identität aus der Session: `customer` (Kunde, Benutzer, Rolle) oder `chef` |

**Für das Auth-Modul (Issue #4):** `createPlatform({ principal })` bzw. `platform.principal` setzen. Der Resolver liefert `null` (nicht angemeldet), `{ kind: "customer", userId, tenantId, email, role }` oder `{ kind: "chef", accountId, email }`. Die Kunden-ID kommt nur von dort (SR-13). Der Resolver sollte prüfen, dass der Benutzer noch existiert, dann wirkt ein Entfernen sofort. Eine Einladung löst das Auth-Modul über `POST /auth/invitations/redeem` ein (öffentlich, Rate-Limit pro IP, Body `{ token, password }`): Es prüft die Passwortregeln, setzt das Passwort und aktiviert den Benutzer (`userId` verweist auf den schon angelegten Benutzer, sonst legt es den ersten Admin des Kunden an: `role`, `email`, `tenantId` der Einladung) und gibt eine Zwischen-Sitzung zurück, mit der der zweite Faktor wie beim ersten Login eingerichtet wird (`/auth/2fa/setup`, `/auth/2fa`). Unbekannt, abgelaufen und benutzt liefern dieselbe Antwort `INVALID_INVITATION`. In Postgres geschieht das atomar in der Funktion `einladung_annehmen`; `invitations.consume` bleibt für die Speicher-Variante. Der Link der Mail lautet `<APP_ORIGIN>/einladung#<token>` (Fragment, damit das Token nicht in Zugriffsprotokollen steht). Pfade unter `/auth/` bleiben bei Nur-Lesen-Lizenz schreibbar (Abmelden); gesperrte Kunden darf Auth beim Login zusätzlich abweisen.

**Zugriffsstufen und Rechtematrix (SR-10, SR-12).** Jede Route in `settings` und `admin` nennt `config: { access }`: `customer` (jeder Benutzer des Kunden), `customer-admin` (Rolle `admin`), `chef`. Ohne Angabe bricht der Start ab. Die Stufe wird als erste Prüfung vor jedem Handler erzwungen. Der Test `settings.test.ts` («Rechtematrix») hält die Tabelle unten fest und prüft pro Route: anonym 401, falsche Rolle 403.

## Lizenz

`platform/licence.ts`, erzwungen in `installPlatform` (globaler `onRequest`-Hook für **alle** Routen aller Module, auch künftige):

| Zustand     | Auslöser                                         | Wirkung                                                        |
| ----------- | ------------------------------------------------ | -------------------------------------------------------------- |
| `active`    | Status aktiv, Enddatum nicht überschritten       | voller Zugriff                                                 |
| `expired`   | Enddatum überschritten (Tag danach, Zeit Zürich) | Nur-Lesen: POST/PUT/PATCH/DELETE → 403 `LICENCE_READ_ONLY`     |
| `ended`     | Chef-Admin hat Vertragsende gesetzt              | Nur-Lesen wie `expired`                                        |
| `suspended` | Chef-Admin hat gesperrt                          | jede Anfrage 403, ausser `GET /settings/licence` und `/auth/*` |

Der Chef-Admin ist nicht betroffen. Ist der Kunde zur Session nicht auffindbar, wird verweigert; fällt der Resolver aus, antwortet die API 500 (SR-54).

## Routen Kunde (`settings`)

| Route                                      | Stufe                     | Zweck                                                                               |
| ------------------------------------------ | ------------------------- | ----------------------------------------------------------------------------------- |
| `GET /settings/organisation`               | customer                  | alle Bereiche und Logo-Info                                                         |
| `PUT /settings/organisation/:section`      | customer-admin            | Bereich ersetzen: `master`, `sender`, `bank`, `fiscal-year`, `modules`              |
| `PUT /settings/organisation/logo`          | customer-admin            | Logo als rohe Bytes (`Content-Type: image/png` oder `image/jpeg`)                   |
| `GET`/`DELETE /settings/organisation/logo` | customer / customer-admin | Logo lesen, entfernen                                                               |
| `GET /settings/users`                      | customer-admin            | Benutzer des Kunden                                                                 |
| `POST /settings/users`                     | customer-admin            | hinzufügen (`email`, `name`, `role`), sendet Einladung                              |
| `PATCH`/`DELETE /settings/users/:id`       | customer-admin            | Rolle ändern, entfernen                                                             |
| `GET /settings/audit`                      | customer-admin            | Protokoll; Filter `from`, `to`, `actor`, `action`, `q`; `limit` (max 200), `offset` |
| `GET /settings/audit/export`               | customer-admin            | CSV mit denselben Filtern, höchstens 10 000 Zeilen                                  |
| `GET /settings/licence`                    | customer                  | Zustand der Lizenz                                                                  |

Regeln:

- **Rollen:** `admin` (Einstellungen, Benutzer, Protokoll) und `user` (Vollzugriff auf die Fachdaten, liest die Organisation). Der letzte Admin kann weder entfernt noch herabgestuft werden, niemand entfernt sich selbst. Fremde Benutzer-IDs ergeben 404 (SR-11).
- **Module (Schalter pro Kunde):** `sammelrechnung` (Standard aus), `mail`, `kalender` (Standard ein). Die Fachmodule lesen den Schalter aus `organisation.modules`.
- **Bank:** IBAN nur CH/LI mit Prüfsumme; QR-IBAN muss im Bereich 30000 bis 31999 liegen. Geschäftsjahr: Startmonat 1 bis 12.
- **Logo (SR-23):** nur PNG und JPEG, geprüft am Inhalt (Signatur, Struktur, Bildgrösse 16 bis 2000 Pixel), höchstens 512 KiB; SVG wird abgelehnt (Skriptgefahr). Der Typ im Header muss zum Inhalt passen. Abgelegt wird unter dem Kunden, nie unter einem Namen aus der Anfrage; die Auslieferung setzt den geprüften Typ, `nosniff` und eine CSP `default-src 'none'`. Die Datei wird nicht neu kodiert; das wäre die nächste Härtungsstufe.
- **Protokoll:** jede Änderung schreibt einen Eintrag (Zeit, Benutzer, Aktion, Objekt). Es werden **keine Feldwerte** protokolliert, nur der Bereich (zum Beispiel `organisation.update` / `bank`), damit weder Bankdaten noch Personendaten ins Protokoll gelangen (SR-41, SR-50). Aktionen: `organisation.update`, `organisation.logo.set`, `organisation.logo.remove`, `user.add`, `user.role`, `user.remove`, `audit.export`.
- **Export:** CSV mit `;` als Trennzeichen und UTF-8-BOM (Excel de-CH). Felder, die mit `=`, `+`, `-`, `@`, Tab oder Zeilenumbruch beginnen, bekommen ein vorangestelltes `'`, damit Excel sie nicht als Formel ausführt (`lib/csv.ts`, Test `csv.test.ts`). Der Export steht selbst im Protokoll; `x-export-truncated: true` zeigt an, dass mehr als 10 000 Zeilen passten.
- **Limits (SR-71):** Benutzer anlegen und Statuswechsel 20 pro Minute, Logo und Export 10 pro Minute, zusätzlich das globale Limit.

## Routen Chef-Admin (`admin`)

| Route                                                               | Zweck                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `GET /admin/customers`                                              | Kundenliste (`status`, `q`, `limit`, `offset`)                                                          |
| `POST /admin/customers`                                             | anlegen: `name`, `contactEmail`, `licenceValidUntil`; sendet Einladung an die erste Person (wird Admin) |
| `GET`/`PATCH /admin/customers/:id`                                  | Detail, Name und Lizenz-Enddatum ändern                                                                 |
| `POST /admin/customers/:id/suspend`, `/reactivate`, `/end-contract` | Statuswechsel; ungültiger Übergang gibt 409                                                             |
| `POST /admin/customers/:id/invitation`                              | Einladung erneut senden (nur aktive Kunden)                                                             |
| `GET /admin/audit`                                                  | Protokoll der Aktionen des Chef-Admins                                                                  |
| `GET`/`PATCH /admin/account`                                        | eigenes Konto (Anzeigename); Passwort und 2. Faktor gehören zur Anmeldung                               |

Statuswechsel: `active` → `suspended` → `active`; `active` oder `suspended` → `ended` (endgültig).

**Der Chef-Admin sieht keine Kundendaten, technisch erzwungen:**

1. Alle Kundenrouten verlangen `customer`; der Chef bekommt 403 ohne Inhalt (Test «bekommt auf jede Kundenroute 403»).
2. Die Antworten des `admin`-Moduls enthalten nur Vertragsfelder (Name, Status, Lizenz, Datum, Einladungsstatus); die Schemas in `admin.ts` lassen nichts anderes zu (Test auf die exakte Feldliste).
3. Das Modul benutzt von `app.platform` nur `tenants`, `invitations`, `invitationSender`, `chefs`, `platformAudit` und `clock`. Der Test «greift im Quelltext nie auf Kundenspeicher zu» schlägt fehl, sobald eine Quelldatei in `modules/admin` `users`, `organisations`, `logos`, `audit` oder das Settings-Modul anfasst.
4. Das Token der Einladung geht nur an `InvitationSender`, nie in die Antwort; sonst könnte der Chef die Einladung selbst einlösen und Kundendaten sehen. Gespeichert wird nur der SHA-256-Hash.
5. Aktionen des Chef-Admins landen im getrennten Protokoll `platformAudit`, nicht im Kundenprotokoll.

Die Datenbank sollte dies zusätzlich absichern: der Zugang des Chef-Admin-Pfads läuft mit einer Rolle, die nur die Tabellen der Verträge lesen darf (Issue #3).

## Offene Punkte und bekannte Grenzen

- `MemoryInvitationOutbox` ersetzt den Versand, bis das Mail-Modul existiert.
- Doppelte E-Mail-Adresse ergibt 409 mit gleichem Text, egal in welchem Kunden sie existiert. Wer eine Adresse ausprobiert, erfährt trotzdem, dass sie irgendwo vergeben ist; eine Einladung, die immer «gesendet» meldet, wäre die Alternative.
- Protokolleintrag und Änderung sind zwei Schritte. Mit der Datenbank gehören beide in eine Transaktion, damit nie eine Änderung ohne Eintrag bleibt.
- Rollen sind bewusst grob (`admin`, `user`), weil der Projektplan Vollzugriff für alle Berechtigten vorsieht; feinere Rechte sind ein offener Punkt des Plans.
- Das Logo wird nicht neu kodiert und nicht auf Schadcode in Bildmetadaten geprüft.
- Neue Fehlercodes in `@stammbuch/shared` (`UNAUTHENTICATED`, `FORBIDDEN`, `LICENCE_READ_ONLY`, `CONFLICT`, `UNSUPPORTED_MEDIA`); `lib/http-error.ts` bringt `HttpError` für erwartete Fehler.

-- ENTWURF für das Personen-Modul (Issue #6). Keine Migration: Die Übernahme nach
-- packages/db/migrations erfolgt mit dem Datenbank-Modul (#3), inklusive RLS-Richtlinien und
-- der dortigen Konventionen für Namen, Zeitstempel und IDs.
--
-- Mandantentrennung: kunde_id in jeder Tabelle. Fremdschlüssel sind zusammengesetzt
-- (kunde_id, id), damit eine Zeile nie auf Daten eines anderen Mandanten zeigen kann.
-- Zusätzlich gilt je Tabelle: ALTER TABLE ... ENABLE ROW LEVEL SECURITY mit
-- USING (kunde_id = current_setting('app.kunde_id')::uuid).

CREATE TABLE firma (
  kunde_id              uuid        NOT NULL,
  id                    uuid        NOT NULL,
  name                  text        NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  uid                   text        CHECK (uid ~ '^CHE-[0-9]{3}\.[0-9]{3}\.[0-9]{3}$'),
  mwst_nr               text        CHECK (mwst_nr ~ '^CHE-[0-9]{3}\.[0-9]{3}\.[0-9]{3} MWST$'),
  strasse               text        NOT NULL,
  hausnr                text,
  zusatz                text,
  plz                   text        NOT NULL,
  ort                   text        NOT NULL,
  land                  char(2)     NOT NULL DEFAULT 'CH',
  email                 text,
  telefon               text        CHECK (telefon ~ '^\+[1-9][0-9]{7,14}$'),
  status                text        NOT NULL
                        CHECK (status IN ('ausstehend', 'freigegeben', 'abgelehnt', 'zusammengefuehrt')),
  zusammengefuehrt_mit  uuid,
  erstellt_am           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kunde_id, id),
  FOREIGN KEY (kunde_id, zusammengefuehrt_mit) REFERENCES firma (kunde_id, id),
  CHECK ((status = 'zusammengefuehrt') = (zusammengefuehrt_mit IS NOT NULL))
);
-- Gleiche UID nur einmal unter den noch gültigen Firmen; Treffer beim Anlegen = Duplikat.
CREATE UNIQUE INDEX firma_uid_gueltig ON firma (kunde_id, uid)
  WHERE uid IS NOT NULL AND status IN ('ausstehend', 'freigegeben');

CREATE TABLE gruppe (
  kunde_id uuid NOT NULL,
  id       uuid NOT NULL,
  name     text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  PRIMARY KEY (kunde_id, id)
);
-- Gruppennamen sind je Mandant eindeutig, ohne Gross-/Kleinschreibung.
CREATE UNIQUE INDEX gruppe_name ON gruppe (kunde_id, lower(name));

CREATE TABLE mitglied (
  kunde_id     uuid        NOT NULL,
  id           uuid        NOT NULL,
  typ          text        NOT NULL CHECK (typ IN ('einzel', 'firma')),
  status       text        NOT NULL DEFAULT 'aktiv' CHECK (status IN ('aktiv', 'archiviert')),
  anrede       text        CHECK (anrede IN ('frau', 'herr', 'divers')),
  vorname      text        NOT NULL,
  nachname     text        NOT NULL,
  email        text,
  telefon      text        CHECK (telefon ~ '^\+[1-9][0-9]{7,14}$'),
  mobil        text        CHECK (mobil ~ '^\+[1-9][0-9]{7,14}$'),
  strasse      text,
  hausnr       text,
  zusatz       text,
  plz          text,
  ort          text,
  land         char(2),
  notiz        text,
  funktion     text,
  firma_id     uuid,
  erstellt_am  timestamptz NOT NULL DEFAULT now(),
  geaendert_am timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kunde_id, id),
  FOREIGN KEY (kunde_id, firma_id) REFERENCES firma (kunde_id, id),
  -- Firmenmitglied braucht eine Firma, Einzelmitglied darf keine haben.
  CHECK ((typ = 'firma') = (firma_id IS NOT NULL))
);
-- E-Mail je Mandant eindeutig (Registrierung erkennt Bekannte ohne Enumeration, siehe Dienst).
CREATE UNIQUE INDEX mitglied_email ON mitglied (kunde_id, email) WHERE email IS NOT NULL;
-- Trigramm-Suche für Name/E-Mail (Liste mit Suche): CREATE EXTENSION pg_trgm; dann GIN-Index
-- auf lower(vorname || ' ' || nachname || ' ' || coalesce(email, '')).
CREATE INDEX mitglied_sortierung ON mitglied (kunde_id, status, lower(nachname), lower(vorname), id);

-- Höchstens eine Gruppe pro Person: UNIQUE auf (kunde_id, mitglied_id) ohne gruppe_id.
-- Eine zweite Zeile für dasselbe Mitglied scheitert in der Datenbank, egal welcher Code schreibt.
CREATE TABLE gruppe_mitgliedschaft (
  kunde_id    uuid NOT NULL,
  mitglied_id uuid NOT NULL,
  gruppe_id   uuid NOT NULL,
  PRIMARY KEY (kunde_id, mitglied_id),
  FOREIGN KEY (kunde_id, mitglied_id) REFERENCES mitglied (kunde_id, id) ON DELETE CASCADE,
  FOREIGN KEY (kunde_id, gruppe_id)   REFERENCES gruppe (kunde_id, id)   ON DELETE CASCADE
);
CREATE INDEX gruppe_mitgliedschaft_gruppe ON gruppe_mitgliedschaft (kunde_id, gruppe_id);

-- Offene Selbstregistrierungen (Double-Opt-in). Nur der Hash des Tokens wird gespeichert.
CREATE TABLE registrierung_offen (
  token_hash text        PRIMARY KEY,
  kunde_id   uuid        NOT NULL,
  art        text        NOT NULL CHECK (art IN ('person', 'firma')),
  daten      jsonb       NOT NULL,
  ablauf_am  timestamptz NOT NULL
);
CREATE INDEX registrierung_offen_ablauf ON registrierung_offen (ablauf_am); -- Aufräumen im Worker

-- Einlösen ist atomar: DELETE FROM registrierung_offen WHERE token_hash = $1 RETURNING ...

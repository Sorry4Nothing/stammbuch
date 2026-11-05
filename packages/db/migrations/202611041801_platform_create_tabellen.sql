-- Platform (Issue #39): Einladungen, Organisation und Logo je Kunde, Protokoll des Chef-Admins.

-- Einladung. Nur der SHA-256-Hash des Tokens wird gespeichert (SR-30). Einlösen: einladung_einloesen (Migration ...802).
CREATE TABLE einladung (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  kunde_id       uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  email          text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  rolle          text NOT NULL CHECK (rolle IN ('admin', 'user')),
  -- Gesetzt, wenn der Benutzer-Eintrag schon existiert (Einladung aus den Einstellungen).
  benutzer_id    uuid,
  token_hash     bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  erstellt_am    timestamptz NOT NULL DEFAULT now(),
  laeuft_ab_am   timestamptz NOT NULL,
  eingeloest_am  timestamptz,
  CHECK (laeuft_ab_am > erstellt_am),
  FOREIGN KEY (benutzer_id, kunde_id) REFERENCES benutzer (id, kunde_id) ON DELETE CASCADE
);

CREATE INDEX einladung_kunde_idx ON einladung (kunde_id, erstellt_am DESC);

ALTER TABLE einladung ENABLE ROW LEVEL SECURITY;

CREATE POLICY einladung_eigener_kunde ON einladung
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

-- Kein UPDATE und kein DELETE: Einlösen geht nur über die Funktion.
GRANT SELECT, INSERT ON einladung TO stammbuch_app;

-- Organisationsdaten (Stammdaten, Absender, Bank, Geschäftsjahr, Module) als ein Dokument je Kunde.
-- Die Anwendung prüft jeden Bereich gegen sein Schema, bevor sie speichert.
CREATE TABLE organisation (
  kunde_id         uuid PRIMARY KEY REFERENCES kunde (id) ON DELETE CASCADE,
  daten            jsonb NOT NULL CHECK (jsonb_typeof(daten) = 'object' AND pg_column_size(daten) <= 32768),
  aktualisiert_am  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE organisation ENABLE ROW LEVEL SECURITY;

CREATE POLICY organisation_eigener_kunde ON organisation
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT, UPDATE ON organisation TO stammbuch_app;

-- Logo des Kunden. Typ und Grösse prüft die Anwendung am Inhalt (SR-23); die Datenbank begrenzt zusätzlich.
CREATE TABLE logo (
  kunde_id         uuid PRIMARY KEY REFERENCES kunde (id) ON DELETE CASCADE,
  mime             text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  bytes            bytea NOT NULL CHECK (length(bytes) BETWEEN 1 AND 524288),
  aktualisiert_am  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE logo ENABLE ROW LEVEL SECURITY;

CREATE POLICY logo_eigener_kunde ON logo
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON logo TO stammbuch_app;

-- Protokoll des Chef-Admins (Kunden anlegen, sperren, beenden). Gehört keinem Kunden, daher OHNE kunde_id und wie
-- auth_sperre / auth_ereignis geschützt: RLS aktiv, KEINE Richtlinie, KEIN GRANT. Zugriff nur über die Funktionen
-- der Migration ...802. Nur anhängen: es gibt keine Funktion zum Ändern oder Löschen.
CREATE TABLE plattform_protokoll (
  id          uuid PRIMARY KEY,
  zeitpunkt   timestamptz NOT NULL,
  -- Ohne Fremdschlüssel: der Eintrag überdauert das Konto.
  akteur_id   uuid NOT NULL,
  akteur      text NOT NULL CHECK (length(akteur) BETWEEN 1 AND 254),
  aktion      text NOT NULL CHECK (length(aktion) BETWEEN 1 AND 100),
  ziel        text NOT NULL DEFAULT '' CHECK (length(ziel) <= 300)
);

CREATE INDEX plattform_protokoll_zeitpunkt_idx ON plattform_protokoll (zeitpunkt DESC);

ALTER TABLE plattform_protokoll ENABLE ROW LEVEL SECURITY;

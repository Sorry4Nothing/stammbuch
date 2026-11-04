-- Importierte CAMT-Dateien (camt.053/.054). Unveränderlich: die Anwendungsrolle darf nur lesen und anlegen.
-- Dieselbe Datei kann pro Kunde nur einmal importiert werden (UNIQUE auf dem Dateihash). Das ist der
-- Schutz gegen parallele Uploads derselben Datei, nicht die vorherige Abfrage im Code.

CREATE TABLE camt_import (
  id             uuid PRIMARY KEY,
  kunde_id       uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  -- SHA-256 der Dateibytes, hexadezimal.
  datei_hash     text NOT NULL CHECK (datei_hash ~ '^[0-9a-f]{64}$'),
  art            text NOT NULL CHECK (art IN ('camt.053', 'camt.054')),
  version        text NOT NULL CHECK (length(version) BETWEEN 1 AND 20),
  nachricht_id   text NOT NULL CHECK (length(nachricht_id) BETWEEN 1 AND 200),
  -- Anzahlen: total, matched, rest, duplicates, ignored (keine Geldbeträge).
  zaehler        jsonb NOT NULL,
  importiert_am  timestamptz NOT NULL DEFAULT now(),
  importiert_von uuid,
  UNIQUE (kunde_id, datei_hash),
  -- Ziel für zusammengesetzte Fremdschlüssel: Zahlungen können den Mandanten nicht wechseln.
  UNIQUE (id, kunde_id),
  FOREIGN KEY (importiert_von, kunde_id) REFERENCES benutzer (id, kunde_id)
);

ALTER TABLE camt_import ENABLE ROW LEVEL SECURITY;

CREATE POLICY camt_import_lesen ON camt_import
  FOR SELECT TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()));

CREATE POLICY camt_import_anlegen ON camt_import
  FOR INSERT TO stammbuch_app
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT ON camt_import TO stammbuch_app;

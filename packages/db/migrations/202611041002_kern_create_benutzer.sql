-- Benutzer eines Kunden. Mitglieder melden sich nicht an und stehen nicht hier.
-- E-Mail ist global eindeutig (Anmeldung ohne vorherige Kundenwahl, siehe Anmeldefunktionen).

CREATE TABLE benutzer (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  kunde_id      uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  email         text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- Argon2id-Hash (SR-01), nie Klartext.
  passwort_hash text NOT NULL,
  aktiv         boolean NOT NULL DEFAULT true,
  erstellt_am   timestamptz NOT NULL DEFAULT now(),
  -- Ziel für zusammengesetzte Fremdschlüssel: Verweise können den Mandanten nicht wechseln.
  UNIQUE (id, kunde_id)
);

CREATE UNIQUE INDEX benutzer_email_key ON benutzer (email);
CREATE INDEX benutzer_kunde_id_idx ON benutzer (kunde_id);

ALTER TABLE benutzer ENABLE ROW LEVEL SECURITY;

CREATE POLICY benutzer_eigener_kunde ON benutzer
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON benutzer TO stammbuch_app;

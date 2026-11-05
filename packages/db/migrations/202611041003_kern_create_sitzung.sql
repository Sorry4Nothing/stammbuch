-- Serverseitige Sitzungen (SR-02): ablaufend, widerrufbar. Gespeichert wird nur der SHA-256-Hash des Tokens.

CREATE TABLE sitzung (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  kunde_id      uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  benutzer_id   uuid NOT NULL,
  token_hash    bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  erstellt_am   timestamptz NOT NULL DEFAULT now(),
  laeuft_ab_am  timestamptz NOT NULL,
  widerrufen_am timestamptz,
  CHECK (laeuft_ab_am > erstellt_am),
  -- Der Benutzer muss zum selben Kunden gehören (Fremdschlüsselprüfungen laufen an RLS vorbei).
  FOREIGN KEY (benutzer_id, kunde_id) REFERENCES benutzer (id, kunde_id) ON DELETE CASCADE
);

CREATE INDEX sitzung_kunde_id_idx ON sitzung (kunde_id);
CREATE INDEX sitzung_benutzer_id_idx ON sitzung (benutzer_id);

ALTER TABLE sitzung ENABLE ROW LEVEL SECURITY;

CREATE POLICY sitzung_eigener_kunde ON sitzung
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON sitzung TO stammbuch_app;

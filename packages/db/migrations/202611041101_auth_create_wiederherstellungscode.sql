-- Wiederherstellungscodes für den zweiten Faktor (SR-03). Gespeichert wird nur der HMAC (mit Serverschlüssel),
-- nie der Code. Einmalverwendung: Verbrauchen = Zeile löschen (atomar, ein DELETE ... RETURNING).

CREATE TABLE wiederherstellungscode (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  kunde_id    uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  benutzer_id uuid NOT NULL,
  code_hmac   text NOT NULL CHECK (code_hmac ~ '^[0-9a-f]{64}$'),
  erstellt_am timestamptz NOT NULL DEFAULT now(),
  UNIQUE (benutzer_id, code_hmac),
  FOREIGN KEY (benutzer_id, kunde_id) REFERENCES benutzer (id, kunde_id) ON DELETE CASCADE
);

CREATE INDEX wiederherstellungscode_kunde_id_idx ON wiederherstellungscode (kunde_id);

ALTER TABLE wiederherstellungscode ENABLE ROW LEVEL SECURITY;

CREATE POLICY wiederherstellungscode_eigener_kunde ON wiederherstellungscode
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT, DELETE ON wiederherstellungscode TO stammbuch_app;

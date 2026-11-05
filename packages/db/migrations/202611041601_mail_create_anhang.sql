-- Mailanhänge. Datei und Metadaten liegen unter einer generierten ID in der Datenbank (SR-23); Kampagnen verweisen
-- nur per ID darauf. Unveränderlich: kein UPDATE, kein DELETE für die Anwendung.

CREATE TABLE mail_anhang (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  kunde_id     uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  benutzer_id  uuid NOT NULL,
  dateiname    text NOT NULL CHECK (length(dateiname) BETWEEN 1 AND 200),
  inhaltstyp   text NOT NULL CHECK (length(inhaltstyp) BETWEEN 1 AND 200),
  groesse      integer NOT NULL CHECK (groesse >= 0),
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  inhalt       bytea NOT NULL,
  erstellt_am  timestamptz NOT NULL DEFAULT now(),
  CHECK (groesse = octet_length(inhalt)),
  FOREIGN KEY (benutzer_id, kunde_id) REFERENCES benutzer (id, kunde_id)
);

CREATE INDEX mail_anhang_kunde_idx ON mail_anhang (kunde_id, benutzer_id);

ALTER TABLE mail_anhang ENABLE ROW LEVEL SECURITY;

CREATE POLICY mail_anhang_eigener_kunde ON mail_anhang
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT ON mail_anhang TO stammbuch_app;

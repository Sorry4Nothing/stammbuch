-- Einladung pro Empfänger. Gespeichert wird nur der SHA-256-Hash des Tokens (SR-02-Muster wie bei Sitzungen);
-- das Token selbst steht nur in der Mail.

CREATE TABLE kalender_einladung (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  kunde_id    uuid NOT NULL,
  event_id    uuid NOT NULL,
  email       text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  token_hash  bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  erstellt_am timestamptz NOT NULL DEFAULT now(),
  -- Der Event muss zum selben Kunden gehören (Fremdschlüsselprüfungen laufen an RLS vorbei).
  FOREIGN KEY (event_id, kunde_id) REFERENCES kalender_event (id, kunde_id) ON DELETE CASCADE,
  UNIQUE (event_id, email),
  UNIQUE (id, event_id, kunde_id)
);

CREATE INDEX kalender_einladung_kunde_id_idx ON kalender_einladung (kunde_id);

ALTER TABLE kalender_einladung ENABLE ROW LEVEL SECURITY;

CREATE POLICY kalender_einladung_eigener_kunde ON kalender_einladung
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

-- Kein UPDATE: eine Einladung ändert sich nicht. Kein Löschen von Events durch die Anwendung,
-- aber eine misslungene Mail nimmt die Einladung zurück.
GRANT SELECT, INSERT, DELETE ON kalender_einladung TO stammbuch_app;

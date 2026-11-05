-- Adresslisten eines Benutzers: von Hand erfasste Empfänger (JSON) und Verweise auf Personengruppen.

CREATE TABLE mail_adressliste (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  kunde_id     uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  benutzer_id  uuid NOT NULL,
  name         text NOT NULL CHECK (length(name) <= 100),
  manuell      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(manuell) = 'array'),
  -- Keine Fremdschlüssel: die Gruppen liefert das Personenmodul zur Laufzeit; unbekannte IDs ergeben keine Empfänger.
  gruppen_ids  text[] NOT NULL DEFAULT '{}',
  erstellt_am  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (benutzer_id, kunde_id) REFERENCES benutzer (id, kunde_id)
);

CREATE INDEX mail_adressliste_benutzer_idx ON mail_adressliste (kunde_id, benutzer_id, erstellt_am);

ALTER TABLE mail_adressliste ENABLE ROW LEVEL SECURITY;

CREATE POLICY mail_adressliste_eigener_kunde ON mail_adressliste
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT, DELETE ON mail_adressliste TO stammbuch_app;
GRANT UPDATE (name, manuell, gruppen_ids) ON mail_adressliste TO stammbuch_app;

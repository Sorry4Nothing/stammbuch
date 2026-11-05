-- Versandaufträge (Kampagne oder Einzelmail). Der Inhalt ist beim Anlegen bereits bereinigt. Von der
-- Bestätigung steht nur der Hash des Einmal-Tokens in der Datenbank.

CREATE TABLE mail_kampagne (
  id                         uuid PRIMARY KEY DEFAULT uuidv7(),
  kunde_id                   uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  benutzer_id                uuid NOT NULL,
  -- Bewusst ohne Fremdschlüssel: ein Konto darf gelöscht werden; offene Zustellungen scheitern dann mit NOT_FOUND.
  -- Die Zugehörigkeit zum Benutzer prüft der Dienst vor dem Anlegen.
  konto_id                   uuid NOT NULL,
  art                        text NOT NULL CHECK (art IN ('campaign', 'transactional')),
  betreff                    text NOT NULL CHECK (length(betreff) <= 998),
  inhalt_html                text NOT NULL CHECK (length(inhalt_html) <= 2000000),
  anhang_ids                 text[] NOT NULL DEFAULT '{}',
  geplant_am                 timestamptz NOT NULL,
  status                     text NOT NULL CHECK (status IN ('awaiting_confirmation', 'confirmed', 'cancelled')),
  bestaetigung_hash          text CHECK (bestaetigung_hash ~ '^[0-9a-f]{64}$'),
  bestaetigung_laeuft_ab_am  timestamptz,
  empfaenger_anzahl          integer NOT NULL CHECK (empfaenger_anzahl >= 0),
  erstellt_am                timestamptz NOT NULL DEFAULT now(),
  bestaetigt_am              timestamptz,
  CHECK ((bestaetigung_hash IS NULL) = (bestaetigung_laeuft_ab_am IS NULL)),
  -- Ein verbrauchtes oder abgebrochenes Token bleibt nicht stehen.
  CHECK (status = 'awaiting_confirmation' OR bestaetigung_hash IS NULL),
  FOREIGN KEY (benutzer_id, kunde_id) REFERENCES benutzer (id, kunde_id),
  UNIQUE (id, kunde_id)
);

CREATE INDEX mail_kampagne_benutzer_idx ON mail_kampagne (kunde_id, benutzer_id, erstellt_am DESC);

ALTER TABLE mail_kampagne ENABLE ROW LEVEL SECURITY;

CREATE POLICY mail_kampagne_eigener_kunde ON mail_kampagne
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

-- Kein DELETE (Versandverlauf). Ändern darf die Anwendung nur den Bestätigungszustand.
GRANT SELECT, INSERT ON mail_kampagne TO stammbuch_app;
GRANT UPDATE (status, bestaetigung_hash, bestaetigung_laeuft_ab_am, bestaetigt_am) ON mail_kampagne TO stammbuch_app;

-- Eine Zeile pro Empfänger einer Kampagne: die Versandqueue. Die API legt an und bestätigt/bricht ab (nur `status`),
-- der Worker übernimmt und schliesst ab über die Funktionen der nächsten Migration (Rolle stammbuch_worker).

CREATE TABLE mail_zustellung (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  -- Reihenfolge des Anlegens (stabile Seitenfolge in der Zustellungsliste).
  lfd                   bigint GENERATED ALWAYS AS IDENTITY,
  kunde_id              uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  kampagne_id           uuid NOT NULL,
  empfaenger            jsonb NOT NULL CHECK (jsonb_typeof(empfaenger) = 'object'),
  status                text NOT NULL CHECK (status IN ('held', 'queued', 'sending', 'sent', 'failed', 'cancelled')),
  versuche              integer NOT NULL DEFAULT 0 CHECK (versuche >= 0),
  naechster_versuch_am  timestamptz NOT NULL,
  -- Sperre der laufenden Zustellung; verfällt sie, gilt die Zustellung als verwaist und wird neu aufgenommen.
  lease_bis             timestamptz,
  -- Nur ein fester Fehlercode, nie der Rohtext des Servers (SR-50, SR-51).
  letzter_fehler        text CHECK (length(letzter_fehler) <= 40),
  gesendet_am           timestamptz,
  nachrichten_id        text CHECK (length(nachrichten_id) <= 998),
  FOREIGN KEY (kampagne_id, kunde_id) REFERENCES mail_kampagne (id, kunde_id) ON DELETE CASCADE
);

CREATE INDEX mail_zustellung_kampagne_idx ON mail_zustellung (kampagne_id, lfd);
CREATE INDEX mail_zustellung_faellig_idx ON mail_zustellung (naechster_versuch_am) WHERE status = 'queued';
CREATE INDEX mail_zustellung_lease_idx ON mail_zustellung (lease_bis) WHERE status = 'sending';
CREATE INDEX mail_zustellung_gesendet_idx ON mail_zustellung (kunde_id, gesendet_am) WHERE status = 'sent';

ALTER TABLE mail_zustellung ENABLE ROW LEVEL SECURITY;

CREATE POLICY mail_zustellung_eigener_kunde ON mail_zustellung
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT ON mail_zustellung TO stammbuch_app;
GRANT UPDATE (status) ON mail_zustellung TO stammbuch_app;

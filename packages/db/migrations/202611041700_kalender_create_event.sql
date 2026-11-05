-- Kalendereinträge. Werden 24 Stunden nach Ende gelöscht (projektplan.md, 3.7), samt Einladungen und Rückmeldungen.

CREATE TABLE kalender_event (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  kunde_id            uuid NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  titel               text NOT NULL CHECK (length(titel) BETWEEN 1 AND 200),
  beschreibung        text NOT NULL DEFAULT '' CHECK (length(beschreibung) <= 5000),
  ort                 text NOT NULL DEFAULT '' CHECK (length(ort) <= 200),
  beginnt_am          timestamptz NOT NULL,
  endet_am            timestamptz NOT NULL,
  -- NULL: Rückmeldungen sind bis zum Beginn möglich.
  anmeldeschluss_am   timestamptz,
  max_begleiter       integer NOT NULL DEFAULT 0 CHECK (max_begleiter >= 0),
  erstellt_von        uuid NOT NULL,
  erstellt_am         timestamptz NOT NULL DEFAULT now(),
  geaendert_am        timestamptz NOT NULL DEFAULT now(),
  CHECK (endet_am > beginnt_am),
  CHECK (anmeldeschluss_am IS NULL OR anmeldeschluss_am <= beginnt_am),
  FOREIGN KEY (erstellt_von, kunde_id) REFERENCES benutzer (id, kunde_id),
  -- Ziel für zusammengesetzte Fremdschlüssel der Einladungen.
  UNIQUE (id, kunde_id)
);

CREATE INDEX kalender_event_kunde_beginn_idx ON kalender_event (kunde_id, beginnt_am);
CREATE INDEX kalender_event_endet_am_idx ON kalender_event (endet_am);

ALTER TABLE kalender_event ENABLE ROW LEVEL SECURITY;

CREATE POLICY kalender_event_eigener_kunde ON kalender_event
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

-- Kein DELETE: Löschen läuft nur über die Aufräumfunktion des Workers (kalender_event_loeschen).
GRANT SELECT, INSERT, UPDATE ON kalender_event TO stammbuch_app;

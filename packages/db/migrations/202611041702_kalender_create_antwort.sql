-- Zu-/Absage pro Einladung: eine neue Antwort ersetzt die alte (UNIQUE auf einladung_id).

CREATE TABLE kalender_antwort (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  kunde_id       uuid NOT NULL,
  event_id       uuid NOT NULL,
  einladung_id   uuid NOT NULL UNIQUE,
  status         text NOT NULL CHECK (status IN ('accepted', 'declined')),
  begleiter      integer NOT NULL DEFAULT 0 CHECK (begleiter >= 0),
  notiz          text NOT NULL DEFAULT '' CHECK (length(notiz) <= 1000),
  geantwortet_am timestamptz NOT NULL DEFAULT now(),
  -- Einladung, Event und Kunde müssen zusammenpassen.
  FOREIGN KEY (einladung_id, event_id, kunde_id)
    REFERENCES kalender_einladung (id, event_id, kunde_id) ON DELETE CASCADE
);

CREATE INDEX kalender_antwort_event_idx ON kalender_antwort (kunde_id, event_id);

ALTER TABLE kalender_antwort ENABLE ROW LEVEL SECURITY;

CREATE POLICY kalender_antwort_eigener_kunde ON kalender_antwort
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT, UPDATE ON kalender_antwort TO stammbuch_app;

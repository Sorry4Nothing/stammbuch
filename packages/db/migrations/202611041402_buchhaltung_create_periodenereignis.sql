-- Buchungsperioden (Monat). Jedes Abschliessen und Wiederöffnen ist ein neues Ereignis, das letzte gilt.
-- Wiederöffnen verlangt eine Begründung. Nur anhängend.

CREATE TABLE buchhaltung_periodenereignis (
  lfd        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kunde_id   uuid NOT NULL REFERENCES kunde (id) ON DELETE RESTRICT,
  periode    text NOT NULL CHECK (periode ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  status     text NOT NULL CHECK (status IN ('closed', 'open')),
  zeitpunkt  timestamptz NOT NULL,
  akteur     text NOT NULL CHECK (length(akteur) BETWEEN 1 AND 100),
  grund      text CHECK (length(grund) BETWEEN 3 AND 150),
  CHECK ((status = 'open') = (grund IS NOT NULL))
);

CREATE INDEX periodenereignis_suche_idx ON buchhaltung_periodenereignis (kunde_id, periode, lfd DESC);

CREATE TRIGGER periodenereignis_unveraenderlich BEFORE UPDATE OR DELETE ON buchhaltung_periodenereignis
  FOR EACH ROW EXECUTE FUNCTION buchhaltung_nur_anhaengen();
CREATE TRIGGER periodenereignis_kein_truncate BEFORE TRUNCATE ON buchhaltung_periodenereignis
  FOR EACH STATEMENT EXECUTE FUNCTION buchhaltung_nur_anhaengen();

ALTER TABLE buchhaltung_periodenereignis ENABLE ROW LEVEL SECURITY;

CREATE POLICY periodenereignis_lesen ON buchhaltung_periodenereignis
  FOR SELECT TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()));
CREATE POLICY periodenereignis_anhaengen ON buchhaltung_periodenereignis
  FOR INSERT TO stammbuch_app
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

GRANT SELECT, INSERT ON buchhaltung_periodenereignis TO stammbuch_app;

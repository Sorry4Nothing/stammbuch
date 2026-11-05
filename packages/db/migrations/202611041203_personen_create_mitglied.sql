-- Mitglieder: Einzelmitglied oder Firmenmitglied (= Kontaktperson einer Firma aus dem Register).

CREATE TABLE mitglied (
  kunde_id      uuid        NOT NULL REFERENCES kunde (id) ON DELETE CASCADE,
  id            uuid        NOT NULL DEFAULT uuidv7(),
  typ           text        NOT NULL CHECK (typ IN ('einzel', 'firma')),
  status        text        NOT NULL DEFAULT 'aktiv' CHECK (status IN ('aktiv', 'archiviert')),
  anrede        text        CHECK (anrede IN ('frau', 'herr', 'divers')),
  vorname       text        NOT NULL CHECK (length(vorname) BETWEEN 1 AND 60),
  nachname      text        NOT NULL CHECK (length(nachname) BETWEEN 1 AND 80),
  email         text        CHECK (email = lower(email) AND length(email) <= 254),
  telefon       text        CHECK (telefon ~ '^\+[1-9][0-9]{7,14}$'),
  mobil         text        CHECK (mobil ~ '^\+[1-9][0-9]{7,14}$'),
  strasse       text        CHECK (length(strasse) BETWEEN 1 AND 100),
  hausnr        text        CHECK (length(hausnr) BETWEEN 1 AND 15),
  zusatz        text        CHECK (length(zusatz) BETWEEN 1 AND 100),
  plz           text        CHECK (length(plz) BETWEEN 2 AND 10),
  ort           text        CHECK (length(ort) BETWEEN 1 AND 60),
  land          text        CHECK (land ~ '^[A-Z]{2}$'),
  notiz         text        CHECK (length(notiz) <= 500),
  funktion      text        CHECK (length(funktion) BETWEEN 1 AND 80),
  firma_id      uuid,
  erstellt_am   timestamptz NOT NULL DEFAULT now(),
  geaendert_am  timestamptz NOT NULL DEFAULT now(),
  -- Sortier- und Suchtext. suchtext enthält auch den Firmennamen und wird per Trigger gepflegt.
  nachname_sort text COLLATE "C" GENERATED ALWAYS AS (suchtext_normalisieren(nachname)) STORED,
  vorname_sort  text COLLATE "C" GENERATED ALWAYS AS (suchtext_normalisieren(vorname)) STORED,
  suchtext      text        NOT NULL DEFAULT '',
  PRIMARY KEY (kunde_id, id),
  FOREIGN KEY (kunde_id, firma_id) REFERENCES firma (kunde_id, id),
  -- Firmenmitglied braucht eine Firma, Einzelmitglied darf keine haben.
  CHECK ((typ = 'firma') = (firma_id IS NOT NULL)),
  -- Adresse ganz oder gar nicht (Hausnummer und Zusatz sind frei).
  CHECK ((strasse IS NULL) = (plz IS NULL) AND (plz IS NULL) = (ort IS NULL) AND (ort IS NULL) = (land IS NULL))
);

-- E-Mail je Kunde eindeutig (die Selbstregistrierung erkennt Bekannte, ohne es zu verraten).
CREATE UNIQUE INDEX mitglied_email_key ON mitglied (kunde_id, email) WHERE email IS NOT NULL;
-- Sortierung der Liste: passt zum Cursor (nachname_sort, vorname_sort, id).
CREATE INDEX mitglied_sortierung ON mitglied (kunde_id, status, nachname_sort, vorname_sort, id);
CREATE INDEX mitglied_firma ON mitglied (kunde_id, firma_id) WHERE firma_id IS NOT NULL;
-- Teilstring-Suche über Name, E-Mail, Telefon, Ort, PLZ und Firma.
CREATE INDEX mitglied_suche ON mitglied USING gin (suchtext gin_trgm_ops);

CREATE FUNCTION mitglied_suchtext_setzen() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.suchtext := suchtext_normalisieren(concat_ws(' ',
    NEW.vorname, NEW.nachname, NEW.email, NEW.telefon, NEW.mobil, NEW.plz, NEW.ort,
    (SELECT f.name FROM firma f WHERE f.kunde_id = NEW.kunde_id AND f.id = NEW.firma_id)));
  RETURN NEW;
END
$$;

CREATE TRIGGER mitglied_suchtext BEFORE INSERT OR UPDATE ON mitglied
  FOR EACH ROW EXECUTE FUNCTION mitglied_suchtext_setzen();

-- Wird eine Firma umbenannt, ziehen die Suchtexte ihrer Mitglieder nach.
CREATE FUNCTION firma_umbenannt() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE mitglied SET suchtext = suchtext WHERE kunde_id = NEW.kunde_id AND firma_id = NEW.id;
  RETURN NULL;
END
$$;

CREATE TRIGGER firma_umbenannt AFTER UPDATE OF name ON firma
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name) EXECUTE FUNCTION firma_umbenannt();

ALTER TABLE mitglied ENABLE ROW LEVEL SECURITY;

CREATE POLICY mitglied_eigener_kunde ON mitglied
  FOR ALL TO stammbuch_app
  USING (kunde_id = (SELECT app_kunde_id()))
  WITH CHECK (kunde_id = (SELECT app_kunde_id()));

-- Mitglieder werden archiviert, nicht gelöscht.
GRANT SELECT, INSERT, UPDATE ON mitglied TO stammbuch_app;
